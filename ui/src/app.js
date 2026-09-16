// The panel shell: page routing, the scratchpad, the key and LSK handlers,
// and the wiring from the host's status stream onto the screen.
//
// Import rule: this is the only module under src/ that may import
// ./bridge.js, and it keeps what it learns there to itself. It builds the one
// small interface every page is allowed to use, hands it to each page module at
// registration and again as `ctx.fmc` on every callback, and the adapter itself
// is not a member of either — a page that could reach the host would, and the
// boundary would then only be as strong as the next reviewer's attention.
//
// This file owns the chrome and nothing else. Pages are separate modules that
// register themselves; the config pages are imported lazily on the first
// navigation to one — so the shell boots, and screenshots, with no config page
// present at all. If that import fails the scratchpad says PAGE UNAVAILABLE;
// it never throws and never leaves a blank screen, because a blank panel on a
// machine nobody can reach is the worst outcome this app has.

import bridge from './bridge.js';
import * as statusPage from './pages/status-page.js';
import { defaultStatus } from './status.js';

const MAX_SCRATCHPAD_CHARS = 4096;
/** Pages that live in the lazily-imported bundle. */
const LAZY_PAGE_IDS = new Set(['NETWORK', 'SIM', 'TRAFFIC']);

const dom = {
  screen: document.getElementById('fmc-screen'),
  title: document.getElementById('page-title'),
  number: document.getElementById('page-number'),
  body: document.getElementById('page-body'),
  scratchpad: document.getElementById('scratchpad'),
  msgLine: document.getElementById('msg-line'),
  bridgeMode: document.getElementById('bridge-mode'),
};

const pages = new Map();
const state = {
  pageId: null,
  status: defaultStatus(),
  config: null,
  configPath: '',
  entry: '',
  message: null,
  pagesLoaded: false,
  pagesLoading: null,
};

// ── Scratchpad ───────────────────────────────────────────────────────────────

function paintScratchpad() {
  if (!dom.scratchpad) return;
  if (state.message) {
    dom.scratchpad.textContent = state.message.text;
    dom.scratchpad.setAttribute('data-message-kind', state.message.kind);
    return;
  }
  // The destination LSK is selected after typing; mask every NETWORK entry
  // so a token can never be painted before we know which field will receive it.
  dom.scratchpad.textContent = state.pageId === 'NETWORK' && state.entry
    ? '•'.repeat(Math.min(22, state.entry.length))
    : state.entry.slice(-22);
  dom.scratchpad.setAttribute('data-message-kind', 'entry');
}

/**
 * `kind` of `entry` replaces what the user has typed; `error` and `advisory`
 * are messages layered over it, so clearing the message brings the typed
 * entry back — the CDU behaviour people expect.
 */
function setScratchpad(text, kind = 'entry') {
  const value = text === null || text === undefined ? '' : String(text);
  if (kind === 'entry') {
    state.entry = value.slice(0, MAX_SCRATCHPAD_CHARS);
    state.message = null;
  } else {
    state.message = { text: value, kind: kind === 'advisory' ? 'advisory' : 'error' };
  }
  paintScratchpad();
}

function getScratchpad() {
  return state.message ? '' : state.entry;
}

function appendScratchpad(char) {
  state.message = null;
  if (state.entry.length >= MAX_SCRATCHPAD_CHARS) {
    paintScratchpad();
    return;
  }
  state.entry = (state.entry + char).slice(0, MAX_SCRATCHPAD_CHARS);
  paintScratchpad();
}

function clearScratchpad() {
  if (state.message) {
    state.message = null;
  } else if (state.entry.length > 0) {
    state.entry = state.entry.slice(0, -1);
  }
  paintScratchpad();
}

// ── Page registry and routing ────────────────────────────────────────────────

/**
 * A page is `{ id, title, group, n, m, render(ctx), onLsk(lsk, ctx),
 * onStatus(status), dispose() }`. `render` returns the element to place in
 * #page-body, or writes into `ctx.body` itself and returns nothing. Only
 * `id`, `title` and `render` are required.
 */
