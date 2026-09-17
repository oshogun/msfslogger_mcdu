// Frozen names copied here so changing either implementation cannot silently
// change the expected contract. This tool only reads application files.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const COMMANDS = ['config_get', 'config_set', 'config_path', 'uplink_start', 'uplink_stop', 'sidecar_restart', 'status_get',
  'datalink_state', 'datalink_watch', 'datalink_refresh', 'datalink_thread', 'datalink_canned', 'datalink_send_canned',
  'datalink_wx', 'datalink_loadsheet', 'simbrief_settings', 'simbrief_prefile', 'simbrief_clear_prefile'];
const EVENTS = ['sidecar:status', 'sidecar:log', 'sidecar:exit', 'sidecar:datalink'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (['target', 'icons'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.name.endsWith('.rs')) found.push(path);
  }
  return found;
}
try {
  const bridgePath = resolve(root, 'ui/src/bridge.js');
  const sources = await Promise.all((await files(resolve(root, 'src-tauri'))).map(async (path) => ({ path, body: await readFile(path, 'utf8') })));
  const bridge = { path: bridgePath, body: await readFile(bridgePath, 'utf8') };
  const locations = (set, pattern) => set.flatMap(({ path, body }) => body.split('\n').flatMap((line, i) =>
    pattern.test(line) ? [`${relative(root, path)}:${i + 1}`] : []));
  let failed = false;
  for (const name of [...COMMANDS, ...EVENTS]) {
    const quoted = new RegExp(`["']${name}["']`);
    const rustPattern = COMMANDS.includes(name) ? new RegExp(`\\bfn\\s+${name}\\b`) : quoted;
    const rust = locations(sources, rustPattern);
    const webview = locations([bridge], quoted);
    if (!rust.length || !webview.length) {
      console.error(`FAIL ${name}: missing from ${!rust.length ? 'Rust' : 'webview bridge'}`);
      failed = true;
    } else console.log(`PASS ${name}: Rust ${rust.join(', ')} | webview ${webview.join(', ')}`);
    if (COMMANDS.includes(name)) {
      const registered = sources.some(({ body }) => [...body.matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)]
        .some((match) => new RegExp(`\\b${name}\\b`).test(match[1])));
      if (!registered) { console.error(`FAIL ${name}: missing from Rust command registration`); failed = true; }
    }
  }
  // The relay must outwait the sidecar's own HTTP timeout by at least the
  // margin, or a slow server reads as a shell timeout instead of its real cause.
  const clientSource = await readFile(resolve(root, 'sidecar/src/datalink-client.ts'), 'utf8');
  const relaySource = await readFile(resolve(root, 'src-tauri/src/datalink.rs'), 'utf8');
  const tsConst = (name) => clientSource.match(new RegExp(`export const ${name} = (\\d+);`))?.[1];
  const rustConst = (name) => relaySource
    .match(new RegExp(`pub const ${name}: Duration = Duration::from_millis\\(([\\d_]+)\\);`))?.[1]?.replaceAll('_', '');
  const ms = {
    datalink: tsConst('DATALINK_HTTP_TIMEOUT_MS'), prefile: tsConst('SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS'),
    relay: rustConst('REQUEST_TIMEOUT'), prefileRelay: rustConst('PREFILE_REQUEST_TIMEOUT'),
    mirror: rustConst('SIDECAR_PREFILE_HTTP_TIMEOUT'), slack: rustConst('RELAY_SLACK_MIN'),
  };
  const missing = Object.entries(ms).filter(([, value]) => value === undefined).map(([key]) => key);
  const n = Object.fromEntries(Object.entries(ms).map(([key, value]) => [key, Number(value)]));
  if (missing.length) {
    console.error(`FAIL relay-timeouts: could not read ${missing.join(', ')}`);
    failed = true;
  } else if (n.mirror !== n.prefile || n.relay < n.datalink + n.slack || n.prefileRelay < n.prefile + n.slack) {
    console.error(`FAIL relay-timeouts: datalink ${n.datalink} ms, relay ${n.relay} ms; prefile ${n.prefile} ms `
      + `(mirror ${n.mirror} ms), relay ${n.prefileRelay} ms; slack ${n.slack} ms`);
    failed = true;
  } else {
    console.log(`PASS relay-timeouts: datalink ${n.datalink} ms < relay ${n.relay} ms; prefile ${n.prefile} ms < relay ${n.prefileRelay} ms`);
  }
  if (failed) process.exitCode = 1;
} catch (error) { console.error(`FAIL contract: ${error.message}`); process.exitCode = 1; }
