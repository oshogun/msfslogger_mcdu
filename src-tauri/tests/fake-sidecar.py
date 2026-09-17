"""No network or simulator: process-lifecycle fixture for the Rust supervisor."""
import json
import os
from pathlib import Path
import sys
import threading
import time

config_path = Path(sys.argv[-1])
config = json.loads(config_path.read_text()) if config_path.exists() else {}
with config_path.with_name('starts').open('a') as log:
    log.write(str(os.getpid()) + '\n')

emit_lock = threading.Lock()

def emit(value):
    with emit_lock:
        print(json.dumps(value), flush=True)

# datalinkMode: answer (default), answer-error, ignore, no-features (a sidecar
# that predates the datalink), no-simbrief (a sidecar with the datalink but
# without SimBrief; otherwise answer), slow-prefile (answers simbrief-prefile
# after prefileDelayMs, every other op at once), echo-token, exit-on-request
# or wrong-id.
datalink_mode = config.get('datalinkMode', 'answer')
hello = dict(v=1, type='hello', at=1, pid=os.getpid(), sidecarVersion='fixture',
             nodeVersion='fixture', configPath=str(config_path))
if datalink_mode == 'no-simbrief':
    hello['features'] = ['datalink']
elif datalink_mode != 'no-features':
    hello['features'] = ['datalink', 'simbrief-prefile']
emit(hello)

def datalink_state(state, **members):
    value = dict(v=1, type='datalink-state', at=1, state=state, watching=False, httpStatus=None,
                 serverCode=None, lastOkAt=None, lastErrorAt=None, nextPollAt=None, scope=None,
                 thread=None)
    value.update(members)
    return value

if datalink_mode != 'no-features':
    emit(datalink_state('dl.idle'))
if config.get('fixtureMode') == 'crash':
    sys.exit(21)
if config.get('fixtureMode') == 'stalled':
    time.sleep(60)
    sys.exit(0)

# The sidecar decides what its config means and says so; the fixture keeps a
# crude version of that judgement only so the supervisor has a state to
# forward which it could not have computed for itself.
problems = []
if not config_path.exists():
    idle_state = 'app.no-config'
elif not str(config.get('serverUrl', '')).startswith(('http://', 'https://')):
    problems.append(dict(field='serverUrl', message='serverUrl must be an http(s) URL'))
    idle_state = 'app.error-config'
elif not str(config.get('ingestToken', '')).strip():
    problems.append(dict(field='ingestToken', message='ingestToken is required'))
    idle_state = 'app.error-config'
else:
    idle_state = 'app.stopped'

status = dict(v=1, type='status', at=1, app=dict(state=idle_state, problems=problems),
              sim=dict(state='sim.idle'), backend=dict(state='net.idle'),
              pause=dict(state='pause.off'), traffic={}, config=None)
token = config.get('ingestToken')
if token:
    print('{broken ' + token, flush=True)
    emit(dict(v=1, type='log', at=1, level='warn', message='redact ' + token))
    print('redact ' + token, file=sys.stderr, flush=True)
emit(status)
for line in sys.stdin:
    control = json.loads(line)
    with config_path.with_name('controls').open('a') as log:
        log.write(control['type'] + '\n')
    if control['type'] == 'shutdown':
        break
    if control['type'] == 'datalink-request':
        # One line per request the shell wrote, so a re-sent line is visible.
        with config_path.with_name('datalink-ops').open('a') as log:
            log.write(control['op'] + '\n')
        if datalink_mode == 'exit-on-request':
            sys.exit(3)
        response = dict(v=1, type='datalink-response', at=1, id=control['id'], ok=True,
                        result=dict(echo=control['op']))
        state = datalink_state('dl.ok', watching=True, lastOkAt=1)
        if datalink_mode == 'answer-error':
            response = dict(v=1, type='datalink-response', at=1, id=control['id'], ok=False,
                            error=dict(code='no-dispatch-data', httpStatus=409,
                                       serverCode='NO_DISPATCH_DATA'))
            state = datalink_state('dl.unavailable', watching=True, httpStatus=401, lastErrorAt=1)
        elif datalink_mode == 'echo-token':
            response['result']['note'] = 'token ' + str(token)
            state['scope'] = dict(kind='flight', flightId=1, note=token)
        elif datalink_mode == 'wrong-id':
            response['id'] = 'dl-999999'
        if datalink_mode == 'slow-prefile' and control['op'] == 'simbrief-prefile':
            def answer_late(response=response, state=state):
                emit(response)
                emit(state)
            timer = threading.Timer(config.get('prefileDelayMs', 1500) / 1000, answer_late)
            timer.daemon = True
            timer.start()
        elif datalink_mode not in ('ignore', 'no-features'):
            emit(response)
            emit(state)
        continue
    if control['type'] == 'start':
        # Mirrors the sidecar: START is refused while the config is unusable.
        if idle_state == 'app.stopped':
            status['app']['state'] = 'app.running'
    elif control['type'] == 'stop':
        status['app']['state'] = idle_state
    emit(status)
