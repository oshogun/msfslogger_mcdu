// The FPLN pages: FPLN (whether the server has a SimBrief Pilot ID, the
// prefiled leg the sidecar holds, and the last PREFILE outcome), FPLN-CONFIRM
// (the one page from which PREFILE is sent) and FPLN-RESULT.
//
// Import rule for this directory applies here too: the outside world is
// reached only through the page interface handed to `register`. Datalink state
// arrives through the `onDatalink` callback the shell calls on the current
// page. None of these pages takes the DATALINK watch lease, and none starts or
// stops the uplink: PREFILE works the same before and after START.
//
// PREFILE imports the pilot's latest SimBrief OFP on the server as a planned
// leg. No single key press sends it: FPLN R6 opens the confirm page, whose R6
// makes exactly one request, and nothing here ever repeats it — not a timer,
// not a page change, not a failure. The server's answer to a repeat press is
// ALREADY FILED, so an unknown outcome is left for the pilot to retry.
//
// The Pilot ID itself never reaches the webview; the host only says whether one
// is configured, and nothing here can set it.

import { fill, label, prompt, value } from './datalink-pages.js';
import {
  ADVISORY,
  TEXT,
  errorHint,
  errorText,
  formatLeg,
  heldPrefiledLeg,
  labelLines,
  normaliseLabel,
} from './fpln-vocab.js';

let fmc = null;
/** The FPLN page on screen and its view element, or null. */
let current = null;

// Webview memory only; a reload starts again from the host.
let settings = { status: 'idle', configured: null, error: null };
/** The last settings answer, which row 2 keeps showing while the next is out. */
let settingsShown = null;
let settingsInFlight = false;
let sending = false;
let clearing = false;
let lastOutcome = null;
let lastResult = null;

function createView(id) {
  const view = document.createElement('div');
  view.className = 'page-view';
  view.setAttribute('data-page-view', id);
  return view;
}

const currentId = () => (current ? current.id : null);

function repaint() {
  if (!current) return;
  painters.get(current.id)(current.view);
}

function heldLeg() {
  return heldPrefiledLeg(fmc.getDatalinkState());
}

function prefileOffered() {
  return settings.status === 'ok' && settings.configured === true && !sending;
}

// ── FPLN ─────────────────────────────────────────────────────────────────────

function settingsRows() {
  const shown = settings.status === 'ok' || settings.status === 'error' ? settings : settingsShown;
  if (!shown) return [TEXT.unknown, ''];
  if (shown.status === 'error') return [errorText(shown.error, 'settings'), errorHint(shown.error, 'settings')];
  return shown.configured === true ? [TEXT.configured, ''] : [TEXT.notSet, TEXT.notSetHint];
}

function outcomeRows() {
  if (sending) return [TEXT.sending, ''];
  if (!lastOutcome) return [TEXT.none, ''];
  if (lastOutcome.ok === true) {
    return [lastOutcome.result.status === 'duplicate' ? TEXT.alreadyFiled : TEXT.prefiled, ''];
  }
  return [errorText(lastOutcome.error, 'prefile'), errorHint(lastOutcome.error, 'prefile')];
}

function paintFpln(view) {
  const [pilotId, pilotHint] = settingsRows();
  const held = heldLeg();
  const [outcome, outcomeHint] = outcomeRows();
  fill(view, [
    label(TEXT.pilotId),
    value(pilotId),
    label(pilotHint),
    value(''),
    label(TEXT.prefiledLeg),
    // The id alone under PREFILED LEG, so it and CLR PREFILE> share 24 columns.
    held ? value(String(held.plannedLegId), prompt(TEXT.clearPrefile)) : value(TEXT.none),
    label(''),
    value(held ? labelLines(normaliseLabel(held.label))[0] : ''),
    label(TEXT.lastPrefile),
    value(outcome),
    label(outcomeHint),
    value(prompt(TEXT.toMenu), prompt(prefileOffered() ? TEXT.prefile : '')),
  ]);
  fmc.setPageNumber(1, 1);
}

async function loadSettings() {
  if (settingsInFlight) return;
  settingsInFlight = true;
  if (settings.status === 'ok' || settings.status === 'error') settingsShown = settings;
  settings = { status: 'loading', configured: null, error: null };
  // PREFILE> is offered only on a settings answer, so it goes while one is out.
  if (currentId() === 'FPLN') repaint();
  const response = await Promise.resolve().then(() => fmc.getSimbriefSettings()).catch(() => null);
  settingsInFlight = false;
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    settings = { status: 'error', configured: null, error: { code: 'host-error' } };
  } else if (response.ok !== true) {
    settings = { status: 'error', configured: null, error: response.error };
  } else if (response.result && typeof response.result.configured === 'boolean') {
    settings = { status: 'ok', configured: response.result.configured, error: null };
  } else {
    settings = { status: 'error', configured: null, error: { code: 'bad-response' } };
  }
  settingsShown = settings;
  if (currentId() === 'FPLN') repaint();
}

/** CLR PREFILE: one call at a time; the leg line follows the state that comes after it. */
async function clearPrefile() {
  if (clearing) return;
  clearing = true;
  try {
    const response = await Promise.resolve().then(() => fmc.clearPrefiledLeg()).catch(() => null);
    if (response && response.ok === true) {
      if (response.result && response.result.cleared === true) fmc.setScratchpad(ADVISORY.cleared, 'advisory');
    } else {
      fmc.setScratchpad(errorText(response ? response.error : { code: 'host-error' }, 'clear'), 'error');
    }
  } finally {
    clearing = false;
  }
}

