# Release

Current practice, stated plainly — there is no CI, no tagging scheme and no
signing yet; this document describes what actually happens today, not an
aspirational process.

## Current practice

- Version is set in two places and both must agree: `Cargo.toml`'s
  `[package].version` and `tauri.conf.json`'s top-level `version`. Nothing
  checks this automatically — it's a manual step in every release.
- The sidecar has its own version, `SIDECAR_VERSION` in `sidecar/src/index.ts`,
  sent in its `hello` message along with a `features` list
  (`datalink`, `simbrief-prefile`, `pdc-clearance`, …). The Tauri shell
  (`src-tauri/`) uses that list, not the version string, to gate which
  features it offers — an old
  sidecar simply doesn't advertise a feature it predates, and the CDU shows
  `SIDECAR UPDATE REQUIRED` for anything that needs it.
- No git tags exist for any release. No CI workflow exists. Everything ships
  from a single `main` branch.
- Every installer this project produces is unsigned — no code-signing
  certificate is configured, by design, not as an unfinished step. Windows
  SmartScreen will warn on first run of an installer built this way; that's
  expected.

## Release build steps

From the repository root:

```powershell
cargo tauri build
```

This runs `beforeBuildCommand` (`npm --prefix sidecar run build`) first, then
produces an MSI and an NSIS `.exe` under
`src-tauri/target/release/bundle/`.

The bundle embeds `sidecar/dist`, `sidecar/node_modules` and
`sidecar/package.json` as resources — whatever is on disk in those
directories at build time is exactly what ships. **Install the sidecar's
production dependencies before building** (`npm --prefix sidecar ci` or
`npm --prefix sidecar install`, not a partial or `--omit=dev` state you
haven't verified); there is no separate "prune dev dependencies for the
bundle" step.

## Pre-release checklist

1. All checks in [development.md](development.md) pass: sidecar typecheck and
   tests, `cargo fmt --check`, `cargo test --offline`, `contract-check.mjs`,
   `check:ui`, `test:gauge`.
2. Version bumped in both `Cargo.toml` and `tauri.conf.json`, and they still
   agree.
3. An in-sim smoke test on a real Windows box with MSFS: launch the built
   app, configure `CFG NETWORK`, confirm the Sim axis reaches
   `SIM LINK ONLINE` and the Backend axis reaches `ACARS UPLINK` against a
   real server.
4. Server compatibility: confirm the target msfslogger server's version
   supports the sidecar's advertised `features` — an older server simply
   shows the corresponding CDU page as unavailable, but it's worth checking
   deliberately before calling a release done.

## Installed-app runtime requirement

The installed app is not self-contained: the shell spawns the sidecar by
running `node` (or the executable at the config file's `nodePath`, if set)
as a child process — the bundle ships the sidecar's JavaScript and
`node_modules`, not a Node runtime. **Node 20 must be on the installed
machine's `PATH`, or `nodePath` must point at one**, or the app will fail to
launch the sidecar (`STATUS` reads a launch-failure state naming the
problem). This applies to every installed copy, not just dev machines.
