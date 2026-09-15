import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../.build/html_ui/Pages/VCockpit/Instruments/MSFSLoggerCDU/',import.meta.url);
const [html,host,ui]=await Promise.all(['MSFSLoggerCDU.html','MSFSLoggerGaugeHost.js','MSFSLoggerCDU.js'].map(name=>readFile(new URL(name,root),'utf8')));
const [tauriConfig,desktopBridge]=await Promise.all([
  readFile(new URL('../../../src-tauri/tauri.conf.json',import.meta.url),'utf8').then(JSON.parse),
  readFile(new URL('../../../ui/src/bridge.js',import.meta.url),'utf8'),
]);
const hostAt=html.indexOf('<script src="MSFSLoggerGaugeHost.js"></script>');
const uiAt=html.indexOf('<script src="MSFSLoggerCDU.js"></script>');
assert.ok(hostAt>=0&&uiAt>hostAt,'synchronized gauge host must load before the shared UI bundle');
assert.match(html,/Content-Security-Policy[^>]+connect-src ws:\/\/127\.0\.0\.1:39091/);
for(const forbidden of ['Sim'+'Var','simvar'+'.js','/api/'+'ingest','x-'+'ingest-token','SENTINEL_T006_TOKEN']) assert.equal(host.includes(forbidden)||ui.includes(forbidden),false,`packaged assets contain ${forbidden}`);
assert.match(host,/ws:\/\/127\.0\.0\.1:39091\/gauge-sync\/v1/);
assert.match(tauriConfig.app.security.csp,/connect-src 'self' ipc: http:\/\/ipc\.localhost/);
assert.match(desktopBridge,/__TAURI_INTERNALS__/);
assert.match(desktopBridge,/\.invoke\(/);
assert.match(desktopBridge,/\.listen\(/);
console.log('PASS package: host-before-ui; exact loopback CSP; synchronized bridge present; desktop Tauri IPC retained; forbidden authority/secret strings absent');
