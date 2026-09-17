# Troubleshooting

Symptom → cause → fix, grouped by area. For the full CDU vocabulary tables
referenced below, see [cdu-reference](cdu-reference.md). For where to look
while diagnosing, see [Diagnostics](#diagnostics) at the end of this file and
[operations](operations.md).

## App / sidecar won't start

| Symptom | Cause | Fix |
|---|---|---|
| `STATUS` reads crashed at launch, message line "Sidecar entry missing; tried X and Y" | The shell first tries the bundled resource `sidecar/dist/index.js` (copied next to the exe in both `cargo tauri dev`'s `target\debug` and a packaged build); if that's missing it falls back to `sidecar/dist/index.js` beside `src-tauri/`. Neither exists | `npm --prefix sidecar run build` to produce `sidecar/dist/`, then relaunch |
| `STATUS` reads crashed, "Cannot launch sidecar; install Node 20 on PATH or set nodePath..." | `node` (or the configured `nodePath`) failed to spawn | Install Node 20 on `PATH`, or set `nodePath` in the config to a valid `node.exe` |
| `STATUS` reads crashed, "Cannot start sidecar input/output writer/reader" | Pipe setup failed immediately after spawn | The child was killed before it could run; retry, or check antivirus/EDR interference |
| App keeps cycling `SIDECAR RESTART` and eventually sticks on `SIDECAR FAULT` with an `R5` prompt | 5 restarts exhausted in a rolling 60 s window; the shell crash-latches to stop looping forever | Fix the underlying cause (often a bad config or missing Node), then press `R5` on `STATUS` to clear the budget and force a restart |
| Sidecar exits repeatedly right after each restart | Usually a config or environment problem that reproduces every launch, not a transient fault | Check the `cargo tauri dev` terminal's stderr for the sidecar's own error before it exited |

## Config

| Symptom | Cause | Fix |
|---|---|---|
| App axis reads `NO CONFIG` | No config file exists yet at the resolved path | `MENU` → `<NETWORK`, fill in at least the server URL and token, `SAVE>` |
| App axis reads `CONFIG INVALID` | Config file exists but fails validation; the field is named in the log/scratchpad. One specific cause: `certPath` is set but the sidecar can't read that file — an unreadable cert path invalidates the whole config, not just the TLS connection | Fix the named field on the matching CFG page and save again, or fix the file by hand and press `RESTART>` |
| A hand-edited `config.json` is now invalid and the app won't pick it up | Same as above, but edited outside the app | The window stays open and usable at `CONFIG INVALID`; fixing the field in the UI recovers without a relaunch |
| `config_set` fails, file left untouched | The existing file is present but corrupt/non-UTF-8/invalid JSON/not a JSON object | The shell deliberately refuses to overwrite a file it can't parse, rather than discarding unknown keys — fix or delete the file by hand, then save again from the UI |
| `config_set` fails: "close other instances or remove a stale temporary file" | A leftover `config.json.tmp` from an interrupted write sits next to the target | Delete the stale `.json.tmp` file (with the app closed), then save again |

## SimConnect

| Symptom | Cause | Fix |
|---|---|---|
| Sim axis cycles `SIM LINK CONNECTING` → `SIM LINK RETRY {ss}S`, never reaches `SIM LINK ONLINE` | MSFS isn't running yet, or the SimConnect handshake keeps failing | Start MSFS and load into a flight; the sidecar retries on its own with backoff 5s→10s→20s→40s, capping at 60s — no restart needed |
| Sim axis stays on `SIM LINK RETRY {ss}S` even with MSFS running | Wrong SimConnect protocol version selected | Set the correct version on `CFG SIM`, L1 (`2020`/`2024`/`fsx`), and save — takes effect without a restart |
| Backend axis reads `ACARS READY` while sim is retrying | Server is reachable but there's nothing to send yet, because the sim link is down | Confirms the problem is MSFS/SimConnect, not the server — if it were server-side, backend would read `ACARS NO COMM` instead |

## Backend uplink

| Symptom | Cause | Fix |
|---|---|---|
| Backend axis reads `ACARS REJECT 401` | The server rejected a post — token mismatch | Re-enter the token on `CFG NETWORK`, L2, to match the server's ingest token, and save |
| Backend axis reads `ACARS FAULT {status}` | Server rejected a post with some other non-2xx status | Check the server's own logs for what it didn't like |
| Backend axis reads `ACARS CERT FAULT` | TLS handshake failed — the server's certificate isn't trusted. With `certPath` set, the sidecar trusts *only* that CA in place of the system's default trust store (Node's `ca` option replaces the defaults, it doesn't add to them) | Fix or set the certificate path on `CFG NETWORK`, L3, to the exact PEM the server presents |
| Backend axis reads `ACARS NO COMM` | Can't reach the server at all (refused, timed out, DNS failure) | Check the server is running and the URL/network path is correct |
| Backend axis stays on `ACARS CONNECTING` for a long time before finally showing `ACARS NO COMM` | **Current limitation**: neither ingest requests (frame/event/traffic posts) nor the 15 s reachability probe set their own request timeout, and ingest requests follow redirects by default, resending the ingest token to wherever the redirect points. A server that accepts the connection and then never answers can hold a request open for up to about 5 minutes — undici's own default headers timeout — before it fails and the Backend axis reports `ACARS NO COMM` | Not user-fixable from the CDU; if the axis is taking minutes to fault, check the server is actually responding, or restart it |

## DATALINK / FPLN / PDC error codes

These relay-level codes can surface from any DATALINK, FPLN or clearance
request, worded per feature — see [cdu-reference](cdu-reference.md) for the
exact CDU text per page.

| Code | Cause | Fix |
|---|---|---|
| `sidecar-outdated` | The running sidecar's `hello` doesn't advertise the feature (`datalink`/`simbrief-prefile`/`pdc-clearance`) this shell expects | `npm --prefix sidecar run build`, then restart the app |
| `shell-timeout` | No answer from the sidecar within the shell's relay budget (12 s general, 30 s for prefile) | Outcome unknown for a write. Whether a retry is safe depends on the op: **clearance** and **SimBrief prefile** are safe to press again — the server itself deduplicates (a repeat clearance answers with the same rows and `ALREADY ISSUED`; a repeat prefile answers `ALREADY FILED` for the same OFP), so a retry never writes twice. A **canned downlink, WX request or loadsheet request** carries no such dedup id — the server has no way to recognize a resend as the same request, so retrying after a timeout can send or request a second time. For a canned downlink specifically, open `DL-THREAD` first to check whether the message actually went out before pressing `SEND*` again |
| `busy` | The relay already has `PENDING_MAX` (8) datalink/clearance/prefile requests outstanding, so a 9th concurrent request is refused before it reaches the sidecar; the same code also covers the shell's internal operation/stdin queues being full | Wait for an in-flight request to resolve, then retry |
| `sidecar-exited` | The sidecar died mid-request | The shell restarts it automatically; retry once it's back |
| `prefile-in-progress` / `clearance-in-progress` | A second press while one request is already outstanding | Refused before reaching the sidecar — no duplicate write; wait for the first to resolve |
| `host-unsupported` (shown as `…NOT SUPPORTED`) | An installed custom host (not this app's own Tauri shell — e.g. the browser preview harness) lacks the method | Not fixable by restarting this app's own shell |
| `host-error` (shown as `…HOST FAULT`) | This build's own shell exe predates the feature; its call to the missing command fails outright | Restart `cargo tauri dev` (or relaunch a built app) — this also rebuilds the sidecar first |
| `token-invalid` (shown as `INGEST TOKEN REJECTED`) | Server confirmed the token is wrong; DATALINK/FPLN/clearance stop polling/retrying until the config is corrected and re-saved | Re-enter the token on `CFG NETWORK`, L2, and save |
| `unavailable` (shown as `…UNAVAILABLE`) | Server answered, but not on a feature-aware route — the server predates DATALINK/SimBrief prefile/the clearance route | Upgrade the server to a build with the route |

## Preview harness

| Symptom | Cause | Fix |
|---|---|---|
| `npm run dev:gauge` / `tools/dev-gauge.ps1` fails to bind its port | Something else is already listening on 8380 (the default) | Pass `-Port <n>` to `tools/dev-gauge.ps1`, or set the equivalent option for `node gauge/dev/server.mjs` directly |
| `ui/tools/render-check.mjs` or `ui/tools/host-swap-check.mjs` fail with `ERR_MODULE_NOT_FOUND` | `puppeteer` is not an installed dependency in this checkout | These checks need `puppeteer` installed; they are not part of the default check set, so skip them unless you have added it |

## Toolchain

| Symptom | Cause | Fix |
|---|---|---|
| `npm --prefix sidecar test` fails every file with `Cannot read properties of undefined (reading 'config')` | Vitest was run from Git Bash, whose `/c/...` lowercase-drive path confuses its working-directory detection | Run the same command from PowerShell instead, with the working directory at the repository root |
| A sidecar TLS test fails with `spawnSync openssl ENOENT` | `openssl` isn't resolvable on `PATH` for that shell | Prepend `C:\Program Files\Git\usr\bin` to `PATH` for that command |

## Diagnostics

Where to look, in order of how much detail each gives:

1. **The `cargo tauri dev` terminal's stderr** — the shell's own log line for
   every sidecar log message, exit, and restart; the only place a fast
   crash-loop's actual cause survives (the CDU scratchpad only ever shows
   the *latest* message).
2. **`STATUS` page** — the four axes plus the config file path (bottom of
   the page), so you can confirm which file the running instance is reading.
3. **The CDU scratchpad** — the latest error/advisory text from whichever
   page you're on; see [cdu-reference](cdu-reference.md) for what each one
   means.
4. **The config file path line on `STATUS`** — confirms the exact file the
   sidecar resolved, useful when `MSFSLOGGER_CONFIG` or `--config` might be
   pointing somewhere unexpected.

To validate a config file outside the running app:

```powershell
node sidecar/dist/inspect-config.js --config <path>
```

(A positional path argument also works: `node sidecar/dist/inspect-config.js
<path>`.) It prints the resolved path and, on success, the effective config
with the ingest token redacted; on failure it prints one line per invalid
field and exits non-zero. Requires `sidecar/dist/` to exist —
`npm --prefix sidecar run build` first if it doesn't.

Do not run `inspect-uplink` against a real server outside a deliberate,
disposable test: it POSTs a synthetic frame/event/traffic batch to whatever
server the config points at, writing into a real logbook. `inspect-datalink`
is read-only GETs and safe to run against a real server.

For log locations, the sidecar↔shell protocol, and how to read the shell's
in-memory log ring, see [operations](operations.md).
