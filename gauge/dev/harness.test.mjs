import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGaugeServer } from './server.mjs';

test('host scenarios, subscriptions and memory-only configuration', async () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await readFile(new URL('./mock-host.js', import.meta.url), 'utf8'), context);
  const { __FMC_HOST__: host, gaugeDev } = context.window;
  const seen = [];
  const off = host.onStatus(status => seen.push(status));
  await host.startUplink();
  assert.equal(seen.at(-1).backend.state, 'net.ok');
  gaugeDev.scenario('offline');
  assert.equal(seen.at(-1).sim.state, 'sim.connected');
  assert.equal(seen.at(-1).backend.state, 'net.unreachable');
  gaugeDev.scenario('active-pause');
  assert.equal(seen.at(-1).pause.state, 'pause.active');
  gaugeDev.scenario('retry');
  assert.ok(seen.at(-1).sim.nextRetryAt > Date.now());
  off();
  const count = seen.length;
  await host.stopUplink();
  assert.equal(seen.length, count);
  assert.equal((await host.getStatus()).app.state, 'app.stopped');
  await host.setConfig({ ingestToken: 'secret-test', trafficRadiusM: 50000 });
  const config = await host.getConfig();
  assert.equal(config.config.tokenSet, true);
  assert.equal(config.config.trafficRadiusM, 50000);
  assert.ok(!JSON.stringify(config).includes('secret-test'));
  assert.ok(!JSON.stringify(gaugeDev.calls).includes('secret-test'));
  config.config.trafficRadiusM = 1;
  assert.equal((await host.getConfig()).config.trafficRadiusM, 50000);
  assert.throws(() => gaugeDev.scenario('typo'));
});

test('serves real UI with early adapter injection and limits file access', async t => {
  const server = createGaugeServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(url + '/ui/index.html')).text();
  assert.ok(html.indexOf('mock-host.js') < html.indexOf('src/app.js'));
  assert.ok(html.includes('mock-host.js'));
  const js = await fetch(url + '/ui/src/app.js');
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  assert.equal(js.headers.get('cache-control'), 'no-store');
  for (const path of ['/.git/config', '/sidecar/package.json', '/ui/%2e%2e%2fpackage.json']) {
    assert.equal((await fetch(url + path)).status, 404);
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.ok((await (await fetch(url + '/__revision')).text()).includes('mock-host.js'));
});

// ── Datalink ─────────────────────────────────────────────────────────────────

const SENTINEL = 'SENTINEL-DATALINK-TOKEN-0000';
const DATALINK_SCENARIOS = ['flight', 'leg', 'no-flight-plan', 'pre-upgrade', 'invalid-token', 'unreachable',
  'long-taf', 'long-route', 'no-dispatch', 'canned-four', 'wx-unavailable', 'sidecar-outdated'];
const DATALINK_METHODS = ['getDatalinkState', 'onDatalink', 'watchDatalink', 'refreshDatalink',
  'getDatalinkThread', 'getCannedMessages', 'sendCannedMessage', 'requestWeather', 'requestLoadsheet'];
const WRITE_METHODS = ['sendCannedMessage', 'requestWeather', 'requestLoadsheet'];
const STATE_KEYS = ['at', 'httpStatus', 'lastErrorAt', 'lastOkAt', 'nextPollAt', 'scope', 'serverCode', 'state', 'thread', 'type', 'v', 'watching'];
const MESSAGE_KEYS = ['body', 'category', 'correlationId', 'direction', 'id', 'label', 'sentAt', 'seq'];
const FLIGHT = { kind: 'flight', flightId: 92, plannedLegId: 12 };
const LEG = { kind: 'leg', plannedLegId: 12, source: 'ground-session' };
const FAULTS = {
  'pre-upgrade': { state: 'dl.unavailable', error: { code: 'unavailable', httpStatus: 401, serverCode: null } },
  'invalid-token': { state: 'dl.token-invalid', error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' } },
  unreachable: { state: 'dl.unreachable', error: { code: 'unreachable', httpStatus: null, serverCode: null } },
  'sidecar-outdated': { state: 'dl.sidecar-outdated', error: { code: 'sidecar-outdated', httpStatus: null, serverCode: null } },
};
const OK_SCOPES = {
  flight: [FLIGHT, 5], leg: [LEG, 3], 'no-flight-plan': [{ kind: 'none' }, null], 'long-taf': [FLIGHT, 6],
  'long-route': [LEG, 3], 'no-dispatch': [LEG, 3], 'canned-four': [FLIGHT, 5], 'wx-unavailable': [FLIGHT, 5],
};
const localError = (code) => ({ ok: false, error: { code, httpStatus: null, serverCode: null } });

// Values from the vm realm carry that realm's prototypes; compare plain copies.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const pageModule = (name) => import(new URL(`../../ui/src/pages/${name}`, import.meta.url));

async function loadMock() {
  // The mock's prefile answers after a timer, as the preview's delay control needs.
  const context = vm.createContext({ window: {}, setTimeout, clearTimeout });
  vm.runInContext(await readFile(new URL('./mock-host.js', import.meta.url), 'utf8'), context);
  const { __FMC_HOST__: host, gaugeDev } = context.window;
  return { host, gaugeDev };
}

async function readWholeThread(host, epoch, total) {
  const seen = new Map();
  let endSeq = total;
  while (endSeq > 0) {
    const response = plain(await host.getDatalinkThread({ epoch, endSeq }));
    assert.equal(response.ok, true);
    const { result } = response;
    assert.deepEqual(Object.keys(result).sort(), ['endSeq', 'epoch', 'firstSeq', 'messages', 'startSeq', 'total']);
    assert.ok(result.messages.length > 0 && result.messages.length <= 5);
    assert.equal(result.startSeq, Math.max(0, endSeq - 5));
    for (const message of result.messages) {
      assert.deepEqual(Object.keys(message).sort(), MESSAGE_KEYS);
      seen.set(message.seq, message);
    }
    endSeq = result.startSeq;
  }
  assert.deepEqual([...seen.keys()].sort((a, b) => a - b), [...Array(total).keys()]);
  return seen;
}

test('datalink mock: every method answers each scenario with the host contract shape', async () => {
  const { host, gaugeDev } = await loadMock();
  for (const name of DATALINK_METHODS) assert.equal(typeof host[name], 'function', name);
  const atLoad = plain(await host.getDatalinkState());
  assert.deepEqual([atLoad.scope, atLoad.watching], [FLIGHT, false]);
  assert.throws(() => gaugeDev.datalinkScenario('typo'), /Unknown datalink scenario: typo/);

  for (const scenario of DATALINK_SCENARIOS) {
    const emitted = [];
    const off = host.onDatalink((state) => emitted.push(plain(state)));
    const returned = plain(gaugeDev.datalinkScenario(scenario));
    assert.deepEqual(emitted.at(-1), returned, scenario);
    const state = plain(await host.getDatalinkState());
    assert.deepEqual(Object.keys(state).sort(), STATE_KEYS, scenario);
    assert.equal(state.type, 'datalink-state');
    const fault = FAULTS[scenario];
    const expectError = (response, error = fault.error) => assert.deepEqual(plain(response), { ok: false, error }, scenario);

    if (fault) {
      assert.deepEqual([state.state, state.httpStatus, state.serverCode, state.scope, state.thread],
        [fault.state, fault.error.httpStatus, fault.error.serverCode, null, null], scenario);
    } else {
      const [scope, total] = OK_SCOPES[scenario];
      assert.equal(state.state, 'dl.ok', scenario);
      assert.deepEqual(state.scope, scope, scenario);
      if (total === null) assert.equal(state.thread, null);
      else {
        assert.equal(state.thread.epoch, returned.thread.epoch);
        assert.ok(state.thread.epoch >= 1);
        assert.deepEqual([state.thread.total, state.thread.firstSeq, state.thread.droppedRows], [total, 0, 0], scenario);
      }
    }

    const watch = await host.watchDatalink(true);
    if (scenario === 'sidecar-outdated') {
      expectError(watch);
      assert.equal(plain(await host.getDatalinkState()).watching, false);
    } else {
      assert.deepEqual(plain(watch), { ok: true, result: { watching: true, leaseMs: 65000 } });
      assert.equal(emitted.at(-1).watching, true);
    }

    const refresh = await host.refreshDatalink();
    if (scenario === 'invalid-token' || scenario === 'sidecar-outdated') expectError(refresh);
    else assert.deepEqual(plain(refresh), { ok: true, result: { accepted: true, coalesced: false } });

    const thread = state.thread;
    if (!thread) {
      expectError(await host.getDatalinkThread({ epoch: 1, endSeq: 0 }), localError('no-thread').error);
    } else {
      const messages = await readWholeThread(host, thread.epoch, thread.total);
      expectError(await host.getDatalinkThread({ epoch: thread.epoch + 1, endSeq: 1 }), localError('stale-epoch').error);
      expectError(await host.getDatalinkThread({ epoch: thread.epoch, endSeq: thread.total + 1 }), localError('bad-request').error);
      if (scenario === 'long-taf') {
        assert.equal(messages.get(5).direction, 'uplink');
        assert.ok(messages.get(5).body.startsWith('METAR EGLL') && messages.get(5).body.includes('\nTAF EGLL'));
      }
      if (scenario === 'long-route') assert.equal(messages.get(0).body.split('\n')[3].length, 'ROUTE '.length + 900);
    }

    const canned = plain(await host.getCannedMessages());
    if (fault) expectError(canned);
    else {
      assert.equal(canned.result.truncated, false);
      assert.equal(canned.result.messages.length, scenario === 'canned-four' ? 4 : 3, scenario);
      for (const entry of canned.result.messages) assert.deepEqual(Object.keys(entry).sort(), ['id', 'label']);
    }

    const target = OK_SCOPES[scenario] && OK_SCOPES[scenario][0].kind === 'leg' ? { kind: 'leg', id: 12 } : { kind: 'flight', id: 92 };
    const before = plain(await host.getDatalinkState()).thread;
    const send = plain(await host.sendCannedMessage({ target, cannedId: fault ? 'x' : canned.result.messages[0].id }));
    if (fault) expectError(send);
    else if (scenario === 'no-flight-plan') expectError(send, { code: 'leg-not-found', httpStatus: 404, serverCode: 'PLANNED_LEG_NOT_FOUND' });
    else {
      assert.deepEqual(send, { ok: true, result: { sent: true, httpStatus: 201 } });
      assert.equal(emitted.at(-1).thread.total, before.total + 1);
      expectError(await host.sendCannedMessage({ target, cannedId: 'not-in-list' }),
        { code: 'unknown-canned-message', httpStatus: 400, serverCode: 'UNKNOWN_CANNED_MESSAGE' });
    }

    const wx = plain(await host.requestWeather({ target, icao: 'EGLL' }));
    if (fault) expectError(wx);
    else {
      assert.equal(wx.ok, true);
      assert.deepEqual(Object.keys(wx.result).sort(), ['available', 'fetchedAt', 'icao', 'metar', 'taf']);
      if (scenario === 'wx-unavailable') assert.deepEqual(wx.result, { icao: 'EGLL', available: false, metar: null, taf: null, fetchedAt: null });
      else assert.equal(wx.result.taf.split('\n').length, scenario === 'long-taf' ? 8 : 1, scenario);
    }

    const sheet = plain(await host.requestLoadsheet({ plannedLegId: 12 }));
    if (fault) expectError(sheet);
    else if (scenario === 'no-dispatch') expectError(sheet, { code: 'no-dispatch-data', httpStatus: 409, serverCode: 'NO_DISPATCH_DATA' });
    else {
      const again = plain(await host.requestLoadsheet({ plannedLegId: 12 }));
      assert.deepEqual([sheet.result.created, sheet.result.httpStatus, again.result.created, again.result.httpStatus], [true, 201, false, 200]);
      assert.deepEqual(again.result.sheet, sheet.result.sheet);
      assert.equal(sheet.result.plannedLegId, 12);
    }
    off();
  }

  gaugeDev.datalinkScenario('invalid-token');
  await host.setConfig({ trafficRadiusM: 45000 });
  assert.equal(plain(await host.getDatalinkState()).state, 'dl.ok');
  for (const call of gaugeDev.calls.filter((entry) => DATALINK_METHODS.includes(entry.method))) {
    assert.deepEqual(Object.keys(call).sort(), ['args', 'at', 'method']);
  }
});

test('datalink pager: long TAF and the 900-character route page to 48 x 10 with nothing lost', async () => {
  const { paginateText, rejoinPages, normaliseText, TEXT_COLUMNS, TEXT_ROWS } = await pageModule('datalink-text.js');
  assert.equal(typeof document, 'undefined');
  assert.deepEqual([TEXT_COLUMNS, TEXT_ROWS], [48, 10]);
  const { host, gaugeDev } = await loadMock();
  gaugeDev.datalinkScenario('long-taf');
  const wx = plain(await host.requestWeather({ target: { kind: 'flight', id: 92 }, icao: 'EGLL' })).result;
  gaugeDev.datalinkScenario('long-route');
  const epoch = plain(await host.getDatalinkState()).thread.epoch;
  const dispatch = plain(await host.getDatalinkThread({ epoch, endSeq: 1 })).result.messages[0].body;
  const route = dispatch.split('\n')[3].slice('ROUTE '.length);
  assert.equal(route.length, 900);
  assert.ok(wx.taf.length > 300 && wx.taf.split('\n').length >= 5);

  const cases = {
    taf: wx.taf,
    wxText: ['METAR', wx.metar, '', 'TAF', wx.taf].join('\n'),
    route,
    dispatch,
    longWord: `${'Q'.repeat(130)} END`,
    messy: 'A\r\nB\rC\tDE   \n\n\n',
    surrogate: `${'x'.repeat(47)}\u{1F6EB}${'y'.repeat(60)}`,
    empty: '',
  };
  for (const [name, input] of Object.entries(cases)) {
    const pages = paginateText(input);
    assert.ok(pages.length >= 1, name);
    for (const page of pages) {
      assert.ok(page.length >= 1 && page.length <= TEXT_ROWS, `${name} rows`);
      for (const line of page) assert.ok(line.text.length <= TEXT_COLUMNS, `${name} width: ${line.text}`);
    }
    assert.equal(rejoinPages(pages), normaliseText(input), `${name} rejoin`);
    const indicators = pages.map((_, i) => `${i + 1}/${pages.length}`);
    assert.deepEqual(indicators, Array.from({ length: pages.length }, (_, i) => `${i + 1}/${pages.length}`));
    if (['wxText', 'route', 'dispatch'].includes(name)) assert.ok(pages.length >= 2, `${name} pages`);
  }
  assert.equal(normaliseText(cases.messy), 'A\nB\nC DE');
  assert.deepEqual(paginateText(''), [[{ text: '', join: '' }]]);
  assert.ok(paginateText(cases.surrogate).flat().every((line) => !/[\uD800-\uDBFF]$/.test(line.text)));
});

test('datalink vocab and session import under Node and hold the frozen CDU strings', async () => {
  const vocab = await pageModule('datalink-vocab.js');
  const { createDatalinkSession } = await pageModule('datalink-session.js');
  assert.equal(typeof createDatalinkSession, 'function');
  assert.equal(typeof document, 'undefined');
  assert.deepEqual(plain(vocab.describeDatalinkState(null)), { id: 'dl.idle', text: 'DATALINK STANDBY', severity: 'idle', hint: '' });
  const unavailable = vocab.describeDatalinkState({ state: 'dl.unavailable' });
  assert.deepEqual([unavailable.text, unavailable.severity, unavailable.hint], ['DATALINK UNAVAILABLE', 'caution', 'SERVER MAY PREDATE DATALINK']);
  const rejected = vocab.describeDatalinkState({ state: 'dl.token-invalid' });
  assert.deepEqual([rejected.text, rejected.hint], ['INGEST TOKEN REJECTED', 'CHECK INGEST TOKEN ON CFG NETWORK']);
  assert.equal(vocab.describeDatalinkState({ state: 'dl.http-error', httpStatus: 502 }).text, 'DATALINK FAULT 502');
  const future = vocab.describeDatalinkState({ state: 'dl.future' });
  assert.deepEqual([future.text, future.severity], ['?? dl.future', 'caution']);
  assert.equal(vocab.errorText({ code: 'no-thread' }), 'NO FLIGHT PLAN');
  assert.equal(vocab.errorText({ code: 'stale-epoch' }), null);
  assert.equal(vocab.errorText({ code: 'host-unsupported' }), 'DATALINK NOT SUPPORTED');
  assert.equal(vocab.errorText({ code: 'no-dispatch-data', httpStatus: 409 }), 'NO DISPATCH DATA');
  assert.equal(vocab.errorText({ code: 'http-error', httpStatus: 500 }), 'DATALINK FAULT 500');
  assert.equal(vocab.errorText({ code: 'something-new' }), 'DATALINK FAULT');
  assert.equal(vocab.formatScope(null), '----');
  assert.equal(vocab.formatScope({ kind: 'none' }), 'NO FLIGHT PLAN');
  assert.equal(vocab.formatScope(FLIGHT), 'FLT 92 LEG 12');
  assert.equal(vocab.formatScope({ kind: 'flight', flightId: 92, plannedLegId: null }), 'FLT 92');
  assert.equal(vocab.formatScope(LEG), 'LEG 12');
  assert.equal(vocab.formatTarget({ kind: 'leg', id: 12 }), 'LEG 12');
  assert.equal(vocab.formatTime('2026-09-16T14:32:07.113Z'), '1432');
  assert.equal(vocab.formatTime('garbage'), '----');
  assert.equal(vocab.formatMessageHeader({ direction: 'uplink', label: null, category: 'wx', sentAt: 'x', body: '' }), 'UP ----Z WX');
  assert.equal(vocab.formatMessagePreview({ body: '\n\n  \nMETAR EGLL' }), '<METAR EGLL');
  assert.equal(vocab.formatMessagePreview({ body: 'Z'.repeat(80) }).length, 48);
});

function sessionHarness(host) {
  let clock = 1_000_000;
  const timeouts = [];
  const intervals = new Set();
  const watches = [];
  const errors = [];
  let shellState = null;
  const envelope = (fn) => Promise.resolve().then(fn).then(
    (result) => (result && typeof result.ok === 'boolean' ? plain(result) : localError('host-error')),
    () => localError('host-error'));
  host.onDatalink((state) => { shellState = plain(state); });
  return {
    watches, errors, intervals,
    fmc: {
      getDatalinkState: () => shellState,
      watchDatalink: (on) => { watches.push(on); return envelope(() => host.watchDatalink(on)); },
      getDatalinkThread: (req) => envelope(() => host.getDatalinkThread(req)),
      setScratchpad: (text, kind) => errors.push([text, kind]),
    },
    options: {
      now: () => clock,
      setInterval: (fn) => { const handle = { fn }; intervals.add(handle); return handle; },
      clearInterval: (handle) => intervals.delete(handle),
      setTimeout: (fn) => { timeouts.push(fn); },
    },
    advance: (ms) => { clock += ms; },
    // Watch calls go out on a microtask; let them land before looking.
    flushTimeouts: async () => {
      while (timeouts.length) timeouts.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    },
    state: async () => plain(await host.getDatalinkState()),
  };
}

test('datalink session: lease follows the pages and the thread loads in windows', async () => {
  const { createDatalinkSession } = await pageModule('datalink-session.js');
  const { host, gaugeDev } = await loadMock();
  const h = sessionHarness(host);
  const session = createDatalinkSession(h.fmc, h.options);

  // Moving between two DATALINK pages keeps one lease and one renew interval.
  session.enterDlPage();
  session.leaveDlPage();
  session.enterDlPage();
  await h.flushTimeouts();
  assert.deepEqual([h.watches, h.intervals.size], [[true], 1]);
  session.leaveDlPage();
  await h.flushTimeouts();
  assert.deepEqual([h.watches, h.intervals.size], [[true, false], 0]);

  session.enterDlPage();
  gaugeDev.datalinkScenario('long-taf');
  session.applyState(await h.state());
  let view = session.threadView();
  assert.deepEqual([view.n, view.m, view.slots[0].kind, view.slots[0].seq], [2, 2, 'loading', 5]);
  await session.loadVisibleThread();
  assert.equal(session.threadView().slots[0].kind, 'message');
  assert.equal(session.stepThreadPage(1), true);
  view = session.threadView();
  assert.deepEqual([view.n, view.slots.map((slot) => slot.kind).join()], [1, 'loading,message,message,message,message']);
  await session.loadVisibleThread();
  assert.ok(session.threadView().slots.every((slot) => slot.kind === 'message'));
  const endSeqs = gaugeDev.calls.filter((call) => call.method === 'getDatalinkThread').map((call) => call.args[0].endSeq);
  // The first window of five already brought seqs 1 to 4; only seq 0 was left.
  assert.deepEqual(plain(endSeqs), [6, 1]);

  // The host moved to a new epoch before the page heard of it: the answer is
  // stale, the cache goes, and nothing is put on the scratchpad.
  const staleEpoch = (await h.state()).thread.epoch;
  gaugeDev.datalinkScenario('leg');
  session.applyState({ ...(await h.state()), thread: null });
  assert.equal(session.threadView().cached, false);
  session.applyState({ ...(await h.state()), thread: { epoch: staleEpoch, total: 6, firstSeq: 0, newestId: 19, droppedRows: 0 } });
  assert.equal(session.threadView().cached, true);
  await session.loadVisibleThread();
  assert.deepEqual([session.threadView().cached, h.errors], [false, []]);

  // After a sidecar restart the first state is not-watching: re-take the lease,
  // at most once in five seconds, and never for a sidecar that cannot serve it.
  const idle = { ...(await h.state()), state: 'dl.idle', watching: false, thread: null };
  const watchesBefore = h.watches.length;
  h.advance(6000);
  session.applyState(idle);
  session.applyState(idle);
  h.advance(6000);
  session.applyState({ ...idle, state: 'dl.sidecar-outdated' });
  await h.flushTimeouts();
  assert.deepEqual(h.watches.slice(watchesBefore), [true]);

  session.leaveDlPage();
  await h.flushTimeouts();
  assert.equal(h.intervals.size, 0);
  assert.equal(gaugeDev.calls.some((call) => WRITE_METHODS.includes(call.method)), false);
});

function fakeDocument() {
  class Element {
    constructor() { this.children = []; this.attributes = {}; this.className = ''; this.ownText = ''; }
    get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : this.ownText; }
    set textContent(value) { this.children = []; this.ownText = String(value); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; }
    get firstChild() { return this.children[0] || null; }
    get childElementCount() { return this.children.length; }
  }
  return { createElement: () => new Element() };
}

