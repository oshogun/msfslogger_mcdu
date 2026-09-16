// The DATALINK pages that send: DL-CANNED (canned downlinks), DL-WX and
// DL-WX-RESULT (METAR/TAF for a typed ICAO), DL-LOADSHEET, and DL-CONFIRM,
// the one page from which any of them is actually sent.
//
// Import rule for this directory applies here too: the outside world is
// reached only through the page interface handed to `register`.
//
// Three rules hold on every page here. No key press sends by itself: a
// selection records a pending action and opens DL-CONFIRM, whose SEND makes
// exactly one request. The canned list is whatever the server returned just
// now; no id or label for one exists in this code. And the only thing typed on
// the scratchpad that can reach a request is a validated ICAO.

import { ROWS, fill, label, prompt, row, value } from './datalink-pages.js';
import { paginateText } from './datalink-text.js';
import {
  ILLUSTRATIVE_MARKER,
  NO_FLIGHT_PLAN,
  cutText,
  errorText,
  formatSheetSource,
  formatSheetValue,
  formatTarget,
  loadsheetLeg,
  validateIcao,
  weatherText,
  writeTarget,
} from './datalink-vocab.js';

const CANNED_PAGE_SIZE = 5;
/** Load sheets kept per planned leg, most recently received last. */
const SHEETS_KEPT = 4;

let fmc = null;
let kit = null;
let session = null;

const canned = { status: 'loading', messages: [], page: 1, request: 0 };
let enteredIcao = null;
let wxResult = null;
let wxPage = 1;
const sheets = new Map();

// ── Shared ───────────────────────────────────────────────────────────────────

function padTo(rows, count) {
  while (rows.length < count) rows.push(rows.length % 2 === 0 ? label('') : value(''));
  return rows;
}

function currentScope() {
  const state = session.getState();
  return state ? state.scope : null;
}

/** Record the action and open the confirm page; refused while a send is out. */
function select(action) {
  if (!session.selectAction(action)) {
    fmc.setScratchpad(errorText({ code: 'busy' }), 'error');
    return true;
  }
  fmc.showPage('DL-CONFIRM');
  return true;
}

function wrapPage(page, delta, m) {
  return ((page - 1 + delta + m) % m) + 1;
}

// ── DL-CANNED ────────────────────────────────────────────────────────────────

function cannedPageCount() {
  return Math.max(1, Math.ceil(canned.messages.length / CANNED_PAGE_SIZE));
}

async function loadCanned() {
  const request = canned.request + 1;
  canned.request = request;
  canned.status = 'loading';
  canned.messages = [];
  canned.page = 1;
  const response = await Promise.resolve().then(() => fmc.getCannedMessages()).catch(() => null);
  // A later render asked again; this answer is for a list nobody is looking at.
  if (request !== canned.request) return;
  if (!response || response.ok !== true) {
    canned.status = 'error';
    if (kit.currentPageId() === 'DL-CANNED') {
      const text = errorText(response && response.error);
      if (text) fmc.setScratchpad(text, 'error');
    }
  } else {
    const list = response.result && Array.isArray(response.result.messages) ? response.result.messages : [];
    canned.messages = list.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.label === 'string');
    canned.status = 'ready';
  }
  kit.repaint();
}

function paintCanned(view) {
  const rows = [];
  const m = cannedPageCount();
  if (canned.page > m) canned.page = m;
  if (canned.status === 'loading') rows.push(label(''), value('LOADING'));
  else if (canned.status === 'error') rows.push(label(''), value(''));
  else if (canned.messages.length === 0) rows.push(label(''), value('NO CANNED MESSAGES'));
  else {
    const start = (canned.page - 1) * CANNED_PAGE_SIZE;
    for (const entry of canned.messages.slice(start, start + CANNED_PAGE_SIZE)) {
      rows.push(label(''), value(cutText(`<${entry.label}`)));
    }
  }
  padTo(rows, ROWS - 1);
  rows.push(value(prompt('<RETURN'), ''));
  fill(view, rows);
  fmc.setPageNumber(canned.status === 'ready' ? canned.page : 1, canned.status === 'ready' ? m : 1);
}

function cannedLsk(lsk) {
  if (lsk === 'L6') {
    fmc.showPage('DL-INDEX');
    return true;
  }
  const match = /^L([1-5])$/.exec(lsk);
  if (!match || canned.status !== 'ready') return false;
  const entry = canned.messages[(canned.page - 1) * CANNED_PAGE_SIZE + Number(match[1]) - 1];
  if (!entry) return false;
  const target = writeTarget(currentScope());
  if (!target) {
    fmc.setScratchpad(NO_FLIGHT_PLAN, 'error');
    return true;
  }
  return select({ kind: 'canned', target, cannedId: entry.id, label: entry.label, origin: 'DL-CANNED' });
}

// ── DL-CONFIRM ───────────────────────────────────────────────────────────────

