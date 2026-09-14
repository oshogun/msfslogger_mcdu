import { WebSocket } from '../../../sidecar/node_modules/undici/index.js';

const pages = await (await fetch('http://127.0.0.1:19999/pagelist.json')).json();
const panel = pages.find(page => page.title === 'MSFSLogger CDU');
if (!panel) throw new Error('The live MSFSLogger CDU Coherent view was not found. Open the toolbar panel first.');
const socket = new WebSocket(`ws://127.0.0.1:19999/devtools/page/${panel.id}`);
const pending = new Map(); let id = 0;
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data));
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  if (message.method === 'Console.messageAdded') console.log('CONSOLE', JSON.stringify(message.params.message));
});
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
function send(method, params={}) { return new Promise(resolve => { const requestId=++id; pending.set(requestId,resolve); socket.send(JSON.stringify({id:requestId,method,params})); }); }
await send('Console.enable'); await send('Runtime.enable');
if (process.argv.includes('--reload')) {
  const reload = await send('Runtime.evaluate', { expression:`(function(){var f=document.querySelector('#MSFSLoggerCDUFrame');if(!f)return 'missing iframe';f.contentWindow.location.reload();return 'reloading';}())`, returnByValue:true });
  console.log(JSON.stringify(reload,null,2));
  await new Promise(resolve => setTimeout(resolve, 1500));
}
const expression = `JSON.stringify((function(){var f=document.querySelector('#MSFSLoggerCDUFrame');var w=f&&f.contentWindow;var h=w&&w.__FMC_HOST__;var raw=w&&w.localStorage&&w.localStorage.getItem('msfslogger.cdu.config.v1');var cfg={};try{cfg=JSON.parse(raw||'{}')}catch(e){}return {frameAttribute:f&&f.getAttribute('src'),frameResolved:f&&f.src,ready:f&&f.contentDocument&&f.contentDocument.readyState,bodyLength:f&&f.contentDocument&&f.contentDocument.body&&f.contentDocument.body.innerHTML.length,host:!!h,label:h&&h.hostLabel,promise:!!(w&&w.Promise),status:h&&h.getStatus?String(h.getStatus()):null,screen:w&&w.document&&w.document.querySelector('#status-app')&&w.document.querySelector('#status-app').textContent,configStored:!!raw,serverUrl:cfg.serverUrl||'',tokenSet:typeof cfg.ingestToken==='string'&&cfg.ingestToken.length>0,tokenLength:typeof cfg.ingestToken==='string'?cfg.ingestToken.length:0,iframeCoherent:typeof w.Coherent,iframeSimVar:typeof w.SimVar,frame:w&&w.msfsloggerGaugeHost?JSON.stringify(w.msfsloggerGaugeHost.frame()):null,parentCoherent:typeof Coherent,parentSimVar:typeof SimVar};}()))`;
const result = await send('Runtime.evaluate', { expression, returnByValue:true });
console.log(JSON.stringify(result,null,2));
socket.close();
