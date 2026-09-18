/* Development only. Loaded before the unchanged CDU module graph. */
(function () {
  'use strict';
  var listeners = { status: new Set(), log: new Set(), exit: new Set() };
  var config = { version: 1, serverUrl: 'http://mock.invalid', certPath: '', sim: '2020', autoUplink: false, trafficEnabled: true, trafficRadiusM: 40000, tokenSet: false, nodePath: null };
  var calls = [];
  var status;
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function subscribe(name, fn) { listeners[name].add(fn); return function () { listeners[name].delete(fn); }; }
  function scenario(name) {
    if (['stopped', 'online', 'retry', 'offline', 'unauthorized', 'paused', 'active-pause', 'crashed'].indexOf(name) < 0) throw new Error('Unknown scenario: ' + name);
    status = {
      app: { state: name === 'stopped' ? 'app.stopped' : name === 'crashed' ? 'app.crashed' : 'app.running' },
      sim: { state: name === 'stopped' ? 'sim.idle' : name === 'retry' ? 'sim.retry' : 'sim.connected', nextRetryAt: Date.now() + 10000 },
      backend: { state: name === 'stopped' ? 'net.idle' : name === 'offline' ? 'net.unreachable' : name === 'unauthorized' ? 'net.unauthorized' : 'net.ok' },
      pause: { state: name === 'paused' ? 'pause.full' : name === 'active-pause' ? 'pause.active' : 'pause.off', flags: name === 'paused' ? 1 : name === 'active-pause' ? 4 : 0 },
      traffic: { enabled: true, radiusM: 40000, lastBatchSize: 3 }
    };
    listeners.status.forEach(function (fn) { fn(clone(status)); });
    return clone(status);
  }
  function record(method) { calls.push({ method: method, at: Date.now() }); }
  scenario('stopped');

  // ── Datalink ──────────────────────────────────────────────────────────────
  // Texts the pages were prototyped against: a TAF that pages, a dispatch
  // release whose route is 900 characters, and a mixed flight thread.
  var FIXTURES = {
    "metar": "METAR EGLL 161250Z 24012KT 9999 FEW030 18/10 Q1012 NOSIG",
    "longTaf": "TAF EGLL 161058Z 1612/1718 24012KT 9999 FEW030 BKN045\n  TEMPO 1612/1616 25018G30KT 7000 -SHRA SCT020CB\n  BECMG 1616/1619 27010KT\n  PROB30 TEMPO 1619/1702 4000 RA BR BKN008 OVC015\n  BECMG 1702/1705 VRB03KT 3000 BR FEW004 BKN010\n  TEMPO 1705/1709 0800 FG VV002\n  BECMG 1709/1712 22008KT 9999 NSW SCT025\n  TEMPO 1712/1718 24015G25KT 6000 -RA BKN014",
    "shortTaf": "TAF EGLL 161058Z 1612/1718 24012KT 9999 FEW030",
    "route900": "EGLL MAXIT1F MAXIT UL9 W100A UN14 W101B UL612 W102C UM605 W103D UN862 W104E UL975 W105F UT420 W106G UM190 W107H UL9 W108I UN14 W109J UL612 W110K UM605 W111L UN862 W112M UL975 W113N UT420 W114O UM190 W115P UL9 W116Q UN14 W117R UL612 W118S UM605 W119T UN862 W120U UL975 W121V UT420 W122W UM190 W123X UL9 W124Y UN14 W125Z UL612 W126A UM605 W127B UN862 W128C UL975 W129D UT420 W130E UM190 W131F UL9 W132G UN14 W133H UL612 W134I UM605 W135J UN862 W136K UL975 W137L UT420 W138M UM190 W139N UL9 W140O UN14 W141P UL612 W142Q UM605 W143R UN862 W144S UL975 W145T UT420 W146U UM190 W147V UL9 W148W UN14 W149X UL612 W150Y UM605 W151Z UN862 W152A UL975 W153B UT420 W154C UM190 W155D UL9 W156E UN14 W157F UL612 W158G UM605 W159H UN862 W160I UL975 W161J UT420 W162K UM190 W163L UL9 W164M UN14 W165N UL612 W166O UM605 W167P UN862 W168Q UL975 W169R UT420 W170S UM190 W171T UL9 W172U UN14 W173V UL612 W174W UM605 W175X",
    "routeDispatchBody": "DISPATCH RELEASE\nFLT BAW123 EGLL-LFPG A320 G-EUUA\nSTD 1630Z  STA 1745Z\nROUTE EGLL MAXIT1F MAXIT UL9 W100A UN14 W101B UL612 W102C UM605 W103D UN862 W104E UL975 W105F UT420 W106G UM190 W107H UL9 W108I UN14 W109J UL612 W110K UM605 W111L UN862 W112M UL975 W113N UT420 W114O UM190 W115P UL9 W116Q UN14 W117R UL612 W118S UM605 W119T UN862 W120U UL975 W121V UT420 W122W UM190 W123X UL9 W124Y UN14 W125Z UL612 W126A UM605 W127B UN862 W128C UL975 W129D UT420 W130E UM190 W131F UL9 W132G UN14 W133H UL612 W134I UM605 W135J UN862 W136K UL975 W137L UT420 W138M UM190 W139N UL9 W140O UN14 W141P UL612 W142Q UM605 W143R UN862 W144S UL975 W145T UT420 W146U UM190 W147V UL9 W148W UN14 W149X UL612 W150Y UM605 W151Z UN862 W152A UL975 W153B UT420 W154C UM190 W155D UL9 W156E UN14 W157F UL612 W158G UM605 W159H UN862 W160I UL975 W161J UT420 W162K UM190 W163L UL9 W164M UN14 W165N UL612 W166O UM605 W167P UN862 W168Q UL975 W169R UT420 W170S UM190 W171T UL9 W172U UN14 W173V UL612 W174W UM605 W175X\nALTN LFPO  FL 350\nBLOCK FUEL 6200 KG  TRIP 3100 KG",
    "legThread": [
      {
        "seq": 0,
        "id": 11,
        "direction": "uplink",
        "category": "dispatch",
        "label": "DISPATCH RELEASE",
        "body": "DISPATCH RELEASE\nFLT BAW123 EGLL-LFPG A320 G-EUUA\nSTD 1630Z  STA 1745Z\nROUTE MAXIT1F MAXIT UL9 KONAN UL607 REDFA\nALTN LFPO  FL 350\nBLOCK FUEL 6200 KG  TRIP 3100 KG",
        "sentAt": "2026-09-16T12:20:01.000Z",
        "correlationId": null
      },
      {
        "seq": 1,
        "id": 12,
        "direction": "downlink",
        "category": "freetext",
        "label": "LOADSHEET REQUEST",
        "body": "LOADSHEET REQUEST",
        "sentAt": "2026-09-16T12:40:00.000Z",
        "correlationId": null
      },
      {
        "seq": 2,
        "id": 13,
        "direction": "uplink",
        "category": "dispatch",
        "label": "LOADSHEET",
        "body": "LOADSHEET EGLL-LFPG ILLUSTRATIVE\nZFW 56350 KG  TOW -----\nBLOCK FUEL 6200 KG",
        "sentAt": "2026-09-16T12:40:00.500Z",
        "correlationId": 12
      }
    ],
    "flightThread": [
      {
        "seq": 0,
        "id": 11,
        "direction": "uplink",
        "category": "dispatch",
        "label": "DISPATCH RELEASE",
        "body": "DISPATCH RELEASE\nFLT BAW123 EGLL-LFPG A320 G-EUUA\nSTD 1630Z  STA 1745Z\nROUTE MAXIT1F MAXIT UL9 KONAN UL607 REDFA\nALTN LFPO  FL 350\nBLOCK FUEL 6200 KG  TRIP 3100 KG",
        "sentAt": "2026-09-16T12:20:01.000Z",
        "correlationId": null
      },
      {
        "seq": 1,
        "id": 12,
        "direction": "downlink",
        "category": "freetext",
        "label": "LOADSHEET REQUEST",
        "body": "LOADSHEET REQUEST",
        "sentAt": "2026-09-16T12:40:00.000Z",
        "correlationId": null
      },
      {
        "seq": 2,
        "id": 13,
        "direction": "uplink",
        "category": "dispatch",
        "label": "LOADSHEET",
        "body": "LOADSHEET EGLL-LFPG ILLUSTRATIVE\nZFW 56350 KG  TOW -----\nBLOCK FUEL 6200 KG",
        "sentAt": "2026-09-16T12:40:00.500Z",
        "correlationId": 12
      },
      {
        "seq": 3,
        "id": 17,
        "direction": "downlink",
        "category": "freetext",
        "label": "GATE REQUEST",
        "body": "GATE REQUEST",
        "sentAt": "2026-09-16T14:32:07.113Z",
        "correlationId": null
      },
      {
        "seq": 4,
        "id": 18,
        "direction": "uplink",
        "category": "wx",
        "label": "METAR EGLL",
        "body": "METAR EGLL 161250Z 24012KT 9999 FEW030 18/10 Q1012 NOSIG",
        "sentAt": "2026-09-16T14:32:08.001Z",
        "correlationId": 17
      }
    ],
    "cannedFour": [
      {
        "id": "wx-request",
        "label": "WX REQUEST"
      },
      {
        "id": "gate-request",
        "label": "GATE REQUEST"
      },
      {
        "id": "request-pushback",
        "label": "REQUEST PUSHBACK"
      },
      {
        "id": "oceanic-clearance",
        "label": "OCEANIC CLEARANCE"
      }
    ],
    "sheetProjected": {
      "units": "kg",
      "blockFuel": 6200,
      "taxiFuel": 200,
      "takeoffFuel": 6000,
      "tripFuel": 3100,
      "payload": 13850,
      "payloadSource": "simbrief",
      "zeroFuelWeight": 56350,
      "zfwSource": "simbrief",
      "maxZeroFuelWeight": 62500,
      "dryOperatingWeight": 42500,
      "takeoffWeight": null
    }
  };
  var DATALINK_SCENARIOS = ['flight', 'leg', 'no-flight-plan', 'pre-upgrade', 'invalid-token', 'unreachable',
    'long-taf', 'long-route', 'no-dispatch', 'canned-four', 'wx-unavailable', 'sidecar-outdated'];
  var FAULTS = {
    'pre-upgrade': { state: 'dl.unavailable', error: { code: 'unavailable', httpStatus: 401, serverCode: null } },
    'invalid-token': { state: 'dl.token-invalid', error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' } },
    'unreachable': { state: 'dl.unreachable', error: { code: 'unreachable', httpStatus: null, serverCode: null } },
    'sidecar-outdated': { state: 'dl.sidecar-outdated', error: { code: 'sidecar-outdated', httpStatus: null, serverCode: null } }
  };
  var FLIGHT_SCOPE = { kind: 'flight', flightId: 92, plannedLegId: 12 };
  var LEG_SCOPE = { kind: 'leg', plannedLegId: 12, source: 'ground-session' };
  // Smaller than the sidecar's window, so the page's fetch loop has to ask more than once.
  var MOCK_WINDOW = 5;
  var datalinkListeners = new Set();
  var dl = { name: 'flight', epoch: 0, watching: false, scope: null, messages: null, loadsheets: 0, ownScope: null, ownMessages: null };
  // The prefiled leg the sidecar would hold after a successful SimBrief prefile.
  var simbrief = { name: 'configured', held: null, messages: null, delay: 0, latched: false };

  function envelope(result) { return { ok: true, result: result }; }
  function failure(code, httpStatus, serverCode) {
    return { ok: false, error: { code: code, httpStatus: httpStatus === undefined ? null : httpStatus, serverCode: serverCode || null } };
  }
  function fault() { return FAULTS[dl.name] ? { ok: false, error: clone(FAULTS[dl.name].error) } : null; }
  function isCount(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
  function isTarget(target) { return !!target && typeof target === 'object' && typeof target.kind === 'string' && isCount(target.id); }
  function cannedList() { return FIXTURES.cannedFour.slice(0, dl.name === 'canned-four' ? 4 : 3); }

  function datalinkState() {
    var at = Date.now();
    var faultEntry = FAULTS[dl.name];
    var messages = dl.messages;
    var state = {
      v: 1, type: 'datalink-state', at: at,
      state: faultEntry ? faultEntry.state : 'dl.ok',
      watching: dl.name === 'sidecar-outdated' ? false : dl.watching,
      httpStatus: faultEntry ? faultEntry.error.httpStatus : null,
      serverCode: faultEntry ? faultEntry.error.serverCode : null,
      lastOkAt: faultEntry ? null : at,
      lastErrorAt: faultEntry ? at : null,
      nextPollAt: null,
      scope: dl.scope ? clone(dl.scope) : null,
      thread: messages ? {
        epoch: dl.epoch, total: messages.length, firstSeq: 0,
        newestId: messages.length ? messages[messages.length - 1].id : null, droppedRows: 0
      } : null
    };
    // Present only while a leg is held, exactly as the sidecar publishes it.
    if (simbrief.held) state.prefiledLeg = clone(simbrief.held);
    return state;
  }
  function emitDatalink() {
    // A flight outranks a prefiled leg, and seeing one clears it.
    if (simbrief.held && dl.ownScope && dl.ownScope.kind === 'flight') holdLeg(null);
    var state = datalinkState();
    datalinkListeners.forEach(function (fn) { fn(clone(state)); });
    return state;
  }
  function recordDatalink(method, args) { calls.push({ method: method, args: clone(args), at: Date.now() }); }

  function loadDatalinkScenario(name) {
    if (DATALINK_SCENARIOS.indexOf(name) < 0) throw new Error('Unknown datalink scenario: ' + name);
    var fromFlight = ['flight', 'long-taf', 'canned-four', 'wx-unavailable'].indexOf(name) >= 0;
    var fromLeg = ['leg', 'long-route', 'no-dispatch'].indexOf(name) >= 0;
    dl.name = name;
    dl.epoch += 1;
    dl.loadsheets = 0;
    if (name === 'sidecar-outdated') dl.watching = false;
    dl.scope = fromFlight ? clone(FLIGHT_SCOPE) : fromLeg ? clone(LEG_SCOPE) : name === 'no-flight-plan' ? { kind: 'none' } : null;
    dl.messages = fromFlight ? clone(FIXTURES.flightThread) : fromLeg ? clone(FIXTURES.legThread) : null;
    if (name === 'long-taf') {
      dl.messages.push({ seq: 5, id: 19, direction: 'uplink', category: 'wx', label: 'TAF EGLL', body: FIXTURES.metar + '\n' + FIXTURES.longTaf, sentAt: '2026-09-16T14:40:02.000Z', correlationId: null });
    }
    if (name === 'long-route') dl.messages[0].body = FIXTURES.routeDispatchBody;
    dl.ownScope = dl.scope;
    dl.ownMessages = dl.messages;
  }
  /**
   * Hold `leg` (or nothing) and publish the scope the sidecar would: a held leg
   * outranks the scenario's own leg or its lack of one, but never a flight, and
   * a fault scenario has no scope at all. A scope change is a new thread epoch.
   */
  function holdLeg(leg) {
    var before = simbrief.held;
    simbrief.held = leg ? { plannedLegId: leg.plannedLegId, label: leg.label } : null;
    if (leg && (!before || before.plannedLegId !== leg.plannedLegId)) simbrief.messages = clone(FIXTURES.legThread);
    var applied = !!simbrief.held && !FAULTS[dl.name] && !!dl.ownScope && dl.ownScope.kind !== 'flight';
    var scope = applied ? { kind: 'leg', plannedLegId: simbrief.held.plannedLegId, source: 'prefile' } : dl.ownScope;
    var messages = applied ? simbrief.messages : dl.ownMessages;
    if (messages !== dl.messages || JSON.stringify(scope) !== JSON.stringify(dl.scope)) dl.epoch += 1;
    dl.scope = scope;
    dl.messages = messages;
  }
  function appendMessage(direction, category, label, body, correlationId) {
    var id = dl.messages.reduce(function (max, m) { return Math.max(max, m.id); }, 0) + 1;
    var message = { seq: dl.messages.length, id: id, direction: direction, category: category, label: label, body: body, sentAt: new Date().toISOString(), correlationId: correlationId };
    dl.messages.push(message);
    return message;
  }

  loadDatalinkScenario('flight');

  var datalinkHost = {
    getDatalinkState: async function () { recordDatalink('getDatalinkState', []); return datalinkState(); },
    onDatalink: function (fn) {
      recordDatalink('onDatalink', []);
      datalinkListeners.add(fn);
      return function () { datalinkListeners.delete(fn); };
    },
    watchDatalink: async function (on) {
      recordDatalink('watchDatalink', [on]);
      if (dl.name === 'sidecar-outdated') return fault();
      dl.watching = on === true;
      emitDatalink();
      return envelope({ watching: dl.watching, leaseMs: 65000 });
    },
    refreshDatalink: async function () {
      recordDatalink('refreshDatalink', []);
      if (dl.name === 'invalid-token' || dl.name === 'sidecar-outdated') return fault();
      emitDatalink();
      return envelope({ accepted: true, coalesced: false });
    },
    getDatalinkThread: async function (req) {
      recordDatalink('getDatalinkThread', [req]);
      if (!dl.messages) return failure('no-thread');
      if (!req || typeof req !== 'object' || !isCount(req.epoch) || !isCount(req.endSeq)) return failure('bad-request');
      if (req.epoch !== dl.epoch) return failure('stale-epoch');
      if (req.endSeq > dl.messages.length) return failure('bad-request');
      var startSeq = Math.max(0, req.endSeq - MOCK_WINDOW);
      return envelope({
        epoch: dl.epoch, total: dl.messages.length, firstSeq: 0, startSeq: startSeq, endSeq: req.endSeq,
        messages: clone(dl.messages.slice(startSeq, req.endSeq))
      });
    },
    getCannedMessages: async function () {
      recordDatalink('getCannedMessages', []);
      return fault() || envelope({ messages: clone(cannedList()), truncated: false });
    },
    sendCannedMessage: async function (req) {
      recordDatalink('sendCannedMessage', [req]);
      var failed = fault();
      if (failed) return failed;
      if (!req || typeof req !== 'object' || !isTarget(req.target) || typeof req.cannedId !== 'string') return failure('bad-request');
      if (dl.name === 'no-flight-plan') return failure('leg-not-found', 404, 'PLANNED_LEG_NOT_FOUND');
      var entry = cannedList().filter(function (item) { return item.id === req.cannedId; })[0];
      if (!entry) return failure('unknown-canned-message', 400, 'UNKNOWN_CANNED_MESSAGE');
      if (dl.messages) {
        appendMessage('downlink', 'freetext', entry.label, entry.label, null);
        emitDatalink();
      }
      return envelope({ sent: true, httpStatus: 201 });
    },
    requestWeather: async function (req) {
      recordDatalink('requestWeather', [req]);
      var failed = fault();
      if (failed) return failed;
      if (!req || typeof req !== 'object' || !isTarget(req.target) || typeof req.icao !== 'string') return failure('bad-request');
      var icao = req.icao;
      var result = dl.name === 'wx-unavailable'
        ? { icao: icao, available: false, metar: null, taf: null, fetchedAt: null }
        : { icao: icao, available: true, metar: FIXTURES.metar, taf: dl.name === 'long-taf' ? FIXTURES.longTaf : FIXTURES.shortTaf, fetchedAt: new Date().toISOString() };
      if (dl.messages) {
        var request = appendMessage('downlink', 'wx', 'WX REQUEST ' + icao, 'WX REQUEST ' + icao, null);
        appendMessage('uplink', 'wx', 'WX ' + icao, result.available ? result.metar + '\n' + result.taf : 'NO WX ' + icao, request.id);
        emitDatalink();
      }
      return envelope(result);
    },
    requestLoadsheet: async function (req) {
      recordDatalink('requestLoadsheet', [req]);
      var failed = fault();
      if (failed) return failed;
      if (!req || typeof req !== 'object' || !isCount(req.plannedLegId)) return failure('bad-request');
      if (dl.name === 'no-dispatch') return failure('no-dispatch-data', 409, 'NO_DISPATCH_DATA');
      dl.loadsheets += 1;
      var created = dl.loadsheets === 1;
      return envelope({ plannedLegId: req.plannedLegId, created: created, httpStatus: created ? 201 : 200, sheet: clone(FIXTURES.sheetProjected) });
    }
  };

  // ── SimBrief ──────────────────────────────────────────────────────────────
  // What getSimbriefSettings, prefileSimbrief and clearPrefiledLeg answer in
  // each preview scenario. A clear of 'held' is the normal behaviour: it says
  // whether a leg was held and drops it. None of the three takes an argument.
  var SAMPLE_LABEL = 'KJFK \u2192 EGLL (BAW178)';
  var LONG_LABEL = 'SBGR \u2192 LFPG (TAP084 S\u00e3o Paulo\u2013Paris Ext)';
  var CONFIGURED = envelope({ configured: true });
  function prefiled(status, plannedLegId, label, warningCount) {
    return envelope({ status: status, plannedLegId: plannedLegId, label: label, warningCount: warningCount, httpStatus: status === 'imported' ? 201 : 200 });
  }
  function answers(settings, prefile, clear) { return { settings: settings, prefile: prefile, clear: clear || 'held' }; }
  function refused(code, httpStatus, serverCode) { return answers(failure(code, httpStatus, serverCode), failure(code, httpStatus, serverCode)); }
  function refusedAll(code) { return answers(failure(code), failure(code), failure(code)); }
  var SIMBRIEF_SCENARIOS = {
    'configured': answers(CONFIGURED, prefiled('imported', 4812, SAMPLE_LABEL, 0)),
    'not-configured': answers(envelope({ configured: false }), failure('simbrief-no-user-id', 400, 'NO_USER_ID')),
    'duplicate': answers(CONFIGURED, prefiled('duplicate', 4812, SAMPLE_LABEL, 0)),
    'long-label': answers(CONFIGURED, prefiled('imported', 4813, LONG_LABEL, 2)),
    'prefiled': answers(CONFIGURED, prefiled('duplicate', 4812, SAMPLE_LABEL, 0)),
    'no-user-id': answers(CONFIGURED, failure('simbrief-no-user-id', 400, 'NO_USER_ID')),
    'unknown-user': answers(CONFIGURED, failure('simbrief-unknown-user', 400, 'UNKNOWN_USER')),
    'no-plan': answers(CONFIGURED, failure('simbrief-no-plan', 404, 'NO_PLAN')),
    'simbrief-timeout': answers(CONFIGURED, failure('simbrief-timeout', 504, 'TIMEOUT')),
    'network': answers(CONFIGURED, failure('simbrief-network', 502, 'NETWORK')),
    'bad-status': answers(CONFIGURED, failure('simbrief-bad-status', 502, 'BAD_STATUS')),
    'bad-body': answers(CONFIGURED, failure('simbrief-bad-body', 502, 'BAD_BODY')),
    'db-error': answers(CONFIGURED, failure('simbrief-db-error', 500, 'DB_ERROR')),
    'unknown-code': answers(CONFIGURED, failure('http-error', 409, 'SOMETHING_NEW')),
    'invalid-token': refused('token-invalid', 401, 'INVALID_INGEST_TOKEN'),
    'token-missing': refused('token-missing', 401),
    'unavailable': refused('simbrief-unavailable', 401),
    'rejected': refused('rejected', 403),
    'bad-response': answers(failure('bad-response', 200), failure('bad-response', 201)),
    'tls-error': refused('tls-error'),
    'unreachable': refused('unreachable'),
    'client-timeout': refused('timeout'),
    'relay-timeout': refused('shell-timeout'),
    'no-config': refused('no-config'),
    'in-progress': answers(CONFIGURED, failure('prefile-in-progress')),
    'busy': refusedAll('busy'),
    'sidecar-exited': refused('sidecar-exited'),
    'sidecar-unavailable': refusedAll('sidecar-unavailable'),
    'sidecar-outdated': refusedAll('sidecar-outdated'),
    'not-supported': refusedAll('host-unsupported')
  };
  SIMBRIEF_SCENARIOS.prefiled.initialPrefiledLeg = { plannedLegId: 4812, label: SAMPLE_LABEL };

  function simbriefAnswers() { return SIMBRIEF_SCENARIOS[simbrief.name]; }
  // The server's rejected-token answer latches the sidecar, which clears the
  // prefiled leg and turns the datalink to INGEST TOKEN REJECTED.
  function latchOnFirstCall() {
    if (simbrief.name !== 'invalid-token' || simbrief.latched) return;
    simbrief.latched = true;
    loadDatalinkScenario('invalid-token');
    holdLeg(null);
    emitDatalink();
  }

  var simbriefHost = {
    getSimbriefSettings: async function () {
      recordDatalink('getSimbriefSettings', Array.prototype.slice.call(arguments));
      latchOnFirstCall();
      return clone(simbriefAnswers().settings);
    },
    prefileSimbrief: function () {
      recordDatalink('prefileSimbrief', Array.prototype.slice.call(arguments));
      latchOnFirstCall();
      var answer = clone(simbriefAnswers().prefile);
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (answer.ok) {
            holdLeg({ plannedLegId: answer.result.plannedLegId, label: answer.result.label });
            emitDatalink();
          }
          resolve(answer);
        }, simbrief.delay);
      });
    },
    clearPrefiledLeg: async function () {
      recordDatalink('clearPrefiledLeg', Array.prototype.slice.call(arguments));
      var clear = simbriefAnswers().clear;
      if (clear !== 'held') return clone(clear);
      var held = simbrief.held !== null;
      if (held) {
        holdLeg(null);
        emitDatalink();
      }
      return envelope({ cleared: held });
    }
  };
  // ── Clearance ─────────────────────────────────────────────────────────────
  // What requestClearance answers in each preview scenario. An ok answer is for
  // the leg that was asked for, and the first one for the leg the thread shows
  // adds the request and the PDC reply to it, as the server's rows would.
  // "reject" makes the call itself fail. The serverError members stand in for
  // server text that no page may show. Nothing but requestClearance asks for a
  // clearance, and only the invalid-token and leg-not-found answers change the
  // datalink state, the way the sidecar's latch and dropped prefiled leg do.
  var CLEARANCE_SCENARIOS = {
    "_note": "Envelope requestClearance resolves in each scenario. For ok envelopes the mock replaces result.plannedLegId with the requested id. \"reject\" means the promise rejects (host-error through runDatalink). serverError members are sentinels the pages must never show.",
    "_default": "created",
    "created": {
      "ok": true,
      "result": {
        "plannedLegId": 12,
        "created": true,
        "departure": "KJFK",
        "destination": "EGLL",
        "route": "GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI UN514 NUMPO BOGNA1H",
        "initialAltitudeFt": 5000,
        "squawk": "4521",
        "httpStatus": 201
      }
    },
    "not-created": {
      "ok": true,
      "result": {
        "plannedLegId": 12,
        "created": false,
        "departure": "KJFK",
        "destination": "EGLL",
        "route": "GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI UN514 NUMPO BOGNA1H",
        "initialAltitudeFt": 5000,
        "squawk": "4521",
        "httpStatus": 200
      }
    },
    "long-route": {
      "ok": true,
      "result": {
        "plannedLegId": 12,
        "created": true,
        "departure": "KJFK",
        "destination": "EGLL",
        "route": "GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONAN UL607 REDFA 5530N02000W M626 SUNOT GREKI DCT MARTN N251A JOOPY NATW GISTI UN514 NUMPO L9 KONANX",
        "initialAltitudeFt": 5000,
        "squawk": "4521",
        "httpStatus": 201
      }
    },
    "null-route-and-icaos": {
      "ok": true,
      "result": {
        "plannedLegId": 12,
        "created": true,
        "departure": null,
        "destination": null,
        "route": null,
        "initialAltitudeFt": 5000,
        "squawk": "4521",
        "httpStatus": 201
      }
    },
    "fl-altitude": {
      "ok": true,
      "result": {
        "plannedLegId": 12,
        "created": true,
        "departure": "KJFK",
        "destination": "EGLL",
        "route": "GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI UN514 NUMPO BOGNA1H",
        "initialAltitudeFt": 18000,
        "squawk": "4521",
        "httpStatus": 201
      }
    },
    "ft-altitude": {
      "ok": true,
      "result": {
        "plannedLegId": 12,
        "created": true,
        "departure": "KJFK",
        "destination": "EGLL",
        "route": "GREKI DCT MARTN DCT EBONY N251A JOOPY NATW GISTI UN514 NUMPO BOGNA1H",
        "initialAltitudeFt": 4500,
        "squawk": "4521",
        "httpStatus": 201
      }
    },
    "leg-not-found": {
      "ok": false,
      "error": {
        "code": "leg-not-found",
        "httpStatus": 404,
        "serverCode": "PLANNED_LEG_NOT_FOUND",
        "serverError": "SENTINEL-SERVER-ERROR-TEXT-DO-NOT-SHOW Planned leg 12 not found"
      }
    },
    "no-flight-plan": {
      "ok": false,
      "error": {
        "code": "clearance-no-flight-plan",
        "httpStatus": 409,
        "serverCode": "NO_FLIGHT_PLAN",
        "serverError": "SENTINEL-SERVER-ERROR-TEXT-DO-NOT-SHOW NO FLIGHT PLAN ON FILE"
      }
    },
    "invalid-token": {
      "ok": false,
      "error": {
        "code": "token-invalid",
        "httpStatus": 401,
        "serverCode": "INVALID_INGEST_TOKEN"
      }
    },
    "token-missing": {
      "ok": false,
      "error": {
        "code": "token-missing",
        "httpStatus": 401,
        "serverCode": null
      }
    },
    "unavailable": {
      "ok": false,
      "error": {
        "code": "clearance-unavailable",
        "httpStatus": 401,
        "serverCode": null
      }
    },
    "rejected": {
      "ok": false,
      "error": {
        "code": "rejected",
        "httpStatus": 403,
        "serverCode": "CROSS_ORIGIN"
      }
    },
    "http-error": {
      "ok": false,
      "error": {
        "code": "http-error",
        "httpStatus": 500,
        "serverCode": null
      }
    },
    "unknown-code": {
      "ok": false,
      "error": {
        "code": "some-future-code",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "bad-response": {
      "ok": false,
      "error": {
        "code": "bad-response",
        "httpStatus": 201,
        "serverCode": null
      }
    },
    "too-large": {
      "ok": false,
      "error": {
        "code": "too-large",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "unreachable": {
      "ok": false,
      "error": {
        "code": "unreachable",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "tls-error": {
      "ok": false,
      "error": {
        "code": "tls-error",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "client-timeout": {
      "ok": false,
      "error": {
        "code": "timeout",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "relay-timeout": {
      "ok": false,
      "error": {
        "code": "shell-timeout",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "busy": {
      "ok": false,
      "error": {
        "code": "busy",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "in-progress": {
      "ok": false,
      "error": {
        "code": "clearance-in-progress",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "no-config": {
      "ok": false,
      "error": {
        "code": "no-config",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "sidecar-exited": {
      "ok": false,
      "error": {
        "code": "sidecar-exited",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "sidecar-unavailable": {
      "ok": false,
      "error": {
        "code": "sidecar-unavailable",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "sidecar-outdated": {
      "ok": false,
      "error": {
        "code": "sidecar-outdated",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "not-supported": {
      "ok": false,
      "error": {
        "code": "host-unsupported",
        "httpStatus": null,
        "serverCode": null
      }
    },
    "host-error": "reject"
  };
  var clearance = { name: CLEARANCE_SCENARIOS._default, delay: 0, latched: false };

  function clearanceNames() {
    return Object.keys(CLEARANCE_SCENARIOS).filter(function (name) { return name.charAt(0) !== '_'; });
  }
  function isLegId(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1; }
  // The server's reply body is its own text; the pages draw the structured result instead.
  function serverAltitude(ft) { return ft >= 18000 ? 'FL' + Math.round(ft / 100) : ft + 'FT'; }
  function orDashes(value) { return value === null ? '----' : value; }
  function appendClearancePair(result) {
    if (!dl.messages || !dl.scope || (dl.scope.kind !== 'flight' && dl.scope.kind !== 'leg')) return;
    if (dl.scope.plannedLegId !== result.plannedLegId) return;
    var issued = dl.messages.some(function (m) { return m.category === 'pdc' && m.label === 'PDC'; });
    if (issued) return;
    var request = appendMessage('downlink', 'pdc', 'REQUEST CLEARANCE', 'REQUEST CLEARANCE', null);
    appendMessage('uplink', 'pdc', 'PDC', [
      'PDC',
      orDashes(result.departure) + ' TO ' + orDashes(result.destination),
      'CLEARED VIA ' + orDashes(result.route),
      'CLIMB AND MAINTAIN ' + serverAltitude(result.initialAltitudeFt),
      'SQUAWK ' + result.squawk,
      'SIMULATED CLEARANCE - NOT FOR REAL WORLD USE'
    ].join('\n'), request.id);
    emitDatalink();
  }

  var clearanceHost = {
    requestClearance: function (req) {
      recordDatalink('requestClearance', [req]);
      if (!req || typeof req !== 'object' || Array.isArray(req) || !isLegId(req.plannedLegId)) {
        return Promise.resolve(failure('bad-request'));
      }
      var plannedLegId = req.plannedLegId;
      var name = clearance.name;
      if (name === 'invalid-token' && !clearance.latched) {
        clearance.latched = true;
        loadDatalinkScenario('invalid-token');
        holdLeg(null);
        emitDatalink();
      }
      var answer = CLEARANCE_SCENARIOS[name];
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (answer === 'reject') { reject(new Error('mock host fault')); return; }
          var answered = clone(answer);
          if (answered.ok) {
            answered.result.plannedLegId = plannedLegId;
            appendClearancePair(answered.result);
          } else if (name === 'leg-not-found' && simbrief.held && simbrief.held.plannedLegId === plannedLegId) {
            holdLeg(null);
            emitDatalink();
          }
          resolve(answered);
        }, clearance.delay);
      });
    }
  };
  // ── SayIntentions ─────────────────────────────────────────────────────────
  // What the five SayIntentions methods answer in each preview scenario. The
  // API key itself is never here and never travels: the server holds it, and the
  // panel is told only whether one is on file.
  //
  // An "ok" scenario carries a small link model, so LINK, UNLINK and IMPORT move
  // the state the next status read answers with, the way the server's rows
  // would. An error scenario answers all five methods with the same failure.
  // "reject" makes the call itself fail (host-error through runDatalink). Every
  // error carries a serverError sentinel: the sidecar forwards a code, an HTTP
  // status and a server code and never the server's prose, so a page that showed
  // one of these strings would be showing something it was never given.
  var SI_SESSION = 'si-7f3a91c4';
  var SI_LINKED_AT = '2026-09-16T14:05:11.000Z';
  var SI_LAST_IMPORT_AT = '2026-09-16T14:31:52.000Z';
  // Four display lines at 48 columns, within the 144 units the server caps at.
  var SI_PDC_TEXT = 'PDC SWA1451 KJFK TO EGLL\nCLEARED VIA GREKI MARTN EBONY JOOPY\nCLIMB AND MAINTAIN 5000FT SQUAWK 4521\nSIMULATED - NOT FOR REAL WORLD USE';
  // Imported comms as the server files them: a category and no label at all.
  var SI_ATC_BODIES = [
    'SWA1451 KENNEDY GROUND TAXI TO RUNWAY 04L VIA ALPHA',
    'SWA1451 KENNEDY TOWER CLEARED FOR TAKEOFF RUNWAY 04L',
    'SWA1451 CONTACT DEPARTURE 124.750',
    'SWA1451 CLIMB AND MAINTAIN FLIGHT LEVEL 230',
    'SWA1451 PROCEED DIRECT GREKI'
  ];
  var SI_PROSE = 'SENTINEL-SERVER-ERROR-TEXT-DO-NOT-SHOW';
  function siError(code, httpStatus, serverCode) {
    return { error: { code: code, httpStatus: httpStatus, serverCode: serverCode, serverError: SI_PROSE + ' ' + (serverCode || code) } };
  }
  function siLocal(code) { return siError(code, null, null); }
  function siLink(importedCount, lastImportAt) {
    return {
      upstreamFlightId: SI_SESSION, sinceId: 4821, baselineCommId: 4800,
      linkedAt: SI_LINKED_AT, lastImportAt: lastImportAt, importedCount: importedCount
    };
  }
  var SAYINTENTIONS_SCENARIOS = {
    "_note": "Answers for getSayIntentionsStatus, linkSayIntentions, unlinkSayIntentions, importSayIntentionsComms and sendSayIntentionsPdc. An ok scenario keeps a link model the three actions move; an error scenario answers all five the same way. serverError members are sentinels the pages must never show.",
    "_default": "linked",
    "no-key": { apiKeySet: false },
    "key-not-linked": { apiKeySet: true },
    "linked": { apiKeySet: true, linked: true, importedCount: 12, lastImport: SI_LAST_IMPORT_AT, imported: 2 },
    // Unlinked, so LINK creates one; NOW or SESSION START is the operator's
    // choice on the page, and the recorded call is where it shows.
    "link-from-now": { apiKeySet: true },
    "import-none": { apiKeySet: true, linked: true, importedCount: 12, lastImport: SI_LAST_IMPORT_AT, imported: 0 },
    "import-rows": { apiKeySet: true, linked: true, importedCount: 12, lastImport: SI_LAST_IMPORT_AT, imported: 4, skipped: 1 },
    "pdc-sent": { apiKeySet: true, linked: true, importedCount: 12, lastImport: SI_LAST_IMPORT_AT },
    // The scope refusal is the page's, not the host's: the scenario puts the
    // datalink in leg scope, where the rule refuses and nothing is asked.
    "leg-scope": { apiKeySet: true, datalink: "leg" },
    "no-api-key": siError('si-no-api-key', 409, 'NO_API_KEY'),
    "bad-api-key": siError('si-bad-api-key', 409, 'BAD_API_KEY'),
    "not-linked": siError('si-not-linked', 409, 'NOT_LINKED'),
    "session-changed": siError('si-session-changed', 409, 'SESSION_CHANGED'),
    "no-comms": siError('si-no-comms', 409, 'NO_COMMS_TO_LINK'),
    "no-active-session": siError('si-no-session', 409, 'NO_ACTIVE_SESSION'),
    "no-clearance": siError('si-no-clearance', 409, 'NO_CLEARANCE'),
    "upstream-unreachable": siError('si-upstream-unreachable', 502, 'UPSTREAM_UNREACHABLE'),
    "upstream-timeout": siError('si-upstream-timeout', 504, 'UPSTREAM_TIMEOUT'),
    "upstream-error": siError('si-upstream-error', 502, 'UPSTREAM_ERROR'),
    "upstream-bad-body": siError('si-upstream-bad-body', 502, 'UPSTREAM_BAD_BODY'),
    "flight-not-found": siError('flight-not-found', 404, 'FLIGHT_NOT_FOUND'),
    "leg-not-found": siError('leg-not-found', 404, 'PLANNED_LEG_NOT_FOUND'),
    "invalid-id": siError('invalid-id', 400, 'INVALID_ID'),
    "invalid-token": siError('token-invalid', 401, 'INVALID_INGEST_TOKEN'),
    "token-missing": siError('token-missing', 401, null),
    "unavailable": siError('sayintentions-unavailable', 401, null),
    "rejected": siError('rejected', 403, 'CROSS_ORIGIN'),
    "http-error": siError('http-error', 500, null),
    "unknown-code": siError('some-future-code', null, null),
    "bad-response": siError('bad-response', 201, null),
    "too-large": siLocal('too-large'),
    "client-timeout": siLocal('timeout'),
    "relay-timeout": siLocal('shell-timeout'),
    "tls-error": siLocal('tls-error'),
    "unreachable": siLocal('unreachable'),
    "no-config": siLocal('no-config'),
    "in-progress": siLocal('sayintentions-in-progress'),
    "bad-params": siLocal('bad-request'),
    "busy": siLocal('busy'),
    "sidecar-exited": siLocal('sidecar-exited'),
    "sidecar-unavailable": siLocal('sidecar-unavailable'),
    "sidecar-outdated": siLocal('sidecar-outdated'),
    "unsupported-host": siLocal('host-unsupported'),
    "host-error": "reject"
  };
  var si = { name: SAYINTENTIONS_SCENARIOS._default, delay: 0, latched: false, apiKeySet: true, link: null };

  function sayIntentionsNames() {
    return Object.keys(SAYINTENTIONS_SCENARIOS).filter(function (name) { return name.charAt(0) !== '_'; });
  }
  /** Take the scenario's key and link state as the state the server holds now. */
  function loadSayIntentionsScenario(name) {
    var entry = SAYINTENTIONS_SCENARIOS[name];
    var answers = entry !== 'reject' && !entry.error;
    si.name = name;
    si.latched = false;
    si.apiKeySet = answers ? entry.apiKeySet === true : true;
    si.link = answers && entry.linked ? siLink(entry.importedCount || 0, entry.lastImport || null) : null;
    return answers ? entry : null;
  }
  function siEntry() { return SAYINTENTIONS_SCENARIOS[si.name]; }
  function isRequest(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function isFlightId(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1; }
  // The server's rejected-token answer latches the sidecar, which clears the
  // prefiled leg and turns the datalink to INGEST TOKEN REJECTED.
  function siLatch() {
    if (si.name !== 'invalid-token' || si.latched) return;
    si.latched = true;
    loadDatalinkScenario('invalid-token');
    holdLeg(null);
    emitDatalink();
  }
  /** The server's own answer to an op that needs a key it has not been given. */
  function siServerRefusal(name) { return { ok: false, error: clone(SAYINTENTIONS_SCENARIOS[name].error) }; }
  /** The scenario's failure, or null when it answers. */
  function siFailure() {
    var entry = siEntry();
    return entry !== 'reject' && entry.error ? { ok: false, error: clone(entry.error) } : null;
  }
  /** Every SayIntentions answer takes this path: the latch, the delay, then `build`. */
  function siAnswer(build) {
    var entry = siEntry();
    siLatch();
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (entry === 'reject') { reject(new Error('mock host fault')); return; }
        resolve(siFailure() || build());
      }, si.delay);
    });
  }
  function appendAtcMessages(count) {
    for (var i = 0; i < count; i += 1) {
      appendMessage('downlink', 'atc', null, SI_ATC_BODIES[i % SI_ATC_BODIES.length], null);
    }
  }

  loadSayIntentionsScenario(si.name);

  var sayIntentionsHost = {
    getSayIntentionsStatus: function (req) {
      recordDatalink('getSayIntentionsStatus', [req]);
      // The flight id is the question, not an option: a number asks whether that
      // flight is linked, an explicit null asks whether a key is on file at all.
      // A missing or undefined key is refused rather than read as null, because
      // only the caller knows which of the two questions it meant to ask, and an
      // omitted key reaches an installed host as an undefined one.
      if (!isRequest(req) || !(req.flightId === null || isFlightId(req.flightId))) {
        return Promise.resolve(failure('bad-request'));
      }
      var flightId = req.flightId;
      return siAnswer(function () {
        if (flightId === null) {
          return envelope({ answered: 'settings', flightId: null, apiKeySet: si.apiKeySet, linked: null, link: null, httpStatus: 200 });
        }
        return envelope({
          answered: 'link', flightId: flightId, apiKeySet: si.apiKeySet,
          linked: si.link !== null, link: si.link ? clone(si.link) : null, httpStatus: 200
        });
      });
    },
    linkSayIntentions: function (req) {
      recordDatalink('linkSayIntentions', [req]);
      if (!isRequest(req) || !isFlightId(req.flightId) || (req.from !== 'now' && req.from !== 'session-start')) {
        return Promise.resolve(failure('bad-request'));
      }
      var flightId = req.flightId;
      var from = req.from;
      return siAnswer(function () {
        // Every one of these three reaches SayIntentions, so the server refuses
        // them outright until a key is on file.
        if (!si.apiKeySet) return siServerRefusal('no-api-key');
        // A re-link rebinds the same session and is a success of its own.
        var created = si.link === null;
        si.link = created ? siLink(0, null) : clone(si.link);
        return envelope({
          flightId: flightId, created: created,
          // FROM NOW starts at the present, so nothing is waiting behind it.
          pendingMessages: from === 'now' ? 0 : 3,
          link: clone(si.link), httpStatus: created ? 201 : 200
        });
      });
    },
    unlinkSayIntentions: function (req) {
      recordDatalink('unlinkSayIntentions', [req]);
      if (!isRequest(req) || !isFlightId(req.flightId)) return Promise.resolve(failure('bad-request'));
      var flightId = req.flightId;
      return siAnswer(function () {
        // Removing a link that was not there is still a success.
        var unlinked = si.link !== null;
        si.link = null;
        return envelope({ flightId: flightId, unlinked: unlinked, httpStatus: 200 });
      });
    },
    importSayIntentionsComms: function (req) {
      recordDatalink('importSayIntentionsComms', [req]);
      if (!isRequest(req) || !isFlightId(req.flightId)) return Promise.resolve(failure('bad-request'));
      var flightId = req.flightId;
      return siAnswer(function () {
        if (!si.apiKeySet) return siServerRefusal('no-api-key');
        if (si.link === null) return siServerRefusal('not-linked');
        var entry = siEntry();
        var imported = entry.imported || 0;
        var skipped = entry.skipped || 0;
        si.link = siLink(si.link.importedCount + imported, new Date().toISOString());
        // The rows land in the flight's own ACARS thread, which the CDU already
        // reads; there is no second message store for them.
        if (imported > 0 && dl.messages) {
          appendAtcMessages(imported);
          emitDatalink();
        }
        return envelope({
          flightId: flightId, imported: imported, alreadySeen: 0, skipped: skipped,
          sinceId: 5001, httpStatus: imported > 0 ? 201 : 200
        });
      });
    },
    sendSayIntentionsPdc: function (req) {
      recordDatalink('sendSayIntentionsPdc', [req]);
      if (!isRequest(req) || !isLegId(req.plannedLegId)) return Promise.resolve(failure('bad-request'));
      var plannedLegId = req.plannedLegId;
      // The row is written against the planned leg upstream, so nothing is added
      // to the flight's thread here: what was sent comes back as sentText.
      return siAnswer(function () {
        if (!si.apiKeySet) return siServerRefusal('no-api-key');
        return envelope({ plannedLegId: plannedLegId, sentText: SI_PDC_TEXT, httpStatus: 201 });
      });
    }
  };

  // Kept only to notice a changed token, as the sidecar does; never returned or recorded.
  var ingestToken = null;

  var host = {
    hostLabel: 'GAUGE MOCK',
    getConfig: async function () { return { exists: true, path: 'memory://gauge-dev', config: clone(config), raw: clone(config) }; },
    setConfig: async function (patch) {
      record('setConfig');
      var serverChanged = 'serverUrl' in patch && patch.serverUrl !== config.serverUrl;
      var tokenChanged = typeof patch.ingestToken === 'string' && patch.ingestToken !== ingestToken;
      Object.keys(config).forEach(function (key) { if (key in patch) config[key] = patch[key]; });
      if (typeof patch.ingestToken === 'string') {
        config.tokenSet = !!patch.ingestToken.trim();
        ingestToken = patch.ingestToken;
      }
      // A different server or token may not know the held prefiled leg.
      if ((serverChanged || tokenChanged) && simbrief.held) { holdLeg(null); emitDatalink(); }
      // A saved config is what clears the sidecar's rejected-token latch.
      if (dl.name === 'invalid-token') { loadDatalinkScenario('flight'); emitDatalink(); }
      return { ok: true, path: 'memory://gauge-dev' };
    },
    getConfigPath: async function () { return 'memory://gauge-dev'; },
    getStatus: async function () { return clone(status); },
    startUplink: async function () { record('startUplink'); scenario('online'); },
    stopUplink: async function () { record('stopUplink'); scenario('stopped'); },
    restartSidecar: async function () { record('restartSidecar'); scenario('stopped'); },
    onStatus: function (fn) { return subscribe('status', fn); },
    onLog: function (fn) { return subscribe('log', fn); },
    onExit: function (fn) { return subscribe('exit', fn); }
  };
  Object.keys(datalinkHost).forEach(function (name) { host[name] = datalinkHost[name]; });
  Object.keys(simbriefHost).forEach(function (name) { host[name] = simbriefHost[name]; });
  Object.keys(clearanceHost).forEach(function (name) { host[name] = clearanceHost[name]; });
  Object.keys(sayIntentionsHost).forEach(function (name) { host[name] = sayIntentionsHost[name]; });
  window.__FMC_HOST__ = host;
  window.gaugeDev = {
    scenario: scenario, calls: calls,
    // A new datalink scenario stands in for a sidecar restart, which forgets the prefiled leg.
    datalinkScenario: function (name) { loadDatalinkScenario(name); holdLeg(null); return clone(emitDatalink()); },
    simbriefScenario: function (name) {
      if (!Object.prototype.hasOwnProperty.call(SIMBRIEF_SCENARIOS, name)) throw new Error('Unknown simbrief scenario: ' + name);
      simbrief.name = name;
      simbrief.latched = false;
      holdLeg(SIMBRIEF_SCENARIOS[name].initialPrefiledLeg || null);
      emitDatalink();
      return name;
    },
    setSimbriefDelay: function (ms) { simbrief.delay = Math.max(0, Number(ms) || 0); return simbrief.delay; },
    clearanceScenario: function (name) {
      if (clearanceNames().indexOf(name) < 0) throw new Error('Unknown clearance scenario: ' + name);
      clearance.name = name;
      clearance.latched = false;
      return name;
    },
    setClearanceDelay: function (ms) { clearance.delay = Math.max(0, Number(ms) || 0); return clearance.delay; },
    sayIntentionsScenario: function (name) {
      if (sayIntentionsNames().indexOf(name) < 0) throw new Error('Unknown sayintentions scenario: ' + name);
      var entry = loadSayIntentionsScenario(name);
      if (entry && entry.datalink) {
        loadDatalinkScenario(entry.datalink);
        holdLeg(null);
        emitDatalink();
      }
      return name;
    },
    setSayIntentionsDelay: function (ms) { si.delay = Math.max(0, Number(ms) || 0); return si.delay; },
    emitLog: function (message) { listeners.log.forEach(function (fn) { fn({ level: 'info', message: message }); }); },
    emitExit: function () { scenario('crashed'); listeners.exit.forEach(function (fn) { fn({ code: 1 }); }); }
  };
}());
