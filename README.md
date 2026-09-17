# msfslogger Windows client

## Offline CDU preview

Run `powershell -ExecutionPolicy Bypass -File tools/dev-gauge.ps1` from this
repository root and open <http://127.0.0.1:8380>. This previews the existing
CDU with a mock host, selectable scenarios, and reload-on-save, without
launching MSFS or changing the Tauri app.
See [CDU preview harness](gauge/README.md) for debugging, tests, and setup on
another machine.

A Tauri desktop app that replaces [`agent/`](../agent/) as the way to get flight
data from MSFS into a `msfslogger` server on another machine. It talks to
SimConnect and to the server exactly the same way the agent does — same
reconnect backoff, same `Pause_EX1` handling, same traffic sweep, same HTTP
uplink — but every setting that used to be an environment variable or a
`--sim` flag is now a field on an on-screen page, and connection state is
shown as an aircraft FMC would show it, with the connected state reading
**ACARS UPLINK**.

**`agent/` is unchanged and stays in place as the fallback.** Nothing in this
run modified it. If this app doesn't work for you on a given box, `cd agent
&& npm start` with the environment variables from [`agent/README.md`](../agent/README.md)
still works exactly as before.

## What's inside

- `sidecar/` — a Node process, adapted from `agent/agent.js` and
  `agent/traffic.js`, that owns the actual SimConnect connection and the HTTP
  push to the server. It reads one JSON config file instead of environment
  variables.
- `src-tauri/` — the Rust shell: the native window, starting and stopping the
  sidecar, and reading/writing the config file.
- `ui/` — the on-screen FMC panel (plain HTML/CSS/JS, no build step) that the
  Rust shell displays in a WebView2 window.

## Prerequisites (Windows)

- **Node.js 20** — same requirement as `agent/`. The sidecar is plain
  Node/TypeScript; it does not run under Tauri's Rust process.
- **A Rust toolchain, version 1.88.0 or newer.** `windows-client/src-tauri/Cargo.toml`
  pins `rust-version = "1.88.0"` because Tauri 2.11.5's dependency graph needs
  Rust's 2024 edition. This is a real minimum, not a suggestion — verified on
  this machine, whose installed toolchain is older:

  ```
  $ rustc --version
  rustc 1.75.0 (82e1608df 2023-12-21) (built from a source tarball)
  $ cargo --version
  cargo 1.75.0
  ```

  A build attempt with this toolchain fails resolving a transitive dependency
  with `feature 'edition2024' is required` — Tauri's own dependencies have
  moved past what 1.75 can compile. Install a current stable Rust via
  [rustup](https://rustup.rs/) on the Windows box, or use the CI artifact
  below.
- **The Tauri CLI**, installed once: `cargo install tauri-cli --locked --version "^2"`.
  This provides the `cargo tauri` subcommand used below. *(Windows-only,
  untested here — this machine's Rust is below the pinned minimum.)*
- **WebView2** — ships with Windows 11 and with any up-to-date Windows 10; no
  separate install needed on a machine that keeps up with Windows Update.

**No-toolchain alternative:** the GitHub Actions `windows-latest` job at
`.github/workflows/windows-client.yml` builds the same app on a Microsoft-hosted
runner and publishes the installer as a workflow artifact — pull that down
if you don't want to install Rust locally.

## Build and run (Windows)

*(Windows-only, untested here — no command below was run to completion on
this Linux machine; the sidecar-only steps that don't need Rust were verified
separately, see [Verification done on this machine](#verification-done-on-this-machine).)*

From the repo root, on the Windows box:

```powershell
cd windows-client
npm --prefix sidecar ci
npm --prefix sidecar run build
cd src-tauri
cargo tauri dev
```

`cargo tauri dev` opens the app window. `tauri.conf.json`'s
`beforeDevCommand`/`beforeBuildCommand` re-runs the sidecar's TypeScript build
automatically on every `cargo tauri dev`/`build`, so the two `npm --prefix
sidecar` lines above only need running once, to install dependencies and
produce the first build — after that they're only needed again if
`sidecar/package.json` changes.

To produce an installer instead of a dev window:

```powershell
cd windows-client/src-tauri
cargo tauri build
```

This produces both an `.msi` and an NSIS `.exe` under
`windows-client/src-tauri/target/release/bundle/`. No code-signing certificate
is configured, so Windows SmartScreen will warn on first run of the installer
— that's expected and out of scope for this run.

## Where the config file lives

`%APPDATA%\msfslogger\config.json` — typically
`C:\Users\<you>\AppData\Roaming\msfslogger\config.json`. It's in your roaming
profile, not next to the executable, so it survives a reinstall or an app
update, and a non-elevated user can write it.

The app finds it there automatically. **No environment variable and no
command-line flag is required** — that's the whole point of this run. The
file also has a fixed, documented path specifically so the standalone sidecar
(`node dist/index.js`, run with no Tauri shell at all) finds the exact same
file the app does.

If you want to point either the app or the standalone sidecar at a different
file (for testing, or running two configs side by side), `--config <path>` on
the sidecar's command line and the `MSFSLOGGER_CONFIG` environment variable
both work, in that order of precedence — but neither is needed for normal use.

The file is a plain JSON file. It's fine to hand-edit it while the app is
closed; the app also has its own atomic-write logic (temp file + rename) so a
crash mid-save can't corrupt it.

## Migrating your current settings

Everything you'd have set via an environment variable or a flag for `agent/`
has a matching field in the new config UI:

| Today (`agent/`) | Config UI field | FMC page | Notes |
|---|---|---|---|
| `SERVER_URL` env var | Server URL | `CFG NETWORK`, L1 | Same value, e.g. `https://192.168.0.30:3000` |
| `INGEST_TOKEN` env var | Token | `CFG NETWORK`, L2 | Displayed masked (`••••••••`) once set; never shown in the clear |
| `NODE_EXTRA_CA_CERTS` env var | Cert path | `CFG NETWORK`, L3 | Path to the server's self-signed certificate PEM, same file you'd point the old env var at |
| `TRAFFIC_ENABLED` env var | Traffic | `CFG TRAFFIC`, L1 | Toggled ON/OFF instead of `0`/`false`/`off`/`no` |
| `TRAFFIC_RADIUS_M` env var | Radius | `CFG TRAFFIC`, L2 | Same metres value, same `[1000, 200000]` clamp |
| `--sim` / `-s` flag | Sim version | `CFG SIM`, L1 | Cycles `2020` → `2024` → `fsx` |
| *(new)* `autoUplink` | Auto-start | `CFG SIM`, L2 | Not something the old agent had: when ON, the uplink starts by itself at launch instead of waiting for `START>` |

