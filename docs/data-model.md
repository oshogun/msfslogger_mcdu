# Data model

The client persists exactly one file, `config.json`. Everything else —
status, traffic, datalink threads, prefiled legs — lives in memory and is
lost when the sidecar or the shell restarts. This page gives the wire shapes;
[configuration](configuration.md) gives the full field-by-field walkthrough
for end users, and [cdu-reference](cdu-reference.md) gives the CDU labels for
every status and datalink state id.

## Config file

Path: `%APPDATA%\msfslogger\config.json` (Windows) — the only file the client
writes in normal operation. Resolution order (both processes): an explicit
override (`--config` for the sidecar, `MSFSLOGGER_CONFIG` for either process)
beats the platform default; the shell always resolves the path once and
passes it to the sidecar via `--config`.

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

Persistence semantics:

- **Atomic write**: the shell's `ConfigStore::save` writes to a sibling
  `.json.tmp` file, flushes it, then renames it over the target. A failure
  midway removes the temp file and leaves the previous config on disk intact.
- **Merge-save**: `config_set` (and the CDU's CFG pages) send a patch, not a
  full document; the shell merges it over the existing on-disk object
  key-by-key (last-writer-wins per key, no deep merge) rather than replacing
  the file.
- **Token-preserving omission**: when the CDU's NETWORK page saves without the
  user having retyped `ingestToken`, the patch omits the key entirely, so the
  merge-save leaves the on-disk token untouched.
- **`tokenSet` redaction**: `ingestToken` never crosses out of the process
  that holds it. Every config snapshot handed to the webview — from
  `config_get` and from the status snapshot's `config` field, itself built
  from the sidecar's own `status` messages — replaces the token with a
  boolean `tokenSet`. (The sidecar's `hello` message carries no config at
  all, redacted or otherwise — just `pid`/versions/`configPath`/`features`.)

See [security](security.md) for the full redaction chain and threat model
around this token.

## Status snapshot

Pushed by the sidecar and forwarded to the webview as the `sidecar:status`
event / `status_get` command result. State-change pushes are coalesced to at
most one per 250 ms; an unconditional heartbeat every 5 seconds, and handling
a `start`, `stop` or `config` control message, send immediately instead,
bypassing that coalescing window.

```json
{
  "v": 1,
  "type": "status",
  "at": 0,
  "app": { "state": "app.running", "problems": [] },
  "sim": {
    "state": "sim.connected",
    "attempt": 0,
    "nextRetryAt": null,
    "retryDelayMs": null,
    "protocol": "SunRise",
    "appName": null,
    "appVersion": null,
    "lastError": null
  },
  "backend": {
    "state": "net.ok",
    "httpStatus": 200,
    "lastOkAt": 0,
    "lastErrorAt": null,
    "message": null
  },
  "pause": { "state": "pause.off", "flags": 0, "label": "off", "usingPauseEx1": false },
  "traffic": {
    "enabled": true,
    "radiusM": 40000,
    "lastSweepAt": 0,
    "lastBatchSize": 0,
    "lastError": null
  },
  "config": { "...RedactedConfig fields...": "...", "tokenSet": true }
}
```

(`protocol: "SunRise"` matches `sim: "2024"` in the config example above; the
other valid values are `KittyHawk` for `"2020"` and `FSX_SP2` for `"fsx"`.)

Four axes make up the CDU's STATUS page: **App**, **Sim**, **Backend**,
**Pause**. Each axis's state id (`app.*`, `sim.*`, `net.*`, `pause.*`) maps to
a fixed CDU label and severity — see [cdu-reference](cdu-reference.md) for the
full table. An id the CDU doesn't recognize (a newer sidecar talking to an
older panel) renders as `?? <id>` at caution rather than blanking the page.

## FlightFrame

One SimConnect sample, posted individually to `POST /api/ingest/frame`:

```ts
interface FlightFrame {
  lat: number;
  lon: number;
  altitudeFt: number;
  airspeedKnots: number;
  groundSpeedKnots: number;
  headingDeg: number;
  verticalSpeedFpm: number;
  onGround: boolean;
  simRunning: number;
  aircraft: string;
  parkingBrake?: boolean;
  engineCount?: number;
  enginesRunning?: number;
}
```

The last three ground-detection fields are read only when at least 24 bytes
remain in the SimConnect buffer, so an older sim build that doesn't report
them simply omits the keys.

## Ingest events

Posted individually to `POST /api/ingest/event` as `{type, flags?}`. `type` is
one of: `connected`, `disconnected`, `crashed`, `paused`, `unpaused`, `pause`
(the last carries a numeric `flags` field decoding SimConnect's `Pause_EX1`
event, which is what actually reports Active Pause — the legacy
`paused`/`unpaused` events miss it).

