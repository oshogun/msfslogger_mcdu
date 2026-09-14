// Independent expectations: importing the UI's table would make a renamed
// label pass its own test. No workflow artifact is read by this tool.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ui = resolve(root, 'ui');
const output = resolve(process.argv[2] || '.claude/runs/2026-09-11-tauri-windows-client/prototypes');
const states = [
  ['app.starting', 'SIDECAR STARTING', 'caution'], ['app.no-config', 'NO CONFIG', 'caution'],
  ['app.error-config', 'CONFIG INVALID', 'fault'], ['app.stopped', 'UPLINK STOPPED', 'idle'],
  ['app.running', 'UPLINK ACTIVE', 'ok'], ['app.crashed', 'SIDECAR FAULT', 'fault'],
  ['app.restarting', 'SIDECAR RESTART', 'caution'],
  ['sim.idle', 'SIM LINK STANDBY', 'idle'], ['sim.connecting', 'SIM LINK CONNECTING', 'caution'],
  ['sim.connected', 'SIM LINK ONLINE', 'ok'], ['sim.retry', 'SIM LINK RETRY 05S', 'caution'],
  ['net.idle', 'ACARS STANDBY', 'idle'], ['net.pending', 'ACARS CONNECTING', 'caution'],
  ['net.ok', 'ACARS UPLINK', 'ok'], ['net.standby', 'ACARS READY', 'ok'],
  ['net.unauthorized', 'ACARS REJECT 401', 'fault'], ['net.http-error', 'ACARS FAULT 503', 'fault'],
  ['net.tls-error', 'ACARS CERT FAULT', 'fault'], ['net.unreachable', 'ACARS NO COMM', 'fault'],
  ['pause.off', 'PAUSE OFF', 'idle'], ['pause.full', 'SIM PAUSED', 'caution'],
  ['pause.active', 'ACTIVE PAUSE', 'caution'], ['pause.menu', 'SIM MENU', 'caution'],
  ['pause.unknown', 'PAUSE 16', 'caution'],
];
const axisNames = { app: 'app', sim: 'sim', net: 'backend', pause: 'pause' };
const hooks = { app: 'status-app', sim: 'status-sim', backend: 'status-net', pause: 'status-pause' };
function snapshot() {
  return {
    v: 1, type: 'status', at: 100000,
    app: { state: 'app.running' },
    sim: { state: 'sim.connected', attempt: 0, nextRetryAt: null, retryDelayMs: null },
    backend: { state: 'net.ok', httpStatus: 503 },
    pause: { state: 'pause.off', flags: 16 },
    traffic: { enabled: true, radiusM: 40000, lastBatchSize: 7 }, config: null,
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
const clean = () => assert.deepEqual(errors, [], `${current}: browser errors`);
const monitor = (target) => {
  target.on('pageerror', (error) => errors.push(`${current}: pageerror ${error.message}`));
  target.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${current}: console ${message.text()}`);
  });
};
const text = (selector) => page.$eval(selector, (el) => el.textContent);
async function capture(name) {
  clean();
  await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
  clean();
}
async function show(id) {
  await page.evaluate((id) => window.FMC.showPage(id), id);
  assert.equal(await page.$eval('#fmc-screen', (el) => el.dataset.page), id);
}
async function emit(status) { await page.evaluate((status) => window.__FMC_STUB__.emitStatus(status), status); }
async function entry(value, lsk) {
  await page.evaluate((value) => window.FMC.setScratchpad(value), value);
  await page.click(`[data-lsk="${lsk}"]`);
}
const saves = () => page.evaluate(() => window.__FMC_STUB__.calls.filter((call) => call.method === 'setConfig').length);
async function rejected(field, value, lsk, expected = 'INVALID ENTRY') {
  const before = await saves();
  await entry(value, lsk);
  assert.equal(await text('#scratchpad'), expected, field);
  assert.equal(await page.$eval('#scratchpad', (el) => el.dataset.messageKind), 'error');
  await page.click('[data-lsk="R6"]');
  assert.equal(await saves(), before, `${field}: invalid entry reached bridge`);
  console.log(`PASS reject ${field}: ${expected}; no save`);
}
try {
  await mkdir(output, { recursive: true });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  assert.notEqual(port, 3000);
  console.log(`Scratch server 127.0.0.1:${port} (never port 3000)`);
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  monitor(page);
  await page.setViewport({ width: 520, height: 760, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.FMC?.getConfigCache());
  assert.equal(await page.$eval('#bridge-mode', (el) => el.dataset.stub), 'true');
  // Fix only the displayed clock; timers still run and the retry test advances it.
  await page.evaluate(() => { Date.now = () => 100000; });
  for (const [id, label, severity] of states) {
    current = id;
    const status = snapshot();
    const axis = axisNames[id.split('.')[0]];
    status[axis].state = id;
    if (id === 'sim.retry') {
      status.sim.nextRetryAt = 105000;
      status.sim.retryDelayMs = 5000;
      status.backend.state = 'net.standby';
    }
    await emit(status);
    const selector = `#${hooks[axis]}`;
    const actual = await text(selector);
    assert.equal(actual, label, `${id}: label`);
    assert.equal(await page.$eval(selector, (el) => el.dataset.severity), severity, id);
    for (const hook of Object.values(hooks)) {
      assert(await page.$eval(`#${hook}`, (el) => el.textContent.length > 0 && el.getBoundingClientRect().height > 0));
    }
    if (axis === 'backend' && id !== 'net.ok') assert.notEqual(actual, 'ACARS UPLINK');
    await capture(id);
    console.log(`PASS ${id}: ${actual}`);
  }
  for (const [name, simState, netState] of [
    ['connected', 'sim.connected', 'net.ok'], ['sim-down', 'sim.retry', 'net.standby'],
    ['backend-down', 'sim.connected', 'net.unreachable'],
  ]) {
    current = name;
    const status = snapshot();
    status.sim.state = simState; status.sim.nextRetryAt = 110000; status.backend.state = netState;
    await emit(status);
    assert.equal((await text('#status-net')) === 'ACARS UPLINK', name === 'connected');
    await capture(name);
    console.log(`PASS ${name}: ${await text('#status-sim')} | ${await text('#status-net')}`);
  }
  current = 'retry-ladder';
  for (const seconds of [5, 10, 20, 40, 60, 60, 60, 60, 60]) {
    const status = snapshot(); status.sim.state = 'sim.retry'; status.sim.nextRetryAt = 100000 + seconds * 1000;
    await emit(status);
    assert.equal(await text('#status-sim'), `SIM LINK RETRY ${String(seconds).padStart(2, '0')}S`);
  }
  await page.evaluate(() => { Date.now = () => 101000; });
  await page.waitForFunction(() => document.getElementById('status-sim').textContent === 'SIM LINK RETRY 59S');
  console.log('PASS retry-ladder: 05,10,20,40,60,60,60,60,60; local tick 60 -> 59');
  current = 'unknown';
  const unknown = snapshot(); unknown.sim.state = 'sim.future'; await emit(unknown);
  assert.equal(await text('#status-sim'), '?? sim.future');
  await capture('unknown'); console.log('PASS unknown: ?? sim.future');

  current = 'config';
  for (const [id, fields] of Object.entries({ NETWORK: ['serverUrl', 'ingestToken', 'certPath'],
    SIM: ['sim', 'autoUplink'], TRAFFIC: ['trafficEnabled', 'trafficRadiusM'] })) {
    await show(id);
    for (const field of fields) assert.equal(await page.$$eval(`[data-field="${field}"] [data-field-value="${field}"]`, (els) => els.length), 1);
    await capture(`config-${id.toLowerCase()}`);
    console.log(`PASS config-${id.toLowerCase()}: ${fields.join(', ')}`);
  }
  await show('NETWORK');
  await rejected('serverUrl', 'ftp://host', 'L1'); await capture('config-rejected');
  await entry('https://example.invalid:4443/a/long/CaseSensitive/path/', 'L1');
  await rejected('serverUrl empty', 'DELETE', 'L1');
  await entry('https://example.invalid:4443/a/long/CaseSensitive/path/', 'L1');
  await rejected('ingestToken empty', 'DELETE', 'L2');
  const token = 'PLACEHOLDER-TOKEN-MixedCase-1234567890';
  await page.evaluate(() => window.FMC.setScratchpad(''));
  // Exercise real physical key events, not a test-only form value.
  await page.keyboard.type(token);
  assert.equal(await page.evaluate(() => window.FMC.getScratchpad()), token);
  assert.equal(await page.evaluate((token) => document.documentElement.textContent.includes(token), token), false);
  assert.equal(await text('#scratchpad'), '•'.repeat(22));
  await capture('config-token-entry');
  await page.click('[data-lsk="L2"]');
  assert.equal(await text('[data-field-value="ingestToken"]'), '••••••••');
  assert.equal(await page.evaluate((token) => document.documentElement.textContent.includes(token), token), false);
  await entry('C:\\Certificates\\Long Mixed Case Path\\root-ca.pem', 'L3');
  await show('SIM');
  await rejected('sim', '2019', 'L1'); await entry(' FSX ', 'L1');
  await rejected('autoUplink', 'yes', 'L2'); await entry('ON', 'L2');
  await show('TRAFFIC');
  await entry('off', 'L1');
  for (const value of ['999', '200001']) {
    await rejected('trafficRadiusM', value, 'L2', 'ENTRY OUT OF RANGE');
    await entry('40000', 'L2');
  }
  await entry('not-a-number', 'L2');
  assert.equal(await text('[data-field-value="trafficRadiusM"]'), '40000');
  assert.equal(await text('#scratchpad'), 'USING DEFAULT 40000');
  await entry('1500.6', 'L2');
  assert.equal(await text('[data-field-value="trafficRadiusM"]'), '1501');
  const before = await saves();
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction(() => document.getElementById('scratchpad').textContent === 'CONFIG SAVED');
  assert.equal(await saves(), before + 1);
  const saved = await page.evaluate(() => window.__FMC_STUB__.calls.findLast((call) => call.method === 'setConfig').args[0]);
  assert.deepEqual(saved, { version: 1, serverUrl: 'https://example.invalid:4443/a/long/CaseSensitive/path',
    ingestToken: token, certPath: 'C:\\Certificates\\Long Mixed Case Path\\root-ca.pem', sim: 'fsx', autoUplink: true,
    trafficEnabled: false, trafficRadiusM: 1501 });
  assert.equal(await page.evaluate((token) => document.documentElement.textContent.includes(token), token), false);
  assert.equal(await page.evaluate(() => 'ingestToken' in window.__FMC_STUB__.config.config), false);
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction((count) => window.__FMC_STUB__.calls.filter((call) => call.method === 'setConfig').length === count, {}, before + 2);
  assert.equal(await page.evaluate(() => 'ingestToken' in window.__FMC_STUB__.calls.findLast((call) => call.method === 'setConfig').args[0]), false);
  console.log('PASS SAVE: full canonical config; untouched token omitted; token absent from all captured DOM text and config returns');
  await page.evaluate(() => { window.__FMC_STUB__.setConfigResult = { ok: false, message: 'write failed' }; });
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction(() => document.getElementById('scratchpad').textContent === 'SAVE FAILED');
  console.log('PASS save failure: SAVE FAILED');
  // Page navigation must not reveal an unfinished secret.
  await show('NETWORK'); await page.keyboard.type(token); await show('SIM');
  assert.equal(await text('#scratchpad'), '');
  assert.equal(await page.evaluate((token) => document.documentElement.textContent.includes(token), token), false);
  await page.click('[data-key="NEXT"]'); assert.equal(await page.$eval('#fmc-screen', (el) => el.dataset.page), 'TRAFFIC');
  await page.click('[data-key="NEXT"]'); assert.equal(await page.$eval('#fmc-screen', (el) => el.dataset.page), 'NETWORK');
  await page.click('[data-key="PREV"]'); assert.equal(await page.$eval('#fmc-screen', (el) => el.dataset.page), 'TRAFFIC');
  console.log('PASS navigation: CFG wrap; unfinished secret cleared');
  current = 'first-run';
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.FMC?.getConfigCache());
  await page.evaluate(async () => {
    window.__FMC_STUB__.config = { exists: false, path: 'C:/scratch/config.json', config: null, raw: null };
    await window.FMC.refreshConfig();
  });
  await show('NETWORK');
  assert.equal(await text('[data-field-value="serverUrl"]'), '□□□□□□□□');
  assert.equal(await text('[data-field-value="ingestToken"]'), '□□□□□□□□');
  await page.click('[data-lsk="R6"]');
  assert.equal(await saves(), 0);
  assert.equal(await text('#scratchpad'), 'INVALID ENTRY');
  await entry('https://fresh.invalid:4443', 'L1');
  await entry(token, 'L2');
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction(() => document.getElementById('scratchpad').textContent === 'CONFIG SAVED');
  assert.equal(await saves(), 1);
  console.log('PASS first-run: required boxes; missing config blocks save; GUI creates full config');

  current = 'invalid-object-repair';
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.FMC?.getConfigCache());
  await page.evaluate(async () => {
    const stub = window.__FMC_STUB__;
    stub.config = { ...stub.config, raw: {
      serverUrl: 'ftp://wrong', sim: '2019', autoUplink: 'bad', tokenSet: true,
    } };
    await window.FMC.refreshConfig();
    stub.emitStatus({ ...window.FMC.getStatus(), config: stub.config.config });
  });
  await show('NETWORK');
  assert.equal(await text('[data-field-value="serverUrl"]'), 'ftp://wrong');
  await entry('https://repaired.invalid', 'L1');
  await page.click('[data-lsk="R6"]');
  assert.equal(await saves(), 0);
  await show('SIM');
  await entry('2024', 'L1');
  await entry('OFF', 'L2');
  await page.click('[data-lsk="R6"]');
  await page.waitForFunction(() => document.getElementById('scratchpad').textContent === 'CONFIG SAVED');
  assert.equal(await saves(), 1);
  console.log('PASS invalid-object-repair: current raw preferred to stale config; repair, defaults, token preserved');
  current = 'window-minimum';
  await page.setViewport({ width: 488, height: 680, deviceScaleFactor: 1 });
  await show('STATUS'); await emit(snapshot());
  assert.equal(await page.evaluate(() => {
    const unit = document.getElementById('fmc-unit').getBoundingClientRect();
    return unit.left >= 0 && unit.top >= 0 && unit.right <= innerWidth && unit.bottom <= innerHeight;
  }), true, 'minimum window clips panel');
  // The panel fitting the window doesn't mean the CDU content fits the
  // screen: --fmc-cols sets the grid's width directly in ch, independent of
  // the screen's actual box, so a wide column count can overflow its own
  // container even while the outer panel still fits — exactly the bug that
  // slipped past this check when --fmc-cols went from 30 to 50.
  assert.equal(await page.evaluate(() => {
    const screen = document.getElementById('fmc-screen');
    return screen.scrollWidth <= screen.clientWidth;
  }), true, 'CDU content overflows its own screen at the minimum window width');
  await capture('window-minimum');
  console.log('PASS window-minimum: panel fits 488x680, CDU content fits the screen');
  clean();
  console.log('PASS browser errors: none (pageerror and console error both fatal)');
} catch (error) {
  console.error(`FAIL ${current}: ${error.message}`);
  process.exitCode = 1;
} finally {
  // Both success and every failure path release the browser and scratch port.
  try { if (browser) await browser.close(); }
  finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    console.log('Cleanup: browser closed; scratch server closed');
  }
}
