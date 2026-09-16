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
  const context = vm.createContext({ window: {} });
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
 */
async function mountDatalinkPages(t, tag, overrides = {}) {
  globalThis.document = fakeDocument();
  const { register } = await import(new URL(`../../ui/src/pages/datalink-pages.js?${tag}`, import.meta.url));
  const write = await import(new URL(`../../ui/src/pages/datalink-write-pages.js?${tag}`, import.meta.url));
  const { host, gaugeDev } = await loadMock();
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
    watchDatalink: (on) => run(() => host.watchDatalink(on)),
    refreshDatalink: () => run(() => host.refreshDatalink()),
    getDatalinkThread: (req) => run(() => host.getDatalinkThread(req)),
    getCannedMessages: () => run(() => host.getCannedMessages()),
    sendCannedMessage: (req) => run(() => (overrides.sendCannedMessage || host.sendCannedMessage)(req)),
    requestWeather: (req) => run(() => host.requestWeather(req)),
    requestLoadsheet: (req) => run(() => host.requestLoadsheet(req)),
    setPageNumber: (n, m) => { shell.number = m > 1 ? `${n}/${m}` : ''; },
  };
  host.onDatalink((state) => {
    shell.datalink = plain(state);
    const page = pages.get(shell.id);
    if (page && page.onDatalink) page.onDatalink(shell.datalink);
  });
  write.register(fmc, register(fmc));
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
