// SayIntentions: DL-SI, which shows the key and link state and stages the three
// flight actions, DL-SI-CONFIRM, the one page from which a link, unlink or
// import is actually made, and DL-SI-PDC, the one page from which a simulated
// PDC is pushed upstream. DL-INDEX R2 and DL-CLEARANCE R5 open them through the
// actions registered here.
//
// Import rule for this directory applies here too: the outside world is
// reached only through the page interface handed to `register`.
//
// No key press sends by itself, the import included: every import reaches the
// real SayIntentions service, so an accidental LSK press must not get there.
// The flight or leg an action goes to is the one its confirm page shows,
// checked again against the current datalink state at the moment SEND is
// pressed; if the two disagree, nothing is sent. One flag holds while any of
// the four actions is out, so a double press cannot make a second request —
// which matters most for the PDC push, because a repeat push files a second
// row and puts a second message into a live session. No failure is retried by
// these pages.

import { setPdcAction } from './datalink-clearance-pages.js';
import { ROWS, fill, label, prompt, row, value } from './datalink-pages.js';
import { formatScope } from './datalink-vocab.js';
import { formatLeg } from './clearance-vocab.js';
import {
  ADVISORY,
  DEFAULT_FROM,
  PDC_TEXT_ROWS,
  REFUSAL,
  TEXT,
  errorHint,
  errorKind,
  errorText,
  formatCount,
  formatFlight,
  formatSession,
  formatStamp,
  importAdvisory,
  isSiImportResult,
  isSiLinkResult,
  isSiPdcResult,
  isSiStatusResult,
  isSiUnlinkResult,
  linkAdvisory,
  pdcLeg,
  sayIntentionsFlight,
  sentTextLines,
  unlinkAdvisory,
} from './sayintentions-vocab.js';

/** Pushed texts kept in memory, one per planned leg, most recent last. */
const SENT_TEXTS_KEPT = 4;

let fmc = null;
let kit = null;
let session = null;

/** The last status read: the flight-scope key it was read for, and its answer. */
let statusKey = null;
let status = null;
let statusError = null;
let statusLoading = false;
let statusRequest = 0;
/** Which comms a link picks up: 'session-start' or 'now'. */
let from = DEFAULT_FROM;

/** The action DL-SI-CONFIRM offers, `{ action, flightId, from? }`, or null. */
let pending = null;
/** The leg DL-SI-PDC offers, `{ plannedLegId }`, or null. */
let pdcPending = null;
/** One flag for all four actions; see the double-press note above. */
let sending = false;
let sendingAction = null;
let sendingLegId = null;
/** The last failed request, kept per target so the confirm page can show it. */
let lastFailure = null;
let pdcFailure = null;
/** Planned leg id → the text pushed upstream, oldest first. */
const sentTexts = new Map();
/** Moves on whenever the server or the token changes; see `forgetSayIntentions`. */
let configGeneration = 0;

function padTo(rows, count, make = (index) => (index % 2 === 0 ? label('') : value(''))) {
  while (rows.length < count) rows.push(make(rows.length));
  return rows;
}

const textRow = (text) => row('row-value dl-text', text);

const fromText = (selection) => (selection === 'now' ? TEXT.fromNow : TEXT.fromSessionStart);

/**
 * The failure behind an answer that is not a result. A host that answers `ok`
 * with something undrawable gave bad data; a host that answers nothing at all,
 * because it predates the method, is the host's fault.
 */
const errorOf = (response) => (response && response.ok === true
  ? { code: 'bad-response' }
  : (response && response.error) || { code: 'host-error' });

/**
 * Where the answer is shown. The page moves apply while the page the action
 * started from is still on screen; if the user has gone elsewhere meanwhile,
 * the result is still kept and the message still shown, but they are not
 * moved. A null page id means stay where we are and repaint.
 */
function conclude(onPage, pageId, text, kind) {
  const shown = onPage && pageId ? Promise.resolve(fmc.showPage(pageId)) : Promise.resolve(kit.repaint());
  return shown.then(() => {
    if (text) fmc.setScratchpad(text, kind);
  });
}

