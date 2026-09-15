import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {Rfc6455WebSocket} from './rfc6455-client.mjs';

let diagnosticStage='SETUP',lastMilestone='CREATED',diagnosticWritten=false;
function mark(value){lastMilestone=value;}
function fixedFailure(code='STAGE_FAILED'){if(diagnosticWritten)return;diagnosticWritten=true;process.stderr.write(JSON.stringify({status:'FAIL',stage:diagnosticStage,code,lastMilestone})+'\n');process.exitCode=1;}
process.on('uncaughtException',()=>fixedFailure('UNEXPECTED_FAILURE'));
process.on('unhandledRejection',()=>fixedFailure('UNEXPECTED_FAILURE'));

// Contract: one JSON object on stdin. Credentials and sentinels must never be
// supplied in argv/environment, and this process emits only a fixed PASS/FAIL.
const input=await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);process.stdin.on('end',()=>{try{resolve(JSON.parse(text));}catch{reject(new Error('invalid private input'));}});});
const endpoint=new URL(input.endpoint);
assert.equal(endpoint.protocol,'ws:');assert.equal(endpoint.hostname,'127.0.0.1');assert.notEqual(Number(endpoint.port),3000);assert.equal(endpoint.pathname,'/gauge-sync/v1');
assert.equal(typeof input.origin,'string');assert.equal(typeof input.sentinel,'string');assert.ok(input.sentinel.length>=12);

const sourceUrl=new URL('../.build/html_ui/Pages/VCockpit/Instruments/MSFSLoggerCDU/MSFSLoggerGaugeHost.js',import.meta.url);
let source;try{source=await readFile(sourceUrl,'utf8');}catch{source=await readFile(new URL('../src/MSFSLoggerGaugeHost.js',import.meta.url),'utf8');}
source=source.replace('ws://127.0.0.1:39091/gauge-sync/v1',endpoint.href);
assert.equal(source.includes(endpoint.href),true);

const store=new Map();
if(input.capability) store.set('msfslogger.gauge.pairing.v1',JSON.stringify({v:1,capability:input.capability}));
const sockets=[],wire=[],stateFullInstances=[];
class RealSocket{
  constructor(url){
    assert.equal(url,endpoint.href);this.inner=new Rfc6455WebSocket(url,{origin:input.origin,onMilestone:mark});sockets.push(this);
    this.inner.addEventListener('open',()=>this.onopen&&this.onopen());
    this.inner.addEventListener('message',event=>{wire.push(String(event.data));try{const message=JSON.parse(String(event.data)),type=message.type;if(type==='auth.result'||type==='pair.result')mark('AUTH_RESULT');else if(type==='session.welcome')mark('WELCOME');else if(type==='state.full'){stateFullInstances.push(message.body.serviceInstanceId);mark('STATE_FULL');}}catch{}this.onmessage&&this.onmessage({data:String(event.data)});});
    this.inner.addEventListener('close',event=>this.onclose&&this.onclose(event));
    this.inner.addEventListener('error',event=>this.onerror&&this.onerror(event));
  }
  get readyState(){return this.inner.readyState;}
  send(value){wire.push(String(value));try{const type=JSON.parse(String(value)).type;if(type==='auth.request'||type==='pair.request')mark('AUTH_SENT');}catch{}this.inner.send(value);}
  close(code,reason){this.inner.close(code,reason);}
}
const inputNode={value:''},form={onsubmit:null};
let modalNode=null;
const body={appendChild(node){node.parentNode=body;modalNode=node;if(input.pairingCode){queueMicrotask(()=>{inputNode.value=input.pairingCode;form.onsubmit({preventDefault(){}});});}},removeChild(node){node.parentNode=null;if(modalNode===node)modalNode=null;}};
const document={body,getElementById(id){return modalNode&&modalNode.id===id?modalNode:null;},createElement(){return {id:'',style:{},firstChild:form,parentNode:null,set innerHTML(_v){},getElementsByTagName(){return [inputNode];}};}};
const window={window:null,WebSocket:RealSocket,crypto:webcrypto,document,localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},setTimeout,clearTimeout};window.window=window;
vm.runInContext(source,vm.createContext({window,Promise,JSON,Object,Array,Boolean,Error,RegExp,Uint8Array,Uint32Array,Number,encodeURIComponent,unescape,isFinite,Math}));
const host=window.__FMC_HOST__,statuses=[];host.onStatus(value=>statuses.push(value));
const waitFor=async(check,ms=8000)=>{const until=Date.now()+ms;while(Date.now()<until){if(check())return;await new Promise(r=>setTimeout(r,20));}throw new Error('timed out');};
const requestId=n=>`E2E_NEGATIVE_${String(n).padStart(4,'0')}`;
function rawConnection(origin=input.origin){
  const messages=[];let closeEvent=null,errorSeen=false;
  const socket=new Rfc6455WebSocket(endpoint.href,{origin,onMilestone:mark});
  socket.addEventListener('message',event=>messages.push(String(event.data)));
  socket.addEventListener('close',event=>{closeEvent=event;});
  socket.addEventListener('error',()=>{errorSeen=true;});
  return {socket,messages,get closeEvent(){return closeEvent;},get errorSeen(){return errorSeen;}};
}
async function opened(connection){await waitFor(()=>connection.socket.readyState===1||connection.closeEvent||connection.errorSeen);assert.equal(connection.socket.readyState,1);}
async function closedOrErrored(connection){await waitFor(()=>connection.closeEvent||connection.errorSeen);}
async function authorizedRaw(){
  const connection=rawConnection();await opened(connection);
  const capability=JSON.parse(store.get('msfslogger.gauge.pairing.v1')).capability;
  connection.socket.send(JSON.stringify({v:1,type:'auth.request',requestId:requestId(0),body:{capability}}));
  await waitFor(()=>connection.messages.some(text=>{try{return JSON.parse(text).type==='state.full';}catch{return false;}}));
  return connection;
}
async function negativeMatrix(){
  diagnosticStage='INVALID_ORIGIN';
  const badOrigin=rawConnection(input.invalidOrigin);await closedOrErrored(badOrigin);

  diagnosticStage='INVALID_AUTH';
  const badAuth=rawConnection();await opened(badAuth);
  badAuth.socket.send(JSON.stringify({v:1,type:'auth.request',requestId:requestId(1),body:{capability:'x'.repeat(43)}}));
  await waitFor(()=>badAuth.messages.some(text=>text.includes('unauthorized')));await closedOrErrored(badAuth);

  diagnosticStage='UNSUPPORTED_VERSION';
  const version=await authorizedRaw();version.socket.send(JSON.stringify({v:2,type:'state.get',requestId:requestId(2),body:{}}));
  await waitFor(()=>version.messages.some(text=>text.includes('unsupported_version')));version.socket.close(1000,'done');await closedOrErrored(version);

  diagnosticStage='INVALID_SCHEMA';
  const schema=await authorizedRaw();schema.socket.send(JSON.stringify({v:1,type:'not.allowed',requestId:requestId(3),body:{}}));
  await waitFor(()=>schema.messages.some(text=>text.includes('unknown_type')));
  schema.socket.send('{');await waitFor(()=>schema.messages.some(text=>text.includes('invalid_request')));schema.socket.close(1000,'done');await closedOrErrored(schema);

  diagnosticStage='OVERSIZE';
  const oversized=await authorizedRaw();oversized.socket.send('x'.repeat(32769));await closedOrErrored(oversized);assert.ok(oversized.errorSeen||(oversized.closeEvent&&(oversized.closeEvent.code===1009||oversized.closeEvent.code===1006)));

  diagnosticStage='RATE_LIMIT';
  const rate=await authorizedRaw();for(let n=10;n<31;n++)rate.socket.send(JSON.stringify({v:1,type:'state.get',requestId:requestId(n),body:{}}));
  await waitFor(()=>rate.messages.some(text=>text.includes('rate_limited')));rate.socket.close(1000,'done');await closedOrErrored(rate);

  const all=[badOrigin,badAuth,version,schema,oversized,rate].flatMap(connection=>connection.messages);
  assert.equal(all.some(value=>value.includes(input.sentinel)),false);
}

