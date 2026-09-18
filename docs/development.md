# Development

Repository layout, the day-to-day dev workflow, the checks this project
enforces, and how changes get made. See [index.md](index.md) for the rest of
the doc set and [architecture.md](architecture.md) for how the pieces here
talk to each other.

## Repository layout

```text
README.md                    product overview, quick start
AGENTS.md, CLAUDE.md         one-line entry points for coding agents (see below)
LICENSE
package.json, package-lock.json   root dev tooling: gauge and UI check scripts
.gitignore
.vscode/launch.json          Edge launch config for the preview harness
docs/                        this documentation set
gauge/
  README.md                  preview harness usage
  dev/                       the preview harness: server, mock host, tests
sidecar/
  src/                       the Node/TypeScript sidecar
  tests/                     vitest unit tests
  tests/fixtures/            recorded server-response fixtures (clearance/, datalink/, sayintentions/, simbrief/)
  samples/config/            good and bad sample config files used by tests and inspect-config
  package.json, tsconfig.json, vitest.config.ts
src-tauri/
  src/                       the Rust shell (main.rs, supervisor.rs, datalink.rs, config.rs, protocol.rs, framing.rs, restart.rs)
  tests/fake-sidecar.py      Python stand-in child process for the supervisor's process-lifecycle tests
  tools/check-core.py        compiles the portable core modules without Tauri/WebView dependencies
  gen/                       Tauri-generated capability/ACL schemas (tracked)
  icons/                     app icons for the installer
  capabilities/              Tauri v2 capability files
  Cargo.toml, tauri.conf.json, build.rs
ui/
  index.html, css/           CDU panel markup and styling
  src/                       app.js (page router/shell), bridge.js (host contract), status.js
  src/pages/                 one module per CDU page
  tools/                     boundary-check.mjs, render-check.mjs, host-swap-check.mjs
tools/
  contract-check.mjs         checks every Tauri command/event name matches between src-tauri/ and ui/src/bridge.js
  dev-gauge.ps1               launches the preview harness
```

`AGENTS.md` and `CLAUDE.md` are the entry points Codex and Claude Code use for
this project's coding-agent workflow; both point into a local, gitignored
workflow directory that isn't part of the product and isn't documented here.

## Dev workflow

**CDU panel work** happens in the preview harness, not against the live app.
Run it per [gauge/README.md](../gauge/README.md); it loads the real `ui/`
files with a mock host, reloads on save, and never touches `sidecar/` or
`src-tauri/`.

**Sidecar work** (`sidecar/`, Node/TypeScript):

```powershell
npm --prefix sidecar run typecheck
npm --prefix sidecar test
npm --prefix sidecar run build
```

**Shell work** (`src-tauri/`, Rust) — if the user's `cargo tauri dev` is
already running, remember that **saving any file under `src-tauri/` rebuilds
and relaunches it**; make edits in coherent, compiling steps.

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --offline
```

**The full app** runs with `cargo tauri dev` from the repository root, which
builds the sidecar first and launches the shell with a live-reloading
webview.

## Code standards

- **TypeScript**: `sidecar/tsconfig.json` sets `strict: true`, plus
  `esModuleInterop`, `skipLibCheck`, `forceConsistentCasingInFileNames` and
  `resolveJsonModule`, targeting `ES2022`/CommonJS. `npm --prefix sidecar run
  typecheck` enforces it.
- **Rust**: formatted with `rustfmt`; `cargo fmt --manifest-path
  src-tauri/Cargo.toml -- --check` must be clean.
- **UI ownership boundaries**: `ui/tools/boundary-check.mjs` (`npm run
  check:ui`) enforces eight rules — `bridge-import` (only `app.js` may import
  `bridge.js`), `tauri-reference` (`__TAURI__`/`__TAURI_INTERNALS__` appear
  only in `bridge.js`), `host-global` (`__FMC_HOST__`/`__FMC_STUB__` appear
  only in `bridge.js`), `page-adapter` (no page names the adapter itself),
  `page-global` (no page references `FMC`), `page-events` (no page subscribes
  to `onLog`/`onExit`/`onDatalink` directly), `adapter-leak` (`app.js` never
  exposes `bridge` as an interface member), `interface-members` (every named
  interface member is actually present on `app.js`'s built interface —
  `npm run check:ui` currently reports all thirty-one present).
- **Host contract changes**: adding or changing a Tauri command or event
  needs a matching Rust `#[tauri::command]`/emit *and* a matching entry in
  `ui/src/bridge.js`, verified by `node tools/contract-check.mjs` — see
  [api.md](api.md).
- **Secrets**: never appear in logs or process argv. The shell redacts every
  remembered token from its own stderr, cached status/log text and datalink
  responses (`src-tauri/src/config.rs`); the sidecar never puts the token on
  the command line either. Tests use `SENTINEL-TOKEN`/`PLACEHOLDER-TOKEN`
  values and assert the real one never appears.
