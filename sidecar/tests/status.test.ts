// tests/status.test.ts — tests src/status.ts.
//
// EXPECTED below is an independent transcription of the status vocabulary: id,
// axis, label and severity for every state, in order. It is deliberately a
// second copy rather than a loop over the module's own table, because the
// point is to fail when a row is added, renamed, reordered or dropped on one
// side only. The webview implements the same vocabulary a third time; that
// copy is checked by its own harness.

import { describe, expect, it } from 'vitest';
import {
  backendStateFromErrorCode,
  backendStateFromStatus,
  describePause,
  describeState,
  formatStateLabel,
  isStateId,
  nextReconnectDelayMs,
  pauseStateFromFlags,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  STATUS_STATES,
} from '../src/status';

const EXPECTED: [string, string, string, string][] = [
  // id, axis, label, severity
  ['app.starting', 'app', 'SIDECAR STARTING', 'caution'],
  ['app.no-config', 'app', 'NO CONFIG', 'caution'],
  ['app.error-config', 'app', 'CONFIG INVALID', 'fault'],
  ['app.stopped', 'app', 'UPLINK STOPPED', 'idle'],
  ['app.running', 'app', 'UPLINK ACTIVE', 'ok'],
  ['app.crashed', 'app', 'SIDECAR FAULT', 'fault'],
  ['app.restarting', 'app', 'SIDECAR RESTART', 'caution'],

  ['sim.idle', 'sim', 'SIM LINK STANDBY', 'idle'],
  ['sim.connecting', 'sim', 'SIM LINK CONNECTING', 'caution'],
  ['sim.connected', 'sim', 'SIM LINK ONLINE', 'ok'],
  ['sim.retry', 'sim', 'SIM LINK RETRY {ss}S', 'caution'],

  ['net.idle', 'backend', 'ACARS STANDBY', 'idle'],
  ['net.pending', 'backend', 'ACARS CONNECTING', 'caution'],
  ['net.ok', 'backend', 'ACARS UPLINK', 'ok'],
  ['net.standby', 'backend', 'ACARS READY', 'ok'],
  ['net.unauthorized', 'backend', 'ACARS REJECT 401', 'fault'],
  ['net.http-error', 'backend', 'ACARS FAULT {status}', 'fault'],
  ['net.tls-error', 'backend', 'ACARS CERT FAULT', 'fault'],
  ['net.unreachable', 'backend', 'ACARS NO COMM', 'fault'],

  ['pause.off', 'pause', 'PAUSE OFF', 'idle'],
  ['pause.full', 'pause', 'SIM PAUSED', 'caution'],
  ['pause.active', 'pause', 'ACTIVE PAUSE', 'caution'],
  ['pause.menu', 'pause', 'SIM MENU', 'caution'],
  ['pause.unknown', 'pause', 'PAUSE {flags}', 'caution'],
];

describe('the status table, row by row', () => {
  it('has exactly the expected rows, in order', () => {
    expect(STATUS_STATES.map((s) => s.id)).toEqual(EXPECTED.map(([id]) => id));
  });

  for (const [id, axis, label, severity] of EXPECTED) {
    it(`${id} is "${label}" on axis ${axis} at severity ${severity}`, () => {
      const state = describeState(id);
      expect(state.axis).toBe(axis);
      expect(state.label).toBe(label);
      expect(state.severity).toBe(severity);
    });
  }

  it('labels are uppercase ASCII and fit the screen grid', () => {
    for (const state of STATUS_STATES) {
      expect(state.label.length).toBeLessThanOrEqual(20);
      // Placeholders are lowercase by convention; the rest must be uppercase.
      const literal = state.label.replace(/\{[a-z]+\}/g, '');
      expect(literal).toBe(literal.toUpperCase());
      expect(literal).toMatch(/^[A-Z0-9 ]*$/);
    }
  });

  it('the connected-backend label is exactly ACARS UPLINK, and appears once', () => {
    expect(describeState('net.ok').label).toBe('ACARS UPLINK');
    expect(STATUS_STATES.filter((s) => s.label === 'ACARS UPLINK')).toHaveLength(1);
  });

  it('every axis has an idle state, so no line is ever blank', () => {
    for (const axis of ['app', 'sim', 'backend', 'pause']) {
      expect(STATUS_STATES.some((s) => s.axis === axis && s.severity === 'idle')).toBe(true);
    }
  });

  it('degrades an unknown id rather than throwing or blanking', () => {
    expect(isStateId('net.teapot')).toBe(false);
    const state = describeState('net.teapot');
    expect(state.label).toBe('?? net.teapot');
    expect(state.severity).toBe('caution');
  });
});

