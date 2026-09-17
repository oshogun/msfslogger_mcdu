// CDU wording for the FPLN pages: the SimBrief Pilot ID setting, the PREFILE
// outcome, the held prefiled leg and its label. Pure and DOM-free.
//
// Every string here fits a classic 24-column CDU line at its widest value.
// A server's own `error` text is never shown: each code the host can answer
// with has a fixed text and hint, and anything this build does not know reads
// as a fault rather than as whatever the server said.

export const COLUMNS = 24;

/** Error code → `{ text, hint }`; an empty hint shows nothing. */
export const ERRORS = {
  'simbrief-no-user-id': { text: 'NO SIMBRIEF PILOT ID', hint: 'SET PILOT ID ON SERVER' },
  'simbrief-unknown-user': { text: 'SIMBRIEF ID NOT FOUND', hint: 'CHECK PILOT ID ON SERVER' },
  'simbrief-no-plan': { text: 'NO SIMBRIEF OFP', hint: 'GENERATE OFP ON SIMBRIEF' },
  'simbrief-timeout': { text: 'SIMBRIEF TIMEOUT', hint: 'TRY AGAIN SHORTLY' },
  'simbrief-network': { text: 'SIMBRIEF NO COMM', hint: 'TRY AGAIN SHORTLY' },
  'simbrief-bad-status': { text: 'SIMBRIEF ERROR', hint: 'TRY AGAIN SHORTLY' },
  'simbrief-bad-body': { text: 'SIMBRIEF BAD DATA', hint: 'TRY AGAIN SHORTLY' },
  'simbrief-db-error': { text: 'SERVER DB ERROR', hint: '' },
  'simbrief-unavailable': { text: 'SIMBRIEF UNAVAILABLE', hint: 'SERVER UPDATE NEEDED' },
  'token-invalid': { text: 'INGEST TOKEN REJECTED', hint: 'CHECK TOKEN ON CFG' },
  'token-missing': { text: 'TOKEN NOT RECEIVED', hint: 'TOKEN LOST IN TRANSIT' },
  rejected: { text: 'SERVER REJECTED 403', hint: '' },
  'http-error': { text: 'SERVER FAULT', hint: '' },
  'bad-response': { text: 'SERVER BAD DATA', hint: '' },
  'too-large': { text: 'SERVER BAD DATA', hint: '' },
  unreachable: { text: 'SERVER NO COMM', hint: '' },
  'tls-error': { text: 'SERVER CERT FAULT', hint: 'CHECK CERTIFICATE PATH' },
  timeout: { text: 'SERVER TIMEOUT', hint: '' },
  'shell-timeout': { text: 'SIDECAR TIMEOUT', hint: '' },
  'no-config': { text: 'SERVER NOT CONFIGURED', hint: 'COMPLETE CFG NETWORK' },
  'bad-request': { text: 'INVALID ENTRY', hint: '' },
  'prefile-in-progress': { text: 'PREFILE IN PROGRESS', hint: '' },
  busy: { text: 'SIDECAR BUSY', hint: '' },
  'sidecar-exited': { text: 'SIDECAR OFFLINE', hint: '' },
  'sidecar-unavailable': { text: 'SIDECAR OFFLINE', hint: '' },
  'sidecar-outdated': { text: 'SIDECAR UPDATE REQUIRED', hint: 'RESTART APP AFTER BUILD' },
  'host-unsupported': { text: 'FPLN NOT SUPPORTED', hint: '' },
  'host-error': { text: 'FPLN HOST FAULT', hint: '' },
};

export const UNKNOWN_CODE_TEXT = 'FPLN FAULT';
export const PREFILE_RESULT_UNKNOWN = 'PREFILE RESULT UNKNOWN';
export const SAFE_TO_PREFILE_AGAIN = 'SAFE TO PREFILE AGAIN';

/**
 * Codes after which nobody can say whether the plan was imported: the request
 * may have reached the server before the answer was lost. PREFILE is safe to
 * press again because the server answers a repeat with ALREADY FILED.
 */
const UNKNOWN_OUTCOME_CODES = new Set([
  'http-error', 'bad-response', 'too-large', 'unreachable', 'timeout', 'shell-timeout',
  'sidecar-exited', 'host-error',
]);

