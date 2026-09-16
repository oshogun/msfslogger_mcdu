// Live proof that a host other than Tauri or the built-in stub can drive the
// real panel with no page-code changes. Serves ui/ from a scratch port on
// 127.0.0.1 (never 3000), installs a synthetic host adapter through the same
// window.__FMC_HOST__ seam every host uses, and drives the pages with
// real clicks and keyboard input. Takes no output directory and writes no
// screenshots or other artifacts; there is nothing to override on argv.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ui = resolve(root, 'ui');

// Injected into the page before the module graph evaluates
// (page.evaluateOnNewDocument, ahead of page.goto). bridge.js resolves its
// host once at module evaluation, so window.__FMC_HOST__ must exist before
// that line runs — assigning it any later has no effect.
function installSynth() {
  const calls = [];
  let statusCb = null;
  let logCb = null;
  let exitCb = null;
  let status = null;
  let config = {
    exists: true,
    path: 'C:/scratch/synth-config.json',
    config: {
      version: 1, serverUrl: 'https://synth.example.invalid:4443/path', ingestToken: 'synth-original-token',
      certPath: '', sim: 'fsx', autoUplink: true, trafficEnabled: true, trafficRadiusM: 40000,
    },
    raw: null,
  };
  config.raw = config.config;
  const record = (method, args) => calls.push({ method, args });
  window.__FMC_HOST__ = {
    getConfig: () => { record('getConfig', []); return Promise.resolve(config); },
    setConfig: (patch) => {
      record('setConfig', [patch]);
      config = { ...config, config: { ...config.config, ...patch } };
      config.raw = config.config;
      return Promise.resolve({ ok: true, path: config.path });
    },
    getConfigPath: () => { record('getConfigPath', []); return Promise.resolve(config.path); },
    startUplink: () => { record('startUplink', []); return Promise.resolve(true); },
    stopUplink: () => { record('stopUplink', []); return Promise.resolve(true); },
    restartSidecar: () => { record('restartSidecar', []); return Promise.resolve(true); },
    getStatus: () => { record('getStatus', []); return status; },
    onStatus: (fn) => { record('onStatus', []); statusCb = fn; return () => { statusCb = null; }; },
    onLog: (fn) => { record('onLog', []); logCb = fn; return () => { logCb = null; }; },
    onExit: (fn) => { record('onExit', []); exitCb = fn; return () => { exitCb = null; }; },
    isStub: false,
    hostLabel: 'SYNTH HOST',
  };
  window.__SYNTH__ = {
    calls,
    emitStatus: (s) => { status = s; if (statusCb) statusCb(s); },
    emitLog: (l) => { if (logCb) logCb(l); },
    emitExit: (e) => { if (exitCb) exitCb(e); },
  };
}

function snapshot() {
  return {
    v: 1, type: 'status', at: 100000,
    app: { state: 'app.running' },
    sim: { state: 'sim.connected', attempt: 0, nextRetryAt: null, retryDelayMs: null },
    backend: { state: 'net.ok', httpStatus: null },
    pause: { state: 'pause.off', flags: 16 },
    traffic: { enabled: true, radiusM: 40000, lastBatchSize: 0 }, config: null,
  };
}