/**
 * Every DATALINK page, registered the way ui/src/pages/index.js does, behind
 * the parts of the shell they use (same scratchpad and page-change rules as
 * app.js) and wired to the mock host. Leaving to MENU afterwards releases the
 * lease, so a failing test cannot leave the renew interval holding Node open.
 *
 * `overrides.fpln` also registers the FPLN pages; `overrides.via` routes every
 * host call through another object (an adopted bridge) instead of the mock.
 */
async function mountDatalinkPages(t, tag, overrides = {}) {
  globalThis.document = fakeDocument();
  const { register } = await import(new URL(`../../ui/src/pages/datalink-pages.js?${tag}`, import.meta.url));
  const write = await import(new URL(`../../ui/src/pages/datalink-write-pages.js?${tag}`, import.meta.url));
  const { host, gaugeDev } = overrides.mock || await loadMock();
  const api = overrides.via || host;
  const pages = new Map();
  const shell = { id: null, view: null, scratchpad: null, entry: '', number: '', datalink: null, title: '' };
  const run = (fn) => Promise.resolve().then(fn).then(
    (result) => (result && typeof result.ok === 'boolean' ? plain(result) : localError('host-error')),
    () => localError('host-error'));
  const fmc = {
    registerPage: (page) => pages.set(page.id, page),
    showPage: (id) => {
      const previous = pages.get(shell.id);
      if (previous && previous.dispose) previous.dispose();
      const page = pages.get(id);
      if (shell.id !== id) fmc.setScratchpad('');
      shell.id = id;
      shell.view = page ? page.render({}) : null;
      shell.title = page ? page.title : '';
      shell.number = page && page.m > 1 ? `${page.n}/${page.m}` : '';
      return true;
    },
    setScratchpad: (value, kind = 'entry') => {
      if (kind === 'entry') { shell.entry = String(value ?? ''); shell.scratchpad = null; }
      else shell.scratchpad = [value, kind];
    },
    getScratchpad: () => (shell.scratchpad ? '' : shell.entry),
    hasScratchpadError: () => Boolean(shell.scratchpad && shell.scratchpad[1] === 'error'),
    getDatalinkState: () => shell.datalink,
    watchDatalink: (on) => run(() => api.watchDatalink(on)),
    refreshDatalink: () => run(() => api.refreshDatalink()),
    getDatalinkThread: (req) => run(() => api.getDatalinkThread(req)),
    getCannedMessages: () => run(() => api.getCannedMessages()),
    sendCannedMessage: (req) => run(() => (overrides.sendCannedMessage || api.sendCannedMessage)(req)),
    requestWeather: (req) => run(() => api.requestWeather(req)),
    requestLoadsheet: (req) => run(() => api.requestLoadsheet(req)),
    setPageNumber: (n, m) => { shell.number = m > 1 ? `${n}/${m}` : ''; },
    getSimbriefSettings: () => run(() => api.getSimbriefSettings()),
    prefileSimbrief: () => run(() => (overrides.prefileSimbrief || api.prefileSimbrief)()),
    clearPrefiledLeg: () => run(() => (overrides.clearPrefiledLeg || api.clearPrefiledLeg)()),
  };
  host.onDatalink((state) => {
    shell.datalink = plain(state);
    const page = pages.get(shell.id);
    if (page && page.onDatalink) page.onDatalink(shell.datalink);
  });
  write.register(fmc, register(fmc));
  if (overrides.fpln) {
    (await import(new URL(`../../ui/src/pages/fpln-pages.js?${tag}`, import.meta.url))).register(fmc);
  }
  t.after(async () => {
    fmc.showPage('MENU');
    await settle();
    delete globalThis.document;
  });
  const lsk = async (id, key) => {
    const handled = pages.get(id).onLsk(key, {});
    await settle();
    return handled;
  };
  return {
    host, gaugeDev, pages, shell, fmc, lsk,
    rows: () => shell.view.children.map((line) => line.children.map((cell) => cell.textContent)),
    writes: () => plain(gaugeDev.calls).filter((call) => WRITE_METHODS.includes(call.method)),
    type: (text) => fmc.setScratchpad(text),
    scenario: async (name) => { shell.datalink = plain(gaugeDev.datalinkScenario(name)); await settle(); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('datalink pages: index, thread and paged message render from the mock without any write call', async (t) => {
  const ui = await mountDatalinkPages(t, 'reading');
  const { pages, shell, fmc, gaugeDev, host, rows } = ui;
  assert.deepEqual([...pages.values()].map((page) => [page.id, page.title]), [
    ['DL-INDEX', 'ACARS DATALINK'], ['DL-THREAD', 'ACARS MSGS'], ['DL-MSG', 'ACARS MSG'], ['DL-CANNED', 'DOWNLINK'],
    ['DL-CONFIRM', 'CONFIRM SEND'], ['DL-WX', 'WX REQUEST'], ['DL-WX-RESULT', 'WX'], ['DL-LOADSHEET', 'LOADSHEET'],
  ]);

  await ui.scenario('pre-upgrade');
  fmc.showPage('DL-INDEX');
  await settle();
  assert.equal(rows().length, 12);
  assert.deepEqual([rows()[0][0], rows()[1][0], rows()[2][0], rows()[3][0], rows()[10][0]],
    ['SCOPE', '----', 'DATALINK', 'DATALINK UNAVAILABLE', 'SERVER MAY PREDATE DATALINK']);
  assert.deepEqual([rows()[5], rows()[7], rows()[11]],
    [['<MESSAGES', 'WX REQUEST>'], ['<DOWNLINK', 'LOADSHEET>'], ['<INDEX', 'REFRESH>']]);
  assert.equal(await ui.lsk('DL-INDEX', 'R6'), true);
  assert.equal(shell.scratchpad, null);

  gaugeDev.datalinkScenario('invalid-token');
  await settle();
  assert.deepEqual([rows()[3][0], rows()[10][0]], ['INGEST TOKEN REJECTED', 'CHECK INGEST TOKEN ON CFG NETWORK']);
  await ui.lsk('DL-INDEX', 'R6');
  assert.deepEqual(shell.scratchpad, ['INGEST TOKEN REJECTED', 'error']);

  gaugeDev.datalinkScenario('no-flight-plan');
  await settle();
  assert.equal(rows()[1][0], 'NO FLIGHT PLAN');
  for (const key of ['L3', 'L4', 'R3', 'R4']) {
    shell.scratchpad = null;
    assert.equal(await ui.lsk('DL-INDEX', key), true, key);
    assert.deepEqual([shell.scratchpad, shell.id], [['NO FLIGHT PLAN', 'error'], 'DL-INDEX'], key);
  }

  gaugeDev.datalinkScenario('long-route');
  await settle();
  assert.deepEqual([rows()[1][0], rows()[3][0], rows()[5][0]], ['LEG 12', 'DATALINK ONLINE', '<MESSAGES']);
  assert.match(rows()[0][1], /^UPD \d{4}Z$/);
  await ui.lsk('DL-INDEX', 'L3');
  assert.equal(shell.id, 'DL-THREAD');
  assert.deepEqual(rows().slice(0, 2), [['UP 1220Z DISPATCH RELEASE'], ['<DISPATCH RELEASE']]);
  assert.deepEqual(rows()[11], ['<RETURN', 'REFRESH>']);
  assert.equal(pages.get('DL-THREAD').onLsk('L5'), false);
  assert.equal(pages.get('DL-THREAD').onPageKey(1), true);
  assert.equal(await ui.lsk('DL-THREAD', 'L1'), true);
  assert.equal(shell.id, 'DL-MSG');
  assert.equal(shell.number, '1/3');
  assert.ok(rows().slice(1, 11).every((line) => line[0].length <= 48));
  assert.equal(pages.get('DL-MSG').onPageKey(-1), true);
  assert.equal(shell.number, '3/3');
  pages.get('DL-MSG').onLsk('L6');
  assert.equal(shell.id, 'DL-THREAD');

  gaugeDev.datalinkScenario('flight');
  await settle();
  assert.equal(rows().filter((line) => line[0] === 'LOADING').length, 0);
  assert.match(rows()[6][0], /^DN 1432Z /);
  fmc.showPage('MENU');
  await settle();
  assert.equal(plain(await host.getDatalinkState()).watching, false);
  assert.deepEqual(ui.writes(), []);
});

test('datalink downlink: the list is the host result, one press never sends, SEND sends once', async (t) => {
  const ui = await mountDatalinkPages(t, 'canned');
  const { shell, fmc, host, rows } = ui;
  const listed = async () => plain(await host.getCannedMessages()).result.messages.map((entry) => cutLabel(entry.label));
  const cutLabel = (text) => `<${text}`.slice(0, 48);

  for (const [scenario, count] of [['flight', 3], ['canned-four', 4]]) {
    await ui.scenario(scenario);
    fmc.showPage('DL-INDEX');
    await ui.lsk('DL-INDEX', 'L4');
    assert.equal(shell.id, 'DL-CANNED');
    const shown = rows().slice(0, 10).filter((_, i) => i % 2 === 1).map((line) => line[0]).filter(Boolean);
    assert.deepEqual(shown, await listed(), scenario);
    assert.equal(shown.length, count);
    assert.deepEqual(rows()[11], ['<RETURN', '']);
  }
  // The fourth entry exists only in the host's answer; selecting it still works.
  assert.equal(await ui.lsk('DL-CANNED', 'L5'), false);
  const fourth = plain(await host.getCannedMessages()).result.messages[3];

  ui.type('FREE TEXT TO ATC');
  assert.equal(await ui.lsk('DL-CANNED', 'L4'), true);
  assert.equal(shell.id, 'DL-CONFIRM');
  assert.deepEqual(ui.writes(), [], 'selecting is one press and sends nothing');
  assert.deepEqual(rows().slice(0, 4).map((line) => line[0]), ['DOWNLINK', fourth.label, 'TO', 'FLT 92']);
  assert.deepEqual(rows()[11], ['<CANCEL', 'SEND*']);

  const refreshesBefore = ui.gaugeDev.calls.filter((call) => call.method === 'refreshDatalink').length;
  assert.equal(ui.pages.get('DL-CONFIRM').onLsk('R6', {}), true);
  assert.deepEqual(rows()[11], ['<CANCEL', 'SENDING']);
  assert.equal(ui.pages.get('DL-CONFIRM').onLsk('R6', {}), true);
  await settle();
  const writes = ui.writes();
  assert.equal(writes.length, 1, 'SEND pressed twice while sending still sends once');
  assert.deepEqual(writes[0].args, [{ target: { kind: 'flight', id: 92 }, cannedId: fourth.id }]);
  assert.equal(JSON.stringify(writes).includes('FREE TEXT'), false);
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-THREAD', ['DOWNLINK SENT', 'advisory']]);
  await settle();
  // The thread shows the downlink from the host's next state, without a REFRESH.
  assert.deepEqual(rows()[1], [`<${fourth.label}`]);
  assert.match(rows()[0][0], /^DN \d{4}Z /);
  assert.equal(ui.gaugeDev.calls.filter((call) => call.method === 'refreshDatalink').length, refreshesBefore);

  // CANCEL returns to the list and sends nothing; CONFIRM with nothing pending refuses SEND.
  fmc.showPage('DL-CANNED');
  await settle();
  await ui.lsk('DL-CANNED', 'L1');
  await ui.lsk('DL-CONFIRM', 'L6');
  assert.equal(shell.id, 'DL-CANNED');
  fmc.showPage('DL-CONFIRM');
  assert.deepEqual([rows()[1][0], rows()[11]], ['NO PENDING REQUEST', ['<RETURN', '']]);
  assert.equal(ui.pages.get('DL-CONFIRM').onLsk('R6', {}), false);
  assert.equal(ui.writes().length, 1);
});

test('datalink write errors show the error text for their code on the scratchpad', async (t) => {
  const refused = { ok: false, error: { code: 'not-a-canned-message', httpStatus: 400, serverCode: null } };
  const ui = await mountDatalinkPages(t, 'errors', { sendCannedMessage: async () => refused });
  const { shell, fmc } = ui;
  await ui.scenario('flight');
  fmc.showPage('DL-CANNED');
  await settle();
  await ui.lsk('DL-CANNED', 'L1');
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-CANNED', ['NOT A CANNED MESSAGE', 'error']]);

  for (const [scenario, text] of [['pre-upgrade', 'DATALINK UNAVAILABLE'], ['invalid-token', 'INGEST TOKEN REJECTED'], ['unreachable', 'DATALINK NO COMM']]) {
    // The canned list itself fails in a fault state, with the same text.
    fmc.showPage('DL-INDEX');
    await ui.scenario(scenario);
    fmc.showPage('DL-CANNED');
    await settle();
    assert.deepEqual(shell.scratchpad, [text, 'error'], `list ${scenario}`);
    // A WX request selected while healthy and sent after the fault.
    await ui.scenario('flight');
    fmc.showPage('DL-WX');
    ui.type('EGLL');
    await ui.lsk('DL-WX', 'L1');
    await ui.lsk('DL-WX', 'R6');
    assert.equal(shell.id, 'DL-CONFIRM');
    ui.gaugeDev.datalinkScenario(scenario);
    await settle();
    await ui.lsk('DL-CONFIRM', 'R6');
    assert.deepEqual([shell.id, shell.scratchpad], ['DL-WX', [text, 'error']], `send ${scenario}`);
  }
});

test('datalink WX REQUEST: only a validated ICAO is sent, and METAR/TAF page through the pager', async (t) => {
  const ui = await mountDatalinkPages(t, 'wx');
  const { shell, fmc, rows, pages } = ui;
  await ui.scenario('long-taf');
  fmc.showPage('DL-INDEX');
  await ui.lsk('DL-INDEX', 'R3');
  assert.equal(shell.id, 'DL-WX');
  assert.deepEqual([rows()[0][0], rows()[1][0], rows()[11]], ['AIRPORT ICAO', '□□□□', ['<RETURN', '']]);
  assert.equal(await ui.lsk('DL-WX', 'R6'), false);
  for (const bad of ['', 'EGL', 'EGLLX', '1GLL', 'EG-L']) {
    ui.type(bad);
    await ui.lsk('DL-WX', 'L1');
    assert.deepEqual(shell.scratchpad, ['INVALID ENTRY', 'error'], bad);
    // With the error still showing, another L1 changes nothing.
    await ui.lsk('DL-WX', 'L1');
    assert.equal(rows()[1][0], '□□□□');
    shell.scratchpad = null;
  }
  ui.type(' egll ');
  await ui.lsk('DL-WX', 'L1');
  assert.deepEqual([rows()[1][0], rows()[11], shell.entry], ['EGLL', ['<RETURN', 'REQUEST>'], '']);
  await ui.lsk('DL-WX', 'R6');
  assert.deepEqual(rows().slice(0, 4).map((line) => line[0]), ['WX REQUEST', 'EGLL', 'TO', 'FLT 92']);
  assert.deepEqual(ui.writes(), []);
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual(ui.writes().map((call) => call.args), [[{ target: { kind: 'flight', id: 92 }, icao: 'EGLL' }]]);
  assert.deepEqual([shell.id, shell.title, shell.number], ['DL-WX-RESULT', 'WX EGLL', '1/2']);
  assert.deepEqual([rows()[1][0], rows()[2][0]], ['METAR', 'METAR EGLL 161250Z 24012KT 9999 FEW030 18/10']);
  assert.ok(rows().slice(1, 11).every((line) => line[0].length <= 48));
  pages.get('DL-WX-RESULT').onPageKey(1, {});
  assert.equal(shell.number, '2/2');
  pages.get('DL-WX-RESULT').onPageKey(1, {});
  assert.equal(shell.number, '1/2');
  await ui.lsk('DL-WX-RESULT', 'L6');
  assert.equal(shell.id, 'DL-WX');

  await ui.scenario('wx-unavailable');
  await ui.lsk('DL-WX', 'R6');
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual([shell.id, rows()[1][0], shell.number], ['DL-WX-RESULT', 'NO WEATHER AVAILABLE', '']);
});

test('datalink LOADSHEET: confirm, illustrative marker, dashes for missing figures, 409 and flight scope', async (t) => {
  const ui = await mountDatalinkPages(t, 'loadsheet');
  const { shell, fmc, rows } = ui;
  await ui.scenario('leg');
  fmc.showPage('DL-INDEX');
  await ui.lsk('DL-INDEX', 'R4');
  assert.deepEqual([shell.id, rows()[1][0], rows()[11]], ['DL-LOADSHEET', 'NO LOADSHEET REQUESTED', ['<RETURN', 'REQUEST>']]);
  await ui.lsk('DL-LOADSHEET', 'R6');
  assert.deepEqual(rows().slice(0, 4).map((line) => line[0]), ['LOADSHEET REQUEST', 'LEG 12', 'TO', 'LEG 12']);
  assert.deepEqual(ui.writes(), []);
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-LOADSHEET', ['LOADSHEET RECEIVED', 'advisory']]);
  const first = rows();
  assert.deepEqual(first, [
    ['ILLUSTRATIVE ONLY', 'LEG 12'], ['BLOCK FUEL', '6200 KG'], ['TAXI FUEL', '200 KG'], ['TAKEOFF FUEL', '6000 KG'],
    ['TRIP FUEL', '3100 KG'], ['PAYLOAD', '13850 KG'], ['ZFW', '56350 KG'], ['MAX ZFW', '62500 KG'],
    ['DOW', '42500 KG'], ['TOW', '-----'], ['SOURCE PLD SIMBRIEF ZFW SIMBRIEF'], ['<RETURN', 'REQUEST>'],
  ]);
  await ui.lsk('DL-LOADSHEET', 'R6');
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual([shell.scratchpad, rows()], [['LOADSHEET ON FILE', 'advisory'], first]);
  assert.deepEqual(ui.writes().map((call) => call.args), [[{ plannedLegId: 12 }], [{ plannedLegId: 12 }]]);

  // Flight scope with a linked leg: offered for that leg.
  fmc.showPage('DL-INDEX');
  await ui.scenario('flight');
  await ui.lsk('DL-INDEX', 'R4');
  assert.deepEqual([shell.id, rows()[1][0]], ['DL-LOADSHEET', 'BLOCK FUEL']);
  // Flight scope without one: refused on DL-INDEX, and on the page itself.
  const unlinked = { ...shell.datalink, scope: { kind: 'flight', flightId: 92, plannedLegId: null } };
  ui.pages.get('DL-LOADSHEET').onDatalink(unlinked);
  shell.datalink = unlinked;
  assert.deepEqual([rows()[1][0], rows()[11]], ['NO LINKED LEG', ['<RETURN', '']]);
  assert.equal(await ui.lsk('DL-LOADSHEET', 'R6'), false);
  fmc.showPage('DL-INDEX');
  await ui.lsk('DL-INDEX', 'R4');
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-INDEX', ['NO LINKED LEG', 'error']]);
  assert.equal(ui.writes().length, 2);

  await ui.scenario('no-dispatch');
  await ui.lsk('DL-INDEX', 'R4');
  await ui.lsk('DL-LOADSHEET', 'R6');
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-LOADSHEET', ['NO DISPATCH DATA', 'error']]);
});

test('datalink session confirm flow: selection sends nothing, confirm sends exactly once', async () => {
  const { createDatalinkSession } = await pageModule('datalink-session.js');
  const writes = [];
  let answer;
  const fmc = {
    getDatalinkState: () => null,
    watchDatalink: async () => ({ ok: true, result: { watching: true, leaseMs: 65000 } }),
    sendCannedMessage: (req) => { writes.push(['canned', req]); return new Promise((resolve) => { answer = resolve; }); },
    requestWeather: async (req) => { writes.push(['wx', req]); return { ok: true, result: {} }; },
    requestLoadsheet: async () => { throw new Error('transport'); },
    setScratchpad: () => {},
  };
  const session = createDatalinkSession(fmc);
  assert.deepEqual(await session.sendPending(), { status: 'none' });
  assert.equal(session.selectAction({ kind: 'free-text', body: 'HELLO' }), false);
  assert.equal(session.selectAction({ kind: 'canned', target: { kind: 'leg', id: 12 }, cannedId: 'abc', label: 'ABC', origin: 'DL-CANNED' }), true);
  assert.deepEqual(writes, []);
  const first = session.sendPending();
  assert.deepEqual([await session.sendPending(), session.isSending()], [{ status: 'busy' }, true]);
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(session.selectAction({ kind: 'wx', target: { kind: 'leg', id: 12 }, icao: 'EGLL' }), false, 'no second action while one is out');
  assert.equal(session.cancelAction(), false);
  answer({ ok: true, result: { sent: true, httpStatus: 201 } });
  const outcome = await first;
  assert.deepEqual([outcome.status, outcome.response.ok, session.pendingAction(), writes.length], ['done', true, null, 1]);
  session.selectAction({ kind: 'loadsheet', plannedLegId: 12, target: { kind: 'leg', id: 12 } });
  assert.deepEqual((await session.sendPending()).response, localError('host-error'));
  session.selectAction({ kind: 'wx', target: { kind: 'leg', id: 12 }, icao: 'EGLL' });
  assert.equal(session.cancelAction(), true);
  assert.deepEqual([await session.sendPending(), writes.length], [{ status: 'none' }, 1]);
});

test('datalink write vocab: ICAO validation, load sheet leg rules, weather text and figures', async () => {
  const vocab = await pageModule('datalink-vocab.js');
  for (const good of ['egll', ' EGLL ', 'K0S9']) assert.equal(vocab.validateIcao(good).ok, true, good);
  assert.deepEqual(plain(vocab.validateIcao(' egll ')), { ok: true, icao: 'EGLL' });
  for (const bad of ['', 'EGL', 'EGLLX', '1GLL', 'EG-L', null, undefined]) assert.deepEqual(plain(vocab.validateIcao(bad)), { ok: false }, String(bad));
  assert.deepEqual(plain(vocab.loadsheetLeg(LEG)), { ok: true, plannedLegId: 12 });
  assert.deepEqual(plain(vocab.loadsheetLeg(FLIGHT)), { ok: true, plannedLegId: 12 });
  assert.deepEqual(plain(vocab.loadsheetLeg({ ...FLIGHT, plannedLegId: null })), { ok: false, text: 'NO LINKED LEG' });
  assert.deepEqual(plain(vocab.loadsheetLeg({ kind: 'none' })), { ok: false, text: 'NO FLIGHT PLAN' });
  assert.deepEqual(plain(vocab.loadsheetLeg(null)), { ok: false, text: 'NO FLIGHT PLAN' });
  assert.deepEqual(plain(vocab.writeTarget(FLIGHT)), { kind: 'flight', id: 92 });
  assert.deepEqual(plain(vocab.writeTarget(LEG)), { kind: 'leg', id: 12 });
  assert.equal(vocab.writeTarget({ kind: 'none' }), null);
  assert.equal(vocab.weatherText({ icao: 'EGLL', available: false, metar: null, taf: null, fetchedAt: null }), 'NO WEATHER AVAILABLE');
  assert.equal(vocab.weatherText({ icao: 'EGLL', available: true, metar: null, taf: null, fetchedAt: null }), 'NO WEATHER AVAILABLE');
  assert.equal(vocab.weatherText({ available: true, metar: 'M', taf: null }), 'METAR\nM\n\nTAF\nNOT AVAILABLE');
  assert.deepEqual([vocab.formatSheetValue(null, 'kg'), vocab.formatSheetValue(0, 'kg'), vocab.formatSheetValue(6200.4, 'kg'), vocab.formatSheetValue(5, null)],
    ['-----', '0 KG', '6200 KG', '5']);
  assert.equal(vocab.formatSheetSource({ payloadSource: null, zfwSource: 'simbrief' }), 'SOURCE PLD ----- ZFW SIMBRIEF');
  assert.equal(vocab.ILLUSTRATIVE_MARKER, 'ILLUSTRATIVE ONLY');
});

test('datalink host contract: Tauri names, stub, and adoption with per-method fallbacks', async () => {
  const importBridge = async (window, tag) => {
    globalThis.window = window;
    try {
      return (await import(new URL(`../../ui/src/bridge.js?${tag}`, import.meta.url))).default;
    } finally {
      delete globalThis.window;
    }
  };
  const invoked = [];
  const listened = [];
  const tauri = await importBridge({
    __TAURI__: {
      core: { invoke: async (cmd, args) => { invoked.push([cmd, args]); return { ok: true, result: {} }; } },
      event: { listen: async (name) => { listened.push(name); return () => {}; } },
    },
  }, 'tauri');
  for (const name of DATALINK_METHODS) assert.equal(typeof tauri[name], 'function', name);
  const target = { kind: 'leg', id: 12 };
  await tauri.getDatalinkState();
  tauri.onDatalink(() => {});
  await tauri.watchDatalink('yes');
  await tauri.refreshDatalink();
  await tauri.getDatalinkThread({ epoch: 3, endSeq: 7 });
  await tauri.getCannedMessages();
  await tauri.sendCannedMessage({ target, cannedId: 'abc' });
  await tauri.requestWeather({ target, icao: 'EGLL' });
  await tauri.requestLoadsheet({ plannedLegId: 12 });
  assert.deepEqual(invoked, [
    ['datalink_state', undefined], ['datalink_watch', { on: false }], ['datalink_refresh', undefined],
    ['datalink_thread', { epoch: 3, endSeq: 7 }], ['datalink_canned', undefined],
    ['datalink_send_canned', { targetKind: 'leg', targetId: 12, cannedId: 'abc' }],
    ['datalink_wx', { targetKind: 'leg', targetId: 12, icao: 'EGLL' }],
    ['datalink_loadsheet', { plannedLegId: 12 }],
  ]);
  assert.deepEqual(listened, ['sidecar:datalink']);
  for (const call of [
    () => tauri.getDatalinkThread(), () => tauri.getDatalinkThread({ epoch: -1, endSeq: 0 }),
    () => tauri.sendCannedMessage({ cannedId: 'abc' }), () => tauri.requestWeather({ target: { kind: 'leg', id: '12' }, icao: 'EGLL' }),
    () => tauri.requestLoadsheet(null),
  ]) assert.deepEqual(await call(), localError('bad-request'));
  assert.equal(invoked.length, 8);

  const legacy = { hostLabel: 'LEGACY' };
  for (const name of ['getConfig', 'setConfig', 'getConfigPath', 'startUplink', 'stopUplink', 'restartSidecar', 'getStatus', 'onStatus', 'onLog', 'onExit']) {
    legacy[name] = async () => null;
  }
  const adopted = await importBridge({ __FMC_HOST__: legacy }, 'legacy');
  assert.equal(adopted.hostLabel, 'LEGACY');
  assert.equal(await adopted.getDatalinkState(), null);
  assert.equal(typeof adopted.onDatalink(() => {}), 'function');
  for (const name of DATALINK_METHODS.slice(2)) assert.deepEqual(await adopted[name]({}), localError('host-unsupported'), name);

  const { host } = await loadMock();
  const adoptedMock = await importBridge({ __FMC_HOST__: host }, 'mock');
  assert.equal(adoptedMock.hostLabel, 'GAUGE MOCK');
  assert.equal(plain(await adoptedMock.getDatalinkState()).state, 'dl.ok');

  const stubWindow = {};
  const stubBridge = await importBridge(stubWindow, 'stub');
  const stub = stubWindow.__FMC_STUB__;
  assert.equal(stub.datalinkState, null);
  assert.deepEqual(await stubBridge.refreshDatalink(), localError('host-unsupported'));
  stub.datalinkResults.refreshDatalink = { ok: true, result: { accepted: true, coalesced: true } };
  assert.deepEqual(await stubBridge.refreshDatalink(), { ok: true, result: { accepted: true, coalesced: true } });
  const heard = [];
  stubBridge.onDatalink((state) => heard.push(state));
  stub.emitDatalink({ type: 'datalink-state', state: 'dl.ok' });
  assert.deepEqual([heard.length, (await stubBridge.getDatalinkState()).state], [1, 'dl.ok']);
  await stubBridge.requestWeather({ target, icao: 'EGLL' });
  assert.deepEqual(stub.calls.at(-1).args, [{ target, icao: 'EGLL' }]);
});

test('datalink token sentinel never reaches a result, an event or a recorded call', async () => {
  const { host, gaugeDev } = await loadMock();
  const seen = [];
  host.onDatalink((state) => seen.push(plain(state)));
  await host.setConfig({ ingestToken: SENTINEL });
  const drive = async () => {
    const target = { kind: 'flight', id: 92 };
    seen.push(plain(await host.getDatalinkState()));
    seen.push(plain(await host.watchDatalink(true)));
    seen.push(plain(await host.refreshDatalink()));
    const state = plain(await host.getDatalinkState());
    seen.push(plain(await host.getDatalinkThread(state.thread
      ? { epoch: state.thread.epoch, endSeq: state.thread.total } : { epoch: 1, endSeq: 0 })));
    const canned = plain(await host.getCannedMessages());
    seen.push(canned);
    seen.push(plain(await host.sendCannedMessage({ target, cannedId: canned.ok ? canned.result.messages[0].id : 'x' })));
    seen.push(plain(await host.requestWeather({ target, icao: 'EGLL' })));
    seen.push(plain(await host.requestLoadsheet({ plannedLegId: 12 })));
    seen.push(plain(await host.watchDatalink(false)));
  };
  for (const scenario of DATALINK_SCENARIOS) {
    seen.push(plain(gaugeDev.datalinkScenario(scenario)));
    await drive();
    if (scenario === 'invalid-token') {
      await host.setConfig({ ingestToken: SENTINEL });
      await drive();
    }
  }
  assert.ok(seen.length > DATALINK_SCENARIOS.length * 9);
  assert.equal(JSON.stringify({ seen, calls: gaugeDev.calls }).includes(SENTINEL), false);

  const stubWindow = {};
  globalThis.window = stubWindow;
  let stubBridge;
  try {
    stubBridge = (await import(new URL('../../ui/src/bridge.js?sentinel', import.meta.url))).default;
  } finally {
    delete globalThis.window;
  }
  const stub = stubWindow.__FMC_STUB__;
  await stubBridge.setConfig({ ingestToken: SENTINEL, trafficRadiusM: 45000 });
  stub.datalinkResults.sendCannedMessage = { ok: true, result: { sent: true, httpStatus: 201 } };
  stub.datalinkResults.requestLoadsheet = { ok: false, error: { code: 'no-dispatch-data', httpStatus: 409, serverCode: null } };
  const target = { kind: 'leg', id: 1 };
  const results = [
    await stubBridge.getDatalinkState(), typeof stubBridge.onDatalink(() => {}), await stubBridge.watchDatalink(true),
    await stubBridge.refreshDatalink(), await stubBridge.getDatalinkThread({ epoch: 1, endSeq: 0 }),
    await stubBridge.getCannedMessages(), await stubBridge.sendCannedMessage({ target, cannedId: 'abc' }),
    await stubBridge.requestWeather({ target, icao: 'EGLL' }), await stubBridge.requestLoadsheet({ plannedLegId: 1 }),
  ];
  const datalinkCalls = stub.calls.filter((call) => DATALINK_METHODS.includes(call.method));
  assert.equal(datalinkCalls.length, DATALINK_METHODS.length);
  // Every recorded call, not only the datalink ones: the config patch keeps a
  // mask where the token was, so a harness can still see one was sent.
  assert.equal(JSON.stringify({ results, calls: stub.calls, config: stub.config }).includes(SENTINEL), false);
  assert.equal(stub.calls.find((call) => call.method === 'setConfig').args[0].ingestToken, '••••••••');
});

test('datalink token sentinel stays out of every write made through the pages', async (t) => {
  const ui = await mountDatalinkPages(t, 'sentinel');
  const { shell, fmc, host, rows } = ui;
  await host.setConfig({ ingestToken: SENTINEL });
  const screens = [];
  const look = () => screens.push(shell.title, rows(), shell.scratchpad, shell.entry);
  for (const scenario of DATALINK_SCENARIOS) {
    fmc.showPage('DL-INDEX');
    await ui.scenario(scenario);
    look();
    fmc.showPage('DL-CANNED');
    await settle();
    look();
    await ui.lsk('DL-CANNED', 'L1');
    await ui.lsk('DL-CONFIRM', 'R6');
    look();
    fmc.showPage('DL-WX');
    ui.type('EGLL');
    await ui.lsk('DL-WX', 'L1');
    await ui.lsk('DL-WX', 'R6');
    await ui.lsk('DL-CONFIRM', 'R6');
    look();
    fmc.showPage('DL-INDEX');
    await ui.lsk('DL-INDEX', 'R4');
    await ui.lsk('DL-LOADSHEET', 'R6');
    await ui.lsk('DL-CONFIRM', 'R6');
    look();
    if (scenario === 'invalid-token') await host.setConfig({ ingestToken: SENTINEL });
  }
  const writes = ui.writes();
  assert.ok(['sendCannedMessage', 'requestWeather', 'requestLoadsheet'].every((name) => writes.some((call) => call.method === name)));
  assert.equal(JSON.stringify({ screens, calls: ui.gaugeDev.calls }).includes(SENTINEL), false);
});

// ── SimBrief prefile (FPLN) ──────────────────────────────────────────────────

const SIMBRIEF_METHODS = ['getSimbriefSettings', 'prefileSimbrief', 'clearPrefiledLeg'];
const SIMBRIEF_SENTINEL = 'SENTINEL-SIMBRIEF-TOKEN-0000';
const SAMPLE_LABEL = 'KJFK → EGLL (BAW178)';
const LONG_LABEL = 'SBGR → LFPG (TAP084 São Paulo–Paris Ext)';
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (code, httpStatus = null, serverCode = null) => ({ ok: false, error: { code, httpStatus, serverCode } });
const configuredOk = { ok: true, result: { configured: true } };
const prefileOk = (status, plannedLegId, label, warningCount) => (
  { ok: true, result: { status, plannedLegId, label, warningCount, httpStatus: status === 'imported' ? 201 : 200 } });
const both = (...args) => [fail(...args), fail(...args)];
const all = (code) => [fail(code), fail(code), fail(code)];

/** Scenario → [settings, prefile, clear] answers; a missing clear is the normal held-leg clear. */
const SIMBRIEF_SCENARIOS = {
  configured: [configuredOk, prefileOk('imported', 4812, SAMPLE_LABEL, 0)],
  'not-configured': [{ ok: true, result: { configured: false } }, fail('simbrief-no-user-id', 400, 'NO_USER_ID')],
  duplicate: [configuredOk, prefileOk('duplicate', 4812, SAMPLE_LABEL, 0)],
  'long-label': [configuredOk, prefileOk('imported', 4813, LONG_LABEL, 2)],
  prefiled: [configuredOk, prefileOk('duplicate', 4812, SAMPLE_LABEL, 0)],
  'no-user-id': [configuredOk, fail('simbrief-no-user-id', 400, 'NO_USER_ID')],
  'unknown-user': [configuredOk, fail('simbrief-unknown-user', 400, 'UNKNOWN_USER')],
  'no-plan': [configuredOk, fail('simbrief-no-plan', 404, 'NO_PLAN')],
  'simbrief-timeout': [configuredOk, fail('simbrief-timeout', 504, 'TIMEOUT')],
  network: [configuredOk, fail('simbrief-network', 502, 'NETWORK')],
  'bad-status': [configuredOk, fail('simbrief-bad-status', 502, 'BAD_STATUS')],
  'bad-body': [configuredOk, fail('simbrief-bad-body', 502, 'BAD_BODY')],
  'db-error': [configuredOk, fail('simbrief-db-error', 500, 'DB_ERROR')],
  'unknown-code': [configuredOk, fail('http-error', 409, 'SOMETHING_NEW')],
  'invalid-token': both('token-invalid', 401, 'INVALID_INGEST_TOKEN'),
  'token-missing': both('token-missing', 401),
  unavailable: both('simbrief-unavailable', 401),
  rejected: both('rejected', 403),
  'bad-response': [fail('bad-response', 200), fail('bad-response', 201)],
  'tls-error': both('tls-error'),
  unreachable: both('unreachable'),
  'client-timeout': both('timeout'),
  'relay-timeout': both('shell-timeout'),
  'no-config': both('no-config'),
  'in-progress': [configuredOk, fail('prefile-in-progress')],
  busy: all('busy'),
  'sidecar-exited': both('sidecar-exited'),
  'sidecar-unavailable': all('sidecar-unavailable'),
  'sidecar-outdated': all('sidecar-outdated'),
  'not-supported': all('host-unsupported'),
};
const OK_PREFILES = ['configured', 'duplicate', 'long-label', 'prefiled'];

/**
 * What FPLN shows after CONFIRM fails in each scenario, character for
 * character: [row 2, row 3] from the settings read that follows, then
 * [row 10, row 11] (and the scratchpad) from the prefile.
 */
const FPLN_ERROR_ROWS = {
  'not-configured': [['NOT SET', 'SET PILOT ID ON SERVER'], ['NO SIMBRIEF PILOT ID', 'SET PILOT ID ON SERVER']],
  'no-user-id': [['CONFIGURED', ''], ['NO SIMBRIEF PILOT ID', 'SET PILOT ID ON SERVER']],
  'unknown-user': [['CONFIGURED', ''], ['SIMBRIEF ID NOT FOUND', 'CHECK PILOT ID ON SERVER']],
  'no-plan': [['CONFIGURED', ''], ['NO SIMBRIEF OFP', 'GENERATE OFP ON SIMBRIEF']],
  'simbrief-timeout': [['CONFIGURED', ''], ['SIMBRIEF TIMEOUT', 'TRY AGAIN SHORTLY']],
  network: [['CONFIGURED', ''], ['SIMBRIEF NO COMM', 'TRY AGAIN SHORTLY']],
  'bad-status': [['CONFIGURED', ''], ['SIMBRIEF ERROR', 'TRY AGAIN SHORTLY']],
  'bad-body': [['CONFIGURED', ''], ['SIMBRIEF BAD DATA', 'TRY AGAIN SHORTLY']],
  'db-error': [['CONFIGURED', ''], ['SERVER DB ERROR', '']],
  'unknown-code': [['CONFIGURED', ''], ['SERVER FAULT 409', 'SAFE TO PREFILE AGAIN']],
  'invalid-token': [['INGEST TOKEN REJECTED', 'CHECK TOKEN ON CFG'], ['INGEST TOKEN REJECTED', 'CHECK TOKEN ON CFG']],
  'token-missing': [['TOKEN NOT RECEIVED', 'TOKEN LOST IN TRANSIT'], ['TOKEN NOT RECEIVED', 'TOKEN LOST IN TRANSIT']],
  unavailable: [['SIMBRIEF UNAVAILABLE', 'SERVER UPDATE NEEDED'], ['SIMBRIEF UNAVAILABLE', 'SERVER UPDATE NEEDED']],
  rejected: [['SERVER REJECTED 403', ''], ['SERVER REJECTED 403', '']],
  'bad-response': [['SERVER BAD DATA', ''], ['SERVER BAD DATA', 'SAFE TO PREFILE AGAIN']],
  'tls-error': [['SERVER CERT FAULT', 'CHECK CERTIFICATE PATH'], ['SERVER CERT FAULT', 'CHECK CERTIFICATE PATH']],
  unreachable: [['SERVER NO COMM', ''], ['SERVER NO COMM', 'SAFE TO PREFILE AGAIN']],
  'client-timeout': [['SERVER TIMEOUT', ''], ['PREFILE RESULT UNKNOWN', 'SAFE TO PREFILE AGAIN']],
  'relay-timeout': [['SIDECAR TIMEOUT', ''], ['PREFILE RESULT UNKNOWN', 'SAFE TO PREFILE AGAIN']],
  'no-config': [['SERVER NOT CONFIGURED', 'COMPLETE CFG NETWORK'], ['SERVER NOT CONFIGURED', 'COMPLETE CFG NETWORK']],
  'in-progress': [['CONFIGURED', ''], ['PREFILE IN PROGRESS', '']],
  busy: [['SIDECAR BUSY', ''], ['SIDECAR BUSY', '']],
  'sidecar-exited': [['SIDECAR OFFLINE', ''], ['SIDECAR OFFLINE', 'SAFE TO PREFILE AGAIN']],
  'sidecar-unavailable': [['SIDECAR OFFLINE', ''], ['SIDECAR OFFLINE', '']],
  'sidecar-outdated': [['SIDECAR UPDATE REQUIRED', 'RESTART APP AFTER BUILD'], ['SIDECAR UPDATE REQUIRED', 'RESTART APP AFTER BUILD']],
  'not-supported': [['FPLN NOT SUPPORTED', ''], ['FPLN NOT SUPPORTED', '']],
};

const callsOf = (gaugeDev, method) => plain(gaugeDev.calls).filter((call) => call.method === method);
const withoutClock = (state) => {
  const { at, lastOkAt, lastErrorAt, ...rest } = plain(state);
  return rest;
};

test('simbrief mock: every method answers every scenario with the host contract shape', async () => {
  const { host, gaugeDev } = await loadMock();
  for (const name of SIMBRIEF_METHODS) assert.equal(typeof host[name], 'function', name);
  assert.equal(typeof gaugeDev.setSimbriefDelay, 'function');
  assert.throws(() => gaugeDev.simbriefScenario('nope'), /Unknown simbrief scenario: nope/);
  assert.equal(Object.keys(SIMBRIEF_SCENARIOS).length, 30);
  // The preview's default, before any scenario is picked.
  assert.deepEqual(plain(await host.getSimbriefSettings()), configuredOk);

  gaugeDev.datalinkScenario('leg');
  for (const [name, [settings, prefile, clear]] of Object.entries(SIMBRIEF_SCENARIOS)) {
    assert.equal(gaugeDev.simbriefScenario(name), name);
    gaugeDev.datalinkScenario('leg');
    gaugeDev.simbriefScenario(name);
    const initial = plain(await host.getDatalinkState());
    if (name === 'prefiled') {
      assert.deepEqual(initial.prefiledLeg, { plannedLegId: 4812, label: SAMPLE_LABEL });
      assert.deepEqual(initial.scope, { kind: 'leg', plannedLegId: 4812, source: 'prefile' });
    } else {
      assert.equal('prefiledLeg' in initial, false, name);
    }
    assert.deepEqual(plain(await host.getSimbriefSettings()), settings, `${name} settings`);
    const answered = plain(await host.prefileSimbrief());
    assert.deepEqual(answered, prefile, `${name} prefile`);
    for (const envelope of [settings, prefile]) {
      if (envelope.ok) continue;
      assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'httpStatus', 'serverCode']);
    }
    const state = plain(await host.getDatalinkState());
    const cleared = plain(await host.clearPrefiledLeg());
    if (clear) {
      assert.deepEqual(cleared, clear, `${name} clear`);
    } else {
      const held = answered.ok === true || name === 'prefiled';
      assert.deepEqual(cleared, { ok: true, result: { cleared: held } }, `${name} clear`);
      if (answered.ok) {
        assert.deepEqual(Object.keys(answered.result).sort(), ['httpStatus', 'label', 'plannedLegId', 'status', 'warningCount']);
        assert.deepEqual(state.prefiledLeg, { plannedLegId: answered.result.plannedLegId, label: answered.result.label });
        assert.deepEqual(state.scope, { kind: 'leg', plannedLegId: answered.result.plannedLegId, source: 'prefile' });
      }
      const after = plain(await host.getDatalinkState());
      assert.equal('prefiledLeg' in after, false, name);
      assert.deepEqual(plain(await host.clearPrefiledLeg()), { ok: true, result: { cleared: false } }, name);
    }
  }

  // Held leg: the prefile scope is a new thread epoch, and clearing restores the scenario's own.
  gaugeDev.simbriefScenario('configured');
  gaugeDev.datalinkScenario('leg');
  const own = plain(await host.getDatalinkState());
  await host.prefileSimbrief();
  const held = plain(await host.getDatalinkState());
  assert.deepEqual([held.scope, held.thread.total, held.thread.epoch], [{ kind: 'leg', plannedLegId: 4812, source: 'prefile' }, 3, own.thread.epoch + 1]);
  await host.clearPrefiledLeg();
  const restored = plain(await host.getDatalinkState());
  assert.deepEqual([restored.scope, restored.thread.epoch, 'prefiledLeg' in restored], [LEG, own.thread.epoch + 2, false]);
  gaugeDev.datalinkScenario('no-flight-plan');
  await host.prefileSimbrief();
  const noPlan = plain(await host.getDatalinkState());
  assert.deepEqual([noPlan.scope, noPlan.thread.total], [{ kind: 'leg', plannedLegId: 4812, source: 'prefile' }, 3]);
  assert.equal(plain(await host.getDatalinkThread({ epoch: noPlan.thread.epoch, endSeq: 3 })).result.messages.length, 3);
  await host.clearPrefiledLeg();
  const noPlanAgain = plain(await host.getDatalinkState());
  assert.deepEqual([noPlanAgain.scope, noPlanAgain.thread], [{ kind: 'none' }, null]);

  // A flight clears the held leg as soon as it is seen.
  gaugeDev.datalinkScenario('flight');
  await host.prefileSimbrief();
  const flight = plain(await host.getDatalinkState());
  assert.deepEqual([flight.scope, 'prefiledLeg' in flight], [FLIGHT, false]);

  // The rejected-token scenario latches the datalink on its first call only.
  gaugeDev.datalinkScenario('leg');
  gaugeDev.simbriefScenario('invalid-token');
  const emitted = [];
  const off = host.onDatalink((next) => emitted.push(plain(next)));
  await host.getSimbriefSettings();
  await host.prefileSimbrief();
  off();
  assert.deepEqual(emitted.map((next) => next.state), ['dl.token-invalid']);

  // The pre-SimBrief server scenario never touches the datalink state.
  gaugeDev.datalinkScenario('leg');
  gaugeDev.simbriefScenario('unavailable');
  const quiet = [];
  const offQuiet = host.onDatalink((next) => quiet.push(next));
  const before = withoutClock(await host.getDatalinkState());
  await host.getSimbriefSettings();
  await host.prefileSimbrief();
  await host.clearPrefiledLeg();
  offQuiet();
  assert.deepEqual([withoutClock(await host.getDatalinkState()), quiet.length], [before, 0]);

  // The delay control holds only the prefile.
  gaugeDev.simbriefScenario('configured');
  assert.equal(gaugeDev.setSimbriefDelay(60), 60);
  const started = Date.now();
  await host.getSimbriefSettings();
  assert.ok(Date.now() - started < 40);
  await host.prefileSimbrief();
  assert.ok(Date.now() - started >= 50);
  gaugeDev.setSimbriefDelay(0);

  for (const call of gaugeDev.calls.filter((entry) => SIMBRIEF_METHODS.includes(entry.method))) {
    assert.deepEqual(Object.keys(call).sort(), ['args', 'at', 'method']);
    assert.deepEqual(plain(call.args), []);
  }
});

test('fpln vocab: every string fits 24 columns, codes map to fixed texts, labels render per the fixtures', async () => {
  const vocab = await pageModule('fpln-vocab.js');
  const { formatScope } = await pageModule('datalink-vocab.js');
  assert.equal(typeof document, 'undefined');
  const widest = '9'.repeat(16);
  const strings = [
    ...Object.values(vocab.ERRORS).flatMap((entry) => [entry.text, entry.hint]),
    ...Object.values(vocab.TEXT), ...Object.values(vocab.ADVISORY),
    vocab.UNKNOWN_CODE_TEXT, vocab.PREFILE_RESULT_UNKNOWN, vocab.SAFE_TO_PREFILE_AGAIN,
    vocab.formatLeg(widest), formatScope({ kind: 'leg', plannedLegId: Number(widest), source: 'prefile' }).replace(/\d+$/, widest),
    vocab.errorText({ code: 'http-error', httpStatus: 599 }), '999',
  ];
  for (const text of strings) assert.ok(text.length <= 24, text);
  assert.equal(`PREFILE ${widest}`.length, 24);
  // Cells that share a row with CLR PREFILE>, at a 9-digit id and at the widest safe integer.
  const clear = vocab.TEXT.clearPrefile;
  assert.equal(vocab.TEXT.prefileScope, 'PREFILE');
  assert.ok(vocab.TEXT.prefileScope.length + clear.length <= 24);
  assert.ok('123456789'.length + clear.length <= 24);
  assert.equal(`LEG ${'1'.repeat(9)}`.length + clear.length, 25, 'why the id is not paired with its LEG prefix');

  // Code → [text, hint, unknown outcome on prefile], transcribed from the design's table.
  const table = {
    'simbrief-no-user-id': ['NO SIMBRIEF PILOT ID', 'SET PILOT ID ON SERVER', false],
    'simbrief-unknown-user': ['SIMBRIEF ID NOT FOUND', 'CHECK PILOT ID ON SERVER', false],
    'simbrief-no-plan': ['NO SIMBRIEF OFP', 'GENERATE OFP ON SIMBRIEF', false],
    'simbrief-timeout': ['SIMBRIEF TIMEOUT', 'TRY AGAIN SHORTLY', false],
    'simbrief-network': ['SIMBRIEF NO COMM', 'TRY AGAIN SHORTLY', false],
    'simbrief-bad-status': ['SIMBRIEF ERROR', 'TRY AGAIN SHORTLY', false],
    'simbrief-bad-body': ['SIMBRIEF BAD DATA', 'TRY AGAIN SHORTLY', false],
    'simbrief-db-error': ['SERVER DB ERROR', '', false],
    'simbrief-unavailable': ['SIMBRIEF UNAVAILABLE', 'SERVER UPDATE NEEDED', false],
    'token-invalid': ['INGEST TOKEN REJECTED', 'CHECK TOKEN ON CFG', false],
    'token-missing': ['TOKEN NOT RECEIVED', 'TOKEN LOST IN TRANSIT', false],
    rejected: ['SERVER REJECTED 403', '', false],
    'http-error': ['SERVER FAULT', '', true],
    'bad-response': ['SERVER BAD DATA', '', true],
    'too-large': ['SERVER BAD DATA', '', true],
    unreachable: ['SERVER NO COMM', '', true],
    'tls-error': ['SERVER CERT FAULT', 'CHECK CERTIFICATE PATH', false],
    timeout: ['SERVER TIMEOUT', '', true],
    'shell-timeout': ['SIDECAR TIMEOUT', '', true],
    'no-config': ['SERVER NOT CONFIGURED', 'COMPLETE CFG NETWORK', false],
    'bad-request': ['INVALID ENTRY', '', false],
    'prefile-in-progress': ['PREFILE IN PROGRESS', '', false],
    busy: ['SIDECAR BUSY', '', false],
    'sidecar-exited': ['SIDECAR OFFLINE', '', true],
    'sidecar-unavailable': ['SIDECAR OFFLINE', '', false],
    'sidecar-outdated': ['SIDECAR UPDATE REQUIRED', 'RESTART APP AFTER BUILD', false],
    'host-unsupported': ['FPLN NOT SUPPORTED', '', false],
    'host-error': ['FPLN HOST FAULT', '', true],
    'something-new': ['FPLN FAULT', '', true],
  };
  for (const [code, [text, hint, unknown]] of Object.entries(table)) {
    const error = { code, httpStatus: null, serverCode: 'SERVER SAYS SOMETHING ELSE' };
    assert.equal(vocab.isUnknownOutcome(code), unknown, code);
    for (const op of ['settings', 'clear']) {
      assert.deepEqual([vocab.errorText(error, op), vocab.errorHint(error, op)], [text, hint], `${code} ${op}`);
    }
    const prefileText = code === 'timeout' || code === 'shell-timeout' ? 'PREFILE RESULT UNKNOWN' : text;
    assert.deepEqual([vocab.errorText(error, 'prefile'), vocab.errorHint(error, 'prefile')],
      [prefileText, unknown ? 'SAFE TO PREFILE AGAIN' : hint], `${code} prefile`);
  }
  assert.equal(vocab.errorText({ code: 'http-error', httpStatus: 502 }, 'prefile'), 'SERVER FAULT 502');
  for (const status of [null, 99, 600, 502.5, '502']) {
    assert.equal(vocab.errorText({ code: 'http-error', httpStatus: status }, 'settings'), 'SERVER FAULT', String(status));
  }
  for (const missing of [undefined, null, 'oops']) {
    assert.deepEqual([vocab.errorText(missing, 'prefile'), vocab.errorHint(missing, 'prefile')], ['FPLN HOST FAULT', 'SAFE TO PREFILE AGAIN']);
  }

  const fixtures = [
    [SAMPLE_LABEL, 'KJFK/EGLL (BAW178)', ['KJFK/EGLL (BAW178)']],
    [LONG_LABEL, 'SBGR/LFPG (TAP084 SAO PAULO-PARIS EXT)', ['SBGR/LFPG (TAP084 SAO', 'PAULO-PARIS EXT)']],
    ['LFPG → KSFO (AFR084 A LABEL MADE DELIBERATELY FAR TOO LONG)', 'LFPG/KSFO (AFR084 A LABEL MADE DELIBERATELY FAR TOO LONG)',
      ['LFPG/KSFO (AFR084 A', 'LABEL MADE DELIBERATELY+']],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ['ABCDEFGHIJKLMNOPQRSTUVWX', 'YZ0123456789']],
    ['', '----', ['----']],
    [`KJFK\t→\nEGLL ${String.fromCodePoint(0x1F600)}`, 'KJFK/EGLL ?', ['KJFK/EGLL ?']],
  ];
  assert.equal(LONG_LABEL.length, 40);
  for (const [input, normalised, lines] of fixtures) {
    assert.equal(vocab.normaliseLabel(input), normalised, input);
    assert.deepEqual(vocab.labelLines(normalised), lines, input);
    for (const line of lines) assert.ok(line.length <= 24, line);
  }

  assert.equal(vocab.formatLeg(4812), 'LEG 4812');
  assert.equal(formatScope({ kind: 'leg', plannedLegId: 4812, source: 'prefile' }), 'PREFILE 4812');
  assert.equal(formatScope({ kind: 'leg', plannedLegId: 12, source: 'status' }), 'LEG 12');
  const leg = { plannedLegId: 4812, label: '' };
  assert.deepEqual(vocab.heldPrefiledLeg({ prefiledLeg: leg }), leg);
  for (const state of [null, {}, { prefiledLeg: null }, { prefiledLeg: { plannedLegId: 0, label: 'X' } },
    { prefiledLeg: { plannedLegId: '4812', label: 'X' } }, { prefiledLeg: { plannedLegId: 4812 } }]) {
    assert.equal(vocab.heldPrefiledLeg(state), null, JSON.stringify(state));
  }
});

