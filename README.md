# msfslogger Windows client

A Tauri desktop client for Windows: it reads Microsoft Flight Simulator over
SimConnect, shows an FMC-style CDU panel, and uplinks flight data to an
msfslogger server on another machine. From the same CDU it also drives
DATALINK (ACARS-style messaging), a SimBrief flight-plan prefile, a
simulated PDC clearance request, and linking a flight to SayIntentions to
import its comms and push the leg's PDC to a live SayIntentions session as a
real CPDLC message — all proxied through that server; see
[docs/usage.md](docs/usage.md) for the SayIntentions walkthrough.

## Prerequisites

- Windows 10 or 11 (SimConnect, WebView2, `%APPDATA%`)
- Microsoft Flight Simulator 2020 or 2024 (or FSX, selectable in `CFG SIM`)
- Node 20
- Rust ≥ 1.88 (MSVC toolchain) plus the Visual Studio Build Tools C++ workload
- Tauri CLI 2.x (`cargo tauri`)
- WebView2 runtime (ships with an up-to-date Windows 10/11)
- A reachable msfslogger server and its ingest token

See [docs/setup.md](docs/setup.md) for exact versions, install commands and
how to check each one.

## Setup

```powershell
git clone <this repository>
cd msfslogger_mcdu
npm --prefix sidecar ci
```

The root `package.json` has no dependencies of its own — only `sidecar/`
needs an install.

## Run

```powershell
cargo tauri dev
```

This builds the sidecar first (`beforeDevCommand`), then opens the app on the
`STATUS` page. Press `MENU`, open `<NETWORK`, enter the server URL and ingest
token (and a certificate path if the server runs HTTPS), save with `R6`, then
press `START>` on `STATUS` to begin the uplink. Full walkthrough:
[docs/configuration.md](docs/configuration.md).

## Preview without MSFS

```powershell
npm run dev:gauge
```

or `powershell -ExecutionPolicy Bypass -File tools/dev-gauge.ps1 [-Port n]`,
then open <http://127.0.0.1:8380>. This serves the real CDU panel against a
mock host with selectable scenarios — no MSFS, sidecar or Tauri shell
involved. Details: [docs/setup.md](docs/setup.md).

## Checks

```powershell
npm --prefix sidecar run typecheck   # sidecar type check
npm --prefix sidecar test            # sidecar unit tests
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check   # Rust formatting
cargo test --manifest-path src-tauri/Cargo.toml --offline   # Rust unit/process tests
node tools/contract-check.mjs        # Rust <-> webview command/event names agree
npm run check:ui                     # CDU panel ownership-boundary rules
npm run test:gauge                   # preview harness tests
```

## Documentation

Start at [docs/index.md](docs/index.md). Key pages: architecture
([docs/architecture.md](docs/architecture.md)), setup
([docs/setup.md](docs/setup.md)), configuration
([docs/configuration.md](docs/configuration.md)), day-to-day usage
([docs/usage.md](docs/usage.md)), the CDU page/vocabulary reference
([docs/cdu-reference.md](docs/cdu-reference.md)), operations
([docs/operations.md](docs/operations.md)), troubleshooting
([docs/troubleshooting.md](docs/troubleshooting.md)), development
([docs/development.md](docs/development.md)), release
([docs/release.md](docs/release.md)), and security
([docs/security.md](docs/security.md)). The CDU preview harness has its own
reference: [gauge/README.md](gauge/README.md).

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE).
