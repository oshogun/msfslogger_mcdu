// The GAUGE PAIR page: issues the one-time code the in-simulator CDU needs
// before the desktop app will sync with it. R6 requests a new code, R5 appears
// only when stored pairing data is unreadable and must be reset, L6 returns to
// the index. A host that cannot issue codes (the gauge itself) says so instead.
//
// Import rule for this directory applies: this page reaches the outside world
// only through the interface handed to `register` and `ctx.fmc`.

let fmc = null;
let view = null;
let pairing = null;
let needsConfirm = false;
let busy = false;

function row(className, left, right, key) {
  const el = document.createElement('div');
  el.className = `row ${className}`;
  const l = document.createElement('span');
  l.className = 'cell-l';
  l.textContent = left || '';
  el.appendChild(l);
  if (right !== undefined) {
    const r = document.createElement('span');
    r.className = 'cell-r';
    r.textContent = right;
    if (key) r.dataset.pair = key;
    el.appendChild(r);
  } else if (key) {
    l.dataset.pair = key;
  }
  return el;
}

function build() {
  const el = document.createElement('div');
  el.className = 'page-view';
  el.setAttribute('data-page-view', 'PAIR');
  el.appendChild(row('row-label', 'PAIRING CODE'));
  el.appendChild(row('row-value', '', undefined, 'code'));
  el.appendChild(row('row-label', 'EXPIRES IN'));
  el.appendChild(row('row-value', '', undefined, 'expires'));
  el.appendChild(row('row-label', ''));
  el.appendChild(row('row-value', '', undefined, 'hint'));
  el.appendChild(row('row-label', ''));
  el.appendChild(row('row-value', ''));
  el.appendChild(row('row-label', ''));
  el.appendChild(row('row-value', '', '', 'confirm'));
  el.appendChild(row('row-label', ''));
  const prompts = document.createElement('div');
  prompts.className = 'row row-value config-prompts';
  const back = document.createElement('span');
  back.className = 'prompt';
  back.textContent = '<INDEX';
  const action = document.createElement('span');
  action.className = 'prompt';
  action.dataset.pair = 'action';
  prompts.appendChild(back);
  prompts.appendChild(action);
  el.appendChild(prompts);
  return el;
}

function secondsLeft() {
  return pairing ? Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000)) : 0;
}

function paint() {
  if (!view) return;
  const set = (key, text) => {
    const el = view.querySelector(`[data-pair="${key}"]`);
    if (el) el.textContent = text;
  };
  if (!fmc.canPairGauge) {
    set('code', 'N/A');
    set('expires', '--');
    set('hint', 'PAIR FROM DESKTOP APP');
    set('confirm', '');
    set('action', '');
    return;
  }
  const live = secondsLeft() > 0;
  set('code', live ? `${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}` : '---- ----');
  set('expires', live ? `${secondsLeft()}S` : pairing ? 'EXPIRED' : '--');
  set('hint', live ? 'ENTER CODE ON MSFS CDU' : 'SELECT NEW CODE');
  set('confirm', needsConfirm ? 'RESET PAIRING>' : '');
  set('action', busy ? 'WAIT' : 'NEW CODE>');
}

async function requestCode(confirmCorrupt) {
  if (busy) return;
  busy = true;
  paint();
  try {
    const result = await fmc.beginGaugePairing(confirmCorrupt);
    if (result && result.ok === true && /^[0-9]{8}$/.test(result.code)) {
      const expiresAt = Number(result.expiresAt);
      pairing = { code: result.code, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 120000 };
      needsConfirm = false;
      fmc.setScratchpad('');
    } else if (result && result.code === 'confirmation_required') {
      pairing = null;
      needsConfirm = true;
      fmc.setScratchpad('PAIR DATA UNREADABLE', 'error');
    } else {
      fmc.setScratchpad('PAIRING FAILED', 'error');
    }
  } catch {
    fmc.setScratchpad('PAIRING FAILED', 'error');
  } finally {
    busy = false;
    paint();
  }
}

export function register(api) {
  fmc = api;
  fmc.registerPage({
    id: 'PAIR',
    title: 'GAUGE PAIR',
    group: 'PAIR',
    n: 1,
    m: 1,
    render() {
      view = build();
      paint();
      return view;
    },
    onLsk(lsk) {
      if (lsk === 'L6') {
        fmc.showPage('MENU');
        return true;
      }
      if (!fmc.canPairGauge) return false;
      if (lsk === 'R6') {
        void requestCode(false);
        return true;
      }
      if (lsk === 'R5' && needsConfirm) {
        void requestCode(true);
        return true;
      }
      return false;
    },
    // The shell repaints the current page every second, which drives the countdown.
    onStatus() {
      paint();
    },
    dispose() {
      view = null;
    },
  });
}
