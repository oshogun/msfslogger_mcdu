import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let exitCode: typeof process.exitCode;

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
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(60000);
  exitCode = process.exitCode;
  stdin = new EventEmitter();
  messages = [];
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
    expect(messages[0]).toMatchObject({ type: 'hello', features: ['datalink', 'simbrief-prefile'] });
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
});
