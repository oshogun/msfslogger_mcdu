"""No network or simulator: process-lifecycle fixture for the Rust supervisor."""
import json
import os
from pathlib import Path
import sys
import time

config_path = Path(sys.argv[-1])
config = json.loads(config_path.read_text()) if config_path.exists() else {}
with config_path.with_name('starts').open('a') as log:
    log.write(str(os.getpid()) + '\n')

def emit(value):
    print(json.dumps(value), flush=True)

emit(dict(v=1, type='hello', at=1, pid=os.getpid(), sidecarVersion='fixture',
          nodeVersion='fixture', configPath=str(config_path)))
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
    if control['type'] == 'start':
        # Mirrors the sidecar: START is refused while the config is unusable.
        if idle_state == 'app.stopped':
            status['app']['state'] = 'app.running'
    elif control['type'] == 'stop':
        status['app']['state'] = idle_state
    emit(status)
