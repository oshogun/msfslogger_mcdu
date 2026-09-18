// The DATALINK reading pages: DL-INDEX (scope, availability and the way into
// every datalink page), DL-THREAD (the ACARS thread, five messages a page,
// oldest first) and DL-MSG (one message, paged to the screen). The pages that
// send live in datalink-write-pages.js and are built with the same factory.
//
// Import rule for this directory applies here too: the outside world is
// reached only through the page interface handed to `register` and `ctx.fmc`.
// Datalink state arrives through the `onDatalink` callback the shell calls on
// the current page; no page subscribes to anything itself.
//
// Nothing on these pages sends a message. REFRESH asks for an immediate poll,
// and the lease that lets the sidecar poll at all is held only while one of
// the DATALINK pages is on screen.

import { createDatalinkSession } from './datalink-session.js';
import { paginateText } from './datalink-text.js';
import { ADVISORY, TEXT as PREFILE_TEXT, errorText as prefileErrorText, heldPrefiledLeg } from './fpln-vocab.js';
import {
  NO_FLIGHT_PLAN,
  cutText,
  describeDatalinkState,
  errorText,
  formatMessageHeader,
  formatMessagePreview,
  formatScope,
  formatTime,
  loadsheetLeg,
  writeTarget,
} from './datalink-vocab.js';

export const ROWS = 12;

let fmc = null;
let session = null;
/** The DATALINK page on screen and its view element, or null. */
let current = null;
let refreshing = false;
let clearing = false;
let textPage = 1;
/** What DL-INDEX R5 does; the clearance pages register it. */
let clearanceAction = null;
/** What DL-INDEX R2 does; the SayIntentions pages register it. */
let sayIntentionsAction = null;

// ── Rows ─────────────────────────────────────────────────────────────────────

function cell(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text || '';
  return el;
}

/** `left`/`right` are strings or `{ text, className, state, severity }`. */
export function row(kind, left, right) {
  const el = document.createElement('div');
  el.className = `row ${kind}`;
  const parts = [[left, 'cell-l'], [right, 'cell-r']];
  for (const [part, base] of parts) {
    if (part === undefined) continue;
    const spec = typeof part === 'object' && part !== null ? part : { text: part };
    const span = cell(spec.className ? `${base} ${spec.className}` : base, spec.text);
    if (spec.state) span.setAttribute('data-state', spec.state);
    if (spec.severity) span.setAttribute('data-severity', spec.severity);
    el.appendChild(span);
  }
  return el;
}

export const label = (left, right) => row('row-label', left, right);
export const value = (left, right) => row('row-value', left, right);
export const prompt = (text) => (text ? { text, className: 'prompt' } : '');

function createView(id) {
  const view = document.createElement('div');
  view.className = 'page-view dl-page';
  view.setAttribute('data-page-view', id);
  return view;
}

/** Replace the view's rows, padded to twelve so prompts stay on row 12. */
export function fill(view, rows) {
  while (view.firstChild) view.removeChild(view.firstChild);
  for (const el of rows.slice(0, ROWS)) view.appendChild(el);
  while (view.childElementCount < ROWS) {
    view.appendChild(view.childElementCount % 2 === 0 ? label('') : value(''));
  }
}

function availabilityCell(state) {
  const described = describeDatalinkState(state);
  return { text: described.text, className: 'status-line', state: described.id, severity: described.severity };
}

// ── Painting ─────────────────────────────────────────────────────────────────

function paintIndex(view) {
  const state = session.getState();
  const described = describeDatalinkState(state);
  const lastOkAt = state && typeof state.lastOkAt === 'number' ? state.lastOkAt : null;
  const scope = state && state.scope;
  // A held prefiled leg puts CLR PREFILE> beside the scope, so the scope line
  // says only PREFILE and the leg id gets a row of its own, shared only with
  // CLEARANCE>: a 16-digit id and the prompt still leave a gap between them.
  const held = heldPrefiledLeg(state);
  fill(view, [
    label('SCOPE', lastOkAt === null ? '' : `UPD ${formatTime(lastOkAt)}Z`),
    held
      ? value(isPrefileScope(scope) ? PREFILE_TEXT.prefileScope : formatScope(scope), prompt(PREFILE_TEXT.clearPrefile))
      : value(formatScope(scope)),
    label('DATALINK'),
    // The availability line's row is the one whose right-hand cell was free on
    // every state, and the longest line the panel can draw there still leaves
    // five columns of gap before the prompt. With no action registered the row
    // has no right-hand cell at all, as it had none before.
    sayIntentionsAction
      ? value(availabilityCell(state), prompt('SAYINTENTIONS>'))
      : value(availabilityCell(state)),
    label(''),
    value(prompt('<MESSAGES'), prompt('WX REQUEST>')),
    label(''),
    value(prompt('<DOWNLINK'), prompt('LOADSHEET>')),
    label(held ? PREFILE_TEXT.prefiledLeg : ''),
    value(held ? String(held.plannedLegId) : '', prompt('CLEARANCE>')),
    label(described.hint),
    value(prompt('<INDEX'), prompt('REFRESH>')),
  ]);
  fmc.setPageNumber(1, 1);
}

