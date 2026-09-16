// ── Datalink model: server bodies in, wire shapes out ─────────────────────────
//
// The server's ACARS bodies are validated and projected here before anything
// crosses to the shell. Three rules hold for every shape:
//
// 1. Fail closed per row or per field. A thread row with a missing required
//    member is dropped and counted, never forwarded half-formed; a load sheet
//    number of the wrong type becomes null rather than rejecting the sheet.
// 2. Every forwarded string is capped, so the largest line the sidecar can
//    write stays under the protocol's line limit whatever the server sends.
//    Lengths are UTF-16 code units, i.e. `string.length`.
// 3. Every forwarded string has the ingest token scrubbed out before it is
//    capped. The server never echoes the token on purpose, but a body is free
//    text and the token must not reach the webview by any route.
//
// Pure: no I/O, no timers.

import type {
  CannedMessageEntry,
  DatalinkMessage,
  DatalinkResults,
  LoadsheetSheet,
} from './protocol';
import { CANNED_ID_PATTERN } from './protocol';
import { isValidId } from './datalink-scope';

export const BODY_MAX_UNITS = 4096;
export const LABEL_MAX_UNITS = 64;
export const CATEGORY_MAX_UNITS = 32;
export const SENT_AT_MAX_UNITS = 40;
export const WX_TEXT_MAX_UNITS = 4096;
export const WX_ICAO_MAX_UNITS = 8;
export const CANNED_MAX_ENTRIES = 30;
export const CANNED_LABEL_MAX_UNITS = 48;
export const SHEET_TEXT_MAX_UNITS = 16;

export const THREAD_CACHE_MAX_MESSAGES = 2000;
export const THREAD_WINDOW_BUDGET_BYTES = 48000;
export const THREAD_WINDOW_MAX_MESSAGES = 40;

export const REDACTED = '[REDACTED]';
/** Shorter tokens are not scrubbed: they would mangle ordinary words. */
export const SCRUB_MIN_TOKEN_LENGTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function scrubToken(text: string, token: string | null | undefined): string {
  if (!token || token.length < SCRUB_MIN_TOKEN_LENGTH) return text;
  return text.split(token).join(REDACTED);
}

/** Scrub first, then cap, so a token straddling the cap cannot leave a prefix behind. */
function clean(text: string, max: number, token: string | null | undefined): string {
  return scrubToken(text, token).slice(0, max);
}

// ── thread ────────────────────────────────────────────────────────────────────

export type ThreadProjection =
  | { ok: true; messages: DatalinkMessage[]; droppedRows: number; threadPlannedLegId: number | null }
  | { ok: false; detail: string };

/**
 * `scope` says which route the body came from: only a flight thread carries a
 * `planned_leg_id` worth reading, the leg linked to that flight.
 */
export function projectThread(
  body: unknown,
  scope: 'flight' | 'leg',
  token: string | null | undefined,
): ThreadProjection {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) {
    return { ok: false, detail: 'thread body has no messages array' };
  }

  const messages: DatalinkMessage[] = [];
  let droppedRows = 0;
  for (const row of body.messages as unknown[]) {
    if (
      !isPlainObject(row) ||
      !isValidId(row.id) ||
      (row.direction !== 'uplink' && row.direction !== 'downlink') ||
      typeof row.category !== 'string' ||
      typeof row.body !== 'string' ||
      typeof row.sent_at !== 'string'
    ) {
      droppedRows++;
      continue;
    }
    messages.push({
      seq: messages.length,
      id: row.id,
      direction: row.direction,
      category: clean(row.category, CATEGORY_MAX_UNITS, token),
      label: typeof row.label === 'string' ? clean(row.label, LABEL_MAX_UNITS, token) : null,
      body: clean(row.body, BODY_MAX_UNITS, token),
      sentAt: clean(row.sent_at, SENT_AT_MAX_UNITS, token),
      correlationId: isValidId(row.correlation_id) ? row.correlation_id : null,
    });
  }

  const threadPlannedLegId = scope === 'flight' && isValidId(body.planned_leg_id) ? body.planned_leg_id : null;
  return { ok: true, messages, droppedRows, threadPlannedLegId };
}

/**
 * The window of cached messages ending just before `endSeq`, newest first
 * until the byte budget or the count is spent, returned oldest first. The
 * first message always goes in, so a caller paging backwards always makes
 * progress, and the per-field caps keep that one message under the line limit.
 *
 * `cache[i].seq === firstSeq + i`.
 */