// ── The status read ──────────────────────────────────────────────────────────

/**
 * Which question the read asks. In flight scope it is the link state of that
 * flight; anywhere else it is whether a key is on file at all, which is the
 * one thing the user can still fix before pushback.
 */
function scopeKey(state) {
  const flight = sayIntentionsFlight(state);
  return flight.ok ? `flight:${flight.flightId}` : 'none';
}

/**
 * One read at a time: a newer one supersedes rather than queues, and an answer
 * for a superseded read is dropped. A failed read is kept as the state line
 * and the hint; the page does not retry it.
 */
async function readStatus() {
  const state = session.getState();
  const flight = sayIntentionsFlight(state);
  const flightId = flight.ok ? flight.flightId : null;
  const request = statusRequest + 1;
  statusRequest = request;
  statusKey = scopeKey(state);
  status = null;
  statusError = null;
  statusLoading = true;
  let response = null;
  try {
    response = await fmc.getSayIntentionsStatus({ flightId });
  } catch {
    response = null;
  }
  // A later read asked again; this answer is for a state nobody is looking at.
  if (request !== statusRequest) return;
  statusLoading = false;
  if (response && response.ok === true && isSiStatusResult(response.result, flightId)) {
    status = response.result;
  } else {
    statusError = errorOf(response);
  }
  kit.repaint();
}

/** Read on entering the page unless the answer on file is already the one wanted. */
function ensureStatus() {
  const key = scopeKey(session.getState());
  if (statusKey !== key) {
    // The flight moved under the page: the selection is a choice about this
    // flight's comms, so it goes back to the default with the link state.
    from = DEFAULT_FROM;
    void readStatus();
    return;
  }
  if (!status && !statusLoading) void readStatus();
}

/**
 * The pushed datalink state is the only signal the page gets that the flight
 * moved, so the check runs before each paint; the read that follows repaints
 * again when it answers.
 */
function followScope(state) {
  if (statusKey === scopeKey(state)) return;
  from = DEFAULT_FROM;
  void readStatus();
}

// ── DL-INDEX R2 ──────────────────────────────────────────────────────────────

/**
 * Never refuses: not for a leg, not without a flight plan, not for a missing
 * key. The page explains every one of those, and refusing at the door would
 * hide the explanation.
 */
function openSayIntentions() {
  fmc.showPage('DL-SI');
  return true;
}

// ── DL-SI ────────────────────────────────────────────────────────────────────

function keyLine() {
  if (statusError) return errorText(statusError);
  if (!status) return TEXT.loading;
  return status.apiKeySet ? TEXT.keyOnFile : TEXT.noKeyOnFile;
}

/** Most fixable problem first: the key can be set now, the flight cannot. */
function hintLine(state) {
  if (status && status.apiKeySet === false) return TEXT.setKeyOnWeb;
  if (!sayIntentionsFlight(state).ok) return TEXT.onceFlying;
  if (statusError) return errorHint(statusError, 'link');
  return '';
}

function paintSi(view) {
  const state = session.getState();
  followScope(state);
  const link = status && status.link ? status.link : null;
  fill(view, [
    label(TEXT.keyLabel, formatScope(state && state.scope)),
    value(keyLine()),
    label(TEXT.session, TEXT.imported),
    value(
      link ? formatSession(link.upstreamFlightId) : TEXT.unknownText,
      link ? formatCount(link.importedCount) : TEXT.unknownCount,
    ),
    label(TEXT.linked, TEXT.lastImport),
    value(
      link ? formatStamp(link.linkedAt) : TEXT.unknownText,
      link ? formatStamp(link.lastImportAt) : TEXT.unknownText,
    ),
    label('', TEXT.linkFrom),
    value(prompt(TEXT.link), prompt(fromText(from))),
    label('', ''),
    value(prompt(TEXT.unlink), prompt(TEXT.import)),
    label(hintLine(state), ''),
    value(prompt(TEXT.return), prompt(TEXT.refresh)),
  ]);
  fmc.setPageNumber(1, 1);
}