## TrafficObject

Posted in batches (capped to 200) to `POST /api/ingest/traffic` as
`{objects: TrafficObject[]}`:

```ts
interface TrafficObject {
  id: number;
  lat: number;
  lon: number;
  altitudeFt: number;
  headingDeg: number;
  onGround: boolean;
}
```

No ground speed, no rounding. The sweep drops the user's own aircraft, drops
parked traffic, dedupes by id, and truncates to 200 before the batch is built.

## Datalink wire shapes

### State (unsolicited, `datalink-state` / `sidecar:datalink`)

```ts
interface DatalinkStateMessage {
  state: DatalinkStateId;      // "dl.idle" | "dl.pending" | "dl.ok" | "dl.unreachable" | ...
  watching: boolean;
  httpStatus: number | null;
  serverCode: string | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  nextPollAt: number | null;
  scope: DatalinkScope | null;         // null until a poll cycle resolves one
  thread: DatalinkThreadSummary | null; // null when nothing is cached yet
  prefiledLeg?: { plannedLegId: number; label: string }; // present only while held
}

type DatalinkScope =
  | { kind: "flight"; flightId: number; plannedLegId: number | null }
  | { kind: "leg"; plannedLegId: number; source: "status" | "ground-session" | "prefile" }
  | { kind: "none" };
```

### Thread and message

```ts
interface DatalinkThreadSummary {
  epoch: number;      // bumps only when cached seq numbers would mean different rows
  total: number;
  firstSeq: number;    // lowest seq still cached
  newestId: number | null;
  droppedRows: number; // rows that failed shape validation on the last fetch
}

interface DatalinkMessage {
  seq: number;         // 0-based, oldest first
  id: number;
  direction: "uplink" | "downlink";
  category: string;
  label: string | null;
  body: string;
  sentAt: string;
  correlationId: number | null;
}
```

### Canned message, WX, loadsheet, prefile, clearance

```ts
interface CannedMessageEntry { id: string; label: string; }

interface LoadsheetSheet {
  units: string | null;
  blockFuel: number | null; taxiFuel: number | null; takeoffFuel: number | null; tripFuel: number | null;
  payload: number | null; payloadSource: string | null;
  zeroFuelWeight: number | null; zfwSource: string | null; maxZeroFuelWeight: number | null;
  dryOperatingWeight: number | null; takeoffWeight: number | null;
}

// simbrief-prefile result
{ status: "imported" | "duplicate"; plannedLegId: number; label: string; warningCount: number; httpStatus: number }

// clearance result — the structured clearance only; the request/reply text
// itself reaches the webview through the thread, not this shape
{
  plannedLegId: number;
  created: boolean;           // false: the leg already had a clearance, these are the stored rows
  departure: string | null; destination: string | null; // 1-8 chars [A-Z0-9], trimmed/upper-cased
  route: string | null;        // token-scrubbed, at most 4096 UTF-16 units
  initialAltitudeFt: number;   // 0-99999
  squawk: string;               // four octal digits
  httpStatus: number;
}
```

Every server-supplied string in these shapes (thread bodies, canned labels,
WX text, loadsheet fields, prefile labels, clearance route/ICAO) is
token-scrubbed before it leaves the sidecar — see [security](security.md).

## In-memory state (not persisted)

| State | Owner | Notes |
| --- | --- | --- |
| Thread cache | sidecar (`datalink-service.ts`) | Keyed by `flight:<id>` / `leg:<id>`, up to 2000 cached messages; carries an `epoch` that changes only when previously-cached seq numbers would stop meaning the same rows |
| Prefiled-leg state | sidecar | One leg id + label + the server/token it was filed under; dropped on token refusal, a server/token change, flight start, the user's own `prefile-clear` op, a 404 on the prefiled leg's own thread poll, or a `leg-not-found` on any write (send-canned, WX, loadsheet) or clearance request aimed at it |
| Traffic sweep buffer | sidecar | Accumulated per 2 s sweep, cleared each cycle |
| Datalink poll lease | sidecar, requested by the CDU panel | A 65-second window a `watch: true` request buys before polling stops on its own if not renewed |
| Status/log cache, 200-entry log ring | shell | So a fast crash loop's cause is still visible after the fact |

Nothing but `config.json` survives a process restart. A CDU panel reconnecting
to a freshly-restarted sidecar or shell sees a fresh status snapshot and an
empty thread cache, not stale state from before the restart.
