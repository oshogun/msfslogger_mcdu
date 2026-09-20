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
  NAVDATA_FEATURE,
  PROTOCOL_VERSION,
  CLEARANCE_FEATURE,
  DATALINK_OPS,
  SAYINTENTIONS_FEATURE,
  SIMBRIEF_FEATURE,
  type ControlMessage,
  type NavdataStatusAxis,
  type SidecarMessage,
  type StatusMessage,
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
      'simbrief-settings', 'simbrief-prefile', 'prefile-clear', 'clearance',
      'si-status', 'si-link', 'si-unlink', 'si-import', 'si-pdc',
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

describe('clearance datalink op', () => {
  const REQUEST = '{"v":1,"type":"datalink-request","id":"dl-51","op":"clearance","params":{"plannedLegId":12}}';
  // Each rejected request, and the answer the sidecar gives it.
  const REJECTED = [
    '{"v":1,"type":"datalink-request","id":"dl-60","op":"clearance","params":{"plannedLegId":12,"tripId":1}}',
    '{"v":1,"type":"datalink-request","id":"dl-61","op":"clearance","params":{"plannedLegId":12,"flightId":92}}',
    '{"v":1,"type":"datalink-request","id":"dl-62","op":"clearance","params":{"plannedLegId":"12"}}',
    '{"v":1,"type":"datalink-request","id":"dl-63","op":"clearance","params":{"plannedLegId":0}}',
    '{"v":1,"type":"datalink-request","id":"dl-64","op":"clearance","params":{"plannedLegId":12.5}}',
    '{"v":1,"type":"datalink-request","id":"dl-65","op":"clearance","params":{"plannedLegId":9007199254740992}}',
    '{"v":1,"type":"datalink-request","id":"dl-66","op":"clearance","params":{}}',
    '{"v":1,"type":"datalink-request","id":"dl-67","op":"clearance","params":{"legId":12}}',
    '{"v":1,"type":"datalink-request","id":"dl-68","op":"clearance","params":null}',
    '{"v":1,"type":"datalink-request","id":"dl-69","op":"clearance","params":[]}',
    '{"v":1,"type":"datalink-request","id":"dl-70","op":"clearance","params":"x"}',
  ];
  const REJECTED_ANSWERS = [
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-60","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-61","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-62","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-63","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-64","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-65","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-66","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-67","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-68","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-69","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-70","ok":false,"error":{"code":"bad-request","httpStatus":null,"serverCode":null}}',
  ];
  const RESPONSES = [
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-51","ok":true,"result":{"plannedLegId":12,"created":true,"departure":"KJFK","destination":"EGLL","route":"GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI UN514 NUMPO BOGNA1H","initialAltitudeFt":5000,"squawk":"4521","httpStatus":201}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-52","ok":true,"result":{"plannedLegId":12,"created":false,"departure":"KJFK","destination":"EGLL","route":"GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI UN514 NUMPO BOGNA1H","initialAltitudeFt":5000,"squawk":"4521","httpStatus":200}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-53","ok":true,"result":{"plannedLegId":12,"created":true,"departure":null,"destination":null,"route":null,"initialAltitudeFt":5000,"squawk":"4521","httpStatus":201}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-54","ok":false,"error":{"code":"leg-not-found","httpStatus":404,"serverCode":"PLANNED_LEG_NOT_FOUND"}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-55","ok":false,"error":{"code":"clearance-no-flight-plan","httpStatus":409,"serverCode":"NO_FLIGHT_PLAN"}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-56","ok":false,"error":{"code":"clearance-unavailable","httpStatus":401,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-57","ok":false,"error":{"code":"clearance-in-progress","httpStatus":null,"serverCode":null}}',
    '{"v":1,"type":"datalink-response","at":1789700000000,"id":"dl-58","ok":false,"error":{"code":"bad-response","httpStatus":201,"serverCode":null}}',
  ];
  const HELLOS = [
    '{"v":1,"type":"hello","at":1789700000000,"pid":4242,"sidecarVersion":"0.1.0","nodeVersion":"v20.20.2","configPath":"C:\\\\Users\\\\<you>\\\\AppData\\\\Roaming\\\\msfslogger\\\\config.json","features":["datalink","simbrief-prefile","pdc-clearance"]}',
    '{"v":1,"type":"hello","at":1789700000000,"pid":4243,"sidecarVersion":"0.1.0","nodeVersion":"v20.20.2","configPath":"C:\\\\Users\\\\<you>\\\\AppData\\\\Roaming\\\\msfslogger\\\\config.json","features":["datalink","simbrief-prefile"]}',
  ];

  it('decodes the op with exactly { plannedLegId } and round-trips it', () => {
    const result = decodeControlMessage(REQUEST);
    expect(result).toEqual({ ok: true, message: JSON.parse(REQUEST) });
    if (result.ok) expect(encodeControlMessage(result.message)).toBe(`${REQUEST}\n`);
    const widest = '{"v":1,"type":"datalink-request","id":"dl-52","op":"clearance","params":{"plannedLegId":9007199254740991}}';
    expect(decodeControlMessage(widest)).toEqual({ ok: true, message: JSON.parse(widest) });
  });

  it('rejects extra, missing and mistyped keys as bad-shape with the request id echoed', () => {
    expect(REJECTED).toHaveLength(REJECTED_ANSWERS.length);
    REJECTED.forEach((line, i) => {
      const result = decodeControlMessage(line);
      const answer = JSON.parse(REJECTED_ANSWERS[i]) as { id: string; error: unknown };
      expect(JSON.parse(line).id).toBe(answer.id);
      expect(result).toMatchObject({
        ok: false, error: 'bad-shape', messageType: 'datalink-request', requestId: answer.id,
      });
      expect(answer).toMatchObject({ ok: false, error: { code: 'bad-request', httpStatus: null, serverCode: null } });
    });
    // A trip or flight id on its own is refused too, as is no params at all.
    for (const params of ['{"tripId":12}', '{"flightId":92}', '{"plannedLegId":-1}']) {
      const result = decodeControlMessage(`{"v":1,"type":"datalink-request","id":"dl-71","op":"clearance","params":${params}}`);
      expect(result).toMatchObject({ ok: false, error: 'bad-shape', requestId: 'dl-71' });
      if (!result.ok) {
        expect(describeDecodeError(result)).toBe(
          'dropped a malformed "datalink-request" message (clearance params must be exactly { plannedLegId })',
        );
      }
    }
    expect(
      decodeControlMessage('{"v":1,"type":"datalink-request","id":"dl-72","op":"clearance"}'),
    ).toMatchObject({ ok: false, error: 'bad-shape', requestId: 'dl-72' });
  });

  it('decodes the clearance responses, the rejected answers and both hellos', () => {
    for (const line of [...RESPONSES, ...REJECTED_ANSWERS, ...HELLOS]) {
      const result = decodeSidecarMessage(line);
      expect(result).toEqual({ ok: true, message: JSON.parse(line) });
      if (result.ok) expect(encodeSidecarMessage(result.message)).toBe(`${line}\n`);
    }
  });

  it('a 4096-unit route response encodes to one line and decodes back', () => {
    const longRoute = {
      v: 1 as const, type: 'datalink-response' as const, at: AT, id: 'dl-59', ok: true as const,
      result: {
        plannedLegId: 12, created: true, departure: 'KJFK', destination: 'EGLL', route: `${'GREKI DCT '.repeat(409)}NUMPOL`,
        initialAltitudeFt: 5000, squawk: '4521', httpStatus: 201,
      },
    };
    expect(longRoute.result.route).toHaveLength(4096);
    const encoded = encodeDatalinkResponse(longRoute);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(decodeSidecarMessage(encoded.trim())).toEqual({ ok: true, message: longRoute });
  });

  it('names the feature, keeps the protocol version, and lists the op after the SimBrief three', () => {
    expect(CLEARANCE_FEATURE).toBe('pdc-clearance');
    expect(JSON.parse(HELLOS[0]).features).toEqual(['datalink', 'simbrief-prefile', CLEARANCE_FEATURE]);
    expect(PROTOCOL_VERSION).toBe(1);
    expect(DATALINK_OPS.indexOf('clearance')).toBe(DATALINK_OPS.indexOf('prefile-clear') + 1);
    expect(DATALINK_OPS.filter((op) => op === 'clearance')).toHaveLength(1);
  });
});

describe('SayIntentions datalink ops', () => {
  // The accepted shape, an extra key, a missing key, a wrong-typed value, and
  // for si-link a `from` outside the set. Written so it can be diffed against
  // the Rust mirror row for row.
  const ACCEPTED = [
    '{"v":1,"type":"datalink-request","id":"dl-80","op":"si-status","params":{"flightId":92}}',
    '{"v":1,"type":"datalink-request","id":"dl-81","op":"si-status","params":{"flightId":null}}',
    '{"v":1,"type":"datalink-request","id":"dl-82","op":"si-link","params":{"flightId":92,"from":"now"}}',
    '{"v":1,"type":"datalink-request","id":"dl-83","op":"si-link","params":{"flightId":92,"from":"session-start"}}',
    '{"v":1,"type":"datalink-request","id":"dl-84","op":"si-unlink","params":{"flightId":92}}',
    '{"v":1,"type":"datalink-request","id":"dl-85","op":"si-import","params":{"flightId":92}}',
    '{"v":1,"type":"datalink-request","id":"dl-86","op":"si-pdc","params":{"plannedLegId":12}}',
    '{"v":1,"type":"datalink-request","id":"dl-87","op":"si-status","params":{"flightId":9007199254740991}}',
  ];

  /** Every row: the op, the params, and the reason it is one of the five rejections. */
  const REJECTED: [string, string, string][] = [
    ['si-status', '{"flightId":92,"plannedLegId":12}', 'extra key'],
    ['si-status', '{}', 'missing key'],
    ['si-status', '{"flight_id":92}', 'missing key'],
    ['si-status', '{"flightId":"92"}', 'wrong type'],
    ['si-status', '{"flightId":0}', 'wrong type'],
    ['si-status', '{"flightId":1.5}', 'wrong type'],
    ['si-status', '{"flightId":-1}', 'wrong type'],
    ['si-status', '{"flightId":9007199254740992}', 'wrong type'],
    ['si-link', '{"flightId":92,"from":"now","text":"x"}', 'extra key'],
    ['si-link', '{"flightId":92}', 'missing key'],
    ['si-link', '{"from":"now"}', 'missing key'],
    ['si-link', '{"flightId":"92","from":"now"}', 'wrong type'],
    ['si-link', '{"flightId":null,"from":"now"}', 'wrong type'],
    ['si-link', '{"flightId":92,"from":"session_start"}', 'from outside the set'],
    ['si-link', '{"flightId":92,"from":"NOW"}', 'from outside the set'],
    ['si-link', '{"flightId":92,"from":null}', 'from outside the set'],
    ['si-link', '{"flightId":92,"from":"whenever"}', 'from outside the set'],
    ['si-unlink', '{"flightId":92,"from":"now"}', 'extra key'],
    ['si-unlink', '{}', 'missing key'],
    ['si-unlink', '{"flightId":null}', 'wrong type'],
    ['si-unlink', '{"flightId":0}', 'wrong type'],
    ['si-import', '{"flightId":92,"since":51224}', 'extra key'],
    ['si-import', '{}', 'missing key'],
    ['si-import', '{"flightId":true}', 'wrong type'],
    ['si-import', '{"flightId":1.5}', 'wrong type'],
    ['si-pdc', '{"plannedLegId":12,"flightId":92}', 'extra key'],
    ['si-pdc', '{}', 'missing key'],
    ['si-pdc', '{"flightId":92}', 'missing key'],
    ['si-pdc', '{"plannedLegId":"12"}', 'wrong type'],
    ['si-pdc', '{"plannedLegId":null}', 'wrong type'],
    ['si-pdc', '{"plannedLegId":0}', 'wrong type'],
  ];

  const DETAIL: Record<string, string> = {
    'si-status': 'si-status params must be exactly { flightId }',
    'si-link': 'si-link params must be exactly { flightId, from }',
    'si-unlink': 'si-unlink params must be exactly { flightId }',
    'si-import': 'si-import params must be exactly { flightId }',
    'si-pdc': 'si-pdc params must be exactly { plannedLegId }',
  };

  it('decodes each accepted shape and round-trips it', () => {
    for (const line of ACCEPTED) {
      const result = decodeControlMessage(line);
      expect(result, line).toEqual({ ok: true, message: JSON.parse(line) });
      if (result.ok) expect(encodeControlMessage(result.message)).toBe(`${line}\n`);
    }
    expect(new Set(ACCEPTED.map((line) => JSON.parse(line).op))).toEqual(
      new Set(['si-status', 'si-link', 'si-unlink', 'si-import', 'si-pdc']),
    );
  });

  it.each(REJECTED)('%s rejects %s (%s) as bad-shape with the request id echoed', (op, params, _why) => {
    const line = `{"v":1,"type":"datalink-request","id":"dl-90","op":"${op}","params":${params}}`;
    const result = decodeControlMessage(line);
    expect(result, line).toMatchObject({
      ok: false, error: 'bad-shape', messageType: 'datalink-request', requestId: 'dl-90',
    });
    if (!result.ok) {
      expect(describeDecodeError(result)).toBe(`dropped a malformed "datalink-request" message (${DETAIL[op]})`);
    }
  });

  it('covers all five rejection kinds for every op, and non-object params too', () => {
    for (const op of Object.keys(DETAIL)) {
      const kinds = new Set(REJECTED.filter(([name]) => name === op).map(([, , why]) => why));
      expect(kinds.has('extra key'), op).toBe(true);
      expect(kinds.has('missing key'), op).toBe(true);
      expect(kinds.has('wrong type'), op).toBe(true);
      for (const params of ['null', '[]', '"x"', '42']) {
        expect(decodeControlMessage(`{"v":1,"type":"datalink-request","id":"dl-91","op":"${op}","params":${params}}`)).toMatchObject({
          ok: false, error: 'bad-shape', requestId: 'dl-91',
        });
      }
      expect(decodeControlMessage(`{"v":1,"type":"datalink-request","id":"dl-92","op":"${op}"}`)).toMatchObject({
        ok: false, error: 'bad-shape', requestId: 'dl-92',
      });
    }
    expect(new Set(REJECTED.filter(([name]) => name === 'si-link').map(([, , why]) => why))).toContain(
      'from outside the set',
    );
  });

  it('never echoes a rejected value into the detail text', () => {
    const line = '{"v":1,"type":"datalink-request","id":"dl-93","op":"si-link","params":{"flightId":92,"from":"now","body":"HELLO SAYINTENTIONS"}}';
    const result = decodeControlMessage(line);
    expect(result).toMatchObject({ ok: false, error: 'bad-shape' });
    if (!result.ok) {
      expect(describeDecodeError(result)).not.toContain('HELLO');
      expect(describeDecodeError(result)).not.toContain('92');
    }
  });

  it('decodes the five responses and the hello that advertises the feature', () => {
    const lines = [
      '{"v":1,"type":"hello","at":1789800000000,"pid":4242,"sidecarVersion":"0.1.0","nodeVersion":"v20.20.2","configPath":"/x","features":["datalink","simbrief-prefile","pdc-clearance","sayintentions"]}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-80","ok":true,"result":{"answered":"settings","flightId":null,"apiKeySet":false,"linked":null,"link":null,"httpStatus":200}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-81","ok":true,"result":{"answered":"link","flightId":42,"apiKeySet":true,"linked":true,"link":{"upstreamFlightId":"8841207","sinceId":51223,"baselineCommId":51220,"linkedAt":"2026-09-17T14:30:00.000Z","lastImportAt":"2026-09-17T14:40:11.284Z","importedCount":4},"httpStatus":200}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-82","ok":true,"result":{"flightId":42,"created":true,"pendingMessages":4,"link":{"upstreamFlightId":"8841207","sinceId":null,"baselineCommId":51224,"linkedAt":"2026-09-17T14:30:00.000Z","lastImportAt":null,"importedCount":0},"httpStatus":201}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-84","ok":true,"result":{"flightId":42,"unlinked":false,"httpStatus":200}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-85","ok":true,"result":{"flightId":42,"imported":4,"alreadySeen":0,"skipped":1,"sinceId":51224,"httpStatus":201}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-86","ok":true,"result":{"plannedLegId":29,"sentText":"PDC KSFO KLAX CLRD SSTIK3 BSR Q13 RZS KWANG2 CLB 5000FT SQ 2451","httpStatus":201}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-87","ok":false,"error":{"code":"si-no-api-key","httpStatus":409,"serverCode":"NO_API_KEY"}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-88","ok":false,"error":{"code":"sayintentions-in-progress","httpStatus":null,"serverCode":null}}',
      '{"v":1,"type":"datalink-response","at":1789800000000,"id":"dl-89","ok":false,"error":{"code":"sayintentions-unavailable","httpStatus":401,"serverCode":null}}',
    ];
    for (const line of lines) {
      const result = decodeSidecarMessage(line);
      expect(result, line).toEqual({ ok: true, message: JSON.parse(line) });
      if (result.ok) expect(encodeSidecarMessage(result.message)).toBe(`${line}\n`);
    }
    expect(JSON.parse(lines[0]).features).toEqual([
      'datalink', SIMBRIEF_FEATURE, CLEARANCE_FEATURE, SAYINTENTIONS_FEATURE,
    ]);
  });

  it('names the feature, and lists the five ops last and once each', () => {
    expect(SAYINTENTIONS_FEATURE).toBe('sayintentions');
    expect(DATALINK_OPS.slice(-5)).toEqual(['si-status', 'si-link', 'si-unlink', 'si-import', 'si-pdc']);
    expect(DATALINK_OPS).toHaveLength(16);
    expect(new Set(DATALINK_OPS).size).toBe(16);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('a 144-unit sent text and a full link row encode to one line and decode back', () => {
    const wide = {
      v: 1 as const, type: 'datalink-response' as const, at: AT, id: 'dl-94', ok: true as const,
      result: { plannedLegId: 29, sentText: 'P'.repeat(144), httpStatus: 201 },
    };
    expect(wide.result.sentText).toHaveLength(144);
    const encoded = encodeDatalinkResponse(wide);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(decodeSidecarMessage(encoded.trim())).toEqual({ ok: true, message: wide });
  });
});

describe('the navdata status axis', () => {
  const plain = SIDECAR_MESSAGES.find(
    (message): message is StatusMessage => message.type === 'status',
  ) as StatusMessage;

  const axis: NavdataStatusAxis = {
    state: 'nav.bulk',
    reason: 'the airport index is being rebuilt',
    snapshotId: 'S-1757600000000-9f2c1a4b',
    rev: 41871,
    ackedRev: 40000,
    airports: 41871,
    navaids: 1408,
    waypoints: 12345,
    pendingDemand: 7,
    lastSyncAt: AT,
    lastSyncError: null,
  };

  it('is a feature string a shell that has never heard of it can ignore', () => {
    const hello = SIDECAR_MESSAGES.find(
      (message) => message.type === 'hello',
    ) as Extract<SidecarMessage, { type: 'hello' }>;
    const older = ['datalink', 'simbrief-prefile', 'pdc-clearance', 'sayintentions'];
    const advertised = { ...hello, features: [...older, NAVDATA_FEATURE] };
    const decoded = decodeSidecarMessage(encodeSidecarMessage(advertised).trim());

    expect(decoded).toEqual({ ok: true, message: advertised });
    // A shell reads the features it knows and finds them unmoved; the one it
    // does not know is a string in a list and means nothing to it.
    expect((decoded as { message: typeof advertised }).message.features?.slice(0, 4)).toEqual(older);
  });

  it('moves neither the protocol version nor the line cap', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAX_LINE_BYTES).toBe(65536);
    expect(NAVDATA_FEATURE).toBe('navdata');
  });

  it('rides one status line, well inside what the shell will read', () => {
    const withAxis: StatusMessage = { ...plain, navdata: axis };
    const encoded = encodeSidecarMessage(withAxis);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.trimEnd()).not.toContain('\n');
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(MAX_LINE_BYTES / 8);
    expect(decodeSidecarMessage(encoded.trim())).toEqual({ ok: true, message: withAxis });
  });

  it('is optional: a status without it is still a valid status', () => {
    expect(plain.navdata).toBeUndefined();
    const decoded = decodeSidecarMessage(encodeSidecarMessage(plain).trim());
    expect(decoded).toEqual({ ok: true, message: plain });
    expect(JSON.parse(encodeSidecarMessage(plain))).not.toHaveProperty('navdata');
  });
});