/**
 * The three action prompts are painted whatever the state, and the key gives
 * the reason instead: a prompt that disappears teaches nothing.
 */
function stage(action) {
  if (sending) {
    fmc.showPage('DL-SI-CONFIRM');
    return true;
  }
  const flight = sayIntentionsFlight(session.getState());
  if (!flight.ok) {
    fmc.setScratchpad(flight.text, 'error');
    return true;
  }
  pending = action === 'link'
    ? { action, flightId: flight.flightId, from }
    : { action, flightId: flight.flightId };
  fmc.showPage('DL-SI-CONFIRM');
  return true;
}

function siLsk(lsk) {
  if (lsk === 'L4') return stage('link');
  if (lsk === 'L5') return stage('unlink');
  if (lsk === 'R5') return stage('import');
  if (lsk === 'R4') {
    from = from === 'now' ? 'session-start' : 'now';
    kit.repaint();
    return true;
  }
  if (lsk === 'R6') {
    // This page's data is the SayIntentions status, not the datalink poll.
    void readStatus();
    return true;
  }
  if (lsk === 'L6') {
    fmc.showPage('DL-INDEX');
    return true;
  }
  return false;
}

// ── DL-SI-CONFIRM ────────────────────────────────────────────────────────────

const CONFIRM_TITLES = { link: TEXT.confirmLink, unlink: TEXT.confirmUnlink, import: TEXT.confirmImport };
const ACTION_TEXT = { link: TEXT.actionLink, unlink: TEXT.actionUnlink, import: TEXT.actionImport };

function shownPending() {
  return sending && sendingAction ? sendingAction : pending;
}

function paintConfirm(view) {
  const action = shownPending();
  const rows = [];
  if (!action) {
    rows.push(label(''), value(TEXT.noPending));
    padTo(rows, ROWS - 1);
    rows.push(value(prompt(TEXT.return), ''));
  } else {
    const failure = !sending && lastFailure
      && lastFailure.action === action.action && lastFailure.flightId === action.flightId
      ? lastFailure
      : null;
    const isLink = action.action === 'link';
    rows.push(
      label(TEXT.confirm),
      value(ACTION_TEXT[action.action]),
      label(TEXT.to),
      value(formatFlight(action.flightId)),
      label(isLink ? TEXT.linkFrom : ''),
      value(isLink ? fromText(action.from) : ''),
      label(failure ? TEXT.lastRequest : ''),
      value(failure ? errorText(failure.error) : ''),
      label(failure ? errorHint(failure.error, action.action) : ''),
    );
    padTo(rows, ROWS - 1);
    rows.push(value(prompt(sending ? '' : TEXT.cancel), prompt(sending ? TEXT.sending : TEXT.send)));
  }
  fill(view, rows);
  fmc.setPageNumber(1, 1);
}

function request(action) {
  if (action.action === 'link') return fmc.linkSayIntentions({ flightId: action.flightId, from: action.from });
  if (action.action === 'unlink') return fmc.unlinkSayIntentions({ flightId: action.flightId });
  return fmc.importSayIntentionsComms({ flightId: action.flightId });
}

function isResultFor(action, result) {
  if (action.action === 'link') return isSiLinkResult(result, action.flightId);
  if (action.action === 'unlink') return isSiUnlinkResult(result, action.flightId);
  return isSiImportResult(result, action.flightId);
}

function advisoryFor(action, result) {
  if (action.action === 'link') return linkAdvisory(result);
  if (action.action === 'unlink') return unlinkAdvisory(result);
  return importAdvisory(result);
}