/** A DOM just rich enough for the real shell to boot, route and paint. */
function bootDocument() {
  class Element {
    constructor() {
      this.children = []; this.attributes = {}; this.className = ''; this.ownText = ''; this.found = new Map();
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name),
        toggle: (name, on) => ((on ?? !classes.has(name)) ? classes.add(name) : classes.delete(name)),
      };
    }
    get textContent() { return this.children.length ? this.children.map((child) => child.textContent).join('') : this.ownText; }
    set textContent(value) { this.children = []; this.ownText = String(value); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; }
    get firstChild() { return this.children[0] || null; }
    get childElementCount() { return this.children.length; }
    querySelector(selector) {
      if (!this.found.has(selector)) this.found.set(selector, new Element());
      return this.found.get(selector);
    }
    closest() { return this; }
  }
  const root = new Element();
  const listeners = new Map();
  const document = {
    getElementById: (id) => root.querySelector(`#${id}`),
    querySelector: (selector) => root.querySelector(selector),
    createElement: () => new Element(),
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
  };
  const press = (attribute, value) => {
    const target = new Element();
    target.setAttribute(attribute, value);
    for (const fn of listeners.get('click') || []) fn({ target });
  };
  return { Element, document, press };
}

test('app shell: MENU keeps L1 to L5 and L6 opens FPLN through the real router and host bridge', async (t) => {
  const { Element, document, press } = bootDocument();
  const { host, gaugeDev } = await loadMock();
  const saved = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  // The shell's once-a-second repaint and the datalink lease renewal would keep the test process alive.
  globalThis.setInterval = () => ({ fake: true });
  globalThis.clearInterval = () => {};
  Object.assign(globalThis, { window: { __FMC_HOST__: host }, document, Node: Element, Element });
  t.after(() => {
    Object.assign(globalThis, saved);
    for (const name of ['window', 'document', 'Node', 'Element']) delete globalThis[name];
  });
  await import(new URL('../../ui/src/app.js', import.meta.url));
  const screen = document.getElementById('fmc-screen');
  const body = document.getElementById('page-body');
  const cells = () => body.children[0].children.map((line) => line.children.map((cell) => cell.textContent));
  const landOn = async (id) => {
    for (let i = 0; i < 400 && screen.getAttribute('data-page') !== id; i += 1) await later(5);
    assert.equal(screen.getAttribute('data-page'), id);
    await settle();
  };

  press('data-key', 'MENU');
  await landOn('MENU');
  assert.deepEqual(cells(), [
    ['SELECT PAGE'], ['<STATUS'], [''], ['<NETWORK'], [''], ['<SIM'], [''], ['<TRAFFIC'], [''], ['<DATALINK'], [''], ['<FPLN'],
  ]);
  for (const [lsk, id] of [['L1', 'STATUS'], ['L2', 'NETWORK'], ['L3', 'SIM'], ['L4', 'TRAFFIC'], ['L5', 'DL-INDEX'], ['L6', 'FPLN']]) {
    press('data-key', 'MENU');
    await landOn('MENU');
    press('data-lsk', lsk);
    await landOn(id);
  }
  assert.equal(document.getElementById('page-title').textContent, 'FLIGHT PLAN');
  assert.deepEqual(cells().slice(0, 2), [['SIMBRIEF PILOT ID'], ['CONFIGURED']]);
  assert.deepEqual(cells()[11], ['<MENU', 'PREFILE>']);
  press('data-lsk', 'R6');
  await landOn('FPLN-CONFIRM');
  assert.equal(callsOf(gaugeDev, 'prefileSimbrief').length, 0);
  press('data-lsk', 'R6');
  await landOn('FPLN-RESULT');
  assert.equal(callsOf(gaugeDev, 'prefileSimbrief').length, 1);
  assert.deepEqual(cells().slice(0, 6).map((line) => line[0]), ['PREFILED', 'KJFK/EGLL (BAW178)', '', '', 'PLANNED LEG', 'LEG 4812']);
  assert.equal(document.getElementById('scratchpad').textContent, 'SIMBRIEF PLAN PREFILED');
  press('data-key', 'NEXT');
  assert.equal(document.getElementById('scratchpad').textContent, 'KEY NOT ACTIVE');
});

