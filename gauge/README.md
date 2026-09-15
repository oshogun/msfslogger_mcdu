# CDU preview harness

Run from the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools/dev-gauge.ps1
```

Open **http://127.0.0.1:8380** in Edge or Chrome. Stop the server with Ctrl+C.
Use `-Port 8381` if that port is occupied. The server binds only to loopback.
No npm dependencies, Rust, MSFS, SimConnect, or Linux server are required.
The launcher uses Node on PATH, or the project-local portable runtime in
`.tools/`. This machine was provisioned with Node 20.20.2 from nodejs.org,
verified against the vendor's SHA-256 list; `.tools/` is ignored by Git.
On another machine install Node 20 or newer before running the launcher.
Node 20 matches the inherited project's tooling requirement; the harness
itself also works with newer Node versions and has no native dependencies.

With Node on PATH, equivalent commands are:

```powershell
npm run dev:gauge
npm run test:gauge
npm run check:ui
```

For the portable runtime installed here:

```powershell
& ./.tools/node-v20.20.2-win-x64/node.exe --test gauge/dev/harness.test.mjs
```

## Daily edit/debug loop

The preview loads the actual `ui/index.html`, CSS, and page modules. The dev
server injects `gauge/dev/mock-host.js` before `ui/src/app.js` in its HTTP
response. No source files in `ui/`, `sidecar/`, or `src-tauri/` are modified.
The adapter implements the existing `window.__FMC_HOST__` contract and the CDU
annunciates `GAUGE MOCK`. It never connects to the server or simulator.

- Select online, reconnect, server failure, unauthorized, pause, or crash
  scenarios to exercise the existing status pages.
- Operate the CDU buttons and keyboard normally. START/STOP update mock status;
  configuration saves affect memory only. Use dummy credentials.
- Save a file under `ui/` or `gauge/dev/` to reload the preview automatically.
  Reload resets configuration and the scenario selector. Disable Reload on
  save when retaining an interactive debugging session matters.
- F12 opens browser DevTools. Put breakpoints in `ui/src/app.js`, page modules,
  or `gauge/dev/mock-host.js`. Select the CDU iframe in the Console context
  picker to run `gaugeDev.scenario('offline')` or inspect `gaugeDev.calls`.
- In VS Code, start the server, select **Gauge preview (start dev server
  first)**, and press F5. The launch configuration uses Edge on port 8380.
- Viewport choices exercise narrower/wider layouts; they are CSS pixel sizes.

## What this validates

This is a **browser host harness** for fast CDU layout, page interaction, host
contract, and status development. The small mock sits at the existing host
boundary and never talks to a real server or simulator.

The tests cover scenario transitions, unsubscribe behavior, configuration
isolation, secret omission, adapter injection order, and server route isolation.
The existing UI boundary and Rust/webview contract checks also pass.
