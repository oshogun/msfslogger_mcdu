// The STATUS page: the four status axes, the config path, and the two command
// prompts — R6 toggles the uplink, R5 restarts the worker while it is down.
//
// Import rule for this directory, and this file is no exception: a page reaches
// the outside world only through the page interface it is handed — `register`
// at load time, `ctx.fmc` inside a callback — plus `../status.js` and sibling
// page modules. It may not import or name the host adapter, read a global for
// the interface, or subscribe to host events; the shell owns all three. That is
// why the same page code will run unchanged on a host this build has never seen.

import { renderConfigPath, renderStatus, uplinkRunning } from '../status.js';

let fmc = null;

/**
 * The STATUS view ships in the HTML and the router detaches it on the first
 * navigation away, so it is captured once at registration while it is still in
 * the document; looked up later there would be nothing to find.
 */
let view = null;

function paint(status) {
  renderStatus(view, status);
  renderConfigPath(view, fmc.getConfigPath());
}

/** R6 offers START or STOP depending on which the current status allows. */
function toggleUplink() {
  if (uplinkRunning(fmc.getStatus())) void fmc.stopUplink();
  else void fmc.startUplink();
}

export function register(api) {
  fmc = api;
  view = document.querySelector('[data-page-view="STATUS"]');

  fmc.registerPage({
    id: 'STATUS',
    title: 'ACARS STATUS',
    group: 'STATUS',
    n: 1,
    m: 1,
    render(ctx) {
      paint(ctx.status);
      return view;
    },
    onLsk(lsk, ctx) {
      if (lsk === 'L6') {
        ctx.fmc.showPage('MENU');
        return true;
      }
      if (lsk === 'R6') {
        toggleUplink();
        return true;
      }
      if (lsk === 'R5') {
        const app = ctx.status && ctx.status.app;
        if (app && app.state === 'app.crashed') {
          void ctx.fmc.restartSidecar();
          return true;
        }
        return false;
      }
      if (['L1', 'L2', 'L3', 'L4', 'L5'].includes(lsk)) {
        ctx.fmc.setScratchpad('NOT ALLOWED', 'error');
        return true;
      }
      return false;
    },
    onStatus(status) {
      paint(status);
    },
  });
}