test('fpln settings: PREFILE is offered only with a Pilot ID, and without one R6 calls nothing', async (t) => {
  const ui = await mountDatalinkPages(t, 'fpln-settings', { fpln: true });
  const { shell, fmc, gaugeDev, rows, pages } = ui;
  assert.deepEqual([...pages.values()].filter((page) => page.id.startsWith('FPLN')).map((page) => [page.id, page.title, page.group, page.n, page.m]), [
    ['FPLN', 'FLIGHT PLAN', 'FPLN', 1, 1], ['FPLN-CONFIRM', 'PREFILE SIMBRIEF', 'FPLN-CONFIRM', 1, 1], ['FPLN-RESULT', 'PREFILE', 'FPLN-RESULT', 1, 1],
  ]);
  fmc.showPage('FPLN');
  // Painted before the settings read answers.
  assert.deepEqual(rows().map((line) => line[0]), [
    'SIMBRIEF PILOT ID', '----', '', '', 'PREFILED LEG', 'NONE', '', '', 'LAST PREFILE', 'NONE', '', '<MENU',
  ]);
  await settle();
  assert.deepEqual([rows()[1], rows()[2], rows()[11]], [['CONFIGURED'], [''], ['<MENU', 'PREFILE>']]);
  assert.deepEqual(callsOf(gaugeDev, 'getSimbriefSettings').length, 1);

  gaugeDev.simbriefScenario('not-configured');
  fmc.showPage('FPLN');
  await settle();
  assert.deepEqual([rows()[1], rows()[2], rows()[11]], [['NOT SET'], ['SET PILOT ID ON SERVER'], ['<MENU', '']]);
  assert.equal(await ui.lsk('FPLN', 'R6'), false);
  assert.equal(await ui.lsk('FPLN', 'R3'), false);
  assert.equal(await ui.lsk('FPLN', 'L1'), false);
  assert.deepEqual([shell.id, callsOf(gaugeDev, 'prefileSimbrief').length, callsOf(gaugeDev, 'clearPrefiledLeg').length], ['FPLN', 0, 0]);
  assert.equal(await ui.lsk('FPLN', 'L6'), true);
  assert.equal(shell.id, 'MENU');
});

