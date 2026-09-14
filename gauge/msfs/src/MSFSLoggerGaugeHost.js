(function (root) {
  'use strict';
  if (typeof root.Coherent === 'undefined' && root.parent && root.parent.Coherent) root.Coherent = root.parent.Coherent;
  if (typeof root.Include === 'undefined' && root.parent && root.parent.Include) root.Include = root.parent.Include;
  if (typeof root.RegisterViewListener === 'undefined' && root.parent && root.parent.RegisterViewListener) root.RegisterViewListener = root.parent.RegisterViewListener;
  if (root.Element && !root.Element.prototype.replaceChildren) {
    root.Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i=0;i<arguments.length;i+=1) this.appendChild(arguments[i] && arguments[i].nodeType ? arguments[i] : root.document.createTextNode(String(arguments[i])));
    };
  }
  if (root.parent && typeof root.parent.SimVar === 'undefined') {
    var simvarScript=root.parent.document.createElement('script'); simvarScript.src='/JS/simvar.js'; root.parent.document.head.appendChild(simvarScript);
  }
  var STORAGE_KEY = 'msfslogger.cdu.config.v1';
  var FRAME_PATH = '/api/ingest/frame';
  var EVENT_PATH = '/api/ingest/event';
  var listeners = { status: [], log: [], exit: [] };
  var running = false, timer = null, posting = false;
  var config = loadConfig();
  var status = makeStatus('app.stopped', 'sim.idle', 'net.idle');

  function defaults() { return { version:1, serverUrl:'', ingestToken:'', certPath:null, trafficEnabled:false, trafficRadiusM:40000, sim:'2020', autoUplink:false, nodePath:null }; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function loadConfig() {
    try { return Object.assign(defaults(), JSON.parse(root.localStorage.getItem(STORAGE_KEY) || '{}')); }
    catch (_) { return defaults(); }
  }
  function saveConfig() { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); }
  function redacted() { var value = clone(config); delete value.ingestToken; value.tokenSet = Boolean(config.ingestToken); return value; }
  function makeStatus(app, sim, backend) {
    return { v:1, type:'status', at:Date.now(), app:{ state:app, running:running, problems:[] }, sim:{ state:sim, attempt:0, nextRetryAt:null, retryDelayMs:null, protocol:'HTML GAUGE', appName:'MSFS', appVersion:null, lastError:null }, backend:{ state:backend, httpStatus:null, lastOkAt:null, lastErrorAt:null, message:null }, pause:{ state:'pause.off', flags:0, label:'unavailable', usingPauseEx1:false }, traffic:{ enabled:false, radiusM:config.trafficRadiusM, lastSweepAt:null, lastBatchSize:null, lastError:'Traffic unavailable in HTML gauge' }, config:{ path:'localStorage://' + STORAGE_KEY } };
  }
  function emit(kind, value) { listeners[kind].slice().forEach(function (fn) { try { fn(clone(value)); } catch (_) {} }); }
  function publish() { status.at = Date.now(); emit('status', status); }
  function log(level, message) { emit('log', { v:1, type:'log', at:Date.now(), level:level, message:message }); }
  function subscribe(kind, fn) { listeners[kind].push(fn); return function () { var i=listeners[kind].indexOf(fn); if(i>=0) listeners[kind].splice(i,1); }; }
  function sim(name, unit, fallback) {
    try { var api = root.parent && root.parent.SimVar ? root.parent.SimVar : root.SimVar; var value = api.GetSimVarValue(name, unit); return value === undefined || value === null ? fallback : value; }
    catch (_) { return fallback; }
  }
  function frame() {
    return { lat:Number(sim('PLANE LATITUDE','degrees',0)), lon:Number(sim('PLANE LONGITUDE','degrees',0)), altitudeFt:Number(sim('PLANE ALTITUDE','feet',0)), airspeedKnots:Number(sim('AIRSPEED INDICATED','knots',0)), groundSpeedKnots:Number(sim('GROUND VELOCITY','knots',0)), headingDeg:Number(sim('PLANE HEADING DEGREES TRUE','degrees',0)), verticalSpeedFpm:Number(sim('VERTICAL SPEED','feet per minute',0)), onGround:Boolean(sim('SIM ON GROUND','bool',0)), simRunning:sim('IS SLEW ACTIVE','bool',0) ? 3 : 2, aircraft:String(sim('TITLE','string','Unknown')) };
  }
  function request(path, method, body) {
    var options = { method:method, headers:{ 'x-ingest-token':config.ingestToken } };
    if (body !== undefined) { options.headers['content-type']='application/json'; options.body=JSON.stringify(body); }
    return root.fetch(config.serverUrl.replace(/\/+$/, '') + path, options).then(function (res) {
      status.backend.httpStatus = res.status;
      if (res.ok) { status.backend.state = path === '/api/status' ? 'net.standby' : 'net.ok'; status.backend.lastOkAt=Date.now(); status.backend.message=null; }
      else { status.backend.state = res.status === 401 ? 'net.unauthorized' : 'net.http-error'; status.backend.lastErrorAt=Date.now(); status.backend.message='HTTP '+res.status; }
      return res;
    }).catch(function (error) { status.backend.state='net.unreachable'; status.backend.lastErrorAt=Date.now(); status.backend.message=String(error && error.message || error); throw error; });
  }
  function tick() {
    if (!running || posting || !config.serverUrl || !config.ingestToken) return;
    posting=true; status.sim.state = (root.parent && root.parent.SimVar) || root.SimVar ? 'sim.connected' : 'sim.retry';
    request(FRAME_PATH, 'POST', frame()).catch(function () {}).then(function () { posting=false; publish(); });
  }
  function start() {
    if (running) return Promise.resolve();
    if (!config.serverUrl || !config.ingestToken) { status=makeStatus('app.no-config','sim.idle','net.idle'); publish(); return Promise.reject(new Error('Server URL and ingest token are required')); }
    running=true; status=makeStatus('app.running', (root.parent && root.parent.SimVar) || root.SimVar ? 'sim.connected':'sim.retry', 'net.pending'); publish();
    timer=root.setInterval(tick,1000);
    request(EVENT_PATH,'POST',{type:'connected'}).catch(function () {}).then(function(){ publish(); });
    return Promise.resolve();
  }
  function stop() {
    var wasRunning=running; running=false; if(timer){root.clearInterval(timer);timer=null;} posting=false;
    status=makeStatus('app.stopped','sim.idle','net.idle'); publish();
    if(wasRunning && config.serverUrl && config.ingestToken) request(EVENT_PATH,'POST',{type:'disconnected'}).catch(function(){});
    return Promise.resolve();
  }
  var host = {
    hostLabel:'MSFS GAUGE',
    getConfig:function(){var safe=redacted();return Promise.resolve({exists:Boolean(config.serverUrl&&config.ingestToken),path:'localStorage://'+STORAGE_KEY,config:safe,raw:safe});},
    setConfig:function(patch){ Object.keys(defaults()).forEach(function(key){if(Object.prototype.hasOwnProperty.call(patch,key)) config[key]=patch[key];}); config.trafficEnabled=false; saveConfig(); if(running){stop();start();} return Promise.resolve({ok:true,path:'localStorage://'+STORAGE_KEY}); },
    getConfigPath:function(){return Promise.resolve('localStorage://'+STORAGE_KEY);}, startUplink:start, stopUplink:stop,
    restartSidecar:function(){return stop().then(start);}, getStatus:function(){return Promise.resolve(clone(status));},
    onStatus:function(fn){var off=subscribe('status',fn);fn(clone(status));return off;}, onLog:function(fn){return subscribe('log',fn);}, onExit:function(fn){return subscribe('exit',fn);}
  };
  root.__FMC_HOST__=host;
  root.msfsloggerGaugeHost={ host:host, frame:frame, suspend:function(){ if(timer){root.clearInterval(timer);timer=null;} }, resume:function(){if(running&&!timer)timer=root.setInterval(tick,1000);}, reset:function(){return stop().then(function(){root.localStorage.removeItem(STORAGE_KEY);config=defaults();});} };
  if(config.autoUplink) root.setTimeout(function(){start().catch(function(e){log('error',e.message);});},0);
}(window));
