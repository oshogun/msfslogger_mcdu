# CDU preview harness

Run from the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools/dev-gauge.ps1
```

Open **http://127.0.0.1:8380** in Edge or Chrome. Stop the server with Ctrl+C.
Use `-Port 8381` if that port is occupied. The server binds only to loopback.
No npm dependencies, Rust, MSFS, SimConnect, or Linux server are required.
The launcher uses Node on PATH, or a project-local portable runtime under
`.tools/` if you've placed one there (`.tools/` is ignored by Git). Install
Node 20 or newer before running the launcher; the harness has no native
dependencies and also works with newer Node versions.

With Node on PATH, equivalent commands are:

```powershell
npm run dev:gauge
npm run test:gauge
npm run check:ui
```

With a portable runtime under `.tools/`, run its `node.exe` directly, e.g.:

```powershell
& ./.tools/node-v20.20.2-win-x64/node.exe --test gauge/dev/harness.test.mjs
```

## Daily edit/debug loop

The preview loads the actual `ui/index.html`, CSS, and page modules. The dev
server injects `gauge/dev/mock-host.js` before `ui/src/app.js` in its HTTP
response. No source files in `ui/`, `sidecar/`, or `src-tauri/` are modified.
The adapter implements the existing `window.__FMC_HOST__` contract and the CDU
annunciates `GAUGE MOCK`. It never connects to the server or simulator.

- The header has five independent scenario selectors, each wired to its own
  `gaugeDev.*Scenario()` call and applied on load and on every change:
  - **Scenario** (`#scenario`) — `stopped`, `online`, `retry`, `offline`,
    `unauthorized`, `paused`, `active-pause`, `crashed`. Drives the App/Sim/
    Backend/Pause status axes shown on `STATUS`.
  - **Datalink** (`#datalink-scenario`) — flight/leg scope, no flight plan, a
    pre-upgrade server, an invalid token, unreachable, a paging TAF, a
    900-character route, no dispatch release, four canned messages, WX
    unavailable, and a sidecar-outdated case. Drives what `DL-INDEX` and the
    rest of the `DL-*` pages show.
  - **SimBrief** (`#simbrief-scenario`) — pilot-ID and prefile outcomes for
    `FPLN`: configured/not configured, duplicate, a long label, an
    already-prefiled leg, and the full set of SimBrief/relay/sidecar failure
    codes (bad user id, no OFP, timeouts, bad body, busy, sidecar exited or
    outdated, not supported, and more).
  - **Clearance** (`#clearance-scenario`) — outcomes for `REQUEST CLEARANCE`
    on `DL-INDEX`/`DL-CLEARANCE`: issued, already issued, long or missing
    routes, flight-level vs. feet altitude, a leg the server has no record of
    (`PLANNED LEG NOT FOUND`), a leg with no dispatch release on file
    (`NO DISPATCH RELEASE ON FILE`), and the same family of relay/sidecar/
    host failure codes as Datalink and SimBrief.
  - **SayIntentions** (`#sayintentions-scenario`) — outcomes for `DL-SI`,
    `DL-SI-CONFIRM` and `DL-SI-PDC`: linked with imports, no key configured,
    key set but not linked, link-from-now, import with and without new rows,
    a sent PDC push, leg-scope refusal, every `si-*` upstream/validation error
    (no API key, key rejected, not linked, session changed, no comms, no
    active session, no PDC on file, upstream unreachable/timeout/error/bad
    body, flight/leg not found, invalid id), and the same relay/sidecar/host
    failure codes as the other three.

  Picking an option that doesn't exist in a selector's own list throws
  `Unknown … scenario: <name>` in the DevTools console rather than silently
  doing nothing.
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

See [../docs/development.md](../docs/development.md) for the rest of the dev
workflow and checks, and [../docs/cdu-reference.md](../docs/cdu-reference.md)
for the page map, LSK layout and CDU vocabulary this harness exercises.