test('fpln prefile: one press sends nothing, CONFIRM sends once, and no failure is ever resent', async (t) => {
  const ui = await mountDatalinkPages(t, 'fpln-send', { fpln: true });
  const { shell, fmc, gaugeDev, rows, pages } = ui;
  const prefiles = () => callsOf(gaugeDev, 'prefileSimbrief').length;
  const screens = [];
  const look = () => {
    screens.push(rows());
    if (shell.scratchpad) screens.push([[shell.scratchpad[0]]]);
  };
  gaugeDev.datalinkScenario('leg');

  fmc.showPage('FPLN');
  await settle();
  assert.equal(await ui.lsk('FPLN', 'R6'), true);
  assert.equal(shell.id, 'FPLN-CONFIRM');
  look();
  assert.deepEqual(rows(), [['IMPORT'], ['LATEST SIMBRIEF OFP'], ['AS'], ['PLANNED LEG, NO TRIP'], [''], [''], [''], [''], [''], [''], [''], ['<CANCEL', 'CONFIRM*']]);
  assert.equal(prefiles(), 0, 'PREFILE alone sends nothing');
  assert.equal(await ui.lsk('FPLN-CONFIRM', 'L6'), true);
  assert.deepEqual([shell.id, prefiles()], ['FPLN', 0], 'CANCEL sends nothing');

  // In flight: CONFIRM again, CANCEL and PREFILE from FPLN all do nothing more.
  await ui.lsk('FPLN', 'R6');
  gaugeDev.setSimbriefDelay(60);
  assert.equal(pages.get('FPLN-CONFIRM').onLsk('R6', {}), true);
  assert.deepEqual([rows()[9], rows()[11]], [['WAIT UP TO 30 SEC'], ['', 'SENDING']]);
  look();
  assert.equal(pages.get('FPLN-CONFIRM').onLsk('R6', {}), true);
  assert.equal(pages.get('FPLN-CONFIRM').onLsk('L6', {}), true);
  await settle();
  assert.deepEqual([shell.id, prefiles()], ['FPLN-CONFIRM', 1]);
  fmc.showPage('FPLN');
  await settle();
  assert.deepEqual([rows()[9], rows()[11]], [['SENDING'], ['<MENU', '']]);
  assert.equal(await ui.lsk('FPLN', 'R6'), true);
  assert.deepEqual([shell.id, rows()[11], prefiles()], ['FPLN-CONFIRM', ['', 'SENDING'], 1]);
  await later(100);
  assert.deepEqual([shell.id, shell.scratchpad, prefiles()], ['FPLN-RESULT', ['SIMBRIEF PLAN PREFILED', 'advisory'], 1]);
  gaugeDev.setSimbriefDelay(0);

  // Imported, duplicate and a long label, on the result page and on FPLN.
  const results = {
    configured: [['PREFILED'], ['KJFK/EGLL (BAW178)'], [''], [''], ['PLANNED LEG'], ['LEG 4812'], [''], [''], [''], ['', 'DATALINK>'], [''], ['<RETURN']],
    duplicate: [['ALREADY FILED'], ['KJFK/EGLL (BAW178)'], [''], [''], ['PLANNED LEG'], ['LEG 4812'], [''], [''], [''], ['', 'DATALINK>'], [''], ['<RETURN']],
    'long-label': [['PREFILED'], ['SBGR/LFPG (TAP084 SAO'], [''], ['PAULO-PARIS EXT)'], ['PLANNED LEG'], ['LEG 4813'], ['WARNINGS'], ['2'], [''], ['', 'DATALINK>'], [''], ['<RETURN']],
  };
  const advisories = { configured: 'SIMBRIEF PLAN PREFILED', duplicate: 'PLAN ALREADY FILED', 'long-label': 'SIMBRIEF PLAN PREFILED' };
  for (const [name, expected] of Object.entries(results)) {
    gaugeDev.datalinkScenario('leg');
    gaugeDev.simbriefScenario(name);
    fmc.showPage('FPLN');
    await settle();
    await ui.lsk('FPLN', 'R6');
    const before = prefiles();
    await ui.lsk('FPLN-CONFIRM', 'R6');
    assert.deepEqual([shell.id, shell.title, rows(), shell.scratchpad], ['FPLN-RESULT', 'PREFILE', expected, [advisories[name], 'advisory']], name);
    look();
    assert.equal(rows().flat().includes('ALREADY FILED'), name === 'duplicate', name);
    await ui.lsk('FPLN-RESULT', 'L6');
    const [line] = expected[1];
    assert.deepEqual(rows().slice(4, 10), [['PREFILED LEG'], [expected[5][0].slice('LEG '.length), 'CLR PREFILE>'], [''], [line], ['LAST PREFILE'], [expected[0][0]]], name);
    look();
    await later(100);
    assert.equal(prefiles(), before + 1, name);
  }

  // Every failure: back on FPLN with its text, once, and nothing sent again later.
  for (const [name, [settingsRows, prefileRows]] of Object.entries(FPLN_ERROR_ROWS)) {
    gaugeDev.datalinkScenario('leg');
    gaugeDev.simbriefScenario('configured');
    fmc.showPage('FPLN');
    await settle();
    await ui.lsk('FPLN', 'R6');
    gaugeDev.simbriefScenario(name);
    const before = prefiles();
    await ui.lsk('FPLN-CONFIRM', 'R6');
    await settle();
    assert.deepEqual([shell.id, shell.scratchpad], ['FPLN', [prefileRows[0], 'error']], name);
    assert.deepEqual([rows()[1][0], rows()[2][0]], settingsRows, `${name} settings`);
    assert.deepEqual([rows()[9][0], rows()[10][0]], prefileRows, `${name} prefile`);
    assert.equal(rows()[11][1], settingsRows[0] === 'CONFIGURED' ? 'PREFILE>' : '', name);
    look();
    await later(100);
    assert.equal(prefiles(), before + 1, `${name} sent once`);
  }

  // A rejected host call and a code this build does not know.
  for (const [override, text] of [[async () => { throw new Error('transport'); }, 'FPLN HOST FAULT'], [async () => fail('brand-new-code'), 'FPLN FAULT']]) {
    const odd = await mountDatalinkPages(t, `fpln-odd-${text.length}`, { fpln: true, prefileSimbrief: override });
    odd.fmc.showPage('FPLN');
    await settle();
    await odd.lsk('FPLN', 'R6');
    await odd.lsk('FPLN-CONFIRM', 'R6');
    assert.deepEqual([odd.shell.id, odd.shell.scratchpad, odd.rows()[9][0], odd.rows()[10][0]], ['FPLN', [text, 'error'], text, 'SAFE TO PREFILE AGAIN']);
    screens.push(odd.rows());
  }

  // The answer arrives while the pilot is elsewhere: nothing moves, FPLN keeps it.
  gaugeDev.simbriefScenario('unreachable');
  gaugeDev.setSimbriefDelay(30);
  fmc.showPage('FPLN-CONFIRM');
  pages.get('FPLN-CONFIRM').onLsk('R6', {});
  fmc.showPage('DL-INDEX');
  await later(80);
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-INDEX', null]);
  fmc.showPage('FPLN');
  await settle();
  assert.deepEqual([rows()[9][0], rows()[10][0]], ['SERVER NO COMM', 'SAFE TO PREFILE AGAIN']);
  gaugeDev.setSimbriefDelay(0);

  for (const screen of screens) {
    for (const cell of screen.flat()) assert.ok(cell.length <= 24, cell);
  }
  assert.equal(JSON.stringify(screens).includes('SOMETHING_NEW'), false, 'server codes are never shown');
});

