// ── SayIntentions routes: classifier and projections ──────────────────────────
//
// The server is the only thing that ever talks to SayIntentions: it holds the
// pilot's API key, and neither the key nor its masked form is ever read here.
// These seven routes authenticate like the other datalink routes, but three of
// them reach a third party through the server, so their answers are read more
// strictly than a poll's:
//
// - Only a refused ingest token touches the shared datalink state. Every other
//   failure is about this one request and leaves availability, the schedule,
//   the scope and the thread cache alone.
// - A 401 with no token scope is a server that predates these routes. The rest
//   of the datalink may be fine, so it must not read as "datalink unavailable"
//   and must never latch like a bad token.
// - A 2xx is a success only when every field the CDU shows checks out. A body
//   that does not project fully is reported as bad data rather than drawn in
//   part: a link state the CDU cannot describe is not one it may show.
//
// A body over the cap keeps its own code rather than reading as bad data,
// because the import answer is the one that can plausibly reach the cap and a
// distinct code says which limit fired. Both read the same on the CDU.
//
// The projections forward counts, timestamps and the upstream flight id, and
// nothing else: never the imported messages (they are read back through the
// existing ACARS thread), never a message id, and never an error string.
//
// Pure: no I/O, no timers.

import {
  emittedServerCode,
  INVALID_INGEST_TOKEN,
  SERVER_CODE_PATTERN,
  type Classified,
  type DatalinkErrorCode,
  type HttpOutcome,
} from './datalink-classify';
import { scrubToken, type Projection } from './datalink-model';
import { isValidId } from './datalink-scope';
import type { DatalinkResults, SayIntentionsLink } from './protocol';
import { TLS_ERROR_CODES } from './status';

/** The upstream flight id is an opaque handle; anything longer is not one. */
export const SAYINTENTIONS_UPSTREAM_ID_MAX_UNITS = 64;
export const SAYINTENTIONS_TIMESTAMP_MAX_UNITS = 32;
/** Counts the CDU prints in six columns. A count outside this is a body it cannot vouch for. */
export const SAYINTENTIONS_COUNT_MAX = 999999;
/**
 * SayIntentions' 128-character ACARS cap plus slack, and the exact width of the
 * rows the PDC page reserves, so nothing shown is ever cut.
 */
export const SAYINTENTIONS_SENT_TEXT_MAX_UNITS = 144;

type Failure = Extract<Classified, { ok: false }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The body's well-formed `code`, compared raw; the `error` text is never read. */
function rawServerCodeOf(bodyText: string | null): string | null {
  const parsed = parseJson(bodyText);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const code = parsed.value.code;
  return typeof code === 'string' && SERVER_CODE_PATTERN.test(code) ? code : null;
}

/** Leaves the datalink availability axis as it is, and is never retried. */
function failure(code: DatalinkErrorCode, httpStatus: number | null, serverCode: string | null): Failure {
  return { ok: false, code, availability: null, httpStatus, serverCode, retry: 'none' };
}

/**
 * The server's documented answers. Keyed on the code and honoured only on the
 * status it is documented with, so a code on the wrong status reads as an
 * unknown fault instead of a meaning the server did not intend.
 *
 * Not keyed on the op: NO_CLEARANCE from an import would be nonsense, but
 * honouring it costs nothing, and an op-scoped table would be a second thing to
 * keep in step with the routes.
 */