function paintThread(view) {
  const state = session.getState();
  const thread = threadRows(state);
  const rows = thread.rows.slice(0, ROWS - 2);
  while (rows.length < ROWS - 2) rows.push(rows.length % 2 === 0 ? label('') : value(''));
  fill(view, [
    ...rows,
    label(isPrefileScope(state && state.scope) ? formatScope(state.scope) : ''),
    value(prompt('<RETURN'), prompt('REFRESH>')),
  ]);
  fmc.setPageNumber(thread.n, thread.m);
}

function isPrefileScope(scope) {
  return Boolean(scope && scope.kind === 'leg' && scope.source === 'prefile');
}

function threadRows(state) {
  const blank = () => [label(''), value('')];
  if (!state || !state.thread) {
    const scope = state && state.scope;
    const line = scope && scope.kind === 'none'
      ? value({ text: NO_FLIGHT_PLAN, className: 'status-line', severity: 'caution' })
      : value(availabilityCell(state));
    return { n: 1, m: 1, rows: [label(''), line] };
  }
  const view = session.threadView();
  if (!view.cached) {
    return { n: 1, m: 1, rows: [label('----'), value('LOADING')] };
  }
  if (view.total === 0) {
    return { n: 1, m: 1, rows: [label(''), value('NO MESSAGES')] };
  }
  const rows = [];
  for (const slot of view.slots) {
    if (slot.kind === 'message') {
      rows.push(label(formatMessageHeader(slot.message)), value(formatMessagePreview(slot.message)));
    } else if (slot.kind === 'loading') {
      rows.push(label('----'), value('LOADING'));
    } else if (slot.kind === 'not-kept') {
      rows.push(label(''), value({ text: 'OLDER MSGS NOT KEPT', className: 'dim' }));
    } else {
      rows.push(...blank());
    }
  }
  return { n: view.n, m: view.m, rows };
}

function messagePages() {
  const selection = session.selectedMessage();
  return selection && selection.message ? paginateText(selection.message.body) : null;
}

function paintMessage(view) {
  const selection = session.selectedMessage();
  const rows = [];
  let m = 1;
  if (!selection) {
    rows.push(label(''), value('NO MESSAGES'));
  } else if (!selection.message) {
    rows.push(label('----'), value('LOADING'));
  } else {
    const pages = paginateText(selection.message.body);
    m = pages.length;
    if (textPage > m) textPage = m;
    rows.push(label(formatMessageHeader(selection.message)));
    for (const line of pages[textPage - 1]) {
      rows.push(row('row-value dl-text', cutText(line.text)));
    }
    while (rows.length < ROWS - 1) rows.push(row('row-value dl-text', ''));
  }
  while (rows.length < ROWS - 1) rows.push(rows.length % 2 === 0 ? label('') : value(''));
  rows.push(value(prompt('<RETURN'), ''));
  fill(view, rows);
  fmc.setPageNumber(m > 1 ? textPage : 1, m);
}

/** Page id → paint(view), for every page built by `dlPage`. */
const painters = new Map();

function repaint() {
  if (!current) return;
  painters.get(current.id)(current.view);
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** One REFRESH at a time; the sidecar coalesces anyway, the scratchpad need not. */
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fmc.refreshDatalink();
    if (!response || response.ok !== true) {
      const text = errorText(response && response.error);
      if (text) fmc.setScratchpad(text, 'error');
    }
  } catch {
    fmc.setScratchpad(errorText({ code: 'host-error' }), 'error');
  } finally {
    refreshing = false;
  }
}

/**
 * CLR PREFILE: one call at a time. The scope line changes when the datalink
 * state that follows the clear arrives, not here.
 */
async function clearPrefile() {
  if (clearing) return;
  clearing = true;
  try {
    const response = await fmc.clearPrefiledLeg();
    if (response && response.ok === true) {
      if (response.result && response.result.cleared === true) fmc.setScratchpad(ADVISORY.cleared, 'advisory');
    } else {
      fmc.setScratchpad(prefileErrorText(response && response.error, 'clear'), 'error');
    }
  } catch {
    fmc.setScratchpad(prefileErrorText({ code: 'host-error' }, 'clear'), 'error');
  } finally {
    clearing = false;
  }
}

function afterThreadChange() {
  if (current && current.id === 'DL-THREAD') void session.loadVisibleThread();
  if (current && current.id === 'DL-MSG') {
    const selection = session.selectedMessage();
    if (selection && !selection.message) void session.loadRange(selection.seq, selection.seq + 1);
  }
}

// ── Pages ────────────────────────────────────────────────────────────────────

/**
 * A DATALINK page: holds the lease while on screen, repaints on every datalink
 * state, and pages itself. `title` may be a function for a title that follows
 * the data; `hooks.onRender` runs on every render just before the first paint,
 * so a page can reset what it shows and start its own request.
 */
