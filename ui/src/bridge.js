// The single seam between the panel and whatever host it is running inside.
//
// Import rule, and it is the whole point of this file: `src/app.js` — the
// shell — is the only module that may import it. No page module may import it,
// name it, or reach it through anything the shell hands them; pages get the
// small page interface the shell builds and nothing else. Tauri, and the
// `window.__TAURI__` / `window.__TAURI_INTERNALS__` / `window.__FMC_HOST__` /
// `window.__FMC_STUB__` globals, are named here and nowhere else in the UI.
// That is what lets the whole panel run in a plain browser — and in headless
// Chromium for screenshots — with no desktop shell at all, and what lets a new
// host adopt the panel without a line of page code changing.
//
// Three hosts are resolved, in this order: an adapter a host installed on
// `window.__FMC_HOST__` before this module evaluated, then Tauri, then a
// built-in stub with the same method names, published as `window.__FMC_STUB__`
// so a test harness can feed status messages in and read every call back out.
// An installed host wins over Tauri so that a panel embedded in something
// Tauri-shaped still gets its own adapter, and a half-built host object falls
// through rather than booting a panel whose buttons throw. Neither the stub nor
// the installation seam is a dev-only branch to be stripped: the seam is how a
// second host comes to exist at all, and if the panel can find no host, showing
// a working panel that says so beats showing nothing.

/** Command names on the Rust side. Renaming one here breaks the shell. */
const COMMANDS = {
  configGet: 'config_get',
  configSet: 'config_set',
  configPath: 'config_path',
  uplinkStart: 'uplink_start',
  uplinkStop: 'uplink_stop',
  sidecarRestart: 'sidecar_restart',
  statusGet: 'status_get',
  datalinkState: 'datalink_state',
  datalinkWatch: 'datalink_watch',
  datalinkRefresh: 'datalink_refresh',
  datalinkThread: 'datalink_thread',
  datalinkCanned: 'datalink_canned',
  datalinkSendCanned: 'datalink_send_canned',
  datalinkWx: 'datalink_wx',
  datalinkLoadsheet: 'datalink_loadsheet',
};

/** Event names the shell emits into the webview. */
const EVENTS = {
  status: 'sidecar:status',
  log: 'sidecar:log',
  exit: 'sidecar:exit',
  datalink: 'sidecar:datalink',
};

const DEFAULT_STUB_PATH = 'C:\\Users\\<you>\\AppData\\Roaming\\msfslogger\\config.json';

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

// ── Host resolution ──────────────────────────────────────────────────────────

/**
 * Everything a host must implement to drive the panel. Each one is treated as
 * async by the shell and signals failure by rejecting, never by throwing.
 */
const HOST_METHODS = [
  'getConfig',
  'setConfig',
  'getConfigPath',
  'startUplink',
  'stopUplink',
  'restartSidecar',
  'getStatus',
  'onStatus',
  'onLog',
  'onExit',
];

/**
 * The datalink methods are optional: a host that predates the datalink is still
 * adopted and gets a per-method fallback, so the rest of the panel keeps
 * working and the DATALINK pages say NOT SUPPORTED instead of throwing. None of
 * them takes the ingest token or any other config value; the token stays in the
 * sidecar. Every one except `onDatalink` returns a Promise, and all but
 * `getDatalinkState` resolve to an `{ok, result|error}` envelope.
 */
const DATALINK_HOST_METHODS = [
  'getDatalinkState', 'onDatalink', 'watchDatalink', 'refreshDatalink',
  'getDatalinkThread', 'getCannedMessages', 'sendCannedMessage',
  'requestWeather', 'requestLoadsheet',
];

const datalinkError = (code) => ({ ok: false, error: { code, httpStatus: null, serverCode: null } });
const UNSUPPORTED = datalinkError('host-unsupported');
const BAD_REQUEST = datalinkError('bad-request');

/** The fallback for a datalink method an installed host does not provide. */
function datalinkFallback(name) {
  if (name === 'getDatalinkState') return async () => null;
  if (name === 'onDatalink') return () => () => {};
  return async () => clone(UNSUPPORTED);
}

// Shape checks only; the shell and the sidecar own the value rules. They stop a
// malformed call before it becomes a command the shell cannot even decode.
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isTarget = (target) => isPlainObject(target) && typeof target.kind === 'string' && isCount(target.id);

/**
 * A host installs itself by assigning `window.__FMC_HOST__` before this module
 * evaluates — from a bootstrap script loaded ahead of the panel document, the
 * way the browser preview harness installs its mock host. An object missing any
 * method is not adopted at all: a panel that falls back to Tauri or the stub is
 * worth more than one whose buttons throw.
 */
function findInstalledHost() {
  const installed = typeof window !== 'undefined' ? window.__FMC_HOST__ : undefined;
  if (!installed || typeof installed !== 'object') return null;
  for (const name of HOST_METHODS) {
    if (typeof installed[name] !== 'function') return null;
  }
  return installed;
}