const SAYINTENTIONS_CODES: Readonly<Record<string, { status: number; code: DatalinkErrorCode }>> = {
  INVALID_ID: { status: 400, code: 'invalid-id' },
  FLIGHT_NOT_FOUND: { status: 404, code: 'flight-not-found' },
  PLANNED_LEG_NOT_FOUND: { status: 404, code: 'leg-not-found' },
  NO_API_KEY: { status: 409, code: 'si-no-api-key' },
  BAD_API_KEY: { status: 409, code: 'si-bad-api-key' },
  NOT_LINKED: { status: 409, code: 'si-not-linked' },
  SESSION_CHANGED: { status: 409, code: 'si-session-changed' },
  NO_COMMS_TO_LINK: { status: 409, code: 'si-no-comms' },
  NO_ACTIVE_SESSION: { status: 409, code: 'si-no-session' },
  NO_CLEARANCE: { status: 409, code: 'si-no-clearance' },
  UPSTREAM_UNREACHABLE: { status: 502, code: 'si-upstream-unreachable' },
  UPSTREAM_ERROR: { status: 502, code: 'si-upstream-error' },
  UPSTREAM_BAD_BODY: { status: 502, code: 'si-upstream-bad-body' },
  UPSTREAM_TIMEOUT: { status: 504, code: 'si-upstream-timeout' },
};

/** `token` is the ingest token in use, only so it can be kept out of the emitted `serverCode`. */
export function classifySayIntentionsOutcome(outcome: HttpOutcome, token: string | null): Classified {
  if (outcome.kind === 'transport') {
    // A timeout carries a numeric code, so the name is checked first.
    if (outcome.errorName === 'TimeoutError') return failure('timeout', null, null);
    if (outcome.errorCode && (TLS_ERROR_CODES as readonly string[]).includes(outcome.errorCode)) {
      return failure('tls-error', null, null);
    }
    return failure('unreachable', null, null);
  }

  const status = outcome.status;
  if (outcome.bodyTooLarge) return failure('too-large', status, null);

  if (status >= 200 && status <= 299) {
    const parsed = parseJson(outcome.bodyText);
    if (!parsed.ok) return failure('bad-response', status, null);
    return { ok: true, httpStatus: status, json: parsed.value };
  }

  const rawCode = rawServerCodeOf(outcome.bodyText);
  const emittedCode = emittedServerCode(rawCode, token);

  if (status === 401) {
    // The same token authenticates every datalink route, so a refusal here
    // stops them all, exactly as it would from a datalink request. The code is
    // checked before the header.
    if (rawCode === INVALID_INGEST_TOKEN) {
      return {
        ok: false,
        code: 'token-invalid',
        availability: 'dl.token-invalid',
        httpStatus: status,
        serverCode: emittedCode,
        retry: 'latch',
      };
    }
    const scope = outcome.scopeHeader === null ? null : outcome.scopeHeader.trim().toLowerCase();
    if (scope === 'accepted') return failure('token-missing', status, emittedCode);
    return failure('sayintentions-unavailable', status, emittedCode);
  }
  if (status === 403) return failure('rejected', status, emittedCode);

  if (rawCode !== null && Object.prototype.hasOwnProperty.call(SAYINTENTIONS_CODES, rawCode)) {
    const known = SAYINTENTIONS_CODES[rawCode];
    if (known.status === status) return failure(known.code, status, emittedCode);
  }

  return failure('http-error', status, emittedCode);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= SAYINTENTIONS_COUNT_MAX;
}

/** A server row id or cursor: null, or a safe integer from zero. */
function isNullableCursor(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

/** A timestamp the CDU can parse. Never reformatted here. */
function timestampOf(value: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof value !== 'string' || value.length > SAYINTENTIONS_TIMESTAMP_MAX_UNITS) return { ok: false };
  return Number.isNaN(Date.parse(value)) ? { ok: false } : { ok: true, value };
}

/**
 * Strict on purpose: a link object that does not project fully makes the whole
 * answer bad data rather than a partially drawn page. The upstream id is
 * scrubbed before its length is checked, and an over-long one fails rather than
 * being cut.
 */
