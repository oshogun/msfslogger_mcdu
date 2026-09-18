# Glossary

Terms used across these docs and in the code, alphabetical. See
[index.md](index.md) for the full document map.

| Term | Meaning | Where it appears |
| --- | --- | --- |
| ACARS | The aircraft datalink-messaging brand this client uses for its DATALINK feature (canned/free messages, weather, loadsheet) and for the Backend status-axis label | [cdu-reference.md](cdu-reference.md), [usage.md](usage.md) |
| CDU | Control Display Unit — the FMC's screen and keypad; the panel this client implements (`ui/`) | [architecture.md](architecture.md), [cdu-reference.md](cdu-reference.md) |
| CPDLC | The genuine clearance message SayIntentions delivers into the pilot's live session, sent only by `DL-SI-PDC` `R6` `SEND*` after `DL-CLEARANCE` R5 `SEND PDC>` — the server condenses the leg's on-file PDC clearance and pushes it as a real message, not a simulation. Never safe to press twice: a repeat push files a second CPDLC message, and neither the CDU nor the server can tell afterwards whether the first one arrived. Distinct from PDC clearance (simulated), which this term never names | [usage.md](usage.md), [cdu-reference.md](cdu-reference.md) |
| crash latch | The supervisor state entered after its restart budget is exhausted; blocks automatic restart until an explicit `RESTART` | [operations.md](operations.md), [troubleshooting.md](troubleshooting.md) |
| datalink lease | The window a `watch:true` datalink request buys before the sidecar's poll loop stops on its own | [api.md](api.md), [data-model.md](data-model.md) |
| DOW | Dry Operating Weight — a loadsheet row on `DL-LOADSHEET` | [cdu-reference.md](cdu-reference.md) |
| epoch | A thread-cache version counter that changes only when previously issued sequence numbers would now point at different rows | [api.md](api.md) |
| FMC | Flight Management Computer — the aircraft system this panel emulates the CDU of; also the panel's page-interface global, `window.FMC` | [architecture.md](architecture.md) |
| FPLN | Flight Plan page — the CDU page for the SimBrief-prefile feature | [cdu-reference.md](cdu-reference.md), [usage.md](usage.md) |
| generation | A counter identifying which spawned sidecar process a pending datalink request/response is bound to, so a stale reply from a replaced process is ignored | [architecture.md](architecture.md) |
| ground session | The server's record of a leg the pilot is on the ground for, before a flight formally starts | [data-model.md](data-model.md) |
| host contract | The UI↔host seam defined by `ui/src/bridge.js` | [architecture.md](architecture.md), [api.md](api.md) |
| ICAO | The 4-letter airport code validated for a `WX REQUEST` | [cdu-reference.md](cdu-reference.md) |
| import (SayIntentions) | `DL-SI` R5 `IMPORT>` — a manual, operator-pressed pull of a linked SayIntentions session's radio/ATC comms into the existing `DL-THREAD`. Nothing imports on its own; a repeat import is always safe, since the server dedups on its own cursor | [usage.md](usage.md), [cdu-reference.md](cdu-reference.md) |
| ingest token | The shared secret that authenticates the sidecar to the msfslogger server | [configuration.md](configuration.md), [security.md](security.md) |
| link (SayIntentions) | `DL-SI` L4 `<LINK` — binds the current flight to whatever SayIntentions session the server's saved key currently holds, either from now or backfilled to session start. Needs a live flight; refused in leg scope | [usage.md](usage.md), [cdu-reference.md](cdu-reference.md) |
| LSK | Line Select Key — one of the 12 buttons beside the screen, addressed as `L1`–`L6`/`R1`–`R6` | [cdu-reference.md](cdu-reference.md) |
| METAR | A weather report, shown on `DL-WX-RESULT` | [cdu-reference.md](cdu-reference.md) |
| mock host | The preview harness's fake host (`gauge/dev/mock-host.js`), distinct from the stub bridge | [gauge/README.md](../gauge/README.md) |
| OFP | Operational Flight Plan — SimBrief's output, imported by the FPLN prefile feature | [usage.md](usage.md) |
| Pause_EX1 | The SimConnect event that reports Active Pause, which the legacy `Paused`/`Unpaused` events miss | [troubleshooting.md](troubleshooting.md) |
| PDC clearance (simulated) | The pre-departure clearance requested from `DL-INDEX` R5 `REQUEST CLEARANCE`. The msfslogger server generates it entirely within the simulation — it never reaches SayIntentions or a live session — and every result carries `NOT FOR REAL WORLD USE` on screen. Distinct from CPDLC, the SayIntentions push of an already-issued PDC clearance into a live session; never call this one CPDLC | [usage.md](usage.md), [cdu-reference.md](cdu-reference.md) |
| planned leg | A server-side leg record; a flight and a leg are two different datalink scopes | [data-model.md](data-model.md) |
| prefile / prefiled leg | Importing a SimBrief OFP into the server as a trip-less planned leg | [usage.md](usage.md) |
| probe | The reachability-only request the sidecar makes when no ingest traffic has landed recently | [operations.md](operations.md) |
| relay | The shell's id↔reply correlation for datalink requests passed between the webview and the sidecar | [api.md](api.md) |
| restart budget | The supervisor's allowance of restarts within a rolling window before it crash-latches | [operations.md](operations.md) |
| SayIntentions | The third-party ATC/comms service the msfslogger server optionally integrates with, reached from `DL-INDEX` R2 `SAYINTENTIONS>` (`DL-SI`). The server holds the SayIntentions API key and does all the talking to it; the client never contacts SayIntentions and never holds the key, only reading whether one is set | [usage.md](usage.md), [cdu-reference.md](cdu-reference.md), [security.md](security.md) |
| scope | Which thread — flight, leg, or none — DATALINK is currently pointed at | [data-model.md](data-model.md) |
| scratchpad | The CDU's one-line entry and feedback field | [cdu-reference.md](cdu-reference.md) |
| shell | The Tauri process (`src-tauri/`): window, sidecar supervisor, `ConfigStore` | [architecture.md](architecture.md) |
| sidecar | The Node process (`sidecar/`) that talks to SimConnect and the msfslogger server | [architecture.md](architecture.md) |
| SimBrief | The third-party flight-planning service the FPLN prefile feature imports an OFP from | [usage.md](usage.md) |
| SimConnect | Microsoft's MSFS API the sidecar reads simulator state through | [architecture.md](architecture.md) |
| squawk | The transponder code assigned as part of a PDC clearance | [cdu-reference.md](cdu-reference.md) |
| stub bridge | The host contract's built-in fallback host, used when neither Tauri nor a mock host is present | [architecture.md](architecture.md) |
| supervisor | The shell component that spawns, restarts and health-checks the sidecar | [architecture.md](architecture.md), [operations.md](operations.md) |
| synthetic status | A shell-fabricated status, used only when no live sidecar can report its own | [operations.md](operations.md) |
| TAF | A terminal area forecast, shown alongside METAR on `DL-WX-RESULT` | [cdu-reference.md](cdu-reference.md) |
| Tauri command / Tauri event | The two kinds of webview↔Rust IPC this client uses | [api.md](api.md) |
| TOW | Takeoff Weight — a loadsheet row on `DL-LOADSHEET` | [cdu-reference.md](cdu-reference.md) |
| unlink (SayIntentions) | `DL-SI` L5 `<UNLINK` — releases the flight's binding to its SayIntentions session. Also needs a live flight; refused in leg scope | [usage.md](usage.md), [cdu-reference.md](cdu-reference.md) |
| uplink | Posting frames, events or traffic to the server's ingest endpoints | [usage.md](usage.md), [api.md](api.md) |
| WebView2 | The Windows web-rendering runtime the CDU panel runs inside | [setup.md](setup.md) |
| ZFW | Zero Fuel Weight — a loadsheet row on `DL-LOADSHEET` | [cdu-reference.md](cdu-reference.md) |
