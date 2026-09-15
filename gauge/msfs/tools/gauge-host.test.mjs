import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../src/MSFSLoggerGaugeHost.js',import.meta.url),'utf8');
const bridgeSource=(await readFile(new URL('../../../ui/src/bridge.js',import.meta.url),'utf8')).replace('export const bridge','var bridge').replace('export const TAURI_COMMANDS','var TAURI_COMMANDS').replace('export const TAURI_EVENTS','var TAURI_EVENTS').replace('export default bridge;','window.__TEST_BRIDGE__=bridge;');
const I='AAAAAAAAAAAAAAAAAAAAAA',C='BBBBBBBBBBBBBBBBBBBBBB',CAP='ccccccccccccccccccccccccccccccccccccccccccc';
const cfg={version:1,serverUrl:'https://host',trafficEnabled:true,trafficRadiusM:40000,sim:'2020',autoUplink:false,tokenSet:true};
function status(name='app.running'){return {v:1,type:'status',at:1,app:{state:name,running:true,problems:[],restarting:false,restartsRemaining:5},sim:{state:'sim.connected',attempt:0,nextRetryAt:null,retryDelayMs:null,protocol:'x',appName:'MSFS',appVersion:null,lastError:null},backend:{state:'net.ok',httpStatus:200,lastOkAt:1,lastErrorAt:null,message:null},pause:{state:'pause.off',flags:0,label:'off',usingPauseEx1:false},traffic:{enabled:true,radiusM:40000,lastSweepAt:null,lastBatchSize:null,lastError:null},config:cfg};}
function full(connection=C,instance=I,snapshotSeq=1,eventSeq=1){return {serviceInstanceId:instance,connectionId:connection,snapshotSeq,eventSeq,generatedAt:1,config:{exists:true,config:cfg},status:status()};}

function harness(paired=true){
  const store=new Map(paired?[['msfslogger.gauge.pairing.v1',JSON.stringify({v:1,capability:CAP})],['msfslogger.cdu.config.v1','forbidden']]:[]);
  const sockets=[],timers=[],writes=[];
  class Socket{constructor(url){this.url=url;this.readyState=0;this.sent=[];this.closes=[];sockets.push(this);}open(){this.readyState=1;this.onopen();}receive(v){this.onmessage({data:typeof v==='string'?v:JSON.stringify(v)});}send(v){this.sent.push(JSON.parse(v));}close(code,reason){this.closes.push({code,reason});this.readyState=3;if(this.onclose)this.onclose();}}
  const crypto={getRandomValues(a){for(let i=0;i<a.length;i++)a[i]=(writes.length+i+1)%251;writes.push(a.length);return a;}};
  let modalNode=null;const body={appendChild(n){n.parentNode=body;modalNode=n;},removeChild(n){n.parentNode=null;if(modalNode===n)modalNode=null;}},document={body,getElementById(id){return modalNode&&modalNode.id===id?modalNode:null;},createElement(){const input={value:''},form={onsubmit:null};return {id:'',style:{},firstChild:form,parentNode:null,set innerHTML(v){this.html=v;},getElementsByTagName(){return [input];},_input:input};}};
  const window={WebSocket:Socket,crypto,document,localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},setTimeout(fn,ms){timers.push({fn,ms,off:false});return timers.length;},clearTimeout(n){if(timers[n-1])timers[n-1].off=true;},SimVar:{GetSimVarValue(){throw Error('forbidden');}},fetch(){throw Error('forbidden');},XMLHttpRequest:function(){throw Error('forbidden');}};
  window.window=window;vm.runInContext(source,vm.createContext({window,Promise,JSON,Object,Array,Boolean,Error,RegExp,Uint8Array,Uint32Array,Number,encodeURIComponent,unescape}));
  function welcome(socket=sockets.at(-1),connection=C,instance=I){socket.receive({v:1,type:'auth.result',requestId:socket.sent[0].requestId,body:{authorized:true}});socket.receive({v:1,type:'session.welcome',body:{serviceInstanceId:instance,connectionId:connection,serverTime:1,capabilityId:I}});socket.receive({v:1,type:'state.full',body:full(connection,instance)});}
  return {window,store,sockets,timers,host:window.__FMC_HOST__,welcome,get modal(){return modalNode;}};
}