async function sendStaged() {
  // The flight shown must still be the flight the rule picks now; a scope that
  // moved while the page was open refuses rather than retargets.
  const action = pending;
  const flight = sayIntentionsFlight(session.getState());
  if (!flight.ok || flight.flightId !== action.flightId) {
    pending = null;
    await conclude(true, 'DL-SI', flight.ok ? REFUSAL.flightChanged : flight.text, 'error');
    return;
  }
  sending = true;
  sendingAction = action;
  const generation = configGeneration;
  kit.repaint();
  let response = null;
  try {
    response = await request(action);
  } catch {
    response = null;
  }
  sending = false;
  sendingAction = null;
  const onConfirm = kit.currentPageId() === 'DL-SI-CONFIRM';
  // An answer from before a server or token change is still reported, but not
  // kept: it belongs to a configuration that is no longer the one in use.
  const current = generation === configGeneration;
  const result = response && response.ok === true ? response.result : null;

  if (result && isResultFor(action, result)) {
    pending = null;
    if (current) {
      if (lastFailure && lastFailure.action === action.action && lastFailure.flightId === action.flightId) {
        lastFailure = null;
      }
      // The link state has changed, so the page reads it again on arrival.
      status = null;
      statusError = null;
    }
    await conclude(onConfirm, 'DL-SI', advisoryFor(action, result), 'advisory');
    return;
  }
  const error = errorOf(response);
  if (current) lastFailure = { action: action.action, flightId: action.flightId, error };
  // The action stays staged and the page stays up: the likeliest failures are
  // "not running yet" and "no calls yet", whose remedy is to do something in
  // the sim and press SEND again.
  await conclude(onConfirm, null, errorText(error), errorKind(error));
}

function confirmLsk(lsk) {
  if (lsk === 'R6') {
    if (sending) return true;
    if (!pending) return false;
    void sendStaged();
    return true;
  }
  if (lsk === 'L6') {
    // Once SEND is out the request cannot be called back; its answer decides
    // where the user lands.
    if (sending) return true;
    pending = null;
    fmc.showPage('DL-SI');
    return true;
  }
  return false;
}

// ── DL-CLEARANCE R5 and DL-SI-PDC ────────────────────────────────────────────

function keepSentText(id, text) {
  sentTexts.delete(id);
  sentTexts.set(id, text);
  while (sentTexts.size > SENT_TEXTS_KEPT) sentTexts.delete(sentTexts.keys().next().value);
}

/** `shownLegId` is the leg whose clearance the clearance page is showing. */
function stagePdc(shownLegId) {
  if (sending && sendingLegId !== null) {
    fmc.showPage('DL-SI-PDC');
    return true;
  }
  const leg = pdcLeg(session.getState());
  if (!leg.ok) {
    fmc.setScratchpad(leg.text, 'error');
    return true;
  }
  if (leg.plannedLegId !== shownLegId) {
    // The clearance on screen is not the leg a push would go to now.
    fmc.setScratchpad(REFUSAL.legChanged, 'error');
    return true;
  }
  pdcPending = { plannedLegId: leg.plannedLegId };
  fmc.showPage('DL-SI-PDC');
  return true;
}

function shownPdcLeg() {
  return sending && sendingLegId !== null ? sendingLegId : pdcPending ? pdcPending.plannedLegId : null;
}

function paintPdc(view) {
  const leg = shownPdcLeg();
  const rows = [];
  if (leg === null) {
    rows.push(label(''), value(TEXT.noPending));
    padTo(rows, ROWS - 1);
    rows.push(value(prompt(TEXT.return), ''));
  } else {
    const sent = sentTexts.has(leg) ? sentTexts.get(leg) : null;
    // The row upstream is written against the planned leg, so the flight's own
    // thread may never show it and this may be the only confirmation there is.
    const lines = sent === null ? [] : sentTextLines(sent);
    const failure = !sending && pdcFailure && pdcFailure.plannedLegId === leg ? pdcFailure : null;
    rows.push(
      label(TEXT.pdcTitle, formatLeg(leg)),
      value(TEXT.toSayIntentions),
      label(sent === null ? '' : TEXT.lastSent),
    );
    for (let i = 0; i < PDC_TEXT_ROWS; i += 1) rows.push(textRow(lines[i] || ''));
    rows.push(
      value(''),
      label(failure ? TEXT.lastRequest : ''),
      value(failure ? errorText(failure.error) : ''),
      label(failure ? errorHint(failure.error, 'pdc') : ''),
    );
    padTo(rows, ROWS - 1);
    rows.push(value(prompt(sending ? '' : TEXT.cancel), prompt(sending ? TEXT.sending : TEXT.send)));
  }
  fill(view, rows);
  fmc.setPageNumber(1, 1);
}

