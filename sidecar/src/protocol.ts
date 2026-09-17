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
// Pure: no I/O, no sockets. The only imports are types, erased at compile time.

import type { RedactedConfig } from './config';
import type { DatalinkErrorCode, DatalinkStateId } from './datalink-classify';
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
  /**
   * Optional capabilities. A shell must not send a datalink-request to a
   * sidecar whose hello lacks 'datalink': an older sidecar would ignore it and
   * leave the request hanging.
   */
  features?: string[];
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

// ── datalink ──────────────────────────────────────────────────────────────────
//
// All additive under protocol version 1: an older shell drops these as unknown
// types, and an older sidecar never advertises the feature, so neither side
// has to renegotiate anything.

export const DATALINK_FEATURE = 'datalink';
/**
 * The SimBrief settings, prefile and prefile-clear ops. A shell must not send
 * them to a sidecar whose hello lacks this feature, for the same reason as
 * 'datalink': an older sidecar would leave the request unanswered.
 */
export const SIMBRIEF_FEATURE = 'simbrief-prefile';
/**
 * The clearance op. A shell must not send it to a sidecar whose hello lacks
 * this feature: an older sidecar would leave the request unanswered.
 */
export const CLEARANCE_FEATURE = 'pdc-clearance';

export const DATALINK_REQUEST_ID_PATTERN = /^dl-[0-9]{1,20}$/;
export const CANNED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ICAO_PATTERN = /^[A-Z][A-Z0-9]{3}$/;

export type DatalinkScope =
  | { kind: 'flight'; flightId: number; plannedLegId: number | null }
  | { kind: 'leg'; plannedLegId: number; source: 'status' | 'ground-session' | 'prefile' }
  | { kind: 'none' };

export interface DatalinkThreadSummary {
  epoch: number;
  total: number;
  /** Lowest seq still cached: total minus the number of cached messages. */
  firstSeq: number;
  newestId: number | null;
  /** Rows that failed shape validation in the last fetch. */
  droppedRows: number;
}

export interface DatalinkMessage {
  /** 0-based position among the valid rows, oldest first. */
  seq: number;
  id: number;
  direction: 'uplink' | 'downlink';
  category: string;
  label: string | null;
  body: string;
  sentAt: string;
  correlationId: number | null;
}

export interface CannedMessageEntry {
  id: string;
  label: string;
}

export interface LoadsheetSheet {
  units: string | null;
  blockFuel: number | null;
  taxiFuel: number | null;
  takeoffFuel: number | null;
  tripFuel: number | null;
  payload: number | null;
  payloadSource: string | null;
  zeroFuelWeight: number | null;
  zfwSource: string | null;
  maxZeroFuelWeight: number | null;
  dryOperatingWeight: number | null;
  takeoffWeight: number | null;
}

/** Codes only: no server `error` text ever crosses a process boundary. */
export interface DatalinkError {
  code: DatalinkErrorCode;
  httpStatus: number | null;
  serverCode: string | null;
}

export type DatalinkOp =
  | 'watch'
  | 'refresh'
  | 'thread'
  | 'canned-list'
  | 'send-canned'
  | 'wx'
  | 'loadsheet'
  | 'simbrief-settings'
  | 'simbrief-prefile'
  | 'prefile-clear'
  | 'clearance';

export interface WriteTarget {
  kind: 'flight' | 'leg';
  id: number;
}

export interface DatalinkParams {
  watch: { on: boolean };
  refresh: Record<string, never>;
  thread: { epoch: number; endSeq: number };
  'canned-list': Record<string, never>;
  'send-canned': { target: WriteTarget; cannedId: string };
  wx: { target: WriteTarget; icao: string };
  loadsheet: { plannedLegId: number };
  // None of the SimBrief ops takes a parameter: the server picks the pilot's
  // current OFP, and duplicates are never forced through.
  'simbrief-settings': Record<string, never>;
  'simbrief-prefile': Record<string, never>;
  'prefile-clear': Record<string, never>;
  // The server takes no request body: the leg id is the whole request.
  clearance: { plannedLegId: number };
}

