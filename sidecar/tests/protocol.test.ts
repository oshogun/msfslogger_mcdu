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
  encodeDatalinkResponse,
  encodeSidecarMessage,
  isBlankLine,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  DATALINK_OPS,
  SIMBRIEF_FEATURE,
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

describe('datalink messages', () => {
  const REQUESTS = [
    '{"v":1,"type":"datalink-request","id":"dl-1","op":"watch","params":{"on":true}}',
    '{"v":1,"type":"datalink-request","id":"dl-2","op":"refresh","params":{}}',
    '{"v":1,"type":"datalink-request","id":"dl-3","op":"thread","params":{"epoch":2,"endSeq":5}}',
    '{"v":1,"type":"datalink-request","id":"dl-4","op":"canned-list","params":{}}',
    '{"v":1,"type":"datalink-request","id":"dl-5","op":"send-canned","params":{"target":{"kind":"flight","id":92},"cannedId":"any-canned.id_1"}}',
    '{"v":1,"type":"datalink-request","id":"dl-6","op":"wx","params":{"target":{"kind":"leg","id":12},"icao":"LFPG"}}',
    '{"v":1,"type":"datalink-request","id":"dl-7","op":"loadsheet","params":{"plannedLegId":12}}',
    '{"v":1,"type":"datalink-request","id":"dl-8","op":"watch","params":{"on":false}}',
  ];

  it('decodes each op and round-trips it', () => {
    for (const line of REQUESTS) {
      const result = decodeControlMessage(line);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message).toEqual(JSON.parse(line));
        expect(decodeControlMessage(encodeControlMessage(result.message).trim())).toEqual(result);
      }
    }
    expect(new Set(REQUESTS.map((line) => JSON.parse(line).op))).toEqual(
      new Set(['watch', 'refresh', 'thread', 'canned-list', 'send-canned', 'wx', 'loadsheet']),
    );
  });

  it('rejects free text next to or instead of a canned id as bad-shape, keeping the request id', () => {
    const smuggled = [
      ['dl-9', '{"v":1,"type":"datalink-request","id":"dl-9","op":"send-canned","params":{"target":{"kind":"flight","id":92},"cannedId":"gate-ok","body":"HELLO DISPATCH"}}'],
      ['dl-10', '{"v":1,"type":"datalink-request","id":"dl-10","op":"send-canned","params":{"target":{"kind":"flight","id":92},"text":"ANY FREE TEXT"}}'],
      ['dl-11', '{"v":1,"type":"datalink-request","id":"dl-11","op":"send-canned","params":{"target":{"kind":"flight","id":92},"cannedId":"HELLO DISPATCH PLEASE"}}'],
      ['dl-12', '{"v":1,"type":"datalink-request","id":"dl-12","op":"wx","params":{"target":{"kind":"leg","id":12},"icao":"LFPG","text":"x"}}'],
      ['dl-13', '{"v":1,"type":"datalink-request","id":"dl-13","op":"loadsheet","params":{"plannedLegId":12,"body":"x"}}'],
      ['dl-14', '{"v":1,"type":"datalink-request","id":"dl-14","op":"send-canned","params":{"target":{"kind":"flight","id":92,"note":"x"},"cannedId":"ok"}}'],
      ['dl-15', '{"v":1,"type":"datalink-request","id":"dl-15","op":"refresh","params":{"text":"x"}}'],
    ];
    for (const [id, line] of smuggled) {
      const result = decodeControlMessage(line);
      expect(result).toMatchObject({ ok: false, error: 'bad-shape', messageType: 'datalink-request', requestId: id });
      if (!result.ok) {
        const text = describeDecodeError(result);
        expect(text).not.toContain('HELLO');
        expect(text).not.toContain('FREE TEXT');
      }
    }
  });

  it('rejects wrong types and unknown ops as bad-shape with the request id', () => {
    const rows = [
      '{"v":1,"type":"datalink-request","id":"dl-20","op":"post-anything","params":{}}',
      '{"v":1,"type":"datalink-request","id":"dl-21","op":"watch","params":{"on":"yes"}}',
      '{"v":1,"type":"datalink-request","id":"dl-22","op":"thread","params":{"epoch":0,"endSeq":1}}',
      '{"v":1,"type":"datalink-request","id":"dl-23","op":"thread","params":{"epoch":1,"endSeq":-1}}',
      '{"v":1,"type":"datalink-request","id":"dl-24","op":"wx","params":{"target":{"kind":"leg","id":12},"icao":"lfpg"}}',
      '{"v":1,"type":"datalink-request","id":"dl-25","op":"wx","params":{"target":{"kind":"gate","id":12},"icao":"LFPG"}}',
      '{"v":1,"type":"datalink-request","id":"dl-26","op":"loadsheet","params":{"plannedLegId":1.5}}',
      '{"v":1,"type":"datalink-request","id":"dl-27","op":"loadsheet","params":[12]}',
      '{"v":1,"type":"datalink-request","id":"dl-28","op":"loadsheet"}',
    ];
    for (const line of rows) {
      expect(decodeControlMessage(line)).toMatchObject({
        ok: false, error: 'bad-shape', requestId: JSON.parse(line).id,
      });
    }
  });

  it('rejects a request with an unusable id without a request id', () => {
    for (const id of ['7', '"dl-"', '"dl-abc"', '"dl-123456789012345678901"', 'null']) {
      const result = decodeControlMessage(`{"v":1,"type":"datalink-request","id":${id},"op":"refresh","params":{}}`);
      expect(result).toMatchObject({ ok: false, error: 'bad-shape' });
      expect(result.ok === false && 'requestId' in result).toBe(false);
    }
  });

  it('accepts a hello with and without features', () => {
    const base = { v: 1, type: 'hello', at: AT, pid: 1, sidecarVersion: '1.0.0', nodeVersion: 'v20', configPath: '/x' };
    expect(decodeSidecarMessage(JSON.stringify(base)).ok).toBe(true);
    const withFeatures = decodeSidecarMessage(JSON.stringify({ ...base, features: ['datalink'] }));
    expect(withFeatures).toEqual({ ok: true, message: { ...base, features: ['datalink'] } });
    expect(decodeSidecarMessage(JSON.stringify({ ...base, features: 'datalink' }))).toMatchObject({ ok: false, error: 'bad-shape' });
  });

  it('decodes datalink-state and datalink-response, and rejects malformed ones', () => {
    const state = '{"v":1,"type":"datalink-state","at":1789569127113,"state":"dl.ok","watching":true,"httpStatus":null,"serverCode":null,"lastOkAt":1789569127113,"lastErrorAt":null,"nextPollAt":1789569147113,"scope":{"kind":"flight","flightId":92,"plannedLegId":12},"thread":{"epoch":2,"total":5,"firstSeq":0,"newestId":18,"droppedRows":0}}';
    const okResponse = '{"v":1,"type":"datalink-response","at":1789569127113,"id":"dl-1","ok":true,"result":{"watching":true,"leaseMs":65000}}';
    const errResponse = '{"v":1,"type":"datalink-response","at":1789569127113,"id":"dl-7","ok":false,"error":{"code":"no-dispatch-data","httpStatus":409,"serverCode":"NO_DISPATCH_DATA"}}';
    for (const line of [state, okResponse, errResponse]) {
      const result = decodeSidecarMessage(line);
      expect(result).toEqual({ ok: true, message: JSON.parse(line) });
      if (result.ok) expect(encodeSidecarMessage(result.message)).toBe(`${line}\n`);
    }
    expect(decodeSidecarMessage(state.replace('"watching":true', '"watching":1'))).toMatchObject({ error: 'bad-shape' });
    expect(decodeSidecarMessage(state.replace('"scope":{', '"scope":[{').replace('"plannedLegId":12}', '"plannedLegId":12}]'))).toMatchObject({ error: 'bad-shape' });
    expect(decodeSidecarMessage(okResponse.replace('"result":{', '"result":[{').replace('65000}', '65000}]'))).toMatchObject({ error: 'bad-shape' });
    expect(decodeSidecarMessage(errResponse.replace('"code":"no-dispatch-data",', ''))).toMatchObject({ error: 'bad-shape' });
  });

  it('encodes a datalink-response as one line, and an oversize one as too-large', () => {
    const small = encodeDatalinkResponse({
      v: 1, type: 'datalink-response', at: AT, id: 'dl-3', ok: true, result: { accepted: true, coalesced: false },
    });
    expect(small).toBe(`{"v":1,"type":"datalink-response","at":${AT},"id":"dl-3","ok":true,"result":{"accepted":true,"coalesced":false}}\n`);
    const big = encodeDatalinkResponse({
      v: 1, type: 'datalink-response', at: AT, id: 'dl-4', ok: true,
      result: { icao: 'EGLL', available: true, metar: 'x'.repeat(MAX_LINE_BYTES), taf: null, fetchedAt: null },
    });
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(JSON.parse(big)).toMatchObject({ id: 'dl-4', ok: false, error: { code: 'too-large', httpStatus: null, serverCode: null } });
  });

  it('keeps the protocol version at 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('SimBrief datalink ops', () => {
  it('decodes the three ops with empty params and round-trips them', () => {
    const lines = [
      '{"v":1,"type":"datalink-request","id":"dl-41","op":"simbrief-settings","params":{}}',
      '{"v":1,"type":"datalink-request","id":"dl-42","op":"simbrief-prefile","params":{}}',
      '{"v":1,"type":"datalink-request","id":"dl-43","op":"prefile-clear","params":{}}',
    ];
    for (const line of lines) {
      const result = decodeControlMessage(line);
      expect(result).toEqual({ ok: true, message: JSON.parse(line) });
      if (result.ok) expect(encodeControlMessage(result.message)).toBe(`${line}
`);
    }
  });

  it('rejects any param key, and non-object params, as bad-shape with the request id echoed', () => {
    const rejected = [
      '{"v":1,"type":"datalink-request","id":"dl-50","op":"simbrief-prefile","params":{"allow_duplicates":true}}',
      '{"v":1,"type":"datalink-request","id":"dl-51","op":"simbrief-prefile","params":{"tripId":7}}',
      '{"v":1,"type":"datalink-request","id":"dl-52","op":"simbrief-settings","params":{"pilotId":"1234567"}}',
      '{"v":1,"type":"datalink-request","id":"dl-53","op":"prefile-clear","params":{"plannedLegId":123}}',
      '{"v":1,"type":"datalink-request","id":"dl-54","op":"simbrief-prefile","params":null}',
      '{"v":1,"type":"datalink-request","id":"dl-55","op":"simbrief-settings","params":[]}',
      '{"v":1,"type":"datalink-request","id":"dl-56","op":"prefile-clear"}',
      '{"v":1,"type":"datalink-request","id":"dl-57","op":"simbrief-prefile","params":{"plannedLegId":123}}',
      '{"v":1,"type":"datalink-request","id":"dl-58","op":"simbrief-settings","params":{"allow_duplicates":false}}',
      '{"v":1,"type":"datalink-request","id":"dl-59","op":"prefile-clear","params":{"pilotId":"1","tripId":1}}',
    ];
    for (const line of rejected) {
      const result = decodeControlMessage(line);
      expect(result).toMatchObject({
        ok: false, error: 'bad-shape', messageType: 'datalink-request', requestId: JSON.parse(line).id,
      });
      if (!result.ok) expect(describeDecodeError(result)).not.toContain('1234567');
    }
  });

  it('lists the ops in their frozen order, and names the feature', () => {
    expect(DATALINK_OPS).toEqual([
      'watch', 'refresh', 'thread', 'canned-list', 'send-canned', 'wx', 'loadsheet',
      'simbrief-settings', 'simbrief-prefile', 'prefile-clear',
    ]);
    expect(SIMBRIEF_FEATURE).toBe('simbrief-prefile');
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('decodes the SimBrief responses and a datalink-state carrying prefiledLeg', () => {
    const lines = [
      '{"v":1,"type":"hello","at":1789600000000,"pid":4242,"sidecarVersion":"0.1.0","nodeVersion":"v20.20.2","configPath":"/x","features":["datalink","simbrief-prefile"]}',
      '{"v":1,"type":"datalink-response","at":1789600000000,"id":"dl-41","ok":true,"result":{"configured":true}}',
      '{"v":1,"type":"datalink-response","at":1789600000000,"id":"dl-42","ok":true,"result":{"status":"imported","plannedLegId":123,"label":"KJFK → EGLL (BAW178)","warningCount":0,"httpStatus":201}}',
      '{"v":1,"type":"datalink-response","at":1789600000000,"id":"dl-47","ok":false,"error":{"code":"prefile-in-progress","httpStatus":null,"serverCode":null}}',
      '{"v":1,"type":"datalink-response","at":1789600000000,"id":"dl-43","ok":true,"result":{"cleared":true}}',
      '{"v":1,"type":"datalink-state","at":1789600000000,"watching":true,"httpStatus":null,"serverCode":null,"lastOkAt":1789600000000,"lastErrorAt":null,"nextPollAt":1789600020000,"state":"dl.ok","scope":{"kind":"leg","plannedLegId":123,"source":"prefile"},"thread":{"epoch":4,"total":1,"firstSeq":0,"newestId":31,"droppedRows":0},"prefiledLeg":{"plannedLegId":123,"label":"KJFK → EGLL (BAW178)"}}',
    ];
    for (const line of lines) {
      expect(decodeSidecarMessage(line)).toEqual({ ok: true, message: JSON.parse(line) });
    }
  });
});
