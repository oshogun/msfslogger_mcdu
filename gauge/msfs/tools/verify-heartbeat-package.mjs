import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const msfs = resolve(here, '..');
const packageRoot = resolve(msfs, 'Packages/msfslogger-cdu');
const builtAfterIndex = process.argv.indexOf('--built-after');
const builtAfter = builtAfterIndex >= 0 ? Number(process.argv[builtAfterIndex + 1]) : undefined;
if (builtAfterIndex >= 0 && !Number.isFinite(builtAfter)) throw new Error('--built-after requires a millisecond timestamp');

const required = [
  'modules/MSFSLoggerBridge.wasm',
  'html_ui/Pages/VCockpit/Instruments/MSFSLoggerCDU/MSFSLoggerCDU.js',
  'html_ui/InGamePanels/MSFSLoggerCDU/MSFSLoggerCDUPanel.js',
  'InGamePanels/InGamePanel_MSFSLoggerCDU.spb',
];
const layout = JSON.parse(await readFile(resolve(packageRoot, 'layout.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'manifest.json'), 'utf8'));
if (manifest.package_version !== '0.1.1') throw new Error(`Expected feasibility package version 0.1.1, found ${manifest.package_version}`);
const entries = Array.isArray(layout.content) ? layout.content : [];
const paths = new Set(entries.map(entry => String(entry.path || '').replaceAll('\\', '/')));
for (const relative of required) {
  if (!paths.has(relative)) throw new Error(`Package layout is missing required asset: ${relative}`);
  const info = await stat(resolve(packageRoot, relative));
  if (info.size === 0) throw new Error(`Package asset is empty: ${relative}`);
  if (builtAfter !== undefined && info.mtimeMs + 2000 < builtAfter) throw new Error(`Package asset is stale: ${relative}`);
}

const stagedWasm = resolve(msfs, '.build/wasm/MSFSLoggerBridge.wasm');
const packagedWasm = resolve(packageRoot, 'modules/MSFSLoggerBridge.wasm');
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const [stagedHash, packagedHash] = await Promise.all([digest(stagedWasm), digest(packagedWasm)]);
if (stagedHash !== packagedHash) throw new Error('Packaged heartbeat module does not match the newly staged WASM');
console.log(`Verified heartbeat package ${manifest.package_version}: ${packagedHash}`);