test('fpln prefiled leg: DATALINK uses it for scope, thread, WX and load sheet, and every clear restores the scope line', async (t) => {
  const ui = await mountDatalinkPages(t, 'fpln-scope', { fpln: true });
  const { shell, fmc, host, gaugeDev, rows } = ui;
  const prefileFromFpln = async () => {
    fmc.showPage('FPLN');
    await settle();
    await ui.lsk('FPLN', 'R6');
    await ui.lsk('FPLN-CONFIRM', 'R6');
    assert.equal(shell.id, 'FPLN-RESULT');
  };
  const scopeLine = async () => {
    fmc.showPage('DL-INDEX');
    await settle();
    // DL-INDEX row 2 (scope and CLR PREFILE>) and row 10 (the held leg's id).
    return [...rows()[1], ...rows()[9]];
  };

  await ui.scenario('leg');
  assert.deepEqual(await scopeLine(), ['LEG 12', '']);
  assert.equal(await ui.lsk('DL-INDEX', 'R1'), false);
  const epochBefore = shell.datalink.thread.epoch;

  for (const name of ['configured', 'duplicate']) {
    gaugeDev.datalinkScenario('leg');
    gaugeDev.simbriefScenario(name);
    await prefileFromFpln();
    await ui.lsk('FPLN-RESULT', 'R5');
    assert.equal(shell.id, 'DL-INDEX');
    assert.deepEqual([...rows()[1], ...rows()[8], ...rows()[9]], ['PREFILE', 'CLR PREFILE>', 'PREFILED LEG', '4812'], name);
  }
  assert.ok(shell.datalink.thread.epoch > epochBefore);

  await ui.lsk('DL-INDEX', 'L3');
  assert.equal(shell.id, 'DL-THREAD');
  assert.deepEqual([rows()[0], rows()[10]], [['UP 1220Z DISPATCH RELEASE'], ['PREFILE 4812']]);
  const threadCall = callsOf(gaugeDev, 'getDatalinkThread').at(-1);
  assert.equal(threadCall.args[0].epoch, shell.datalink.thread.epoch);
  await ui.lsk('DL-THREAD', 'L6');

  await ui.lsk('DL-INDEX', 'R3');
  ui.type('EGLL');
  await ui.lsk('DL-WX', 'L1');
  await ui.lsk('DL-WX', 'R6');
  assert.deepEqual(rows()[3], ['LEG 4812']);
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual(callsOf(gaugeDev, 'requestWeather').at(-1).args, [{ target: { kind: 'leg', id: 4812 }, icao: 'EGLL' }]);

  fmc.showPage('DL-INDEX');
  await ui.lsk('DL-INDEX', 'R4');
  assert.equal(shell.id, 'DL-LOADSHEET');
  await ui.lsk('DL-LOADSHEET', 'R6');
  assert.deepEqual([rows()[1], rows()[3]], [['LEG 4812'], ['LEG 4812']]);
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual(callsOf(gaugeDev, 'requestLoadsheet').at(-1).args, [{ plannedLegId: 4812 }]);

  // CLR PREFILE on DL-INDEX.
  fmc.showPage('DL-INDEX');
  await settle();
  assert.equal(await ui.lsk('DL-INDEX', 'R1'), true);
  assert.deepEqual([rows()[1], rows()[8], rows()[9], shell.scratchpad], [['LEG 12'], [''], [''], ['PREFILE CLEARED', 'advisory']]);
  assert.equal('prefiledLeg' in shell.datalink, false);
  fmc.showPage('DL-THREAD');
  await settle();
  assert.deepEqual(rows()[10], ['']);

  // CLR PREFILE on FPLN.
  gaugeDev.simbriefScenario('configured');
  await prefileFromFpln();
  await ui.lsk('FPLN-RESULT', 'L6');
  assert.deepEqual(rows()[5], ['4812', 'CLR PREFILE>']);
  assert.equal(await ui.lsk('FPLN', 'R3'), true);
  assert.deepEqual([rows()[5], rows()[7], shell.scratchpad], [['NONE'], [''], ['PREFILE CLEARED', 'advisory']]);
  assert.deepEqual(await scopeLine(), ['LEG 12', '']);

  // The other clearing events the mock can produce.
  const events = {
    'a datalink scenario change': async () => { gaugeDev.datalinkScenario('leg'); },
    'a different server URL': async () => { await host.setConfig({ serverUrl: 'http://other.invalid' }); },
    'a different ingest token': async () => { await host.setConfig({ ingestToken: 'another-token' }); },
    'a flight': async () => { gaugeDev.datalinkScenario('flight'); },
    'a rejected token': async () => { gaugeDev.datalinkScenario('invalid-token'); },
  };
  const own = { 'a flight': ['FLT 92 LEG 12', ''], 'a rejected token': ['----', ''] };
  for (const [event, run] of Object.entries(events)) {
    gaugeDev.datalinkScenario('leg');
    gaugeDev.simbriefScenario('configured');
    await prefileFromFpln();
    assert.deepEqual(await scopeLine(), ['PREFILE', 'CLR PREFILE>', '4812'], event);
    await run();
    await settle();
    assert.deepEqual([...rows()[1], ...rows()[9]], own[event] || ['LEG 12', ''], event);
    assert.equal('prefiledLeg' in shell.datalink, false, event);
  }
  // Saving the same server and token keeps it.
  gaugeDev.datalinkScenario('leg');
  await prefileFromFpln();
  await host.setConfig({ serverUrl: 'http://other.invalid', ingestToken: 'another-token', trafficRadiusM: 45000 });
  assert.deepEqual(await scopeLine(), ['PREFILE', 'CLR PREFILE>', '4812']);

  // A prefile seen with a flight never takes the scope.
  gaugeDev.datalinkScenario('flight');
  await prefileFromFpln();
  assert.deepEqual(await scopeLine(), ['FLT 92 LEG 12', '']);

  // A clear the host refuses says so, once per press, and the leg stays.
  let refusals = 0;
  const refusing = await mountDatalinkPages(t, 'fpln-clear-refused', {
    fpln: true,
    clearPrefiledLeg: () => { refusals += 1; return new Promise((resolve) => setTimeout(() => resolve(fail('busy')), 20)); },
  });
  refusing.gaugeDev.datalinkScenario('leg');
  refusing.gaugeDev.simbriefScenario('prefiled');
  refusing.fmc.showPage('DL-INDEX');
  await settle();
  assert.deepEqual([...refusing.rows()[1], ...refusing.rows()[9]], ['PREFILE', 'CLR PREFILE>', '4812']);
  assert.equal(refusing.pages.get('DL-INDEX').onLsk('R1', {}), true);
  assert.equal(refusing.pages.get('DL-INDEX').onLsk('R1', {}), true);
  await later(40);
  assert.deepEqual([refusals, refusing.shell.scratchpad, refusing.rows()[1]], [1, ['SIDECAR BUSY', 'error'], ['PREFILE', 'CLR PREFILE>']]);
  refusing.fmc.showPage('FPLN');
  await settle();
  assert.equal(refusing.pages.get('FPLN').onLsk('R3', {}), true);
  assert.equal(refusing.pages.get('FPLN').onLsk('R3', {}), true);
  await later(40);
  assert.deepEqual([refusals, refusing.shell.scratchpad, refusing.rows()[5]], [2, ['SIDECAR BUSY', 'error'], ['4812', 'CLR PREFILE>']]);
});

