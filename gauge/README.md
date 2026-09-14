# Gauge development environment

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
- Viewport choices exercise narrower/wider layouts; they are CSS pixel sizes,
  not a simulation of cockpit textures or simulator display scaling.

## What this validates

This is a **browser host harness**, not a standalone Coherent GT runtime or
an MSFS API emulator. It supports fast CDU layout, page interaction, host
contract, and status development. The small mock is deliberately at the
existing host boundary: it does not claim to implement `SimVar`, `Coherent`,
`BaseInstrument`, aircraft electrical systems, or simulator lifecycle timing.
Unsupported simulator APIs remain absent instead of silently returning fake
success. Add narrowly scoped fixtures when a future gauge adapter needs them.

The new tests cover scenario transitions, unsubscribe behavior, configuration
isolation, secret omission, adapter injection order, and server route isolation.
The existing UI boundary and Rust/webview contract checks also pass. Browser
visual verification and real-engine verification remain pending: this session
had no connected browser automation surface or running simulator target.

## Build and install the MSFS 2020 gauge

The gauge is an aircraft-independent toolbar panel. It bundles the same CDU UI,
installs a separate `MSFS GAUGE` host, reads the user aircraft through SimVar,
and posts one frame per second to the existing `/api/ingest/frame` endpoint.
The Tauri app and its SimConnect sidecar are unchanged.

Build with the installed SDK:

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-gauge.ps1 -SdkRoot 'C:\MSFS SDK'
```

The Community-ready folder is `gauge/msfs/Packages/msfslogger-cdu`. Install it
after closing MSFS:

```powershell
powershell -ExecutionPolicy Bypass -File tools/install-gauge.ps1
```

The installer reads MSFS `UserCfg.opt` to locate Community. For a custom path:

```powershell
powershell -ExecutionPolicy Bypass -File tools/install-gauge.ps1 -CommunityPath 'D:\MSFS\Community'
```

Build and install while MSFS is closed. The SDK may return success without
replacing a package that the running simulator has mounted; the build script
checks the generated version and assets and rejects that stale result.

After the first install, restart MSFS, enter a flight, open the toolbar, and
select **MSFSLogger CDU**. On the CDU use `MENU` → `<NETWORK`, enter the server
URL and ingest token, and press `SAVE>`. The settings live in the gauge's
browser storage and do not overwrite the Tauri configuration. Return to STATUS
and press `START>`; `SIM LINK ONLINE` confirms SimVar access and `ACARS UPLINK`
confirms an accepted ingest response. The server must be reachable from this PC.
An HTTPS server certificate must already be trusted by Windows/MSFS; a Coherent
gauge cannot load Tauri's custom certificate file.

The initial gauge sends user-aircraft frames and connected/disconnected events.
AI traffic remains off because the HTML gauge does not expose the sidecar's
SimConnect object sweep. Pause remains `PAUSE OFF` because reliable
`Pause_EX1` system-event parity needs a WASM/SimConnect bridge. Those two lines
are explicit capability limits, not simulated data.

## Coherent GT debugging

The SDK debugger inspects a running MSFS view. Check the installation with:

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools/coherent-debugger.ps1 -SdkRoot 'C:\MSFS SDK'
   ```

Once the gauge is loaded in a flight, add `-Launch` to start the debugger, then
point it at **http://127.0.0.1:19999** and click Go.
   Select the relevant VCockpit view and enable **Network > Ignore Cache**.
   Debugger edits are temporary; copy changes back to source.

SDK 0.24.6.0 compiled the package successfully on this machine. The browser
host tests verify SimVar-to-frame mapping, secret redaction, local persistence,
auto-start, and the existing ingest URLs. Rendering, input focus, HTTP/CORS,
certificate trust, and live SimVar behavior still require the in-simulator test.

Official references:

- [MSFS 2020 Coherent GT Debugger](https://docs.flightsimulator.com/html/Additional_Information/Tools/Coherent_GT_Debugger.htm)
- [MSFS 2020 JavaScript instruments and lifecycle](https://docs.flightsimulator.com/html/Programming_Tools/JavaScript/JavaScript.htm)
- [Coherent GT debugging and live editing](https://coherent-labs.com/Documentation/cpp-gt/dd/d68/debugging.html)