export function fillWindow(
  cache: readonly DatalinkMessage[],
  firstSeq: number,
  endSeq: number,
): DatalinkMessage[] {
  const picked: DatalinkMessage[] = [];
  let used = 0;
  for (let seq = endSeq - 1; seq >= firstSeq; seq--) {
    const message = cache[seq - firstSeq];
    if (!message) break;
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (picked.length > 0) {
      if (picked.length >= THREAD_WINDOW_MAX_MESSAGES) break;
      if (used + bytes + 1 > THREAD_WINDOW_BUDGET_BYTES) break;
    }
    picked.push(message);
    used += bytes + 1;
  }
  return picked.reverse();
}

// ── canned list ───────────────────────────────────────────────────────────────

export type Projection<T> = { ok: true; result: T } | { ok: false; detail: string };

/**
 * The server owns the canned set; nothing here knows which ids exist. An entry
 * is kept only when it is a downlink with a well-formed id and a label. The id
 * is scrubbed like everything else and then re-validated, so an id that
 * somehow contained the token is dropped rather than sent back altered.
 */
export function projectCanned(body: unknown, token: string | null | undefined): Projection<DatalinkResults['canned-list']> {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) {
    return { ok: false, detail: 'canned body has no messages array' };
  }
  const messages: CannedMessageEntry[] = [];
  let truncated = false;
  for (const entry of body.messages as unknown[]) {
    if (!isPlainObject(entry) || entry.direction !== 'downlink') continue;
    if (typeof entry.id !== 'string' || typeof entry.label !== 'string') continue;
    const id = scrubToken(entry.id, token);
    if (!CANNED_ID_PATTERN.test(id)) continue;
    const label = scrubToken(entry.label, token).trim();
    if (label === '') continue;
    if (messages.length >= CANNED_MAX_ENTRIES) {
      truncated = true;
      break;
    }
    messages.push({ id, label: label.slice(0, CANNED_LABEL_MAX_UNITS) });
  }
  return { ok: true, result: { messages, truncated } };
}

// ── weather ───────────────────────────────────────────────────────────────────

export function projectWx(
  body: unknown,
  requestedIcao: string,
  token: string | null | undefined,
): Projection<DatalinkResults['wx']> {
  if (!isPlainObject(body) || typeof body.available !== 'boolean') {
    return { ok: false, detail: 'wx body has no available flag' };
  }
  const weather = body.weather;
  if (weather !== null && !isPlainObject(weather)) {
    return { ok: false, detail: 'wx weather is neither null nor an object' };
  }
  const icao =
    typeof body.icao === 'string' && body.icao.length <= WX_ICAO_MAX_UNITS ? scrubToken(body.icao, token) : requestedIcao;
  const text = (value: unknown, max: number): string | null =>
    typeof value === 'string' ? clean(value, max, token) : null;
  return {
    ok: true,
    result: {
      icao,
      available: body.available,
      metar: weather === null ? null : text(weather.metar, WX_TEXT_MAX_UNITS),
      taf: weather === null ? null : text(weather.taf, WX_TEXT_MAX_UNITS),
      fetchedAt: weather === null ? null : text(weather.fetched_at, SENT_AT_MAX_UNITS),
    },
  };
}

// ── load sheet ────────────────────────────────────────────────────────────────

export function projectLoadsheet(
  body: unknown,
  httpStatus: number,
  requestedLegId: number,
  token: string | null | undefined,
): Projection<DatalinkResults['loadsheet']> {
  if (!isPlainObject(body) || !isPlainObject(body.sheet)) {
    return { ok: false, detail: 'loadsheet body has no sheet object' };
  }
  const sheet = body.sheet;
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const str = (value: unknown): string | null =>
    typeof value === 'string' ? clean(value.trim(), SHEET_TEXT_MAX_UNITS, token) : null;

  const projected: LoadsheetSheet = {
    units: str(sheet.units),
    blockFuel: num(sheet.block_fuel),
    taxiFuel: num(sheet.taxi_fuel),
    takeoffFuel: num(sheet.takeoff_fuel),
    tripFuel: num(sheet.trip_fuel),
    payload: num(sheet.payload),
    payloadSource: str(sheet.payload_source),
    zeroFuelWeight: num(sheet.zero_fuel_weight),
    zfwSource: str(sheet.zfw_source),
    maxZeroFuelWeight: num(sheet.max_zero_fuel_weight),
    dryOperatingWeight: num(sheet.dry_operating_weight),
    takeoffWeight: num(sheet.takeoff_weight),
  };
  return {
    ok: true,
    result: {
      plannedLegId: isValidId(body.planned_leg_id) ? body.planned_leg_id : requestedLegId,
      created: typeof body.created === 'boolean' ? body.created : httpStatus === 201,
      httpStatus,
      sheet: projected,
    },
  };
}
