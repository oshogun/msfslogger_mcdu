// CDU wording and rules for the simulated pre-departure clearance: which
// planned leg a request would go to, the confirm and result page texts, the
// error texts, and the altitude, pair and route layout. Pure and DOM-free.
//
// Every string here fits one 48-column cell, and any two sharing a row fit 47
// columns together, leaving a gap on the 50-column grid. A server's own `error`
// text is never shown: each code has a fixed text, and a code this build does
// not know reads as a fault.

import { TEXT_COLUMNS, paginateText } from './datalink-text.js';
import { NO_FLIGHT_PLAN, loadsheetLeg } from './datalink-vocab.js';
import { heldPrefiledLeg } from './fpln-vocab.js';

export const CELL_COLUMNS = TEXT_COLUMNS;
export const ROW_COLUMNS = TEXT_COLUMNS - 1;

/** Clearances kept in memory, one per planned leg, most recent last. */
export const RESULTS_KEPT = 4;
export const PAGE1_ROUTE_LINES = 5;
export const MORE_ROUTE_LINES = 9;

const ROUTE_MAX_UNITS = 4096;
const ICAO_MAX_UNITS = 8;
const ALTITUDE_MAX_FT = 99999;
const FLIGHT_LEVEL_FROM_FT = 18000;

/** Local refusals: nothing is sent. */
export const REFUSAL = {
  noFlightPlan: NO_FLIGHT_PLAN,
  noLinkedLeg: 'NO LINKED LEG',
  scopePending: 'SCOPE UPDATE PENDING',
  tokenRejected: 'INGEST TOKEN REJECTED',
  noConfig: 'DATALINK NO CONFIG',
  legChanged: 'CLEARANCE LEG CHANGED',
};

/** Page texts. */
export const TEXT = {
  indexPrompt: 'CLEARANCE>',
  confirmTitle: 'REQUEST CLEARANCE',
  confirmHeading: 'CLEARANCE REQUEST',
  simulatedPdc: 'SIMULATED PDC',
  to: 'TO',
  noPending: 'NO PENDING REQUEST',
  lastRequest: 'LAST REQUEST',
  cancel: '<CANCEL',
  send: 'SEND*',
  sending: 'SENDING',
  return: '<RETURN',
  resultTitle: 'CLEARANCE',
  marker: 'SIMULATED CLEARANCE',
  notReal: 'NOT FOR REAL WORLD USE',
  alreadyIssued: 'ALREADY ISSUED',
  unknownIcao: '----',
  initialAlt: 'INITIAL ALT',
  squawk: 'SQUAWK',
  clearedVia: 'CLEARED VIA',
  noRoute: 'NO ROUTE ON FILE',
  noResult: 'NO CLEARANCE RECEIVED',
  messages: 'MESSAGES>',
  noAltitude: '-----',
};

/** Scratchpad advisories after a clearance arrives. */
export const ADVISORY = {
  created: 'CLEARANCE RECEIVED',
  onFile: 'CLEARANCE ON FILE',
};

export const SAFE_TO_REQUEST_AGAIN = 'SAFE TO REQUEST AGAIN';
export const UNKNOWN_CODE_TEXT = 'CLEARANCE FAULT';

/** Error code → `{ text, hint }`; an empty hint shows nothing. */
export const ERRORS = {
  'leg-not-found': { text: 'PLANNED LEG NOT FOUND', hint: '' },
  'clearance-no-flight-plan': { text: 'NO DISPATCH RELEASE ON FILE', hint: 'IMPORT THE PLAN FROM SIMBRIEF' },
  'clearance-unavailable': { text: 'CLEARANCE UNAVAILABLE', hint: 'SERVER UPDATE NEEDED' },
  'token-invalid': { text: 'INGEST TOKEN REJECTED', hint: 'CHECK INGEST TOKEN ON CFG NETWORK' },
  'token-missing': { text: 'CLEARANCE TOKEN NOT RECEIVED', hint: 'TOKEN HEADER LOST IN TRANSIT' },
  rejected: { text: 'CLEARANCE REJECTED 403', hint: '' },
  'http-error': { text: 'CLEARANCE FAULT', hint: '' },
  'bad-response': { text: 'CLEARANCE BAD DATA', hint: '' },
  'too-large': { text: 'CLEARANCE BAD DATA', hint: '' },
  unreachable: { text: 'CLEARANCE NO COMM', hint: '' },
  'tls-error': { text: 'CLEARANCE CERT FAULT', hint: 'CHECK CERTIFICATE PATH' },
  timeout: { text: 'CLEARANCE RESULT UNKNOWN', hint: '' },
  'shell-timeout': { text: 'CLEARANCE RESULT UNKNOWN', hint: '' },
  'no-config': { text: 'DATALINK NO CONFIG', hint: 'COMPLETE CFG NETWORK' },
  'bad-request': { text: 'INVALID ENTRY', hint: '' },
  'clearance-in-progress': { text: 'CLEARANCE IN PROGRESS', hint: '' },
  busy: { text: 'DATALINK BUSY', hint: '' },
  'sidecar-exited': { text: 'DATALINK OFFLINE', hint: '' },
  'sidecar-unavailable': { text: 'DATALINK OFFLINE', hint: '' },
  'sidecar-outdated': { text: 'SIDECAR UPDATE REQUIRED', hint: 'REBUILD SIDECAR THEN RESTART APP' },
  'host-unsupported': { text: 'CLEARANCE NOT SUPPORTED', hint: '' },
  'host-error': { text: 'CLEARANCE HOST FAULT', hint: '' },
};