describe('formatStateLabel', () => {
  it('renders the retry countdown zero-padded and capped at 99', () => {
    expect(formatStateLabel('sim.retry', { remainingMs: 5000 })).toBe('SIM LINK RETRY 05S');
    expect(formatStateLabel('sim.retry', { remainingMs: 60000 })).toBe('SIM LINK RETRY 60S');
    expect(formatStateLabel('sim.retry', { remainingMs: 500000 })).toBe('SIM LINK RETRY 99S');
    expect(formatStateLabel('sim.retry', { remainingMs: -1 })).toBe('SIM LINK RETRY 00S');
  });

  it('fills the HTTP status and the raw pause flags', () => {
    expect(formatStateLabel('net.http-error', { httpStatus: 503 })).toBe('ACARS FAULT 503');
    expect(formatStateLabel('pause.unknown', { flags: 16 })).toBe('PAUSE 16');
  });

  it('leaves a placeholder-free label alone', () => {
    expect(formatStateLabel('net.ok')).toBe('ACARS UPLINK');
  });
});

describe('nextReconnectDelayMs', () => {
  it('reproduces the agent backoff for attempts 0..8', () => {
    const ladder = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(nextReconnectDelayMs);
    expect(ladder).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000, 60000, 60000]);
  });

  it('starts at the base delay and never exceeds the cap', () => {
    expect(nextReconnectDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(nextReconnectDelayMs(100)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(nextReconnectDelayMs(-1)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(nextReconnectDelayMs(Number.NaN)).toBe(RECONNECT_BASE_DELAY_MS);
  });
});

describe('pause decoding', () => {
  const rows: [number, string, string][] = [
    // flags, state id, describePause() text
    [0, 'pause.off', 'off'],
    [1, 'pause.full', 'full'],
    [2, 'pause.full', 'with-sound'],
    [3, 'pause.full', 'full+with-sound'],
    [4, 'pause.active', 'active'],
    [5, 'pause.active', 'full+active'],
    [8, 'pause.menu', 'sim'],
    [9, 'pause.menu', 'full+sim'],
    [12, 'pause.active', 'active+sim'],
    [16, 'pause.unknown', 'unknown(16)'],
  ];

  for (const [flags, stateId, text] of rows) {
    it(`flags ${flags} -> ${stateId} / "${text}"`, () => {
      expect(pauseStateFromFlags(flags)).toBe(stateId);
      expect(describePause(flags)).toBe(text);
    });
  }

  it('active pause outranks every other bit', () => {
    expect(pauseStateFromFlags(1 | 2 | 4 | 8)).toBe('pause.active');
  });
});

describe('backend axis classification', () => {
  it('maps ingest response statuses', () => {
    expect(backendStateFromStatus(200)).toBe('net.ok');
    expect(backendStateFromStatus(204)).toBe('net.ok');
    expect(backendStateFromStatus(401)).toBe('net.unauthorized');
    expect(backendStateFromStatus(500)).toBe('net.http-error');
    expect(backendStateFromStatus(404)).toBe('net.http-error');
  });

  it('separates a TLS refusal from a transport failure', () => {
    expect(backendStateFromErrorCode('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe('net.tls-error');
    expect(backendStateFromErrorCode('ERR_TLS_CERT_ALTNAME_INVALID')).toBe('net.tls-error');
    expect(backendStateFromErrorCode('ECONNREFUSED')).toBe('net.unreachable');
    expect(backendStateFromErrorCode(undefined)).toBe('net.unreachable');
  });
});
