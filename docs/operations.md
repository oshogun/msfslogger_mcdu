# Operations

Running, watching and diagnosing the client once it's built.

## Running modes

- **Dev**: `cargo tauri dev` from the repository root. Builds the sidecar
  first (`beforeDevCommand`), opens the Tauri shell's window, and the shell
  supervises the sidecar as a child process for the life of the window.
- **Installed app**: the MSI/NSIS installer's app, same supervised-sidecar
  model, built per [release.md](release.md).
- **Standalone sidecar**: `node sidecar/dist/index.js --config <path>` runs
  the sidecar with no shell at all, speaking the shell↔sidecar protocol
  (line-delimited JSON on stdin/stdout) directly. This is for scripting or
  debugging the sidecar in isolation — feeding it `start`/`stop`/`config`/
  `shutdown`/`datalink-request` lines by hand or from a test harness, not for
  normal use.

## Monitoring

- `STATUS` page: four axes, always shown — App (sidecar alive / uplink
  intent), Sim (SimConnect link), Backend (server uplink), Pause (MSFS pause
  state) — plus the traffic advisory line and the resolved config path.
- The scratchpad shows the latest log/error line as it happens.
- The Rust shell keeps a 200-entry in-memory ring of recent log lines,
  pushed to the webview as `sidecar:log` events; nothing older survives a
  restart.
- The resolved config path is shown on `STATUS` itself, so you can confirm
  which file the running instance is actually using.

## Logs

- No log files exist anywhere in normal operation.
- Shell-side text (its own log lines and the sidecar's log messages it
  relays) goes to the Tauri process's own stderr — visible in the
  `cargo tauri dev` terminal. This is deliberate: the CDU scratchpad only
  shows the latest message, so a fast crash loop's cause would otherwise be
  lost.
- The sidecar's stdout carries protocol lines only, never human text. The
  sidecar's own stderr receives output only for genuinely unexpected
  process-level failures (an uncaught exception or unhandled rejection) —
  the sidecar survives these and keeps running; the shell's restart budget is
  not involved.
- Every log line and status value that could carry the ingest token is
  redacted to `[REDACTED]` before it's written or emitted, on both the shell
  and sidecar sides. The token itself never appears in argv or environment
  variables.

## Supervisor behaviour

The shell's supervisor manages the sidecar child process:

- Fixed 2-second delay before each restart after an unexpected exit.
- A restart budget of 5 restarts per rolling 60-second window; exhausting it
  crash-latches the app — no further automatic restart until you press
  `RESTART>` on `STATUS`, which also clears the budget.
- On shutdown, the supervisor sends a `shutdown` control frame, closes stdin,
  waits up to a 2-second grace period for the sidecar to exit on its own,
  then terminates the process if it hasn't.

## Diagnostics CLIs

All three read the same config file resolution as the sidecar itself
(`--config` → `MSFSLOGGER_CONFIG` → platform default); none needs the app or
the shell running.

- **`node sidecar/dist/inspect-config.js [path]`** — local only. Resolves,
  loads and validates a config file, prints it with the token redacted, exits
  0 if the sidecar would accept it or 1 with a one-line reason per bad field.
- **`node sidecar/dist/inspect-datalink.js --config <path>`** — read-only
  GETs against the msfslogger server: walks the datalink routes, resolves
  scope, fetches the current thread if one exists, checks SimBrief Pilot ID
  status. Safe to run against a real server.
- **`node sidecar/dist/inspect-uplink.js --config <path>`** — **WARNING: this
  posts one synthetic flight-data frame, one synthetic event and one
  synthetic traffic batch to the configured server**, then runs the
  reachability probe. It writes into the real logbook the configured server
  points at. Only run it against a server and config you're prepared to see
  a synthetic entry land in — never against a production logbook you care
  about staying clean.

## Backup and recovery

- The only file worth backing up is `config.json` — it contains the ingest
  token, so store any backup copy as securely as you'd store the token
  itself.
- **Corrupt config**: if the shell reports the file present but unreadable,
  non-UTF-8, invalid JSON, or not a JSON object, saving from the CDU is
  refused (the file is left untouched) until you fix it by hand at the path
  shown on `STATUS`, or delete it to start over.
- **Stale `.json.tmp`**: a `config.json.tmp` sibling left behind by a crash
  mid-save (or a second running instance) blocks the next save with "close
  other instances or remove a stale temporary file." Close any other running
  instance first; if none is running, delete the `.json.tmp` file and retry.
- There is nothing else to back up — the client keeps no other local data;
  the logbook itself lives on the msfslogger server.

## Common operational failures

See [troubleshooting.md](troubleshooting.md) for symptom-to-fix tables
covering sidecar launch failures, SimConnect link problems, ingest/backend
faults, and DATALINK/SimBrief/clearance failure states.
