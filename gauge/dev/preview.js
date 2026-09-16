const frame = document.getElementById('gauge');
const scenario = document.getElementById('scenario');
function applyScenario() { frame.contentWindow.gaugeDev.scenario(scenario.value); }
frame.addEventListener('load', applyScenario);
scenario.addEventListener('change', applyScenario);
const datalinkScenario = document.getElementById('datalink-scenario');
function applyDatalinkScenario() { frame.contentWindow.gaugeDev.datalinkScenario(datalinkScenario.value); }
frame.addEventListener('load', applyDatalinkScenario);
datalinkScenario.addEventListener('change', applyDatalinkScenario);
document.getElementById('size').addEventListener('change', event => { frame.style.width = event.target.value + 'px'; });
document.getElementById('reload').addEventListener('click', () => frame.contentWindow.location.reload());
let revision;
async function poll() {
  try {
    const response = await fetch('/__revision');
    if (!response.ok) throw new Error('Server unavailable');
    const next = await response.text();
    if (revision && revision !== next && document.getElementById('auto').checked) location.reload();
    revision = next;
    document.getElementById('connection').textContent = '';
  } catch { document.getElementById('connection').textContent = 'Development server disconnected'; }
  setTimeout(poll, 1000);
}
poll();
