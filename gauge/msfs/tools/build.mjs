import { build } from 'esbuild';
import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const msfs = resolve(here, '..');
const root = resolve(msfs, '../..');
const out = resolve(msfs, '.build/html_ui');
const instrument = resolve(out, 'Pages/VCockpit/Instruments/MSFSLoggerCDU');
const panel = resolve(out, 'InGamePanels/MSFSLoggerCDU');
const run = (command, args, label) => new Promise((done, reject) => {
  const child = spawn(command, args, { cwd: msfs, stdio: 'inherit' });
  child.on('error', error => reject(new Error(`${label} could not start (${command}): ${error.message}`)));
  child.on('exit', code => {
    if (code === 0) return done();
    const unsigned = Number(code) >>> 0;
    reject(new Error(`${label} failed with exit code ${code} (0x${unsigned.toString(16).toUpperCase().padStart(8, '0')})`));
  });
});

const runPackageTool = (tool, project, packageRoot, builtAfter, requiredRelative=['manifest.json','layout.json','modules/MSFSLoggerBridge.wasm']) => new Promise((done, reject) => {
  const timeoutMs = 120_000;
  const stableMs = 5_000;
  const pollMs = 500;
  const started = Date.now();
  const required = requiredRelative.map(path=>resolve(packageRoot,path));
  const child = spawn(tool, [project, '-nopause'], { cwd: msfs, stdio: 'inherit' });
  let settled = false;
  let terminating = false;
  let terminationError;
  let exitCode = null;
  let stableSince = 0;
  let signature = '';

  const finish = (error) => {
    if (settled) return;
    settled = true;
    if (error) reject(error); else done();
  };
  const stopOwnedChild = (error) => {
    if (exitCode !== null) return finish(error);
    if (terminating) return;
    terminating = true;
    terminationError = error;
    if (!child.kill()) finish(new Error(`Could not terminate task-owned fspackagetool child${error ? ` after: ${error.message}` : ''}`));
  };
  child.on('error', error => finish(new Error(`fspackagetool could not start (${tool}): ${error.message}`)));
  child.on('exit', code => {
    exitCode = code;
    if (terminating) return finish(terminationError);
    if (!terminating && code !== 0) {
      const unsigned = Number(code) >>> 0;
      finish(new Error(`fspackagetool failed with exit code ${code} (0x${unsigned.toString(16).toUpperCase().padStart(8, '0')})`));
    }
  });

  const poll = async () => {
    if (settled) return;
    try {
      const infos = await Promise.all(required.map(path => stat(path)));
      if (infos.some(info=>info.size===0||info.mtimeMs+2000<builtAfter)) {
        throw new Error('required package output is empty or predates this build');
      }
      await Promise.all([readFile(required[0], 'utf8').then(JSON.parse), readFile(required[1], 'utf8').then(JSON.parse)]);
      const nextSignature = infos.map(info => `${info.size}:${info.mtimeMs}`).join('|');
      if (nextSignature !== signature) {
        signature = nextSignature;
        stableSince = Date.now();
      } else if (stableSince && Date.now() - stableSince >= stableMs) {
        if (exitCode === 0) return finish();
      }
    } catch {
      signature = '';
      stableSince = 0;
    }
    if (Date.now() - started >= timeoutMs) {
      stopOwnedChild(new Error(`fspackagetool timed out after ${timeoutMs / 1000}s without stable, fresh manifest/layout/module output`));
      return;
    }
    setTimeout(poll, pollMs);
  };
  void poll();
});

if (process.argv.includes('--origin-probe')) {
  const probeOut=resolve(msfs,'.build-origin-probe/html_ui');
  const probeInstrument=resolve(probeOut,'Pages/VCockpit/Instruments/MSFSLoggerOriginProbe');
  const probePanel=resolve(probeOut,'InGamePanels/MSFSLoggerOriginProbe');
  await rm(resolve(msfs,'.build-origin-probe'),{recursive:true,force:true});
  await mkdir(probeInstrument,{recursive:true});await mkdir(probePanel,{recursive:true});
  const probeCsp="default-src 'none'; script-src 'self'; connect-src ws://127.0.0.1:39092";
  await writeFile(resolve(probeInstrument,'MSFSLoggerOriginProbe.html'),`<!doctype html><html><head><meta charset="utf-8"><meta name="msfslogger-build" content="ORIGIN-PROBE-ONLY"><meta http-equiv="Content-Security-Policy" content="${probeCsp}"></head><body><p>MSFSLogger Origin Probe Only</p><script src="MSFSLoggerOriginProbe.js"></script></body></html>`);
  await writeFile(resolve(probeInstrument,'MSFSLoggerOriginProbe.js'),"(function(){'use strict';var socket=new WebSocket('ws://127.0.0.1:39092/gauge-sync/v1');socket.onerror=function(){};socket.onclose=function(){};}());\n");
  const panelHtml=(await readFile(resolve(msfs,'src/MSFSLoggerCDUPanel.html'),'utf8')).replaceAll('MSFSLoggerCDU','MSFSLoggerOriginProbe').replaceAll('MSFSLOGGER CDU','MSFSLOGGER ORIGIN PROBE');
  const panelCss=await readFile(resolve(msfs,'src/MSFSLoggerCDUPanel.css'),'utf8');
  const panelJs=(await readFile(resolve(msfs,'src/MSFSLoggerCDUPanel.js'),'utf8')).replaceAll('MSFSLoggerCDU','MSFSLoggerOriginProbe').replace('/Pages/VCockpit/Instruments/MSFSLoggerOriginProbe/MSFSLoggerOriginProbe.html?v=0.1.1','/Pages/VCockpit/Instruments/MSFSLoggerOriginProbe/MSFSLoggerOriginProbe.html');
  await writeFile(resolve(probePanel,'MSFSLoggerOriginProbe.html'),panelHtml);await writeFile(resolve(probePanel,'MSFSLoggerOriginProbePanel.css'),panelCss);await writeFile(resolve(probePanel,'MSFSLoggerOriginProbePanel.js'),panelJs);
  await mkdir(resolve(probeOut,'icons/toolbar'),{recursive:true});await cp(resolve(msfs,'src/ICON_TOOLBAR_MSFSLOGGER_CDU.svg'),resolve(probeOut,'icons/toolbar/ICON_TOOLBAR_MSFSLOGGER_ORIGIN_PROBE.svg'));
  console.log('ORIGIN-PROBE-ONLY staged assets: '+probeOut);
  if(process.argv.includes('--stage-only'))process.exit(0);
  const sdk=process.env.MSFS_SDK||'C:\\MSFS SDK',tool=resolve(sdk,'Tools/bin/fspackagetool.exe');await access(tool);
  const builtAfter=Date.now(),packageRoot=resolve(msfs,'Packages/msfslogger-origin-probe');
  await rm(packageRoot,{recursive:true,force:true});await rm(resolve(msfs,'_PackageIntOriginProbe'),{recursive:true,force:true});
  await runPackageTool(tool,resolve(msfs,'msfslogger-origin-probe.xml'),packageRoot,builtAfter,['manifest.json','layout.json']);
  console.log('ORIGIN-PROBE-ONLY Community package: '+packageRoot);process.exit(0);
}

