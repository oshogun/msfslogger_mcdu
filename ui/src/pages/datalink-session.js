// State shared by the DATALINK pages: the watch lease, the latest datalink
// state, and the thread cache with its fetch loop.
//
// The sidecar polls the server only while a lease is held, and a lease is
// held only while a DATALINK page is showing. Pages report entering and
// leaving; moving between two DATALINK pages disposes one and renders the
// next in the same tick, so the release is deferred a tick and skipped when a
// DATALINK page is back on screen by then.
//
// The sidecar keeps the thread and hands it out in windows. The cache here is
// keyed by the sidecar's epoch: a new epoch means rows moved or the scope
// changed, so everything cached is dropped rather than patched.
//
// No DOM is touched in this module; the harness imports it under Node.

import { errorText } from './datalink-vocab.js';

export const DATALINK_WATCH_RENEW_MS = 20000;
export const REWATCH_DEBOUNCE_MS = 5000;
export const THREAD_PAGE_SIZE = 5;
export const THREAD_CACHE_MAX = 200;
const FETCH_ROUNDS_MAX = 5;

/** States in which the shell itself knows a watch cannot succeed. */
const NO_REWATCH_STATES = new Set(['dl.sidecar-outdated', 'dl.sidecar-unavailable']);

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/** `options` replaces the clock and timers, which is how the harness drives it. */
export function createDatalinkSession(fmc, options = {}) {
  const now = options.now || (() => Date.now());
  const every = options.setInterval || ((fn, ms) => setInterval(fn, ms));
  const stopEvery = options.clearInterval || ((handle) => clearInterval(handle));
  const later = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const onError = (text) => fmc.setScratchpad(text, 'error');

  let dlShowing = false;
  let renew = null;
  let lastWatchAt = -Infinity;
  let latest = null;
  let cache = null;
  let page = 1;
  let followTail = true;
  let visible = { lo: 0, hi: 0 };
  let fetching = false;
  let rerun = false;
  let selected = null;
  let repaint = null;
  let pending = null;
  let sending = false;

  const call = (fn) => Promise.resolve().then(fn).catch(() => null);

  function watch(on) {
    if (on) lastWatchAt = now();
    return call(() => fmc.watchDatalink(on));
  }

  function notify() {
    if (typeof repaint !== 'function') return;
    try {
      repaint();
    } catch {
      /* a page that cannot repaint must not stall the fetch loop */
    }
  }

  // ── Watch lease ────────────────────────────────────────────────────────────

  function enterDlPage() {
    dlShowing = true;
    if (renew !== null) return;
    void watch(true);
    renew = every(() => void watch(true), DATALINK_WATCH_RENEW_MS);
  }

  function leaveDlPage() {
    dlShowing = false;
    later(() => {
      if (dlShowing || renew === null) return;
      stopEvery(renew);
      renew = null;
      void watch(false);
    }, 0);
  }

  // ── State ──────────────────────────────────────────────────────────────────

  function pageCount() {
    return cache ? Math.max(1, Math.ceil(cache.total / THREAD_PAGE_SIZE)) : 1;
  }

  function adoptThread(summary) {
    if (!summary || typeof summary !== 'object' || !isCount(summary.epoch)) {
      cache = null;
      page = 1;
      followTail = true;
      return;
    }
    const total = isCount(summary.total) ? summary.total : 0;
    const firstSeq = isCount(summary.firstSeq) ? Math.min(summary.firstSeq, total) : 0;
    if (!cache || cache.epoch !== summary.epoch) {
      cache = { epoch: summary.epoch, total, firstSeq, bySeq: new Map() };
      page = pageCount();
      followTail = true;
      return;
    }
    if (firstSeq > cache.firstSeq) cache.firstSeq = firstSeq;
    if (total !== cache.total) {
      cache.total = total;
      for (const seq of cache.bySeq.keys()) if (seq >= total) cache.bySeq.delete(seq);
      page = followTail ? pageCount() : Math.min(page, pageCount());
    }
  }

  function applyState(state) {
    if (!state || typeof state !== 'object') return;
    latest = state;
    adoptThread(state.thread);
    // A restarted sidecar comes back with no lease; take it again, but not in
    // a loop if the host keeps answering not-watching.
    if (
      dlShowing
      && state.watching === false
      && !NO_REWATCH_STATES.has(state.state)
      && now() - lastWatchAt >= REWATCH_DEBOUNCE_MS
    ) {
      void watch(true);
    }
  }

  /** Adopt whatever the shell last cached; used when a DATALINK page renders. */
  function sync() {
    const state = fmc.getDatalinkState();
    if (state && state !== latest) applyState(state);
  }

  function getState() {
    return latest || fmc.getDatalinkState() || null;
  }

  // ── Thread pages ───────────────────────────────────────────────────────────

  function clampPage() {
    const m = pageCount();
    if (page > m) page = m;
    if (page < 1) page = 1;
    return m;
  }

  function pageRange() {
    const lo = (page - 1) * THREAD_PAGE_SIZE;
    return { lo, hi: cache ? Math.min(lo + THREAD_PAGE_SIZE, cache.total) : lo };
  }

  function threadView() {
    const m = clampPage();
    const { lo } = pageRange();
    const slots = [];
    for (let seq = lo; seq < lo + THREAD_PAGE_SIZE; seq += 1) {
      if (!cache || seq >= cache.total) slots.push({ kind: 'empty', seq });
      else if (seq < cache.firstSeq) slots.push({ kind: 'not-kept', seq });
      else if (cache.bySeq.has(seq)) slots.push({ kind: 'message', seq, message: cache.bySeq.get(seq) });
      else slots.push({ kind: 'loading', seq });
    }
    return { n: page, m, cached: cache !== null, total: cache ? cache.total : 0, slots };
  }

  function showNewestThreadPage() {
    page = pageCount();
    followTail = true;
  }

  /** PREV/NEXT on the thread; wraps. Returns false when there is one page. */
  function stepThreadPage(delta) {
    const m = clampPage();
    if (m === 1) return false;
    page = ((page - 1 + delta + m) % m) + 1;
    followTail = page === m;
    return true;
  }

  function setThreadPage(n) {
    page = n;
    const m = clampPage();
    followTail = page === m;
  }

  // ── Fetch loop ─────────────────────────────────────────────────────────────

  function clearCache() {
    cache = null;
    page = 1;
    followTail = true;
  }

  function evict() {
    if (!cache || cache.bySeq.size <= THREAD_CACHE_MAX) return;
    const { lo, hi } = visible;
    const distance = (seq) => (seq < lo ? lo - seq : seq >= hi ? seq - hi + 1 : 0);
    const farthest = [...cache.bySeq.keys()].sort((a, b) => distance(b) - distance(a));
    for (const seq of farthest) {
      if (cache.bySeq.size <= THREAD_CACHE_MAX) break;
      cache.bySeq.delete(seq);
    }
  }

  function merge(target, messages) {
    let added = 0;
    for (const message of messages) {
      if (!message || typeof message !== 'object' || !isCount(message.seq)) continue;
      if (message.seq < target.firstSeq || message.seq >= target.total) continue;
      if (typeof message.body !== 'string') continue;
      if (!target.bySeq.has(message.seq)) added += 1;
      target.bySeq.set(message.seq, message);
    }
    return added;
  }

  async function runRounds() {
    for (let round = 0; round < FETCH_ROUNDS_MAX; round += 1) {
      const target = cache;
      if (!target) return;
      const from = Math.max(visible.lo, target.firstSeq);
      const to = Math.min(visible.hi, target.total);
      let endSeq = -1;
      for (let seq = from; seq < to; seq += 1) if (!target.bySeq.has(seq)) endSeq = seq + 1;
      if (endSeq < 0) return;

      const response = await call(() => fmc.getDatalinkThread({ epoch: target.epoch, endSeq }));
      // A state with a new epoch landed while we waited: this answer belongs
      // to a thread nobody is looking at any more.
      if (cache !== target) return;
      if (!response || response.ok !== true) {
        const error = response && response.error;
        if (error && error.code === 'stale-epoch') {
          clearCache();
          notify();
          return;
        }
        const text = errorText(error);
        if (text) onError(text);
        return;
      }
      const result = response.result;
      if (!result || typeof result !== 'object' || result.epoch !== target.epoch) {
        clearCache();
        notify();
        return;
      }
      if (isCount(result.firstSeq) && result.firstSeq > target.firstSeq) {
        target.firstSeq = Math.min(result.firstSeq, target.total);
        for (const seq of target.bySeq.keys()) if (seq < target.firstSeq) target.bySeq.delete(seq);
      }
      const messages = Array.isArray(result.messages) ? result.messages : [];
      const added = merge(target, messages);
      evict();
      notify();
      if (messages.length === 0 || added === 0) return;
    }
  }

  /** Fetch whatever of `[lo, hi)` is missing. Concurrent calls coalesce. */
  async function loadRange(lo, hi) {
    visible = { lo, hi };
    if (fetching) {
      rerun = true;
      return;
    }
    fetching = true;
    try {
      do {
        rerun = false;
        await runRounds();
      } while (rerun);
    } finally {
      fetching = false;
    }
  }

  function loadVisibleThread() {
    clampPage();
    const { lo, hi } = pageRange();
    return loadRange(lo, hi);
  }

  // ── Selected message ───────────────────────────────────────────────────────

  function selectMessage(seq) {
    const message = cache && cache.bySeq.has(seq) ? cache.bySeq.get(seq) : null;
    selected = { seq, message, threadPage: page };
  }

  function selectedMessage() {
    if (!selected) return null;
    if (!selected.message && cache && cache.bySeq.has(selected.seq)) {
      selected.message = cache.bySeq.get(selected.seq);
    }
    return selected;
  }

  function returnToThreadPage() {
    if (selected) setThreadPage(selected.threadPage);
  }

  // ── Pending write ──────────────────────────────────────────────────────────
  //
  // No key press sends anything by itself. Selecting a downlink, a WX request
  // or a load sheet only records it here; the confirm page's SEND makes the one
  // request, and a second SEND while it is out does nothing.

  const WRITE_KINDS = new Set(['canned', 'wx', 'loadsheet']);

  /** Record the action to confirm. Refused while another one is being sent. */
  function selectAction(action) {
    if (sending) return false;
    if (!action || typeof action !== 'object' || !WRITE_KINDS.has(action.kind)) return false;
    pending = { ...action, target: action.target ? { ...action.target } : undefined };
    return true;
  }

  function pendingAction() {
    return pending ? { ...pending } : null;
  }

  function isSending() {
    return sending;
  }

  /** Drop the pending action without sending it. Not possible once it is out. */
  function cancelAction() {
    if (sending) return false;
    pending = null;
    return true;
  }

  function writeCall(action) {
    if (action.kind === 'canned') {
      return fmc.sendCannedMessage({ target: action.target, cannedId: action.cannedId });
    }
    if (action.kind === 'wx') return fmc.requestWeather({ target: action.target, icao: action.icao });
    return fmc.requestLoadsheet({ plannedLegId: action.plannedLegId });
  }

  /**
   * `{ status: 'none' }` with nothing pending, `{ status: 'busy' }` while a send
   * is out, otherwise `{ status: 'done', action, response }` once the single
   * request has answered. The pending action is cleared either way.
   */
  async function sendPending() {
    if (sending) return { status: 'busy' };
    if (!pending) return { status: 'none' };
    const action = pending;
    sending = true;
    try {
      const response = await call(() => writeCall(action));
      const envelope = response && typeof response === 'object' && typeof response.ok === 'boolean'
        ? response
        : { ok: false, error: { code: 'host-error', httpStatus: null, serverCode: null } };
      return { status: 'done', action, response: envelope };
    } finally {
      pending = null;
      sending = false;
    }
  }

  return {
    selectAction,
    pendingAction,
    isSending,
    cancelAction,
    sendPending,
    enterDlPage,
    leaveDlPage,
    applyState,
    sync,
    getState,
    threadView,
    showNewestThreadPage,
    stepThreadPage,
    loadRange,
    loadVisibleThread,
    selectMessage,
    selectedMessage,
    returnToThreadPage,
    setRepaint(fn) { repaint = fn; },
    isWatching: () => renew !== null,
  };
}