- **Dependencies are exact-pinned**: `sidecar/package.json` pins every
  dependency and devDependency with no `^`/`~`; `src-tauri/Cargo.toml` pins
  `tauri`, `tauri-build`, `serde` and `serde_json` with a leading `=`.

## Testing strategy

Tests that need a config use a temporary one, never the real
`%APPDATA%\msfslogger\config.json` — the sidecar's `--config <path>` flag or
the `MSFSLOGGER_CONFIG` environment variable, and a sentinel token, never a
real one.

| Check | Covers | Runs where | Prerequisites |
| --- | --- | --- | --- |
| `npm --prefix sidecar run typecheck` | Strict TypeScript type-check of `sidecar/src` | Any OS, Node 20 | none |
| `npm --prefix sidecar test` | Sidecar unit tests: config, protocol, status, SimConnect, traffic, uplink, datalink client/classify/model/scope/service, clearance/SimBrief/SayIntentions models, sentinel tests that assert secrets never leak, entrypoint | Any OS, Node 20 | TLS tests spawn `openssl`; on Windows it resolves from `C:\Program Files\Git\usr\bin` |
| `npm --prefix sidecar run build` | Compiles `sidecar/src` to `sidecar/dist` | Any OS, Node 20 | none |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Rust formatting | Any Rust toolchain | none |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline` | Rust unit tests plus process-lifecycle tests that spawn `src-tauri/tests/fake-sidecar.py` as a stand-in sidecar | Windows (this project) | `python` on PATH; uses real sleeps, takes roughly ten seconds |
| `python src-tauri/tools/check-core.py` | Compiles `config`/`framing`/`protocol`/`restart`/`supervisor` as a standalone crate with no Tauri/WebView dependency, then runs `cargo test` against it; proves the portable core has no hidden dependency on the Tauri crate | Any OS with `cargo` | Point `CARGO_TARGET_DIR` at a scratch directory — the default target dir may be the locked `cargo tauri dev` build |
| `supervisor.rs`'s Linux-only test module | Extra process-lifecycle assertions that only compile under `#[cfg(all(test, target_os = "linux"))]` | Linux only | Not exercised by the commands above on Windows |
| `node tools/contract-check.mjs` | Every Tauri command/event name matches between `src-tauri/` and `ui/src/bridge.js`, and datalink relay timeouts stay ahead of the sidecar's own HTTP timeouts | Any OS, Node | none |
| `npm run check:ui` | The eight UI ownership-boundary rules above | Any OS, Node | none |
| `npm run test:gauge` | Preview harness: mock host, dev server, datalink/SimBrief/clearance/SayIntentions vocab and session modules, and full CDU page-flow tests | Any OS, Node | none |
| `node ui/tools/render-check.mjs` | Headless-Chromium screenshot and label check against an independent STATUS-state table | Any OS, Node | Needs `puppeteer`, not installed by default |
| `node ui/tools/host-swap-check.mjs` | Proves a synthetic `window.__FMC_HOST__` can drive the real panel | Any OS, Node | Needs `puppeteer`, not installed by default |
| Manual test plan (below) | End-to-end behaviour against a real MSFS session and the real msfslogger server | A Windows box with MSFS and WebView2 | A built app, Node 20, a reachable msfslogger server, and a known ingest token |

### Manual test plan (run this on the Windows box)

This is the sign-off procedure for the client's five acceptance criteria:

- **AC1** — the client can connect to the msfslogger server
- **AC2** — every connection setting is configurable through the UI, no
  required CLI/env var
- **AC3** — connection status visibly changes in the UI, with the connected
  state labeled `ACARS UPLINK`
- **AC4** — the UI style and labels are FMC-inspired
- **AC5** — functionally matches an equivalent standalone uplink

Prerequisites: the app built per [setup.md](setup.md), Node 20 available, and
the msfslogger server reachable with a known ingest token.

