// Diagnostic probe for the gauge link. Runs the real gauge host over a real
// WebSocket against a gauge service backed by a real Supervisor and sidecar,
// pairs with a one-time code, and reports what the gauge accepted and why any
// connection closed. Driven by the ignored Rust test
// `live_supervisor_sidecar_stack_keeps_gauge_synchronized`.
//
// Input: one JSON object on stdin: {endpoint, origin, code, seconds}.
// Output: one JSON report on stdout. The stored capability is never printed.
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {Rfc6455WebSocket} from './rfc6455-client.mjs';

const input=await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>text+=v);process.stdin.on('end',()=>{try{resolve(JSON.parse(text));}catch{reject(new Error('invalid input'));}});});
const endpoint=new URL(input.endpoint);
let source=await readFile(new URL('../src/MSFSLoggerGaugeHost.js',import.meta.url),'utf8');
source=source.replace('ws://127.0.0.1:39091/gauge-sync/v1',endpoint.href);

const started=Date.now();
const elapsed=()=>Date.now()-started;
const cap=(list,item,max=60)=>{if(list.length<max)list.push(item);};
const report={connections:0,received:{},sequence:[],serverCloses:[],gaugeCloses:[],statuses:[],logs:[],exits:[],boot:{}};

class RealSocket{
  constructor(url){
    report.connections++;
    this.inner=new Rfc6455WebSocket(url,{origin:input.origin});
    this.inner.addEventListener('open',()=>this.onopen&&this.onopen());
    this.inner.addEventListener('message',event=>{
      const text=String(event.data);
      try{
        const m=JSON.parse(text);
        report.received[m.type]=(report.received[m.type]||0)+1;
        if(m.body&&typeof m.body.eventSeq==='number')cap(report.sequence,[elapsed(),m.type,m.body.eventSeq,m.body.snapshotSeq??null,m.requestId?'response':'push'],200);
        if(m.type==='error')cap(report.logs,{at:elapsed(),serverError:m.body&&m.body.code});
      }catch{report.received.unparseable=(report.received.unparseable||0)+1;}
      this.onmessage&&this.onmessage({data:text});
    });
    this.inner.addEventListener('close',event=>{cap(report.serverCloses,{at:elapsed(),code:event.code,reason:event.reason});this.onclose&&this.onclose(event);});
    this.inner.addEventListener('error',event=>this.onerror&&this.onerror(event));
  }
  get readyState(){return this.inner.readyState;}
  send(value){this.inner.send(value);}
  close(code,reason){cap(report.gaugeCloses,{at:elapsed(),code,reason});this.inner.close(code,reason);}
}

const store=new Map();
const inputNode={value:''},form={onsubmit:null};
let modalNode=null;
const body={appendChild(node){node.parentNode=body;modalNode=node;queueMicrotask(()=>{inputNode.value=input.code;form.onsubmit({preventDefault(){}});});},removeChild(node){node.parentNode=null;if(modalNode===node)modalNode=null;}};
const document={body,getElementById(id){return modalNode&&modalNode.id===id?modalNode:null;},createElement(){return {id:'',style:{},firstChild:form,parentNode:null,set innerHTML(_v){},getElementsByTagName(){return [inputNode];}};}};
const window={window:null,WebSocket:RealSocket,crypto:webcrypto,document,localStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},setTimeout,clearTimeout};
window.window=window;
vm.runInContext(source,vm.createContext({window,Promise,JSON,Object,Array,Boolean,Error,RegExp,Uint8Array,Uint32Array,Number,encodeURIComponent,unescape,isFinite,Math,String}));

const host=window.__FMC_HOST__;
host.onStatus(s=>cap(report.statuses,{at:elapsed(),app:s.app&&s.app.state,sim:s.sim&&s.sim.state,backend:s.backend&&s.backend.state,pause:s.pause&&s.pause.state,traffic:s.traffic}));
host.onLog(l=>cap(report.logs,{at:elapsed(),level:l.level,message:String(l.message).slice(0,120)}));
host.onExit(e=>cap(report.exits,{at:elapsed(),code:e.code,restarting:e.restarting}));

// The shell makes these calls at boot, before the link is ready.
const settle=(name,promise)=>promise.then(v=>{report.boot[name]={ok:true,at:elapsed(),kind:typeof v==='object'&&v!==null?Object.keys(v).sort().join(','):String(v).slice(0,60)};},e=>{report.boot[name]={ok:false,at:elapsed(),error:String(e&&e.message).slice(0,80)};});
settle('getConfig',host.getConfig());
settle('getConfigPath',host.getConfigPath());
settle('getStatus',host.getStatus());

await new Promise(resolve=>setTimeout(resolve,Math.max(5,Number(input.seconds)||45)*1000));
await settle('finalGetStatus',host.getStatus());
report.paired=store.has('msfslogger.gauge.pairing.v1');
window.msfsloggerGaugeHost.teardown();
process.stdout.write(JSON.stringify(report)+'\n');
setTimeout(()=>process.exit(0),200);
