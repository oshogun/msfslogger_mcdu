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
