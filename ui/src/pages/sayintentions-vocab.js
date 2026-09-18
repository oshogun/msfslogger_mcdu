// CDU wording and rules for SayIntentions: which flight a link, unlink or
// import would go to, which planned leg a PDC push would go to, the page texts,
// the error texts and the link formatters. Pure and DOM-free.
//
// Every string here fits one 48-column cell, and any two sharing a row fit 47
// columns together, leaving a gap on the 50-column grid. A server's own `error`
// text is never shown: each code has a fixed text, and a code this build does
// not know reads as a fault.
//
// Nothing here knows the SayIntentions API key. The key is set on the web app's
// Prefiles page and the panel is told only whether one is on file, so there is
// no masked value to render and no entry for one to collect.

import { clearanceLeg } from './clearance-vocab.js';
import { paginateText } from './datalink-text.js';
import { NO_FLIGHT_PLAN, cutText, formatTime } from './datalink-vocab.js';

/** Columns row 4 reserves for the upstream session id. */
export const SESSION_COLUMNS = 32;
/** Display rows reserved for what was pushed upstream; the text always fits. */
export const PDC_TEXT_ROWS = 4;
/** What the counts are printed in, so six columns always suffice. */
const COUNT_MAX = 999999;
const SENT_TEXT_MAX_UNITS = 144;
const SESSION_MAX_UNITS = 64;
const STAMP_MAX_UNITS = 32;

const SET_KEY_ON_WEB = 'SET KEY ON WEB PREFILES PAGE';

/** The default: it backfills the taxi calls the session already holds. */
export const DEFAULT_FROM = 'session-start';

/** Local refusals: nothing is sent. */
export const REFUSAL = {
  needsFlight: 'NEEDS ACTIVE FLIGHT',
  noFlightPlan: NO_FLIGHT_PLAN,
  // No scopePending here: the PDC send inherits the scope-lag refusal from
  // clearance-vocab.js, so a copy would only be free to drift from it.
  tokenRejected: 'INGEST TOKEN REJECTED',
  noConfig: 'DATALINK NO CONFIG',
  flightChanged: 'SI FLIGHT CHANGED',
  legChanged: 'PDC LEG CHANGED',
};

/** Page texts. */
export const TEXT = {
  indexPrompt: 'SAYINTENTIONS>',
  title: 'SAYINTENTIONS',
  keyLabel: 'SI KEY',
  keyOnFile: 'KEY ON FILE',
  noKeyOnFile: 'NO KEY ON FILE',
  loading: 'LOADING',
  session: 'SESSION',
  imported: 'IMPORTED',
  linked: 'LINKED',
  lastImport: 'LAST IMPORT',
  linkFrom: 'LINK FROM',
  fromNow: 'NOW',
  fromSessionStart: 'SESSION START',
  link: '<LINK',
  unlink: '<UNLINK',
  import: 'IMPORT>',
  return: '<RETURN',
  refresh: 'REFRESH>',
  unknownText: '----',
  unknownCount: '---',
  onceFlying: 'LINK AVAILABLE ONCE FLYING',
  setKeyOnWeb: SET_KEY_ON_WEB,
  confirmLink: 'CONFIRM LINK',
  confirmUnlink: 'CONFIRM UNLINK',
  confirmImport: 'CONFIRM IMPORT',
  confirmTitle: 'CONFIRM SI ACTION',
  actionLink: 'LINK SESSION',
  actionUnlink: 'UNLINK SESSION',
  actionImport: 'IMPORT COMMS',
  confirm: 'CONFIRM',
  to: 'TO',
  noPending: 'NO PENDING ACTION',
  lastRequest: 'LAST REQUEST',
  cancel: '<CANCEL',
  send: 'SEND*',
  sending: 'SENDING',
  clearancePrompt: 'SEND PDC>',
  pdcTitle: 'SEND PDC',
  toSayIntentions: 'TO SAYINTENTIONS',
  lastSent: 'LAST SENT',
};

