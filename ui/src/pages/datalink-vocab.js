// CDU wording for the datalink: availability lines, error texts, scope lines
// and message headers. Pure and DOM-free.
//
// Availability is its own axis. These tables render only the datalink state
// the host reports; nothing here reads or changes the STATUS page's ACARS
// (ingest) line, because a server that predates the datalink must still show
// a healthy uplink there.

import { TEXT_COLUMNS, normaliseText } from './datalink-text.js';

/** `state` id → line text, severity and the DL-INDEX hint (empty for none). */
export const AVAILABILITY = {
  'dl.idle': { text: 'DATALINK STANDBY', severity: 'idle', hint: '' },
  'dl.pending': { text: 'DATALINK CONNECTING', severity: 'caution', hint: '' },
  'dl.ok': { text: 'DATALINK ONLINE', severity: 'ok', hint: '' },
  'dl.unreachable': { text: 'DATALINK NO COMM', severity: 'fault', hint: '' },
  'dl.tls-error': { text: 'DATALINK CERT FAULT', severity: 'fault', hint: 'CHECK CERTIFICATE PATH' },
  'dl.timeout': { text: 'DATALINK TIMEOUT', severity: 'fault', hint: '' },
  'dl.token-invalid': { text: 'INGEST TOKEN REJECTED', severity: 'fault', hint: 'CHECK INGEST TOKEN ON CFG NETWORK' },
  'dl.token-missing': { text: 'DATALINK TOKEN NOT RECEIVED', severity: 'fault', hint: 'TOKEN HEADER LOST IN TRANSIT' },
  'dl.unavailable': { text: 'DATALINK UNAVAILABLE', severity: 'caution', hint: 'SERVER MAY PREDATE DATALINK' },
  'dl.rejected': { text: 'DATALINK REJECTED 403', severity: 'fault', hint: '' },
  'dl.http-error': { text: 'DATALINK FAULT', severity: 'fault', hint: '' },
  'dl.bad-response': { text: 'DATALINK BAD DATA', severity: 'fault', hint: '' },
  'dl.no-config': { text: 'DATALINK NO CONFIG', severity: 'caution', hint: 'COMPLETE CFG NETWORK' },
  'dl.sidecar-outdated': { text: 'SIDECAR UPDATE REQUIRED', severity: 'caution', hint: 'REBUILD SIDECAR THEN RESTART APP' },
  'dl.sidecar-unavailable': { text: 'DATALINK OFFLINE', severity: 'fault', hint: '' },
};

/**
 * Error code → scratchpad text. `stale-epoch` is deliberately null: the page
 * drops its cache and waits for the next state instead of alarming anyone.
 */
export const ERROR_TEXT = {
  unreachable: 'DATALINK NO COMM',
  'tls-error': 'DATALINK CERT FAULT',
  timeout: 'DATALINK TIMEOUT',
  'token-invalid': 'INGEST TOKEN REJECTED',
  'token-missing': 'DATALINK TOKEN NOT RECEIVED',
  unavailable: 'DATALINK UNAVAILABLE',
  rejected: 'DATALINK REJECTED 403',
  'http-error': 'DATALINK FAULT',
  'bad-response': 'DATALINK BAD DATA',
  'no-config': 'DATALINK NO CONFIG',
  'not-a-canned-message': 'NOT A CANNED MESSAGE',
  'unknown-canned-message': 'UNKNOWN CANNED MESSAGE',
  'no-dispatch-data': 'NO DISPATCH DATA',
  'invalid-id': 'DATALINK INVALID ID',
  'flight-not-found': 'FLIGHT NOT FOUND',
  'leg-not-found': 'PLANNED LEG NOT FOUND',
  'bad-request': 'INVALID ENTRY',
  'stale-epoch': null,
  'no-thread': 'NO FLIGHT PLAN',
  'too-large': 'DATALINK BAD DATA',
  'shell-timeout': 'DATALINK TIMEOUT',
  busy: 'DATALINK BUSY',
  'sidecar-exited': 'DATALINK OFFLINE',
  'sidecar-outdated': 'SIDECAR UPDATE REQUIRED',
  'sidecar-unavailable': 'DATALINK OFFLINE',
  'host-unsupported': 'DATALINK NOT SUPPORTED',
  'host-error': 'DATALINK HOST FAULT',
};

export const NO_FLIGHT_PLAN = 'NO FLIGHT PLAN';
const UNKNOWN_ERROR_TEXT = 'DATALINK FAULT';

const own = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

function withStatus(text, httpStatus) {
  return Number.isInteger(httpStatus) ? `${text} ${httpStatus}` : text;
}

export function cutText(text, columns = TEXT_COLUMNS) {
  return String(text ?? '').slice(0, columns);
}