test('fpln prefiled leg ids of 5 and 9 digits keep every DL-INDEX, FPLN and result row within 24 columns', async (t) => {
  for (const id of [48123, 123456789]) {
    const ui = await mountDatalinkPages(t, `fpln-wide-${id}`, {
      fpln: true,
      prefileSimbrief: async () => ({ ok: true, result: { status: 'imported', plannedLegId: id, label: SAMPLE_LABEL, warningCount: 999, httpStatus: 201 } }),
    });
    const { shell, fmc, pages, rows } = ui;
    const within = (where) => {
      for (const line of rows()) assert.ok(line.join('').length <= 24, `${id} ${where}: ${JSON.stringify(line)}`);
    };
    await ui.scenario('leg');
    // The sidecar's state once this leg is held and applied; set again after anything the mock emits.
    const held = { ...shell.datalink, scope: { kind: 'leg', plannedLegId: id, source: 'prefile' }, prefiledLeg: { plannedLegId: id, label: SAMPLE_LABEL } };
    const hold = () => {
      shell.datalink = held;
      const page = pages.get(shell.id);
      if (page && page.onDatalink) page.onDatalink(held);
    };

    hold();
    fmc.showPage('FPLN');
    await settle();
    assert.deepEqual(rows().slice(4, 8), [['PREFILED LEG'], [String(id), 'CLR PREFILE>'], [''], ['KJFK/EGLL (BAW178)']], `${id} FPLN`);
    within('FPLN');
    await ui.lsk('FPLN', 'R6');
    await ui.lsk('FPLN-CONFIRM', 'R6');
    assert.equal(shell.id, 'FPLN-RESULT');
    assert.deepEqual([rows()[5], rows()[7]], [[`LEG ${id}`], ['999']], `${id} FPLN-RESULT`);
    within('FPLN-RESULT');

    fmc.showPage('DL-INDEX');
    await settle();
    hold();
    assert.deepEqual([rows()[1], rows()[8], rows()[9]], [['PREFILE', 'CLR PREFILE>'], ['PREFILED LEG'], [String(id)]], `${id} DL-INDEX`);
    within('DL-INDEX');
    await ui.lsk('DL-INDEX', 'L3');
    hold();
    assert.deepEqual(rows()[10], [`PREFILE ${id}`], `${id} DL-THREAD`);
    assert.ok(rows()[10][0].length <= 24);
  }
});