function registerPage(page) {
  if (!page || typeof page.id !== 'string' || typeof page.render !== 'function') {
    setScratchpad('PAGE UNAVAILABLE', 'error');
    return;
  }
  pages.set(page.id, page);
}

function pageContext() {
  return {
    body: dom.body,
    config: state.config,
    status: state.status,
    fmc: window.FMC,
  };
}

async function loadPages() {
  if (state.pagesLoaded) return true;
  if (!state.pagesLoading) {
    state.pagesLoading = import('./pages/index.js')
      .then((module) => {
        module.register(window.FMC);
        state.pagesLoaded = true;
        return true;
      })
      .catch(() => {
        state.pagesLoading = null;
        return false;
      });
  }
  return state.pagesLoading;
}

async function showPage(id) {
  if (!pages.has(id) && LAZY_PAGE_IDS.has(id)) {
    const loaded = await loadPages();
    if (!loaded || !pages.has(id)) {
      setScratchpad('PAGE UNAVAILABLE', 'error');
      return false;
    }
  }
  const page = pages.get(id);
  if (!page) {
    setScratchpad('PAGE UNAVAILABLE', 'error');
    return false;
  }

  const previous = state.pageId ? pages.get(state.pageId) : null;
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose();
    } catch {
      /* a page that cannot tidy up must not block navigation */
    }
  }

  // Cleared child by child rather than with replaceChildren(): a throw here
  // would leave no current page and freeze the display.
  if (dom.body) while (dom.body.firstChild) dom.body.removeChild(dom.body.firstChild);
  if (state.pageId !== id) setScratchpad('');
  state.pageId = id;
  paintScratchpad();

  let view = null;
  try {
    view = page.render(pageContext());
  } catch {
    setScratchpad('PAGE UNAVAILABLE', 'error');
  }
  if (view instanceof Node && dom.body) dom.body.appendChild(view);

  if (dom.screen) dom.screen.setAttribute('data-page', id);
  if (dom.title) dom.title.textContent = page.title || id;
  if (dom.number) {
    dom.number.textContent = page.m && page.m > 1 ? `${page.n}/${page.m}` : '';
  }
  paintStatus();
  return true;
}

/** PREV/NEXT step through the current page's group, in order, and wrap. */
function stepGroup(delta) {
  const current = state.pageId ? pages.get(state.pageId) : null;
  if (!current) return;
  const group = [...pages.values()]
    .filter((page) => page.group && page.group === current.group)
    .sort((a, b) => (a.n || 0) - (b.n || 0));
  if (group.length < 2) {
    setScratchpad('KEY NOT ACTIVE', 'error');
    return;
  }
  const index = group.findIndex((page) => page.id === current.id);
  const next = group[(index + delta + group.length) % group.length];
  showPage(next.id);
}

// ── Built-in pages ───────────────────────────────────────────────────────────

function row(className, left, right) {
  const el = document.createElement('div');
  el.className = `row ${className}`;
  const l = document.createElement('span');
  l.className = 'cell-l';
  l.textContent = left || '';
  el.appendChild(l);
  if (right !== undefined) {
    const r = document.createElement('span');
    r.className = 'cell-r';
    r.textContent = right;
    el.appendChild(r);
  }
  return el;
}

const MENU_ITEMS = [
  { lsk: 'L1', label: '<STATUS', page: 'STATUS' },
  { lsk: 'L2', label: '<NETWORK', page: 'NETWORK' },
  { lsk: 'L3', label: '<SIM', page: 'SIM' },
  { lsk: 'L4', label: '<TRAFFIC', page: 'TRAFFIC' },
];