function projectLink(value: unknown, token: string | null): Projection<SayIntentionsLink> {
  if (!isPlainObject(value)) return { ok: false, detail: 'sayintentions link is not an object' };
  if (typeof value.upstream_flight_id !== 'string') {
    return { ok: false, detail: 'sayintentions upstream flight id is not a string' };
  }
  const upstreamFlightId = scrubToken(value.upstream_flight_id, token).trim();
  if (upstreamFlightId === '' || upstreamFlightId.length > SAYINTENTIONS_UPSTREAM_ID_MAX_UNITS) {
    return { ok: false, detail: 'sayintentions upstream flight id is blank or too long' };
  }
  if (!isNullableCursor(value.since_id) || !isNullableCursor(value.baseline_comm_id)) {
    return { ok: false, detail: 'sayintentions link cursor is out of range' };
  }
  const linkedAt = timestampOf(value.linked_at);
  if (!linkedAt.ok) return { ok: false, detail: 'sayintentions linked-at is not a timestamp' };
  let lastImportAt: string | null = null;
  if (value.last_import_at !== null) {
    const parsed = timestampOf(value.last_import_at);
    if (!parsed.ok) return { ok: false, detail: 'sayintentions last-import-at is not a timestamp' };
    lastImportAt = parsed.value;
  }
  if (!isCount(value.imported_count)) {
    return { ok: false, detail: 'sayintentions imported count is out of range' };
  }
  return {
    ok: true,
    result: {
      upstreamFlightId,
      sinceId: value.since_id,
      baselineCommId: value.baseline_comm_id,
      linkedAt: linkedAt.value,
      lastImportAt,
      importedCount: value.imported_count,
    },
  };
}

/** A body that names another flight or leg than the one asked about. */
function namesRequested(body: Record<string, unknown>, key: string, requestedId: number): boolean {
  return isValidId(body[key]) && body[key] === requestedId;
}

/**
 * One projection for both questions the op can ask. `requestedFlightId` is the
 * parameter the page chose: an id means the flight's link state was asked for,
 * null means only whether a key is on file. Nothing else decides which shape
 * comes back, so the discriminant is predictable from the request.
 */
export function projectSayIntentionsStatus(
  body: unknown,
  httpStatus: number,
  requestedFlightId: number | null,
  token: string | null,
): Projection<DatalinkResults['si-status']> {
  if (!isPlainObject(body)) return { ok: false, detail: 'sayintentions status body is not an object' };

  if (requestedFlightId === null) {
    // The masked key is in this body and is deliberately not read.
    if (typeof body.sayintentions_api_key_set !== 'boolean') {
      return { ok: false, detail: 'sayintentions key-set flag is not a boolean' };
    }
    return {
      ok: true,
      result: {
        answered: 'settings',
        flightId: null,
        apiKeySet: body.sayintentions_api_key_set,
        linked: null,
        link: null,
        httpStatus,
      },
    };
  }

  if (!namesRequested(body, 'flight_id', requestedFlightId)) {
    return { ok: false, detail: 'sayintentions status body names another flight' };
  }
  if (typeof body.api_key_set !== 'boolean') {
    return { ok: false, detail: 'sayintentions key-set flag is not a boolean' };
  }
  if (typeof body.linked !== 'boolean') return { ok: false, detail: 'sayintentions linked is not a boolean' };

  let link: SayIntentionsLink | null = null;
  if (body.linked) {
    const projected = projectLink(body.link, token);
    if (!projected.ok) return projected;
    link = projected.result;
  } else if (body.link !== null) {
    return { ok: false, detail: 'sayintentions body is not linked but carries a link' };
  }

  return {
    ok: true,
    result: {
      answered: 'link',
      flightId: requestedFlightId,
      apiKeySet: body.api_key_set,
      linked: body.linked,
      link,
      httpStatus,
    },
  };
}

/**
 * 201 for a new link, 200 for a re-link; either is a success, because the link
 * exists both ways and the status does not have to pair with `created`.
 */
