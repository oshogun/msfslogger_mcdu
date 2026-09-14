/* Development only. Loaded before the unchanged CDU module graph. */
(function () {
  'use strict';
  var listeners = { status: new Set(), log: new Set(), exit: new Set() };
  var config = { version: 1, serverUrl: 'http://mock.invalid', certPath: '', sim: '2020', autoUplink: false, trafficEnabled: true, trafficRadiusM: 40000, tokenSet: false, nodePath: null };
  var calls = [];
  var status;
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function subscribe(name, fn) { listeners[name].add(fn); return function () { listeners[name].delete(fn); }; }
  function scenario(name) {
    if (['stopped', 'online', 'retry', 'offline', 'unauthorized', 'paused', 'active-pause', 'crashed'].indexOf(name) < 0) throw new Error('Unknown scenario: ' + name);
    status = {
      app: { state: name === 'stopped' ? 'app.stopped' : name === 'crashed' ? 'app.crashed' : 'app.running' },
      sim: { state: name === 'stopped' ? 'sim.idle' : name === 'retry' ? 'sim.retry' : 'sim.connected', nextRetryAt: Date.now() + 10000 },
      backend: { state: name === 'stopped' ? 'net.idle' : name === 'offline' ? 'net.unreachable' : name === 'unauthorized' ? 'net.unauthorized' : 'net.ok' },
      pause: { state: name === 'paused' ? 'pause.full' : name === 'active-pause' ? 'pause.active' : 'pause.off', flags: name === 'paused' ? 1 : name === 'active-pause' ? 4 : 0 },
      traffic: { enabled: true, radiusM: 40000, lastBatchSize: 3 }
    };
    listeners.status.forEach(function (fn) { fn(clone(status)); });
    return clone(status);
  }
  function record(method) { calls.push({ method: method, at: Date.now() }); }
  scenario('stopped');
  window.__FMC_HOST__ = {
    hostLabel: 'GAUGE MOCK',
    getConfig: async function () { return { exists: true, path: 'memory://gauge-dev', config: clone(config), raw: clone(config) }; },
    setConfig: async function (patch) {
      record('setConfig');
      Object.keys(config).forEach(function (key) { if (key in patch) config[key] = patch[key]; });
      if (typeof patch.ingestToken === 'string') config.tokenSet = !!patch.ingestToken.trim();
      return { ok: true, path: 'memory://gauge-dev' };
    },
    getConfigPath: async function () { return 'memory://gauge-dev'; },
    getStatus: async function () { return clone(status); },
    startUplink: async function () { record('startUplink'); scenario('online'); },
    stopUplink: async function () { record('stopUplink'); scenario('stopped'); },
    restartSidecar: async function () { record('restartSidecar'); scenario('stopped'); },
    onStatus: function (fn) { return subscribe('status', fn); },
    onLog: function (fn) { return subscribe('log', fn); },
    onExit: function (fn) { return subscribe('exit', fn); }
  };
  window.gaugeDev = {
    scenario: scenario, calls: calls,
    emitLog: function (message) { listeners.log.forEach(function (fn) { fn({ level: 'info', message: message }); }); },
    emitExit: function () { scenario('crashed'); listeners.exit.forEach(function (fn) { fn({ code: 1 }); }); }
  };
}());
