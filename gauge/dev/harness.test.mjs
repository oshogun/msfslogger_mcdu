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
  // The CFG pages look for their feedback line and field values; there are none here.
  return { createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => [] };
}

/**
 * Every DATALINK page, registered the way ui/src/pages/index.js does, behind
 * the parts of the shell they use (same scratchpad and page-change rules as
 * app.js) and wired to the mock host. Leaving to MENU afterwards releases the
 * lease, so a failing test cannot leave the renew interval holding Node open.
 *
 * `overrides.fpln` also registers the FPLN pages and `overrides.clearance` the
 * clearance pages; `overrides.cfg` registers everything through
 * ui/src/pages/index.js instead, CFG pages included; `overrides.via` routes
 * every host call through another object (an adopted bridge) instead of the mock.
 */
async function mountDatalinkPages(t, tag, overrides = {}) {
  globalThis.document = fakeDocument();
  const { register } = await import(new URL(`../../ui/src/pages/datalink-pages.js?${tag}`, import.meta.url));
  const write = await import(new URL(`../../ui/src/pages/datalink-write-pages.js?${tag}`, import.meta.url));
  const { host, gaugeDev } = overrides.mock || await loadMock();
  const api = overrides.via || host;
  const pages = new Map();
  const shell = { id: null, view: null, scratchpad: null, entry: '', number: '', datalink: null, title: '', config: null };
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
    requestClearance: (req) => run(() => (overrides.requestClearance || api.requestClearance)(req)),
    getConfigCache: () => shell.config,
    setConfig: (patch) => api.setConfig(patch),
    refreshConfig: async () => {
      const result = plain(await api.getConfig());
      shell.config = result.raw || result.config;
    },
  };
  host.onDatalink((state) => {
    shell.datalink = plain(state);
    const page = pages.get(shell.id);
    if (page && page.onDatalink) page.onDatalink(shell.datalink);
  });
  if (overrides.cfg) {
    await fmc.refreshConfig();
    (await import(new URL(`../../ui/src/pages/index.js?${tag}`, import.meta.url))).register(fmc);
  } else {
    const shared = register(fmc);
    write.register(fmc, shared);
    if (overrides.clearance) {
      (await import(new URL(`../../ui/src/pages/datalink-clearance-pages.js?${tag}`, import.meta.url))).register(fmc, shared);
    }
  }
  if (overrides.fpln && !overrides.cfg) {
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
  assert.deepEqual(await scopeLine(), ['LEG 12', '', 'CLEARANCE>']);
  assert.equal(await ui.lsk('DL-INDEX', 'R1'), false);
  const epochBefore = shell.datalink.thread.epoch;

  for (const name of ['configured', 'duplicate']) {
    gaugeDev.datalinkScenario('leg');
    gaugeDev.simbriefScenario(name);
    await prefileFromFpln();
    await ui.lsk('FPLN-RESULT', 'R5');
    assert.equal(shell.id, 'DL-INDEX');
    assert.deepEqual([...rows()[1], ...rows()[8], ...rows()[9]], ['PREFILE', 'CLR PREFILE>', 'PREFILED LEG', '4812', 'CLEARANCE>'], name);
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
  assert.deepEqual([rows()[1], rows()[8], rows()[9], shell.scratchpad], [['LEG 12'], [''], ['', 'CLEARANCE>'], ['PREFILE CLEARED', 'advisory']]);
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
  assert.deepEqual(await scopeLine(), ['LEG 12', '', 'CLEARANCE>']);

  // The other clearing events the mock can produce.
  const events = {
    'a datalink scenario change': async () => { gaugeDev.datalinkScenario('leg'); },
    'a different server URL': async () => { await host.setConfig({ serverUrl: 'http://other.invalid' }); },
    'a different ingest token': async () => { await host.setConfig({ ingestToken: 'another-token' }); },
    'a flight': async () => { gaugeDev.datalinkScenario('flight'); },
    'a rejected token': async () => { gaugeDev.datalinkScenario('invalid-token'); },
  };
  const own = { 'a flight': ['FLT 92 LEG 12', '', 'CLEARANCE>'], 'a rejected token': ['----', '', 'CLEARANCE>'] };
  for (const [event, run] of Object.entries(events)) {
    gaugeDev.datalinkScenario('leg');
    gaugeDev.simbriefScenario('configured');
    await prefileFromFpln();
    assert.deepEqual(await scopeLine(), ['PREFILE', 'CLR PREFILE>', '4812', 'CLEARANCE>'], event);
    await run();
    await settle();
    assert.deepEqual([...rows()[1], ...rows()[9]], own[event] || ['LEG 12', '', 'CLEARANCE>'], event);
    assert.equal('prefiledLeg' in shell.datalink, false, event);
  }
  // Saving the same server and token keeps it.
  gaugeDev.datalinkScenario('leg');
  await prefileFromFpln();
  await host.setConfig({ serverUrl: 'http://other.invalid', ingestToken: 'another-token', trafficRadiusM: 45000 });
  assert.deepEqual(await scopeLine(), ['PREFILE', 'CLR PREFILE>', '4812', 'CLEARANCE>']);

  // A prefile seen with a flight never takes the scope.
  gaugeDev.datalinkScenario('flight');
  await prefileFromFpln();
  assert.deepEqual(await scopeLine(), ['FLT 92 LEG 12', '', 'CLEARANCE>']);

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
  assert.deepEqual([...refusing.rows()[1], ...refusing.rows()[9]], ['PREFILE', 'CLR PREFILE>', '4812', 'CLEARANCE>']);
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
    assert.deepEqual([rows()[1], rows()[8], rows()[9]], [['PREFILE', 'CLR PREFILE>'], ['PREFILED LEG'], [String(id), 'CLEARANCE>']], `${id} DL-INDEX`);
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

// ── Clearance ────────────────────────────────────────────────────────────────

const CLEARANCE_SENTINEL = 'SENTINEL-CLEARANCE-TOKEN-0000';
const SERVER_TEXT_SENTINEL = 'SENTINEL-SERVER-ERROR-TEXT-DO-NOT-SHOW';
const SHORT_ROUTE = 'GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI UN514 NUMPO BOGNA1H';
const ROUTE_FIXES = ['GREKI', 'DCT', 'MARTN', 'N251A', 'JOOPY', 'NATW', 'GISTI', 'UN514', 'NUMPO', 'L9', 'KONAN', 'UL607', 'REDFA', '5530N02000W', 'M626', 'SUNOT'];
/** A route of exactly `n` characters made of real-looking fixes, never ending in a space. */
function routeOfLength(n) {
  const parts = [];
  let length = -1;
  for (let i = 0; length < n; i += 1) {
    const fix = ROUTE_FIXES[i % ROUTE_FIXES.length];
    parts.push(fix);
    length += fix.length + 1;
  }
  const route = parts.join(' ').slice(0, n);
  return route.endsWith(' ') ? `${route.slice(0, -1)}X` : route;
}
const CLEARANCE_RESULT_KEYS = ['created', 'departure', 'destination', 'httpStatus', 'initialAltitudeFt', 'plannedLegId', 'route', 'squawk'];
const clearanceResult = (changes = {}) => ({
  plannedLegId: 12, created: true, departure: 'KJFK', destination: 'EGLL', route: SHORT_ROUTE,
  initialAltitudeFt: 5000, squawk: '4521', httpStatus: 201, ...changes,
});
/** The six mock scenarios that issue a clearance, as the mock answers them for leg 12. */
const CLEARANCE_OK = {
  created: clearanceResult(),
  'not-created': clearanceResult({ created: false, httpStatus: 200 }),
  'long-route': clearanceResult({ route: routeOfLength(1200) }),
  'null-route-and-icaos': clearanceResult({ departure: null, destination: null, route: null }),
  'fl-altitude': clearanceResult({ initialAltitudeFt: 18000 }),
  'ft-altitude': clearanceResult({ initialAltitudeFt: 4500 }),
};
/** Scenario → [code, httpStatus, serverCode, CDU text, confirm-page hint]. `host-error` rejects. */
const CLEARANCE_ERRORS = {
  'leg-not-found': ['leg-not-found', 404, 'PLANNED_LEG_NOT_FOUND', 'PLANNED LEG NOT FOUND', ''],
  'no-flight-plan': ['clearance-no-flight-plan', 409, 'NO_FLIGHT_PLAN', 'NO DISPATCH RELEASE ON FILE', 'IMPORT THE PLAN FROM SIMBRIEF'],
  'invalid-token': ['token-invalid', 401, 'INVALID_INGEST_TOKEN', 'INGEST TOKEN REJECTED', 'CHECK INGEST TOKEN ON CFG NETWORK'],
  'token-missing': ['token-missing', 401, null, 'CLEARANCE TOKEN NOT RECEIVED', 'TOKEN HEADER LOST IN TRANSIT'],
  unavailable: ['clearance-unavailable', 401, null, 'CLEARANCE UNAVAILABLE', 'SERVER UPDATE NEEDED'],
  rejected: ['rejected', 403, 'CROSS_ORIGIN', 'CLEARANCE REJECTED 403', ''],
  'http-error': ['http-error', 500, null, 'CLEARANCE FAULT 500', 'SAFE TO REQUEST AGAIN'],
  'unknown-code': ['some-future-code', null, null, 'CLEARANCE FAULT', 'SAFE TO REQUEST AGAIN'],
  'bad-response': ['bad-response', 201, null, 'CLEARANCE BAD DATA', 'SAFE TO REQUEST AGAIN'],
  'too-large': ['too-large', null, null, 'CLEARANCE BAD DATA', 'SAFE TO REQUEST AGAIN'],
  unreachable: ['unreachable', null, null, 'CLEARANCE NO COMM', 'SAFE TO REQUEST AGAIN'],
  'tls-error': ['tls-error', null, null, 'CLEARANCE CERT FAULT', 'CHECK CERTIFICATE PATH'],
  'client-timeout': ['timeout', null, null, 'CLEARANCE RESULT UNKNOWN', 'SAFE TO REQUEST AGAIN'],
  'relay-timeout': ['shell-timeout', null, null, 'CLEARANCE RESULT UNKNOWN', 'SAFE TO REQUEST AGAIN'],
  busy: ['busy', null, null, 'DATALINK BUSY', ''],
  'in-progress': ['clearance-in-progress', null, null, 'CLEARANCE IN PROGRESS', ''],
  'no-config': ['no-config', null, null, 'DATALINK NO CONFIG', 'COMPLETE CFG NETWORK'],
  'sidecar-exited': ['sidecar-exited', null, null, 'DATALINK OFFLINE', 'SAFE TO REQUEST AGAIN'],
  'sidecar-unavailable': ['sidecar-unavailable', null, null, 'DATALINK OFFLINE', ''],
  'sidecar-outdated': ['sidecar-outdated', null, null, 'SIDECAR UPDATE REQUIRED', 'REBUILD SIDECAR THEN RESTART APP'],
  'not-supported': ['host-unsupported', null, null, 'CLEARANCE NOT SUPPORTED', ''],
  'host-error': ['host-error', null, null, 'CLEARANCE HOST FAULT', 'SAFE TO REQUEST AGAIN'],
};
const CLEARANCE_SCENARIOS = [...Object.keys(CLEARANCE_OK), ...Object.keys(CLEARANCE_ERRORS)];
/** Every clearance string at its widest placeholder, and the column count it was frozen at. */
const CLEARANCE_STRINGS = [
  ['index.prompt', 'CLEARANCE>', 10],
  ['refusal.noFlightPlan', 'NO FLIGHT PLAN', 14],
  ['refusal.noLinkedLeg', 'NO LINKED LEG', 13],
  ['refusal.scopePending', 'SCOPE UPDATE PENDING', 20],
  ['refusal.tokenRejected', 'INGEST TOKEN REJECTED', 21],
  ['refusal.noConfig', 'DATALINK NO CONFIG', 18],
  ['refusal.legChanged', 'CLEARANCE LEG CHANGED', 21],
  ['text.confirmTitle', 'REQUEST CLEARANCE', 17],
  ['text.confirmHeading', 'CLEARANCE REQUEST', 17],
  ['text.simulatedPdc', 'SIMULATED PDC', 13],
  ['text.to', 'TO', 2],
  ['text.noPending', 'NO PENDING REQUEST', 18],
  ['text.lastRequest', 'LAST REQUEST', 12],
  ['text.cancel', '<CANCEL', 7],
  ['text.send', 'SEND*', 5],
  ['text.sending', 'SENDING', 7],
  ['text.return', '<RETURN', 7],
  ['text.resultTitle', 'CLEARANCE', 9],
  ['text.marker', 'SIMULATED CLEARANCE', 19],
  ['text.notReal', 'NOT FOR REAL WORLD USE', 22],
  ['text.alreadyIssued', 'ALREADY ISSUED', 14],
  ['text.unknownIcao', '----', 4],
  ['text.initialAlt', 'INITIAL ALT', 11],
  ['text.squawk', 'SQUAWK', 6],
  ['text.clearedVia', 'CLEARED VIA', 11],
  ['text.noRoute', 'NO ROUTE ON FILE', 16],
  ['text.noResult', 'NO CLEARANCE RECEIVED', 21],
  ['text.messages', 'MESSAGES>', 9],
  ['text.noAltitude', '-----', 5],
  ['text.leg', 'LEG 9007199254740991', 20],
  ['text.pair', 'ABCDEFGH TO ABCDEFGH', 20],
  ['text.altitudeFt', '17999FT', 7],
  ['text.altitudeFl', 'FL1000', 6],
  ['text.squawkValue', '7777', 4],
  ['advisory.created', 'CLEARANCE RECEIVED', 18],
  ['advisory.onFile', 'CLEARANCE ON FILE', 17],
  ['hint.unknown', 'SAFE TO REQUEST AGAIN', 21],
  ['error.leg-not-found', 'PLANNED LEG NOT FOUND', 21],
  ['error.clearance-no-flight-plan', 'NO DISPATCH RELEASE ON FILE', 27],
  ['hint.clearance-no-flight-plan', 'IMPORT THE PLAN FROM SIMBRIEF', 29],
  ['error.clearance-unavailable', 'CLEARANCE UNAVAILABLE', 21],
  ['hint.clearance-unavailable', 'SERVER UPDATE NEEDED', 20],
  ['error.token-invalid', 'INGEST TOKEN REJECTED', 21],
  ['hint.token-invalid', 'CHECK INGEST TOKEN ON CFG NETWORK', 33],
  ['error.token-missing', 'CLEARANCE TOKEN NOT RECEIVED', 28],
  ['hint.token-missing', 'TOKEN HEADER LOST IN TRANSIT', 28],
  ['error.rejected', 'CLEARANCE REJECTED 403', 22],
  ['error.http-error', 'CLEARANCE FAULT 599', 19],
  ['error.bad-response', 'CLEARANCE BAD DATA', 18],
  ['error.too-large', 'CLEARANCE BAD DATA', 18],
  ['error.unreachable', 'CLEARANCE NO COMM', 17],
  ['error.tls-error', 'CLEARANCE CERT FAULT', 20],
  ['hint.tls-error', 'CHECK CERTIFICATE PATH', 22],
  ['error.timeout', 'CLEARANCE RESULT UNKNOWN', 24],
  ['error.shell-timeout', 'CLEARANCE RESULT UNKNOWN', 24],
  ['error.no-config', 'DATALINK NO CONFIG', 18],
  ['hint.no-config', 'COMPLETE CFG NETWORK', 20],
  ['error.bad-request', 'INVALID ENTRY', 13],
  ['error.clearance-in-progress', 'CLEARANCE IN PROGRESS', 21],
  ['error.busy', 'DATALINK BUSY', 13],
  ['error.sidecar-exited', 'DATALINK OFFLINE', 16],
  ['error.sidecar-unavailable', 'DATALINK OFFLINE', 16],
  ['error.sidecar-outdated', 'SIDECAR UPDATE REQUIRED', 23],
  ['hint.sidecar-outdated', 'REBUILD SIDECAR THEN RESTART APP', 32],
  ['error.host-unsupported', 'CLEARANCE NOT SUPPORTED', 23],
  ['error.host-error', 'CLEARANCE HOST FAULT', 20],
  ['error.unknown', 'CLEARANCE FAULT', 15],
];
const CELL_MAX = 48;
const ROW_MAX = 47;

/** One cell within 48 columns, and two cells sharing a row within 47. */
function assertClearanceWidths(screen, where) {
  for (const line of screen) {
    for (const cell of line) assert.ok(cell.length <= CELL_MAX, `${where}: ${JSON.stringify(cell)}`);
    if (line.length === 2) assert.ok(line[0].length + line[1].length <= ROW_MAX, `${where}: ${JSON.stringify(line)}`);
  }
}

const importBridgeWith = async (window, tag) => {
  globalThis.window = window;
  try {
    return (await import(new URL(`../../ui/src/bridge.js?${tag}`, import.meta.url))).default;
  } finally {
    delete globalThis.window;
  }
};

/** Put a datalink state on screen as if the shell had just received it. */
function showState(ui, state) {
  ui.shell.datalink = state;
  const page = ui.pages.get(ui.shell.id);
  if (page && page.onDatalink) page.onDatalink(state);
}

/** `ui.shell.datalink` with its scope and held prefiled leg replaced. */
function withScope(ui, scope, heldLegId = null, changes = {}) {
  const { prefiledLeg, ...rest } = ui.shell.datalink;
  const state = { ...rest, scope, ...changes };
  if (heldLegId !== null) state.prefiledLeg = { plannedLegId: heldLegId, label: SAMPLE_LABEL };
  return state;
}

test('clearance mock: requestClearance answers every scenario with the host contract shape', async () => {
  const { host, gaugeDev } = await loadMock();
  assert.equal(typeof host.requestClearance, 'function');
  assert.equal(CLEARANCE_SCENARIOS.length, 28);
  assert.throws(() => gaugeDev.clearanceScenario('nope'), { message: 'Unknown clearance scenario: nope' });
  assert.throws(() => gaugeDev.clearanceScenario('_default'), { message: 'Unknown clearance scenario: _default' });
  assert.deepEqual([gaugeDev.setClearanceDelay('x'), gaugeDev.setClearanceDelay(-5), gaugeDev.setClearanceDelay(0)], [0, 0, 0]);

  // Default scenario: created.
  gaugeDev.datalinkScenario('flight');
  assert.deepEqual(plain(await host.requestClearance({ plannedLegId: 77 })), { ok: true, result: { ...CLEARANCE_OK.created, plannedLegId: 77 } });

  for (const name of CLEARANCE_SCENARIOS) {
    gaugeDev.datalinkScenario('flight');
    const before = withoutClock(await host.getDatalinkState());
    const callsBefore = callsOf(gaugeDev, 'requestClearance').length;
    assert.equal(gaugeDev.clearanceScenario(name), name);
    if (name === 'host-error') {
      await assert.rejects(host.requestClearance({ plannedLegId: 77 }), { message: 'mock host fault' });
    } else {
      const response = plain(await host.requestClearance({ plannedLegId: 77 }));
      if (CLEARANCE_OK[name]) {
        assert.deepEqual(Object.keys(response.result).sort(), CLEARANCE_RESULT_KEYS, name);
        assert.deepEqual(response, { ok: true, result: { ...CLEARANCE_OK[name], plannedLegId: 77 } }, name);
      } else {
        const [code, httpStatus, serverCode] = CLEARANCE_ERRORS[name];
        if (name === 'leg-not-found' || name === 'no-flight-plan') {
          assert.ok(response.error.serverError.startsWith(SERVER_TEXT_SENTINEL), name);
          delete response.error.serverError;
        }
        assert.deepEqual(response, { ok: false, error: { code, httpStatus, serverCode } }, name);
      }
    }
    const calls = callsOf(gaugeDev, 'requestClearance');
    assert.equal(calls.length, callsBefore + 1, name);
    assert.deepEqual(Object.keys(calls.at(-1)).sort(), ['args', 'at', 'method']);
    assert.deepEqual(calls.at(-1).args, [{ plannedLegId: 77 }], name);
    // Leg 77 is not the thread's leg, so only the token latch may change anything.
    const after = withoutClock(await host.getDatalinkState());
    if (name === 'invalid-token') assert.deepEqual([after.state, after.scope, after.thread], ['dl.token-invalid', null, null]);
    else assert.deepEqual(after, before, name);
  }

  // The token latch happens once per selection, and drops a held prefiled leg.
  gaugeDev.datalinkScenario('leg');
  gaugeDev.simbriefScenario('prefiled');
  gaugeDev.clearanceScenario('invalid-token');
  assert.equal(plain(await host.requestClearance({ plannedLegId: 4812 })).error.code, 'token-invalid');
  let state = plain(await host.getDatalinkState());
  assert.deepEqual([state.state, 'prefiledLeg' in state, state.scope], ['dl.token-invalid', false, null]);
  gaugeDev.datalinkScenario('leg');
  await host.requestClearance({ plannedLegId: 12 });
  assert.equal(plain(await host.getDatalinkState()).state, 'dl.ok');

  // Not found drops the held leg only when it is the leg asked for.
  gaugeDev.datalinkScenario('leg');
  gaugeDev.simbriefScenario('prefiled');
  gaugeDev.clearanceScenario('leg-not-found');
  await host.requestClearance({ plannedLegId: 12 });
  assert.equal(plain(await host.getDatalinkState()).prefiledLeg.plannedLegId, 4812);
  await host.requestClearance({ plannedLegId: 4812 });
  state = plain(await host.getDatalinkState());
  assert.deepEqual(['prefiledLeg' in state, state.scope], [false, LEG]);

  // Malformed requests are refused and still recorded.
  gaugeDev.clearanceScenario('created');
  const malformed = [undefined, null, {}, [], 'x', { plannedLegId: 0 }, { plannedLegId: '12' }, { plannedLegId: 12.5 }, { plannedLegId: 2 ** 53 }];
  for (const req of malformed) {
    assert.deepEqual(plain(await host.requestClearance(req)), localError('bad-request'), JSON.stringify(req));
  }

  // The first clearance for the thread's leg adds the request and the PDC reply, once.
  gaugeDev.datalinkScenario('leg');
  const epoch = plain(await host.getDatalinkState()).thread.epoch;
  const heard = [];
  host.onDatalink((next) => heard.push(plain(next)));
  await host.requestClearance({ plannedLegId: 12 });
  const thread = [...(await readWholeThread(host, epoch, 5)).values()];
  assert.deepEqual(thread.slice(3).map((m) => [m.seq, m.direction, m.category, m.label, m.correlationId]), [
    [3, 'downlink', 'pdc', 'REQUEST CLEARANCE', null], [4, 'uplink', 'pdc', 'PDC', thread[3].id],
  ]);
  assert.equal(thread[3].body, 'REQUEST CLEARANCE');
  assert.equal(thread[4].body, ['PDC', 'KJFK TO EGLL', `CLEARED VIA ${SHORT_ROUTE}`, 'CLIMB AND MAINTAIN 5000FT', 'SQUAWK 4521',
    'SIMULATED CLEARANCE - NOT FOR REAL WORLD USE'].join('\n'));
  assert.equal(heard.length, 1);
  await host.requestClearance({ plannedLegId: 12 });
  await host.requestClearance({ plannedLegId: 77 });
  assert.deepEqual([plain(await host.getDatalinkState()).thread.total, heard.length], [5, 1]);

  gaugeDev.setClearanceDelay(40);
  const started = Date.now();
  await host.requestClearance({ plannedLegId: 77 });
  assert.ok(Date.now() - started >= 30);
  gaugeDev.setClearanceDelay(0);

  // The preview offers every scenario and applies the selection on change and on load.
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const select = /<label>Clearance <select id="clearance-scenario">([\s\S]*?)<\/select><\/label>/.exec(html);
  assert.ok(select);
  assert.deepEqual([...select[1].matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]).sort(), [...CLEARANCE_SCENARIOS].sort());
  const preview = await readFile(new URL('./preview.js', import.meta.url), 'utf8');
  assert.match(preview, /getElementById\('clearance-scenario'\)/);
  assert.match(preview, /gaugeDev\.clearanceScenario\(clearanceScenario\.value\)/);
  assert.match(preview, /frame\.addEventListener\('load', applyClearanceScenario\)/);
  assert.match(preview, /clearanceScenario\.addEventListener\('change', applyClearanceScenario\)/);
});

test('clearance vocab: the target-leg table, altitude and route rules, and every string within the column bound', async () => {
  const vocab = await pageModule('clearance-vocab.js');
  const { loadsheetLeg } = await pageModule('datalink-vocab.js');
  const { normaliseText } = await pageModule('datalink-text.js');
  const st = (scope, heldId) => (heldId
    ? { state: 'dl.ok', scope, prefiledLeg: { plannedLegId: heldId, label: SAMPLE_LABEL } }
    : { state: 'dl.ok', scope });
  const ground = (id, source = 'status') => ({ kind: 'leg', plannedLegId: id, source });
  const prefile = (id) => ({ kind: 'leg', plannedLegId: id, source: 'prefile' });
  const flight = (legId) => ({ kind: 'flight', flightId: 92, plannedLegId: legId });
  const rows = [
    ['T1', st(flight(12)), 12],
    ['T2', st(flight(null)), 'NO LINKED LEG'],
    ['T3', st(ground(12)), 12],
    ['T4', st(ground(12, 'ground-session')), 12],
    ['T5', st(prefile(4812), 4812), 4812],
    ['T6', st({ kind: 'none' }, 4812), 'SCOPE UPDATE PENDING'],
    ['T7', st(null, 4812), 'SCOPE UPDATE PENDING'],
    ['T8', st(ground(12), 4812), 'SCOPE UPDATE PENDING'],
    ['T8 fault', { state: 'dl.unreachable', scope: ground(12), prefiledLeg: { plannedLegId: 4812, label: SAMPLE_LABEL } }, 'SCOPE UPDATE PENDING'],
    ['T9', st(prefile(4812), 4813), 'SCOPE UPDATE PENDING'],
    ['T10', st(flight(12), 4812), 12],
    ['T11', st(flight(null), 4812), 'NO LINKED LEG'],
    ['T12', st(prefile(4812)), 'SCOPE UPDATE PENDING'],
    ['T12 fault', { state: 'dl.timeout', scope: prefile(4812) }, 'SCOPE UPDATE PENDING'],
    ['T13', st({ kind: 'none' }), 'NO FLIGHT PLAN'],
    ['T14', { state: 'dl.idle', scope: null }, 'NO FLIGHT PLAN'],
    ['T14 pending', { state: 'dl.pending', scope: null }, 'NO FLIGHT PLAN'],
    ['T15', null, 'NO FLIGHT PLAN'],
    ['T16', { state: 'dl.token-invalid', scope: ground(12) }, 'INGEST TOKEN REJECTED'],
    ['T17', { state: 'dl.no-config', scope: ground(12) }, 'DATALINK NO CONFIG'],
    ['T18', { state: 'dl.unavailable', scope: null }, 'NO FLIGHT PLAN'],
    ['T19', { state: 'dl.unreachable', scope: ground(12) }, 12],
    ['T19 timeout', { state: 'dl.timeout', scope: ground(12) }, 12],
    ['T20', { state: 'dl.sidecar-outdated', scope: null }, 'NO FLIGHT PLAN'],
    ['T20 unavailable', { state: 'dl.sidecar-unavailable', scope: null }, 'NO FLIGHT PLAN'],
    ['T21', { state: 'dl.ok', scope: ground(12), prefiledLeg: { plannedLegId: 4812 } }, 12],
    ['T22', st(ground(0)), 'NO FLIGHT PLAN'],
    ['T23', st({ kind: 'airport', plannedLegId: 12 }), 'NO FLIGHT PLAN'],
  ];
  // Where the clearance rule refuses a leg the load sheet rule would take, or says why differently.
  const differs = new Set(['T6', 'T7', 'T8', 'T8 fault', 'T9', 'T12', 'T12 fault', 'T16', 'T17', 'T22']);
  for (const [id, state, expected] of rows) {
    const got = vocab.clearanceLeg(state);
    assert.deepEqual(got, typeof expected === 'number' ? { ok: true, plannedLegId: expected } : { ok: false, text: expected }, id);
    const sheet = loadsheetLeg(state ? state.scope : null);
    assert.equal(JSON.stringify(sheet) === JSON.stringify(got), !differs.has(id), `${id} against loadsheetLeg`);
  }
  assert.deepEqual(vocab.clearanceLeg('dl.ok'), { ok: false, text: 'NO FLIGHT PLAN' });

  for (const [ft, text] of [[0, '0FT'], [4500, '4500FT'], [5000, '5000FT'], [17999, '17999FT'], [18000, 'FL180'], [18049, 'FL180'],
    [18050, 'FL181'], [35000, 'FL350'], [99999, 'FL1000'], [-1, '-----'], [4500.5, '-----'], ['5000', '-----'], [null, '-----'], [NaN, '-----']]) {
    assert.equal(vocab.formatAltitude(ft), text, String(ft));
  }
  assert.equal(vocab.formatPair(clearanceResult()), 'KJFK TO EGLL');
  assert.equal(vocab.formatPair(clearanceResult({ departure: null, destination: '' })), '---- TO ----');

  for (const [route, pages] of [[SHORT_ROUTE, 1], [routeOfLength(1200), 4], [routeOfLength(4096), 11], ['X'.repeat(200), 1], ['GREKI DCT\r\nMARTN\tDCT', 1]]) {
    const m = vocab.routePageCount(route);
    assert.equal(m, pages, `${route.length} characters`);
    let rejoined = '';
    for (let p = 1; p <= m; p += 1) {
      const lines = vocab.routeLinesOnPage(route, p);
      assert.ok(lines.length > 0 && lines.length <= (p === 1 ? 5 : 9), `${route.length} page ${p}`);
      for (const line of lines) {
        assert.ok(line.text.length <= CELL_MAX);
        rejoined += line.text + line.join;
      }
    }
    assert.equal(rejoined, normaliseText(route), `${route.length} characters reassemble`);
    assert.deepEqual(vocab.routeLines(route), Array.from({ length: m }, (_, i) => vocab.routeLinesOnPage(route, i + 1)).flat());
  }
  assert.equal(routeOfLength(4096).length, 4096);
  assert.equal(vocab.routePageCount(null), 1);

  for (const [name, [code, httpStatus, serverCode, text, hint]] of Object.entries(CLEARANCE_ERRORS)) {
    const error = { code, httpStatus, serverCode, serverError: SERVER_TEXT_SENTINEL, message: SERVER_TEXT_SENTINEL };
    assert.deepEqual([vocab.errorText(error), vocab.errorHint(error)], [text, hint], name);
    assert.equal(vocab.isUnknownOutcome(code), hint === 'SAFE TO REQUEST AGAIN', name);
  }
  for (const status of [99, 600, null, '500', 500.5]) {
    assert.equal(vocab.errorText({ code: 'http-error', httpStatus: status }), 'CLEARANCE FAULT', String(status));
  }
  assert.equal(vocab.errorText({ code: 'http-error', httpStatus: 599 }), 'CLEARANCE FAULT 599');
  assert.deepEqual([vocab.errorText(undefined), vocab.errorHint(undefined)], ['CLEARANCE HOST FAULT', 'SAFE TO REQUEST AGAIN']);
  for (const malformed of [{}, [], { code: 7 }, { code: null }, { httpStatus: 500 }, 'text']) {
    assert.deepEqual([vocab.errorText(malformed), vocab.errorHint(malformed)], ['CLEARANCE HOST FAULT', 'SAFE TO REQUEST AGAIN'], JSON.stringify(malformed));
  }
  assert.deepEqual([vocab.errorText({ code: 'some-future-code' }), vocab.errorHint({ code: 'some-future-code' })], ['CLEARANCE FAULT', 'SAFE TO REQUEST AGAIN']);
  assert.deepEqual([vocab.errorText({ code: 'toString' }), vocab.errorText({ code: 'bad-request' }), vocab.errorHint({ code: 'bad-request' })],
    ['CLEARANCE FAULT', 'INVALID ENTRY', '']);

  const good = clearanceResult();
  assert.equal(vocab.isClearanceResult(good, 12), true);
  for (const [what, result, id] of [
    ['other leg', good, 13], ['null', null, 12], ['array', [good], 12], ['created string', { ...good, created: 'true' }, 12],
    ['squawk 8', { ...good, squawk: '4581' }, 12], ['squawk short', { ...good, squawk: '452' }, 12], ['squawk number', { ...good, squawk: 4521 }, 12],
    ['altitude negative', { ...good, initialAltitudeFt: -1 }, 12], ['altitude over', { ...good, initialAltitudeFt: 100000 }, 12],
    ['altitude fraction', { ...good, initialAltitudeFt: 5000.5 }, 12], ['icao 9', { ...good, departure: 'ABCDEFGHI' }, 12],
    ['icao number', { ...good, destination: 7 }, 12], ['route over', { ...good, route: 'X'.repeat(4097) }, 12], ['route missing', { ...good, route: undefined }, 12],
  ]) assert.equal(vocab.isClearanceResult(result, id), false, what);
  for (const result of [{ ...good, route: routeOfLength(4096) }, { ...good, departure: null, destination: null, route: null }, { ...good, initialAltitudeFt: 99999, squawk: '0000' }]) {
    assert.equal(vocab.isClearanceResult(result, 12), true);
  }

  // The string table is the whole vocabulary: nothing in it is too wide, and nothing outside it is shown.
  assert.equal(CLEARANCE_STRINGS.length, 67);
  for (const [id, text, columns] of CLEARANCE_STRINGS) {
    assert.equal(text.length, columns, id);
    assert.ok(text.length <= CELL_MAX, id);
  }
  const table = new Set(CLEARANCE_STRINGS.map(([, text]) => text));
  const produced = new Set([
    ...Object.values(vocab.REFUSAL), ...Object.values(vocab.TEXT), ...Object.values(vocab.ADVISORY),
    ...Object.values(vocab.ERRORS).flatMap((entry) => [entry.text, entry.hint]).filter(Boolean),
    vocab.SAFE_TO_REQUEST_AGAIN, vocab.UNKNOWN_CODE_TEXT,
    vocab.formatLeg(Number.MAX_SAFE_INTEGER), vocab.formatPair({ departure: 'ABCDEFGH', destination: 'ABCDEFGH' }),
    vocab.formatAltitude(17999), vocab.formatAltitude(99999), '7777', vocab.errorText({ code: 'http-error', httpStatus: 599 }),
  ]);
  assert.deepEqual([...produced].filter((text) => !table.has(text)), []);
  assert.deepEqual([...table].filter((text) => !produced.has(text)), []);
  const T = vocab.TEXT;
  const widestLeg = vocab.formatLeg(Number.MAX_SAFE_INTEGER);
  for (const [where, left, right] of [
    ['DL-INDEX row 10', String(Number.MAX_SAFE_INTEGER), T.indexPrompt],
    ['result row 1', T.marker, widestLeg],
    ['result row 2', vocab.formatPair({ departure: 'ABCDEFGH', destination: 'ABCDEFGH' }), T.alreadyIssued],
    ['result row 3', T.initialAlt, T.squawk],
    ['result row 4', vocab.formatAltitude(17999), '7777'],
    ['result row 12', T.return, T.messages],
    ['confirm row 12', T.cancel, T.send],
    ['confirm row 12 sending', '', T.sending],
    ['confirm row 12 no request', T.return, ''],
  ]) assert.ok(left.length + right.length <= ROW_MAX, where);
});

test('clearance DL-INDEX: R5 CLEARANCE> joins row 10 and every other row keeps its text and place', async (t) => {
  const bare = await mountDatalinkPages(t, 'clearance-unregistered');
  await bare.scenario('leg');
  bare.fmc.showPage('DL-INDEX');
  await settle();
  assert.deepEqual(bare.rows()[9], ['', 'CLEARANCE>']);
  assert.equal(await bare.lsk('DL-INDEX', 'R5'), false, 'no action until the clearance pages register one');

  const ui = await mountDatalinkPages(t, 'clearance-index', { clearance: true, fpln: true });
  const { shell, fmc, gaugeDev, rows, pages } = ui;
  assert.deepEqual([...pages.values()].map((page) => [page.id, page.title]).slice(8), [
    ['DL-CLEARANCE-CONFIRM', 'REQUEST CLEARANCE'], ['DL-CLEARANCE', 'CLEARANCE'], ['FPLN', 'FLIGHT PLAN'], ['FPLN-CONFIRM', 'PREFILE SIMBRIEF'], ['FPLN-RESULT', 'PREFILE'],
  ]);
  await ui.scenario('leg');
  fmc.showPage('DL-INDEX');
  await settle();
  const updated = () => rows()[0][1];
  assert.match(updated(), /^UPD \d{4}Z$/);
  assert.deepEqual(rows(), [
    ['SCOPE', updated()], ['LEG 12'], ['DATALINK'], ['DATALINK ONLINE'], [''], ['<MESSAGES', 'WX REQUEST>'],
    [''], ['<DOWNLINK', 'LOADSHEET>'], [''], ['', 'CLEARANCE>'], [''], ['<INDEX', 'REFRESH>'],
  ]);
  assert.equal(shell.view.children[9].children[1].className, 'cell-r prompt');

  gaugeDev.simbriefScenario('prefiled');
  await settle();
  assert.deepEqual(rows(), [
    ['SCOPE', updated()], ['PREFILE', 'CLR PREFILE>'], ['DATALINK'], ['DATALINK ONLINE'], [''], ['<MESSAGES', 'WX REQUEST>'],
    [''], ['<DOWNLINK', 'LOADSHEET>'], ['PREFILED LEG'], ['4812', 'CLEARANCE>'], [''], ['<INDEX', 'REFRESH>'],
  ]);

  // A 16-digit prefiled id and the prompt share row 10 with a gap to spare.
  const widest = Number.MAX_SAFE_INTEGER;
  showState(ui, withScope(ui, { kind: 'leg', plannedLegId: widest, source: 'prefile' }, widest));
  assert.deepEqual(rows()[9], ['9007199254740991', 'CLEARANCE>']);
  assert.equal(rows()[9].join('').length, 26);
  assertClearanceWidths(rows(), 'DL-INDEX 16-digit id');
  assert.equal(pages.get('DL-INDEX').onLsk('R5', {}), true);
  assert.deepEqual([shell.id, rows()[3]], ['DL-CLEARANCE-CONFIRM', ['LEG 9007199254740991']]);
  assertClearanceWidths(rows(), 'confirm 16-digit id');
  assert.equal(await ui.lsk('DL-CLEARANCE-CONFIRM', 'L6'), true);

  // The prompts that were there before still do what they did.
  await ui.scenario('leg');
  for (const [key, id] of [['L3', 'DL-THREAD'], ['L4', 'DL-CANNED'], ['R3', 'DL-WX'], ['R4', 'DL-LOADSHEET'], ['L6', 'MENU']]) {
    fmc.showPage('DL-INDEX');
    await settle();
    assert.equal(await ui.lsk('DL-INDEX', key), true, key);
    assert.equal(shell.id, id, key);
  }
  assert.equal(callsOf(gaugeDev, 'requestClearance').length, 0);
});

test('clearance request: nothing asks for one but the confirm key, once per press, and the thread then holds the PDC pair', async (t) => {
  const ui = await mountDatalinkPages(t, 'clearance-calls', { clearance: true });
  const { shell, fmc, gaugeDev, rows, pages } = ui;
  const clearances = () => callsOf(gaugeDev, 'requestClearance');
  await ui.scenario('leg');
  fmc.showPage('DL-INDEX');
  await later(30);
  assert.equal(clearances().length, 0, 'opening DL-INDEX');
  assert.equal(await ui.lsk('DL-INDEX', 'R5'), true);
  assert.deepEqual([shell.id, shell.title, shell.number, shell.scratchpad], ['DL-CLEARANCE-CONFIRM', 'REQUEST CLEARANCE', '', null]);
  assert.deepEqual(rows(), [['CLEARANCE REQUEST'], ['SIMULATED PDC'], ['TO'], ['LEG 12'], [''], [''], [''], [''], [''], [''], [''], ['<CANCEL', 'SEND*']]);
  await later(30);
  assert.equal(clearances().length, 0, 'R5 only opens the confirm page');
  assert.equal(await ui.lsk('DL-CLEARANCE-CONFIRM', 'L6'), true);
  assert.deepEqual([shell.id, clearances().length], ['DL-INDEX', 0]);
  fmc.showPage('DL-CLEARANCE-CONFIRM');
  assert.deepEqual(rows(), [[''], ['NO PENDING REQUEST'], [''], [''], [''], [''], [''], [''], [''], [''], [''], ['<RETURN', '']]);
  assert.equal(await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6'), false, 'nothing pending after CANCEL');
  assert.equal(await ui.lsk('DL-CLEARANCE-CONFIRM', 'L6'), true);
  fmc.showPage('DL-CLEARANCE');
  assert.deepEqual([shell.title, rows()], ['CLEARANCE', [[''], ['NO CLEARANCE RECEIVED'], [''], [''], [''], [''], [''], [''], [''], [''], [''], ['<RETURN', '']]]);
  assert.equal(await ui.lsk('DL-CLEARANCE', 'R6'), false);
  assert.equal(await ui.lsk('DL-CLEARANCE', 'L6'), true);
  assert.equal(clearances().length, 0);

  // In flight: SEND again, CANCEL and R5 from DL-INDEX do nothing more.
  await ui.lsk('DL-INDEX', 'R5');
  gaugeDev.setClearanceDelay(50);
  const confirm = pages.get('DL-CLEARANCE-CONFIRM');
  assert.equal(confirm.onLsk('R6', {}), true);
  assert.deepEqual([rows()[3], rows()[11]], [['LEG 12'], ['', 'SENDING']]);
  assert.equal(confirm.onLsk('R6', {}), true);
  assert.equal(confirm.onLsk('L6', {}), true);
  await settle();
  assert.deepEqual([shell.id, clearances().map((call) => call.args)], ['DL-CLEARANCE-CONFIRM', [[{ plannedLegId: 12 }]]]);
  fmc.showPage('DL-INDEX');
  await settle();
  assert.equal(await ui.lsk('DL-INDEX', 'R5'), true);
  assert.deepEqual([shell.id, rows()[3], rows()[11], clearances().length], ['DL-CLEARANCE-CONFIRM', ['LEG 12'], ['', 'SENDING'], 1]);
  await later(100);
  assert.deepEqual([shell.id, shell.title, shell.scratchpad, clearances().length], ['DL-CLEARANCE', 'CLEARANCE', ['CLEARANCE RECEIVED', 'advisory'], 1]);
  gaugeDev.setClearanceDelay(0);

  // The result, the thread and the message open without another request.
  assert.deepEqual(rows()[0], ['SIMULATED CLEARANCE', 'LEG 12']);
  assert.equal(await ui.lsk('DL-CLEARANCE', 'R6'), true);
  assert.equal(shell.id, 'DL-THREAD');
  assert.match(rows()[6][0], /^DN \d{4}Z REQUEST CLEARANCE$/);
  assert.match(rows()[8][0], /^UP \d{4}Z PDC$/);
  assert.deepEqual([rows()[7], rows()[9]], [['<REQUEST CLEARANCE'], ['<PDC']]);
  assert.equal(await ui.lsk('DL-THREAD', 'L5'), true);
  assert.equal(shell.id, 'DL-MSG');
  const body = rows().slice(1, 11).map((line) => line[0]);
  for (const line of ['PDC', 'KJFK TO EGLL', 'SQUAWK 4521', 'CLIMB AND MAINTAIN 5000FT', 'SIMULATED CLEARANCE - NOT FOR REAL WORLD USE']) {
    assert.ok(body.includes(line), line);
  }
  await ui.lsk('DL-MSG', 'L6');
  await ui.lsk('DL-THREAD', 'L6');
  assert.equal(shell.id, 'DL-INDEX');
  assert.equal(await ui.lsk('DL-INDEX', 'R5'), true);
  assert.deepEqual([shell.id, rows()[0]], ['DL-CLEARANCE', ['SIMULATED CLEARANCE', 'LEG 12']], 'R5 reopens the kept clearance');
  fmc.showPage('DL-THREAD');
  fmc.showPage('DL-MSG');
  fmc.showPage('DL-CLEARANCE');
  fmc.showPage('DL-INDEX');
  await later(100);
  assert.equal(clearances().length, 1);
});

test('clearance errors: every reachable answer shows its text and hint, never the server text, and nothing is sent again', async (t) => {
  const ui = await mountDatalinkPages(t, 'clearance-errors', { clearance: true });
  const { shell, fmc, gaugeDev, rows } = ui;
  const clearances = () => callsOf(gaugeDev, 'requestClearance').length;
  const screens = [];
  for (const [name, [, , , text, hint]] of Object.entries(CLEARANCE_ERRORS)) {
    await ui.scenario('leg');
    gaugeDev.clearanceScenario(name);
    fmc.showPage('DL-INDEX');
    await settle();
    await ui.lsk('DL-INDEX', 'R5');
    assert.equal(shell.id, 'DL-CLEARANCE-CONFIRM', name);
    const before = clearances();
    await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
    assert.deepEqual([shell.id, shell.scratchpad, clearances()], ['DL-INDEX', [text, 'error'], before + 1], name);
    screens.push(rows(), shell.scratchpad);
    await later(100);
    assert.equal(clearances(), before + 1, `${name} is never sent again`);
    if (name === 'invalid-token') {
      // The latch comes back as the datalink state, and the rule then refuses locally.
      assert.equal(rows()[3][0], 'INGEST TOKEN REJECTED');
      assert.equal(await ui.lsk('DL-INDEX', 'R5'), true);
      assert.deepEqual([shell.id, shell.scratchpad, clearances()], ['DL-INDEX', ['INGEST TOKEN REJECTED', 'error'], before + 1]);
      await ui.scenario('leg');
    }
    await ui.lsk('DL-INDEX', 'R5');
    assert.equal(shell.id, 'DL-CLEARANCE-CONFIRM', name);
    assert.deepEqual(rows().slice(3, 9), [['LEG 12'], [''], [''], ['LAST REQUEST'], [text], [hint]], name);
    assert.deepEqual(rows()[11], ['<CANCEL', 'SEND*']);
    screens.push(rows());
    await ui.lsk('DL-CLEARANCE-CONFIRM', 'L6');
    assert.equal(clearances(), before + 1, name);
  }

  // Answers the mock never gives: a non-envelope, a rejected call, results that are not a clearance for the leg.
  const odd = [
    [async () => 'not an envelope', 'CLEARANCE HOST FAULT'],
    [async () => { throw new Error('transport'); }, 'CLEARANCE HOST FAULT'],
    [async () => ({ ok: true, result: clearanceResult({ plannedLegId: 13 }) }), 'CLEARANCE BAD DATA'],
    [async () => ({ ok: true, result: clearanceResult({ squawk: '7800' }) }), 'CLEARANCE BAD DATA'],
    [async () => ({ ok: true }), 'CLEARANCE BAD DATA'],
    [async () => ({ ok: false, error: { code: 'http-error', httpStatus: 502, serverCode: null } }), 'CLEARANCE FAULT 502'],
    [async () => ({ ok: false, error: 'text' }), 'CLEARANCE HOST FAULT'],
    [async () => ({ ok: false, error: {} }), 'CLEARANCE HOST FAULT'],
    [async () => ({ ok: false }), 'CLEARANCE HOST FAULT'],
  ];
  for (const [index, [override, text]] of odd.entries()) {
    let asked = 0;
    const other = await mountDatalinkPages(t, `clearance-odd-${index}`, { clearance: true, requestClearance: (req) => { asked += 1; return override(req); } });
    await other.scenario('leg');
    other.fmc.showPage('DL-INDEX');
    await settle();
    await other.lsk('DL-INDEX', 'R5');
    await other.lsk('DL-CLEARANCE-CONFIRM', 'R6');
    assert.deepEqual([other.shell.id, other.shell.scratchpad], ['DL-INDEX', [text, 'error']], String(index));
    await other.lsk('DL-INDEX', 'R5');
    assert.deepEqual(other.rows().slice(6, 9), [['LAST REQUEST'], [text], ['SAFE TO REQUEST AGAIN']], String(index));
    screens.push(other.rows());
    await later(50);
    assert.equal(asked, 1, String(index));
  }

  for (const [index, screen] of screens.entries()) {
    if (Array.isArray(screen[0])) assertClearanceWidths(screen, `screen ${index}`);
  }
  const shown = JSON.stringify(screens);
  for (const hidden of [SERVER_TEXT_SENTINEL, 'PLANNED_LEG_NOT_FOUND', 'NO_FLIGHT_PLAN', 'INVALID_INGEST_TOKEN', 'CROSS_ORIGIN', 'some-future-code']) {
    assert.equal(shown.includes(hidden), false, hidden);
  }
});

test('clearance results: pair, route pages, altitude, squawk and markers as issued, and the PDC pair in the thread', async (t) => {
  const line1 = 'GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI';
  const line2 = 'UN514 NUMPO BOGNA1H';
  const page1 = (pair, marker, altitude, route) => [
    ['SIMULATED CLEARANCE', 'LEG 12'], [pair, marker], ['INITIAL ALT', 'SQUAWK'], [altitude, '4521'], ['CLEARED VIA'],
    ...route, ['NOT FOR REAL WORLD USE'], ['<RETURN', 'MESSAGES>'],
  ];
  const shortRoute = [[line1], [line2], [''], [''], ['']];
  const expected = {
    created: [page1('KJFK TO EGLL', '', '5000FT', shortRoute), 'CLEARANCE RECEIVED'],
    'not-created': [page1('KJFK TO EGLL', 'ALREADY ISSUED', '5000FT', shortRoute), 'CLEARANCE ON FILE'],
    'null-route-and-icaos': [page1('---- TO ----', '', '5000FT', [['NO ROUTE ON FILE'], [''], [''], [''], ['']]), 'CLEARANCE RECEIVED'],
    'fl-altitude': [page1('KJFK TO EGLL', '', 'FL180', shortRoute), 'CLEARANCE RECEIVED'],
    'ft-altitude': [page1('KJFK TO EGLL', '', '4500FT', shortRoute), 'CLEARANCE RECEIVED'],
  };
  assert.equal(`${line1} ${line2}`, SHORT_ROUTE);
  /** Every route line on every page, in order, with the blank rows after the last one dropped. */
  const readRoute = (ui, pages) => {
    const lines = [];
    for (let p = 1; p <= pages; p += 1) {
      assert.equal(ui.shell.number, pages > 1 ? `${p}/${pages}` : '');
      const screen = ui.rows();
      assertClearanceWidths(screen, `route page ${p}`);
      assert.deepEqual([screen[0], screen[10], screen[11]], [['SIMULATED CLEARANCE', 'LEG 12'], ['NOT FOR REAL WORLD USE'], ['<RETURN', 'MESSAGES>']]);
      lines.push(...(p === 1 ? screen.slice(5, 10) : screen.slice(1, 10)).map((line) => line[0]));
      assert.equal(ui.pages.get('DL-CLEARANCE').onPageKey(1), true);
    }
    assert.equal(ui.shell.number, pages > 1 ? `1/${pages}` : '', 'NEXT wraps to page 1');
    while (lines.length && lines.at(-1) === '') lines.pop();
    return lines;
  };

  for (const name of Object.keys(CLEARANCE_OK)) {
    const ui = await mountDatalinkPages(t, `clearance-result-${name}`, { clearance: true });
    const { shell, fmc, gaugeDev, rows, pages } = ui;
    await ui.scenario('leg');
    gaugeDev.clearanceScenario(name);
    fmc.showPage('DL-INDEX');
    await settle();
    await ui.lsk('DL-INDEX', 'R5');
    await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
    assert.equal(shell.id, 'DL-CLEARANCE', name);
    assertClearanceWidths(rows(), name);
    assert.equal(rows().flat().includes('ALREADY ISSUED'), name === 'not-created', name);
    assert.equal(rows().flat().includes('SIMULATED CLEARANCE'), true, name);
    if (name === 'long-route') {
      const route = CLEARANCE_OK[name].route;
      assert.deepEqual(rows().slice(0, 5), [['SIMULATED CLEARANCE', 'LEG 12'], ['KJFK TO EGLL', ''], ['INITIAL ALT', 'SQUAWK'], ['5000FT', '4521'], ['CLEARED VIA']]);
      assert.deepEqual(shell.scratchpad, ['CLEARANCE RECEIVED', 'advisory']);
      const lines = readRoute(ui, 4);
      assert.ok(lines.every((line) => line.length > 0 && line.length <= CELL_MAX));
      assert.equal(lines.join(' '), route, 'every route character, in order');
      assert.equal(pages.get('DL-CLEARANCE').onPageKey(-1), true);
      assert.equal(shell.number, '4/4', 'PREV wraps to the last page');
      assert.deepEqual(rows()[0], ['SIMULATED CLEARANCE', 'LEG 12']);
    } else {
      assert.deepEqual([rows(), shell.scratchpad, shell.number], [expected[name][0], [expected[name][1], 'advisory'], ''], name);
      assert.equal(pages.get('DL-CLEARANCE').onPageKey(1), true);
      assert.deepEqual(rows(), expected[name][0]);
    }
    assert.equal(await ui.lsk('DL-CLEARANCE', 'R6'), true);
    assert.equal(shell.id, 'DL-THREAD', name);
    assert.match(rows()[6][0], /^DN \d{4}Z REQUEST CLEARANCE$/, name);
    assert.match(rows()[8][0], /^UP \d{4}Z PDC$/, name);
    assert.equal(callsOf(gaugeDev, 'requestClearance').length, 1, name);
  }

  // The longest route the sidecar passes on pages to eleven screens with nothing lost.
  const longest = routeOfLength(4096);
  const ui = await mountDatalinkPages(t, 'clearance-result-4096', {
    clearance: true,
    requestClearance: async (req) => ({ ok: true, result: clearanceResult({ plannedLegId: req.plannedLegId, route: longest, created: false, httpStatus: 200, departure: 'ABCDEFGH', destination: 'ABCDEFGH' }) }),
  });
  await ui.scenario('leg');
  ui.fmc.showPage('DL-INDEX');
  await settle();
  await ui.lsk('DL-INDEX', 'R5');
  await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
  assert.deepEqual([ui.shell.id, ui.rows()[1], ui.shell.scratchpad], ['DL-CLEARANCE', ['ABCDEFGH TO ABCDEFGH', 'ALREADY ISSUED'], ['CLEARANCE ON FILE', 'advisory']]);
  assert.equal(readRoute(ui, 11).join(' '), longest);
});

test('clearance refusals: each refusing scope shows its text on DL-INDEX and asks the host for nothing', async (t) => {
  const ui = await mountDatalinkPages(t, 'clearance-refusals', { clearance: true, fpln: true });
  const { shell, fmc, gaugeDev, pages } = ui;
  const press = (text, where) => {
    shell.scratchpad = null;
    assert.equal(pages.get('DL-INDEX').onLsk('R5', {}), true, where);
    assert.deepEqual([shell.id, shell.scratchpad], ['DL-INDEX', [text, 'error']], where);
  };
  fmc.showPage('DL-INDEX');
  await settle();

  // Through the mock.
  await ui.scenario('no-flight-plan');
  press('NO FLIGHT PLAN', 'T13 scope none');
  await ui.scenario('invalid-token');
  press('INGEST TOKEN REJECTED', 'T16 token latched');
  await ui.scenario('unreachable');
  gaugeDev.simbriefScenario('prefiled');
  await settle();
  assert.deepEqual([shell.datalink.scope, shell.datalink.prefiledLeg.plannedLegId], [null, 4812]);
  press('SCOPE UPDATE PENDING', 'T7 a held leg the faulted datalink has not applied');
  await ui.scenario('sidecar-outdated');
  press('NO FLIGHT PLAN', 'T20 sidecar outdated');

  // States the mock cannot publish, put on screen directly.
  await ui.scenario('leg');
  const flight = (legId) => ({ kind: 'flight', flightId: 92, plannedLegId: legId });
  for (const [where, state, text] of [
    ['T2 flight without a linked leg', withScope(ui, flight(null)), 'NO LINKED LEG'],
    ['T6 held leg, scope none', withScope(ui, { kind: 'none' }, 4812), 'SCOPE UPDATE PENDING'],
    ['T8 held leg, ground scope', withScope(ui, { kind: 'leg', plannedLegId: 12, source: 'status' }, 4812), 'SCOPE UPDATE PENDING'],
    ['T9 new prefile held', withScope(ui, { kind: 'leg', plannedLegId: 4812, source: 'prefile' }, 4813), 'SCOPE UPDATE PENDING'],
    ['T11 flight without a leg, held leg', withScope(ui, flight(null), 4812), 'NO LINKED LEG'],
    ['T12 prefile scope, nothing held', withScope(ui, { kind: 'leg', plannedLegId: 4812, source: 'prefile' }), 'SCOPE UPDATE PENDING'],
    ['T17 no config', withScope(ui, { kind: 'leg', plannedLegId: 12, source: 'status' }, null, { state: 'dl.no-config' }), 'DATALINK NO CONFIG'],
    ['T22 leg 0', withScope(ui, { kind: 'leg', plannedLegId: 0, source: 'status' }), 'NO FLIGHT PLAN'],
    ['T23 unknown kind', withScope(ui, { kind: 'airport', plannedLegId: 12 }), 'NO FLIGHT PLAN'],
  ]) {
    showState(ui, state);
    press(text, where);
  }
  await later(50);
  assert.equal(callsOf(gaugeDev, 'requestClearance').length, 0);
});

test('clearance stale target: the confirm key checks the shown leg against the rule again and never sends another', async (t) => {
  const flight = (flightId, legId) => ({ kind: 'flight', flightId, plannedLegId: legId });
  const groundSetup = async (ui) => { await ui.scenario('leg'); };
  const prefileSetup = async (ui) => {
    await ui.scenario('leg');
    ui.gaugeDev.simbriefScenario('prefiled');
    await settle();
  };
  const cases = [
    ['C-a prefile cleared, scope null', prefileSetup, 'LEG 4812', async (ui) => showState(ui, withScope(ui, null)), 'NO FLIGHT PLAN'],
    ['prefile cleared back to the ground leg', prefileSetup, 'LEG 4812', async (ui) => { await ui.host.clearPrefiledLeg(); await settle(); }, 'CLEARANCE LEG CHANGED'],
    ['prefile cleared with no ground leg', async (ui) => { await ui.scenario('no-flight-plan'); ui.gaugeDev.simbriefScenario('prefiled'); await settle(); },
      'LEG 4812', async (ui) => { await ui.host.clearPrefiledLeg(); await settle(); }, 'NO FLIGHT PLAN'],
    ['flight starts over a prefiled leg', prefileSetup, 'LEG 4812', async (ui) => { ui.gaugeDev.datalinkScenario('flight'); await settle(); }, 'CLEARANCE LEG CHANGED'],
    ['C-b flight starts, linked leg 77', groundSetup, 'LEG 12', async (ui) => showState(ui, withScope(ui, flight(93, 77))), 'CLEARANCE LEG CHANGED'],
    ['C-c flight starts, same linked leg', groundSetup, 'LEG 12', async (ui) => { ui.gaugeDev.datalinkScenario('flight'); await settle(); }, 12],
    ['C-d flight starts without a linked leg', prefileSetup, 'LEG 4812', async (ui) => showState(ui, withScope(ui, flight(93, null))), 'NO LINKED LEG'],
    ['C-e scope becomes none', groundSetup, 'LEG 12', async (ui) => { ui.gaugeDev.datalinkScenario('no-flight-plan'); await settle(); }, 'NO FLIGHT PLAN'],
    ['C-f token latch', prefileSetup, 'LEG 4812', async (ui) => { ui.gaugeDev.datalinkScenario('invalid-token'); await settle(); }, 'INGEST TOKEN REJECTED'],
    ['C-g new prefile held, not applied', prefileSetup, 'LEG 4812',
      async (ui) => showState(ui, withScope(ui, { kind: 'leg', plannedLegId: 4812, source: 'prefile' }, 4813)), 'SCOPE UPDATE PENDING'],
    ['C-h prefile applied over the ground leg', groundSetup, 'LEG 12',
      async (ui) => { ui.gaugeDev.simbriefScenario('prefiled'); await settle(); }, 'CLEARANCE LEG CHANGED'],
    ['C-i no change', prefileSetup, 'LEG 4812', async () => {}, 4812],
    ['C-j status failing, scope kept', groundSetup, 'LEG 12',
      async (ui) => showState(ui, withScope(ui, ui.shell.datalink.scope, null, { state: 'dl.unreachable' })), 12],
  ];
  const { clearanceLeg } = await pageModule('clearance-vocab.js');
  for (const [index, [what, setup, shown, change, outcome]] of cases.entries()) {
    const ui = await mountDatalinkPages(t, `clearance-stale-${index}`, { clearance: true, fpln: true });
    await setup(ui);
    ui.fmc.showPage('DL-INDEX');
    await settle();
    assert.equal(await ui.lsk('DL-INDEX', 'R5'), true, what);
    assert.deepEqual([ui.shell.id, ui.rows()[3]], ['DL-CLEARANCE-CONFIRM', [shown]], what);
    await change(ui);
    assert.deepEqual([ui.shell.id, ui.rows()[3]], ['DL-CLEARANCE-CONFIRM', [shown]], `${what}: the shown leg does not follow the scope`);
    const rule = clearanceLeg(ui.shell.datalink);
    assert.equal(ui.pages.get('DL-CLEARANCE-CONFIRM').onLsk('R6', {}), true, what);
    await later(20);
    const sent = callsOf(ui.gaugeDev, 'requestClearance').map((call) => call.args);
    if (typeof outcome === 'number') {
      assert.deepEqual(sent, [[{ plannedLegId: outcome }]], what);
      assert.deepEqual([shown, rule], [`LEG ${outcome}`, { ok: true, plannedLegId: outcome }], `${what}: sent leg is shown and current`);
      assert.equal(ui.shell.id, 'DL-CLEARANCE', what);
    } else {
      assert.deepEqual([sent, ui.shell.id, ui.shell.scratchpad], [[], 'DL-INDEX', [outcome, 'error']], what);
      assert.equal(await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6'), false, `${what}: nothing left pending`);
    }
  }
});

test('clearance unavailable: the datalink state, DL-INDEX, the thread and the other DATALINK pages are unchanged', async (t) => {
  const ui = await mountDatalinkPages(t, 'clearance-unavailable', { clearance: true });
  const { shell, fmc, gaugeDev, host, rows } = ui;
  await ui.scenario('leg');
  gaugeDev.clearanceScenario('unavailable');
  fmc.showPage('DL-INDEX');
  await settle();
  const index = () => [rows()[0][0], ...rows().slice(1)];
  const indexBefore = index();
  const stateBefore = withoutClock(await host.getDatalinkState());
  await ui.lsk('DL-INDEX', 'L3');
  const threadBefore = rows();
  await ui.lsk('DL-THREAD', 'L6');

  await ui.lsk('DL-INDEX', 'R5');
  await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
  await later(30);
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-INDEX', ['CLEARANCE UNAVAILABLE', 'error']]);
  assert.deepEqual(index(), indexBefore);
  assert.deepEqual(withoutClock(await host.getDatalinkState()), stateBefore);
  assert.equal(rows()[3][0], 'DATALINK ONLINE');
  await ui.lsk('DL-INDEX', 'L3');
  assert.deepEqual([shell.id, rows()], ['DL-THREAD', threadBefore]);
  for (const [key, id] of [['L3', 'DL-THREAD'], ['R3', 'DL-WX'], ['R4', 'DL-LOADSHEET'], ['L4', 'DL-CANNED']]) {
    fmc.showPage('DL-INDEX');
    await settle();
    assert.equal(await ui.lsk('DL-INDEX', key), true, key);
    assert.deepEqual([shell.id, shell.scratchpad], [id, null], key);
  }
  assert.deepEqual(rows()[1], ['<WX REQUEST']);
  assert.equal(callsOf(gaugeDev, 'requestClearance').length, 1);
});

test('clearance on an older host: still adopted, the clearance says NOT SUPPORTED, and DATALINK and FPLN work as before', async (t) => {
  const legacy = { hostLabel: 'LEGACY' };
  for (const name of ['getConfig', 'setConfig', 'getConfigPath', 'startUplink', 'stopUplink', 'restartSidecar', 'getStatus', 'onStatus', 'onLog', 'onExit']) {
    legacy[name] = async () => null;
  }
  const bare = await importBridgeWith({ __FMC_HOST__: legacy }, 'clearance-legacy');
  assert.equal(bare.hostLabel, 'LEGACY');
  assert.deepEqual(await bare.requestClearance({ plannedLegId: 12 }), localError('host-unsupported'));

  // A host that has it gets the leg id and nothing else.
  const seen = [];
  const modern = { ...legacy, hostLabel: 'MODERN', requestClearance: async (...args) => { seen.push(args); return { ok: true, result: {} }; } };
  const adoptedModern = await importBridgeWith({ __FMC_HOST__: modern }, 'clearance-modern');
  await adoptedModern.requestClearance({ plannedLegId: 12, ingestToken: CLEARANCE_SENTINEL, tripId: 3 });
  await adoptedModern.requestClearance('12');
  assert.deepEqual(plain(seen), [[{ plannedLegId: 12 }], [{}]]);
  assert.deepEqual(Object.keys(seen[1][0]), ['plannedLegId']);

  // Tauri: one command name, the leg id alone, and a malformed request never invoked.
  const invoked = [];
  const tauri = await importBridgeWith({ __TAURI__: { core: { invoke: async (cmd, args) => { invoked.push([cmd, args]); return { ok: true, result: {} }; } } } }, 'clearance-tauri');
  await tauri.requestClearance({ plannedLegId: 12, ingestToken: CLEARANCE_SENTINEL });
  for (const req of [undefined, null, {}, [], { plannedLegId: -1 }, { plannedLegId: '12' }, { plannedLegId: 1.5 }]) {
    assert.deepEqual(await tauri.requestClearance(req), localError('bad-request'), JSON.stringify(req));
  }
  assert.deepEqual(invoked, [['datalink_clearance', { plannedLegId: 12 }]]);

  // Stub: recorded, and unsupported until a result is set.
  const stubWindow = {};
  const stubBridge = await importBridgeWith(stubWindow, 'clearance-stub');
  const stub = stubWindow.__FMC_STUB__;
  assert.deepEqual(await stubBridge.requestClearance({ plannedLegId: 12 }), localError('host-unsupported'));
  stub.datalinkResults.requestClearance = { ok: true, result: clearanceResult() };
  assert.deepEqual(await stubBridge.requestClearance({ plannedLegId: 12 }), { ok: true, result: clearanceResult() });
  assert.deepEqual(stub.calls.slice(-2).map((call) => [call.method, call.args]), [['requestClearance', [{ plannedLegId: 12 }]], ['requestClearance', [{ plannedLegId: 12 }]]]);

  // The preview mock without the method, through the adopted host, on the pages.
  const mock = await loadMock();
  delete mock.host.requestClearance;
  const adopted = await importBridgeWith({ __FMC_HOST__: mock.host }, 'clearance-old-mock');
  assert.equal(adopted.hostLabel, 'GAUGE MOCK');
  const ui = await mountDatalinkPages(t, 'clearance-old-host', { clearance: true, fpln: true, mock, via: adopted });
  const { shell, fmc, rows } = ui;
  await ui.scenario('leg');
  fmc.showPage('DL-INDEX');
  await settle();
  const indexBefore = rows().slice(1);
  await ui.lsk('DL-INDEX', 'R5');
  assert.deepEqual([shell.id, rows()[3]], ['DL-CLEARANCE-CONFIRM', ['LEG 12']]);
  await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
  assert.deepEqual([shell.id, shell.scratchpad, rows().slice(1)], ['DL-INDEX', ['CLEARANCE NOT SUPPORTED', 'error'], indexBefore]);
  await ui.lsk('DL-INDEX', 'R5');
  assert.deepEqual(rows().slice(6, 9), [['LAST REQUEST'], ['CLEARANCE NOT SUPPORTED'], ['']]);
  await ui.lsk('DL-CLEARANCE-CONFIRM', 'L6');
  assert.deepEqual([rows()[1], rows()[3], rows()[5], rows()[7], rows()[11]], [['LEG 12'], ['DATALINK ONLINE'], ['<MESSAGES', 'WX REQUEST>'], ['<DOWNLINK', 'LOADSHEET>'], ['<INDEX', 'REFRESH>']]);
  await ui.lsk('DL-INDEX', 'L3');
  assert.deepEqual([shell.id, rows()[0]], ['DL-THREAD', ['UP 1220Z DISPATCH RELEASE']]);
  await ui.lsk('DL-THREAD', 'L6');
  await ui.lsk('DL-INDEX', 'R4');
  await ui.lsk('DL-LOADSHEET', 'R6');
  await ui.lsk('DL-CONFIRM', 'R6');
  assert.deepEqual([shell.id, shell.scratchpad], ['DL-LOADSHEET', ['LOADSHEET RECEIVED', 'advisory']]);
  fmc.showPage('FPLN');
  await settle();
  assert.deepEqual([rows()[1], rows()[11]], [['CONFIGURED'], ['<MENU', 'PREFILE>']]);
  await ui.lsk('FPLN', 'R6');
  await ui.lsk('FPLN-CONFIRM', 'R6');
  assert.deepEqual([shell.id, shell.scratchpad], ['FPLN-RESULT', ['SIMBRIEF PLAN PREFILED', 'advisory']]);
  assert.equal(callsOf(mock.gaugeDev, 'requestClearance').length, 0);
});

test('clearance before START: the same text and the same calls whether the uplink is stopped or running', async (t) => {
  const run = async (status) => {
    const ui = await mountDatalinkPages(t, `clearance-${status}`, { clearance: true });
    const { fmc, gaugeDev, rows, shell } = ui;
    gaugeDev.scenario(status);
    await ui.scenario('leg');
    const screens = [];
    const look = () => screens.push(shell.id, rows().map((line) => line.map((cell) => cell.replace(/^UPD \d{4}Z$/, 'UPD'))), shell.scratchpad);
    fmc.showPage('DL-INDEX');
    await settle();
    look();
    gaugeDev.clearanceScenario('unreachable');
    await ui.lsk('DL-INDEX', 'R5');
    look();
    await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
    look();
    gaugeDev.clearanceScenario('created');
    await ui.lsk('DL-INDEX', 'R5');
    look();
    await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
    look();
    await ui.lsk('DL-CLEARANCE', 'L6');
    await ui.scenario('no-flight-plan');
    await ui.lsk('DL-INDEX', 'R5');
    look();
    const calls = plain(gaugeDev.calls)
      .filter((call) => ['requestClearance', 'startUplink', 'stopUplink', 'restartSidecar'].includes(call.method))
      .map((call) => [call.method, call.args]);
    return { screens, calls };
  };
  const stopped = await run('stopped');
  const online = await run('online');
  assert.deepEqual(stopped, online);
  assert.deepEqual(stopped.calls, [['requestClearance', [{ plannedLegId: 12 }]], ['requestClearance', [{ plannedLegId: 12 }]]]);
  assert.deepEqual(stopped.screens.slice(6, 9), ['DL-INDEX', stopped.screens[1], ['CLEARANCE NO COMM', 'error']]);
  assert.deepEqual(stopped.screens.slice(12, 15).map((item, i) => (i === 1 ? item[0] : item)), ['DL-CLEARANCE', ['SIMULATED CLEARANCE', 'LEG 12'], ['CLEARANCE RECEIVED', 'advisory']]);
  assert.deepEqual(stopped.screens.slice(15, 18).map((item, i) => (i === 1 ? item[1] : item)), ['DL-INDEX', ['NO FLIGHT PLAN'], ['NO FLIGHT PLAN', 'error']]);
});

test('clearance token sentinel never reaches a result, a state, a recorded call or the screen', async (t) => {
  const { host, gaugeDev } = await loadMock();
  const seen = [];
  host.onDatalink((state) => seen.push(plain(state)));
  await host.setConfig({ ingestToken: CLEARANCE_SENTINEL });
  const adopted = await importBridgeWith({ __FMC_HOST__: host }, 'clearance-sentinel');
  for (const datalink of ['leg', 'flight', 'no-flight-plan']) {
    for (const name of CLEARANCE_SCENARIOS) {
      seen.push(plain(gaugeDev.datalinkScenario(datalink)));
      seen.push(gaugeDev.clearanceScenario(name));
      for (const call of [() => host.requestClearance({ plannedLegId: 12 }), () => adopted.requestClearance({ plannedLegId: 12, ingestToken: CLEARANCE_SENTINEL })]) {
        try {
          seen.push(plain(await call()));
        } catch (error) {
          seen.push(String(error && error.message));
        }
      }
      seen.push(plain(await host.getDatalinkState()));
    }
  }
  assert.ok(seen.length > 28 * 3 * 4);
  assert.equal(JSON.stringify({ seen, calls: gaugeDev.calls }).includes(CLEARANCE_SENTINEL), false);

  const screens = [];
  const drive = async (ui, name) => {
    const look = () => screens.push(ui.shell.title, ui.rows(), ui.shell.scratchpad);
    await ui.scenario('leg');
    ui.gaugeDev.clearanceScenario(name);
    ui.fmc.showPage('DL-INDEX');
    await settle();
    await ui.lsk('DL-INDEX', 'R5');
    look();
    await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
    look();
    if (ui.shell.id === 'DL-CLEARANCE') {
      await ui.lsk('DL-CLEARANCE', 'R6');
      look();
    } else {
      await ui.lsk('DL-INDEX', 'R5');
      look();
    }
  };
  const failing = await mountDatalinkPages(t, 'clearance-sentinel-errors', { clearance: true });
  await failing.host.setConfig({ ingestToken: CLEARANCE_SENTINEL });
  for (const name of Object.keys(CLEARANCE_ERRORS)) await drive(failing, name);
  const calls = [failing.gaugeDev.calls];
  for (const name of Object.keys(CLEARANCE_OK)) {
    const ui = await mountDatalinkPages(t, `clearance-sentinel-${name}`, { clearance: true });
    await ui.host.setConfig({ ingestToken: CLEARANCE_SENTINEL });
    await drive(ui, name);
    calls.push(ui.gaugeDev.calls);
  }
  assert.ok(screens.length >= 28 * 9);
  assert.equal(JSON.stringify({ screens, calls }).includes(CLEARANCE_SENTINEL), false);
  assert.equal(JSON.stringify(screens).includes(SERVER_TEXT_SENTINEL), false);
});

test('clearance kept results are forgotten when CFG NETWORK saves another server URL or token, and kept on an unchanged save', async (t) => {
  const ui = await mountDatalinkPages(t, 'clearance-cfg', { cfg: true });
  const { shell, fmc, host, gaugeDev, pages, rows } = ui;
  await host.setConfig({ ingestToken: 'first-token' });
  await fmc.refreshConfig();
  await ui.scenario('leg');
  const clearances = () => callsOf(gaugeDev, 'requestClearance').length;
  const request = async () => {
    fmc.showPage('DL-INDEX');
    await settle();
    await ui.lsk('DL-INDEX', 'R5');
    assert.equal(shell.id, 'DL-CLEARANCE-CONFIRM');
    await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
    assert.deepEqual([shell.id, rows()[0]], ['DL-CLEARANCE', ['SIMULATED CLEARANCE', 'LEG 12']]);
  };
  /** Where R5 on DL-INDEX lands; a kept clearance opens DL-CLEARANCE without a request. */
  const pressR5 = async () => {
    fmc.showPage('DL-INDEX');
    await settle();
    await ui.lsk('DL-INDEX', 'R5');
    const landed = shell.id;
    if (landed === 'DL-CLEARANCE-CONFIRM') await ui.lsk('DL-CLEARANCE-CONFIRM', 'L6');
    return landed;
  };
  // CFG NETWORK as the pilot uses it: an optional entry on L1 (URL) or L2 (token), then EXEC.
  const save = async (lsk, entry) => {
    const network = pages.get('NETWORK');
    if (lsk) {
      ui.type(entry);
      assert.equal(network.onLsk(lsk, {}), true);
    }
    assert.equal(network.onKey('EXEC'), true);
    await settle();
    assert.deepEqual(shell.scratchpad, ['CONFIG SAVED', 'advisory'], `save ${lsk || 'unchanged'}`);
  };

  await request();
  assert.deepEqual([await pressR5(), clearances()], ['DL-CLEARANCE', 1]);

  await save();
  assert.deepEqual([await pressR5(), clearances()], ['DL-CLEARANCE', 1], 'an unchanged save keeps the clearance');

  await save('L1', 'http://other.invalid');
  assert.equal(shell.config.serverUrl, 'http://other.invalid');
  assert.deepEqual([await pressR5(), clearances()], ['DL-CLEARANCE-CONFIRM', 1], 'another server URL forgets it and sends nothing');
  fmc.showPage('DL-CLEARANCE');
  assert.deepEqual(rows()[1], ['NO CLEARANCE RECEIVED']);
  await request();
  assert.equal(clearances(), 2);

  await save('L2', 'another-token');
  assert.deepEqual([await pressR5(), clearances()], ['DL-CLEARANCE-CONFIRM', 2], 'a new token forgets it and sends nothing');
  await request();
  assert.equal(clearances(), 3);
  await save();
  assert.deepEqual([await pressR5(), clearances()], ['DL-CLEARANCE', 3]);

  // A failure's last-request line is forgotten too.
  await save('L1', 'http://third.invalid');
  gaugeDev.clearanceScenario('unreachable');
  fmc.showPage('DL-INDEX');
  await settle();
  await ui.lsk('DL-INDEX', 'R5');
  await ui.lsk('DL-CLEARANCE-CONFIRM', 'R6');
  assert.deepEqual([shell.id, shell.scratchpad, clearances()], ['DL-INDEX', ['CLEARANCE NO COMM', 'error'], 4]);
  await save('L2', 'fourth-token');
  fmc.showPage('DL-INDEX');
  await ui.lsk('DL-INDEX', 'R5');
  assert.deepEqual([shell.id, rows()[6], rows()[7]], ['DL-CLEARANCE-CONFIRM', [''], ['']]);

  // An answer that lands after a change is shown but not kept.
  gaugeDev.clearanceScenario('created');
  gaugeDev.setClearanceDelay(50);
  assert.equal(pages.get('DL-CLEARANCE-CONFIRM').onLsk('R6', {}), true);
  await save('L1', 'http://fifth.invalid');
  await later(100);
  assert.deepEqual([shell.id, shell.scratchpad, clearances()], ['DL-INDEX', ['CLEARANCE RECEIVED', 'advisory'], 5]);
  gaugeDev.setClearanceDelay(0);
  assert.deepEqual([await pressR5(), clearances()], ['DL-CLEARANCE-CONFIRM', 5]);
});