registerPage({
  id: 'MENU',
  title: 'MSFSLOGGER',
  group: 'MENU',
  n: 1,
  m: 1,
  render() {
    const view = document.createElement('div');
    view.className = 'page-view';
    view.setAttribute('data-page-view', 'MENU');
    view.appendChild(row('row-label', 'SELECT PAGE'));
    for (const item of MENU_ITEMS) {
      const line = row('row-value row-prompts', item.label);
      line.firstChild.classList.add('prompt');
      view.appendChild(line);
      view.appendChild(row('row-label', ''));
    }
    while (view.childElementCount < 12) view.appendChild(row('row-label', ''));
    return view;
  },
  onLsk(lsk) {
    const item = MENU_ITEMS.find((entry) => entry.lsk === lsk);
    if (!item) return false;
    showPage(item.page);
    return true;
  },
});

// ── Host commands ────────────────────────────────────────────────────────────

/**
 * The three command members of the page interface share one failure message,
 * because a page has nothing useful to do with the error and every page that
 * offered a command prompt would otherwise repeat this try/catch.
 */
async function runCommand(fn) {
  try {
    await fn();
    return true;
  } catch {
    setScratchpad('COMMAND FAILED', 'error');
    return false;
  }
}

// ── Status painting ──────────────────────────────────────────────────────────

function paintStatus() {
  const page = state.pageId ? pages.get(state.pageId) : null;
  if (page && typeof page.onStatus === 'function') {
    try {
      page.onStatus(state.status);
    } catch {
      /* a page that mishandles a status must not stop the axes updating */
    }
  }
}

function applyStatus(status) {
  if (!status || typeof status !== 'object') return;
  state.status = status;
  // A host whose link came up only after boot failed the boot-time config
  // read; a status proves the link is up, so read it again once.
  if (!state.configLoaded && !state.configLoading) {
    state.configLoading = true;
    const done = () => { state.configLoading = false; };
    loadConfig().then(done, done);
  }
  const problems = status.app && Array.isArray(status.app.problems) ? status.app.problems : null;
  if (problems && problems.length > 0) {
    setMessageLine(`CFG ${problems[0].field}: ${problems[0].message}`, 'warn');
  }
  paintStatus();
}

function setMessageLine(text, level = 'info') {
  if (!dom.msgLine) return;
  dom.msgLine.textContent = text || '';
  dom.msgLine.setAttribute('data-level', level);
}

function applyLog(log) {
  if (!log || typeof log !== 'object') return;
  setMessageLine(String(log.message || ''), String(log.level || 'info'));
}

function applyExit(payload) {
  const info = payload && typeof payload === 'object' ? payload : {};
  const code = info.code === null || info.code === undefined ? info.signal || '?' : info.code;
  const tail = info.restarting ? ' - RESTARTING' : '';
  setMessageLine(`SIDECAR EXIT ${code}${tail}`, 'error');
}

// ── Keys ────────────────────────────────────────────────────────────────────

function handleKey(key) {
  if (key === '+/-') {
    setScratchpad(state.entry.startsWith('-') ? state.entry.slice(1) : `-${state.entry}`);
    return;
  }
  if (typeof key === 'string' && key.length === 1) {
    appendScratchpad(key);
    return;
  }
  switch (key) {
    case 'SP':
      appendScratchpad(' ');
      return;
    case 'CLR':
      clearScratchpad();
      return;
    case 'DEL':
      // The CDU way to empty a field: put DELETE on the scratchpad and line
      // select it onto the field you want cleared.
      if (getScratchpad().length === 0) setScratchpad('DELETE');
      else setScratchpad('');
      return;
    case 'MENU':
      showPage('MENU');
      return;
    case 'PREV':
      stepGroup(-1);
      return;
    case 'NEXT':
      stepGroup(1);
      return;
    default:
      break;
  }
  const page = state.pageId ? pages.get(state.pageId) : null;
  if (page && typeof page.onKey === 'function' && page.onKey(key, pageContext())) return;
  setScratchpad('KEY NOT ACTIVE', 'error');
}

function handleLsk(lsk) {
  const page = state.pageId ? pages.get(state.pageId) : null;
  if (page && typeof page.onLsk === 'function') {
    let handled = false;
    try {
      handled = page.onLsk(lsk, pageContext()) === true;
    } catch {
      setScratchpad('COMMAND FAILED', 'error');
      return;
    }
    if (handled) return;
  }
  setScratchpad('KEY NOT ACTIVE', 'error');
}

