// Static checker for the ownership boundary between the host adapter, the
// shell and the pages. Reads only application source under ui/src/ — no
// browser, no server, no run artifact, no node_modules. Writes nothing to
// disk; there is no output path to override.
//
// Rules are transcribed verbatim from the frozen design, not derived by
// reading the shell or the pages: a check written by reverse-engineering the
// implementation it grades would pass by construction. See each rule's
// comment for the exact prose it encodes.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = resolve(root, 'ui/src');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

function loc(path, line) {
  return `${relative(root, path)}:${line}`;
}

// Every rule below is (scanned set, violating pattern, message). No judgement
// calls: a line either matches the pattern or it doesn't.
function scan(files, pattern, exceptPaths) {
  const violations = [];
  const exceptionMatches = [];
  for (const file of files) {
    const isExcepted = exceptPaths.includes(file.path);
    file.body.split('\n').forEach((line, i) => {
      if (!pattern.test(line)) return;
      if (isExcepted) exceptionMatches.push(loc(file.path, i + 1));
      else violations.push(loc(file.path, i + 1));
    });
  }
  return { violations, exceptionMatches };
}

try {
  const paths = await walk(src);
  const files = await Promise.all(paths.map(async (path) => ({ path, body: await readFile(path, 'utf8') })));
  const appJs = resolve(src, 'app.js');
  const bridgeJs = resolve(src, 'bridge.js');
  const pageFiles = files.filter((f) => f.path.startsWith(`${resolve(src, 'pages')}${sep}`));

  let failed = false;
  const fail = (rule, locations, message) => {
    for (const l of locations) console.error(`FAIL ${rule}: ${l} — ${message}`);
    failed = true;
  };

  // bridge-import: only ui/src/app.js may import ./bridge.js. A file with
  // zero matches in app.js also fails — otherwise deleting the import would
  // pass the rule instead of tripping interface-members downstream.
  {
    const pattern = /(from\s*['"][^'"]*\/bridge\.js['"]|import\(\s*['"][^'"]*\/bridge\.js['"])/;
    const { violations, exceptionMatches } = scan(files, pattern, [appJs]);
    if (violations.length) fail('bridge-import', violations, 'only ui/src/app.js may import ./bridge.js');
    else if (!exceptionMatches.length) fail('bridge-import', [loc(appJs, 1)], 'only ui/src/app.js may import ./bridge.js');
    else console.log(`PASS bridge-import: ./bridge.js imported only at ${exceptionMatches.join(', ')}`);
  }

  // tauri-reference: __TAURI__ / __TAURI_INTERNALS__ appear only in bridge.js.
  {
    const pattern = /__TAURI__|__TAURI_INTERNALS__/;
    const { violations, exceptionMatches } = scan(files, pattern, [bridgeJs]);
    if (violations.length) fail('tauri-reference', violations, 'only ui/src/bridge.js may mention Tauri');
    else console.log(`PASS tauri-reference: found only in ui/src/bridge.js (${exceptionMatches.length} line${exceptionMatches.length === 1 ? '' : 's'})`);
  }

  // host-global: __FMC_HOST__ / __FMC_STUB__ appear only in bridge.js.
  {
    const pattern = /__FMC_HOST__|__FMC_STUB__/;
    const { violations, exceptionMatches } = scan(files, pattern, [bridgeJs]);
    if (violations.length) fail('host-global', violations, 'only ui/src/bridge.js may resolve or publish a host');
    else console.log(`PASS host-global: found only in ui/src/bridge.js (${exceptionMatches.length} line${exceptionMatches.length === 1 ? '' : 's'})`);
  }

  // page-adapter: no page may name the adapter (bare word "bridge").
  {
    const pattern = /\bbridge\b/;
    const { violations } = scan(pageFiles, pattern, []);
    if (violations.length) fail('page-adapter', violations, 'a page may not name the adapter; use ctx.fmc');
    else console.log('PASS page-adapter: no page under ui/src/pages/ names the adapter');
  }

  // page-global: no page may mention the FMC global; it arrives via
  // register(fmc)/ctx.fmc.
  {
    const pattern = /\bFMC\b/;
    const { violations } = scan(pageFiles, pattern, []);
    if (violations.length) fail('page-global', violations, 'a page receives the interface via register(fmc)/ctx.fmc, not a global');
    else console.log('PASS page-global: no page under ui/src/pages/ mentions FMC');
  }

  // page-events: no page may subscribe to host events directly. A page's own
  // `onDatalink` hook is a property the shell calls, never a call it makes.
  {
    const pattern = /\.\s*(onLog|onExit|onDatalink)\s*\(/;
    const { violations } = scan(pageFiles, pattern, []);
    if (violations.length) fail('page-events', violations, 'the shell owns host event subscriptions');
    else console.log('PASS page-events: no page under ui/src/pages/ subscribes to onLog/onExit/onDatalink');
  }

  // adapter-leak: app.js must not expose the adapter as a member of the
  // interface object or the page context.
  {
    const pattern = /^\s*bridge,\s*$|\bbridge\s*:/;
    const { violations } = scan(files.filter((f) => f.path === appJs), pattern, []);
    if (violations.length) fail('adapter-leak', violations, 'the adapter must not be a member of window.FMC or the page context');
    else console.log('PASS adapter-leak: bridge is not exposed as a member in ui/src/app.js');
  }

  // interface-members: the thirteen original names and the nine datalink
  // members must each appear as a property line in ui/src/app.js.
  {
    const names = [
      'registerPage', 'showPage', 'setScratchpad', 'getScratchpad', 'hasScratchpadError',
      'getConfigCache', 'getConfigPath', 'getStatus', 'refreshConfig', 'setConfig',
      'startUplink', 'stopUplink', 'restartSidecar', 'getDatalinkState', 'watchDatalink',
      'refreshDatalink', 'getDatalinkThread', 'getCannedMessages', 'sendCannedMessage',
      'requestWeather', 'requestLoadsheet', 'setPageNumber',
    ];
    const appFile = files.find((f) => f.path === appJs);
    const lines = appFile ? appFile.body.split('\n') : [];
    const missing = names.filter((name) => !lines.some((line) => new RegExp(`^\\s*${name}[,:]`).test(line)));
    if (missing.length) fail('interface-members', [loc(appJs, 1)], `${missing.join(', ')} missing from the interface built in ui/src/app.js`);
    else console.log('PASS interface-members: all twenty-two present in ui/src/app.js');
  }

  process.exitCode = failed ? 1 : 0;
} catch (error) {
  console.error(`FAIL boundary-check: ${error.message}`);
  process.exitCode = 1;
}
