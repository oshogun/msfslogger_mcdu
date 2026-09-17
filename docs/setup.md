# Setup

Bootstrapping a Windows machine to build and run the msfslogger Windows
client, and validating that the result works before you go near MSFS.

## Required versions

| Tool | Minimum | How to check | Source of the requirement |
|---|---|---|---|
| Windows | 10 or 11 | `winver` | SimConnect, WebView2 and `%APPDATA%` are Windows-only |
| Node.js | 20 | `node -v` | root `package.json` `engines.node`; the sidecar has no `engines` field but is written and tested against Node 20 |
| Rust (MSVC) | 1.88.0 | `rustc --version` | `src-tauri/Cargo.toml` `rust-version` |
| Tauri CLI | 2.x | `cargo tauri --version` | `src-tauri/Cargo.toml` pins the `tauri` library at `2.11.5`; the CLI tracks the same major |
| WebView2 runtime | any current | Settings → Apps → "WebView2 Runtime" | Tauri's webview on Windows |
| MSFS | 2020, 2024, or FSX | — | needed only to exercise the sidecar's SimConnect link; every check below runs without it |

Don't take this machine's exact installed versions as the floor — the table
above is the actual requirement each tool is pinned to.

## Bootstrap from zero

Run from an elevated PowerShell where noted.

```powershell
# Node 20 (winget; use nvm-windows instead if you manage multiple Node versions)
winget install OpenJS.NodeJS.LTS

# Rust, MSVC host
winget install Rustlang.Rustup
rustup default stable-msvc

# Visual Studio Build Tools, C++ workload (required for the MSVC linker)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"

# Tauri CLI — the standard Tauri 2 install
cargo install tauri-cli --version "^2" --locked

# WebView2 runtime (already present on an updated Windows 10/11; installs it if missing)
winget install Microsoft.EdgeWebView2Runtime
```

Reopen PowerShell after the Rust/Node installs so `PATH` picks them up, then
clone and install dependencies:

```powershell
git clone <this repository>
cd msfslogger_mcdu
npm --prefix sidecar ci
```

The root `package.json` declares no dependencies — `npm --prefix sidecar ci`
is the only install this repository needs. Do not run a plain `npm ci`/`npm
install` at the repo root expecting it to install the sidecar; the `--prefix`
is required.

Build the sidecar once (also happens automatically before every `cargo tauri
dev`/`cargo tauri build`, via `beforeDevCommand`/`beforeBuildCommand` in
`src-tauri/tauri.conf.json`):

```powershell
npm --prefix sidecar run build
```

First run:

```powershell
cargo tauri dev
```

This opens the app on `STATUS`. Configure the server URL, ingest token and
(for HTTPS) a certificate path from `MENU` → `<NETWORK`, save with `R6`, then
press `START>` on `STATUS`. Full field reference:
[configuration.md](configuration.md).

## Validate your setup

Run each of these and expect the result shown.

```powershell
npm --prefix sidecar run build
```
Expect: no output, exit code 0.

```powershell
node sidecar/dist/inspect-config.js --config=sidecar/samples/config/good.json
```
Expect: `config     : OK`, every field printed, the ingest token shown only as
`<set, redacted>`, exit code 0.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --offline
```
Expect: all tests pass (the process-level tests use real sleeps, so this
takes roughly ten seconds).

```powershell
cargo tauri dev
```
Expect: the app window opens on `STATUS`; the App axis reads `NO CONFIG`
until you save `CFG NETWORK`, then `UPLINK STOPPED`; after `START>` it moves
toward `UPLINK ACTIVE` (a running or standby state) even with MSFS closed —
the Sim axis is what waits on MSFS, not the App axis.

## Running tests and tools from PowerShell, not Git Bash

Run `npm --prefix sidecar test`, `npm run test:gauge`, `npm run check:ui` and
`cargo` commands from PowerShell. From Git Bash, vitest's path handling
breaks (`/c/...`-style lowercase-drive paths fail every file with a
`Cannot read properties of undefined (reading 'config')` error) — this is a
path-format problem, not a real failure of the code under test.

## OpenSSL on PATH

The sidecar's TLS tests spawn `openssl`. It resolves from `C:\Program
Files\Git\usr\bin`, which a normal Git for Windows install already has on
`PATH`. If a test run fails with `spawnSync openssl ENOENT`, prepend that
directory to `PATH` for the session:

```powershell
$env:PATH = "C:\Program Files\Git\usr\bin;$env:PATH"
```

## Platform limitations

The client's runtime — the Tauri shell (`src-tauri/`), the CDU panel inside it, and a live
SimConnect connection — is Windows-only. Two things do run cross-platform:
the sidecar's own type check and unit tests (plain Node 20, no SimConnect
import in that code path), and the CDU preview harness
(`npm run dev:gauge`, `npm run test:gauge`), which serves the panel against a
mock host in a browser with no Tauri, no sidecar and no MSFS involved.
`ui/tools/render-check.mjs` and `ui/tools/host-swap-check.mjs` additionally
need `puppeteer`, which is not part of this repository's install.
