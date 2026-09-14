// ── FMC status vocabulary ─────────────────────────────────────────────────────
//
// Four axes, all visible at once: the SimConnect link being down and the
// server being unreachable are different problems with different fixes, so a
// single "status" line would have to pick one and hide the other.
//
// This table is the authority for the sidecar half; the webview implements the
// same table independently and a contract check keeps the two honest. Pure by
// construction: no imports, no I/O, no timers. The reconnect backoff lives
// here rather than in simconnect.ts because a retry ladder is decision logic
// and belongs where it can be asserted.

export type AxisId = 'app' | 'sim' | 'backend' | 'pause';

export type Severity = 'ok' | 'caution' | 'fault' | 'idle';

export type AppStateId =
  | 'app.starting'
  | 'app.no-config'
  | 'app.error-config'
  | 'app.stopped'
  | 'app.running'
  | 'app.crashed'
  | 'app.restarting';

export type SimStateId = 'sim.idle' | 'sim.connecting' | 'sim.connected' | 'sim.retry';

export type BackendStateId =
  | 'net.idle'
  | 'net.pending'
  | 'net.ok'
  | 'net.standby'
  | 'net.unauthorized'
  | 'net.http-error'
  | 'net.tls-error'
  | 'net.unreachable';

export type PauseStateId =
  | 'pause.off'
  | 'pause.full'
  | 'pause.active'
  | 'pause.menu'
  | 'pause.unknown';

export type StateId = AppStateId | SimStateId | BackendStateId | PauseStateId;

export interface StatusState {
  id: StateId;
  axis: AxisId;
  /**
   * Display label. `{ss}`, `{status}` and `{flags}` are placeholders filled by
   * formatStateLabel(); the raw template is what the contract check compares.
   */
  label: string;
  severity: Severity;
  /** Which side of the IPC boundary is entitled to claim this state. */
  emittedBy: 'sidecar' | 'tauri';
}

/**
 * The state table, in axis order. Order is part of the contract: the status
 * page renders one line per axis, always present, never collapsed.
 */
export const STATUS_STATES: readonly StatusState[] = [
  { id: 'app.starting', axis: 'app', label: 'SIDECAR STARTING', severity: 'caution', emittedBy: 'sidecar' },
  { id: 'app.no-config', axis: 'app', label: 'NO CONFIG', severity: 'caution', emittedBy: 'sidecar' },
  { id: 'app.error-config', axis: 'app', label: 'CONFIG INVALID', severity: 'fault', emittedBy: 'sidecar' },
  { id: 'app.stopped', axis: 'app', label: 'UPLINK STOPPED', severity: 'idle', emittedBy: 'sidecar' },
  { id: 'app.running', axis: 'app', label: 'UPLINK ACTIVE', severity: 'ok', emittedBy: 'sidecar' },
  { id: 'app.crashed', axis: 'app', label: 'SIDECAR FAULT', severity: 'fault', emittedBy: 'tauri' },
  { id: 'app.restarting', axis: 'app', label: 'SIDECAR RESTART', severity: 'caution', emittedBy: 'tauri' },

  { id: 'sim.idle', axis: 'sim', label: 'SIM LINK STANDBY', severity: 'idle', emittedBy: 'sidecar' },
  { id: 'sim.connecting', axis: 'sim', label: 'SIM LINK CONNECTING', severity: 'caution', emittedBy: 'sidecar' },
  { id: 'sim.connected', axis: 'sim', label: 'SIM LINK ONLINE', severity: 'ok', emittedBy: 'sidecar' },
  { id: 'sim.retry', axis: 'sim', label: 'SIM LINK RETRY {ss}S', severity: 'caution', emittedBy: 'sidecar' },

  { id: 'net.idle', axis: 'backend', label: 'ACARS STANDBY', severity: 'idle', emittedBy: 'sidecar' },
  { id: 'net.pending', axis: 'backend', label: 'ACARS CONNECTING', severity: 'caution', emittedBy: 'sidecar' },
  { id: 'net.ok', axis: 'backend', label: 'ACARS UPLINK', severity: 'ok', emittedBy: 'sidecar' },
  { id: 'net.standby', axis: 'backend', label: 'ACARS READY', severity: 'ok', emittedBy: 'sidecar' },
  { id: 'net.unauthorized', axis: 'backend', label: 'ACARS REJECT 401', severity: 'fault', emittedBy: 'sidecar' },
  { id: 'net.http-error', axis: 'backend', label: 'ACARS FAULT {status}', severity: 'fault', emittedBy: 'sidecar' },
  { id: 'net.tls-error', axis: 'backend', label: 'ACARS CERT FAULT', severity: 'fault', emittedBy: 'sidecar' },
  { id: 'net.unreachable', axis: 'backend', label: 'ACARS NO COMM', severity: 'fault', emittedBy: 'sidecar' },

  { id: 'pause.off', axis: 'pause', label: 'PAUSE OFF', severity: 'idle', emittedBy: 'sidecar' },
  { id: 'pause.full', axis: 'pause', label: 'SIM PAUSED', severity: 'caution', emittedBy: 'sidecar' },
  { id: 'pause.active', axis: 'pause', label: 'ACTIVE PAUSE', severity: 'caution', emittedBy: 'sidecar' },
  { id: 'pause.menu', axis: 'pause', label: 'SIM MENU', severity: 'caution', emittedBy: 'sidecar' },
  { id: 'pause.unknown', axis: 'pause', label: 'PAUSE {flags}', severity: 'caution', emittedBy: 'sidecar' },
];

