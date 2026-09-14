// ── Shell <-> sidecar IPC codec ───────────────────────────────────────────────
//
// One JSON object per line: stdout carries sidecar -> shell, stdin carries
// shell -> sidecar. Line-delimited JSON because it is debuggable with `head`,
// testable with a string, and readable by a human when the sidecar is run
// standalone — which is exactly how it gets verified.
//
// Nothing here throws. A decode failure of any kind must not terminate a
// process, kill the child or blank the panel: a blank panel on a machine the
// developer cannot reach is the worst outcome in this system, so the failure
// mode everywhere is "drop the line, keep the last good state".
//
// Pure: no I/O, no sockets. The only import is a type, erased at compile time.

import type { RedactedConfig } from './config';
import type { AppStateId, BackendStateId, PauseStateId, SimStateId } from './status';

/** Bumped only on a breaking change: a removed field, a changed type or meaning. */
export const PROTOCOL_VERSION = 1;

/** A line longer than this is dropped with a decode error, never buffered. */
export const MAX_LINE_BYTES = 65536;

// ── sidecar -> shell ──────────────────────────────────────────────────────────

/** First line the sidecar ever writes. */
export interface HelloMessage {
  v: 1;
  type: 'hello';
  at: number;
  pid: number;
  sidecarVersion: string;
  nodeVersion: string;
  configPath: string;
}

/** The whole observable state. Always complete — never a partial patch. */
export interface StatusMessage {
  v: 1;
  type: 'status';
  at: number;
  app: {
    state: AppStateId;
    problems?: { field: string; message: string }[];
  };
  sim: {
    state: SimStateId;
    attempt: number;
    nextRetryAt: number | null;
    retryDelayMs: number | null;
    protocol: string;
    appName: string | null;
    appVersion: string | null;
    lastError: string | null;
  };
  backend: {
    state: BackendStateId;
    httpStatus: number | null;
    lastOkAt: number | null;
    lastErrorAt: number | null;
    message: string | null;
  };
  pause: {
    state: PauseStateId;
    flags: number;
    label: string;
    usingPauseEx1: boolean;
  };
  traffic: {
    enabled: boolean;
    radiusM: number;
    lastSweepAt: number | null;
    lastBatchSize: number | null;
    lastError: string | null;
  };
  /** Redacted — the token is a type error here, not just a convention. */
  config: RedactedConfig | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Human-readable log, mirroring what the CLI agent printed to the console. */
export interface LogMessage {
  v: 1;
  type: 'log';
  at: number;
  level: LogLevel;
  message: string;
}

export interface PongMessage {
  v: 1;
  type: 'pong';
  at: number;
  id: string;
}

/**
 * Reserved for a future live-data page: named and shaped now, emitted never in
 * this build. An unknown type is a silent no-op for every consumer, so a later
 * sidecar can start emitting these without renegotiating anything.
 */
export interface FrameMessage {
  v: 1;
  type: 'frame';
  at: number;
  frame: {
    lat: number;
    lon: number;
    altitudeFt: number;
    airspeedKnots: number;
    groundSpeedKnots: number;
    headingDeg: number;
    verticalSpeedFpm: number;
    onGround: boolean;
    simRunning: number;
    aircraft: string;
  };
}

export interface TrafficMessage {
  v: 1;
  type: 'traffic';
  at: number;
  count: number;
  objects: {
    id: number;
    lat: number;
    lon: number;
    altitudeFt: number;
    headingDeg: number;
    onGround: boolean;
  }[];
}

export type SidecarMessage =
  | HelloMessage
  | StatusMessage
  | LogMessage
  | PongMessage
  | FrameMessage
  | TrafficMessage;

export type SidecarMessageType = SidecarMessage['type'];

// ── shell -> sidecar ──────────────────────────────────────────────────────────

export interface ControlStart {
  v: 1;
  type: 'start';
}
export interface ControlStop {
  v: 1;
  type: 'stop';
}
export interface ControlConfig {
  v: 1;
  type: 'config';
  path?: string;
}
export interface ControlShutdown {
  v: 1;
  type: 'shutdown';
}
export interface ControlPing {
  v: 1;
  type: 'ping';
  id: string;
}

export type ControlMessage =
  | ControlStart
  | ControlStop
  | ControlConfig
  | ControlShutdown
  | ControlPing;

export type ControlMessageType = ControlMessage['type'];

// ── codec ─────────────────────────────────────────────────────────────────────

export type DecodeError =
  | { ok: false; error: 'oversize'; bytes: number }
  | { ok: false; error: 'not-json'; detail: string }
  | { ok: false; error: 'not-object' }
  | { ok: false; error: 'bad-version'; v: unknown }
  | { ok: false; error: 'unknown-type'; messageType: string }
  | { ok: false; error: 'bad-shape'; messageType: string; detail: string };

export type DecodeResult<T> = { ok: true; message: T } | DecodeError;

const SIDECAR_TYPES: readonly SidecarMessageType[] = [
  'hello',
  'status',
  'log',
  'pong',
  'frame',
  'traffic',
];

const CONTROL_TYPES: readonly ControlMessageType[] = [
  'start',
  'stop',
  'config',
  'shutdown',
  'ping',
];

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Returns null when the line is not worth decoding (blank), else a result. */
function preDecode(line: string): { value: Record<string, unknown> } | DecodeError {
  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > MAX_LINE_BYTES) return { ok: false, error: 'oversize', bytes };

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return { ok: false, error: 'not-json', detail: err instanceof Error ? err.message : String(err) };
  }

  if (!isPlainObject(parsed)) return { ok: false, error: 'not-object' };
  if (parsed.v !== PROTOCOL_VERSION) return { ok: false, error: 'bad-version', v: parsed.v };
  return { value: parsed };
}