const CONFIRM_HEADINGS = { canned: 'DOWNLINK', wx: 'WX REQUEST', loadsheet: 'LOADSHEET REQUEST' };

function confirmDetail(action) {
  if (action.kind === 'canned') return cutText(action.label);
  if (action.kind === 'wx') return action.icao;
  return `LEG ${action.plannedLegId}`;
}

function paintConfirm(view) {
  const action = session.pendingAction();
  const rows = [];
  if (!action) {
    rows.push(label(''), value('NO PENDING REQUEST'));
    padTo(rows, ROWS - 1);
    rows.push(value(prompt('<RETURN'), ''));
  } else {
    rows.push(label(CONFIRM_HEADINGS[action.kind]), value(confirmDetail(action)), label('TO'), value(formatTarget(action.target)));
    padTo(rows, ROWS - 1);
    rows.push(value(prompt('<CANCEL'), prompt(session.isSending() ? 'SENDING' : 'SEND*')));
  }
  fill(view, rows);
  fmc.setPageNumber(1, 1);
}

function storeSheet(action, result) {
  const id = Number.isSafeInteger(result.plannedLegId) ? result.plannedLegId : action.plannedLegId;
  sheets.delete(id);
  sheets.set(id, result.sheet);
  while (sheets.size > SHEETS_KEPT) sheets.delete(sheets.keys().next().value);
}

/**
 * Where the answer is shown. The design's page moves apply while the confirm
 * page is still on screen; if the user has gone elsewhere meanwhile, the
 * result is still kept and the message still shown, but they are not moved.
 */
function conclude(onConfirm, pageId, text, kind) {
  const shown = onConfirm ? Promise.resolve(fmc.showPage(pageId)) : Promise.resolve(kit.repaint());
  return shown.then(() => {
    if (text) fmc.setScratchpad(text, kind);
  });
}

async function sendConfirmed() {
  const sent = session.sendPending();
  kit.repaint();
  const outcome = await sent;
  if (outcome.status !== 'done') return;
  const { action, response } = outcome;
  const onConfirm = kit.currentPageId() === 'DL-CONFIRM';
  const result = response.ok === true ? response.result : null;

  if (response.ok !== true || !result || typeof result !== 'object') {
    const error = response.ok === true ? { code: 'bad-response' } : response.error;
    await conclude(onConfirm, action.origin, errorText(error), 'error');
    return;
  }
  if (action.kind === 'canned') {
    // The sidecar polls again after a write, so the downlink and any reply
    // arrive as a new datalink state; the thread follows its newest page.
    session.showNewestThreadPage();
    await conclude(onConfirm, 'DL-THREAD', 'DOWNLINK SENT', 'advisory');
  } else if (action.kind === 'wx') {
    wxResult = result;
    wxPage = 1;
    await conclude(onConfirm, 'DL-WX-RESULT', '', 'advisory');
  } else {
    if (!result.sheet || typeof result.sheet !== 'object') {
      await conclude(onConfirm, action.origin, errorText({ code: 'bad-response' }), 'error');
      return;
    }
    storeSheet(action, result);
    await conclude(onConfirm, 'DL-LOADSHEET', result.created ? 'LOADSHEET RECEIVED' : 'LOADSHEET ON FILE', 'advisory');
  }
}

function confirmLsk(lsk) {
  const action = session.pendingAction();
  if (lsk === 'R6') {
    if (!action) return false;
    if (!session.isSending()) void sendConfirmed();
    return true;
  }
  if (lsk === 'L6') {
    // Once SEND is out the request cannot be called back; its answer decides
    // where the user lands.
    if (session.isSending()) return true;
    session.cancelAction();
    fmc.showPage(action ? action.origin : 'DL-INDEX');
    return true;
  }
  return false;
}

// ── DL-WX and DL-WX-RESULT ───────────────────────────────────────────────────

function paintWx(view) {
  const rows = [label('AIRPORT ICAO'), value(enteredIcao || '□□□□')];
  padTo(rows, ROWS - 1);
  rows.push(value(prompt('<RETURN'), prompt(enteredIcao ? 'REQUEST>' : '')));
  fill(view, rows);
  fmc.setPageNumber(1, 1);
}

function wxLsk(lsk) {
  if (lsk === 'L1') {
    if (fmc.hasScratchpadError()) return true;
    const entry = validateIcao(fmc.getScratchpad());
    if (!entry.ok) {
      fmc.setScratchpad('INVALID ENTRY', 'error');
      return true;
    }
    enteredIcao = entry.icao;
    fmc.setScratchpad('');
    kit.repaint();
    return true;
  }
  if (lsk === 'L6') {
    fmc.showPage('DL-INDEX');
    return true;
  }
  if (lsk === 'R6') {
    if (!enteredIcao) return false;
    const target = writeTarget(currentScope());
    if (!target) {
      fmc.setScratchpad(NO_FLIGHT_PLAN, 'error');
      return true;
    }
    return select({ kind: 'wx', target, icao: enteredIcao, origin: 'DL-WX' });
  }
  return false;
}