test('installs ten-method host, authenticates in first message, and consumes ordered authoritative state',async()=>{
  const h=harness();assert.deepEqual(['getConfig','setConfig','getConfigPath','startUplink','stopUplink','restartSidecar','getStatus','onStatus','onLog','onExit'].filter(k=>typeof h.host[k]==='function').length,10);
  const seen=[];h.host.onStatus(v=>seen.push(v));const s=h.sockets[0];assert.equal(s.url,'ws://127.0.0.1:39091/gauge-sync/v1');s.open();assert.equal(s.sent[0].type,'auth.request');assert.equal(s.url.includes(CAP),false);h.welcome(s);assert.equal(seen.length,1);
  s.receive({v:1,type:'status.event',body:{serviceInstanceId:I,connectionId:C,snapshotSeq:2,eventSeq:2,generatedAt:2,status:status('app.stopped')}});assert.equal(seen.at(-1).app.state,'app.stopped');
  s.receive({v:1,type:'status.event',body:{serviceInstanceId:I,connectionId:C,snapshotSeq:3,eventSeq:4,generatedAt:3,status:status()}});assert.equal(seen.at(-1).app.state,'app.running');assert.equal(s.closes.length,0);
  s.receive({v:1,type:'status.event',body:{serviceInstanceId:I,connectionId:C,snapshotSeq:4,eventSeq:4,generatedAt:4,status:status('app.stopped')}});s.receive({v:1,type:'status.event',body:{serviceInstanceId:I,connectionId:C,snapshotSeq:2,eventSeq:5,generatedAt:4,status:status('app.stopped')}});assert.equal(seen.length,3);assert.equal(s.closes.length,0);
  s.receive({v:1,type:'status.event',body:{serviceInstanceId:I,connectionId:'X'.repeat(22),snapshotSeq:6,eventSeq:6,generatedAt:5,status:status()}});assert.equal(s.closes.at(-1).code,1008);
});

test('maps reads, config allowlist, and lifecycle methods to one command each',async()=>{
  const h=harness(),s=h.sockets[0];s.open();h.welcome(s);
  async function round(method,args,type,response,body){const p=h.host[method](...(args||[]));const sent=s.sent.at(-1);assert.equal(sent.type,type);s.receive({v:1,type:response,requestId:sent.requestId,body});return p;}
  assert.equal((await round('getConfig',[],'config.get','config.result',{ok:true,config:{exists:true,config:cfg}})).config.sim,'2020');
  const saved=round('setConfig',[{serverUrl:'https://x',ingestToken:'SENTINEL_SECRET',certPath:'no',tokenSet:true}],'config.patch','config.result',{ok:true,config:{exists:true,config:cfg}});assert.deepEqual(s.sent.at(-1).body.patch,{serverUrl:'https://x',ingestToken:'SENTINEL_SECRET'});assert.equal(JSON.stringify(await saved).includes('SENTINEL_SECRET'),false);
  assert.equal(await round('getConfigPath',[],'config.path.get','config.path.result',{display:'Managed by MSFSLogger desktop'}),'Managed by MSFSLogger desktop');
  await round('getStatus',[],'state.get','state.full',{...full(C,I,2,2),status:null});
  for(const [m,t] of [['startUplink','uplink.start'],['stopUplink','uplink.stop'],['restartSidecar','sidecar.restart']])await round(m,[],t,'command.result',{ok:true,command:t,acceptedAt:2});
  await assert.rejects(h.host.setConfig({certPath:'x'}),/supported/);
});

test('reconnect uses bounded schedule, replaces state, and retries accepted action with stable id',async()=>{
  const h=harness(),s=h.sockets[0],seen=[];h.host.onStatus(v=>seen.push(v));s.open();h.welcome(s);const action=h.host.startUplink();const original=s.sent.at(-1);s.close(1006,'lost');assert.equal(h.timers.filter(t=>!t.off).at(-1).ms,0);h.timers.filter(t=>!t.off).at(-1).fn();const s2=h.sockets[1];s2.open();h.welcome(s2);const replay=s2.sent.find(x=>x.type==='uplink.start');assert.equal(replay.requestId,original.requestId);assert.equal(s2.sent.filter(x=>x.type==='uplink.start').length,1);s2.receive({v:1,type:'command.result',requestId:replay.requestId,body:{ok:true,command:'uplink.start',acceptedAt:3}});await action;assert.equal(seen.length,2);
  s2.close(1006,'again');const delays=h.timers.filter(t=>!t.off).map(t=>t.ms);assert.ok(delays.every(x=>x<=36000));
});

