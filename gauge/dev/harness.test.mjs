import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createGaugeServer } from './server.mjs';

test('host scenarios, subscriptions and memory-only configuration', async () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(await readFile(new URL('./mock-host.js', import.meta.url), 'utf8'), context);
  const { __FMC_HOST__: host, gaugeDev } = context.window;
  const seen = [];
  const off = host.onStatus(status => seen.push(status));
  await host.startUplink();
  assert.equal(seen.at(-1).backend.state, 'net.ok');
  gaugeDev.scenario('offline');
  assert.equal(seen.at(-1).sim.state, 'sim.connected');
  assert.equal(seen.at(-1).backend.state, 'net.unreachable');
  gaugeDev.scenario('active-pause');
  assert.equal(seen.at(-1).pause.state, 'pause.active');
  gaugeDev.scenario('retry');
  assert.ok(seen.at(-1).sim.nextRetryAt > Date.now());
  off();
  const count = seen.length;
  await host.stopUplink();
  assert.equal(seen.length, count);
  assert.equal((await host.getStatus()).app.state, 'app.stopped');
  await host.setConfig({ ingestToken: 'secret-test', trafficRadiusM: 50000 });
  const config = await host.getConfig();
  assert.equal(config.config.tokenSet, true);
  assert.equal(config.config.trafficRadiusM, 50000);
  assert.ok(!JSON.stringify(config).includes('secret-test'));
  assert.ok(!JSON.stringify(gaugeDev.calls).includes('secret-test'));
  config.config.trafficRadiusM = 1;
  assert.equal((await host.getConfig()).config.trafficRadiusM, 50000);
  assert.throws(() => gaugeDev.scenario('typo'));
});

test('serves real UI with early adapter injection and limits file access', async t => {
  const server = createGaugeServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(url + '/ui/index.html')).text();
  assert.ok(html.indexOf('mock-host.js') < html.indexOf('src/app.js'));
  assert.ok(html.includes('mock-host.js'));
  const js = await fetch(url + '/ui/src/app.js');
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  assert.equal(js.headers.get('cache-control'), 'no-store');
  for (const path of ['/.git/config', '/sidecar/package.json', '/ui/%2e%2e%2fpackage.json']) {
    assert.equal((await fetch(url + path)).status, 404);
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.ok((await (await fetch(url + '/__revision')).text()).includes('mock-host.js'));
});
