// The simulated pre-departure clearance: DL-CLEARANCE-CONFIRM, the one page
// from which a clearance is requested, and DL-CLEARANCE, which shows the
// answer. DL-INDEX R5 opens them through the action registered here.
//
// Import rule for this directory applies here too: the outside world is
// reached only through the page interface handed to `register`.
//
// A clearance request writes rows to the logbook, so nothing here asks for one
// except the confirm page's SEND, once per press, and never while one is
// already out. The leg it goes to is the leg the confirm page shows, checked
// again against the current datalink state at the moment SEND is pressed; if
// the two disagree, nothing is sent. No failure is retried by this page.

import { ROWS, fill, label, prompt, row, value } from './datalink-pages.js';
import {
  ADVISORY,
  REFUSAL,
  RESULTS_KEPT,
  TEXT,
  clearanceLeg,
  errorHint,
  errorText,
  formatAltitude,
  formatLeg,
  formatPair,
  isClearanceResult,
  routeLinesOnPage,
  routePageCount,
} from './clearance-vocab.js';

let fmc = null;
let kit = null;
let session = null;

/** The leg the confirm page offers, `{ plannedLegId }`, or null. */
let pending = null;
/** What DL-CLEARANCE R5 does; the SayIntentions pages register it. */
let pdcAction = null;
let sending = false;
let sendingLegId = null;
/** Planned leg id → clearance result, oldest first. */
const results = new Map();
let shownLegId = null;
let resultPage = 1;
/** The last failed request, `{ plannedLegId, error }`, or null. */
let lastFailure = null;
/** Moves on whenever the server or the token changes; see `forgetClearances`. */
let configGeneration = 0;

function padTo(rows, count, make = (index) => (index % 2 === 0 ? label('') : value(''))) {
  while (rows.length < count) rows.push(make(rows.length));
  return rows;
}

const textRow = (text) => row('row-value dl-text', text);

function keepResult(id, result) {
  results.delete(id);
  results.set(id, result);
  while (results.size > RESULTS_KEPT) results.delete(results.keys().next().value);
}

/**
 * Where the answer is shown. The page moves apply while the confirm page is
 * still on screen; if the user has gone elsewhere meanwhile, the result is
 * still kept and the message still shown, but they are not moved.
 */
function conclude(onConfirm, pageId, text, kind) {
  const shown = onConfirm ? Promise.resolve(fmc.showPage(pageId)) : Promise.resolve(kit.repaint());
  return shown.then(() => {
    if (text) fmc.setScratchpad(text, kind);
  });
}

// ── DL-INDEX R5 ──────────────────────────────────────────────────────────────

function openClearance() {
  if (sending) {
    fmc.showPage('DL-CLEARANCE-CONFIRM');
    return true;
  }
  const leg = clearanceLeg(session.getState());
  if (!leg.ok) {
    fmc.setScratchpad(leg.text, 'error');
    return true;
  }
  if (results.has(leg.plannedLegId)) {
    shownLegId = leg.plannedLegId;
    resultPage = 1;
    fmc.showPage('DL-CLEARANCE');
    return true;
  }
  pending = { plannedLegId: leg.plannedLegId };
  fmc.showPage('DL-CLEARANCE-CONFIRM');
  return true;
}

// ── DL-CLEARANCE-CONFIRM ─────────────────────────────────────────────────────

function shownPendingLeg() {
  return sending ? sendingLegId : pending ? pending.plannedLegId : null;
}

function paintConfirm(view) {
  const leg = shownPendingLeg();
  const rows = [];
  if (leg === null) {
    rows.push(label(''), value(TEXT.noPending));
    padTo(rows, ROWS - 1);
    rows.push(value(prompt(TEXT.return), ''));
  } else {
    const failure = !sending && lastFailure && lastFailure.plannedLegId === leg ? lastFailure : null;
    rows.push(
      label(TEXT.confirmHeading),
      value(TEXT.simulatedPdc),
      label(TEXT.to),
      value(formatLeg(leg)),
      label(''),
      value(''),
      label(failure ? TEXT.lastRequest : ''),
      value(failure ? errorText(failure.error) : ''),
      label(failure ? errorHint(failure.error) : ''),
    );
    padTo(rows, ROWS - 1);
    rows.push(value(prompt(sending ? '' : TEXT.cancel), prompt(sending ? TEXT.sending : TEXT.send)));
  }
  fill(view, rows);
  fmc.setPageNumber(1, 1);
}

async function sendClearance() {
  // The leg shown must still be the leg the rule picks now; a scope that moved
  // while the page was open refuses rather than retargets.
  const leg = clearanceLeg(session.getState());
  if (!leg.ok || leg.plannedLegId !== pending.plannedLegId) {
    pending = null;
    await conclude(true, 'DL-INDEX', leg.ok ? REFUSAL.legChanged : leg.text, 'error');
    return;
  }
  sending = true;
  sendingLegId = pending.plannedLegId;
  const id = sendingLegId;
  const generation = configGeneration;
  kit.repaint();
  let response = null;
  try {
    response = await fmc.requestClearance({ plannedLegId: id });
  } catch {
    response = null;
  }
  sending = false;
  pending = null;
  const onConfirm = kit.currentPageId() === 'DL-CLEARANCE-CONFIRM';
  // An answer from before a server or token change is still reported, but not
  // kept: it belongs to a configuration that is no longer the one in use.
  const current = generation === configGeneration;

  if (response && response.ok === true && isClearanceResult(response.result, id)) {
    const result = response.result;
    if (current) {
      keepResult(id, result);
      if (lastFailure && lastFailure.plannedLegId === id) lastFailure = null;
      shownLegId = id;
      resultPage = 1;
    }
    await conclude(onConfirm, current ? 'DL-CLEARANCE' : 'DL-INDEX', result.created ? ADVISORY.created : ADVISORY.onFile, 'advisory');
    return;
  }
  const error = response && response.ok === true ? { code: 'bad-response' } : response && response.error;
  if (current) lastFailure = { plannedLegId: id, error };
  await conclude(onConfirm, 'DL-INDEX', errorText(error), 'error');
}

