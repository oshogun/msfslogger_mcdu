import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

function environment(stored) {
  const values=new Map(stored ? [['msfslogger.cdu.config.v1',JSON.stringify(stored)]] : []), requests=[];
  let interval;
  const window={
    localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
    SimVar:{GetSimVarValue:(name)=>({ 'PLANE LATITUDE':-23.5,'PLANE LONGITUDE':-46.6,'PLANE ALTITUDE':5000,'AIRSPEED INDICATED':123,'GROUND VELOCITY':130,'PLANE HEADING DEGREES TRUE':270,'VERTICAL SPEED':-500,'SIM ON GROUND':0,'IS SLEW ACTIVE':0,TITLE:'Test Aircraft' })[name]},
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,status:200};},
    setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{interval=null;},setTimeout:fn=>{fn();return 2;}
  };
  window.window=window;
  return {context:vm.createContext({window}),window,requests,tick:()=>interval&&interval()};
}

test('reads SimVars, stores config locally, and posts the existing ingest contract',async()=>{
  const env=environment();
  vm.runInContext(await readFile(new URL('../src/MSFSLoggerGaugeHost.js',import.meta.url),'utf8'),env.context);
  const host=env.window.__FMC_HOST__;
  await assert.rejects(host.startUplink(),/required/);
  await host.setConfig({serverUrl:'http://logger.test:3000/',ingestToken:'secret'});
  const shown=await host.getConfig();
  assert.equal(shown.config.tokenSet,true); assert.ok(!JSON.stringify(shown).includes('secret'));
  await host.startUplink(); await new Promise(setImmediate); env.tick(); await new Promise(setImmediate);
  assert.equal(env.requests[0].url,'http://logger.test:3000/api/ingest/event');
  assert.equal(env.requests[1].url,'http://logger.test:3000/api/ingest/frame');
  const frame=JSON.parse(env.requests[1].options.body);
  assert.equal(frame.lat,-23.5); assert.equal(frame.aircraft,'Test Aircraft'); assert.equal(frame.simRunning,2);
  assert.equal(env.requests[1].options.headers['x-ingest-token'],'secret');
  assert.equal((await host.getStatus()).backend.state,'net.ok');
  await host.stopUplink(); await new Promise(setImmediate);
  assert.equal(env.requests.at(-1).url,'http://logger.test:3000/api/ingest/event');
});

test('auto uplink starts from persisted configuration',async()=>{
  const env=environment({serverUrl:'http://logger.test',ingestToken:'token',autoUplink:true});
  vm.runInContext(await readFile(new URL('../src/MSFSLoggerGaugeHost.js',import.meta.url),'utf8'),env.context);
  await new Promise(setImmediate);
  assert.equal((await env.window.__FMC_HOST__.getStatus()).app.state,'app.running');
  assert.equal(env.requests.length,1);
});
