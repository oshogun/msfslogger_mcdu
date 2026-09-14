// The FMC status vocabulary, rendered.
//
// Four axes are on screen at once and none of them is ever blank. SimConnect
// being down and the server being unreachable are different problems with
// different fixes, so a single "status" line would have to pick one to show
// and would hide the other; every axis therefore has its own line and its own
// idle state.
//
// The table below is a second, independent implementation of the one the
// sidecar carries: the wire carries state ids, never labels, and this file
// owns presentation. A contract check keeps the two copies honest. An id this
// build has never heard of renders as `?? <id>` at caution severity rather
// than blanking the line or throwing — a sidecar newer than the panel must
// degrade to ugly-but-informative.

/** Axis order is part of the contract: one line each, always present. */
export const AXES = [
  { id: 'app', title: 'SIDECAR', domId: 'status-app' },
  { id: 'sim', title: 'SIM LINK', domId: 'status-sim' },
  { id: 'backend', title: 'ACARS', domId: 'status-net' },
  { id: 'pause', title: 'PAUSE', domId: 'status-pause' },
];

/**
 * `{ss}` is whole seconds until the next connect attempt, `{status}` an HTTP
 * status, `{flags}` a raw Pause_EX1 bitmask; all three are filled by
 * formatStateLabel().
 */
export const STATUS_STATES = [
  { id: 'app.starting', axis: 'app', label: 'SIDECAR STARTING', severity: 'caution' },
  { id: 'app.no-config', axis: 'app', label: 'NO CONFIG', severity: 'caution' },
  { id: 'app.error-config', axis: 'app', label: 'CONFIG INVALID', severity: 'fault' },
  { id: 'app.stopped', axis: 'app', label: 'UPLINK STOPPED', severity: 'idle' },
  { id: 'app.running', axis: 'app', label: 'UPLINK ACTIVE', severity: 'ok' },
  { id: 'app.crashed', axis: 'app', label: 'SIDECAR FAULT', severity: 'fault' },
  { id: 'app.restarting', axis: 'app', label: 'SIDECAR RESTART', severity: 'caution' },

  { id: 'sim.idle', axis: 'sim', label: 'SIM LINK STANDBY', severity: 'idle' },
  { id: 'sim.connecting', axis: 'sim', label: 'SIM LINK CONNECTING', severity: 'caution' },
  { id: 'sim.connected', axis: 'sim', label: 'SIM LINK ONLINE', severity: 'ok' },
  { id: 'sim.retry', axis: 'sim', label: 'SIM LINK RETRY {ss}S', severity: 'caution' },

  { id: 'net.idle', axis: 'backend', label: 'ACARS STANDBY', severity: 'idle' },
  { id: 'net.pending', axis: 'backend', label: 'ACARS CONNECTING', severity: 'caution' },
  { id: 'net.ok', axis: 'backend', label: 'ACARS UPLINK', severity: 'ok' },
  { id: 'net.standby', axis: 'backend', label: 'ACARS READY', severity: 'ok' },
  { id: 'net.unauthorized', axis: 'backend', label: 'ACARS REJECT 401', severity: 'fault' },
  { id: 'net.http-error', axis: 'backend', label: 'ACARS FAULT {status}', severity: 'fault' },
  { id: 'net.tls-error', axis: 'backend', label: 'ACARS CERT FAULT', severity: 'fault' },
  { id: 'net.unreachable', axis: 'backend', label: 'ACARS NO COMM', severity: 'fault' },

  { id: 'pause.off', axis: 'pause', label: 'PAUSE OFF', severity: 'idle' },
  { id: 'pause.full', axis: 'pause', label: 'SIM PAUSED', severity: 'caution' },
  { id: 'pause.active', axis: 'pause', label: 'ACTIVE PAUSE', severity: 'caution' },
  { id: 'pause.menu', axis: 'pause', label: 'SIM MENU', severity: 'caution' },
  { id: 'pause.unknown', axis: 'pause', label: 'PAUSE {flags}', severity: 'caution' },
];

const STATES_BY_ID = new Map(STATUS_STATES.map((state) => [state.id, state]));

export function isStateId(id) {
  return STATES_BY_ID.has(id);
}

/** Label, axis and severity for a state id. Never throws, never returns null. */
export function describeState(id) {
  const known = STATES_BY_ID.get(id);
  if (known) return known;
  const shown = typeof id === 'string' && id.length > 0 ? id : '(none)';
  return { id: shown, axis: 'app', label: `?? ${shown}`, severity: 'caution', unknown: true };
}