function confirmLsk(lsk) {
  if (lsk === 'R6') {
    if (sending) return true;
    if (!pending) return false;
    void sendClearance();
    return true;
  }
  if (lsk === 'L6') {
    // Once SEND is out the request cannot be called back; its answer decides
    // where the user lands.
    if (sending) return true;
    pending = null;
    fmc.showPage('DL-INDEX');
    return true;
  }
  return false;
}

// ── DL-CLEARANCE ─────────────────────────────────────────────────────────────

function shownResult() {
  return shownLegId === null ? null : results.get(shownLegId) || null;
}

function resultPageCount() {
  const result = shownResult();
  return result ? routePageCount(result.route) : 1;
}

function paintResult(view) {
  const result = shownResult();
  const rows = [];
  if (!result) {
    rows.push(label(''), value(TEXT.noResult));
    padTo(rows, ROWS - 1);
    rows.push(value(prompt(TEXT.return), ''));
    fill(view, rows);
    fmc.setPageNumber(1, 1);
    return;
  }
  const m = resultPageCount();
  if (resultPage > m) resultPage = m;
  const n = resultPage;
  rows.push(label(TEXT.marker, formatLeg(shownLegId)));
  if (n === 1) {
    rows.push(
      value(formatPair(result), result.created === false ? TEXT.alreadyIssued : ''),
      label(TEXT.initialAlt, TEXT.squawk),
      value(formatAltitude(result.initialAltitudeFt), result.squawk),
      label(TEXT.clearedVia),
    );
    if (result.route === null) rows.push(value(TEXT.noRoute));
    else for (const line of routeLinesOnPage(result.route, 1)) rows.push(textRow(line.text));
  } else {
    for (const line of routeLinesOnPage(result.route, n)) rows.push(textRow(line.text));
  }
  // Row 10 is a prompt row on every page, so the route block ends at row 9.
  padTo(rows, ROWS - 3, () => textRow(''));
  rows.push(value('', prompt(pdcAction ? 'SEND PDC>' : '')));
  rows.push(label(TEXT.notReal), value(prompt(TEXT.return), prompt(TEXT.messages)));
  fill(view, rows);
  fmc.setPageNumber(n, m);
}

function resultLsk(lsk) {
  if (lsk === 'L6') {
    fmc.showPage('DL-INDEX');
    return true;
  }
  if (lsk === 'R5') {
    if (!pdcAction || !shownResult()) return false;
    return pdcAction(shownLegId);
  }
  if (lsk === 'R6') {
    if (!shownResult()) return false;
    session.showNewestThreadPage();
    fmc.showPage('DL-THREAD');
    return true;
  }
  return false;
}

// ── Configuration changes ────────────────────────────────────────────────────

/**
 * What R5 of the result page does with the leg it is showing. Registered by the
 * pages that push a clearance onwards, so this module does not import them; an
 * unset action leaves the prompt unpainted and the key inactive.
 */
export function setPdcAction(fn) {
  pdcAction = typeof fn === 'function' ? fn : null;
}

/**
 * Forget every kept clearance and the last failure. CFG NETWORK calls this
 * after saving a different server URL or a newly entered token: leg ids are
 * only unique per server, so a clearance kept from before would otherwise be
 * reopened by R5 as if the new server had issued it. Asking again is safe, as
 * the server answers a repeat with the clearance it already has on file.
 */
export function forgetClearances() {
  configGeneration += 1;
  results.clear();
  shownLegId = null;
  resultPage = 1;
  lastFailure = null;
}

// ── Registration ─────────────────────────────────────────────────────────────

/** `shared` is what `register` in datalink-pages.js returned. */
export function register(api, shared) {
  fmc = api;
  kit = shared;
  session = shared.session;
  const { dlPage } = shared;

  fmc.registerPage(dlPage('DL-CLEARANCE-CONFIRM', TEXT.confirmTitle, {
    paint: paintConfirm,
    onLsk: confirmLsk,
  }));

  fmc.registerPage(dlPage('DL-CLEARANCE', TEXT.resultTitle, {
    paint: paintResult,
    number: () => {
      const m = resultPageCount();
      return [Math.min(resultPage, m), m];
    },
    onLsk: resultLsk,
    onPageKey(delta) {
      const m = resultPageCount();
      if (m > 1) {
        resultPage = ((Math.min(resultPage, m) - 1 + delta + m) % m) + 1;
        kit.repaint();
      }
      return true;
    },
  }));

  kit.setClearanceAction(openClearance);
}