Nothing needs to be set twice: once you've saved these on `CFG NETWORK` /
`CFG SIM` / `CFG TRAFFIC`, the sidecar this app supervises behaves exactly
like `agent.js` run with the equivalent environment variables and flag.

## Configuring through the FMC pages — walkthrough

1. Launch the app. It opens on the `STATUS` page.
2. Press the `MENU` key.
3. On the `MENU` page, press the line-select key (LSK) next to `<NETWORK`.
4. On `CFG NETWORK`: type the server URL on the scratchpad and press `L1`;
   type the ingest token and press `L2`; type the certificate path (if the
   server runs HTTPS, which is the norm) and press `L3`.
5. Press `R6` (`SAVE>`) to write the file. The scratchpad shows `CONFIG SAVED`.
6. Press `MENU` again, then `<SIM` to set the SimConnect protocol version and
   auto-start behaviour, or `<TRAFFIC` to set AI traffic on/off and the sweep
   radius. Each page saves the same way, `R6`.
7. Back on `STATUS`, press `START>` to begin the uplink (skip this if you set
   `autoUplink` ON — it will have started by itself).

An entry that fails validation never gets as far as the file: the scratchpad
shows a one-line reason (`INVALID ENTRY`, `ENTRY OUT OF RANGE`) and the field
keeps its previous value.

## FMC status vocabulary

The `STATUS` page shows four lines, always present, never collapsed, because
**the SimConnect link and the backend uplink are two independent things that
fail for different reasons** — MSFS not being open yet and the server being
unreachable are both real, both common, and need different fixes. A single
status line would have to hide one to show the other.

### App — is the sidecar alive and is the uplink meant to be running

| Label | Meaning | Operator action |
|---|---|---|
| `SIDECAR STARTING` | Process just started, hasn't read the config yet | Wait a moment |
| `NO CONFIG` | No config file exists yet at the resolved path | Go to `MENU` and fill in `CFG NETWORK` at minimum |
| `CONFIG INVALID` | Config file exists but fails validation (see the scratchpad/log for which field) | Fix the named field on the matching CFG page and save again |
| `UPLINK STOPPED` | Config is valid; the uplink isn't running (never started, or you pressed `STOP>`) | Press `START>` when ready |
| `UPLINK ACTIVE` | The uplink is running | Nothing needed |
| `SIDECAR FAULT` | The sidecar process died unexpectedly | The shell will restart it automatically within its budget; if it keeps happening, check Windows Event Viewer / the app's log for a Node crash |
| `SIDECAR RESTART` | The shell is respawning the sidecar after a fault | Wait; this is automatic |

### Sim — the SimConnect link

| Label | Meaning | Operator action |
|---|---|---|
| `SIM LINK STANDBY` | Uplink not running, so nothing is being attempted | Press `START>` |
| `SIM LINK CONNECTING` | Trying to open SimConnect | Wait a few seconds |
| `SIM LINK ONLINE` | Connected to MSFS | Nothing needed |
| `SIM LINK RETRY {ss}S` | Last attempt failed (or a live link dropped); reconnecting in `{ss}` seconds, backing off 5s → 10s → 20s → 40s → capping at 60s | Make sure MSFS is running; the app will keep retrying on its own |

### Backend — the msfslogger server