function wxPages() {
  return paginateText(weatherText(wxResult));
}

function paintWxResult(view) {
  const pages = wxPages();
  if (wxPage > pages.length) wxPage = pages.length;
  const rows = [label('')];
  for (const line of pages[wxPage - 1]) rows.push(row('row-value dl-text', cutText(line.text)));
  while (rows.length < ROWS - 1) rows.push(row('row-value dl-text', ''));
  rows.push(value(prompt('<RETURN'), ''));
  fill(view, rows);
  fmc.setPageNumber(wxPage, pages.length);
}

// ── DL-LOADSHEET ─────────────────────────────────────────────────────────────

const SHEET_ROWS = [
  ['BLOCK FUEL', 'blockFuel'],
  ['TAXI FUEL', 'taxiFuel'],
  ['TAKEOFF FUEL', 'takeoffFuel'],
  ['TRIP FUEL', 'tripFuel'],
  ['PAYLOAD', 'payload'],
  ['ZFW', 'zeroFuelWeight'],
  ['MAX ZFW', 'maxZeroFuelWeight'],
  ['DOW', 'dryOperatingWeight'],
  ['TOW', 'takeoffWeight'],
];

function paintLoadsheet(view) {
  const leg = loadsheetLeg(currentScope());
  const rows = [];
  let request = '';
  if (!leg.ok) {
    rows.push(label(''), value(leg.text));
  } else if (!sheets.has(leg.plannedLegId)) {
    rows.push(label(''), value('NO LOADSHEET REQUESTED'));
    request = 'REQUEST>';
  } else {
    const sheet = sheets.get(leg.plannedLegId);
    // The server's sheet is illustrative, not for operational use; the marker
    // travels with the figures wherever they are shown.
    rows.push(label(ILLUSTRATIVE_MARKER, `LEG ${leg.plannedLegId}`));
    for (const [name, key] of SHEET_ROWS) {
      rows.push(row('row-value dl-sheet', name, formatSheetValue(sheet[key], sheet.units)));
    }
    rows.push(label(formatSheetSource(sheet)));
    request = 'REQUEST>';
  }
  padTo(rows, ROWS - 1);
  rows.push(value(prompt('<RETURN'), prompt(request)));
  fill(view, rows);
  fmc.setPageNumber(1, 1);
}

function loadsheetLsk(lsk) {
  if (lsk === 'L6') {
    fmc.showPage('DL-INDEX');
    return true;
  }
  if (lsk !== 'R6') return false;
  const leg = loadsheetLeg(currentScope());
  if (!leg.ok) return false;
  return select({
    kind: 'loadsheet',
    plannedLegId: leg.plannedLegId,
    target: { kind: 'leg', id: leg.plannedLegId },
    origin: 'DL-LOADSHEET',
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

/** `shared` is what `register` in datalink-pages.js returned. */
export function register(api, shared) {
  fmc = api;
  kit = shared;
  session = shared.session;
  const { dlPage } = shared;

  fmc.registerPage(dlPage('DL-CANNED', 'DOWNLINK', {
    paint: paintCanned,
    number: () => [canned.page, canned.status === 'ready' ? cannedPageCount() : 1],
    onRender: () => { void loadCanned(); },
    onLsk: cannedLsk,
    onPageKey(delta) {
      const m = cannedPageCount();
      if (canned.status === 'ready' && m > 1) {
        canned.page = wrapPage(canned.page, delta, m);
        kit.repaint();
      }
      return true;
    },
  }));

  fmc.registerPage(dlPage('DL-CONFIRM', 'CONFIRM SEND', {
    paint: paintConfirm,
    onLsk: confirmLsk,
  }));

  fmc.registerPage(dlPage('DL-WX', 'WX REQUEST', {
    paint: paintWx,
    onLsk: wxLsk,
  }));

  fmc.registerPage(dlPage('DL-WX-RESULT', () => cutText(`WX ${wxResult && typeof wxResult.icao === 'string' ? wxResult.icao : ''}`.trim()), {
    paint: paintWxResult,
    number: () => {
      const m = wxPages().length;
      return [Math.min(wxPage, m), m];
    },
    onLsk(lsk) {
      if (lsk !== 'L6') return false;
      fmc.showPage('DL-WX');
      return true;
    },
    onPageKey(delta) {
      const m = wxPages().length;
      if (m > 1) {
        wxPage = wrapPage(wxPage, delta, m);
        kit.repaint();
      }
      return true;
    },
  }));

  fmc.registerPage(dlPage('DL-LOADSHEET', 'LOADSHEET', {
    paint: paintLoadsheet,
    onLsk: loadsheetLsk,
  }));
}