test('disconnected actions reject, malformed/oversized/auth failures close, teardown prevents reconnect',async()=>{
  const h=harness(),s=h.sockets[0];await assert.rejects(h.host.stopUplink(),/unavailable/);s.open();s.receive('{');assert.equal(s.closes.at(-1).code,1007);
  const a=harness(),as=a.sockets[0];as.open();as.receive({v:1,type:'error',requestId:as.sent[0].requestId,body:{code:'unauthorized',message:'Unauthorized',retryable:false}});assert.equal(a.store.has('msfslogger.gauge.pairing.v1'),false);
  const b=harness(),bs=b.sockets[0];bs.open();b.welcome(bs);bs.receive('x'.repeat(32769));assert.equal(bs.closes.at(-1).code,1009);b.window.msfsloggerGaugeHost.teardown();const count=b.sockets.length;b.timers.filter(t=>!t.off).forEach(t=>t.fn());assert.equal(b.sockets.length,count);
});

test('only pairing capability persists and unsubscribe works',()=>{
  const h=harness(),s=h.sockets[0],logs=[];assert.deepEqual([...h.store.keys()],['msfslogger.gauge.pairing.v1']);s.open();h.welcome(s);const off=h.host.onLog(v=>logs.push(v));off();s.receive({v:1,type:'log.event',body:{serviceInstanceId:I,connectionId:C,eventSeq:2,at:2,level:'info',message:'safe'}});assert.equal(logs.length,0);assert.equal(JSON.stringify([...h.store]).includes('SENTINEL_SECRET'),false);
});

test('unchanged bridge adopts the complete installed host contract',()=>{
  const h=harness();const context=vm.createContext({window:h.window,structuredClone,JSON,Set,Date,Promise});vm.runInContext(bridgeSource,context);const bridge=h.window.__TEST_BRIDGE__;assert.equal(bridge.hostLabel,'MSFS GAUGE');for(const name of ['getConfig','setConfig','getConfigPath','startUplink','stopUplink','restartSidecar','getStatus','onStatus','onLog','onExit'])assert.equal(typeof bridge[name],'function',name);
});

test('pairing sends the exact first request and persists only the returned capability',()=>{
  const h=harness(false),s=h.sockets[0];s.open();assert.ok(h.modal);h.modal._input.value='12345678';h.modal.firstChild.onsubmit({preventDefault(){}});const req=s.sent[0];assert.deepEqual(req.body,{code:'12345678',clientLabel:'MSFS CDU'});assert.equal(req.type,'pair.request');s.receive({v:1,type:'pair.result',requestId:req.requestId,body:{paired:true,capability:CAP,capabilityId:I}});assert.deepEqual([...h.store],[["msfslogger.gauge.pairing.v1",JSON.stringify({v:1,capability:CAP})]]);
});

test('a code entered after the auth window is held and sent first on a fresh connection',()=>{
  const h=harness(false),s=h.sockets[0];s.open();assert.ok(h.modal);
  h.modal._input.value='1234';h.modal.firstChild.onsubmit({preventDefault(){}});assert.equal(s.sent.length,0);
  h.timers.find(t=>!t.off&&t.ms===3000).fn();
  h.modal._input.value='87654321';h.modal.firstChild.onsubmit({preventDefault(){}});h.modal.firstChild.onsubmit({preventDefault(){}});
  assert.equal(s.sent.length,0);assert.deepEqual(s.closes,[{code:1000,reason:'Pairing'}]);
  assert.equal(h.sockets.length,2);const s2=h.sockets[1];s2.open();
  assert.equal(s2.sent.length,1);assert.equal(s2.sent[0].type,'pair.request');assert.deepEqual(s2.sent[0].body,{code:'87654321',clientLabel:'MSFS CDU'});
  h.modal.firstChild.onsubmit({preventDefault(){}});assert.equal(s2.sent.length,1);
  s2.receive({v:1,type:'pair.result',requestId:s2.sent[0].requestId,body:{paired:true,capability:CAP,capabilityId:I}});
  assert.equal(h.modal,null);assert.deepEqual([...h.store],[["msfslogger.gauge.pairing.v1",JSON.stringify({v:1,capability:CAP})]]);
});

test('an unanswered keepalive drops the link with a visible note and resume reconnects at once',()=>{
  const h=harness(),s=h.sockets[0],logs=[];h.host.onLog(v=>logs.push(v.message));s.open();h.welcome(s);
  assert.ok(logs.some(m=>m==='GAUGE LINK SYNCED (app.running)'));
  h.timers.find(t=>!t.off&&t.ms===25000).fn();assert.equal(s.sent.at(-1).type,'config.path.get');
  h.timers.find(t=>!t.off&&t.ms===9000).fn();assert.equal(s.closes.at(-1).code,4000);assert.ok(logs.includes('GAUGE LINK LOST (no response)'));
  assert.equal(h.sockets.length,1);h.window.msfsloggerGaugeHost.resume();assert.equal(h.sockets.length,2);
  h.window.msfsloggerGaugeHost.suspend();assert.equal(h.sockets.length,2);
});

