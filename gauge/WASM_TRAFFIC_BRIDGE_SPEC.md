# MSFS WASM Traffic and Pause Bridge Specification

Status: proposed  
Target simulator: Microsoft Flight Simulator 2020  
Consumers: MSFSLogger CDU Coherent GT gauge and MSFSLogger ingest API

## 1. Purpose

The existing toolbar gauge reads the user's aircraft through JavaScript
`SimVar`, but Coherent GT cannot enumerate AI SimObjects or subscribe reliably
to the `Pause_EX1` SimConnect event. This module adds those two capabilities
without changing or depending on the Tauri desktop client.

The finished package must:

- enumerate nearby AI aircraft through the native MSFS SimConnect API;
- expose coherent, bounded traffic snapshots to the existing JavaScript gauge;
- expose authoritative pause flags, including Active Pause;
- let the JavaScript gauge continue owning configuration, HTTPS, authentication,
  retries, and posts to `/api/ingest/traffic` and `/api/ingest/event`;
- remain aircraft independent if the MSFS 2020 module loader permits a toolbar
  package to load the module globally;
- fail visibly and leave user-aircraft telemetry operational when the native
  bridge is unavailable.

The module must not contain the server URL, ingest token, certificate material,
or HTTP client code.

## 2. Required feasibility gate

Before implementing the full bridge, build a minimal SDK WASM module that only
increments a heartbeat LVar once per second. Package it with the existing
aircraft-independent toolbar package and verify that MSFS loads it when a
flight starts without editing an aircraft's `panel.cfg`.

Acceptance for the gate:

1. The toolbar panel remains available on an unmodified stock aircraft.
2. `L:MSFSLOGGER_BRIDGE_HEARTBEAT` changes while the flight is running.
3. Changing to another stock aircraft requires no aircraft-specific files.
4. Closing and reopening the toolbar does not create a second module instance.

If MSFS 2020 does not load a standalone WASM module from this package type,
stop and record the SDK limitation. Do not silently introduce per-aircraft
installation. The follow-up architecture decision must choose explicitly
between an aircraft package integration and a separate native Windows helper.

## 3. Architecture

```text
MSFS SimConnect runtime
        |
        | RequestDataOnSimObjectType / system events
        v
MSFSLoggerBridge.wasm
        |
        | numeric LVars, versioned snapshot protocol
        v
MSFSLoggerGaugeHost.js (Coherent GT)
        |
        | HTTPS + x-ingest-token
        v
/api/ingest/traffic and /api/ingest/event
```

The WASM side owns SimConnect handles, definitions, requests, dispatch, native
filtering, and publishing LVars. JavaScript owns the poll timer, snapshot
validation, conversion to JSON, status display, and server upload.

## 4. SimConnect inputs

### 4.1 Traffic definition

Register a dedicated data definition in this exact field order:

| Field | SimVar | Unit | Native type |
|---|---|---|---|
| latitude | `PLANE LATITUDE` | `degrees` | `FLOAT64` |
| longitude | `PLANE LONGITUDE` | `degrees` | `FLOAT64` |
| altitude | `PLANE ALTITUDE` | `feet` | `FLOAT64` |
| heading | `PLANE HEADING DEGREES TRUE` | `degrees` | `FLOAT64` |
| ground speed | `GROUND VELOCITY` | `knots` | `FLOAT64` |
| on ground | `SIM ON GROUND` | `bool` | `INT32` |

Use the `dwObjectID` supplied by SimConnect as the traffic object ID. Do not
derive an ID from position or array order.

Request `SIMCONNECT_SIMOBJECT_TYPE_AIRCRAFT` with the configured radius. The
default radius is 40,000 metres and valid input is clamped to
`1,000..200,000` metres. Start one sweep every 2,000 ms. Never start a second
sweep while the previous sweep is incomplete.

Collect `SIMCONNECT_RECV_ID_SIMOBJECT_DATA_BYTYPE` records until the response's
entry count is complete. Publish an empty completed snapshot when no objects
are returned so stale traffic is removed from the server.

### 4.2 User aircraft exclusion

Exclude `SIMCONNECT_OBJECT_ID_USER`. Also exclude an object whose latitude and
longitude are both within `0.0001` degrees of the current user-aircraft
position. The positional test protects against simulator/runtime differences
in the returned user object ID.

### 4.3 Traffic normalization

Apply the same rules as `sidecar/src/traffic.ts`:

1. Reject invalid IDs and non-finite numeric fields.
2. Reject on-ground objects moving slower than 1 knot.
3. De-duplicate by object ID, keeping the most recent values.
4. Preserve first-seen ordering for the snapshot.
5. Limit the published snapshot to 200 objects.
6. Publish `id`, `lat`, `lon`, `altitudeFt`, `headingDeg`, and `onGround`.
7. Ground speed is used for filtering but is not sent to the server.

