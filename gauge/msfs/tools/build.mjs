import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const msfs = resolve(here, '..');
const root = resolve(msfs, '../..');
const out = resolve(msfs, '.build/html_ui');
const instrument = resolve(out, 'Pages/VCockpit/Instruments/MSFSLoggerCDU');
const panel = resolve(out, 'InGamePanels/MSFSLoggerCDU');
await rm(resolve(msfs, '.build'), { recursive:true, force:true });
await mkdir(instrument, { recursive:true }); await mkdir(panel, { recursive:true });
await build({ entryPoints:[resolve(root,'ui/src/app.js')], bundle:true, format:'iife', target:'safari11', outfile:resolve(instrument,'MSFSLoggerCDU.js'), logLevel:'warning' });
const uiHtml = await readFile(resolve(root,'ui/index.html'),'utf8');
const body = uiHtml.match(/<body>([\s\S]*?)<script type="module" src="src\/app\.js"><\/script>[\s\S]*?<\/body>/i);
if(!body) throw new Error('Could not extract CDU body from ui/index.html');
const shell = await readFile(resolve(msfs,'src/MSFSLoggerCDU.html'),'utf8');
await writeFile(resolve(instrument,'MSFSLoggerCDU.html'), shell.replace('<!-- UI_BODY -->', body[1]));
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
const code = await new Promise((done,reject)=>{const child=spawn(tool,[resolve(msfs,'msfslogger-cdu.xml')],{cwd:msfs,stdio:'inherit'}); child.on('error',reject); child.on('exit',code=>done(code));});
if(code!==0) throw new Error('fspackagetool failed with exit code '+code);
const packageRoot=resolve(msfs,'Packages/msfslogger-cdu');
let manifest;
try { manifest=JSON.parse(await readFile(resolve(packageRoot,'manifest.json'),'utf8')); }
catch (_) { throw new Error('SDK returned success but did not create a Community package. Close MSFS, then rebuild.'); }
if(manifest.package_version!=='0.1.1') throw new Error('SDK left stale package version '+manifest.package_version+'. Close MSFS, remove gauge/msfs/Packages and gauge/msfs/_PackageInt, then rebuild.');
const panelSource=await stat(resolve(msfs,'src/MSFSLoggerCDUPanel.js'));
const panelOutput=await stat(resolve(packageRoot,'html_ui/InGamePanels/MSFSLoggerCDU/MSFSLoggerCDUPanel.js'));
if(panelOutput.size!==panelSource.size) throw new Error('SDK left stale panel assets. Close MSFS and rebuild from a clean generated output.');
console.log('Community package: '+packageRoot);