try{
  diagnosticStage='CONNECT';
  await waitFor(()=>statuses.length>0);
  diagnosticStage='SNAPSHOT';
  const before=await host.getConfig(),status=await host.getStatus();
  assert.equal(JSON.stringify(before).includes(input.sentinel),false);assert.equal(JSON.stringify(status).includes(input.sentinel),false);
  assert.ok(status&&status.pause&&status.traffic);
  diagnosticStage='CONFIG_PATCH';
  const patch={...(input.patch||{})};delete patch.ingestToken;
  await host.setConfig(patch);
  diagnosticStage='CONTROLS';
  await host.startUplink();await host.stopUplink();await host.restartSidecar();
  await assert.rejects(host.setConfig({certPath:'forbidden'}));
  diagnosticStage='WAIT_ENDPOINT_RESTART';mark('WAIT_ENDPOINT_RESTART');
  const firstCount=sockets.length,firstStatuses=statuses.length,firstInstance=stateFullInstances.at(-1);assert.equal(typeof firstInstance,'string');
  await waitFor(()=>sockets.length>firstCount&&statuses.length>firstStatuses&&stateFullInstances.some(value=>value!==firstInstance),20000);
  diagnosticStage='ENDPOINT_RESTART_REPLAY';
  assert.notEqual(stateFullInstances.at(-1),firstInstance);
  const replay=await host.getStatus();assert.ok(replay&&replay.pause&&replay.traffic);
  diagnosticStage='PRIVACY_ASSERT';
  assert.equal(JSON.stringify([...store]).includes(input.sentinel),false);
  assert.equal(wire.some(value=>value.includes(input.sentinel)),false);
  window.msfsloggerGaugeHost.teardown();
  await waitFor(()=>sockets.at(-1).inner.readyState===3);
  diagnosticStage='NEGATIVE_MATRIX';
  assert.equal(typeof input.invalidOrigin,'string');await negativeMatrix();
  diagnosticStage='COMPLETE';diagnosticWritten=true;process.stdout.write(JSON.stringify({status:'PASS',stage:'COMPLETE',code:'OK',lastMilestone})+'\n');
}catch{
  try{window.msfsloggerGaugeHost.teardown();}catch{}
  fixedFailure(diagnosticStage==='CONNECT'?'CONNECT_TIMEOUT':diagnosticStage==='INVALID_ORIGIN'?'HANDSHAKE_REJECTED':diagnosticStage==='WAIT_ENDPOINT_RESTART'?'ENDPOINT_RESTART_TIMEOUT':diagnosticStage==='PRIVACY_ASSERT'?'PRIVACY_ASSERTION':'STAGE_FAILED');
}
