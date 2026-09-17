# Architecture

The msfslogger Windows client is a Tauri desktop app with two processes and one
webview panel. This page maps the components, the runtime flows that connect
them, and the boundaries the codebase enforces between them.

## Component map

```text
+-------------------------+        Tauri IPC        +---------------------------+
|   CDU panel (ui/)       | <----------------------> |  Tauri shell              |
|   webview, ES modules   |   commands + events       |  (src-tauri/, Rust)       |
|   host contract:        |                           |  window, sidecar          |
|   ui/src/bridge.js      |                           |  supervisor, ConfigStore  |
+-------------------------+                           +-------------+-------------+
                                                                     |
                                                     stdio, one JSON |
                                                     object per line |
                                                     (shell<->sidecar|
                                                      protocol)      |
                                                                     v
                                                       +---------------------------+
                                                       |   sidecar (sidecar/)      |
                                                       |   Node 20 / TypeScript    |
                                                       +------+-------------+------+
                                                              |             |
                                                    SimConnect|             |HTTP(S)
                                                              v             v
                                                     +----------------+  +----------------------+
                                                     | MSFS           |  | msfslogger server     |
                                                     | (node-         |  | (another machine;     |
                                                     |  simconnect)   |  |  ingest + datalink/    |
                                                     +----------------+  |  SimBrief/PDC routes)  |
                                                                          +----------------------+
```

`gauge/dev/` is a separate, optional fourth piece: a browser preview harness
that serves `ui/` standalone with a mock host in place of the Tauri shell, for
UI development with no Rust or MSFS running.

## Responsibilities

| Component | Key modules | Responsibility |
| --- | --- | --- |
| CDU panel (`ui/`) | `ui/src/app.js` (page router, scratchpad, key dispatch), `ui/src/bridge.js` (host contract), `ui/src/pages/*` (STATUS, CFG, DATALINK, FPLN pages) | Renders the CDU screen and keys, and talks to whatever host it finds through the host contract only |
| Tauri shell (`src-tauri/`) | `src-tauri/src/main.rs` (commands/events), `supervisor.rs` (sidecar lifecycle), `config.rs` (`ConfigStore`), `datalink.rs` (relay), `protocol.rs`/`framing.rs` (wire decode), `restart.rs` (restart budget) | Owns the window, spawns and supervises the sidecar process, persists `config.json`, relays datalink requests, and is the only place the ingest token is written to disk |
| sidecar (`sidecar/`) | `index.ts` (entrypoint), `simconnect.ts` (SimConnect), `uplink.ts` (ingest HTTP), `datalink-client.ts`/`datalink-service.ts` (ACARS/SimBrief/clearance), `config.ts` (config load/validate) | Reads MSFS over SimConnect, uplinks flight data to the msfslogger server, and runs the datalink/SimBrief/clearance poll and request cycle. The only process that ever opens a socket to the server |
| preview harness (`gauge/dev/`) | `gauge/dev/server.mjs`, `gauge/dev/mock-host.js` | Serves the CDU panel in a plain browser against a mock host, for UI iteration without Tauri or MSFS |

## Runtime flows

### Startup

1. The shell's `.setup()` resolves the config path and the sidecar entry
   point, then constructs the `Supervisor`, which spawns the sidecar
   immediately — the sidecar process always launches. Entry resolution prefers
   the bundled resource copy of `sidecar/dist/index.js` (copied next to the
   executable in both `cargo tauri dev` and a packaged build); only if that
   file is missing does it fall back to `sidecar/dist/index.js` beside
   `src-tauri/`.
2. The sidecar resolves its config path (`--config` → `MSFSLOGGER_CONFIG` →
   platform default — always the path the shell passed), sends `hello`
   (pid, versions, `configPath`, feature list), starts its status heartbeat
   and stdin reader, then loads the config file. If `autoUplink` is `true`,
   this initial load starts the uplink on its own, with no `start` message
   needed; the shell also sends an explicit `start` right after spawn when it
   read `autoUplink: true` from the config file itself, so either side
   starting first is enough.
3. The CDU panel boots independently: `ui/src/app.js` resolves a host (see
   "CDU boot and host detection" below), builds the page interface, shows
   `STATUS`, and fetches the current status and datalink state once rather
   than waiting for the first push.

### Main loop

- **SimConnect sampling**: once connected, the sidecar samples one data
  definition at 1 Hz (position, heading, speeds, ground state, aircraft
  title — heading only; no pitch or bank is sampled). A second, smaller
  AI-traffic sweep rides the same tick, throttled to every 2 seconds and
  capped at 200 objects, only when `trafficEnabled`.
- **Uplink**: each sampled frame and each ingest event (`connected`,
  `disconnected`, `crashed`, `paused`, `unpaused`, `pause`) is POSTed
  individually to the msfslogger server as it happens — no batching, no
  automatic retry of a failed post.
- **Probe**: a reachability probe (`GET /api/status`) fires every 15 seconds,
  but only when no ingest traffic has landed in that window, so the Backend
  status axis never goes stale while the sim link itself is down.