| Label | Meaning | Operator action |
|---|---|---|
| `ACARS STANDBY` | Uplink not running: nothing posted, nothing probed | Press `START>` |
| `ACARS CONNECTING` | Uplink just started; no request has completed yet | Wait a moment |
| **`ACARS UPLINK`** | The most recent flight-data or event post to the server succeeded | Nothing needed — this is the "everything working" state |
| `ACARS READY` | The server answered a reachability check, but nothing has been posted recently (usually because the sim link is down, so there's nothing to send) | Nothing needed; this clears once the sim link comes up and data starts flowing |
| `ACARS REJECT 401` | The server rejected a post — the token doesn't match | Fix the token on `CFG NETWORK` to match the server's `INGEST_TOKEN` |
| `ACARS FAULT {status}` | The server rejected a post with some other non-2xx status | Check the server's own logs for what it didn't like |
| `ACARS CERT FAULT` | TLS handshake failed — the server's certificate isn't trusted | Fix or set the certificate path on `CFG NETWORK` |
| `ACARS NO COMM` | Can't reach the server at all (refused, timed out, DNS failure) | Check the server is running and the URL/network path is correct |

DATALINK faults never appear on this Backend line — it only ever reflects the
flight-data/event uplink. See [DATALINK (ACARS messaging)](#datalink-acars-messaging)
below for the separate DATALINK state line.

### Pause — what MSFS is doing right now

| Label | Meaning | Operator action |
|---|---|---|
| `PAUSE OFF` | Not paused | Nothing needed |
| `SIM PAUSED` | Regular full pause | Nothing needed — the flight clock is stopped, resume when ready |
| `ACTIVE PAUSE` | Active Pause (aircraft frozen, sim keeps running) | Nothing needed — same clock-stop guarantee as a full pause |
| `SIM MENU` | Sim is frozen in a menu | Nothing needed |
| `PAUSE {flags}` | An unrecognized pause bitmask | Informational only; the flight clock still stops for any non-zero flag |

## DATALINK (ACARS messaging)

DATALINK is a second, independent feature from the flight-data uplink above:
it lets you read and send ACARS-style text messages (dispatch releases,
free-text/canned downlinks, weather requests, loadsheets) against the
msfslogger server, over the same connection settings. It has its own state
line and its own vocabulary, separate from the `STATUS` page's Backend axis.

### Requirements

- **The msfslogger server must be on commit `9a52d2d` or later.** Before that
  commit, DATALINK pages show `DATALINK UNAVAILABLE` (hint
  `SERVER MAY PREDATE DATALINK`) and nothing else works on them — but this has
  **no effect on the regular flight-data uplink**: `STATUS` keeps reading
  `ACARS UPLINK` or `ACARS READY` as normal, never `ACARS REJECT 401`.
- DATALINK uses the **same ingest token already set on `CFG NETWORK`** — there
  is no separate login, token or setting to configure.
- The token is **never shown on the CDU**, in a DATALINK page, in the sidecar
  log, or anywhere in an event sent to the webview.

### Reaching DATALINK

`MENU` → `L5` `<DATALINK` opens `DL-INDEX` (`ACARS DATALINK`).

### Page flow

- **`DL-INDEX`** (`ACARS DATALINK`) — current scope and the DATALINK state
  line. `L3` `<MESSAGES` → `DL-THREAD`; `L4` `<DOWNLINK` → `DL-CANNED`; `R3`
  `WX REQUEST>` → `DL-WX`; `R4` `LOADSHEET>` → `DL-LOADSHEET`; `R5`
  `CLEARANCE>` requests a simulated PDC for the current leg (see "REQUEST
  CLEARANCE" below); `R6` `REFRESH>` polls immediately; `L6` `<INDEX` →
  `MENU`. If a leg prefiled from `FPLN` (below) is held, the scope line
  instead reads `PREFILE` and `R1` shows `CLR PREFILE>` to drop it; the leg's
  id then shows on its own row below, under `PREFILED LEG`.
- **`DL-THREAD`** (`ACARS MSGS`) — the message thread for the current scope,
  five messages per page, oldest first, opening on the newest page. `L1`–`L5`
  open a message; `L6` `<RETURN`; `R6` `REFRESH>`.
- **`DL-MSG`** (`ACARS MSG`) — the full text of one message, paged 10 lines at
  a time; `L6` `<RETURN` goes back to the thread page it came from.
- **`DL-CANNED`** (`DOWNLINK`) — the list of canned downlink messages the
  server offers; picking one stages it and opens `DL-CONFIRM`.
- **`DL-WX`** (`WX REQUEST`) — type an ICAO on the scratchpad, `L1` to stage
  it, then `R6` `REQUEST>` opens `DL-CONFIRM`.
- **`DL-WX-RESULT`** (`WX <ICAO>`) — the returned `METAR` and `TAF`, paged;
  `L6` `<RETURN` goes back to `DL-WX`.
- **`DL-LOADSHEET`** (`LOADSHEET`) — the last illustrative loadsheet received
  for the current leg, or `R6` `REQUEST>` to fetch one via `DL-CONFIRM`.
- **`DL-CONFIRM`** (`CONFIRM SEND`) — every write (canned downlink, WX
  request, loadsheet request) stops here first. Staging it from the previous
  page is one key press; `R6` `SEND*` here is the second, separate press that
  actually sends it. `L6` `<CANCEL` discards it without sending anything. No
  single key press anywhere in DATALINK sends a message by itself. Row 2
  reads `NO PENDING REQUEST` if this page is ever reached with nothing
  staged — not expected through normal navigation.

### REQUEST CLEARANCE (simulated PDC)

`DL-INDEX` `R5` `CLEARANCE>` is always shown, and requests a simulated
pre-departure clearance for whichever leg is the current scope: the flight's
linked leg, the ground-session leg, or a held `FPLN` prefiled leg. With no
leg resolved yet, or a newly held prefiled leg the scope hasn't caught up
with, `R5` refuses locally and sends nothing — `NO FLIGHT PLAN`,
`NO LINKED LEG`, or `SCOPE UPDATE PENDING`; the usual `INGEST TOKEN REJECTED`
/ `DATALINK NO CONFIG` refusals apply here too.

`R5` opens `DL-CLEARANCE-CONFIRM` (`REQUEST CLEARANCE`), showing the leg as
`LEG <id>`. `R6` `SEND*` is the one press that actually sends the request; it
re-checks the leg against the current scope first, and if it has changed
since the page opened, nothing is sent and the scratchpad reads
`CLEARANCE LEG CHANGED`. While the request is in flight the page reads
`SENDING`: pressing `R5` again from `DL-INDEX` reopens the confirm page
instead of starting a second request, and a second `R6` press on the confirm
page itself makes no call either — at most one clearance request is ever in
flight. `L6` `<CANCEL` discards a staged request without sending anything.

On success, `DL-CLEARANCE` shows the marker `SIMULATED CLEARANCE`,
`<DEP> TO <DEST>`, the initial altitude, the squawk, and the cleared route
(paged); the last line always reads `NOT FOR REAL WORLD USE` — this is a
simulated exchange, never a real clearance. The app refreshes the message
thread right away after any successful send, so `R6` `MESSAGES>` normally
already finds the request/reply pair (a downlink `REQUEST CLEARANCE` and its
uplink `PDC` reply) without you needing to press `REFRESH>` yourself. The app
keeps the last result for up to four legs in its own memory for the rest of
the session: pressing `R5` again for one of those legs reopens its kept
result with no new request, until the app is restarted, the page reloaded, or
`CFG NETWORK` saves a different server URL or a newly entered token (which
drops every kept result).
A genuine repeat request for a leg that already has a clearance (after a
restart, for example) is answered by the server with the same rows and shows
`ALREADY ISSUED` next to the pair, with the same squawk — a repeat never
issues a second clearance and never writes a second logbook row.

Requesting a clearance needs a msfslogger server build that has the
clearance route — later than DATALINK's own floor above. Until that build is
running, `SEND*` fails and `DL-INDEX`'s scratchpad reads
`CLEARANCE UNAVAILABLE` (no hint shown there); pressing `R5` again reopens
`DL-CLEARANCE-CONFIRM`, whose `LAST REQUEST` rows then show the hint,
`SERVER UPDATE NEEDED` — every clearance hint below works the same way, on
the reopened confirm page, never on `DL-INDEX` itself. Every other DATALINK
page and the flight-data uplink keep working normally. The same distinction
applies if this build's own sidecar or shell predates the clearance feature:
an outdated **sidecar** (whose hello lacks the clearance capability, with an
up-to-date shell) shows the existing `SIDECAR UPDATE REQUIRED` (hint
`REBUILD SIDECAR THEN RESTART APP`) — the same code DATALINK already uses
for an outdated sidecar in general; an outdated **shell exe** instead shows
`CLEARANCE HOST FAULT`, because its call to the (missing) command fails
outright — restarting `cargo tauri dev` fixes this, and also rebuilds the
sidecar first through its `beforeDevCommand`
(`src-tauri/tauri.conf.json:8`). `CLEARANCE NOT SUPPORTED` is a different
case again: it only appears if an *installed custom host*
(`window.__FMC_HOST__`, as the browser preview harness installs) lacks the
clearance method; that host lives outside this app's shell, so restarting
`cargo tauri dev` does not change it. Like the rest of DATALINK, a clearance
request uses the existing ingest token with no extra
login, is never shown on the CDU, the sidecar log, or an event sent to the
webview, and is never retried automatically by this app. A leg with no
SimBrief dispatch release on file — for example one imported only from
Little Navmap, with no SimBrief import run for it — cannot be cleared: the
server answers `409`, and `DL-INDEX`'s scratchpad reads
`NO DISPATCH RELEASE ON FILE` (hint `IMPORT THE PLAN FROM SIMBRIEF`, again
only on the reopened confirm page).

### Polling

DATALINK polls the server every 20 seconds, but **only while a DATALINK page
is on screen** — there is no background polling and no new-message
annunciator on other pages. It works before `START>` is pressed and
independently of it: the ACARS uplink and DATALINK are unrelated, and
starting or stopping one has no effect on the other.

### DATALINK vocabulary

**State line** (`DL-INDEX` row 4; also shown on `DL-THREAD` when no thread is
cached yet):

| CDU text | Hint | Meaning | Operator action |
|---|---|---|---|
| `DATALINK STANDBY` | | No DATALINK page has polled yet this session | Nothing needed |
| `DATALINK CONNECTING` | | The first poll after opening a DATALINK page is in flight | Wait a moment |
| `DATALINK ONLINE` | | The last poll succeeded | Nothing needed — this is the working state |
| `DATALINK NO COMM` | | No HTTP response reached the server | Check the server is running and reachable |
| `DATALINK CERT FAULT` | `CHECK CERTIFICATE PATH` | TLS handshake failed | Fix the certificate path on `CFG NETWORK`, L3 |
| `DATALINK TIMEOUT` | | No response within 8 seconds | Wait for the next poll; persistent timeouts point at server load or network path |
| `INGEST TOKEN REJECTED` | `CHECK INGEST TOKEN ON CFG NETWORK` | The server rejected the ingest token; DATALINK stops polling until the config is corrected and re-saved | Re-enter the token on `CFG NETWORK`, L2, and save |
| `DATALINK TOKEN NOT RECEIVED` | `TOKEN HEADER LOST IN TRANSIT` | The route answered, but the token header never reached the server | Check any reverse proxy between the app and the server |
| `DATALINK UNAVAILABLE` | `SERVER MAY PREDATE DATALINK` | The server answered, but not on a DATALINK-aware route — normal before it's on commit `9a52d2d` or later | Restart the server onto `9a52d2d` or later, when you choose to |
| `DATALINK REJECTED 403` | | The server refused the request | Should not happen from this app; report it if seen |
| `DATALINK FAULT {status}` | | Any other non-2xx server response | Check the server's own logs |
| `DATALINK BAD DATA` | | The server's response wasn't valid JSON or wasn't the expected shape | Should not happen against a matching server version |
| `DATALINK NO CONFIG` | `COMPLETE CFG NETWORK` | The sidecar has no valid config yet | Fill in `CFG NETWORK` and save |
| `SIDECAR UPDATE REQUIRED` | `REBUILD SIDECAR THEN RESTART APP` | The running sidecar predates the DATALINK feature this shell expects | `npm --prefix sidecar run build`, then restart `cargo tauri dev` |
| `DATALINK OFFLINE` | | No sidecar is running, or it exited with a DATALINK request pending | The shell restarts the sidecar automatically; check the app log if it persists |

**Scratchpad messages** (page actions and requests):

| CDU text | When |
|---|---|
| `NO FLIGHT PLAN` | A DATALINK action was pressed with no leg or flight resolved yet |
| `NO LINKED LEG` | `LOADSHEET` was requested in flight scope, and the flight has no linked planned leg to request one for |
| `NO DISPATCH DATA` | The leg has no SimBrief dispatch release on the server |
| `INVALID ENTRY` | An empty or malformed ICAO was entered on `DL-WX` |
| `DOWNLINK SENT` | A canned downlink send completed |
| `LOADSHEET RECEIVED` | A loadsheet request generated new figures |
| `LOADSHEET ON FILE` | A loadsheet request returned the same figures already on file |
| `NOT A CANNED MESSAGE` / `UNKNOWN CANNED MESSAGE` / `FLIGHT NOT FOUND` / `PLANNED LEG NOT FOUND` / `DATALINK INVALID ID` | Server-side or scope-staleness faults; not expected from normal use of this app's own pages |
| `DATALINK BUSY` / `DATALINK OFFLINE` / `DATALINK NOT SUPPORTED` / `DATALINK HOST FAULT` | A local fault in the relay between the webview and the sidecar, not a server response |

**Clearance page text** (`DL-CLEARANCE-CONFIRM`, `DL-CLEARANCE`):

| CDU text | When |
|---|---|
| `CLEARANCE>` | `DL-INDEX` R5 prompt; always shown |
| `REQUEST CLEARANCE` | `DL-CLEARANCE-CONFIRM` title |
| `LEG <id>` | The leg a pending or in-flight request targets |
| `SENDING` | The request is in flight |
| `CLEARANCE LEG CHANGED` | `SEND*` was pressed but the scope moved to a different leg since the confirm page opened; nothing was sent |
| `SIMULATED CLEARANCE` | Result page marker |
| `ALREADY ISSUED` | Shown next to the pair when the server answers `200` — a clearance already existed for this leg |
| `NOT FOR REAL WORLD USE` | Fixed last line of every clearance result |
| `CLEARANCE RECEIVED` / `CLEARANCE ON FILE` | Advisory after a successful send — a new clearance, or one already on file |
| `NO CLEARANCE RECEIVED` | `DL-CLEARANCE` reached with nothing kept for the shown leg; not expected through normal navigation |
| `MESSAGES>` | `DL-CLEARANCE` R6 — opens the thread |

**Clearance-specific errors:** the CDU text appears on `DL-INDEX`'s
scratchpad right after a failed `SEND*`. The Hint column is **not** shown
there — press `R5` again for the same leg to reopen `DL-CLEARANCE-CONFIRM`,
whose `LAST REQUEST` rows then show it.

| CDU text | Hint | Meaning |
|---|---|---|
| `SCOPE UPDATE PENDING` | | `R5` was pressed while the scope hadn't yet caught up with a newly held prefiled leg; local refusal, nothing sent |
| `NO DISPATCH RELEASE ON FILE` | `IMPORT THE PLAN FROM SIMBRIEF` | The leg has no parseable dispatch release on the server — for example a Little Navmap import with no SimBrief import run for it |
| `CLEARANCE UNAVAILABLE` | `SERVER UPDATE NEEDED` | The server answered, but not on a clearance-aware route — normal before the server has the clearance route. Only the clearance flow is affected; every other DATALINK page and the flight-data uplink keep working |
| `SIDECAR UPDATE REQUIRED` | `REBUILD SIDECAR THEN RESTART APP` | This build's **sidecar** predates the clearance feature — the same code and fix DATALINK already uses for an outdated sidecar in general |
| `CLEARANCE HOST FAULT` | `SAFE TO REQUEST AGAIN` | This build's own **shell exe** predates the clearance feature; its call to the (missing) command fails outright. Fix: restart `cargo tauri dev`, which also rebuilds the sidecar first |
| `CLEARANCE NOT SUPPORTED` | | An *installed custom host* (`window.__FMC_HOST__`, for example the browser preview harness) lacks the clearance method — not this app's own shell, and restarting it does not change this |
| `CLEARANCE RESULT UNKNOWN` | `SAFE TO REQUEST AGAIN` | A sidecar or shell timeout on the request specifically — outcome unknown. Pressing `SEND*` again is safe: the server answers a repeat idempotently |
| `CLEARANCE IN PROGRESS` | | The shell or sidecar refused a concurrent clearance request underneath the app |

Every other fault the clearance flow can show reuses the same underlying
codes as DATALINK, worded for clearance — see `ERRORS` in
`ui/src/pages/clearance-vocab.js`.

## FPLN (SimBrief prefile)

FPLN is a separate feature from DATALINK above: instead of reading and
sending ACARS messages against an existing leg or flight, it imports your
latest SimBrief OFP into the msfslogger server as a new, trip-less planned
leg, which DATALINK can then be used against. It shares DATALINK's server
connection and ingest token, but has its own pages and its own state.

### Requirements

- **The msfslogger server must be on commit `92fa6f6` or later** — later than
  DATALINK's own `9a52d2d` floor. Before that, FPLN reads
  `SIMBRIEF UNAVAILABLE` (hint `SERVER UPDATE NEEDED`) and `PREFILE>` stays
  hidden; this has **no effect on DATALINK or on the regular flight-data
  uplink**.
- FPLN uses the **same ingest token already set on `CFG NETWORK`** — there is
  no extra login or setting to configure, and the token is **never shown** on
  any FPLN page, in the sidecar log, or in an event sent to the webview.
- Your **SimBrief Pilot ID is set only on the msfslogger web app** — there is
  no CDU page to enter or change it. FPLN only reads whether one is
  configured; it never writes it.

### Reaching FPLN

`MENU` → `L6` `<FPLN` opens `FPLN` (`FLIGHT PLAN`). It behaves identically
before and after `START>`.

### PREFILE flow

- `FPLN` row 2 shows `CONFIGURED` or `NOT SET` for the Pilot ID, read fresh
  each time the page opens.
- With a Pilot ID configured, `R6` `PREFILE>` opens `FPLN-CONFIRM`
  (`PREFILE SIMBRIEF`) showing `IMPORT` / `LATEST SIMBRIEF OFP` / `AS` /
  `PLANNED LEG, NO TRIP`. Nothing is sent yet — this is a staging page.
- `R6` `CONFIRM*` on that page is the one press that actually sends the
  request. It reads `SENDING` / `WAIT UP TO 30 SEC` while in flight, and the
  app makes at most one prefile request at a time: pressing `R6` again while
  sending, on `FPLN` or `FPLN-CONFIRM`, is simply ignored — the page already
  says `SENDING` and makes no second call. `PREFILE IN PROGRESS` is a
  different case: it only appears if the shell or the sidecar itself refuses
  a concurrent request underneath the app (single-flight below the
  webview).
- **PREFILE is never retried automatically**, by the webview, the shell or
  the sidecar. If the result comes back unknown (a timeout at any layer —
  `PREFILE RESULT UNKNOWN`, hint `SAFE TO PREFILE AGAIN`), pressing PREFILE
  again is safe: the server checks for a duplicate before writing, so a
  repeat for the same OFP answers `200 duplicate`, never a second leg.
- On success, `FPLN-RESULT` shows `PREFILED` (a new leg was created) or
  `ALREADY FILED` (this OFP was already prefiled), plus the label and
  `PLANNED LEG` / `LEG <id>`. Re-pressing PREFILE for an already-filed OFP
  always answers `ALREADY FILED` with the same id, never a new leg.
- A prefiled leg is trip-less: it never appears in the server's
  `ground-sessions/current`, and a flight the app later detects never links
  back to it.

### The prefiled-leg scope

Once PREFILE succeeds, DATALINK picks it up as the active scope: `DL-INDEX`'s
scope line reads `PREFILE` with `R1` `CLR PREFILE>`, and the id itself moves
to its own row, `PREFILED LEG` / the bare id (both blank when nothing is
held); `DL-THREAD`'s label row reads `PREFILE <id>`, with the id. DATALINK's
message thread, `WX REQUEST` and `LOADSHEET` all target that leg.
Precedence: an active flight always wins over a prefiled leg, which in turn
wins over any ground-session leg the server reports.

The prefiled leg is cleared automatically the moment a flight is detected, if
the leg itself is gone from the server (a `404`), on a token rejection, or on
a `CFG NETWORK` change that alters the server URL or token; it is also
cleared manually with `CLR PREFILE>` — `DL-INDEX` `R1` or `FPLN` `R3` — which
answers `PREFILE CLEARED` and returns DATALINK to whatever scope applies
without it. It lives only in the sidecar's memory: it is not saved to
`config.json` and does not survive a sidecar restart. A newer successful
PREFILE simply replaces the leg already held.

### Timeouts

PREFILE waits longer than every other FPLN/DATALINK request: up to 25 s for
the sidecar's own request to the server, and up to 30 s for the shell before
it gives up and reports `PREFILE RESULT UNKNOWN` itself. Every other FPLN
request (the Pilot ID check, clearing) keeps the existing 8 s / 12 s bounds.

### FPLN vocabulary

**Pilot ID and prefile outcome** (`FPLN` rows 2 and 10):

| CDU text | Hint | Meaning |
|---|---|---|
| `CONFIGURED` | | The server has a SimBrief Pilot ID on file |
| `NOT SET` | `SET PILOT ID ON SERVER` | No Pilot ID is configured; set it on the msfslogger web app |
| `SENDING` | | The prefile request is in flight |
| `PREFILED` | | A new planned leg was created from the latest OFP |
| `ALREADY FILED` | | This OFP was already prefiled; same leg id, nothing new written |
| `NONE` | | No prefile attempt yet this session |

**SimBrief-specific errors** (shown on `FPLN` row 2 or row 10):

| CDU text | Hint | Meaning |
|---|---|---|
| `NO SIMBRIEF PILOT ID` | `SET PILOT ID ON SERVER` | The server has no Pilot ID configured for this prefile |
| `SIMBRIEF ID NOT FOUND` | `CHECK PILOT ID ON SERVER` | The configured Pilot ID doesn't resolve on SimBrief |
| `NO SIMBRIEF OFP` | `GENERATE OFP ON SIMBRIEF` | The Pilot ID has no current OFP to import |
| `SIMBRIEF TIMEOUT` | `TRY AGAIN SHORTLY` | The server's own call to SimBrief timed out |
| `SIMBRIEF NO COMM` | `TRY AGAIN SHORTLY` | The server couldn't reach SimBrief |
| `SIMBRIEF ERROR` | `TRY AGAIN SHORTLY` | SimBrief answered with an unexpected status |
| `SIMBRIEF BAD DATA` | `TRY AGAIN SHORTLY` | SimBrief's response wasn't usable |
| `SERVER DB ERROR` | | The server failed to write the imported leg |
| `SIMBRIEF UNAVAILABLE` | `SERVER UPDATE NEEDED` | The server answered, but predates SimBrief prefile support (older than commit `92fa6f6`) |
| `PREFILE RESULT UNKNOWN` | `SAFE TO PREFILE AGAIN` | A sidecar or shell timeout on the prefile specifically — outcome unknown; see "PREFILE flow" above |
| `PREFILE IN PROGRESS` | | The shell or sidecar refused a concurrent prefile request underneath the app; not shown for a repeat press on `FPLN`/`FPLN-CONFIRM`, which is silently ignored while `SENDING` |

**Prefiled-leg scope and advisories:**

| CDU text | When |
|---|---|
| `CLR PREFILE>` | Shown on `DL-INDEX` R1 and `FPLN` R3 whenever a prefiled leg is held |
| `PREFILE CLEARED` | Advisory after a successful `CLR PREFILE>` |
| `SIMBRIEF PLAN PREFILED` | Advisory after a `PREFILED` result |
| `PLAN ALREADY FILED` | Advisory after an `ALREADY FILED` result |

Every other fault FPLN can show (a rejected token, a busy or outdated
sidecar, no config, and so on) reuses the same underlying codes as DATALINK,
worded to fit FPLN's own rows — see `errorText`/`errorHint` in
`ui/src/pages/fpln-vocab.js`.

## Troubleshooting

The failure modes below are the same ones `agent/README.md` documents; this
maps each to what you'll see on this app's `STATUS` page instead of an agent
log line.

| Failure | `agent/README.md` symptom | This app's `STATUS` page |
|---|---|---|
| Self-signed certificate not trusted | `fetch` throws `DEPTH_ZERO_SELF_SIGNED_CERT`, agent keeps retrying and logging the error | Backend line reads `ACARS CERT FAULT`. Fix: set the correct PEM path on `CFG NETWORK`, L3, and save |
| Token mismatch | Server responds `401`, agent logs it and keeps retrying | Backend line reads `ACARS REJECT 401`. Fix: re-enter the token on `CFG NETWORK`, L2, to match the server's `INGEST_TOKEN`, and save |
| Wrong `--sim` / SimConnect protocol mismatch | The connection handshake fails, agent keeps retrying with backoff | Sim line stays on `SIM LINK RETRY {ss}S` and never reaches `SIM LINK ONLINE`. Fix: set the correct version on `CFG SIM`, L1, and save — no restart needed |
| Server unreachable (down, wrong host/port, network path broken) | `ECONNREFUSED`/`ETIMEDOUT`, agent keeps retrying | Backend line reads `ACARS NO COMM`. The sim line is unaffected — if MSFS is connected it stays `SIM LINK ONLINE`, which is the signal that this is a server-side problem, not a SimConnect one |
| MSFS not running yet | Agent logs repeated connect failures | Sim line cycles `SIM LINK CONNECTING` → `SIM LINK RETRY {ss}S`; backend line reads `ACARS READY` if the server itself is reachable, because there's nothing to send yet — that split is the tell that MSFS, not the server, is the problem |
| Invalid entry on a config page | N/A (agent read env vars, so a bad value just failed at startup) | The scratchpad shows a one-line reason (`INVALID ENTRY`, `ENTRY OUT OF RANGE`) immediately, before it's saved; nothing is written to the config file |
| Hand-edited `config.json` made invalid | N/A | App line reads `CONFIG INVALID`; the window stays open and usable. Fix the field named in the log/scratchpad on its CFG page, or fix the file by hand and press `RESTART>` |
| Sidecar rebuilt/updated but the app not restarted (or vice versa) | N/A | Any `DATALINK` page reads `SIDECAR UPDATE REQUIRED` with hint `REBUILD SIDECAR THEN RESTART APP`. Fix: `npm --prefix sidecar run build`, then restart `cargo tauri dev` (or reinstall/relaunch a built app) |
| Server predates DATALINK support | N/A | Any `DATALINK` page reads `DATALINK UNAVAILABLE` with hint `SERVER MAY PREDATE DATALINK`. The flight-data uplink (`STATUS` page) is unaffected. Fix: restart the server onto commit `9a52d2d` or later, when you choose to |
| Wrong ingest token, DATALINK specifically | N/A | Any `DATALINK` page reads `INGEST TOKEN REJECTED` with hint `CHECK INGEST TOKEN ON CFG NETWORK`, and DATALINK stops polling until the token is corrected. Fix: re-enter the token on `CFG NETWORK`, L2, and save |
| Server has DATALINK but predates SimBrief prefile | N/A | `FPLN` reads `SIMBRIEF UNAVAILABLE` with hint `SERVER UPDATE NEEDED`, and `PREFILE>` stays hidden. DATALINK itself is unaffected. Fix: restart the server onto commit `92fa6f6` or later, when you choose to |
| Server predates the clearance route | N/A | After `DL-CLEARANCE-CONFIRM` `SEND*`, `DL-INDEX`'s scratchpad reads `CLEARANCE UNAVAILABLE`; press `R5` again to see the hint, `SERVER UPDATE NEEDED`, on the reopened confirm page. Every other DATALINK page and the flight-data uplink are unaffected. Fix: restart the server onto a build with the clearance route, when you choose to |
| Sidecar predates the clearance feature | N/A | After `SEND*`, `DL-INDEX` reads `SIDECAR UPDATE REQUIRED` — the same text and fix as the "Sidecar rebuilt/updated…" row above |
| This app's own shell exe predates the clearance feature | N/A | After `SEND*`, `DL-INDEX` reads `CLEARANCE HOST FAULT` — the webview's call to the missing command fails outright. Fix: restart `cargo tauri dev` (or reinstall/relaunch a built app); this also rebuilds the sidecar first, through `beforeDevCommand` |
| An installed custom host lacks the clearance method | N/A | After `SEND*`, `DL-INDEX` reads `CLEARANCE NOT SUPPORTED`, with no hint. Only relevant with a non-Tauri host installed (`window.__FMC_HOST__`, for example the browser preview harness) — not expected in this app's own shell, and restarting it does not fix this |

## Manual test plan (run this on the Windows box)

This is the sign-off procedure for the five user-story acceptance criteria:

- **AC1** — a Tauri client can connect to the backend server
- **AC2** — every connection setting is configurable through the UI, no
  required CLI/env var
- **AC3** — connection status visibly changes in the UI, with the connected
  state labeled `ACARS UPLINK`
- **AC4** — the UI style and labels are FMC-inspired
- **AC5** — functionally matches the existing CLI agent

Prerequisites: the app built per [Build and run](#build-and-run-windows)
above, Node 20 available, and the msfslogger server reachable with a known
`INGEST_TOKEN`.

| # | Step | Expected observation | Proves |
|---|---|---|---|
| 1 | Launch the app with no config file present (rename or delete `%APPDATA%\msfslogger\config.json` first if one exists) | Window opens on `STATUS`. App line reads `NO CONFIG`, sim line `SIM LINK STANDBY`, backend line `ACARS STANDBY`. No console window flashes. Nothing crashes or loops | AC1 |
| 2 | `MENU` → `<NETWORK`, type the server URL, `L1`; type the token, `L2`; type the certificate path, `L3`; press `SAVE>` (`R6`) | Each value appears on its line; the token shows as `••••••••`; scratchpad shows `CONFIG SAVED`; `%APPDATA%\msfslogger\config.json` now exists with those values | AC2 |
| 3 | `MENU` → `<SIM`, set version to `2024`; `MENU` → `<TRAFFIC`, set radius to `60000`, `SAVE>` | Values persist when you navigate away and back; the file shows `"sim":"2024"`, `"trafficRadiusM":60000` | AC2 |
| 4 | On `CFG TRAFFIC`, type `500` and press the radius LSK | Scratchpad shows `ENTRY OUT OF RANGE`; the field doesn't change; nothing is saved | AC2, negative test |
| 5 | On `CFG NETWORK`, type `ftp://x` and press `L1` | Scratchpad shows `INVALID ENTRY`; field unchanged | AC2, negative test |
| 6 | With MSFS **not** running, press `START>` on `STATUS` | App line: `UPLINK ACTIVE`. Sim line cycles `SIM LINK CONNECTING` → `SIM LINK RETRY 05S`, then `10S`, `20S`, … capping at `60S` — sim not running | AC1, AC3, negative test |
| 7 | Start MSFS and load a flight | Sim line → `SIM LINK ONLINE`; within a second, backend line → **`ACARS UPLINK`**; the server's web UI header shows `Connected · Idle` (then `Recording · <aircraft>` once a flight starts) and the live map starts moving | AC1, AC3, AC5 |
| 8 | Press `ESC` in the sim (full pause), then trigger Active Pause | Pause line → `SIM PAUSED`, then `ACTIVE PAUSE`. The server's flight clock stops in both cases | AC5 |
| 9 | With traffic ON, watch the server's live map at a busy airport | AI aircraft appear and move; parked aircraft don't | AC5 |
| 10 | Stop the msfslogger server while flying, then restart it | Backend line → `ACARS NO COMM` while sim line stays `SIM LINK ONLINE` — server unreachable | AC3, negative test |
| 10b | (continuing from 10) Restart the server | Backend line returns to `ACARS UPLINK` with no action on the Windows box | AC3, AC5 |
| 11 | Press `STOP>`, then close the window | App line → `UPLINK STOPPED`, backend line → `ACARS STANDBY`. After closing, Task Manager shows **no** `node.exe` left from this app, and the server marks the agent disconnected | AC1 |
| 12 | Set a deliberately wrong token on `CFG NETWORK`, `SAVE>`, `START>` with MSFS running | Backend line → `ACARS REJECT 401` (server 401); sim line stays `SIM LINK ONLINE` | AC3, negative test |
| 13 | Clear the certificate path while the server runs HTTPS, `SAVE>` | Backend line → `ACARS CERT FAULT` — untrusted certificate, distinct from a generic network failure | AC3, negative test |
| 14 | Hand-edit `config.json` to `"sim": "2019"` (an invalid value), then press `RESTART>` (or relaunch) | App line → `CONFIG INVALID` naming `sim`; window stays up and usable; fixing it in the UI recovers without a relaunch | AC2, negative test |
| 15 | Set `autoUplink` to `true` on `CFG SIM`, quit, relaunch | The uplink starts by itself with no `START>` press; set it back to `false` and it doesn't | AC2 |
| 16 | Compare against the old agent: stop this app, run `node agent.js --sim 2024` from `agent/` with the equivalent environment variables, fly for a minute | Identical server-side behaviour to steps 7–9 — same frames, same events, same traffic | AC5 |

Acceptance-criterion coverage: **AC1** — steps 1, 7, 11. **AC2** — steps 2, 3,
4, 5, 14, 15. **AC3** — steps 6, 7, 10, 12, 13. **AC4** — every step above is
performed through the FMC panel's own vocabulary and LSK/scratchpad
interaction model, rather than a settings dialog or a config file edited by
hand; steps 4, 5, and 14 specifically exercise its FMC-style error feedback
(`INVALID ENTRY`, `ENTRY OUT OF RANGE`, `CONFIG INVALID`). **AC5** — steps 7,
8, 9, 16.

Negative tests, one per failure mode named in [Troubleshooting](#troubleshooting):
wrong token → step 12 (`ACARS REJECT 401`); untrusted certificate → step 13
(`ACARS CERT FAULT`); sim not running → step 6 (`SIM LINK RETRY {ss}S` /
`ACARS READY`); server unreachable → step 10 (`ACARS NO COMM`); invalid
config-UI entry → steps 4, 5, 14 (`ENTRY OUT OF RANGE`, `INVALID ENTRY`,
`CONFIG INVALID`).

## Verification done on this machine

This machine has no Windows, no WebView2, and (as shown above) a Rust
toolchain below the pinned minimum, so none of the following was executed
here and each remains to be signed off with the plan above:

- `cargo build` / `cargo tauri build` of the actual Rust shell
- `cargo tauri dev` / a running window
- WebView2 rendering of the FMC panel (headless Chromium screenshots stood in
  for this during development — a different rendering engine, evidence of
  structure and labels only, not of on-screen appearance)
- A live SimConnect session against a running MSFS (every connect attempt
  here fails immediately with `ECONNREFUSED`, which is what exercises the
  retry ladder but not a real `recvOpen`)

What *was* run here, under Node 20, and is current as of this writing:

```
$ npx tsc --noEmit -p windows-client/sidecar/tsconfig.json
(clean)
$ npx vitest run --config windows-client/sidecar/vitest.config.ts
 Test Files  6 passed (6)
      Tests  175 passed (175)
$ node windows-client/sidecar/dist/inspect-config.js windows-client/sidecar/samples/config/good.json
(prints the parsed, redacted config; exit 0)
$ for f in windows-client/sidecar/samples/config/bad-*.json; do node windows-client/sidecar/dist/inspect-config.js "$f"; done
(every one exits 1 with a one-line reason)
$ node windows-client/tools/contract-check.mjs
(every Rust↔webview command/event name matches; exit 0)
```

`agent/` was not touched by this run and remains available, unmodified, as
the fallback if this app doesn't work out on your box.