| # | Step | Expected observation | Proves |
| --- | --- | --- | --- |
| 1 | Launch the app with no config file present (rename or delete `%APPDATA%\msfslogger\config.json` first if one exists) | Window opens on `STATUS`. App line reads `NO CONFIG`, sim line `SIM LINK STANDBY`, backend line `ACARS STANDBY`. No console window flashes. Nothing crashes or loops | AC1 |
| 2 | `MENU` → `<NETWORK`, type the server URL, `L1`; type the token, `L2`; type the certificate path, `L3`; press `SAVE>` (`R6`) | Each value appears on its line; the token shows as `••••••••`; scratchpad shows `CONFIG SAVED`; `%APPDATA%\msfslogger\config.json` now exists with those values | AC2 |
| 3 | `MENU` → `<SIM`, set version to `2024`; `MENU` → `<TRAFFIC`, set radius to `60000`, `SAVE>` | Values persist when you navigate away and back; the file shows `"sim":"2024"`, `"trafficRadiusM":60000` | AC2 |
| 4 | On `CFG TRAFFIC`, type `500` and press the radius LSK | Scratchpad shows `ENTRY OUT OF RANGE`; the field doesn't change; nothing is saved | AC2, negative test |
| 5 | On `CFG NETWORK`, type `ftp://x` and press `L1` | Scratchpad shows `INVALID ENTRY`; field unchanged | AC2, negative test |
| 6 | With MSFS **not** running, press `START>` on `STATUS` | App line: `UPLINK ACTIVE`. Sim line cycles `SIM LINK CONNECTING` → `SIM LINK RETRY 05S`, then `10S`, `20S`, … capping at `60S` — sim not running | AC1, AC3, negative test |
| 7 | Start MSFS and load a flight | Sim line → `SIM LINK ONLINE`; within a second, backend line → `ACARS UPLINK`; the server's web UI header shows `Connected · Idle` (then `Recording · <aircraft>` once a flight starts) and the live map starts moving | AC1, AC3, AC5 |
| 8 | Press `ESC` in the sim (full pause), then trigger Active Pause | Pause line → `SIM PAUSED`, then `ACTIVE PAUSE`. The server's flight clock stops in both cases | AC5 |
| 9 | With traffic ON, watch the server's live map at a busy airport | AI aircraft appear and move; parked aircraft don't | AC5 |
| 10 | Stop the msfslogger server while flying, then restart it | Backend line → `ACARS NO COMM` while sim line stays `SIM LINK ONLINE` — server unreachable | AC3, negative test |
| 10b | (continuing from 10) Restart the server | Backend line returns to `ACARS UPLINK` with no action on the Windows box | AC3, AC5 |
| 11 | Press `STOP>`, then close the window | App line → `UPLINK STOPPED`, backend line → `ACARS STANDBY`. After closing, Task Manager shows **no** `node.exe` left from this app, and the server marks the connection disconnected | AC1 |
| 12 | Set a deliberately wrong token on `CFG NETWORK`, `SAVE>`, `START>` with MSFS running | Backend line → `ACARS REJECT 401` (server 401); sim line stays `SIM LINK ONLINE` | AC3, negative test |
| 13 | Clear the certificate path while the server runs HTTPS, `SAVE>` | Backend line → `ACARS CERT FAULT` — untrusted certificate, distinct from a generic network failure | AC3, negative test |
| 14 | Hand-edit `config.json` to `"sim": "2019"` (an invalid value), then press `RESTART>` (or relaunch) | App line → `CONFIG INVALID` naming `sim`; window stays up and usable; fixing it in the UI recovers without a relaunch | AC2, negative test |
| 15 | Set `autoUplink` to `true` on `CFG SIM`, quit, relaunch | The uplink starts by itself with no `START>` press; set it back to `false` and it doesn't | AC2 |

Acceptance-criterion coverage: **AC1** — steps 1, 7, 11. **AC2** — steps 2, 3,
4, 5, 14, 15. **AC3** — steps 6, 7, 10, 12, 13. **AC4** — every step above is
performed through the FMC panel's own vocabulary and LSK/scratchpad
interaction model, rather than a settings dialog or a hand-edited config file;
steps 4, 5 and 14 specifically exercise its FMC-style error feedback
(`INVALID ENTRY`, `ENTRY OUT OF RANGE`, `CONFIG INVALID`). **AC5** — steps 7,
8, 9.

Negative tests, one per failure mode named in [troubleshooting.md](troubleshooting.md):
wrong token → step 12 (`ACARS REJECT 401`); untrusted certificate → step 13
(`ACARS CERT FAULT`); sim not running → step 6 (`SIM LINK RETRY {ss}S` /
`ACARS READY`); server unreachable → step 10 (`ACARS NO COMM`); invalid
config-UI entry → steps 4, 5, 14 (`ENTRY OUT OF RANGE`, `INVALID ENTRY`,
`CONFIG INVALID`).

## Branching and PRs

A single `main` branch, no CI — every check above runs locally before a
commit. Commits are small and focused, with an imperative subject line (see
`git log --oneline`: "Request a simulated PDC clearance from the CDU",
"Prefile the latest SimBrief plan from a new CDU FPLN page"). Open pull
requests against `main` on `github.com/oshogun/msfslogger_mcdu`.

## Contribution and review conventions

- Describe the behaviour change and the checks you ran in the commit message
  and/or PR description — there's no CI to fall back on, so that description
  is the only record a reviewer has.
- Update the relevant doc in the same change, not as a follow-up.
- Never commit `config.json`, tokens, `target/`, `node_modules/` or `dist/`
  (see `.gitignore`).
