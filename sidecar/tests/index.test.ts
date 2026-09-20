import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigLoadResult, EffectiveConfig } from '../src/config';
import type { SimConnectCallbacks } from '../src/simconnect';
import type { SidecarMessage, StatusMessage } from '../src/protocol';
import type { UplinkResult } from '../src/uplink';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  setConfig: vi.fn(),
  postFrame: vi.fn(),
  postEvent: vi.fn(),
  postTraffic: vi.fn(),
  probe: vi.fn(),
  close: vi.fn(),
  linkStart: vi.fn(),
  linkStop: vi.fn(),
  linkConfig: vi.fn(),
  getConfig: vi.fn(),
  datalinkRequest: vi.fn(),
  callbacks: null as SimConnectCallbacks | null,
}));

vi.mock('../src/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config')>(),
  loadConfig: mocks.loadConfig,
}));
vi.mock('../src/uplink', () => ({
  Uplink: class {
    setConfig = mocks.setConfig;
    postFrame = mocks.postFrame;
    postEvent = mocks.postEvent;
    postTraffic = mocks.postTraffic;
    probe = mocks.probe;
    close = mocks.close;
    getConfig = mocks.getConfig;
  },
}));
vi.mock('../src/datalink-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/datalink-client')>(),
  DatalinkClient: class {
    request = mocks.datalinkRequest;
  },
}));
vi.mock('../src/simconnect', () => ({
  SimConnectLink: class {
    constructor(_config: EffectiveConfig, callbacks: SimConnectCallbacks) {
      mocks.callbacks = callbacks;
    }
    start = mocks.linkStart;
    stop = mocks.linkStop;
    setConfig = mocks.linkConfig;
  },
}));

const config: EffectiveConfig = {
  version: 1, serverUrl: 'http://127.0.0.1:3199', ingestToken: 'TEST-TOKEN',
  certPath: null, trafficEnabled: true, trafficRadiusM: 40000,
  sim: '2020', autoUplink: false, nodePath: null,
};
const good: ConfigLoadResult = { ok: true, config, warnings: [] };
const invalid: ConfigLoadResult = {
  ok: false, reason: 'invalid', path: '/tmp/mock-config.json',
  problems: [{ field: 'sim', message: 'Unknown simulator' }],
};
const success: UplinkResult = { ok: true, state: 'net.ok', httpStatus: 204, message: null };
const failure: UplinkResult = {
  ok: false, state: 'net.http-error', httpStatus: 500, code: null, message: 'HTTP 500',
};
const standby: UplinkResult = { ok: true, state: 'net.standby', httpStatus: 401, message: null };
let stdin: EventEmitter;
let messages: SidecarMessage[];
/** Every line exactly as it was written, so a line's size can be measured. */
let lines: string[];
let exitCode: typeof process.exitCode;
// The navdata store is created beside the config file. Every test in this file
// points that at a throwaway directory, so nothing here can touch the real one.
let configDir: string;
let previousConfigEnv: string | undefined;
/** Set by the suite that wants the navdata store to fail to open. */
let blockNavdata = false;

function control(type: string): void {
  stdin.emit('data', JSON.stringify({ v: 1, type }) + '\n');
}
function status(): StatusMessage {
  const statuses = messages.filter((message): message is StatusMessage => message.type === 'status');
  return statuses[statuses.length - 1];
}
function deferred() {
  let resolve!: (value: UplinkResult) => void;
  const promise = new Promise<UplinkResult>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(250);
}
async function start(): Promise<void> {
  control('start');
  await flush();
}
function reload(result: ConfigLoadResult): void {
  mocks.loadConfig.mockReturnValue(result);
  control('config');
}
function sendFrame(): void {
  mocks.callbacks!.onFrame({
    lat: 1, lon: 2, altitudeFt: 3, airspeedKnots: 4, groundSpeedKnots: 5,
    headingDeg: 6, verticalSpeedFpm: 7, onGround: false, simRunning: 1, aircraft: 'Test',
  });
}

beforeEach(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-index-'));
  previousConfigEnv = process.env.MSFSLOGGER_CONFIG;
  if (blockNavdata) {
    // A file where the config's directory should be: the navdata directory
    // beside it cannot be created, which is how a store that will not open
    // looks from here.
    fs.writeFileSync(path.join(configDir, 'blocked'), 'not a directory');
    process.env.MSFSLOGGER_CONFIG = path.join(configDir, 'blocked', 'config.json');
  } else {
    process.env.MSFSLOGGER_CONFIG = path.join(configDir, 'config.json');
  }
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(60000);
  exitCode = process.exitCode;
  stdin = new EventEmitter();
  messages = [];
  lines = [];
  mocks.callbacks = null;
  mocks.loadConfig.mockReturnValue(good);
  mocks.postFrame.mockResolvedValue(success);
  mocks.postEvent.mockResolvedValue(success);
  mocks.postTraffic.mockResolvedValue(success);
  mocks.probe.mockResolvedValue(standby);
  mocks.close.mockResolvedValue(undefined);
  vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'on').mockImplementation((event, listener) => {
    stdin.on(event, listener);
    return process.stdin;
  });
  vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    messages.push(JSON.parse(String(chunk)) as SidecarMessage);
    return true;
  });
  await import('../src/index');
});