const STATES_BY_ID = new Map<string, StatusState>(STATUS_STATES.map((s) => [s.id, s]));

export function isStateId(id: string): id is StateId {
  return STATES_BY_ID.has(id);
}

/**
 * Label and axis for a state id. An id this build does not know renders as
 * `?? <id>` at caution rather than blanking the line or throwing: a sidecar
 * newer than its reader must degrade to ugly-but-informative.
 */
export function describeState(id: string): StatusState {
  const known = STATES_BY_ID.get(id);
  if (known) return known;
  return { id: id as StateId, axis: 'app', label: `?? ${id}`, severity: 'caution', emittedBy: 'sidecar' };
}

export interface LabelParams {
  /** Milliseconds until the next connect attempt, for sim.retry. */
  remainingMs?: number;
  /** HTTP status, for net.http-error. */
  httpStatus?: number;
  /** Raw Pause_EX1 bitmask, for pause.unknown. */
  flags?: number;
}

/** Fills the `{ss}` / `{status}` / `{flags}` placeholders in a state's label. */
export function formatStateLabel(id: string, params: LabelParams = {}): string {
  const state = describeState(id);
  let label = state.label;
  if (label.includes('{ss}')) {
    const seconds = Math.min(99, Math.max(0, Math.ceil((params.remainingMs ?? 0) / 1000)));
    label = label.replace('{ss}', String(seconds).padStart(2, '0'));
  }
  if (label.includes('{status}')) {
    label = label.replace('{status}', String(params.httpStatus ?? ''));
  }
  if (label.includes('{flags}')) {
    label = label.replace('{flags}', String(params.flags ?? 0));
  }
  return label;
}

// ── Reconnect backoff ─────────────────────────────────────────────────────────
//
// Capped exponential, doubling on each consecutive failure: 5s, 10s, 20s, 40s,
// 60s, 60s, ... The attempt counter resets to 0 on a successful open, so an
// unrelated later drop starts from the base delay again.

export const RECONNECT_BASE_DELAY_MS = 5000;
export const RECONNECT_MAX_DELAY_MS = 60000;

export function nextReconnectDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** safeAttempt, RECONNECT_MAX_DELAY_MS);
}

// ── Pause_EX1 decoding ────────────────────────────────────────────────────────
//
// The MSFS Pause_EX1 bitmask. The legacy Paused/Unpaused events never fire for
// Active Pause, which is why this event exists and why it wins once seen.

export const PAUSE_FLAG_OFF = 0;
export const PAUSE_FLAG_FULL = 1; // regular full pause
export const PAUSE_FLAG_WITH_SOUND = 2; // legacy, rarely seen
export const PAUSE_FLAG_ACTIVE = 4; // Active Pause — aircraft frozen, sim running
export const PAUSE_FLAG_SIM = 8; // sim frozen (e.g. in a menu)

/** The agent's own wording, carried into the log line unchanged. */
export function describePause(flags: number): string {
  if (flags === PAUSE_FLAG_OFF) return 'off';
  const parts: string[] = [];
  if (flags & PAUSE_FLAG_FULL) parts.push('full');
  if (flags & PAUSE_FLAG_WITH_SOUND) parts.push('with-sound');
  if (flags & PAUSE_FLAG_ACTIVE) parts.push('active');
  if (flags & PAUSE_FLAG_SIM) parts.push('sim');
  return parts.join('+') || `unknown(${flags})`;
}

/**
 * Four bits, three meaningful display states, resolved by precedence so a
 * combined bitmask never produces a blank or an ambiguous label. Active Pause
 * always wins: it is the one the legacy events miss.
 */
export function pauseStateFromFlags(flags: number): PauseStateId {
  const bits = Number.isFinite(flags) ? flags | 0 : 0;
  if (bits & PAUSE_FLAG_ACTIVE) return 'pause.active';
  if (bits & PAUSE_FLAG_SIM) return 'pause.menu';
  if (bits & (PAUSE_FLAG_FULL | PAUSE_FLAG_WITH_SOUND)) return 'pause.full';
  if (bits !== 0) return 'pause.unknown';
  return 'pause.off';
}

// ── Backend axis classification ───────────────────────────────────────────────

/** Error codes that mean "TLS said no", as opposed to "the wire said no". */
export const TLS_ERROR_CODES = [
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
] as const;

/** Transport failures. Anything unrecognised is treated as unreachable too. */
export const TRANSPORT_ERROR_CODES = [
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
  'ABORT_ERR',
] as const;

/** Maps an ingest response status onto the backend axis. */
export function backendStateFromStatus(httpStatus: number): BackendStateId {
  if (httpStatus >= 200 && httpStatus < 300) return 'net.ok';
  if (httpStatus === 401) return 'net.unauthorized';
  return 'net.http-error';
}

/** Maps a transport/TLS failure code onto the backend axis. */
export function backendStateFromErrorCode(code: string | undefined): BackendStateId {
  if (code && (TLS_ERROR_CODES as readonly string[]).includes(code)) return 'net.tls-error';
  return 'net.unreachable';
}