export interface DatalinkResults {
  watch: { watching: boolean; leaseMs: number };
  refresh: { accepted: true; coalesced: boolean };
  thread: {
    epoch: number;
    total: number;
    firstSeq: number;
    startSeq: number;
    endSeq: number;
    messages: DatalinkMessage[];
  };
  'canned-list': { messages: CannedMessageEntry[]; truncated: boolean };
  'send-canned': { sent: true; httpStatus: number };
  wx: { icao: string; available: boolean; metar: string | null; taf: string | null; fetchedAt: string | null };
  loadsheet: { plannedLegId: number; created: boolean; httpStatus: number; sheet: LoadsheetSheet };
  /** Whether a SimBrief Pilot ID is saved on the server. The id itself never crosses the wire. */
  'simbrief-settings': { configured: boolean };
  'simbrief-prefile': {
    status: 'imported' | 'duplicate';
    plannedLegId: number;
    /** Token-scrubbed, then capped; may be empty. */
    label: string;
    /** How many warnings the server attached; their text is never forwarded. */
    warningCount: number;
    httpStatus: number;
  };
  /** True when a prefiled leg was held and has now been dropped. */
  'prefile-clear': { cleared: boolean };
  /**
   * The structured clearance only. The request and reply messages, their
   * bodies and the server's payload reach the webview through the thread.
   */
  clearance: {
    /** Always the requested id; a body naming another leg is bad-response. */
    plannedLegId: number;
    /** false: the leg already had a clearance, and these are the stored rows. */
    created: boolean;
    /** Trimmed and upper-cased, 1 to 8 of [A-Z0-9], or null. */
    departure: string | null;
    destination: string | null;
    /** Token-scrubbed, never blank, at most 4096 UTF-16 units; or null. */
    route: string | null;
    /** A safe integer from 0 to 99 999. */
    initialAltitudeFt: number;
    /** Four octal digits. */
    squawk: string;
    httpStatus: number;
  };
}

/** The leg the user prefiled from SimBrief, held by the sidecar as a scope of its own. */
export interface PrefiledLeg {
  plannedLegId: number;
  label: string;
}

/** An op's answer before it is wrapped in a response line. */
export type DatalinkOutcome<K extends DatalinkOp = DatalinkOp> =
  | { ok: true; result: DatalinkResults[K] }
  | { ok: false; error: DatalinkError };

/** shell -> sidecar. */
export type DatalinkRequestMessage = {
  [K in DatalinkOp]: { v: 1; type: 'datalink-request'; id: string; op: K; params: DatalinkParams[K] };
}[DatalinkOp];

/** sidecar -> shell, exactly one per decoded request id. */
export type DatalinkResponseMessage =
  | { v: 1; type: 'datalink-response'; at: number; id: string; ok: true; result: DatalinkResults[DatalinkOp] }
  | { v: 1; type: 'datalink-response'; at: number; id: string; ok: false; error: DatalinkError };

/** sidecar -> shell, unsolicited. Always complete, never a patch. */
export interface DatalinkStateMessage {
  v: 1;
  type: 'datalink-state';
  at: number;
  state: DatalinkStateId;
  watching: boolean;
  httpStatus: number | null;
  serverCode: string | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  nextPollAt: number | null;
  /** null until a poll cycle has resolved a scope. */
  scope: DatalinkScope | null;
  /** null when there is no cached thread for the scope. */
  thread: DatalinkThreadSummary | null;
  /** Present only while a prefiled leg is held; the key is omitted otherwise. */
  prefiledLeg?: PrefiledLeg;
}

export type SidecarMessage =
  | HelloMessage
  | StatusMessage
  | LogMessage
  | PongMessage
  | FrameMessage
  | TrafficMessage
  | DatalinkResponseMessage
  | DatalinkStateMessage;

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
  | ControlPing
  | DatalinkRequestMessage;

export type ControlMessageType = ControlMessage['type'];

// ── codec ─────────────────────────────────────────────────────────────────────

export type DecodeError =
  | { ok: false; error: 'oversize'; bytes: number }
  | { ok: false; error: 'not-json'; detail: string }
  | { ok: false; error: 'not-object' }
  | { ok: false; error: 'bad-version'; v: unknown }
  | { ok: false; error: 'unknown-type'; messageType: string }
  | {
      ok: false;
      error: 'bad-shape';
      messageType: string;
      detail: string;
      /** Set for a malformed datalink-request whose id was valid, so it can still be answered. */
      requestId?: string;
    };

export type DecodeResult<T> = { ok: true; message: T } | DecodeError;

const SIDECAR_TYPES: readonly SidecarMessageType[] = [
  'hello',
  'status',
  'log',
  'pong',
  'frame',
  'traffic',
  'datalink-response',
  'datalink-state',
];

const CONTROL_TYPES: readonly ControlMessageType[] = [
  'start',
  'stop',
  'config',
  'shutdown',
  'ping',
  'datalink-request',
];

export const DATALINK_OPS: readonly DatalinkOp[] = [
  'watch',
  'refresh',
  'thread',
  'canned-list',
  'send-canned',
  'wx',
  'loadsheet',
  'simbrief-settings',
  'simbrief-prefile',
  'prefile-clear',
  'clearance',
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

function isSafeInt(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isWriteTarget(value: unknown): value is WriteTarget {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ['kind', 'id']) &&
    (value.kind === 'flight' || value.kind === 'leg') &&
    isSafeInt(value.id, 1)
  );
}

/**
 * Params must carry exactly the op's keys. An extra key such as `body` or
 * `text` next to a canned id is precisely how free text would be smuggled into
 * a downlink, so it is a shape error rather than something to ignore. Details
 * are fixed text: a rejected value is never echoed into a log.
 */