let current = 'boot';
let browser;
let page;
const errors = [];
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const path = resolve(ui, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(`${ui}${sep}`)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
const monitor = (target) => {
  target.on('pageerror', (error) => errors.push(`${current}: pageerror ${error.message}`));
  target.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${current}: console ${message.text()}`);
  });
};
const text = (selector) => page.$eval(selector, (el) => el.textContent);
const calls = (method) => page.evaluate((method) => window.__SYNTH__.calls.filter((c) => c.method === method), method);
async function show(id) {
  await page.evaluate((id) => window.FMC.showPage(id), id);
  assert.equal(await page.$eval('#fmc-screen', (el) => el.dataset.page), id);
}
async function emit(status) { await page.evaluate((status) => window.__SYNTH__.emitStatus(status), status); }

try {
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  assert.notEqual(port, 3000);
  console.log(`Scratch server 127.0.0.1:${port} (never port 3000)`);

  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  monitor(page);
  await page.setViewport({ width: 520, height: 760, deviceScaleFactor: 1 });
  // Installed before page.goto so it runs before the app.js module graph
  // evaluates — the only ordering that reliably beats a module preload.
  await page.evaluateOnNewDocument(installSynth);
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.FMC?.getConfigCache());

  current = 'host-identity';
  assert.equal(await page.evaluate(() => '__TAURI__' in window || '__TAURI_INTERNALS__' in window), false, 'Tauri globals must be absent');
  assert.equal(await page.evaluate(() => '__FMC_STUB__' in window), false, '__FMC_STUB__ must be absent');
  assert.equal(await text('#bridge-mode'), 'SYNTH HOST', 'stub bridge must not be the host in use');
  assert.equal(await page.$eval('#bridge-mode', (el) => el.dataset.stub), 'false', 'stub bridge must not be the host in use');
  for (const method of ['getConfig', 'getConfigPath', 'getStatus', 'onStatus', 'onLog', 'onExit']) {
    assert.ok((await calls(method)).length > 0, `boot never called ${method}`);
  }
  console.log('PASS host-identity: window.__TAURI__/__TAURI_INTERNALS__ absent; window.__FMC_STUB__ absent; '
    + '#bridge-mode shows the synthetic hostLabel with data-stub="false" (calls landed on the synthetic host, not the stub); '
    + 'boot reached getConfig, getConfigPath, getStatus, onStatus, onLog, onExit on it');

  current = 'status-uplink-toggle';
  await show('STATUS');
  await emit({ ...snapshot(), app: { state: 'app.stopped' } });
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction((n) => window.__SYNTH__.calls.filter((c) => c.method === 'startUplink').length === n, {}, 1);
  assert.equal((await calls('startUplink')).length, 1, 'R6 while stopped must call startUplink');
  await emit({ ...snapshot(), app: { state: 'app.running' } });
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction((n) => window.__SYNTH__.calls.filter((c) => c.method === 'stopUplink').length === n, {}, 1);
  assert.equal((await calls('stopUplink')).length, 1, 'R6 while running must call stopUplink');
  console.log('PASS status-uplink-toggle: STATUS R6 reached the synthetic host\'s startUplink then stopUplink');

  current = 'status-restart';
  await emit({ ...snapshot(), app: { state: 'app.crashed' } });
  await page.click('[data-lsk="R5"]');
  await page.waitForFunction((n) => window.__SYNTH__.calls.filter((c) => c.method === 'restartSidecar').length === n, {}, 1);
  assert.equal((await calls('restartSidecar')).length, 1, 'R5 while crashed must call restartSidecar');
  console.log('PASS status-restart: STATUS R5 reached the synthetic host\'s restartSidecar');

  current = 'cfg-save';
  await show('NETWORK');
  const token = 'SYNTH-TOKEN-CaseSensitive-1234567890';
  await page.evaluate(() => window.FMC.setScratchpad(''));
  // Real physical key events, not a test-only form value — the same
  // discipline render-check.mjs uses for the equivalent case.
  await page.keyboard.type(token);
  await page.click('[data-lsk="L2"]');
  const before = (await calls('setConfig')).length;
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction(() => document.getElementById('scratchpad').textContent === 'CONFIG SAVED');
  const after = await calls('setConfig');
  assert.equal(after.length, before + 1, 'R6 on NETWORK must call setConfig exactly once more');
  const patch = after[after.length - 1].args[0];
  assert.equal(patch.ingestToken, token, 'setConfig patch must carry the typed token');
  for (const field of ['version', 'serverUrl', 'sim', 'autoUplink', 'trafficEnabled', 'trafficRadiusM']) {
    assert.ok(field in patch, `setConfig patch missing canonical field ${field}`);
  }
  console.log(`PASS cfg-save: NETWORK L2+R6 reached the synthetic host's setConfig with the typed token and the canonical field set (${Object.keys(patch).sort().join(', ')})`);

  current = 'browser-errors';
  assert.deepEqual(errors, [], 'browser errors');
  console.log('PASS browser-errors: none (pageerror and console error both fatal)');

  process.exitCode = 0;
} catch (error) {
  console.error(`FAIL ${current}: ${error.message}`);
  process.exitCode = 1;
} finally {
  // Both success and every failure path release the browser and the port.
  try { if (browser) await browser.close(); }
  finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    console.log('Cleanup: browser closed; scratch server closed');
  }
}