function fplnLsk(lsk) {
  if (lsk === 'L6') {
    fmc.showPage('MENU');
    return true;
  }
  if (lsk === 'R6') {
    if (!sending && !prefileOffered()) return false;
    fmc.showPage('FPLN-CONFIRM');
    return true;
  }
  if (lsk === 'R3') {
    if (!heldLeg()) return false;
    void clearPrefile();
    return true;
  }
  return false;
}

// ── FPLN-CONFIRM ─────────────────────────────────────────────────────────────

function paintConfirm(view) {
  fill(view, [
    label(TEXT.import),
    value(TEXT.latestOfp),
    label(TEXT.as),
    value(TEXT.plannedLegNoTrip),
    label(''),
    value(''),
    label(''),
    value(''),
    label(''),
    value(sending ? TEXT.wait : ''),
    label(''),
    value(prompt(sending ? '' : TEXT.cancel), prompt(sending ? TEXT.sending : TEXT.confirm)),
  ]);
  fmc.setPageNumber(1, 1);
}

/** An ok envelope the page cannot read is treated as an unreadable answer. */
function readOutcome(response) {
  if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') {
    return { ok: false, error: { code: 'host-error', httpStatus: null, serverCode: null } };
  }
  if (response.ok === true) {
    const result = response.result;
    if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.plannedLegId)) {
      return { ok: false, error: { code: 'bad-response', httpStatus: null, serverCode: null } };
    }
  }
  return response;
}

async function sendPrefile() {
  sending = true;
  repaint();
  let response;
  try {
    response = readOutcome(await Promise.resolve().then(() => fmc.prefileSimbrief()).catch(() => null));
  } finally {
    sending = false;
  }
  lastOutcome = response;
  const onConfirm = currentId() === 'FPLN-CONFIRM';
  const onFpln = currentId() === 'FPLN';

  if (response.ok === true) {
    lastResult = response.result;
    if (onConfirm) {
      await fmc.showPage('FPLN-RESULT');
      fmc.setScratchpad(response.result.status === 'duplicate' ? ADVISORY.duplicate : ADVISORY.imported, 'advisory');
    } else if (onFpln) {
      repaint();
    }
    return;
  }

  // The server has no Pilot ID after all: PREFILE is withdrawn until the
  // settings say otherwise.
  if (response.error && response.error.code === 'simbrief-no-user-id') {
    settings = { status: 'ok', configured: false, error: null };
    settingsShown = settings;
  }
  const text = errorText(response.error, 'prefile');
  if (onConfirm) {
    await fmc.showPage('FPLN');
    fmc.setScratchpad(text, 'error');
  } else if (onFpln) {
    repaint();
    fmc.setScratchpad(text, 'error');
  }
}

function confirmLsk(lsk) {
  if (lsk === 'R6') {
    if (!sending) void sendPrefile();
    return true;
  }
  if (lsk === 'L6') {
    // Once PREFILE is out it cannot be called back; its answer decides where
    // the pilot lands.
    if (!sending) fmc.showPage('FPLN');
    return true;
  }
  return false;
}

// ── FPLN-RESULT ──────────────────────────────────────────────────────────────

function paintResult(view) {
  if (!lastResult) {
    fill(view, [
      label(''),
      value(TEXT.noResult),
      label(''), value(''), label(''), value(''), label(''), value(''), label(''), value(''), label(''),
      value(prompt(TEXT.return)),
    ]);
    fmc.setPageNumber(1, 1);
    return;
  }
  const lines = labelLines(normaliseLabel(lastResult.label));
  const warnings = Number.isSafeInteger(lastResult.warningCount) && lastResult.warningCount > 0
    ? lastResult.warningCount
    : 0;
  fill(view, [
    label(lastResult.status === 'duplicate' ? TEXT.alreadyFiled : TEXT.prefiled),
    value(lines[0]),
    label(''),
    value(lines[1] || ''),
    label(TEXT.plannedLeg),
    value(formatLeg(lastResult.plannedLegId)),
    label(warnings ? TEXT.warnings : ''),
    value(warnings ? String(warnings) : ''),
    label(''),
    value('', prompt(TEXT.datalink)),
    label(''),
    value(prompt(TEXT.return)),
  ]);
  fmc.setPageNumber(1, 1);
}

function resultLsk(lsk) {
  if (lsk === 'L6') {
    fmc.showPage('FPLN');
    return true;
  }
  if (lsk === 'R5') {
    if (!lastResult) return false;
    fmc.showPage('DL-INDEX');
    return true;
  }
  return false;
}

// ── Registration ─────────────────────────────────────────────────────────────

/** Page id → paint(view). */
const painters = new Map();

function fplnPage(id, title, hooks) {
  painters.set(id, hooks.paint);
  return {
    id,
    title,
    group: id,
    n: 1,
    m: 1,
    render() {
      const view = createView(id);
      current = { id, view };
      repaint();
      if (hooks.onRender) hooks.onRender();
      return view;
    },
    dispose() {
      if (current && current.id === id) current = null;
    },
    onDatalink() {
      repaint();
    },
    onLsk: hooks.onLsk,
  };
}

export function register(api) {
  fmc = api;
  fmc.registerPage(fplnPage('FPLN', TEXT.title, {
    paint: paintFpln,
    onRender: () => { void loadSettings(); },
    onLsk: fplnLsk,
  }));
  fmc.registerPage(fplnPage('FPLN-CONFIRM', TEXT.confirmTitle, { paint: paintConfirm, onLsk: confirmLsk }));
  fmc.registerPage(fplnPage('FPLN-RESULT', TEXT.resultTitle, { paint: paintResult, onLsk: resultLsk }));
}