/** Page texts. */
export const TEXT = {
  menu: '<FPLN',
  title: 'FLIGHT PLAN',
  pilotId: 'SIMBRIEF PILOT ID',
  configured: 'CONFIGURED',
  notSet: 'NOT SET',
  notSetHint: 'SET PILOT ID ON SERVER',
  unknown: '----',
  prefiledLeg: 'PREFILED LEG',
  prefileScope: 'PREFILE',
  none: 'NONE',
  clearPrefile: 'CLR PREFILE>',
  lastPrefile: 'LAST PREFILE',
  toMenu: '<MENU',
  prefile: 'PREFILE>',
  sending: 'SENDING',
  confirmTitle: 'PREFILE SIMBRIEF',
  import: 'IMPORT',
  latestOfp: 'LATEST SIMBRIEF OFP',
  as: 'AS',
  plannedLegNoTrip: 'PLANNED LEG, NO TRIP',
  wait: 'WAIT UP TO 30 SEC',
  cancel: '<CANCEL',
  confirm: 'CONFIRM*',
  resultTitle: 'PREFILE',
  prefiled: 'PREFILED',
  alreadyFiled: 'ALREADY FILED',
  plannedLeg: 'PLANNED LEG',
  warnings: 'WARNINGS',
  datalink: 'DATALINK>',
  return: '<RETURN',
  noResult: 'NO PREFILE RESULT',
};

/** Scratchpad advisories. */
export const ADVISORY = {
  imported: 'SIMBRIEF PLAN PREFILED',
  duplicate: 'PLAN ALREADY FILED',
  cleared: 'PREFILE CLEARED',
};

const own = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

/** A missing or malformed error is the host's fault, not the server's. */
function codeOf(error) {
  return error && typeof error === 'object' ? error.code : 'host-error';
}

export function isUnknownOutcome(code) {
  return !own(ERRORS, code) || UNKNOWN_OUTCOME_CODES.has(code);
}

/** The row or scratchpad text for a failed host result. `op` is settings, prefile or clear. */
export function errorText(error, op) {
  const code = codeOf(error);
  if (!own(ERRORS, code)) return UNKNOWN_CODE_TEXT;
  if (op === 'prefile' && (code === 'timeout' || code === 'shell-timeout')) return PREFILE_RESULT_UNKNOWN;
  if (code === 'http-error') {
    const status = error.httpStatus;
    return Number.isInteger(status) && status >= 100 && status <= 599
      ? `${ERRORS[code].text} ${status}`
      : ERRORS[code].text;
  }
  return ERRORS[code].text;
}

/** The hint line under `errorText`, or '' when there is none. */
export function errorHint(error, op) {
  const code = codeOf(error);
  if (op === 'prefile' && isUnknownOutcome(code)) return SAFE_TO_PREFILE_AGAIN;
  return own(ERRORS, code) ? ERRORS[code].hint : '';
}

/**
 * A leg label as the CDU can draw it: accents stripped, the route arrow as a
 * slash, dashes and whitespace plain, upper case, and anything outside
 * printable ASCII as `?`.
 */
export function normaliseLabel(label) {
  const text = String(label ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\u2192\s*/g, '/')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  let out = '';
  for (const char of text) {
    const point = char.codePointAt(0);
    out += point >= 0x20 && point <= 0x7e ? char : '?';
  }
  return out === '' ? TEXT.unknown : out;
}

/** One or two lines of at most 24 columns, broken at a space when there is one. */
export function labelLines(normalised) {
  const n = String(normalised);
  if (n.length <= COLUMNS) return [n];
  const i = n.lastIndexOf(' ', COLUMNS);
  let first;
  let rest;
  if (i >= 1) {
    first = n.slice(0, i);
    rest = n.slice(i + 1);
  } else {
    first = n.slice(0, COLUMNS);
    rest = n.slice(COLUMNS);
  }
  if (rest.length > COLUMNS) rest = `${rest.slice(0, COLUMNS - 1)}+`;
  return [first, rest];
}

export function formatLeg(id) {
  return `LEG ${id}`;
}

/** The prefiled leg the sidecar holds, from a datalink state, or null. */
export function heldPrefiledLeg(state) {
  const leg = state && typeof state === 'object' ? state.prefiledLeg : null;
  if (!leg || typeof leg !== 'object') return null;
  if (!Number.isSafeInteger(leg.plannedLegId) || leg.plannedLegId < 1) return null;
  if (typeof leg.label !== 'string') return null;
  return leg;
}