test('double-click actions remain distinct and each retries once with its stable id on the same service instance',async()=>{
  const h=harness(),s=h.sockets[0];s.open();h.welcome(s);const a=h.host.startUplink(),b=h.host.startUplink(),sent=s.sent.slice(-2);assert.notEqual(sent[0].requestId,sent[1].requestId);s.close(1006,'lost');h.timers.find(t=>!t.off&&t.ms===0).fn();const s2=h.sockets[1],C2='EEEEEEEEEEEEEEEEEEEEEE';s2.open();h.welcome(s2,C2,I);for(const original of sent){const copies=s2.sent.filter(x=>x.type==='uplink.start'&&x.requestId===original.requestId);assert.equal(copies.length,1);s2.receive({v:1,type:'command.result',requestId:original.requestId,body:{ok:true,command:'uplink.start',acceptedAt:2}});}await Promise.all([a,b]);
});

test('a new service instance makes an accepted action uncertain without resending it',async()=>{
  const h=harness(),s=h.sockets[0],I2='DDDDDDDDDDDDDDDDDDDDDD',C2='EEEEEEEEEEEEEEEEEEEEEE';s.open();h.welcome(s);const action=h.host.stopUplink(),original=s.sent.at(-1);s.close(1006,'lost');h.timers.find(t=>!t.off&&t.ms===0).fn();const s2=h.sockets[1];s2.open();h.welcome(s2,C2,I2);await assert.rejects(action,/outcome uncertain/);assert.equal(s2.sent.some(x=>x.type==='uplink.stop'&&x.requestId===original.requestId),false);
});

test('strict schemas reject unknown keys, wrong bodies, bounds, identities, and sequence regressions',()=>{
  function rejected(mutator){const h=harness(),s=h.sockets[0];s.open();h.welcome(s);mutator(h,s);assert.equal(s.closes.at(-1).code,1008);}
  rejected((h,s)=>s.receive({v:1,type:'log.event',extra:true,body:{serviceInstanceId:I,connectionId:C,eventSeq:2,at:2,level:'info',message:'x'}}));
  rejected((h,s)=>s.receive({v:1,type:'log.event',body:{serviceInstanceId:I,connectionId:C,eventSeq:2,at:2,level:'debug',message:'x'}}));
  rejected((h,s)=>s.receive({v:1,type:'log.event',body:{serviceInstanceId:I,connectionId:C,eventSeq:2,at:2,level:'info',message:'x'.repeat(2049)}}));
  rejected((h,s)=>s.receive({v:2,type:'log.event',body:{serviceInstanceId:I,connectionId:C,eventSeq:2,at:2,level:'info',message:'x'}}));
  rejected((h,s)=>s.receive({v:1,type:'exit.event',body:{serviceInstanceId:I,connectionId:'X'.repeat(22),eventSeq:2,at:2,code:null,signal:null,restarting:false,restartsRemaining:0}}));
  rejected((h,s)=>s.receive({v:1,type:'status.event',body:{serviceInstanceId:I,connectionId:C,snapshotSeq:2,eventSeq:2,generatedAt:2,status:{...status(),app:{state:'app.running'}}}}));
  rejected((h,s)=>{const p=h.host.startUplink();const req=s.sent.at(-1);s.receive({v:1,type:'command.result',requestId:req.requestId,body:{ok:true,command:'uplink.start',acceptedAt:2,extra:true}});void p;});
});

test('accepted actions stop retrying at dedup expiry and surface uncertainty',async()=>{
  const h=harness(),s=h.sockets[0];s.open();h.welcome(s);const action=h.host.restartSidecar();const expiry=h.timers.find(t=>!t.off&&t.ms===600000);assert.ok(expiry);expiry.fn();await assert.rejects(action,/outcome uncertain/);s.close(1006,'lost');h.timers.filter(t=>!t.off&&t.ms===0).at(-1).fn();const s2=h.sockets[1];s2.open();h.welcome(s2);assert.equal(s2.sent.some(x=>x.type==='sidecar.restart'),false);
});

test('source has no autonomous ingest implementation',()=>{for(const forbidden of ['Sim'+'Var','simvar'+'.js','/api/'+'ingest','x-'+'ingest-token','FRAME'+'_PATH','EVENT'+'_PATH','root.'+'fetch'])assert.equal(source.includes(forbidden),false,forbidden);});