test('fpln on an older host: still adopted, FPLN says NOT SUPPORTED, and DATALINK works as before', async (t) => {
  const importBridge = async (window, tag) => {
    globalThis.window = window;
    try {
      return (await import(new URL(`../../ui/src/bridge.js?${tag}`, import.meta.url))).default;
    } finally {
      delete globalThis.window;
    }
  };
  const legacy = { hostLabel: 'LEGACY' };
  const seenArgs = [];
  for (const name of ['getConfig', 'setConfig', 'getConfigPath', 'startUplink', 'stopUplink', 'restartSidecar', 'getStatus', 'onStatus', 'onLog', 'onExit']) {
    legacy[name] = async () => null;
  }
  const bare = await importBridge({ __FMC_HOST__: legacy }, 'simbrief-legacy');
  assert.equal(bare.hostLabel, 'LEGACY');
  for (const name of SIMBRIEF_METHODS) assert.deepEqual(await bare[name](SIMBRIEF_SENTINEL), localError('host-unsupported'), name);

  // A host that has them gets every call, with nothing passed through.
  const modern = { ...legacy, hostLabel: 'MODERN' };
  for (const name of SIMBRIEF_METHODS) modern[name] = async (...args) => { seenArgs.push([name, args.length]); return { ok: true, result: {} }; };
  const adoptedModern = await importBridge({ __FMC_HOST__: modern }, 'simbrief-modern');
  for (const name of SIMBRIEF_METHODS) await adoptedModern[name]({ ingestToken: SIMBRIEF_SENTINEL });
  assert.deepEqual(seenArgs, SIMBRIEF_METHODS.map((name) => [name, 0]));

  // Tauri: the three command names, no arguments object.
  const invoked = [];
  const tauri = await importBridge({ __TAURI__: { core: { invoke: async (cmd, args) => { invoked.push([cmd, args]); return { ok: true, result: {} }; } } } }, 'simbrief-tauri');
  for (const name of SIMBRIEF_METHODS) await tauri[name]({ pilotId: '1' });
  assert.deepEqual(invoked, [['simbrief_settings', undefined], ['simbrief_prefile', undefined], ['simbrief_clear_prefile', undefined]]);

  // Stub: recorded and unsupported until a result is set.
  const stubWindow = {};
  const stubBridge = await importBridge(stubWindow, 'simbrief-stub');
  const stub = stubWindow.__FMC_STUB__;
  assert.deepEqual(await stubBridge.getSimbriefSettings(), localError('host-unsupported'));
  stub.datalinkResults.prefileSimbrief = { ok: true, result: { status: 'imported', plannedLegId: 7, label: '', warningCount: 0, httpStatus: 201 } };
  assert.equal((await stubBridge.prefileSimbrief()).result.plannedLegId, 7);
  assert.deepEqual(stub.calls.slice(-2).map((call) => [call.method, call.args]), [['getSimbriefSettings', []], ['prefileSimbrief', []]]);

  // The preview mock with the three methods removed, through the adopted bridge, on the pages.
  const mock = await loadMock();
  for (const name of SIMBRIEF_METHODS) delete mock.host[name];
  const adopted = await importBridge({ __FMC_HOST__: mock.host }, 'simbrief-old-mock');
  const ui = await mountDatalinkPages(t, 'fpln-old-host', { fpln: true, mock, via: adopted });
  const { shell, fmc, rows } = ui;
  await ui.scenario('flight');
  fmc.showPage('FPLN');
  await settle();
  assert.deepEqual([rows()[1], rows()[2], rows()[11]], [['FPLN NOT SUPPORTED'], [''], ['<MENU', '']]);
  assert.equal(await ui.lsk('FPLN', 'R6'), false);
  fmc.showPage('DL-INDEX');
  await settle();
  assert.deepEqual([rows()[1], rows()[3], rows()[5], rows()[11]], [['FLT 92 LEG 12'], ['DATALINK ONLINE'], ['<MESSAGES', 'WX REQUEST>'], ['<INDEX', 'REFRESH>']]);
  await ui.lsk('DL-INDEX', 'L3');
  assert.deepEqual([shell.id, rows()[0][0].startsWith('UP 1220Z'), rows()[10]], ['DL-THREAD', true, ['']]);
  assert.equal(await ui.lsk('DL-INDEX', 'R1'), false);
});

test('fpln before START: the same text and the same calls whether the uplink is stopped or running', async (t) => {
  const run = async (status) => {
    const ui = await mountDatalinkPages(t, `fpln-${status}`, { fpln: true });
    const { fmc, gaugeDev, rows, shell } = ui;
    gaugeDev.scenario(status);
    await ui.scenario('leg');
    const screens = [];
    fmc.showPage('FPLN');
    await settle();
    screens.push(rows());
    await ui.lsk('FPLN', 'R6');
    await ui.lsk('FPLN-CONFIRM', 'R6');
    screens.push(rows(), shell.scratchpad);
    await ui.lsk('FPLN-RESULT', 'L6');
    screens.push(rows());
    await ui.lsk('FPLN', 'R3');
    screens.push(rows(), shell.scratchpad);
    gaugeDev.simbriefScenario('no-config');
    fmc.showPage('FPLN');
    await settle();
    screens.push(rows());
    const methods = plain(gaugeDev.calls).map((call) => call.method)
      .filter((method) => SIMBRIEF_METHODS.includes(method) || ['startUplink', 'stopUplink', 'restartSidecar', 'watchDatalink'].includes(method));
    return { screens, methods };
  };
  const stopped = await run('stopped');
  const online = await run('online');
  assert.deepEqual(stopped, online);
  assert.deepEqual(stopped.methods, ['getSimbriefSettings', 'prefileSimbrief', 'getSimbriefSettings', 'clearPrefiledLeg', 'getSimbriefSettings']);
  assert.deepEqual(stopped.screens.at(-1).slice(1, 3), [['SERVER NOT CONFIGURED'], ['COMPLETE CFG NETWORK']]);
  assert.deepEqual(stopped.screens.at(-1)[11], ['<MENU', '']);
});

test('simbrief token sentinel never reaches a result, a state, a recorded call or the screen', async (t) => {
  const { host, gaugeDev } = await loadMock();
  const seen = [];
  host.onDatalink((state) => seen.push(plain(state)));
  await host.setConfig({ ingestToken: SIMBRIEF_SENTINEL });
  for (const datalink of ['leg', 'flight', 'no-flight-plan']) {
    for (const name of Object.keys(SIMBRIEF_SCENARIOS)) {
      gaugeDev.datalinkScenario(datalink);
      seen.push(gaugeDev.simbriefScenario(name));
      seen.push(plain(await host.getSimbriefSettings()), plain(await host.prefileSimbrief()));
      seen.push(plain(await host.getDatalinkState()), plain(await host.clearPrefiledLeg()), plain(await host.getDatalinkState()));
    }
  }
  assert.ok(seen.length > 30 * 3 * 6);
  assert.equal(JSON.stringify({ seen, calls: gaugeDev.calls }).includes(SIMBRIEF_SENTINEL), false);

  const ui = await mountDatalinkPages(t, 'fpln-sentinel', { fpln: true });
  await ui.host.setConfig({ ingestToken: SIMBRIEF_SENTINEL });
  const screens = [];
  const look = () => screens.push(ui.shell.title, ui.rows(), ui.shell.scratchpad);
  for (const name of Object.keys(SIMBRIEF_SCENARIOS)) {
    ui.gaugeDev.datalinkScenario('leg');
    ui.gaugeDev.simbriefScenario('configured');
    ui.fmc.showPage('FPLN');
    await settle();
    await ui.lsk('FPLN', 'R6');
    ui.gaugeDev.simbriefScenario(name);
    await ui.lsk('FPLN-CONFIRM', 'R6');
    look();
    ui.fmc.showPage('FPLN');
    await settle();
    look();
    await ui.lsk('FPLN', 'R3');
    look();
    ui.fmc.showPage('DL-INDEX');
    await settle();
    look();
  }
  assert.equal(JSON.stringify({ screens, calls: ui.gaugeDev.calls }).includes(SIMBRIEF_SENTINEL), false);
});