/**
 * An installed host is adopted, not used raw: the shell always sees an object
 * built here, with every method bound through and a label to annunciate, so it
 * never has to defend against a partial adapter.
 */
function adoptHost(installed) {
  const label = typeof installed.hostLabel === 'string' && installed.hostLabel.trim()
    ? installed.hostLabel.trim()
    : 'HOST';
  const adapter = { isStub: false, hostLabel: label };
  for (const name of HOST_METHODS) {
    adapter[name] = (...args) => installed[name](...args);
  }
  for (const name of DATALINK_HOST_METHODS) {
    adapter[name] = typeof installed[name] === 'function'
      ? (...args) => installed[name](...args)
      : datalinkFallback(name);
  }
  return adapter;
}

function findHost() {
  const installed = findInstalledHost();
  if (installed) return { kind: 'installed', installed };

  const globalApi = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
  const internals = typeof window !== 'undefined' ? window.__TAURI_INTERNALS__ : undefined;
  if (!globalApi && !internals) return null;

  // Preferred path: the shell exposes the JS API globally.
  if (globalApi && globalApi.core && typeof globalApi.core.invoke === 'function') {
    const listen = globalApi.event && globalApi.event.listen;
    return {
      kind: 'tauri',
      invoke: (cmd, args) => globalApi.core.invoke(cmd, args),
      listen:
        typeof listen === 'function'
          ? (name, handler) => listen(name, handler)
          : listenViaInternals(internals),
    };
  }

  // Fallback: only the internals are injected. Events then go through the
  // event plugin directly, which is what the global API does anyway.
  if (internals && typeof internals.invoke === 'function') {
    return {
      kind: 'tauri',
      invoke: (cmd, args) => internals.invoke(cmd, args),
      listen: listenViaInternals(internals),
    };
  }

  return null;
}

function listenViaInternals(internals) {
  if (!internals || typeof internals.invoke !== 'function' || typeof internals.transformCallback !== 'function') {
    // A host we cannot subscribe to: commands still work, events never fire.
    // Better a panel that only misses live updates than one that throws.
    return async () => () => {};
  }
  return async (name, handler) => {
    const callbackId = internals.transformCallback((event) => {
      handler(event && typeof event === 'object' && 'payload' in event ? event : { payload: event });
    });
    const eventId = await internals.invoke('plugin:event|listen', { event: name, target: { kind: 'Any' }, handler: callbackId });
    return async () => {
      await internals.invoke('plugin:event|unlisten', { event: name, eventId });
    };
  };
}