Set the snapshot's truncated flag when valid objects were dropped by the
200-object limit.

### 4.4 Pause events

Subscribe to `Pause_EX1`, `Paused`, and `Unpaused` using distinct event IDs.
Once at least one `Pause_EX1` event has been received, treat it as authoritative
and ignore legacy `Paused`/`Unpaused` updates for the rest of that connection.

Publish the raw `Pause_EX1` flags. JavaScript will use the existing status
mapping and post `{ "type": "pause", "flags": n }` when the value changes.
Before `Pause_EX1` becomes authoritative, legacy `Paused` maps to flags `1`
and `Unpaused` maps to `0`.

## 5. WASM-to-JavaScript bridge

MSFS named local variables are numeric doubles. The bridge therefore uses a
fixed numeric slot table and a sequence counter rather than JSON or strings.

All variables use the `L:MSFSLOGGER_` prefix.

### 5.1 Control and health variables

| LVar | Writer | Meaning |
|---|---|---|
| `BRIDGE_PROTOCOL` | WASM | Protocol version; exactly `1` |
| `BRIDGE_STATE` | WASM | `0` stopped, `1` starting, `2` ready, `3` fault |
| `BRIDGE_HEARTBEAT` | WASM | Monotonically increasing once per second |
| `BRIDGE_ERROR` | WASM | Stable numeric error code; `0` means none |
| `TRAFFIC_ENABLED` | JS | `0` disabled, nonzero enabled |
| `TRAFFIC_RADIUS_M` | JS | Requested radius in metres |
| `TRAFFIC_INTERVAL_MS` | JS | Requested interval; version 1 accepts `2000` |

The module clamps configuration values. It must continue publishing heartbeat,
pause, and health data while traffic is disabled.

### 5.2 Snapshot metadata

| LVar | Writer | Meaning |
|---|---|---|
| `TRAFFIC_SEQ` | WASM | Even stable sequence; odd while being written |
| `TRAFFIC_COUNT` | WASM | Valid slots in the current snapshot, `0..200` |
| `TRAFFIC_TRUNCATED` | WASM | `1` if the 200-object cap removed records |
| `TRAFFIC_SWEEP_ID` | WASM | Monotonically increasing completed-sweep ID |
| `TRAFFIC_AGE_MS` | WASM | Milliseconds since the last completed sweep |

### 5.3 Traffic slots

Allocate slots `000` through `199`, zero padded. Each slot has:

```text
L:MSFSLOGGER_T_000_ID
L:MSFSLOGGER_T_000_LAT
L:MSFSLOGGER_T_000_LON
L:MSFSLOGGER_T_000_ALT_FT
L:MSFSLOGGER_T_000_HDG_DEG
L:MSFSLOGGER_T_000_ON_GROUND
```

Object IDs must be exactly representable as JavaScript numbers. Latitude and
longitude remain unrounded. Normalize heading to `[0, 360)`. Store on-ground
as `0` or `1`.

Slots at indexes greater than or equal to `TRAFFIC_COUNT` are undefined and
must not be read. The writer does not need to clear unused slots.

### 5.4 Pause variables

| LVar | Writer | Meaning |
|---|---|---|
| `PAUSE_FLAGS` | WASM | Current raw/derived flags |
| `PAUSE_SEQ` | WASM | Incremented after a changed pause value is committed |
| `PAUSE_EX1_ACTIVE` | WASM | `1` after `Pause_EX1` becomes authoritative |

## 6. Snapshot consistency protocol

WASM publishes a snapshot using a seqlock:

1. Increment `TRAFFIC_SEQ` to an odd value.
2. Write slot values.
3. Write count, truncated flag, sweep ID, and age.
4. Increment `TRAFFIC_SEQ` to the next even value.

JavaScript reads it as follows:

1. Read `TRAFFIC_SEQ`; stop if it is odd.
2. Read count and slots `0..count-1`.
3. Read `TRAFFIC_SEQ` again.
4. Accept only when both sequence values are equal and even.
5. Retry once on the next animation/timer turn if validation fails.

JavaScript posts a traffic batch only when `TRAFFIC_SWEEP_ID` differs from the
last successfully consumed sweep. A server failure may retry the same snapshot,
but only one traffic request may be in flight.

## 7. Lifecycle and failure behavior

On module initialization:

1. Register every LVar and set protocol/state/heartbeat defaults.
2. Open one SimConnect client named `MSFSLogger Gauge Bridge`.
3. Register traffic definitions and pause subscriptions.
4. Set `BRIDGE_STATE=2` only after SimConnect setup succeeds.

Dispatch SimConnect messages during the SDK module update callback. Do not
block the simulator thread, allocate without bounds, perform network I/O, or
wait on locks held by another thread.

On SimConnect quit/exception:

- set state to fault and publish a stable error code;
- cancel the active sweep and invalidate its partial buffer;
- close the handle safely;
- retry with delays of 5, 10, 20, 40, then 60 seconds;
- keep exactly one pending reconnect attempt.

On module deinitialization, close SimConnect, release native allocations, and
set `BRIDGE_STATE=0`.

### 7.1 Error codes

| Code | Meaning |
|---:|---|
| 0 | no error |
| 1 | SimConnect open failed |
| 2 | data definition failed |
| 3 | traffic request failed |
| 4 | malformed/incomplete SimConnect response |
| 5 | pause subscription failed |
| 6 | protocol/configuration error |
| 99 | unexpected internal failure |

The JavaScript status layer should translate bridge faults to `TFC FAULT` and
retain the code in `traffic.lastError`. Bridge failure must not stop the
existing user-aircraft `/api/ingest/frame` loop.

## 8. JavaScript gauge integration

Extend `gauge/msfs/src/MSFSLoggerGaugeHost.js` with a bridge reader that:

- detects protocol version `1` and a moving heartbeat;
- writes traffic enable/radius/interval config LVars;
- reads stable traffic snapshots with the seqlock rules;
- applies defensive finite/range checks again before creating JSON;
- posts `{ "objects": [...] }` to `/api/ingest/traffic` using the existing
  server URL and `x-ingest-token` header;
- updates `lastSweepAt`, `lastBatchSize`, and `lastError` independently from
  the ACARS frame status;
- reads pause changes and updates the existing pause axis/event endpoint;
- reports `TFC STBY` while enabled but before the first completed snapshot;
- reports `TFC OFF` only when the user has disabled traffic;
- reports `TFC FAULT` when the bridge is missing, stale, incompatible, or in a
  fault state.

Do not force `trafficEnabled=false` in `setConfig` after this integration.

If the heartbeat does not change for 5 seconds, treat the bridge as stale. A
subsequent moving heartbeat recovers automatically without reloading the panel.

## 9. Packaging and build

Add a dedicated WASM source directory under `gauge/msfs/wasm/` and keep SDK
generated output out of Git. The committed directory should contain source,
build configuration, protocol constants, and native unit-testable helpers.

Update the package definition and `gauge/msfs/tools/build.mjs` so the Community
package contains both the existing `html_ui` assets and the compiled WASM
module. Use the MSFS 2020 SDK's supported WASM toolchain and package layout;
do not download or vendor another Emscripten toolchain.

The build must fail when:

- the SDK or WASM compiler is unavailable;
- the module is absent from generated package output;
- the compiled protocol version differs from the JavaScript protocol version;
- the SDK returns success but leaves stale output.

Increment the package version when the bridge first ships.

## 10. Test requirements

### 10.1 Native tests outside MSFS

Keep filtering and snapshot publication logic independent from SimConnect so
host-native tests can cover:

- user-object exclusion by ID and position;
- malformed-number rejection;
- parked-aircraft filtering;
- de-duplication and stable order;
- 200-object truncation;
- empty completed snapshots;
- heading normalization;
- odd/even sequence transitions;
- pause precedence and legacy fallback;
- reconnect delay and single-pending-retry behavior.

### 10.2 JavaScript tests

Use a fake SimVar/LVar implementation to verify:

- stable snapshots are converted to the existing server schema;
- odd or changing sequences are never posted;
- a new sweep posts once;
- an empty sweep posts an empty array;
- invalid slots are rejected without stopping frame uploads;
- missing, stale, and incompatible bridges produce traffic faults;
- traffic upload failures do not overwrite ACARS frame status;
- pause changes post exactly once;
- secrets never enter LVars, logs, test snapshots, or status messages.

### 10.3 In-simulator acceptance

Test with at least two unmodified stock aircraft at a busy airport:

1. Bridge state becomes ready and heartbeat advances.
2. Enabling traffic changes the CDU from `TFC OFF` to `TFC STBY`, then to a
   count-bearing healthy state.
3. Moving AI aircraft appear on the server map within 5 seconds.
4. Parked aircraft below 1 knot do not appear.
5. The user aircraft is absent from the traffic batch.
6. Disabling traffic sends one final empty batch and stops native sweeps.
7. Re-enabling traffic recovers without restarting MSFS or the toolbar.
8. Full Pause and Active Pause produce distinct correct pause states.
9. Closing/reopening the toolbar does not duplicate traffic posts or the WASM
   instance.
10. SimConnect and server interruptions recover automatically.

## 11. Definition of done

The module is complete when the feasibility gate passes, all native and
JavaScript tests pass, the package builds reproducibly with the installed MSFS
2020 SDK, and the in-simulator acceptance run demonstrates traffic and Active
Pause on two stock aircraft without an MSFS restart between configuration
changes.