await rm(resolve(msfs, '.build'), { recursive:true, force:true });
await mkdir(instrument, { recursive:true }); await mkdir(panel, { recursive:true });
await build({ entryPoints:[resolve(root,'ui/src/app.js')], bundle:true, format:'iife', target:'safari11', outfile:resolve(instrument,'MSFSLoggerCDU.js'), logLevel:'warning' });
const uiHtml = await readFile(resolve(root,'ui/index.html'),'utf8');
const body = uiHtml.match(/<body>([\s\S]*?)<script type="module" src="src\/app\.js"><\/script>[\s\S]*?<\/body>/i);
if(!body) throw new Error('Could not extract CDU body from ui/index.html');
const shell = await readFile(resolve(msfs,'src/MSFSLoggerCDU.html'),'utf8');
const gaugeCsp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ws://127.0.0.1:39091";
const stagedShell = shell.replace('<meta charset="utf-8" />', `<meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${gaugeCsp}" />`);
await writeFile(resolve(instrument,'MSFSLoggerCDU.html'), stagedShell.replace('<!-- UI_BODY -->', body[1]));
await writeFile(resolve(instrument,'MSFSLoggerCDU.css'), (await readFile(resolve(root,'ui/css/fmc.css'),'utf8'))+'\n'+(await readFile(resolve(root,'ui/css/pages.css'),'utf8')));
await cp(resolve(msfs,'src/MSFSLoggerGaugeHost.js'),resolve(instrument,'MSFSLoggerGaugeHost.js'));
for(const name of ['MSFSLoggerCDUPanel.html','MSFSLoggerCDUPanel.css','MSFSLoggerCDUPanel.js']) await cp(resolve(msfs,'src',name),resolve(panel,name));
await mkdir(resolve(out,'icons/toolbar'),{recursive:true}); await cp(resolve(msfs,'src/ICON_TOOLBAR_MSFSLOGGER_CDU.svg'),resolve(out,'icons/toolbar/ICON_TOOLBAR_MSFSLOGGER_CDU.svg'));

if (process.argv.includes('--stage-only')) {
  console.log('Staged gauge web assets: '+out);
  process.exit(0);
}

const sdk = process.env.MSFS_SDK || 'C:\\MSFS SDK';
const tool = resolve(sdk,'Tools/bin/fspackagetool.exe');
const clang = resolve(sdk, 'WASM/llvm/bin/clang-cl.exe');
for (const [label, path] of [['MSFS package tool', tool], ['MSFS WASM compiler', clang]]) {
  try { await access(path); }
  catch { throw new Error(`${label} not found at ${path}. Set MSFS_SDK to the installed MSFS 2020 SDK root.`); }
}

const buildStarted = Date.now();
const cmakeBuild = resolve(msfs, '.build/wasm-sdk');
await run('cmake', ['-S', resolve(msfs, 'wasm'), '-B', cmakeBuild, '-DMSFSLOGGER_BUILD_TESTS=OFF', '-DMSFSLOGGER_BUILD_WASM=ON', `-DMSFS_SDK_ROOT=${sdk}`], 'CMake configure');
await run('cmake', ['--build', cmakeBuild, '--config', 'Release', '--target', 'MSFSLoggerBridge'], 'heartbeat WASM build');

await rm(resolve(msfs, 'Packages/msfslogger-cdu'), { recursive:true, force:true });
await rm(resolve(msfs, '_PackageInt'), { recursive:true, force:true });
const packageRoot=resolve(msfs,'Packages/msfslogger-cdu');
await runPackageTool(tool, resolve(msfs,'msfslogger-cdu.xml'), packageRoot, buildStarted);
await run(process.execPath, [resolve(here, 'verify-heartbeat-package.mjs'), '--built-after', String(buildStarted)], 'package verifier');
console.log('Community package: '+packageRoot);