function createTauriBridge(host) {
  // Unsubscribing is async on the Tauri side; callers get a plain function
  // that starts the teardown and cannot throw at them.
  const subscribe = (eventName, fn) => {
    let unlisten = null;
    let cancelled = false;
    host
      .listen(eventName, (event) => {
        if (!cancelled) fn(event && event.payload !== undefined ? event.payload : event);
      })
      .then((off) => {
        if (cancelled && typeof off === 'function') off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (typeof unlisten === 'function') unlisten();
      unlisten = null;
    };
  };

  return {
    isStub: false,
    hostLabel: 'TAURI',
    getConfig: () => host.invoke(COMMANDS.configGet),
    setConfig: (patch) => host.invoke(COMMANDS.configSet, { patch }),
    getConfigPath: () => host.invoke(COMMANDS.configPath),
    startUplink: () => host.invoke(COMMANDS.uplinkStart),
    stopUplink: () => host.invoke(COMMANDS.uplinkStop),
    restartSidecar: () => host.invoke(COMMANDS.sidecarRestart),
    getStatus: () => host.invoke(COMMANDS.statusGet),
    onStatus: (fn) => subscribe(EVENTS.status, fn),
    onLog: (fn) => subscribe(EVENTS.log, fn),
    onExit: (fn) => subscribe(EVENTS.exit, fn),
    getDatalinkState: () => host.invoke(COMMANDS.datalinkState),
    onDatalink: (fn) => subscribe(EVENTS.datalink, fn),
    watchDatalink: (on) => host.invoke(COMMANDS.datalinkWatch, { on: on === true }),
    refreshDatalink: () => host.invoke(COMMANDS.datalinkRefresh),
    getDatalinkThread: async (req) => {
      if (!isPlainObject(req) || !isCount(req.epoch) || !isCount(req.endSeq)) return clone(BAD_REQUEST);
      return host.invoke(COMMANDS.datalinkThread, { epoch: req.epoch, endSeq: req.endSeq });
    },
    getCannedMessages: () => host.invoke(COMMANDS.datalinkCanned),
    sendCannedMessage: async (req) => {
      if (!isPlainObject(req) || !isTarget(req.target) || typeof req.cannedId !== 'string') return clone(BAD_REQUEST);
      return host.invoke(COMMANDS.datalinkSendCanned, {
        targetKind: req.target.kind,
        targetId: req.target.id,
        cannedId: req.cannedId,
      });
    },
    requestWeather: async (req) => {
      if (!isPlainObject(req) || !isTarget(req.target) || typeof req.icao !== 'string') return clone(BAD_REQUEST);
      return host.invoke(COMMANDS.datalinkWx, { targetKind: req.target.kind, targetId: req.target.id, icao: req.icao });
    },
    requestLoadsheet: async (req) => {
      if (!isPlainObject(req) || !isCount(req.plannedLegId)) return clone(BAD_REQUEST);
      return host.invoke(COMMANDS.datalinkLoadsheet, { plannedLegId: req.plannedLegId });
    },
  };
}

// ── Stub bridge ──────────────────────────────────────────────────────────────

function createStubBridge() {
  const listeners = { status: new Set(), log: new Set(), exit: new Set(), datalink: new Set() };

  const stub = {
    isStub: true,
    config: {
      exists: true,
      path: DEFAULT_STUB_PATH,
      config: {
        version: 1,
        serverUrl: 'https://192.168.0.30:3000',
        certPath: 'C:\\msfslogger\\msfslogger-cert.pem',
        trafficEnabled: true,
        trafficRadiusM: 40000,
        sim: '2020',
        autoUplink: false,
        nodePath: null,
        tokenSet: true,
      },
      raw: {
        version: 1,
        serverUrl: 'https://192.168.0.30:3000',
        certPath: 'C:\\msfslogger\\msfslogger-cert.pem',
        trafficEnabled: true,
        trafficRadiusM: 40000,
        sim: '2020',
        autoUplink: false,
        nodePath: null,
        tokenSet: true,
      },
    },
    status: null,
    datalinkState: null,
    // Method name → the envelope that method resolves; unset methods answer
    // host-unsupported, the same as an installed host without the datalink.
    datalinkResults: {},
    calls: [],
    setConfigResult: { ok: true, path: DEFAULT_STUB_PATH },
    emitStatus(status) {
      stub.status = status;
      for (const fn of listeners.status) fn(status);
    },
    emitLog(log) {
      for (const fn of listeners.log) fn(log);
    },
    emitExit(payload) {
      for (const fn of listeners.exit) fn(payload);
    },
    emitDatalink(state) {
      stub.datalinkState = state;
      for (const fn of listeners.datalink) fn(state);
    },
  };

  const record = (method, args) => {
    stub.calls.push({ method, args, at: Date.now() });
  };

  const subscribe = (set, fn) => {
    set.add(fn);
    return () => set.delete(fn);
  };

  const bridge = {
    isStub: true,
    hostLabel: 'STUB BRIDGE',
    async getConfig() {
      record('getConfig', []);
      return clone(stub.config);
    },
    async setConfig(patch) {
      // The token is recorded as the mask the CFG NETWORK page shows: a harness
      // can still see that one was sent, but `calls` never holds the secret.
      const recorded = clone(patch);
      if (recorded && typeof recorded === 'object' && 'ingestToken' in recorded) recorded.ingestToken = '••••••••';
      record('setConfig', [recorded]);
      const result = stub.setConfigResult;
      if (result?.ok === true) {
        const { ingestToken, ...safe } = patch;
        const config = { ...stub.config?.config, ...safe };
        if (typeof ingestToken === 'string') config.tokenSet = Boolean(ingestToken.trim());
        stub.config = { exists: true, path: result.path || DEFAULT_STUB_PATH, config, raw: clone(config) };
      }
      return clone(result);
    },
    async getConfigPath() {
      record('getConfigPath', []);
      return stub.config ? stub.config.path : DEFAULT_STUB_PATH;
    },
    async startUplink() {
      record('startUplink', []);
      return null;
    },
    async stopUplink() {
      record('stopUplink', []);
      return null;
    },
    async restartSidecar() {
      record('restartSidecar', []);
      return null;
    },
    async getStatus() {
      record('getStatus', []);
      return clone(stub.status);
    },
    onStatus(fn) {
      record('onStatus', []);
      return subscribe(listeners.status, fn);
    },
    onLog(fn) {
      record('onLog', []);
      return subscribe(listeners.log, fn);
    },
    onExit(fn) {
      record('onExit', []);
      return subscribe(listeners.exit, fn);
    },
    async getDatalinkState() {
      record('getDatalinkState', []);
      return clone(stub.datalinkState);
    },
    onDatalink(fn) {
      record('onDatalink', []);
      return subscribe(listeners.datalink, fn);
    },
  };
  for (const name of DATALINK_HOST_METHODS) {
    if (name === 'getDatalinkState' || name === 'onDatalink') continue;
    bridge[name] = async (...args) => {
      record(name, clone(args));
      const results = stub.datalinkResults;
      return results && Object.prototype.hasOwnProperty.call(results, name)
        ? clone(results[name])
        : clone(UNSUPPORTED);
    };
  }

  if (typeof window !== 'undefined') window.__FMC_STUB__ = stub;
  return bridge;
}

const host = findHost();

export const bridge = host === null
  ? createStubBridge()
  : host.kind === 'installed'
    ? adoptHost(host.installed)
    : createTauriBridge(host);

export const TAURI_COMMANDS = COMMANDS;
export const TAURI_EVENTS = EVENTS;

export default bridge;