/** Fills the `{ss}` / `{status}` / `{flags}` placeholders. */
export function formatStateLabel(id, params = {}) {
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

/**
 * Milliseconds left on the reconnect ladder. The countdown is computed here,
 * not sent over the wire: the ladder runs 5s, 10s, 20s, 40s and then caps at
 * 60s, and a minute of apparent silence is exactly when a user decides the
 * app is dead. Ticking it locally costs no IPC traffic at all.
 */
export function retryRemainingMs(sim, now) {
  if (!sim) return 0;
  if (typeof sim.nextRetryAt === 'number') return Math.max(0, sim.nextRetryAt - now);
  if (typeof sim.retryDelayMs === 'number') return Math.max(0, sim.retryDelayMs);
  return 0;
}

/** The status every axis shows before the first message arrives. */
export function defaultStatus() {
  return {
    v: 1,
    type: 'status',
    at: 0,
    app: { state: 'app.starting' },
    sim: { state: 'sim.idle', attempt: 0, nextRetryAt: null, retryDelayMs: null, protocol: '', appName: null, appVersion: null, lastError: null },
    backend: { state: 'net.idle', httpStatus: null, lastOkAt: null, lastErrorAt: null, message: null },
    pause: { state: 'pause.off', flags: 0, label: 'off', usingPauseEx1: false },
    traffic: { enabled: false, radiusM: 0, lastSweepAt: null, lastBatchSize: null, lastError: null },
    config: null,
  };
}

/** Advisory only: traffic never drives the backend axis, so it has no severity. */
export function trafficLine(traffic) {
  if (!traffic || traffic.enabled !== true) return { state: 'traffic.off', text: 'TFC OFF' };
  const radiusKm = Math.round((Number(traffic.radiusM) || 0) / 1000);
  const suffix = radiusKm > 0 ? ` ${radiusKm}KM` : '';
  if (traffic.lastError) return { state: 'traffic.error', text: `TFC FAULT${suffix}` };
  if (typeof traffic.lastBatchSize === 'number') {
    return { state: 'traffic.ok', text: `TFC ${traffic.lastBatchSize} OBJ${suffix}` };
  }
  return { state: 'traffic.idle', text: `TFC STBY${suffix}` };
}

/** Keeps the tail of a long Windows path — the file name is the useful end. */
export function shortenPath(path, maxChars = 22) {
  if (typeof path !== 'string' || path.length === 0) return '--------';
  if (path.length <= maxChars) return path;
  return `…${path.slice(path.length - (maxChars - 1))}`;
}

const SEVERITIES = new Set(['ok', 'caution', 'fault', 'idle']);

function paintAxis(root, domId, stateId, params) {
  const el = root.querySelector(`#${domId}`);
  if (!el) return;
  const described = describeState(stateId);
  el.textContent = formatStateLabel(stateId, params);
  el.setAttribute('data-state', typeof stateId === 'string' && stateId ? stateId : described.id);
  el.setAttribute('data-severity', SEVERITIES.has(described.severity) ? described.severity : 'caution');
}

/**
 * Paints all four axes plus the advisory lines from one status snapshot.
 * `root` may be detached from the document — the STATUS view is parked off
 * screen while a config page is up, and must be current when it comes back.
 */
export function renderStatus(root, status, options = {}) {
  if (!root) return;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const snapshot = status && typeof status === 'object' ? status : defaultStatus();
  const app = snapshot.app || {};
  const sim = snapshot.sim || {};
  const backend = snapshot.backend || {};
  const pause = snapshot.pause || {};

  paintAxis(root, 'status-app', app.state, {});
  paintAxis(root, 'status-sim', sim.state, { remainingMs: retryRemainingMs(sim, now) });
  paintAxis(root, 'status-net', backend.state, { httpStatus: backend.httpStatus });
  paintAxis(root, 'status-pause', pause.state, { flags: pause.flags });

  const traffic = root.querySelector('#status-traffic');
  if (traffic) {
    const line = trafficLine(snapshot.traffic);
    traffic.textContent = line.text;
    traffic.setAttribute('data-state', line.state);
  }

  const prompt = root.querySelector('#uplink-prompt');
  if (prompt) prompt.textContent = app.state === 'app.running' ? 'STOP>' : 'START>';

  const restart = root.querySelector('#restart-prompt');
  if (restart) {
    const crashed = app.state === 'app.crashed';
    restart.classList.toggle('prompt-hidden', !crashed);
    restart.setAttribute('aria-hidden', crashed ? 'false' : 'true');
  }
}

/** The config path lives on the STATUS page so the user can find the file. */
export function renderConfigPath(root, path) {
  if (!root) return;
  const el = root.querySelector('#status-config-path');
  if (!el) return;
  el.textContent = shortenPath(path, 40);
  el.title = typeof path === 'string' ? path : '';
}

/** Whether the uplink is running, which is what R6 offers to toggle. */
export function uplinkRunning(status) {
  return Boolean(status && status.app && status.app.state === 'app.running');
}
