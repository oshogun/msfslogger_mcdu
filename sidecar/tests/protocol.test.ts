// tests/protocol.test.ts — tests src/protocol.ts.
//
// Two properties are worth this much test surface. First, round-tripping:
// every message type encodes to one line and decodes back to an equal object,
// in both directions, because the Rust shell mirrors these shapes and a silent
// field rename would show up as a blank panel rather than an error. Second,
// and more important: no input decodes into a throw. A malformed line from a
// mismatched build must be dropped and logged, never fatal.

import { describe, expect, it } from 'vitest';
import {
  decodeControlMessage,
  decodeSidecarMessage,
  describeDecodeError,
  encodeControlMessage,
  encodeSidecarMessage,
  isBlankLine,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  type ControlMessage,
  type SidecarMessage,
} from '../src/protocol';

const AT = 1757600000000;

const REDACTED_CONFIG = {
  version: 1 as const,
  serverUrl: 'http://192.168.0.30:3000',
  certPath: null,
  trafficEnabled: true,
  trafficRadiusM: 40000,
  sim: '2020' as const,
  autoUplink: false,
  nodePath: null,
  tokenSet: true,
};

const SIDECAR_MESSAGES: SidecarMessage[] = [
  {
    v: 1,
    type: 'hello',
    at: AT,
    pid: 4242,
    sidecarVersion: '1.0.0',
    nodeVersion: 'v20.20.2',
    configPath: '/home/pilot/.config/msfslogger/config.json',
  },
  {
    v: 1,
    type: 'status',
    at: AT,
    app: { state: 'app.running' },
    sim: {
      state: 'sim.retry',
      attempt: 2,
      nextRetryAt: AT + 20000,
      retryDelayMs: 20000,
      protocol: 'KittyHawk',
      appName: null,
      appVersion: null,
      lastError: 'connect ECONNREFUSED 127.0.0.1:2048',
    },
    backend: {
      state: 'net.ok',
      httpStatus: 204,
      lastOkAt: AT,
      lastErrorAt: null,
      message: null,
    },
    pause: { state: 'pause.off', flags: 0, label: 'off', usingPauseEx1: true },
    traffic: {
      enabled: true,
      radiusM: 40000,
      lastSweepAt: AT,
      lastBatchSize: 17,
      lastError: null,
    },
    config: REDACTED_CONFIG,
  },
  {
    v: 1,
    type: 'status',
    at: AT,
    app: {
      state: 'app.error-config',
      problems: [{ field: 'serverUrl', message: 'serverUrl is required' }],
    },
    sim: {
      state: 'sim.idle',
      attempt: 0,
      nextRetryAt: null,
      retryDelayMs: null,
      protocol: 'KittyHawk',
      appName: null,
      appVersion: null,
      lastError: null,
    },
    backend: { state: 'net.idle', httpStatus: null, lastOkAt: null, lastErrorAt: null, message: null },
    pause: { state: 'pause.off', flags: 0, label: 'off', usingPauseEx1: false },
    traffic: { enabled: true, radiusM: 40000, lastSweepAt: null, lastBatchSize: null, lastError: null },
    config: null,
  },
  { v: 1, type: 'log', at: AT, level: 'warn', message: 'Server responded 500 for /api/ingest/frame' },
  { v: 1, type: 'pong', at: AT, id: 'probe-1' },
  {
    v: 1,
    type: 'frame',
    at: AT,
    frame: {
      lat: 37.618023,
      lon: -122.375519,
      altitudeFt: 12.5,
      airspeedKnots: 0,
      groundSpeedKnots: 0,
      headingDeg: 271.3,
      verticalSpeedFpm: 0,
      onGround: true,
      simRunning: 2,
      aircraft: 'Cessna 172',
    },
  },
  {
    v: 1,
    type: 'traffic',
    at: AT,
    count: 1,
    objects: [{ id: 7, lat: 37.7, lon: -122.4, altitudeFt: 3500, headingDeg: 90, onGround: false }],
  },
];

const CONTROL_MESSAGES: ControlMessage[] = [
  { v: 1, type: 'start' },
  { v: 1, type: 'stop' },
  { v: 1, type: 'config' },
  { v: 1, type: 'config', path: '/tmp/other-config.json' },
  { v: 1, type: 'shutdown' },
  { v: 1, type: 'ping', id: 'probe-1' },
];

describe('encoding', () => {
  it('emits exactly one newline-terminated line per message', () => {
    for (const message of [...SIDECAR_MESSAGES]) {
      const line = encodeSidecarMessage(message);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
    }
    for (const message of CONTROL_MESSAGES) {
      const line = encodeControlMessage(message);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
    }
  });

  it('escapes an embedded newline instead of breaking the framing', () => {
    const line = encodeSidecarMessage({
      v: 1,
      type: 'log',
      at: AT,
      level: 'error',
      message: 'line one\nline two',
    });
    expect(line.split('\n')).toHaveLength(2);
    const decoded = decodeSidecarMessage(line.trim());
    expect(decoded.ok && decoded.message.type === 'log' && decoded.message.message).toBe(
      'line one\nline two',
    );
  });

  it('carries the protocol version on every message', () => {
    for (const message of SIDECAR_MESSAGES) expect(message.v).toBe(PROTOCOL_VERSION);
  });
});

