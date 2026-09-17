# Configuration

Everything the client needs to run lives in one JSON file, the config file:
`%APPDATA%\msfslogger\config.json` (typically
`C:\Users\<you>\AppData\Roaming\msfslogger\config.json`).

## Location and resolution order

Both the shell (`src-tauri/`) and the sidecar resolve the config path the
same way, and the shell always launches the sidecar with `--config <its own
resolved path>` so the two processes never disagree:

1. `MSFSLOGGER_CONFIG` environment variable, if set and non-blank. A relative
   value resolves against the current working directory; an absolute value
   (any platform, drive letter or not) is used as-is.
2. Platform default:
   - Windows: `%APPDATA%\msfslogger\config.json` (or
     `%USERPROFILE%\AppData\Roaming\msfslogger\config.json` if `APPDATA` is
     unset).
   - Off Windows (sidecar only — the shell doesn't run elsewhere):
     `$XDG_CONFIG_HOME/msfslogger/config.json`, or
     `~/.config/msfslogger/config.json` if `XDG_CONFIG_HOME` is unset.

The sidecar additionally accepts `--config <path>` / `--config=<path>` on its
own command line, which takes priority over `MSFSLOGGER_CONFIG`. This is how
the shell always points the sidecar at its own resolved path, and how you can
run the sidecar standalone against a different file (see
[operations.md](operations.md)).

## Config keys

| Key | Required | Default | Description | Example | CDU page / LSK |
|---|---|---|---|---|---|
| `version` | no | `1` | Must be `1` if present | `1` | not editable |
| `serverUrl` | yes | — | msfslogger server base URL, `http:`/`https:` only, trailing slash stripped | `"https://192.168.0.30:3000"` | `CFG NETWORK`, L1 |
| `ingestToken` | yes | — | The server's ingest token; never echoed back once set | `"SENTINEL-TOKEN"` | `CFG NETWORK`, L2 |
| `certPath` | no | `null` | Path to a PEM for the server's self-signed certificate; must be readable if set | `"C:\\certs\\server.pem"` | `CFG NETWORK`, L3 |
| `trafficEnabled` | no | `true` | `false` only for `0`/`false`/`off`/`no` (trimmed, case-insensitive); anything else, including absent, is `true` | `false` | `CFG TRAFFIC`, L1 |
| `trafficRadiusM` | no | `40000` | AI traffic sweep radius in metres, clamped to `[1000, 200000]` | `60000` | `CFG TRAFFIC`, L2 |
| `sim` | no | `"2020"` | One of `2020`, `2024`, `fsx`, case-insensitive | `"2024"` | `CFG SIM`, L1 |
| `autoUplink` | no | `false` | When `true`, the uplink starts at launch without a `START>` press | `true` | `CFG SIM`, L2 |
| `nodePath` | no | `null` | Overrides the `node` executable the shell spawns as the sidecar; read only by the shell, never by the sidecar itself | `"C:\\nvm4w\\nodejs\\node.exe"` | not editable |

## Environment variables

| Name | Required | Default | Description | Example |
|---|---|---|---|---|
| `MSFSLOGGER_CONFIG` | no | unset | Overrides the config file path for either process (second priority, after `--config` on the sidecar) | `C:\temp\test-config.json` |

No other environment variable is read by the shell or the sidecar. All
runtime settings live in the config file above.

## CLI flags

Sidecar (`sidecar/dist/index.js`):

- `--config <path>` / `--config=<path>` — config file path, highest priority.

Diagnostic tools (see [operations.md](operations.md) for what each does and
its danger notes):

- `node sidecar/dist/inspect-config.js [path] [--config=<path>]`
- `node sidecar/dist/inspect-datalink.js --config <path>`
- `node sidecar/dist/inspect-uplink.js --config <path>`

## Example config.json

```json
{
  "version": 1,
  "serverUrl": "https://192.168.0.30:3000",
  "ingestToken": "SENTINEL-TOKEN",
  "certPath": null,
  "trafficEnabled": true,
  "trafficRadiusM": 40000,
  "sim": "2024",
  "autoUplink": false,
  "nodePath": null
}
```

## Editing rules

- It's fine to hand-edit the file while the app is closed. Editing it while
  the app is running works too, but only takes effect after the app's own
  next read — prefer the CDU pages or a restart to avoid surprises.
- The shell writes atomically: it creates a sibling `config.json.tmp`, writes
  and syncs it, then renames it over the target. A crash mid-save leaves the
  previous file intact.
- Saving from the CDU never re-sends an unchanged `ingestToken` — if you
  didn't type a new one, the existing token on disk is preserved rather than
  overwritten with a blank.
- A BOM (as Notepad writes) is stripped before parsing; the file is otherwise
  plain UTF-8 JSON.
- An invalid file is never overwritten. If the shell finds the existing file
  present but unreadable, non-UTF-8, invalid JSON, or not a JSON object, a
  `config_set` save from the CDU fails and the file is left untouched — fix
  it by hand at the path shown, or delete it to start fresh.

## Migrating from the standalone msfslogger agent

The old standalone agent (a separate repository) read its settings from
environment variables and a `--sim` flag. Every one of those has a matching
config key here:

| Old agent setting | Config key | CDU page / LSK |
|---|---|---|
| `SERVER_URL` env var | `serverUrl` | `CFG NETWORK`, L1 |
| `INGEST_TOKEN` env var | `ingestToken` | `CFG NETWORK`, L2 |
| `NODE_EXTRA_CA_CERTS` env var | `certPath` | `CFG NETWORK`, L3 |
| `TRAFFIC_ENABLED` env var | `trafficEnabled` | `CFG TRAFFIC`, L1 |
| `TRAFFIC_RADIUS_M` env var | `trafficRadiusM` | `CFG TRAFFIC`, L2 |
| `--sim` flag | `sim` | `CFG SIM`, L1 |

There is no code path that reads the old agent's environment variables or
migrates them automatically — set each value once on the matching CDU page
and save.
