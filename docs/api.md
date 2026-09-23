# API reference

Three interface layers connect the CDU panel to the Sabiá server: the
host contract (webview↔host), Tauri commands and events (webview↔shell), and
the shell↔sidecar protocol (stdio). A fourth layer, the HTTP routes the
sidecar calls on the Sabiá server, is also documented here since the
sidecar is the only process that calls them.

The Tauri command/event names and the shell↔sidecar relay-timeout ordering are
checked by `node tools/contract-check.mjs`; see [development](development.md).

## 1. Host contract (`ui/src/bridge.js`)

Every page calls a small interface (`window.FMC`) the app shell builds over
whichever host `bridge.js` resolved (installed host, Tauri, or the built-in
stub — see [architecture](architecture.md)). The contract has a required core
group and three optional groups; a method an installed host does not provide
answers `{ok: false, error: {code: 'host-unsupported', ...}}` rather than
throwing, so an older host or a mid-upgrade sidecar degrades a page to a
`NOT SUPPORTED` message instead of breaking it.

### Core (required for a host to be adopted at all)

| Method | Args | Returns |
| --- | --- | --- |
| `getConfig()` | — | `{exists, path, config, raw}` (redacted) |
| `setConfig(patch)` | patch object | `{ok, path}` or `{ok: false, message}` |
| `getConfigPath()` | — | `string` |
| `startUplink()` | — | — |
| `stopUplink()` | — | — |
| `restartSidecar()` | — | — |
| `getStatus()` | — | status snapshot or `null` |
| `onStatus(fn)` / `onLog(fn)` / `onExit(fn)` | callback | unsubscribe function |

### Datalink (optional, per-method fallback)