async function sendPdc() {
  // The leg shown must still be the leg the rule picks now; a scope that moved
  // while the page was open refuses rather than retargets.
  const staged = pdcPending;
  const leg = pdcLeg(session.getState());
  if (!leg.ok || leg.plannedLegId !== staged.plannedLegId) {
    pdcPending = null;
    await conclude(true, 'DL-CLEARANCE', leg.ok ? REFUSAL.legChanged : leg.text, 'error');
    return;
  }
  sending = true;
  sendingLegId = staged.plannedLegId;
  const id = sendingLegId;
  const generation = configGeneration;
  kit.repaint();
  let response = null;
  try {
    response = await fmc.sendSayIntentionsPdc({ plannedLegId: id });
  } catch {
    response = null;
  }
  sending = false;
  sendingLegId = null;
  const onPdc = kit.currentPageId() === 'DL-SI-PDC';
  const current = generation === configGeneration;
  const result = response && response.ok === true ? response.result : null;

  if (result && isSiPdcResult(result, id)) {
    pdcPending = null;
    if (current) {
      keepSentText(id, result.sentText);
      if (pdcFailure && pdcFailure.plannedLegId === id) pdcFailure = null;
    }
    await conclude(onPdc, 'DL-CLEARANCE', ADVISORY.pdcSent, 'advisory');
    return;
  }
  const error = errorOf(response);
  if (current) pdcFailure = { plannedLegId: id, error };
  await conclude(onPdc, null, errorText(error), errorKind(error));
}

function pdcLsk(lsk) {
  if (lsk === 'R6') {
    if (sending) return true;
    if (!pdcPending) return false;
    void sendPdc();
    return true;
  }
  if (lsk === 'L6') {
    if (sending) return true;
    pdcPending = null;
    fmc.showPage('DL-CLEARANCE');
    return true;
  }
  return false;
}

// ── Configuration changes ────────────────────────────────────────────────────

/**
 * Forget the link state, every pushed text, the last failures and anything
 * staged. CFG NETWORK calls this after saving a different server URL or a newly
 * entered token: flight and leg ids are only unique per server, so a link state
 * kept from before would otherwise be redrawn as if the new server had it.
 */
export function forgetSayIntentions() {
  configGeneration += 1;
  // Any read already out belongs to the configuration that has just gone.
  statusRequest += 1;
  statusKey = null;
  status = null;
  statusError = null;
  statusLoading = false;
  sentTexts.clear();
  lastFailure = null;
  pdcFailure = null;
  pending = null;
  pdcPending = null;
  from = DEFAULT_FROM;
}

// ── Registration ─────────────────────────────────────────────────────────────

/** `shared` is what `register` in datalink-pages.js returned. */
export function register(api, shared) {
  fmc = api;
  kit = shared;
  session = shared.session;
  const { dlPage } = shared;

  fmc.registerPage(dlPage('DL-SI', TEXT.title, {
    paint: paintSi,
    onRender: ensureStatus,
    onLsk: siLsk,
  }));

  fmc.registerPage(dlPage('DL-SI-CONFIRM', () => {
    const action = shownPending();
    return action ? CONFIRM_TITLES[action.action] : TEXT.confirmTitle;
  }, {
    paint: paintConfirm,
    onLsk: confirmLsk,
  }));

  fmc.registerPage(dlPage('DL-SI-PDC', TEXT.pdcTitle, {
    paint: paintPdc,
    onLsk: pdcLsk,
  }));

  kit.setSayIntentionsAction(openSayIntentions);
  setPdcAction(stagePdc);
}