/** Scratchpad advisories after an action succeeds. */
export const ADVISORY = {
  linked: 'SESSION LINKED',
  relinked: 'SESSION RELINKED',
  unlinked: 'SESSION UNLINKED',
  noLinkToRemove: 'NO LINK TO REMOVE',
  noNewComms: 'NO NEW COMMS',
  pdcSent: 'PDC SENT',
};

/**
 * The hint after an outcome nobody can vouch for. A re-link rebinds the same
 * session, an unlink is idempotent and an import dedups on the server, so all
 * three are safe to repeat. A second PDC push files a second row and puts a
 * second message into a live session, and nothing can be checked afterwards to
 * find out whether the first one arrived.
 */
export const SAFE_TO_PRESS_AGAIN = 'SAFE TO PRESS AGAIN';
export const PDC_MAY_HAVE_BEEN_SENT = 'PDC MAY HAVE BEEN SENT';
export const UNKNOWN_CODE_TEXT = 'SAYINTENTIONS FAULT';

/**
 * Error code → `{ text, hint, kind }`; an empty hint shows nothing. `kind` is
 * the scratchpad kind, so no page decides it: a code whose sentence is "not
 * ready yet" is an advisory, a code whose sentence is "something is wrong" is
 * an error.
 */
export const ERRORS = {
  'si-no-api-key': { text: 'NO SAYINTENTIONS KEY', hint: SET_KEY_ON_WEB, kind: 'error' },
  'si-bad-api-key': { text: 'SAYINTENTIONS KEY REJECTED', hint: 'CHECK KEY ON WEB PREFILES PAGE', kind: 'error' },
  'si-not-linked': { text: 'SAYINTENTIONS NOT LINKED', hint: 'LINK THIS FLIGHT ON DL-SI FIRST', kind: 'error' },
  'si-session-changed': { text: 'SAYINTENTIONS SESSION CHANGED', hint: 'UNLINK THEN LINK AGAIN', kind: 'error' },
  'si-no-comms': { text: 'NO RADIO CALLS YET', hint: 'CALL ATC IN THE SIM THEN LINK', kind: 'advisory' },
  'si-no-session': { text: 'SAYINTENTIONS NOT RUNNING', hint: 'START SAYINTENTIONS THEN RETRY', kind: 'advisory' },
  'si-no-clearance': { text: 'NO PDC ON FILE', hint: 'REQUEST CLEARANCE ON DL-INDEX R5', kind: 'error' },
  'si-upstream-unreachable': { text: 'SAYINTENTIONS NO COMM', hint: '', kind: 'error' },
  'si-upstream-timeout': { text: 'SAYINTENTIONS TIMEOUT', hint: '', kind: 'error' },
  'si-upstream-error': { text: 'SAYINTENTIONS UPSTREAM FAULT', hint: '', kind: 'error' },
  'si-upstream-bad-body': { text: 'SAYINTENTIONS UPSTREAM BAD DATA', hint: '', kind: 'error' },
  'flight-not-found': { text: 'FLIGHT NOT FOUND', hint: '', kind: 'error' },
  'leg-not-found': { text: 'PLANNED LEG NOT FOUND', hint: '', kind: 'error' },
  'invalid-id': { text: 'DATALINK INVALID ID', hint: '', kind: 'error' },
  'token-invalid': { text: 'INGEST TOKEN REJECTED', hint: 'CHECK INGEST TOKEN ON CFG NETWORK', kind: 'error' },
  'token-missing': { text: 'SAYINTENTIONS TOKEN NOT RECEIVED', hint: 'TOKEN HEADER LOST IN TRANSIT', kind: 'error' },
  'sayintentions-unavailable': { text: 'SAYINTENTIONS UNAVAILABLE', hint: 'SERVER UPDATE NEEDED', kind: 'error' },
  rejected: { text: 'SAYINTENTIONS REJECTED 403', hint: '', kind: 'error' },
  'http-error': { text: 'SAYINTENTIONS FAULT', hint: '', kind: 'error' },
  'bad-response': { text: 'SAYINTENTIONS BAD DATA', hint: '', kind: 'error' },
  'too-large': { text: 'SAYINTENTIONS BAD DATA', hint: '', kind: 'error' },
  timeout: { text: 'SAYINTENTIONS RESULT UNKNOWN', hint: '', kind: 'error' },
  'tls-error': { text: 'DATALINK CERT FAULT', hint: 'CHECK CERTIFICATE PATH', kind: 'error' },
  unreachable: { text: 'DATALINK NO COMM', hint: '', kind: 'error' },
  'no-config': { text: 'DATALINK NO CONFIG', hint: 'COMPLETE CFG NETWORK', kind: 'error' },
  'sayintentions-in-progress': { text: 'SAYINTENTIONS IN PROGRESS', hint: '', kind: 'error' },
  'bad-request': { text: 'INVALID ENTRY', hint: '', kind: 'error' },
  busy: { text: 'DATALINK BUSY', hint: '', kind: 'error' },
  'shell-timeout': { text: 'SAYINTENTIONS RESULT UNKNOWN', hint: '', kind: 'error' },
  'sidecar-exited': { text: 'DATALINK OFFLINE', hint: '', kind: 'error' },
  'sidecar-unavailable': { text: 'DATALINK OFFLINE', hint: '', kind: 'error' },
  'sidecar-outdated': { text: 'SIDECAR UPDATE REQUIRED', hint: 'REBUILD SIDECAR THEN RESTART APP', kind: 'error' },
  'host-unsupported': { text: 'SAYINTENTIONS NOT SUPPORTED', hint: '', kind: 'error' },
  'host-error': { text: 'SAYINTENTIONS HOST FAULT', hint: '', kind: 'error' },
};