afterEach(async () => {
  control('shutdown');
  await vi.advanceTimersByTimeAsync(1000);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = exitCode;
  if (previousConfigEnv === undefined) delete process.env.MSFSLOGGER_CONFIG;
  else process.env.MSFSLOGGER_CONFIG = previousConfigEnv;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('sidecar config recovery and lifecycle through control messages', () => {
  it.each(['stop', 'shutdown'])('keeps unresolved config errors visible after %s with idle axes', async (action) => {
    await start();
    reload(invalid);
    control(action);
    await flush();
    expect(status().app).toEqual({ state: 'app.error-config', problems: invalid.problems });
    expect(status().backend.state).toBe('net.idle');
    expect(status().sim.state).toBe('sim.idle');
    expect(mocks.linkStop).toHaveBeenCalledOnce();
    expect(mocks.postEvent).toHaveBeenCalledWith({ type: 'disconnected' });
    expect(messages.filter((message) => message.type === 'status' &&
      message.app.state === 'app.stopped' && message.app.problems?.length)).toEqual([]);
  });

  it('retains active config across repeated invalid reloads, continues probes and recovers as running', async () => {
    await start();
    reload(invalid);
    reload(invalid);
    expect(status().config).toMatchObject({ serverUrl: config.serverUrl, sim: config.sim });
    expect(mocks.linkStop).not.toHaveBeenCalled();
    expect(mocks.setConfig).not.toHaveBeenCalled();
    const starts = mocks.linkStart.mock.calls.length;
    control('start');
    expect(mocks.linkStart).toHaveBeenCalledTimes(starts);
    expect(status().app.state).toBe('app.error-config');
    await vi.advanceTimersByTimeAsync(15000);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    sendFrame();
    await flush();
    expect(status().backend.state).toBe('net.ok');
    const updated = { ...config, trafficRadiusM: 50000 };
    reload({ ok: true, config: updated, warnings: [] });
    expect(status().app).toEqual({ state: 'app.running' });
    expect(status().config?.trafficRadiusM).toBe(50000);
    expect(mocks.setConfig).toHaveBeenCalledWith(updated);
    expect(mocks.linkConfig).toHaveBeenCalledWith(updated);
  });

  it('recovers as stopped when STOP follows an invalid reload', async () => {
    await start();
    reload(invalid);
    control('stop');
    reload(good);
    expect(status().app).toEqual({ state: 'app.stopped' });
    expect(status().backend.state).toBe('net.idle');
    expect(mocks.linkStart).toHaveBeenCalledOnce();
  });

  it.each(['frame', 'event'])('ignores successful or failed pending %s completions after STOP', async (kind) => {
    await start();
    const pendingSuccess = deferred();
    const pendingFailure = deferred();
    const post = kind === 'frame' ? mocks.postFrame : mocks.postEvent;
    post.mockReturnValueOnce(pendingSuccess.promise).mockReturnValueOnce(pendingFailure.promise);
    if (kind === 'frame') { sendFrame(); sendFrame(); }
    else {
      mocks.callbacks!.onIngestEvent({ type: 'connected' });
      mocks.callbacks!.onIngestEvent({ type: 'paused' });
    }
    control('stop');
    const stopped = status().backend;
    pendingSuccess.resolve(success);
    pendingFailure.resolve(failure);
    await flush();
    expect(status().app).toEqual({ state: 'app.stopped' });
    expect(status().backend).toEqual(stopped);
  });

  it('ignores a previous run\'s ingest completion after STOP and START', async () => {
    await start();
    const pending = deferred();
    mocks.postFrame.mockReturnValueOnce(pending.promise);
    sendFrame();
    control('stop');
    await start();
    expect(status().backend.state).toBe('net.standby');
    pending.resolve(failure);
    await flush();
    expect(status().backend.state).toBe('net.standby');
    sendFrame();
    await flush();
    expect(status().backend.state).toBe('net.ok');
  });

  it('ignores a pending probe completion after STOP', async () => {
    const pending = deferred();
    mocks.probe.mockReturnValueOnce(pending.promise);
    await start();
    control('stop');
    pending.resolve(standby);
    await flush();
    expect(status().backend.state).toBe('net.idle');
  });

  it('preserves a missing config through shutdown when no valid config was retained', async () => {
    const problems = [{ field: '*' as const, message: 'No config file at /tmp/mock-config.json' }];
    reload({ ok: false, reason: 'missing', path: '/tmp/mock-config.json', problems });
    control('shutdown');
    await flush();
    expect(status().app).toEqual({ state: 'app.no-config', problems });
    expect(status().config).toBeNull();
    expect(mocks.postEvent).not.toHaveBeenCalled();
  });
});

describe('datalink wiring', () => {
  const SENTINEL = 'SENTINEL-DATALINK-TOKEN-0000';
  const sentinelConfig: EffectiveConfig = { ...config, ingestToken: SENTINEL };
  let nextId = 1;

  type Outcome =
    | { kind: 'response'; status: number; scopeHeader: string | null; bodyText: string | null; bodyTooLarge: boolean }
    | { kind: 'transport'; errorName: string | null; errorCode: string | null };

  const respond = (status: number, body: unknown, scopeHeader: string | null = null): Outcome => ({
    kind: 'response', status, scopeHeader, bodyText: JSON.stringify(body), bodyTooLarge: false,
  });
  const UNREACHABLE: Outcome = { kind: 'transport', errorName: 'TypeError', errorCode: 'ECONNREFUSED' };
  const FAULTS: [string, Outcome][] = [
    ['401 invalid token', respond(401, { error: `rejected ${SENTINEL}`, code: 'INVALID_INGEST_TOKEN' })],
    ['401 scope accepted', respond(401, { error: `missing ${SENTINEL}` }, 'accepted')],
    ['401 pre-upgrade', respond(401, { error: `Authentication required ${SENTINEL}` })],
    ['403 cross-origin', respond(403, { error: `Cross-origin request rejected ${SENTINEL}` })],
    ['500', respond(500, { error: SENTINEL })],
    ['unreachable', UNREACHABLE],
  ];

  function datalink(op: string, params: unknown, id = `dl-${nextId++}`): string {
    stdin.emit('data', JSON.stringify({ v: 1, type: 'datalink-request', id, op, params }) + '\n');
    return id;
  }
  function responseFor(id: string) {
    return messages.find((m) => m.type === 'datalink-response' && m.id === id);
  }
  function lastDatalinkState() {
    const states = messages.filter((m) => m.type === 'datalink-state');
    return states[states.length - 1];
  }
  function flyingWithThread(route: { key: string }): Outcome {
    if (route.key === 'status') return respond(200, { currentFlightId: 92, plannedLeg: { plannedLegId: 12 } });
    return respond(200, {
      flight_id: 92, planned_leg_id: 12,
      messages: [{
        id: 1, direction: 'uplink', category: 'dispatch', label: `L ${SENTINEL}`,
        body: `BODY ${SENTINEL}`, sent_at: '2026-09-16T12:00:00.000Z', correlation_id: null,
      }],
    });
  }

  beforeEach(() => {
    mocks.getConfig.mockReturnValue(sentinelConfig);
    reload({ ok: true, config: sentinelConfig, warnings: [] });
  });

  it('hello advertises the datalink feature and is followed by one idle datalink-state', () => {
    expect(messages[0]).toMatchObject({
      type: 'hello',
      features: ['datalink', 'simbrief-prefile', 'pdc-clearance', 'sayintentions', 'navdata'],
    });
    expect(messages[1]).toEqual({
      v: 1, type: 'datalink-state', at: 60000, state: 'dl.idle', watching: false, httpStatus: null,
      serverCode: null, lastOkAt: null, lastErrorAt: null, nextPollAt: null, scope: null, thread: null,
    });
  });

  it('answers a malformed request with a valid id as bad-request, without a log line', async () => {
    const logsBefore = messages.filter((m) => m.type === 'log').length;
    datalink('send-canned', { target: { kind: 'flight', id: 92 }, cannedId: 'x', body: 'FREE TEXT' }, 'dl-41');
    await flush();
    expect(responseFor('dl-41')).toEqual({
      v: 1, type: 'datalink-response', at: expect.any(Number), id: 'dl-41', ok: false,
      error: { code: 'bad-request', httpStatus: null, serverCode: null },
    });
    expect(messages.filter((m) => m.type === 'log').length).toBe(logsBefore);
    expect(mocks.datalinkRequest).not.toHaveBeenCalled();
  });

  it('runs while the uplink is stopped and never starts it', async () => {
    mocks.datalinkRequest.mockImplementation(async (route: { key: string }) => flyingWithThread(route));
    const id = datalink('watch', { on: true });
    await flush();
    expect(responseFor(id)).toMatchObject({ ok: true, result: { watching: true, leaseMs: 65000 } });
    expect(mocks.datalinkRequest).toHaveBeenCalledTimes(2);
    expect(lastDatalinkState()).toMatchObject({ state: 'dl.ok', scope: { kind: 'flight', flightId: 92, plannedLegId: 12 } });
    expect(status().app.state).toBe('app.stopped');
    expect(status().backend.state).toBe('net.idle');
    expect(mocks.linkStart).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('datalink 401 (three variants), 403, 500 and unreachable leave the backend axis identical', async () => {
    await start();
    sendFrame();
    await flush();
    const before = status().backend;
    expect(before.state).toBe('net.ok');

    for (const [name, outcome] of FAULTS) {
      mocks.datalinkRequest.mockResolvedValue(outcome);
      // A valid reload clears the invalid-token latch so every case really makes requests.
      reload({ ok: true, config: sentinelConfig, warnings: [] });
      datalink('watch', { on: true });
      datalink('refresh', {});
      datalink('canned-list', {});
      await flush();
      const expected = name === 'unreachable' ? 'dl.unreachable' : undefined;
      if (expected) expect(lastDatalinkState()).toMatchObject({ state: expected });
      // The reload above scheduled a status line, written after the datalink faults.
      expect(status().at).toBeGreaterThan(before.lastOkAt ?? 0);
      expect(status().backend).toEqual(before);
    }
    expect(mocks.datalinkRequest).toHaveBeenCalled();
    expect(messages.filter((m) => m.type === 'datalink-state').map((m) => m.state)).toEqual(
      expect.arrayContaining(['dl.token-invalid', 'dl.token-missing', 'dl.unavailable', 'dl.rejected', 'dl.http-error', 'dl.unreachable']),
    );
    const backends = messages.filter((m): m is StatusMessage => m.type === 'status').slice(-3).map((m) => m.backend);
    for (const backend of backends) {
      expect({ state: backend.state, httpStatus: backend.httpStatus, message: backend.message, lastErrorAt: backend.lastErrorAt })
        .toEqual({ state: before.state, httpStatus: before.httpStatus, message: before.message, lastErrorAt: before.lastErrorAt });
    }
  });

  it('SimBrief settings and prefile through 401 (three variants), 403, 500, 504 and unreachable leave the backend axis identical', async () => {
    await start();
    sendFrame();
    await flush();
    const before = status().backend;
    expect(before.state).toBe('net.ok');

    const simbriefFaults: [string, Outcome][] = [
      ...FAULTS,
      ['504 TIMEOUT', respond(504, { error: `SimBrief timeout ${SENTINEL}`, code: 'TIMEOUT' })],
    ];
    for (const [, outcome] of simbriefFaults) {
      mocks.datalinkRequest.mockResolvedValue(outcome);
      reload({ ok: true, config: sentinelConfig, warnings: [] });
      const settings = datalink('simbrief-settings', {});
      const prefile = datalink('simbrief-prefile', {});
      await flush();
      expect(responseFor(settings)).toMatchObject({ ok: false });
      expect(responseFor(prefile)).toMatchObject({ ok: false });
      expect(status().backend).toEqual(before);
    }
    const routes = mocks.datalinkRequest.mock.calls.map(([route]) => (route as { key: string }).key);
    expect(new Set(routes)).toEqual(new Set(['simbrief-settings', 'simbrief-prefile']));
    expect(routes.filter((key) => key === 'simbrief-prefile')).toHaveLength(simbriefFaults.length);
    const codes = messages
      .filter((m) => m.type === 'datalink-response' && !m.ok)
      .map((m) => (m.type === 'datalink-response' && !m.ok ? m.error.code : ''));
    expect(new Set(codes)).toEqual(
      new Set(['token-invalid', 'token-missing', 'simbrief-unavailable', 'rejected', 'http-error', 'unreachable', 'simbrief-timeout']),
    );
    const backends = messages.filter((m): m is StatusMessage => m.type === 'status').slice(-3).map((m) => m.backend);
    for (const backend of backends) {
      expect({ state: backend.state, httpStatus: backend.httpStatus, message: backend.message, lastErrorAt: backend.lastErrorAt })
        .toEqual({ state: before.state, httpStatus: before.httpStatus, message: before.message, lastErrorAt: before.lastErrorAt });
    }
  });

  it('a prefile publishes prefiledLeg and its scope, and nothing it writes to stdout carries the token', async () => {
    mocks.datalinkRequest.mockImplementation(async (route: { key: string; id?: number }) => {
      if (route.key === 'simbrief-prefile') {
        return respond(201, {
          imported: [{ id: 123, note: SENTINEL }],
          result: { status: 'imported', planned_leg_id: 123, label: `KJFK EGLL ${SENTINEL}`, warnings: [SENTINEL] },
        });
      }
      if (route.key === 'simbrief-settings') return respond(200, { simbrief_user_id: '1234567' });
      if (route.key === 'status') return respond(200, { currentFlightId: null });
      if (route.key === 'ground-session-current') return respond(200, { session: null });
      return respond(200, { planned_leg_id: route.id, messages: [] });
    });
    datalink('watch', { on: true });
    await flush();
    const settings = datalink('simbrief-settings', {});
    const prefile = datalink('simbrief-prefile', {});
    await flush();
    expect(responseFor(settings)).toMatchObject({ ok: true, result: { configured: true } });
    expect(responseFor(prefile)).toMatchObject({
      ok: true, result: { status: 'imported', plannedLegId: 123, label: 'KJFK EGLL [REDACTED]', warningCount: 1, httpStatus: 201 },
    });
    expect(lastDatalinkState()).toMatchObject({
      scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' },
      prefiledLeg: { plannedLegId: 123, label: 'KJFK EGLL [REDACTED]' },
    });
    const clear = datalink('prefile-clear', {});
    await flush();
    expect(responseFor(clear)).toMatchObject({ ok: true, result: { cleared: true } });
    expect(lastDatalinkState()).not.toHaveProperty('prefiledLeg');

    for (const [, outcome] of FAULTS) {
      mocks.datalinkRequest.mockResolvedValue(outcome);
      reload({ ok: true, config: sentinelConfig, warnings: [] });
      datalink('simbrief-settings', {});
      datalink('simbrief-prefile', {});
      await flush();
    }
    control('shutdown');
    await flush();
    const logs = messages.filter((m) => m.type === 'log').map((m) => m.message);
    expect(logs).toContain('SimBrief prefile imported (HTTP 201)');
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('SENTINEL-DATALINK');
    expect(everything).not.toContain('1234567');
  });

  it('never writes the token to stdout across success, all 401s, 403, 409 and unreachable', async () => {
    mocks.datalinkRequest.mockImplementation(async (route: { key: string }) => flyingWithThread(route));
    datalink('watch', { on: true });
    await flush();
    const thread = datalink('thread', { epoch: 1, endSeq: 1 });
    await flush();
    expect(responseFor(thread)).toMatchObject({ ok: true, result: { messages: [{ body: 'BODY [REDACTED]' }] } });

    mocks.datalinkRequest.mockResolvedValue(respond(409, { error: `NO DISPATCH ${SENTINEL}`, code: 'NO_DISPATCH_DATA' }));
    const loadsheet = datalink('loadsheet', { plannedLegId: 12 });
    await flush();
    expect(responseFor(loadsheet)).toMatchObject({ ok: false, error: { code: 'no-dispatch-data', httpStatus: 409 } });

    for (const [, outcome] of FAULTS) {
      mocks.datalinkRequest.mockResolvedValue(outcome);
      reload({ ok: true, config: sentinelConfig, warnings: [] });
      datalink('refresh', {});
      datalink('canned-list', {});
      datalink('wx', { target: { kind: 'flight', id: 92 }, icao: 'EGLL' });
      await flush();
    }
    control('shutdown');
    await flush();

    const logs = messages.filter((m) => m.type === 'log').map((m) => m.message);
    expect(logs.some((line) => /^Datalink dl\.\S+ \(HTTP (\d{3}|---)(, code [A-Z_]+)?\)( on (GET|POST) \/api\/\S+)?$/.test(line))).toBe(true);
    expect(messages.some((m) => m.type === 'datalink-response')).toBe(true);
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('SENTINEL-DATALINK');
  });

  it('clearance through 401 (three variants), 403, 404, 409, 500, timeout and unreachable leaves the backend axis identical', async () => {
    await start();
    sendFrame();
    await flush();
    const before = status().backend;
    expect(before.state).toBe('net.ok');

    const clearanceFaults: [string, Outcome][] = [
      ...FAULTS.filter(([name]) => name !== '500'),
      ['404', respond(404, { error: `Planned leg 12 not found ${SENTINEL}`, code: 'PLANNED_LEG_NOT_FOUND' }, 'accepted')],
      ['409', respond(409, { error: `NO FLIGHT PLAN ON FILE ${SENTINEL}`, code: 'NO_FLIGHT_PLAN' }, 'accepted')],
      ['500', respond(500, { error: SENTINEL })],
      ['timeout', { kind: 'transport', errorName: 'TimeoutError', errorCode: null }],
    ];
    const ids: string[] = [];
    for (const [, outcome] of clearanceFaults) {
      mocks.datalinkRequest.mockResolvedValue(outcome);
      reload({ ok: true, config: sentinelConfig, warnings: [] });
      const id = datalink('clearance', { plannedLegId: 12 });
      ids.push(id);
      await flush();
      expect(responseFor(id)).toMatchObject({ ok: false });
      expect(status().backend).toEqual(before);
    }
    const routes = mocks.datalinkRequest.mock.calls.map(([route]) => route as { key: string; id: number });
    expect(routes).toEqual(clearanceFaults.map(() => ({ key: 'leg-clearance', id: 12 })));
    const codes = ids.map((id) => {
      const message = responseFor(id);
      return message && message.type === 'datalink-response' && !message.ok ? message.error.code : '';
    });
    expect(codes).toEqual([
      'token-invalid', 'token-missing', 'clearance-unavailable', 'rejected', 'unreachable',
      'leg-not-found', 'clearance-no-flight-plan', 'http-error', 'timeout',
    ]);
    const backends = messages.filter((m): m is StatusMessage => m.type === 'status').slice(-3).map((m) => m.backend);
    for (const backend of backends) {
      expect({ state: backend.state, httpStatus: backend.httpStatus, message: backend.message, lastErrorAt: backend.lastErrorAt })
        .toEqual({ state: before.state, httpStatus: before.httpStatus, message: before.message, lastErrorAt: before.lastErrorAt });
    }
    control('shutdown');
    await flush();
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain(SENTINEL);
    const logs = messages.filter((m) => m.type === 'log').map((m) => m.message);
    expect(logs.filter((line) => line.startsWith('Clearance '))).toEqual([
      'Clearance token-invalid (HTTP 401)', 'Clearance token-missing (HTTP 401)', 'Clearance clearance-unavailable (HTTP 401)',
      'Clearance rejected (HTTP 403)', 'Clearance unreachable (HTTP ---)', 'Clearance leg-not-found (HTTP 404)',
      'Clearance clearance-no-flight-plan (HTTP 409)', 'Clearance http-error (HTTP 500)', 'Clearance timeout (HTTP ---)',
    ]);
  });

  it('answers each malformed clearance request with exactly the bad-request line, sending nothing', async () => {
    const rejected: [string, unknown][] = [
      ['dl-60', { plannedLegId: 12, tripId: 1 }],
      ['dl-61', { plannedLegId: 12, flightId: 92 }],
      ['dl-62', { plannedLegId: '12' }],
      ['dl-63', { plannedLegId: 0 }],
      ['dl-64', { plannedLegId: 12.5 }],
      ['dl-65', { plannedLegId: 9007199254740992 }],
      ['dl-66', {}],
      ['dl-67', { legId: 12 }],
      ['dl-68', null],
      ['dl-69', []],
      ['dl-70', 'x'],
    ];
    const logsBefore = messages.filter((m) => m.type === 'log').length;
    for (const [id, params] of rejected) datalink('clearance', params, id);
    await flush();
    for (const [id] of rejected) {
      expect(responseFor(id)).toEqual({
        v: 1, type: 'datalink-response', at: expect.any(Number), id, ok: false,
        error: { code: 'bad-request', httpStatus: null, serverCode: null },
      });
    }
    expect(messages.filter((m) => m.type === 'log').length).toBe(logsBefore);
    expect(mocks.datalinkRequest).not.toHaveBeenCalled();
  });

  it('a clearance success is answered with the structured result only, and emits no datalink-state when not watching', async () => {
    mocks.datalinkRequest.mockResolvedValue(respond(201, {
      planned_leg_id: 12, created: true,
      request: { id: 501, body: `REQUEST CLEARANCE ${SENTINEL}` },
      reply: { id: 502, correlation_id: 501, body: `PDC ${SENTINEL}`, payload_json: SENTINEL },
      clearance: { v: 1, departure_icao: 'kjfk', destination_icao: 'EGLL', route: `GREKI ${SENTINEL} DCT`, initial_altitude_ft: 5000, squawk: '4521' },
    }, 'accepted'));
    const states = messages.filter((m) => m.type === 'datalink-state').length;
    const id = datalink('clearance', { plannedLegId: 12 });
    await flush();
    expect(responseFor(id)).toEqual({
      v: 1, type: 'datalink-response', at: expect.any(Number), id, ok: true,
      result: {
        plannedLegId: 12, created: true, departure: 'KJFK', destination: 'EGLL', route: 'GREKI [REDACTED] DCT',
        initialAltitudeFt: 5000, squawk: '4521', httpStatus: 201,
      },
    });
    expect(messages.filter((m) => m.type === 'datalink-state').length).toBe(states);
    expect(JSON.stringify(messages)).not.toContain(SENTINEL);
    expect(JSON.stringify(messages)).not.toContain('PDC');
  });

  it('the five SayIntentions ops reach their own routes and are answered with the projected result only', async () => {
    const link = {
      flight_id: 42, upstream_flight_id: `8841207 ${SENTINEL}`, since_id: 51223, baseline_comm_id: 51220,
      linked_at: '2026-09-17T14:30:00.000Z', last_import_at: null, imported_count: 4,
    };
    mocks.datalinkRequest.mockImplementation(async (route: { key: string; id?: number }) => {
      switch (route.key) {
        case 'si-settings':
          return respond(200, { sayintentions_api_key_set: true, sayintentions_api_key_masked: `si_1 ${SENTINEL}` });
        case 'si-link-status':
          return respond(200, { flight_id: 42, api_key_set: true, linked: true, link });
        case 'si-link-now':
          return respond(201, { flight_id: 42, created: true, pending_messages: 4, link });
        case 'si-unlink':
          return respond(200, { flight_id: 42, unlinked: true });
        case 'si-import':
          return respond(201, {
            flight_id: 42, imported: 4, already_seen: 0, skipped: 1, since_id: 51224,
            messages: [{ id: 901, body: `Ground, ${SENTINEL}, ready to taxi.` }],
          });
        case 'si-pdc':
          return respond(201, {
            planned_leg_id: 29, sent_text: `PDC KSFO KLAX ${SENTINEL}`, message: { id: 905, body: SENTINEL },
          });
        default:
          return respond(200, { currentFlightId: null });
      }
    });
    // One action at a time: the four writes share one in-flight guard.
    const ids: string[] = [];
    for (const [op, params] of [
      ['si-status', { flightId: null }],
      ['si-status', { flightId: 42 }],
      ['si-link', { flightId: 42, from: 'now' }],
      ['si-unlink', { flightId: 42 }],
      ['si-import', { flightId: 42 }],
      ['si-pdc', { plannedLegId: 29 }],
    ] as [string, unknown][]) {
      ids.push(datalink(op, params));
      await flush();
    }
    const results = ids.map((id) => {
      const message = responseFor(id);
      return message && message.type === 'datalink-response' && message.ok ? message.result : null;
    });
    expect(results[0]).toEqual({
      answered: 'settings', flightId: null, apiKeySet: true, linked: null, link: null, httpStatus: 200,
    });
    expect(results[1]).toEqual({
      answered: 'link', flightId: 42, apiKeySet: true, linked: true, httpStatus: 200,
      link: {
        upstreamFlightId: '8841207 [REDACTED]', sinceId: 51223, baselineCommId: 51220,
        linkedAt: '2026-09-17T14:30:00.000Z', lastImportAt: null, importedCount: 4,
      },
    });
    expect(results[2]).toMatchObject({ flightId: 42, created: true, pendingMessages: 4, httpStatus: 201 });
    expect(results[3]).toEqual({ flightId: 42, unlinked: true, httpStatus: 200 });
    expect(results[4]).toEqual({
      flightId: 42, imported: 4, alreadySeen: 0, skipped: 1, sinceId: 51224, httpStatus: 201,
    });
    expect(results[5]).toEqual({ plannedLegId: 29, sentText: 'PDC KSFO KLAX [REDACTED]', httpStatus: 201 });

    expect(mocks.datalinkRequest.mock.calls.map(([route]) => route)).toEqual([
      { key: 'si-settings' },
      { key: 'si-link-status', id: 42 },
      { key: 'si-link-now', id: 42 },
      { key: 'si-unlink', id: 42 },
      { key: 'si-import', id: 42 },
      { key: 'si-pdc', id: 29 },
    ]);
    const logs = messages.filter((m) => m.type === 'log').map((m) => m.message);
    expect(logs.filter((line) => line.startsWith('SayIntentions '))).toEqual([
      'SayIntentions status ok (HTTP 200)',
      'SayIntentions status ok (HTTP 200)',
      'SayIntentions link created (HTTP 201)',
      'SayIntentions unlink unlinked (HTTP 200)',
      'SayIntentions import ok (HTTP 201)',
      'SayIntentions pdc sent (HTTP 201)',
    ]);

    // A second action pressed while one is out is refused, and sends nothing.
    const made = mocks.datalinkRequest.mock.calls.length;
    const first = datalink('si-import', { flightId: 42 });
    const second = datalink('si-pdc', { plannedLegId: 29 });
    await flush();
    expect(responseFor(second)).toMatchObject({
      ok: false, error: { code: 'sayintentions-in-progress', httpStatus: null, serverCode: null },
    });
    expect(responseFor(first)).toMatchObject({ ok: true });
    expect(mocks.datalinkRequest.mock.calls.length).toBe(made + 1);
    control('shutdown');
    await flush();
    const everything = JSON.stringify(messages);
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain('SENTINEL-DATALINK');
    expect(everything).not.toContain('masked');
    expect(everything).not.toContain('taxi');
  });

  it('answers each malformed SayIntentions request with exactly the bad-request line, sending nothing', async () => {
    const rejected: [string, string, unknown][] = [
      ['dl-80', 'si-status', {}],
      ['dl-81', 'si-status', { flightId: 0 }],
      ['dl-82', 'si-status', { flightId: 1.5 }],
      ['dl-83', 'si-status', { flightId: 42, plannedLegId: 29 }],
      ['dl-84', 'si-link', { flightId: 42 }],
      ['dl-85', 'si-link', { flightId: 42, from: 'session_start' }],
      ['dl-86', 'si-link', { flightId: null, from: 'now' }],
      ['dl-87', 'si-unlink', { flightId: '42' }],
      ['dl-88', 'si-import', { flightId: 42, since: 1 }],
      ['dl-89', 'si-pdc', { flightId: 42 }],
      ['dl-90', 'si-pdc', null],
    ];
    const logsBefore = messages.filter((m) => m.type === 'log').length;
    for (const [id, op, params] of rejected) datalink(op, params, id);
    await flush();
    for (const [id] of rejected) {
      expect(responseFor(id)).toEqual({
        v: 1, type: 'datalink-response', at: expect.any(Number), id, ok: false,
        error: { code: 'bad-request', httpStatus: null, serverCode: null },
      });
    }
    expect(messages.filter((m) => m.type === 'log').length).toBe(logsBefore);
    expect(mocks.datalinkRequest).not.toHaveBeenCalled();
  });
});

describe('navdata wiring', () => {
  const navdataDir = (): string => path.join(configDir, 'navdata');

  it('has no axis before START, publishes one while running and keeps the store on STOP', async () => {
    expect(status().navdata).toBeUndefined();
    expect(fs.existsSync(navdataDir())).toBe(false);

    await start();
    expect(status().navdata).toMatchObject({
      state: 'nav.ready',
      reason: null,
      airports: 0,
      navaids: 0,
      waypoints: 0,
      ackedRev: null,
      pendingDemand: 0,
      lastSyncAt: null,
      lastSyncError: null,
    });
    expect(status().navdata?.snapshotId).toEqual(expect.any(String));
    expect(status().navdata?.rev).toBe(0);
    expect(fs.existsSync(path.join(navdataDir(), 'navdata.db'))).toBe(true);

    control('stop');
    await flush();
    // The store belongs to the process, not to the run: it stays open.
    expect(status().navdata?.state).toBe('nav.off');
    expect(fs.existsSync(path.join(navdataDir(), 'navdata.db'))).toBe(true);
  });

  it('names navdata in hello as a capability, before any store exists', () => {
    // hello is the first line written, long before a store could be opened, so
    // the feature says what this build knows how to do and nothing more.
    expect(messages[0]).toMatchObject({ type: 'hello' });
    expect((messages[0] as { features: string[] }).features.at(-1)).toBe('navdata');
    expect(status().navdata).toBeUndefined();
  });

  it('hands the navdata gate the name the simulator answered with', async () => {
    await start();
    const connected = {
      state: 'sim.connected' as const, attempt: 0, nextRetryAt: null, retryDelayMs: null,
      protocol: 'KittyHawk', appVersion: '11.0', lastError: null,
    };
    let listRequests = 0;
    const handle = {
      on: () => undefined,
      off: () => undefined,
      addToFacilityDefinition: () => 1,
      requestFacilityData: () => 1,
      requestFacilitiesList: () => { listRequests++; return 1; },
    } as never;

    // A simulator that is not the one this client is configured for. Asking it
    // for a facility list would be parsed with the wrong row size and take the
    // connection down, frames and all, so navdata must refuse and say which
    // two disagreed.
    mocks.callbacks!.onSimState({ ...connected, appName: 'SunRise' });
    mocks.callbacks!.onConnected!(handle);
    await flush();
    expect(listRequests).toBe(0);
    expect(status().navdata?.state).toBe('nav.error');
    expect(status().navdata?.reason).toContain('SunRise');
    expect(status().backend.state).not.toBe('net.idle');

    // The same client against the simulator it IS configured for: the request
    // goes out. So the gate reads the live name, not a constant.
    mocks.callbacks!.onDisconnected!();
    mocks.callbacks!.onSimState({ ...connected, appName: 'KittyHawk' });
    mocks.callbacks!.onConnected!(handle);
    await flush();
    expect(listRequests).toBe(1);
  });

  it('adds the axis to a line that still fits what the shell reads', async () => {
    await start();
    const line = lines[lines.length - 1];
    expect(JSON.parse(line).navdata.state).toBe('nav.ready');
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(65536);
  });

  it('opens the store once and hands the connection to the facility session', async () => {
    await start();
    expect(mocks.callbacks?.onConnected).toBeTypeOf('function');
    expect(mocks.callbacks?.onDisconnected).toBeTypeOf('function');
    // A disconnect with nothing in flight is not an error and not a reason to
    // drop the store.
    mocks.callbacks?.onDisconnected?.();
    await flush();
    expect(status().navdata?.state).toBe('nav.ready');
    expect(status().navdata?.reason).toBeNull();
  });
});

describe('navdata when the store cannot open', () => {
  beforeAll(() => {
    blockNavdata = true;
  });
  afterAll(() => {
    blockNavdata = false;
  });

  it('reports nav.unavailable and leaves frames, traffic, the datalink and the backend axis alone', async () => {
    await start();
    const axis = status().navdata;
    expect(axis?.state).toBe('nav.unavailable');
    expect(axis?.reason).toContain('navdata disabled');
    expect(axis?.reason).not.toContain('config.json');
    expect(axis?.reason).not.toContain(config.ingestToken);

    // A capability is still a capability when the store will not open: the
    // feature says what this build speaks, the axis says whether it is running.
    expect((messages[0] as { features: string[] }).features).toContain('navdata');

    sendFrame();
    await flush();
    expect(status().backend.state).toBe('net.ok');
    mocks.callbacks!.onIngestEvent({ type: 'connected' });
    await flush();
    expect(mocks.postEvent).toHaveBeenCalledWith({ type: 'connected' });
    mocks.callbacks!.onTraffic([{ id: 1 } as never]);
    await flush();
    expect(status().traffic.lastBatchSize).toBe(1);
    expect(status().navdata?.state).toBe('nav.unavailable');

    // Warned once, with no path to the config and no token in it.
    const warnings = messages.filter(
      (message) => message.type === 'log' && message.level === 'warn',
    );
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain(config.ingestToken);
  });
});