function badShape(messageType: string, detail: string): DecodeError {
  return { ok: false, error: 'bad-shape', messageType, detail };
}

/** Empty and whitespace-only lines are skipped before decoding; not errors. */
export function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

export function decodeSidecarMessage(line: string): DecodeResult<SidecarMessage> {
  const pre = preDecode(line);
  if ('ok' in pre) return pre;
  const obj = pre.value;

  const messageType = obj.type;
  if (!isString(messageType) || !(SIDECAR_TYPES as readonly string[]).includes(messageType)) {
    return { ok: false, error: 'unknown-type', messageType: isString(messageType) ? messageType : String(messageType) };
  }
  if (!isFiniteNumber(obj.at)) return badShape(messageType, 'at must be a number');

  switch (messageType as SidecarMessageType) {
    case 'hello': {
      if (!isFiniteNumber(obj.pid)) return badShape(messageType, 'pid must be a number');
      if (!isString(obj.sidecarVersion)) return badShape(messageType, 'sidecarVersion must be a string');
      if (!isString(obj.nodeVersion)) return badShape(messageType, 'nodeVersion must be a string');
      if (!isString(obj.configPath)) return badShape(messageType, 'configPath must be a string');
      return { ok: true, message: obj as unknown as HelloMessage };
    }
    case 'status': {
      for (const axis of ['app', 'sim', 'backend', 'pause', 'traffic'] as const) {
        const value = obj[axis];
        if (!isPlainObject(value)) return badShape(messageType, `${axis} must be an object`);
        if (axis !== 'traffic' && !isString(value.state)) {
          return badShape(messageType, `${axis}.state must be a string`);
        }
      }
      if (obj.config !== null && !isPlainObject(obj.config)) {
        return badShape(messageType, 'config must be an object or null');
      }
      return { ok: true, message: obj as unknown as StatusMessage };
    }
    case 'log': {
      if (!isString(obj.level) || !(LOG_LEVELS as readonly string[]).includes(obj.level)) {
        return badShape(messageType, 'level must be one of debug, info, warn, error');
      }
      if (!isString(obj.message)) return badShape(messageType, 'message must be a string');
      return { ok: true, message: obj as unknown as LogMessage };
    }
    case 'pong': {
      if (!isString(obj.id)) return badShape(messageType, 'id must be a string');
      return { ok: true, message: obj as unknown as PongMessage };
    }
    case 'frame': {
      if (!isPlainObject(obj.frame)) return badShape(messageType, 'frame must be an object');
      return { ok: true, message: obj as unknown as FrameMessage };
    }
    case 'traffic': {
      if (!isFiniteNumber(obj.count)) return badShape(messageType, 'count must be a number');
      if (!Array.isArray(obj.objects)) return badShape(messageType, 'objects must be an array');
      return { ok: true, message: obj as unknown as TrafficMessage };
    }
  }
}

export function decodeControlMessage(line: string): DecodeResult<ControlMessage> {
  const pre = preDecode(line);
  if ('ok' in pre) return pre;
  const obj = pre.value;

  const messageType = obj.type;
  if (!isString(messageType) || !(CONTROL_TYPES as readonly string[]).includes(messageType)) {
    return { ok: false, error: 'unknown-type', messageType: isString(messageType) ? messageType : String(messageType) };
  }

  switch (messageType as ControlMessageType) {
    case 'config': {
      if (obj.path !== undefined && !isString(obj.path)) {
        return badShape(messageType, 'path must be a string when present');
      }
      return { ok: true, message: obj as unknown as ControlConfig };
    }
    case 'ping': {
      if (!isString(obj.id)) return badShape(messageType, 'id must be a string');
      return { ok: true, message: obj as unknown as ControlPing };
    }
    default:
      return { ok: true, message: obj as unknown as ControlMessage };
  }
}

/** Exactly one line, newline-terminated; JSON.stringify escapes any newline. */
export function encodeSidecarMessage(message: SidecarMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function encodeControlMessage(message: ControlMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** One-line, already-redacted description of a decode failure, for the log. */
export function describeDecodeError(error: DecodeError): string {
  switch (error.error) {
    case 'oversize':
      return `dropped an oversized line (${error.bytes} bytes, limit ${MAX_LINE_BYTES})`;
    case 'not-json':
      return `dropped a line that is not JSON (${error.detail})`;
    case 'not-object':
      return 'dropped a line that is not a JSON object';
    case 'bad-version':
      return `dropped a line with protocol version ${JSON.stringify(error.v)}, expected ${PROTOCOL_VERSION}`;
    case 'unknown-type':
      return `ignored an unknown message type "${error.messageType}"`;
    case 'bad-shape':
      return `dropped a malformed "${error.messageType}" message (${error.detail})`;
  }
}