/** `{ id, text, severity, hint }` for a datalink state; null reads as standby. */
export function describeDatalinkState(state) {
  const id = state && typeof state === 'object' && typeof state.state === 'string' ? state.state : 'dl.idle';
  if (!own(AVAILABILITY, id)) {
    return { id, text: cutText(`?? ${id}`), severity: 'caution', hint: '' };
  }
  const entry = AVAILABILITY[id];
  const text = id === 'dl.http-error' ? withStatus(entry.text, state.httpStatus) : entry.text;
  return { id, text, severity: entry.severity, hint: entry.hint };
}

/** Scratchpad text for a failed host result, or null when none should show. */
export function errorText(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (!own(ERROR_TEXT, code)) return UNKNOWN_ERROR_TEXT;
  const text = ERROR_TEXT[code];
  return code === 'http-error' ? withStatus(text, error.httpStatus) : text;
}

export function formatScope(scope) {
  if (!scope || typeof scope !== 'object') return '----';
  if (scope.kind === 'none') return NO_FLIGHT_PLAN;
  if (scope.kind === 'flight') {
    return scope.plannedLegId == null
      ? `FLT ${scope.flightId}`
      : `FLT ${scope.flightId} LEG ${scope.plannedLegId}`;
  }
  if (scope.kind === 'leg') return `LEG ${scope.plannedLegId}`;
  return '----';
}

export function formatTarget(target) {
  if (!target || typeof target !== 'object') return '';
  return target.kind === 'flight' ? `FLT ${target.id}` : `LEG ${target.id}`;
}

/** `HHMM` in UTC from epoch milliseconds or an ISO string; `----` otherwise. */
export function formatTime(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return '----';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '----';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

/** `UP 1432Z METAR EGLL`: direction, UTC time and the label or category. */
export function formatMessageHeader(message) {
  const dir = message.direction === 'uplink' ? 'UP' : 'DN';
  const title = typeof message.label === 'string' && message.label.trim()
    ? message.label
    : String(message.category ?? '').toUpperCase();
  return cutText(`${dir} ${formatTime(message.sentAt)}Z ${title}`);
}

/** `<` and the first non-empty body line, as the thread list shows it. */
export function formatMessagePreview(message) {
  const first = normaliseText(message.body).split('\n').find((line) => line.length > 0) ?? '';
  return cutText(`<${first}`);
}

// ── Writes ───────────────────────────────────────────────────────────────────

export const NO_LINKED_LEG = 'NO LINKED LEG';
export const NO_WEATHER_AVAILABLE = 'NO WEATHER AVAILABLE';
export const ILLUSTRATIVE_MARKER = 'ILLUSTRATIVE ONLY';
const SHEET_PLACEHOLDER = '-----';

/**
 * The one scratchpad value that may reach a datalink write: a four-character
 * ICAO, letter first. Anything else is refused before a request exists.
 */
export function validateIcao(entry) {
  const s = String(entry ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{3}$/.test(s) ? { ok: true, icao: s } : { ok: false };
}

/**
 * Where a canned downlink or WX request is posted, captured when the user
 * selects it: the flight in flight scope, the planned leg in leg scope, and
 * nothing without a flight plan.
 */
export function writeTarget(scope) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.kind === 'flight' && Number.isSafeInteger(scope.flightId)) return { kind: 'flight', id: scope.flightId };
  if (scope.kind === 'leg' && Number.isSafeInteger(scope.plannedLegId)) return { kind: 'leg', id: scope.plannedLegId };
  return null;
}

/**
 * Load sheets are generated per planned leg only. In flight scope that is the
 * leg the flight is linked to; a flight without one is refused rather than
 * guessed at.
 */
export function loadsheetLeg(scope) {
  if (!scope || typeof scope !== 'object' || (scope.kind !== 'flight' && scope.kind !== 'leg')) {
    return { ok: false, text: NO_FLIGHT_PLAN };
  }
  if (!Number.isSafeInteger(scope.plannedLegId)) {
    return { ok: false, text: scope.kind === 'flight' ? NO_LINKED_LEG : NO_FLIGHT_PLAN };
  }
  return { ok: true, plannedLegId: scope.plannedLegId };
}

/** METAR and TAF as one text for the pager, or the no-weather line. */
export function weatherText(result) {
  if (!result || !result.available || (result.metar == null && result.taf == null)) return NO_WEATHER_AVAILABLE;
  return ['METAR', result.metar ?? 'NOT AVAILABLE', '', 'TAF', result.taf ?? 'NOT AVAILABLE'].join('\n');
}

/** A load sheet figure; a missing one is dashes, never a zero. */
export function formatSheetValue(value, units) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SHEET_PLACEHOLDER;
  const suffix = typeof units === 'string' && units.length > 0 ? ` ${units.toUpperCase()}` : '';
  return `${Math.round(value)}${suffix}`;
}

export function formatSheetSource(sheet) {
  const source = (value) => (typeof value === 'string' ? value : SHEET_PLACEHOLDER);
  return cutText(`SOURCE PLD ${source(sheet.payloadSource)} ZFW ${source(sheet.zfwSource)}`.toUpperCase());
}