function flashKey(el) {
  if (!el) return;
  el.classList.add('is-pressed');
  setTimeout(() => el.classList.remove('is-pressed'), 110);
}

/** Physical keyboard, mapped onto the same handlers as the drawn keys. */
function keyFromEvent(event) {
  const key = event.key;
  if (typeof key !== 'string') return null;
  if (key.length === 1) {
    if (key === ' ') return 'SP';
    return key;
  }
  if (key === 'Backspace') return 'CLR';
  if (key === 'Delete') return 'DEL';
  if (key === 'Enter') return 'EXEC';
  if (key === 'Escape') return 'CLR';
  if (key === 'PageUp') return 'PREV';
  if (key === 'PageDown') return 'NEXT';
  return null;
}

function wireKeys() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-key],[data-lsk]') : null;
    if (!target) return;
    flashKey(target);
    const lsk = target.getAttribute('data-lsk');
    if (lsk) handleLsk(lsk);
    else handleKey(target.getAttribute('data-key'));
  });

  document.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text) {
      event.preventDefault();
      appendScratchpad(text.replace(/[\r\n]/g, ''));
    }
  });
  let clearTimer;
  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest?.('[data-key="CLR"]')) {
      clearTimer = setTimeout(() => setScratchpad(''), 500);
    }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    document.addEventListener(type, () => clearTimeout(clearTimer));
  }

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = keyFromEvent(event);
    if (!key) return;
    event.preventDefault();
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(key)
      : key.replace(/["\\]/g, '\\$&');
    flashKey(document.querySelector(`[data-key="${escaped}"]`));
    handleKey(key);
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const result = await bridge.getConfig();
    if (result && typeof result === 'object') {
      state.config = result.raw || result.config || null;
      if (typeof result.path === 'string') state.configPath = result.path;
    }
    state.configLoaded = true;
  } catch {
    setMessageLine('CONFIG READ FAILED', 'error');
  }
  try {
    const path = await bridge.getConfigPath();
    if (typeof path === 'string' && path) state.configPath = path;
  } catch {
    /* the path is a convenience; its absence must not stop the boot */
  }
  paintStatus();
}

function boot() {
  if (dom.bridgeMode) {
    // The host names itself. Hardcoding TAURI here would make the one piece of
    // chrome whose job is saying which host you are on the piece that lies.
    dom.bridgeMode.setAttribute('data-stub', bridge.isStub ? 'true' : 'false');
    dom.bridgeMode.textContent = bridge.hostLabel;
  }

  // Everything a page is allowed to do, and the adapter is deliberately not
  // among it. Built as a local first so it can be injected into page modules
  // that are loaded by something other than a browser's module loader.
  const fmc = {
    registerPage,
    showPage,
    setScratchpad,
    getScratchpad,
    hasScratchpadError: () => state.message?.kind === 'error',
    getConfigCache: () => state.config,
    getConfigPath: () => state.configPath,
    getStatus: () => state.status,
    refreshConfig: loadConfig,
    setConfig: (patch) => bridge.setConfig(patch),
    startUplink: () => runCommand(() => bridge.startUplink()),
    stopUplink: () => runCommand(() => bridge.stopUplink()),
    restartSidecar: () => runCommand(() => bridge.restartSidecar()),
  };
  window.FMC = fmc;

  wireKeys();
  paintScratchpad();
  statusPage.register(fmc);
  showPage('STATUS');

  bridge.onStatus(applyStatus);
  bridge.onLog(applyLog);
  bridge.onExit(applyExit);

  // Paint from the last known status immediately rather than waiting up to
  // five seconds for the next heartbeat.
  Promise.resolve()
    .then(() => bridge.getStatus())
    .then((status) => applyStatus(status))
    .catch(() => {});

  loadConfig();

  // The retry countdown ticks locally: the sidecar sends nextRetryAt once and
  // the seconds come off the clock here.
  setInterval(paintStatus, 1000);
}

boot();