/**
 * Codes after which nobody can say whether the action took effect: the request
 * may have reached the server before the answer was lost. What to do about
 * that depends on the action, which is why the hint does too.
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

/**
 * The hint under `errorText` on a confirm page, or '' when there is none.
 * `action` is 'link', 'unlink', 'import' or 'pdc'.
 */
export function errorHint(error, action) {
  const code = codeOf(error);
  if (isUnknownOutcome(code)) return action === 'pdc' ? PDC_MAY_HAVE_BEEN_SENT : SAFE_TO_PRESS_AGAIN;
  return ERRORS[code].hint;
}

/** The scratchpad kind for a failed request. */
export function errorKind(error) {
  const code = codeOf(error);
  return own(ERRORS, code) ? ERRORS[code].kind : 'error';
}

const refuse = (text) => ({ ok: false, text });

/**
 * The flight a link, unlink or import would go to, or the refusal to show
 * instead. These three need a live flight: the server keeps the link on the
 * flight row, and an import against a planned leg would land in the thread of
 * whichever flight later linked to that leg. A prefiled or ground-session leg
 * is therefore not "no flight plan" but "not flying yet", and the page's hint
 * line says when it arrives.
 */
export function sayIntentionsFlight(state) {
  if (!state || typeof state !== 'object') return refuse(REFUSAL.noFlightPlan);
  if (state.state === 'dl.token-invalid') return refuse(REFUSAL.tokenRejected);
  if (state.state === 'dl.no-config') return refuse(REFUSAL.noConfig);
  const scope = state.scope && typeof state.scope === 'object' ? state.scope : null;
  if (!scope || scope.kind !== 'flight') return refuse(REFUSAL.needsFlight);
  if (!Number.isSafeInteger(scope.flightId) || scope.flightId < 1) return refuse(REFUSAL.noFlightPlan);
  return { ok: true, flightId: scope.flightId };
}

/**
 * The planned leg a PDC push would go to. It is the clearance rule itself, not
 * a copy of it: the push must go to exactly the leg whose clearance the
 * clearance page is showing, so a second implementation could send a PDC for
 * another leg. It carries that rule's refusal while a held prefiled leg and
 * the published scope still disagree.
 */
