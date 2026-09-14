// The three CFG pages. A shared draft keeps edits across them. Existing
// credentials stay in the shell: an untouched token is omitted from the patch
// so the writer preserves it.
//
// Import rule for this directory: a page reaches the outside world only through
// the page interface it is handed — `register` at load time, `ctx.fmc` inside a
// callback — plus `../status.js` and sibling page modules. It may not import or
// name the host adapter, read a global for the interface, or subscribe to host
// events; the shell owns all three. That is why the same page code will run
// unchanged on a host this build has never seen.
let fmc = null;
const DEFAULTS = { version: 1, serverUrl: '', certPath: null, sim: '2020',
  autoUplink: false, trafficEnabled: true, trafficRadiusM: 40000, tokenSet: false };
const FIELDS = {
  NETWORK: ['serverUrl', 'ingestToken', 'certPath'],
  SIM: ['sim', 'autoUplink'],
  TRAFFIC: ['trafficEnabled', 'trafficRadiusM'],
};
let draft;
let pendingToken;
let saving = false;
const edited = new Set();
const invalid = new Map();

function validate(field, value) {
  const fail = (message = 'INVALID ENTRY') => ({ ok: false, message });
  switch (field) {
    case 'serverUrl': {
      if (typeof value !== 'string' || !value.trim()) return fail();
      try {
        const url = new URL(value.trim());
        if (!['http:', 'https:'].includes(url.protocol)) return fail();
        return { ok: true, value: value.trim().replace(/\/+$/, '') };
      } catch { return fail(); }
    }
    case 'ingestToken':
      return typeof value === 'string' && value.trim()
        ? { ok: true, value: value.trim() } : fail();
    case 'certPath':
      // Only the sidecar can check file readability on the Windows host.
      return value == null || typeof value === 'string'
        ? { ok: true, value: value?.trim() || null } : fail();
    case 'sim':
      return typeof value === 'string' && ['2020', '2024', 'fsx'].includes(value.trim().toLowerCase())
        ? { ok: true, value: value.trim().toLowerCase() } : fail();
    case 'autoUplink':
      if (typeof value === 'boolean') return { ok: true, value };
      if (typeof value === 'string' && ['on', 'off', 'true', 'false'].includes(value.trim().toLowerCase())) {
        return { ok: true, value: ['on', 'true'].includes(value.trim().toLowerCase()) };
      }
      return fail();
    case 'trafficEnabled':
      return { ok: true, value: !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase()) };
    case 'trafficRadiusM': {
      if (value == null) return { ok: true, value: 40000 };
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: true, value: 40000, warning: 'USING DEFAULT 40000' };
      const rounded = Math.round(n);
      if (rounded < 1000 || rounded > 200000) return fail('ENTRY OUT OF RANGE');
      return { ok: true, value: rounded };
    }
    default: return fail();
  }
}

function ensureDraft() {
  if (draft) return;
  draft = { ...DEFAULTS, ...fmc.getConfigCache() };
  // Optional values in hand-edited files use the loader's defaults.
  for (const key of ['sim', 'autoUplink', 'trafficEnabled', 'trafficRadiusM']) {
    if (draft[key] === undefined) draft[key] = DEFAULTS[key];
  }
  draft.trafficEnabled = validate('trafficEnabled', draft.trafficEnabled).value;
  draft.tokenSet = draft.tokenSet === true;
}

function feedback(field, message, kind = 'error') {
  const el = document.querySelector('[data-config-feedback]');
  if (el) el.textContent = field;
  fmc.setScratchpad(message, kind);
}

function reject(field, message) {
  invalid.set(field, message);
  feedback(field, message);
}

function display(field) {
  if (field === 'ingestToken') return draft.tokenSet || pendingToken ? '••••••••' : '□□□□□□□□';
  const value = draft[field];
  if (field === 'serverUrl' && !value) return '□□□□□□□□';
  if (field === 'certPath' && !value) return '--------';
  if (['trafficEnabled', 'autoUplink'].includes(field) && typeof value === 'boolean') return value ? 'ON' : 'OFF';
  return String(value ?? '').toUpperCase();
}

function paintFields() {
  for (const el of document.querySelectorAll('[data-field-value]')) {
    const field = el.dataset.fieldValue;
    el.textContent = display(field);
    el.dataset.edited = String(edited.has(field));
    // Keep paths case-sensitive and copyable without putting secrets in attributes.
    if (field === 'serverUrl' || field === 'certPath') {
      el.textContent = draft[field] || (field === 'serverUrl' ? '□□□□□□□□' : '--------');
      el.title = draft[field] || '';
    }
  }
}