/**
 * Codes after which nobody can say whether the clearance was issued: the
 * request may have reached the server before the answer was lost. Asking again
 * is safe because the server answers a repeat with the clearance already on
 * file rather than issuing a second one.
 */
const UNKNOWN_OUTCOME_CODES = new Set([
  'http-error', 'bad-response', 'too-large', 'unreachable', 'timeout', 'shell-timeout',
  'sidecar-exited', 'host-error',
]);

const own = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);

/**
 * A missing or malformed error, including one without a string code, is the
 * host's fault, not the server's. A well-formed code this build does not know
 * is a fault of its own.
 */
function codeOf(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'host-error';
}

export function isUnknownOutcome(code) {
  return !own(ERRORS, code) || UNKNOWN_OUTCOME_CODES.has(code);
}

/** Scratchpad and last-request text for a failed request. */
export function errorText(error) {
  const code = codeOf(error);
  if (!own(ERRORS, code)) return UNKNOWN_CODE_TEXT;
  if (code === 'http-error') {
    const status = error.httpStatus;
    return Number.isInteger(status) && status >= 100 && status <= 599
      ? `${ERRORS[code].text} ${status}`
      : ERRORS[code].text;
  }
  return ERRORS[code].text;
}

/** The hint under `errorText` on the confirm page, or '' when there is none. */
export function errorHint(error) {
  const code = codeOf(error);
  if (isUnknownOutcome(code)) return SAFE_TO_REQUEST_AGAIN;
  return ERRORS[code].hint;
}

const refuse = (text) => ({ ok: false, text });

/**
 * The planned leg a clearance request would be written to, from the datalink
 * state, or the refusal to show instead. It builds on the load sheet rule but
 * refuses more, because a clearance writes logbook rows:
 *
 * - a flight outranks a held prefiled leg, which the sidecar clears on seeing it;
 * - otherwise a held prefiled leg must be the leg the scope has already moved
 *   to, and a prefile scope must match a held leg; until both agree the scope
 *   update is still on its way and a request could land on the wrong leg;
 * - a rejected token or a missing config refuses before a confirm page opens
 *   that could never succeed;
 * - a leg id below 1 is no leg at all.
 */
export function clearanceLeg(state) {
  if (!state || typeof state !== 'object') return refuse(REFUSAL.noFlightPlan);
  if (state.state === 'dl.token-invalid') return refuse(REFUSAL.tokenRejected);
  if (state.state === 'dl.no-config') return refuse(REFUSAL.noConfig);
  const scope = state.scope && typeof state.scope === 'object' ? state.scope : null;
  let leg;
  if (scope && scope.kind === 'flight') {
    leg = loadsheetLeg(scope);
  } else {
    const held = heldPrefiledLeg(state);
    const prefileScope = Boolean(scope && scope.kind === 'leg' && scope.source === 'prefile');
    if ((held || prefileScope) && !(held && prefileScope && scope.plannedLegId === held.plannedLegId)) {
      return refuse(REFUSAL.scopePending);
    }
    leg = loadsheetLeg(scope);
  }
  if (leg.ok && leg.plannedLegId < 1) return refuse(REFUSAL.noFlightPlan);
  return leg.ok ? { ok: true, plannedLegId: leg.plannedLegId } : refuse(leg.text);
}

export function formatLeg(id) {
  return `LEG ${id}`;
}

/** `5000FT` below 18 000 ft, `FL180` from there up; dashes for anything else. */
export function formatAltitude(ft) {
  if (!Number.isSafeInteger(ft) || ft < 0) return TEXT.noAltitude;
  if (ft >= FLIGHT_LEVEL_FROM_FT) return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;
  return `${ft}FT`;
}

/** `KJFK TO EGLL`, with dashes for an airport the server did not have. */
export function formatPair(result) {
  const icao = (value) => (typeof value === 'string' && value.length > 0 ? value : TEXT.unknownIcao);
  return `${icao(result && result.departure)} TO ${icao(result && result.destination)}`;
}

/** The route as display lines of the text pager: word-wrapped, nothing lost. */
export function routeLines(route) {
  return paginateText(route).flat();
}

/** Page 1 holds five route lines under the clearance; each further page nine. */
export function routePageCount(route) {
  if (route === null || route === undefined) return 1;
  const lines = routeLines(route).length;
  return 1 + Math.ceil(Math.max(0, lines - PAGE1_ROUTE_LINES) / MORE_ROUTE_LINES);
}

export function routeLinesOnPage(route, page) {
  const lines = routeLines(route);
  if (page <= 1) return lines.slice(0, PAGE1_ROUTE_LINES);
  const start = PAGE1_ROUTE_LINES + (page - 2) * MORE_ROUTE_LINES;
  return lines.slice(start, start + MORE_ROUTE_LINES);
}

const isIcao = (value) => value === null || (typeof value === 'string' && value.length <= ICAO_MAX_UNITS);

/** Whether a host result is a clearance for `plannedLegId` that the pages can draw. */
export function isClearanceResult(result, plannedLegId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  return result.plannedLegId === plannedLegId
    && typeof result.created === 'boolean'
    && typeof result.squawk === 'string' && /^[0-7]{4}$/.test(result.squawk)
    && Number.isSafeInteger(result.initialAltitudeFt)
    && result.initialAltitudeFt >= 0 && result.initialAltitudeFt <= ALTITUDE_MAX_FT
    && isIcao(result.departure) && isIcao(result.destination)
    && (result.route === null || (typeof result.route === 'string' && result.route.length <= ROUTE_MAX_UNITS));
}