export const pdcLeg = clearanceLeg;

/** `SESSION LINKED` / `SESSION RELINKED`, with the messages waiting upstream. */
export function linkAdvisory(result) {
  const base = result.created ? ADVISORY.linked : ADVISORY.relinked;
  return result.pendingMessages > 0 ? `${base} ${result.pendingMessages} PENDING` : base;
}

/** Removing a link that was not there is still a success. */
export function unlinkAdvisory(result) {
  return result.unlinked ? ADVISORY.unlinked : ADVISORY.noLinkToRemove;
}

export function importAdvisory(result) {
  if (result.imported <= 0) return ADVISORY.noNewComms;
  const base = `IMPORTED ${result.imported} MSGS`;
  return result.skipped > 0 ? `${base} SKIPPED ${result.skipped}` : base;
}

/**
 * The upstream session id, cut to the columns row 4 reserves. It is an opaque
 * id shown for recognition, not a value the panel acts on, so a longer one is
 * shown cut rather than refused.
 */
export function formatSession(id) {
  return typeof id === 'string' && id.length > 0 ? cutText(id, SESSION_COLUMNS) : TEXT.unknownText;
}

export function formatCount(n) {
  return Number.isSafeInteger(n) && n >= 0 && n <= COUNT_MAX ? String(n) : TEXT.unknownCount;
}

export function formatStamp(value) {
  const time = formatTime(value);
  return time === TEXT.unknownText ? TEXT.unknownText : `${time}Z`;
}

export function formatFlight(id) {
  return `FLT ${id}`;
}

/** What was pushed upstream, as the display lines the page reserves rows for. */
export function sentTextLines(text) {
  return paginateText(text)[0].slice(0, PDC_TEXT_ROWS).map((line) => cutText(line.text));
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0 && n <= COUNT_MAX;

const isStamp = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= STAMP_MAX_UNITS
  && Number.isFinite(Date.parse(value));

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The link row as the pages draw it. `sinceId` and `baselineCommId` are not
 * checked because nothing shows them; every field a row does show must be
 * there, because a link state the panel cannot describe is not one it may draw.
 */
function isLink(link) {
  if (!isObject(link)) return false;
  return typeof link.upstreamFlightId === 'string'
    && link.upstreamFlightId.length > 0 && link.upstreamFlightId.length <= SESSION_MAX_UNITS
    && isStamp(link.linkedAt)
    && (link.lastImportAt === null || isStamp(link.lastImportAt))
    && isCount(link.importedCount);
}

/**
 * Whether the answer is the status of the flight that was asked about. A null
 * `flightId` asks the key question alone, and the answer must say so rather
 * than carry a link state nobody asked for.
 */
export function isSiStatusResult(result, flightId) {
  if (!isObject(result) || typeof result.apiKeySet !== 'boolean') return false;
  if (flightId === null) {
    return result.answered === 'settings' && result.flightId === null
      && result.linked === null && result.link === null;
  }
  if (result.answered !== 'link' || result.flightId !== flightId) return false;
  if (typeof result.linked !== 'boolean') return false;
  return result.linked ? isLink(result.link) : result.link === null;
}

export function isSiLinkResult(result, flightId) {
  if (!isObject(result) || result.flightId !== flightId) return false;
  return typeof result.created === 'boolean' && isCount(result.pendingMessages) && isLink(result.link);
}

export function isSiUnlinkResult(result, flightId) {
  return isObject(result) && result.flightId === flightId && typeof result.unlinked === 'boolean';
}

export function isSiImportResult(result, flightId) {
  if (!isObject(result) || result.flightId !== flightId) return false;
  return isCount(result.imported) && isCount(result.skipped);
}

export function isSiPdcResult(result, plannedLegId) {
  if (!isObject(result) || result.plannedLegId !== plannedLegId) return false;
  return typeof result.sentText === 'string'
    && result.sentText.length > 0 && result.sentText.length <= SENT_TEXT_MAX_UNITS;
}