function enterField(field) {
  ensureDraft();
  let entry = fmc.getScratchpad();
  if (fmc.hasScratchpadError()) return;
  if (!entry) {
    if (field === 'sim') {
      const choices = ['2020', '2024', 'fsx'];
      entry = choices[(choices.indexOf(draft.sim) + 1) % choices.length];
    } else if (['autoUplink', 'trafficEnabled'].includes(field)) {
      entry = !draft[field];
    } else if (field === 'ingestToken') {
      feedback(field, 'ENTER TOKEN', 'advisory');
      return;
    } else {
      fmc.setScratchpad(draft[field] == null ? '' : String(draft[field]));
      return;
    }
  }
  if (entry === 'DELETE') entry = field === 'certPath' ? null : '';
  const result = validate(field, entry);
  if (!result.ok) { reject(field, result.message); return; }
  if (field === 'ingestToken') pendingToken = result.value;
  else draft[field] = result.value;
  edited.add(field);
  invalid.delete(field);
  fmc.setScratchpad('');
  paintFields();
  feedback(field, result.warning || (field === 'certPath' ? 'CHECKED ON SAVE' : ''), 'advisory');
  if (!result.warning && field !== 'certPath') fmc.setScratchpad('');
}

async function save() {
  if (saving) return;
  ensureDraft();
  if (invalid.size) {
    const [field, message] = invalid.entries().next().value;
    feedback(field, message);
    return;
  }
  if (fmc.getScratchpad()) { feedback('SELECT FIELD LSK', 'INVALID ENTRY'); return; }
  const patch = { version: 1 };
  const allFields = Object.values(FIELDS).reduce((result, fields) => result.concat(fields), []);
  for (const field of allFields) {
    if (field === 'ingestToken' && pendingToken === undefined && draft.tokenSet) continue;
    const value = field === 'ingestToken' ? pendingToken : draft[field];
    // On-disk autoUplink accepts booleans only; strings are an entry convenience.
    const result = field === 'autoUplink' && typeof value !== 'boolean'
      ? { ok: false, message: 'INVALID ENTRY' } : validate(field, value);
    if (!result.ok) { reject(field, result.message); return; }
    patch[field] = result.value;
  }
  saving = true;
  fmc.setScratchpad('');
  try {
    const result = await fmc.setConfig(patch);
    if (!result?.ok) { feedback('CONFIG WRITE', 'SAVE FAILED'); return; }
    const { ingestToken, ...safe } = patch;
    Object.assign(draft, safe);
    if (ingestToken) draft.tokenSet = true;
    pendingToken = undefined;
    edited.clear();
    await fmc.refreshConfig();
    paintFields();
    feedback('', 'CONFIG SAVED', 'advisory');
  } catch { feedback('CONFIG WRITE', 'SAVE FAILED'); }
  finally { saving = false; }
}

// Registering is the module's only side effect, and it waits for the interface
// to be injected: loading this bundle must not assume a browser module loader
// ran the shell first.
export function register(api) {
  fmc = api;
  for (const [index, id] of Object.keys(FIELDS).entries()) {
    fmc.registerPage({
      id, title: `CFG ${id}`, group: 'CFG', n: index + 1, m: 3,
      render() {
        ensureDraft();
        const view = document.getElementById(`page-${id.toLowerCase()}-template`).content.firstElementChild.cloneNode(true);
        // Paint against the returned view before it is attached by the router.
        for (const el of view.querySelectorAll('[data-field-value]')) {
          const field = el.dataset.fieldValue;
          el.textContent = display(field);
          if (field === 'serverUrl' || field === 'certPath') {
            el.textContent = draft[field] || (field === 'serverUrl' ? '□□□□□□□□' : '--------');
            el.title = draft[field] || '';
          }
          el.dataset.edited = String(edited.has(field));
        }
        view.querySelector('[data-config-feedback]').textContent = id === 'NETWORK' ? 'ENTRY MASKED · LSK TO SET' : '';
        return view;
      },
      onLsk(lsk) {
        if (lsk === 'L6') { fmc.showPage('MENU'); return true; }
        if (lsk === 'R6') { void save(); return true; }
        const field = FIELDS[id][Number(lsk.slice(1)) - 1];
        if (!lsk.startsWith('L') || !field) return false;
        enterField(field);
        return true;
      },
      onKey(key) {
        if (key !== 'EXEC') return false;
        void save();
        return true;
      },
    });
  }
}