export function projectSayIntentionsLink(
  body: unknown,
  httpStatus: number,
  requestedFlightId: number,
  token: string | null,
): Projection<DatalinkResults['si-link']> {
  if (!isPlainObject(body)) return { ok: false, detail: 'sayintentions link body is not an object' };
  if (!namesRequested(body, 'flight_id', requestedFlightId)) {
    return { ok: false, detail: 'sayintentions link body names another flight' };
  }
  if (typeof body.created !== 'boolean') return { ok: false, detail: 'sayintentions created is not a boolean' };
  if (!isCount(body.pending_messages)) {
    return { ok: false, detail: 'sayintentions pending messages is out of range' };
  }
  const link = projectLink(body.link, token);
  if (!link.ok) return link;
  return {
    ok: true,
    result: {
      flightId: requestedFlightId,
      created: body.created,
      pendingMessages: body.pending_messages,
      link: link.result,
      httpStatus,
    },
  };
}

/** Always 200. `unlinked: false` means there was nothing to remove, and is a success. */
export function projectSayIntentionsUnlink(
  body: unknown,
  httpStatus: number,
  requestedFlightId: number,
): Projection<DatalinkResults['si-unlink']> {
  if (!isPlainObject(body)) return { ok: false, detail: 'sayintentions unlink body is not an object' };
  if (!namesRequested(body, 'flight_id', requestedFlightId)) {
    return { ok: false, detail: 'sayintentions unlink body names another flight' };
  }
  if (typeof body.unlinked !== 'boolean') return { ok: false, detail: 'sayintentions unlinked is not a boolean' };
  return { ok: true, result: { flightId: requestedFlightId, unlinked: body.unlinked, httpStatus } };
}

/**
 * The counts only. `messages` is not read at all: the imported rows are read
 * back through the ACARS thread the CDU already shows, and a second copy of
 * them here would be a parallel message store. The status does not have to
 * agree with `imported`.
 */
export function projectSayIntentionsImport(
  body: unknown,
  httpStatus: number,
  requestedFlightId: number,
): Projection<DatalinkResults['si-import']> {
  if (!isPlainObject(body)) return { ok: false, detail: 'sayintentions import body is not an object' };
  if (!namesRequested(body, 'flight_id', requestedFlightId)) {
    return { ok: false, detail: 'sayintentions import body names another flight' };
  }
  if (!isCount(body.imported) || !isCount(body.already_seen) || !isCount(body.skipped)) {
    return { ok: false, detail: 'sayintentions import count is out of range' };
  }
  if (!isNullableCursor(body.since_id)) return { ok: false, detail: 'sayintentions import cursor is out of range' };
  return {
    ok: true,
    result: {
      flightId: requestedFlightId,
      imported: body.imported,
      alreadySeen: body.already_seen,
      skipped: body.skipped,
      sinceId: body.since_id,
      httpStatus,
    },
  };
}

/**
 * The text that went upstream, scrubbed. The filed message's id is validated —
 * it proves a row exists — and then dropped, because nothing on the CDU shows
 * it. An over-long text fails rather than being cut.
 */
export function projectSayIntentionsPdc(
  body: unknown,
  httpStatus: number,
  requestedLegId: number,
  token: string | null,
): Projection<DatalinkResults['si-pdc']> {
  if (!isPlainObject(body)) return { ok: false, detail: 'sayintentions pdc body is not an object' };
  if (!namesRequested(body, 'planned_leg_id', requestedLegId)) {
    return { ok: false, detail: 'sayintentions pdc body names another planned leg' };
  }
  if (typeof body.sent_text !== 'string') return { ok: false, detail: 'sayintentions sent text is not a string' };
  const sentText = scrubToken(body.sent_text, token);
  if (sentText.trim() === '' || sentText.length > SAYINTENTIONS_SENT_TEXT_MAX_UNITS) {
    return { ok: false, detail: 'sayintentions sent text is blank or too long' };
  }
  if (!isPlainObject(body.message) || !isValidId(body.message.id)) {
    return { ok: false, detail: 'sayintentions pdc message has no id' };
  }
  return { ok: true, result: { plannedLegId: requestedLegId, sentText, httpStatus } };
}