| Method | Args | Returns |
| --- | --- | --- |
| `getDatalinkState()` | — | datalink state or `null` |
| `onDatalink(fn)` | callback | unsubscribe function |
| `watchDatalink(on)` | `boolean` | `{ok, result: {watching, leaseMs}}` |
| `refreshDatalink()` | — | `{ok, result: {accepted, coalesced}}` |
| `getDatalinkThread({epoch, endSeq})` | | `{ok, result: thread page}` |
| `getCannedMessages()` | — | `{ok, result: {messages, truncated}}` |
| `sendCannedMessage({target, cannedId})` | target `{kind, id}` | `{ok, result: {sent, httpStatus}}` |
| `requestWeather({target, icao})` | | `{ok, result: {icao, available, metar, taf, fetchedAt}}` |
| `requestLoadsheet({plannedLegId})` | | `{ok, result: {plannedLegId, created, httpStatus, sheet}}` |
| `getSayIntentionsStatus({flightId})` | `flightId` a safe integer ≥ 1, or `null` (a missing key is refused `BAD_REQUEST` locally — see F1 in the run's amendments) | `{ok, result: {answered, flightId, apiKeySet, linked, link, httpStatus}}` |
| `linkSayIntentions({flightId, from})` | `from` exactly `'now'` or `'session-start'` | `{ok, result: {flightId, created, pendingMessages, link, httpStatus}}` |
| `unlinkSayIntentions({flightId})` | only `flightId` is forwarded | `{ok, result: {flightId, unlinked, httpStatus}}` |
| `importSayIntentionsComms({flightId})` | only `flightId` is forwarded | `{ok, result: {flightId, imported, alreadySeen, skipped, sinceId, httpStatus}}` |
| `sendSayIntentionsPdc({plannedLegId})` | only `plannedLegId` is forwarded | `{ok, result: {plannedLegId, sentText, httpStatus}}` |

### SimBrief (optional, no args ever forwarded)

| Method | Returns |
| --- | --- |
| `getSimbriefSettings()` | `{ok, result: {configured}}` |
| `prefileSimbrief()` | `{ok, result: {status, plannedLegId, label, warningCount, httpStatus}}` |
| `clearPrefiledLeg()` | `{ok, result: {cleared}}` |

### Clearance (optional)

| Method | Args | Returns |
| --- | --- | --- |
| `requestClearance({plannedLegId})` | only `plannedLegId` is forwarded | `{ok, result: {plannedLegId, created, departure, destination, route, initialAltitudeFt, squawk, httpStatus}}` |

## 2. Tauri commands and events

24 commands, all defined in `src-tauri/src/main.rs`:

| Command | Args | Returns | Does |
| --- | --- | --- | --- |
| `config_get` | — | `{exists, path, config, raw}` | Returns the sidecar's last-reported effective config (`config`) and the redacted on-disk file (`raw`) side by side — not merged |
| `config_set` | `patch` | `{ok, path}` / `{ok: false, message}` | Merge-saves the patch, requests a sidecar config reload |
| `config_path` | — | `string` | The sidecar's `hello.configPath`, else the shell's own resolved path |
| `uplink_start` | — | `Result<(), String>` | Sends `start` |
| `uplink_stop` | — | `Result<(), String>` | Sends `stop` |
| `sidecar_restart` | — | `Result<(), String>` | Force-respawns, clears the crash latch and restart budget |
| `status_get` | — | `Option<Value>` | Last cached status message |
| `datalink_state` | — | `Value` | Latest datalink state, redacted, no round trip |
| `datalink_watch` | `on: bool` | async | Relays `watch {on}` |
| `datalink_refresh` | — | async | Relays `refresh {}` |
| `datalink_canned` | — | async | Relays `canned-list {}` |
| `datalink_thread` | `epoch, end_seq: u64` | async | Relays `thread {epoch, endSeq}` |
| `datalink_send_canned` | `target_kind, target_id, canned_id` | async | Relays `send-canned {target, cannedId}` |
| `datalink_wx` | `target_kind, target_id, icao` | async | Relays `wx {target, icao}` |
| `datalink_loadsheet` | `planned_leg_id: u64` | async | Relays `loadsheet {plannedLegId}` |
| `simbrief_settings` | — | async | Relays `simbrief-settings {}` |
| `simbrief_prefile` | — | async | Relays `simbrief-prefile {}` (single-flight) |
| `simbrief_clear_prefile` | — | async | Relays `prefile-clear {}` |
| `datalink_clearance` | `planned_leg_id: u64` | async | Relays `clearance {plannedLegId}` (single-flight) |
| `sayintentions_status` | `flight_id: Option<u64>` | async | Relays `si-status {flightId}` — a `null` id asks the key question alone |
| `sayintentions_link` | `flight_id: u64, from: String` | async | Relays `si-link {flightId, from}` |
| `sayintentions_unlink` | `flight_id: u64` | async | Relays `si-unlink {flightId}` |
| `sayintentions_import` | `flight_id: u64` | async | Relays `si-import {flightId}` |
| `sayintentions_pdc` | `planned_leg_id: u64` | async | Relays `si-pdc {plannedLegId}` |

Datalink-family commands run via `spawn_blocking` so a multi-second relay
round trip never blocks the async runtime, and every returned envelope is
redacted before it reaches the webview.

4 events, pushed from the shell to the webview (`sidecar:*`):

| Event | Payload | When |
| --- | --- | --- |
| `sidecar:status` | full status snapshot | On every status push from the sidecar (see [data-model](data-model.md)) |
| `sidecar:log` | `{v, type: "log", at, level, message}` | On every sidecar log line |
| `sidecar:exit` | `{code, signal, restarting, restartsRemaining}` | On sidecar process exit |
| `sidecar:datalink` | datalink state object | On every unsolicited datalink state push |

Only `core:event:allow-listen` and `core:event:allow-unlisten` are granted in
`src-tauri/capabilities/main.json`; the webview subscribes to these events but
holds no other Tauri permission.

## 3. Shell↔sidecar protocol

Transport: the shell spawns the sidecar as a child process and talks over its
stdio — one JSON object per line, `\n`-terminated (CRLF tolerated), in both
directions. Every line is capped at 65536 bytes (64 KiB); a response too
large to encode is answered with a `too-large` error for the same request id
rather than ever writing an over-limit line. On the sidecar's stdin side, an
incoming chunk with no newline is buffered up to 131072 bytes (2x the line
cap) before being dropped as oversized input. On the shell's outgoing side, a
`datalink-request` line is capped separately at 4096 bytes.

### Sidecar -> shell message types

| Type | Fields | Notes |
| --- | --- | --- |
| `hello` | `pid, sidecarVersion, nodeVersion, configPath, features[]` | Sent once, first. `features` lists `datalink`, `simbrief-prefile`, `pdc-clearance` when supported |
| `status` | `app, sim, backend, pause, traffic, config` | Full snapshot, never a partial patch; state-change pushes coalesced to at most 1 per 250 ms, while the 5 s heartbeat and handling a `start`/`stop`/`config` control message send immediately, bypassing that window |
| `log` | `level, message` | Human-readable, re-logged by the shell |
| `pong` | `id` | Echoes a `ping` |
| `frame` | `frame: {...}` | Reserved for a future live-data page; decoded but never emitted in this build |
| `traffic` | `count, objects[]` | Reserved: decoded but not emitted in this build (the shell drops any unknown/reserved type — no `sidecar:traffic` event exists). Traffic batches go only to `POST /api/ingest/traffic` on the server |
| `datalink-response` | `id, ok, result` or `id, ok: false, error` | Exactly one per request id |
| `datalink-state` | `state, watching, httpStatus, serverCode, lastOkAt, lastErrorAt, nextPollAt, scope, thread, prefiledLeg?` | Unsolicited, always a full snapshot |

### Shell -> sidecar message types

| Type | Fields | Notes |
| --- | --- | --- |
| `start` | — | Starts the uplink |
| `stop` | — | Stops the uplink |
| `config` | `path?` | Requests a config reload |
| `shutdown` | — | Graceful shutdown |
| `ping` | `id` | Answered with `pong` |
| `datalink-request` | `id, op, params` | `id` must match `/^dl-[0-9]{1,20}$/`; a malformed request with a recognizable id still gets a `bad-request` answer so the shell never times out on it |

### Datalink-request ops

`watch`, `refresh`, `thread`, `canned-list`, `send-canned`, `wx`, `loadsheet`,
`simbrief-settings`, `simbrief-prefile`, `prefile-clear`, `clearance`,
`si-status`, `si-link`, `si-unlink`, `si-import`, `si-pdc`.

Every op requires the `datalink` feature in the connected sidecar's `hello`;
without it, every op is refused `sidecar-outdated`. `simbrief-settings`,
`simbrief-prefile` and `prefile-clear` additionally require the
`simbrief-prefile` feature, `clearance` additionally requires the
`pdc-clearance` feature, and the five `si-*` ops additionally require the
`sayintentions` feature — a sidecar with `datalink` but not (say)
`sayintentions` still serves every other op normally; only `si-status`,
`si-link`, `si-unlink`, `si-import` and `si-pdc` are refused (with
`sidecar-outdated`, rendered on the CDU as `SIDECAR UPDATE REQUIRED`).

### Error codes

| Code | Meaning |
| --- | --- |
| `busy` | 8 datalink requests already pending in the shell's relay (a 9th concurrent request is refused), or the shell's internal request/stdin-writer queue is full |
| `sidecar-outdated` | The connected sidecar's `hello.features` lacks the feature the op needs |
| `shell-timeout` | No sidecar answer within the relay timeout (12 s; 30 s for `simbrief-prefile` only) |
| `sidecar-exited` | The sidecar process died mid-request |
| `sidecar-unavailable` | No sidecar connected (including: still queued when shutdown began) |
| `prefile-in-progress` | A second `simbrief-prefile` while one is already in flight |
| `clearance-in-progress` | A second `clearance` request while one is already in flight |
| `bad-request` | Malformed request params (recognizable id, wrong shape) |
| `host-unsupported` | The host object doesn't implement this method at all (webview-local) |
| `too-large` | A response would exceed the 64 KiB line limit |
| `no-thread` | `thread` requested with no cached thread for the current scope |
| `stale-epoch` | `thread` requested against an epoch the sidecar has since invalidated |
| `no-config` | No valid config loaded yet |

The availability-class codes (`unreachable`, `tls-error`, `timeout`,
`token-invalid`, `token-missing`, `unavailable`, `rejected`, `http-error`,
`bad-response`) are assigned by the sidecar itself from each HTTP attempt —
the transport error (a failed connection is `unreachable`, a TLS handshake
failure is `tls-error`, an expired timeout is `timeout`), the HTTP status, and
the `x-ingest-token-scope` header for a 401. They are not passed through
verbatim from the server. `no-config` is not tied to an HTTP attempt at all:
it means no valid config has loaded yet, so no request was even attempted.
`token-invalid` is likewise produced locally, with no HTTP attempt, once the
sidecar has latched an invalid token from an earlier response — every
server-bound op (`refresh`, `canned-list`, `send-canned`, `wx`, `loadsheet`,
`simbrief-settings`, `simbrief-prefile`, `clearance`) is refused
`token-invalid` while latched; `watch`, `thread` and `prefile-clear` touch no
server and keep answering normally. `simbrief-unavailable` and
`clearance-unavailable` are also 401-derived, not a body `code`: on the two
SimBrief routes and the clearance route respectively, a 401 that isn't
`INVALID_INGEST_TOKEN` and doesn't carry an `accepted` scope header answers
with these instead of the generic `unavailable` — the SimBrief/clearance
equivalent, naming a server build that predates the route. The other
semantic codes (`not-a-canned-message`, `unknown-canned-message`, `invalid-id`,
`no-dispatch-data`, `flight-not-found`, `leg-not-found`,
`simbrief-no-user-id`, `simbrief-unknown-user`, `simbrief-no-plan`,
`simbrief-timeout`, `simbrief-network`, `simbrief-bad-status`,
`simbrief-bad-body`, `simbrief-db-error`, `clearance-no-flight-plan`) do come
from a specific server body `code` value on a matching HTTP status.
`host-error` is webview-local: the host adapter itself threw or returned
something unusable. All are documented with the CDU text that renders them in
[cdu-reference](cdu-reference.md).

## 4. Sabiá server HTTP routes

The sidecar is the only process that calls the Sabiá server. Every
ingest and datalink request carries the token in an `x-ingest-token` header
and nothing else authenticates it (no session, cookie or Origin check). The
one exception is the reachability probe, `GET /api/status`: the sidecar sets
no `x-ingest-token` (or any other app-set header) on it — fetch still adds its
own defaults such as `accept`/`user-agent` — so the probe never carries the
token.

### Ingest routes (flight-data uplink)

| Method/Path | Body | Timeout | Notes |
| --- | --- | --- | --- |
| `POST /api/ingest/frame` | `FlightFrame` | none (no `AbortSignal`) | Posted once per SimConnect sample |
| `POST /api/ingest/event` | `{type, flags?}` | none | `type` one of `connected/disconnected/crashed/paused/unpaused/pause` |
| `POST /api/ingest/traffic` | `{objects: TrafficObject[]}`, capped to 200 | none | Failure is advisory only; never touches the Backend status axis |
| `GET /api/status` | — | none | Reachability probe, sent with no `x-ingest-token`; fired every 15 s when no ingest traffic has landed; any HTTP answer (including its own 401) counts as reachable, only a transport/TLS error is a fault |

Ingest requests set no `redirect` option, so fetch's default (`follow`)
applies, and no per-request timeout — see [security](security.md) for why
this is a stated limitation, not a design choice to rely on.

### Datalink / SimBrief / clearance routes (13)

| Method/Path | Notes |
| --- | --- |
| `GET /api/status` | Also used for datalink scope resolution |
| `GET /api/acars/canned-messages` | |
| `GET /api/flights/:id/acars-messages` | |
| `POST /api/flights/:id/acars-messages` | body `{canned_id}` |
| `POST /api/flights/:id/acars-messages/wx` | body `{icao}` |
| `GET /api/planned-legs/:id/acars-messages` | |
| `POST /api/planned-legs/:id/acars-messages` | body `{canned_id}` |
| `POST /api/planned-legs/:id/acars-messages/wx` | body `{icao}` |
| `POST /api/planned-legs/:id/acars-messages/loadsheet` | no body |
| `POST /api/planned-legs/:id/acars-messages/clearance` | no body — the leg id in the path is the whole request |
| `GET /api/ground-sessions/current` | scope resolution |
| `GET /api/settings/simbrief` | |
| `POST /api/planned-legs/simbrief` | no body — the server picks the pilot's current OFP |

All 13 routes are `accept: application/json`, use `redirect: 'manual'` (a 3xx
is treated as a fault so the token is never replayed to another host), and
share the ingest client's CA dispatcher (see [security](security.md)).
Timeout: 8 seconds for every route except `POST /api/planned-legs/simbrief`,
which gets 25 seconds (the server itself allows SimBrief up to 20 seconds
before answering 504). Every path segment is a validated integer id — the
only route parameters that appear in a URL. A canned-message id or an ICAO
code is validated against its own pattern but travels only in the JSON
request body (`{"canned_id": ...}` / `{"icao": ...}`), never in the path or a
query string, and no trailing slash reaches a URL either. SimBrief and PDC
clearance are proxied and simulated by the Sabiá server itself; the
sidecar never contacts SimBrief or any ACARS network directly.

### SayIntentions routes (6)

The Sabiá server's optional SayIntentions.AI integration, frozen by a
peer session's contract (`.claude/runs/2026-09-17-mcdu-sayintentions/contracts/server-sayintentions-api.md`)
and never yet exercised against a live server from this repository (see the
run's `live-check.md`). Six server-side operations, reachable with the same
`x-ingest-token` header as the 13 routes above — **with one deliberate
exception**: `PUT /api/settings/sayintentions` (writing or changing the
SayIntentions API key itself) is **not** on that token's scope and never will
be. It is a web-UI-only action on the server's Prefiles page; the sidecar
never calls it and this client has no code path that could. A CDU that finds
no key configured points the operator at the web app and never offers to
collect the key (see [security](security.md)).

The five sidecar ops map to seven literal client-side templates — the link
route (op 3 below) has two, selected by the CDU's `FROM NOW` / `SESSION
START` choice, both literal in `sidecar/src/datalink-client.ts`'s closed route
table (no query string is ever composed from a value):

| # | Method/Path | Notes |
| --- | --- | --- |
| 1 | `GET /api/settings/sayintentions` | Whether a key is configured; answers `si-status` when `flightId` is `null` |
| 2 | `GET /api/flights/:id/sayintentions/link` | Link status for a flight; answers `si-status` when `flightId` is given |
| 3 | `POST /api/flights/:id/sayintentions/link` · `POST /api/flights/:id/sayintentions/link?from=now` | `si-link`; omitted query defaults to `session_start` server-side, but the CDU always sends one of the two literal templates explicitly rather than relying on that default (A-6 Q4) |
| 4 | `DELETE /api/flights/:id/sayintentions/link` | `si-unlink`; always 200, even with nothing to remove |
| 5 | `POST /api/flights/:id/sayintentions/import` | `si-import`; idempotent, cursor-driven, dedups server-side |
| 6 | `POST /api/planned-legs/:id/sayintentions/clearance` | `si-pdc`; condenses the leg's on-file PDC and sends it as a real CPDLC message |

All six take no request body (D-4: a known upstream `400 text/html` gap on a
malformed body is deliberately left unreached rather than worked around).
Method union for the client widens to `GET | POST | DELETE` — route 4 is the
client's first `DELETE`. Timeout: the default 8 seconds for routes 1, 2 and 4
(the server's own database, no SayIntentions round trip); 20 seconds for
routes 3, 5 and 6, which reach SayIntentions itself through the server —
above the server's own fixed 10-second upstream timeout (`SAYINTENTIONS_TIMEOUT_MS`
in the server's `sayIntentionsClient.ts`, per the peer session), so the CDU
sees the server's own `502`/`504`-derived code rather than a local unknown
result (A-9).

A response's HTTP status and, for a 401, its body `code` and
`x-ingest-token-scope` header decide the outcome: a body `code` of
`INVALID_INGEST_TOKEN` latches the token as invalid (`token-invalid`). A 401
whose `x-ingest-token-scope` header reads `accepted` (compared trimmed and
lower-cased) but carries no
`INVALID_INGEST_TOKEN` code means the route takes the token but it didn't
arrive — something in between stripped the header (`token-missing`). Any
other 401 — a different or absent scope header — means the route is outside
the token's scope, in practice a server whose build predates that route
(`unavailable`, or the SimBrief/clearance-specific `simbrief-unavailable`/
`clearance-unavailable`). The server's free-text `error` field is never read.