function dlPage(id, title, hooks) {
  painters.set(id, hooks.paint);
  return {
    id,
    get title() { return typeof title === 'function' ? title() : title; },
    group: id,
    get n() { return hooks.number ? hooks.number()[0] : 1; },
    get m() { return hooks.number ? hooks.number()[1] : 1; },
    render() {
      session.enterDlPage();
      session.sync();
      const view = createView(id);
      current = { id, view };
      if (hooks.onRender) hooks.onRender();
      repaint();
      afterThreadChange();
      return view;
    },
    dispose() {
      if (current && current.id === id) current = null;
      session.leaveDlPage();
    },
    onDatalink(state) {
      session.applyState(state);
      repaint();
      afterThreadChange();
    },
    onLsk: hooks.onLsk,
    onPageKey: hooks.onPageKey || (() => true),
  };
}

/** Scratchpad the refusal and stay, or run `open` when a flight plan is known. */
function withTarget(open) {
  const state = session.getState();
  if (!writeTarget(state && state.scope)) {
    fmc.setScratchpad(NO_FLIGHT_PLAN, 'error');
    return true;
  }
  open();
  return true;
}

/**
 * Registers the reading pages and returns what the write and clearance pages
 * share with them: the one session, the page factory, a repaint of whatever
 * DATALINK page is on screen, its id, and the hooks that give DL-INDEX R5 and
 * R2 their actions without this module importing the pages behind them.
 */
export function register(api) {
  fmc = api;
  session = createDatalinkSession(fmc);
  session.setRepaint(repaint);

  fmc.registerPage(dlPage('DL-INDEX', 'ACARS DATALINK', {
    paint: paintIndex,
    onLsk(lsk) {
      if (lsk === 'R1') {
        if (!heldPrefiledLeg(session.getState())) return false;
        void clearPrefile();
        return true;
      }
      if (lsk === 'R2') return sayIntentionsAction ? sayIntentionsAction() : false;
      if (lsk === 'L3') {
        const state = session.getState();
        if (state && state.scope && state.scope.kind === 'none') {
          fmc.setScratchpad(NO_FLIGHT_PLAN, 'error');
          return true;
        }
        session.showNewestThreadPage();
        fmc.showPage('DL-THREAD');
        return true;
      }
      if (lsk === 'L4') return withTarget(() => fmc.showPage('DL-CANNED'));
      if (lsk === 'R3') return withTarget(() => fmc.showPage('DL-WX'));
      if (lsk === 'R4') {
        const state = session.getState();
        const leg = loadsheetLeg(state && state.scope);
        if (!leg.ok) fmc.setScratchpad(leg.text, 'error');
        else fmc.showPage('DL-LOADSHEET');
        return true;
      }
      if (lsk === 'R5') return clearanceAction ? clearanceAction() : false;
      if (lsk === 'R6') {
        void refresh();
        return true;
      }
      if (lsk === 'L6') {
        fmc.showPage('MENU');
        return true;
      }
      return false;
    },
  }));

  fmc.registerPage(dlPage('DL-THREAD', 'ACARS MSGS', {
    paint: paintThread,
    number: () => {
      const view = session.threadView();
      return [view.n, view.m];
    },
    onLsk(lsk) {
      if (lsk === 'L6') {
        fmc.showPage('DL-INDEX');
        return true;
      }
      if (lsk === 'R6') {
        void refresh();
        return true;
      }
      const match = /^L([1-5])$/.exec(lsk);
      const state = session.getState();
      if (!match || !state || !state.thread) return false;
      const slot = session.threadView().slots[Number(match[1]) - 1];
      if (!slot || slot.kind !== 'message') return false;
      session.selectMessage(slot.seq);
      textPage = 1;
      fmc.showPage('DL-MSG');
      return true;
    },
    onPageKey(delta) {
      if (session.stepThreadPage(delta)) {
        repaint();
        afterThreadChange();
      }
      return true;
    },
  }));

  fmc.registerPage(dlPage('DL-MSG', 'ACARS MSG', {
    paint: paintMessage,
    number: () => {
      const pages = messagePages();
      return pages ? [Math.min(textPage, pages.length), pages.length] : [1, 1];
    },
    onLsk(lsk) {
      if (lsk !== 'L6') return false;
      session.returnToThreadPage();
      fmc.showPage('DL-THREAD');
      return true;
    },
    onPageKey(delta) {
      const pages = messagePages();
      const m = pages ? pages.length : 1;
      if (m > 1) {
        textPage = ((textPage - 1 + delta + m) % m) + 1;
        repaint();
      }
      return true;
    },
  }));

  return {
    session,
    dlPage,
    repaint,
    currentPageId: () => (current ? current.id : null),
    setClearanceAction(fn) { clearanceAction = typeof fn === 'function' ? fn : null; },
    setSayIntentionsAction(fn) { sayIntentionsAction = typeof fn === 'function' ? fn : null; },
  };
}