describe('round trips', () => {
  for (const message of SIDECAR_MESSAGES) {
    it(`sidecar ${message.type} survives encode -> decode`, () => {
      const result = decodeSidecarMessage(encodeSidecarMessage(message).trim());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.message).toEqual(message);
    });
  }

  for (const message of CONTROL_MESSAGES) {
    it(`control ${message.type}${'path' in message ? ' with path' : ''} survives encode -> decode`, () => {
      const result = decodeControlMessage(encodeControlMessage(message).trim());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.message).toEqual(message);
    });
  }

  it('covers every declared message type', () => {
    expect(new Set(SIDECAR_MESSAGES.map((m) => m.type))).toEqual(
      new Set(['hello', 'status', 'log', 'pong', 'frame', 'traffic']),
    );
    expect(new Set(CONTROL_MESSAGES.map((m) => m.type))).toEqual(
      new Set(['start', 'stop', 'config', 'shutdown', 'ping']),
    );
  });
});

describe('decode failures are typed results, never throws', () => {
  it('rejects a non-JSON line', () => {
    const result = decodeSidecarMessage('not json at all');
    expect(result).toMatchObject({ ok: false, error: 'not-json' });
  });

  it('rejects valid JSON that is not an object', () => {
    expect(decodeSidecarMessage('[1,2,3]')).toEqual({ ok: false, error: 'not-object' });
    expect(decodeControlMessage('42')).toEqual({ ok: false, error: 'not-object' });
    expect(decodeSidecarMessage('null')).toEqual({ ok: false, error: 'not-object' });
  });

  it('rejects a version mismatch loudly', () => {
    expect(decodeSidecarMessage('{"v":2,"type":"log","at":1,"level":"info","message":"x"}')).toEqual({
      ok: false,
      error: 'bad-version',
      v: 2,
    });
    expect(decodeControlMessage('{"type":"stop"}')).toEqual({
      ok: false,
      error: 'bad-version',
      v: undefined,
    });
  });

  it('treats an unknown type as a soft, non-fatal error', () => {
    expect(decodeSidecarMessage('{"v":1,"type":"telemetry","at":1}')).toEqual({
      ok: false,
      error: 'unknown-type',
      messageType: 'telemetry',
    });
    expect(decodeControlMessage('{"v":1,"type":"restart"}')).toEqual({
      ok: false,
      error: 'unknown-type',
      messageType: 'restart',
    });
    expect(decodeControlMessage('{"v":1,"type":7}')).toMatchObject({
      ok: false,
      error: 'unknown-type',
    });
  });

  it('rejects a known type with the wrong shape', () => {
    const rows = [
      '{"v":1,"type":"log","at":1,"level":"chatty","message":"x"}',
      '{"v":1,"type":"log","at":1,"level":"info","message":42}',
      '{"v":1,"type":"hello","at":1,"pid":"nope","sidecarVersion":"1","nodeVersion":"v20","configPath":"/x"}',
      '{"v":1,"type":"status","at":1,"app":{},"sim":{},"backend":{},"pause":{},"traffic":{}}',
      '{"v":1,"type":"pong","at":1}',
      '{"v":1,"type":"traffic","at":1,"count":1,"objects":{}}',
      '{"v":1,"type":"log","level":"info","message":"no at"}',
    ];
    for (const line of rows) {
      const result = decodeSidecarMessage(line);
      expect(result).toMatchObject({ ok: false, error: 'bad-shape' });
    }
    expect(decodeControlMessage('{"v":1,"type":"ping"}')).toMatchObject({
      ok: false,
      error: 'bad-shape',
      messageType: 'ping',
    });
    expect(decodeControlMessage('{"v":1,"type":"config","path":7}')).toMatchObject({
      ok: false,
      error: 'bad-shape',
    });
  });

  it('drops an oversized line rather than buffering it', () => {
    const huge = `{"v":1,"type":"log","at":1,"level":"info","message":"${'x'.repeat(MAX_LINE_BYTES)}"}`;
    const result = decodeSidecarMessage(huge);
    expect(result).toMatchObject({ ok: false, error: 'oversize' });
    if (!result.ok && result.error === 'oversize') {
      expect(result.bytes).toBeGreaterThan(MAX_LINE_BYTES);
    }
  });

  it('never throws, whatever it is handed', () => {
    const nasty = ['', '   ', '{', '{}', '[]', 'undefined', '"a string"', ' ', '{"v":1}'];
    for (const line of nasty) {
      expect(() => decodeSidecarMessage(line)).not.toThrow();
      expect(() => decodeControlMessage(line)).not.toThrow();
      expect(decodeSidecarMessage(line).ok).toBe(false);
    }
  });

  it('skips blank lines before decoding', () => {
    expect(isBlankLine('')).toBe(true);
    expect(isBlankLine('  \t ')).toBe(true);
    expect(isBlankLine('{"v":1}')).toBe(false);
  });

  it('describes every failure in one line', () => {
    const errors = [
      decodeSidecarMessage('nope'),
      decodeSidecarMessage('[]'),
      decodeSidecarMessage('{"v":9}'),
      decodeSidecarMessage('{"v":1,"type":"nope","at":1}'),
      decodeSidecarMessage('{"v":1,"type":"pong","at":1}'),
      decodeSidecarMessage(`{"v":1,"type":"log","at":1,"message":"${'x'.repeat(MAX_LINE_BYTES)}"}`),
    ];
    for (const error of errors) {
      expect(error.ok).toBe(false);
      if (!error.ok) {
        const text = describeDecodeError(error);
        expect(text).not.toContain('\n');
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });
});
