// Frozen names copied here so changing either implementation cannot silently
// change the expected contract. This tool only reads application files.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const COMMANDS = ['config_get', 'config_set', 'config_path', 'uplink_start', 'uplink_stop', 'sidecar_restart', 'status_get'];
const EVENTS = ['sidecar:status', 'sidecar:log', 'sidecar:exit'];
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
  if (failed) process.exitCode = 1;
} catch (error) { console.error(`FAIL contract: ${error.message}`); process.exitCode = 1; }