function datalinkParamsProblem(op: DatalinkOp, params: Record<string, unknown>): string | null {
  switch (op) {
    case 'watch':
      return hasExactKeys(params, ['on']) && typeof params.on === 'boolean'
        ? null
        : 'watch params must be exactly { on }';
    case 'refresh':
    case 'canned-list':
    // Any key here, a duplicate override or a trip or pilot id among them,
    // would ask the server for something the CDU never offers.
    case 'simbrief-settings':
    case 'simbrief-prefile':
    case 'prefile-clear':
      return hasExactKeys(params, []) ? null : `${op} params must be empty`;
    case 'thread':
      return hasExactKeys(params, ['epoch', 'endSeq']) && isSafeInt(params.epoch, 1) && isSafeInt(params.endSeq, 0)
        ? null
        : 'thread params must be exactly { epoch, endSeq }';
    case 'send-canned':
      return hasExactKeys(params, ['target', 'cannedId']) &&
        isWriteTarget(params.target) &&
        isString(params.cannedId) &&
        CANNED_ID_PATTERN.test(params.cannedId)
        ? null
        : 'send-canned params must be exactly { target, cannedId }';
    case 'wx':
      return hasExactKeys(params, ['target', 'icao']) &&
        isWriteTarget(params.target) &&
        isString(params.icao) &&
        ICAO_PATTERN.test(params.icao)
        ? null
        : 'wx params must be exactly { target, icao }';
    case 'loadsheet':
      return hasExactKeys(params, ['plannedLegId']) && isSafeInt(params.plannedLegId, 1)
        ? null
        : 'loadsheet params must be exactly { plannedLegId }';
    // A trip or flight id next to the leg would let the request aim at
    // something other than the leg the CDU confirmed.
    case 'clearance':
      return hasExactKeys(params, ['plannedLegId']) && isSafeInt(params.plannedLegId, 1)
        ? null
        : 'clearance params must be exactly { plannedLegId }';
  }
}

function decodeDatalinkRequest(obj: Record<string, unknown>): DecodeResult<ControlMessage> {
  const messageType = 'datalink-request';
  if (!isString(obj.id) || !DATALINK_REQUEST_ID_PATTERN.test(obj.id)) {
    return badShape(messageType, 'id must be dl-<digits>');
  }
  const requestId = obj.id;
  const reject = (detail: string): DecodeError => ({
    ok: false,
    error: 'bad-shape',
    messageType,
    detail,
    requestId,
  });
  if (!isString(obj.op) || !(DATALINK_OPS as readonly string[]).includes(obj.op)) {
    return reject('op is not a datalink operation');
  }
  if (!isPlainObject(obj.params)) return reject('params must be an object');
  const problem = datalinkParamsProblem(obj.op as DatalinkOp, obj.params);
  if (problem !== null) return reject(problem);
  return { ok: true, message: obj as unknown as DatalinkRequestMessage };
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
      if (obj.features !== undefined && !(Array.isArray(obj.features) && obj.features.every(isString))) {
        return badShape(messageType, 'features must be an array of strings when present');
      }
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
    case 'datalink-response': {
      if (!isString(obj.id)) return badShape(messageType, 'id must be a string');
      if (typeof obj.ok !== 'boolean') return badShape(messageType, 'ok must be a boolean');
      if (obj.ok && !isPlainObject(obj.result)) return badShape(messageType, 'result must be an object');
      if (!obj.ok && !(isPlainObject(obj.error) && isString(obj.error.code))) {
        return badShape(messageType, 'error must be an object with a string code');
      }
      return { ok: true, message: obj as unknown as DatalinkResponseMessage };
    }
    case 'datalink-state': {
      if (!isString(obj.state)) return badShape(messageType, 'state must be a string');
      if (typeof obj.watching !== 'boolean') return badShape(messageType, 'watching must be a boolean');
      if (obj.scope !== null && !isPlainObject(obj.scope)) {
        return badShape(messageType, 'scope must be an object or null');
      }
      if (obj.thread !== null && !isPlainObject(obj.thread)) {
        return badShape(messageType, 'thread must be an object or null');
      }
      return { ok: true, message: obj as unknown as DatalinkStateMessage };
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
    case 'datalink-request':
      return decodeDatalinkRequest(obj);
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

/**
 * Every datalink-response is written through this. A result that would not fit
 * on one line becomes a `too-large` error for the same request id, so no
 * oversize line is ever written and the shell still gets exactly one answer.
 */
export function encodeDatalinkResponse(message: DatalinkResponseMessage): string {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_BYTES) return line;
  const fallback: DatalinkResponseMessage = {
    v: message.v,
    type: message.type,
    at: message.at,
    id: message.id,
    ok: false,
    error: { code: 'too-large', httpStatus: null, serverCode: null },
  };
  return `${JSON.stringify(fallback)}\n`;
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