- **Datalink polling lease**: the CDU panel only polls datalink state while a
  DATALINK page is on screen. `watchDatalink(true)` starts a lease; the
  sidecar keeps polling for the lease window and stops on its own if no page
  renews it.
- **Status heartbeat**: state-change pushes are coalesced to at most one full
  snapshot every 250 ms; an unconditional heartbeat every 5 seconds sends
  immediately, bypassing that window, so a quiet period still confirms the
  sidecar is alive. Handling `start`, `stop` or `config` (each a shell→sidecar
  control message) also emits a status line immediately rather than waiting
  for the debounce.

### CDU boot and host detection

`ui/src/bridge.js` is evaluated once, before any page module, and resolves
exactly one host in this order: an adapter a host already installed on
`window.__FMC_HOST__` (used by the preview harness's mock host), then Tauri
(`window.__TAURI__`/`window.__TAURI_INTERNALS__`), then a built-in stub with
the same method names. Whichever host is found is exposed to every page as a
single interface the shell builds (`window.FMC`); only `app.js` imports
`bridge.js`, and only `bridge.js` names `__TAURI__`/`__TAURI_INTERNALS__`/
`__FMC_HOST__`/`__FMC_STUB__` — no page module does either. This is what lets
the same panel run under the Tauri shell, under the preview harness, or
standalone in a plain browser with a working (if inert) stub.

### Supervisor restart policy

If the sidecar process exits unexpectedly, the shell waits a fixed 2 seconds
and respawns it, up to 5 restarts in a rolling 60-second window. Exhausting
that budget latches the supervisor in a crashed state until the user issues an
explicit restart (`sidecar_restart` / the STATUS page's restart prompt), which
clears both the latch and the budget.

### Shutdown

On window close, the shell sets a stopping flag, sends a `shutdown` control
frame to the sidecar, closes its stdin (EOF), and waits up to 2 seconds of
grace before force-terminating the process. The sidecar's own shutdown
sequence stops the uplink and SimConnect, shuts down the datalink service,
races a best-effort `disconnected` ingest event against half of that grace
window, and exits cleanly. Any shell-side requests still queued behind the
stop are answered with a `sidecar-unavailable` error rather than left to time
out.

## Data flow and integration points

- **CDU panel <-> shell**: Tauri IPC — commands (webview calls Rust) and
  events (Rust pushes to the webview). See [api](api.md) for the full command
  and event tables.
- **Shell <-> sidecar**: a private stdio pipe, line-delimited JSON in both
  directions, bounded to 64 KiB per line. This is the only place the shell and
  sidecar communicate; neither process reaches the other over a network
  socket.
- **Sidecar -> MSFS**: SimConnect, via `node-simconnect`, local-machine only.
- **Sidecar -> msfslogger server**: HTTP or HTTPS, per `serverUrl` — the
  config accepts either scheme. For HTTPS against a self-signed certificate,
  `certPath` supplies the CA to trust. Covers the ingest routes and the 13
  datalink/SimBrief/clearance routes. This is the only process in the client
  that ever opens a socket to the server; see [data-model](data-model.md) and
  [api](api.md) for the wire shapes and route table.
- **Shell -> disk**: the only file the shell writes in normal operation is
  `config.json`, via an atomic write.

## External dependencies

- **MSFS / SimConnect**, reached through `node-simconnect` — local IPC to a
  running simulator, not a network dependency.
- **msfslogger server** — the one remote host the client talks to, holding the
  user's logbook and proxying SimBrief and the simulated PDC clearance
  server-side. The sidecar never contacts SimBrief or any ACARS network
  directly.
- **WebView2** — renders the CDU panel; ships with Windows 11 and updated
  Windows 10.
- **Tauri** (2.x CLI and library) — the shell framework: window, IPC,
  bundling.
- **undici** — the sidecar's HTTP client library, shared by the ingest and
  datalink clients through one CA dispatcher.

## Design boundaries

- **UI boundary rules**, enforced mechanically by `npm run check:ui`
  (`ui/tools/boundary-check.mjs`), not by convention alone: only `app.js` may
  import `bridge.js`; only `bridge.js` may name `__TAURI__`,
  `__TAURI_INTERNALS__`, `__FMC_HOST__` or `__FMC_STUB__`; no page under
  `ui/src/pages/` may name the adapter (`bridge`) or the `FMC` global, or call
  `.onLog(`/`.onExit(`/`.onDatalink(` itself — those are the shell's
  subscriptions to make; and `app.js` must never expose the adapter as a
  member of `window.FMC` or a page's context.
- **Secrets never cross to the webview**: the ingest token is stripped from
  every config object before it can leave the sidecar or the shell process;
  the webview only ever sees a boolean `tokenSet`. See
  [security](security.md) for the full redaction chain.
- **All network I/O lives in the sidecar**: the shell's webview CSP has no
  remote `connect-src` at all, so the CDU panel cannot reach the msfslogger
  server (or anywhere else) even if a page tried; every HTTP request the
  client makes is the sidecar's job.
