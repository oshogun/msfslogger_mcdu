# CDU reference

Key and LSK conventions, the full page map, and every CDU vocabulary table
for the msfslogger Windows client's CDU panel (`ui/`). For flow-oriented
walkthroughs, see [usage](usage.md).

## Key and LSK conventions

- **LSKs**: `L1`–`L6` down the left of the screen, `R1`–`R6` down the right,
  next to their matching row. A page names which rows are active; pressing
  an inactive LSK shows `KEY NOT ACTIVE`.
- **Keys**: `MENU` returns to the `MENU` page from anywhere. `EXEC` commits
  the current page's pending action (equivalent to its `R6` prompt on the
  CFG pages). `CLR` clears the scratchpad entry one character at a time (a
  long press clears it fully); it also dismisses a scratchpad message and
  restores whatever was typed underneath. `PREV`/`NEXT` (`PageUp`/`PageDown`
  on a keyboard) page within the current page's group, or step through a
  paged view (long message text, a route, a page of messages).
- **Prompts render as they show on screen**: `START>`/`STOP>`, `SAVE>`,
  `PREFILE>`, `SEND*`/`CONFIRM*` (an asterisk marks a one-shot send, not
  repeatable while in flight).
- **Scratchpad vs message line**: typed text (`entry`) and an
  error/advisory overlay (`message`) are separate — clearing a message
  restores whatever was being typed. `CFG NETWORK`'s token field masks input
  with `•` while typing.

## Page map

| Page id | Title | Reached via | LSKs | Shows |
|---|---|---|---|---|
| `MENU` | MSFSLOGGER | `MENU` key from anywhere | L1–L6 → STATUS/NETWORK/SIM/TRAFFIC/DL-INDEX/FPLN | Static list |
| `STATUS` | ACARS STATUS | boot default; L6 from most pages | L6 MENU; R6 start/stop uplink; R5 restart (only while crashed) | 4 axes, traffic line, config path |
| `NETWORK` (CFG) | CFG NETWORK | MENU L2 | L1 serverUrl, L2 ingestToken, L3 certPath, L6 MENU, R6 save (EXEC also saves) | serverUrl / ingestToken (masked) / certPath |
| `SIM` (CFG) | CFG SIM | MENU L3 | L1 sim version, L2 autoUplink, L6/R6 as above | sim, autoUplink |
| `TRAFFIC` (CFG) | CFG TRAFFIC | MENU L4 | L1 trafficEnabled, L2 trafficRadiusM, L6/R6 as above | trafficEnabled, trafficRadiusM |
| `DL-INDEX` | ACARS DATALINK | MENU L5; L6 from other DL pages | R1 CLR PREFILE (if held); L3 MESSAGES→DL-THREAD; L4 DOWNLINK→DL-CANNED; R3 WX→DL-WX; R4 LOADSHEET→DL-LOADSHEET; R5 CLEARANCE; R6 REFRESH; L6 MENU | scope, DATALINK state line, prefiled-leg row |
| `DL-THREAD` | ACARS MSGS | DL-INDEX L3 | L1–L5 open a message; L6 DL-INDEX; R6 REFRESH; PREV/NEXT pages | 5 msgs/page, oldest-first, newest page on open |
| `DL-MSG` | ACARS MSG | DL-THREAD L1–L5 | L6 return to originating thread page; PREV/NEXT pages the text | one message, 10 lines/page |
| `DL-CANNED` | DOWNLINK | DL-INDEX L4 | L1–L5 select → DL-CONFIRM; L6 DL-INDEX; PREV/NEXT pages | server's canned list |
| `DL-CONFIRM` | CONFIRM SEND | staged from CANNED/WX/LOADSHEET | R6 SEND* (once); L6 CANCEL | pending action + target |
| `DL-WX` | WX REQUEST | DL-INDEX R3 | L1 stage ICAO; L6 DL-INDEX; R6 REQUEST→DL-CONFIRM | typed ICAO |
| `DL-WX-RESULT` | `WX <ICAO>` | after WX send | L6→DL-WX; PREV/NEXT pages | METAR/TAF paged |
| `DL-LOADSHEET` | LOADSHEET | DL-INDEX R4 | L6 DL-INDEX; R6 REQUEST→DL-CONFIRM | last illustrative sheet for the leg |
| `DL-CLEARANCE-CONFIRM` | REQUEST CLEARANCE | DL-INDEX R5 | R6 SEND*; L6 CANCEL | target leg, last failure |
| `DL-CLEARANCE` | CLEARANCE | after successful send, or R5 with a kept result | L6 DL-INDEX; R6 MESSAGES→DL-THREAD; PREV/NEXT pages the route | pair, initial alt, squawk, route paged, `NOT FOR REAL WORLD USE` |
| `FPLN` | FLIGHT PLAN | MENU L6 | L6 MENU; R6 PREFILE→FPLN-CONFIRM (only if offered); R3 CLR PREFILE | Pilot ID status, held prefiled leg, last outcome |
| `FPLN-CONFIRM` | PREFILE SIMBRIEF | FPLN R6 | R6 CONFIRM* (once); L6 CANCEL | static staging text |
| `FPLN-RESULT` | PREFILE | after send | L6 FPLN; R5 DATALINK→DL-INDEX | PREFILED/ALREADY FILED, label, leg id, warnings |

Every DATALINK page holds its poll lease only while on screen. No key send
in DATALINK/FPLN is a single press: canned downlink, WX, loadsheet and
clearance all stage on one page, then send on a confirm page.

## STATUS vocabulary

Four axes, always present, never collapsed: the SimConnect link and the
backend uplink are independent things that fail for different reasons.

### App — is the sidecar alive, is the uplink meant to be running

| Label | Severity | Meaning | Action |
|---|---|---|---|
| `SIDECAR STARTING` | caution | Process just started, hasn't read the config yet | Wait a moment |
| `NO CONFIG` | caution | No config file exists yet at the resolved path | Fill in `CFG NETWORK` |
| `CONFIG INVALID` | fault | Config file exists but fails validation | Fix the named field and save again |
| `UPLINK STOPPED` | idle | Config valid; uplink not running | Press `START>` |
| `UPLINK ACTIVE` | ok | Uplink running | Nothing needed |
| `SIDECAR FAULT` | fault | The sidecar process died unexpectedly | Shell restarts it automatically; press `R5` if the restart budget is exhausted |
| `SIDECAR RESTART` | caution | The shell is respawning the sidecar after a fault | Wait; automatic |

### Sim — the SimConnect link

| Label | Severity | Meaning | Action |
|---|---|---|---|
| `SIM LINK STANDBY` | idle | Uplink not running, nothing attempted | Press `START>` |
| `SIM LINK CONNECTING` | caution | Trying to open SimConnect | Wait a few seconds |
| `SIM LINK ONLINE` | ok | Connected to MSFS | Nothing needed |
| `SIM LINK RETRY {ss}S` | caution | Last attempt failed (or a live link dropped); reconnecting in `{ss}` seconds, backing off 5s→10s→20s→40s, capping at 60s | Make sure MSFS is running |

### Backend — the msfslogger server (flight-data uplink)

| Label | Severity | Meaning | Action |
|---|---|---|---|
| `ACARS STANDBY` | idle | Uplink not running | Press `START>` |
| `ACARS CONNECTING` | caution | Uplink just started, no request completed yet | Wait a moment |
| `ACARS UPLINK` | ok | Most recent flight-data/event post succeeded | Nothing needed — the working state |
| `ACARS READY` | ok | Server answered a reachability check, nothing posted recently (usually because the sim link is down) | Nothing needed; clears once data starts flowing |
| `ACARS REJECT 401` | fault | Server rejected a post — token mismatch | Fix the token on `CFG NETWORK` |
| `ACARS FAULT {status}` | fault | Server rejected a post with another non-2xx status | Check the server's own logs |
| `ACARS CERT FAULT` | fault | TLS handshake failed | Fix the certificate path on `CFG NETWORK` |
| `ACARS NO COMM` | fault | Can't reach the server at all | Check the server is running and reachable |

DATALINK faults never appear on this line — see DATALINK vocabulary below
for its own state line.

### Pause — what MSFS is doing right now

| Label | Severity | Meaning | Action |
|---|---|---|---|
| `PAUSE OFF` | idle | Not paused | Nothing needed |
| `SIM PAUSED` | caution | Regular full pause | Nothing needed |
| `ACTIVE PAUSE` | caution | Active Pause (aircraft frozen, sim keeps running) | Nothing needed |
| `SIM MENU` | caution | Sim is frozen in a menu | Nothing needed |
| `PAUSE {flags}` | caution | An unrecognized pause bitmask | Informational only |

An unknown status/datalink state id (sidecar newer than panel) renders as
`?? <id>` at caution severity rather than blanking the line.

### Traffic advisory line

Not a severity axis; informational only. `TFC OFF` when traffic is disabled;
otherwise `TFC STBY {radius}KM` before the first sweep, `TFC {n} OBJ
{radius}KM` after one, or `TFC FAULT {radius}KM` if the last sweep failed.

## DATALINK vocabulary

**State line** (`DL-INDEX` row 4; also shown on `DL-THREAD` when no thread
is cached yet):

| CDU text | Hint | Meaning | Action |
|---|---|---|---|
| `DATALINK STANDBY` | | No DATALINK page has polled yet this session | Nothing needed |
| `DATALINK CONNECTING` | | First poll after opening a DATALINK page in flight | Wait a moment |
| `DATALINK ONLINE` | | Last poll succeeded | Nothing needed — the working state |
| `DATALINK NO COMM` | | No HTTP response reached the server | Check the server is running and reachable |
| `DATALINK CERT FAULT` | `CHECK CERTIFICATE PATH` | TLS handshake failed | Fix the certificate path on `CFG NETWORK` |
| `DATALINK TIMEOUT` | | No response within 8 seconds | Wait for the next poll |
| `INGEST TOKEN REJECTED` | `CHECK INGEST TOKEN ON CFG NETWORK` | Server rejected the token; DATALINK stops polling until config is corrected and re-saved | Re-enter the token and save |
| `DATALINK TOKEN NOT RECEIVED` | `TOKEN HEADER LOST IN TRANSIT` | Route answered but the token header never reached the server | Check any reverse proxy in front of the server |
| `DATALINK UNAVAILABLE` | `SERVER MAY PREDATE DATALINK` | Server answered, but not on a DATALINK-aware route | Upgrade the server |
| `DATALINK REJECTED 403` | | Server refused the request | Should not happen; report if seen |
| `DATALINK FAULT {status}` | | Any other non-2xx server response | Check the server's own logs |
| `DATALINK BAD DATA` | | Response wasn't valid JSON or the expected shape | Should not happen against a matching server version |
| `DATALINK NO CONFIG` | `COMPLETE CFG NETWORK` | Sidecar has no valid config yet | Fill in `CFG NETWORK` and save |
| `SIDECAR UPDATE REQUIRED` | `REBUILD SIDECAR THEN RESTART APP` | Running sidecar predates the DATALINK feature this shell expects | `npm --prefix sidecar run build`, restart the app |
| `DATALINK OFFLINE` | | No sidecar running, or it exited with a DATALINK request pending | Shell restarts the sidecar automatically |

**Scratchpad messages** (page actions and requests):

| CDU text | When |
|---|---|
| `NO FLIGHT PLAN` | A DATALINK action was pressed with no leg or flight resolved yet |
| `NO LINKED LEG` | LOADSHEET requested in flight scope, and the flight has no linked planned leg |
| `NO DISPATCH DATA` | The leg has no SimBrief dispatch release on the server |
| `INVALID ENTRY` | An empty or malformed ICAO was entered on `DL-WX` |
| `DOWNLINK SENT` | A canned downlink send completed |
| `LOADSHEET RECEIVED` | A loadsheet request generated new figures |
| `LOADSHEET ON FILE` | A loadsheet request returned figures already on file |
| `NOT A CANNED MESSAGE` / `UNKNOWN CANNED MESSAGE` / `FLIGHT NOT FOUND` / `PLANNED LEG NOT FOUND` / `DATALINK INVALID ID` | Server-side or scope-staleness faults; not expected from normal use |
| `DATALINK BUSY` / `DATALINK OFFLINE` / `DATALINK NOT SUPPORTED` / `DATALINK HOST FAULT` | A local fault in the relay between the webview and the sidecar, not a server response. `DATALINK BUSY` specifically means the relay already had 8 datalink/clearance/prefile requests pending (`PENDING_MAX = 8`) and refused a 9th, or the shell's own internal operation/stdin queue to the sidecar was full |

## CLEARANCE vocabulary

**Page text** (`DL-CLEARANCE-CONFIRM`, `DL-CLEARANCE`):

| CDU text | When |
|---|---|
| `CLEARANCE>` | `DL-INDEX` R5 prompt; always shown |
| `REQUEST CLEARANCE` | `DL-CLEARANCE-CONFIRM` title |
| `CLEARANCE REQUEST` | `DL-CLEARANCE-CONFIRM` heading above the leg/status rows |
| `SIMULATED PDC` | `DL-CLEARANCE-CONFIRM` marker, labelling the request as the simulated exchange it is |
| `LEG <id>` | The leg a pending or in-flight request targets |
| `SENDING` | The request is in flight |
| `CLEARANCE LEG CHANGED` | `SEND*` pressed but scope moved to a different leg since the confirm page opened; nothing sent |
| `SIMULATED CLEARANCE` | Result page marker |
| `ALREADY ISSUED` | Server answered with a 2xx and `created: false` — a clearance already existed for this leg, and this request returned the existing rows rather than writing new ones |
| `NOT FOR REAL WORLD USE` | Fixed last line of every clearance result |
| `CLEARANCE RECEIVED` / `CLEARANCE ON FILE` | Advisory after a successful send — new, or already on file |
| `NO CLEARANCE RECEIVED` | `DL-CLEARANCE` reached with nothing kept for the shown leg |
| `MESSAGES>` | `DL-CLEARANCE` R6 — opens the thread |

**Refusals** (local; nothing is sent):

| CDU text | Meaning |
|---|---|
| `NO FLIGHT PLAN` | No leg or flight resolved yet |
| `NO LINKED LEG` | The leg has no linked planned leg |
| `SCOPE UPDATE PENDING` | `R5` pressed while the scope hadn't yet caught up with a newly held prefiled leg |
| `INGEST TOKEN REJECTED` | Token already known to be rejected |
| `DATALINK NO CONFIG` | Sidecar has no valid config |
| `CLEARANCE LEG CHANGED` | Scope moved since the confirm page opened |

**Errors** (shown on `DL-INDEX`'s scratchpad after a failed `SEND*`; the hint
appears only on the reopened `DL-CLEARANCE-CONFIRM`, under `LAST REQUEST`):

| CDU text | Hint | Meaning |
|---|---|---|
| `PLANNED LEG NOT FOUND` | | The leg no longer exists on the server |
| `NO DISPATCH RELEASE ON FILE` | `IMPORT THE PLAN FROM SIMBRIEF` | No parseable dispatch release for the leg — e.g. a Little Navmap import with no SimBrief import run for it |
| `CLEARANCE UNAVAILABLE` | `SERVER UPDATE NEEDED` | Server answered, but not on a clearance-aware route |
| `INGEST TOKEN REJECTED` | `CHECK INGEST TOKEN ON CFG NETWORK` | Server rejected the token |
| `CLEARANCE TOKEN NOT RECEIVED` | `TOKEN HEADER LOST IN TRANSIT` | Token header never reached the server |
| `CLEARANCE REJECTED 403` | | Server refused the request |
| `CLEARANCE FAULT {status}` | | Any other non-2xx server response |
| `CLEARANCE BAD DATA` | | Response wasn't valid JSON or the expected shape |
| `CLEARANCE NO COMM` | | Can't reach the server |
| `CLEARANCE CERT FAULT` | `CHECK CERTIFICATE PATH` | TLS handshake failed |
| `CLEARANCE RESULT UNKNOWN` | `SAFE TO REQUEST AGAIN` | A sidecar or shell timeout on the request specifically — outcome unknown; pressing `SEND*` again is safe |
| `DATALINK NO CONFIG` | `COMPLETE CFG NETWORK` | Sidecar has no valid config |
| `INVALID ENTRY` | | Malformed request |
| `CLEARANCE IN PROGRESS` | | Shell or sidecar refused a concurrent clearance request |
| `DATALINK BUSY` | | The relay already had 8 requests pending (`PENDING_MAX = 8`) and refused this one, or the shell's internal queue to the sidecar was full |
| `DATALINK OFFLINE` | | Sidecar exited, or is unavailable |
| `SIDECAR UPDATE REQUIRED` | `REBUILD SIDECAR THEN RESTART APP` | This build's sidecar predates the clearance feature |
| `CLEARANCE NOT SUPPORTED` | | An installed custom host (not this app's own shell) lacks the clearance method |
| `CLEARANCE HOST FAULT` | | This build's own shell exe predates the clearance feature; restart the app |

## FPLN vocabulary

**Pilot ID and prefile outcome** (`FPLN` rows 2 and 10):

| CDU text | Hint | Meaning |
|---|---|---|
| `CONFIGURED` | | The server has a SimBrief Pilot ID on file |
| `NOT SET` | `SET PILOT ID ON SERVER` | No Pilot ID configured |
| `SENDING` | | The prefile request is in flight |
| `PREFILED` | | A new planned leg was created from the latest OFP |
| `ALREADY FILED` | | This OFP was already prefiled; same leg id |
| `NONE` | | No prefile attempt yet this session |

**Errors** (shown on `FPLN` row 2 or row 10 — note these have their own
FPLN-specific wording, distinct from the DATALINK table above even where the
underlying cause is shared):

| CDU text | Hint | Meaning |
|---|---|---|
| `NO SIMBRIEF PILOT ID` | `SET PILOT ID ON SERVER` | Server has no Pilot ID configured for this prefile |
| `SIMBRIEF ID NOT FOUND` | `CHECK PILOT ID ON SERVER` | Configured Pilot ID doesn't resolve on SimBrief |
| `NO SIMBRIEF OFP` | `GENERATE OFP ON SIMBRIEF` | The Pilot ID has no current OFP to import |
| `SIMBRIEF TIMEOUT` | `TRY AGAIN SHORTLY` | The server's own call to SimBrief timed out |
| `SIMBRIEF NO COMM` | `TRY AGAIN SHORTLY` | The server couldn't reach SimBrief |
| `SIMBRIEF ERROR` | `TRY AGAIN SHORTLY` | SimBrief answered with an unexpected status |
| `SIMBRIEF BAD DATA` | `TRY AGAIN SHORTLY` | SimBrief's response wasn't usable |
| `SERVER DB ERROR` | | The server failed to write the imported leg |
| `SIMBRIEF UNAVAILABLE` | `SERVER UPDATE NEEDED` | Server predates SimBrief prefile support |
| `INGEST TOKEN REJECTED` | `CHECK TOKEN ON CFG` | Server rejected the token |
| `TOKEN NOT RECEIVED` | `TOKEN LOST IN TRANSIT` | Token header never reached the server |
| `SERVER REJECTED 403` | | Server refused the request |
| `SERVER FAULT {status}` | | Any other non-2xx server response |
| `SERVER BAD DATA` | | Response wasn't valid JSON or the expected shape |
| `SERVER NO COMM` | | Can't reach the server |
| `SERVER CERT FAULT` | `CHECK CERTIFICATE PATH` | TLS handshake failed |
| `SERVER TIMEOUT` | | No response in time (settings check / clear) |
| `SIDECAR TIMEOUT` | | Shell-side timeout waiting on the sidecar |
| `SERVER NOT CONFIGURED` | `COMPLETE CFG NETWORK` | Sidecar has no valid config |
| `INVALID ENTRY` | | Malformed request |
| `PREFILE IN PROGRESS` | | Shell or sidecar refused a concurrent prefile request; not shown for a repeat press on `FPLN`/`FPLN-CONFIRM`, which is silently ignored while `SENDING` |
| `SIDECAR BUSY` | | The relay already had 8 requests pending (`PENDING_MAX = 8`) and refused this one, or the shell's internal queue to the sidecar was full |
| `SIDECAR OFFLINE` | | Sidecar exited, or is unavailable |
| `SIDECAR UPDATE REQUIRED` | `RESTART APP AFTER BUILD` | This build's sidecar predates the FPLN feature |
| `FPLN NOT SUPPORTED` | | An installed custom host lacks the FPLN method |
| `FPLN HOST FAULT` | | This build's own shell exe predates the FPLN feature |
| `PREFILE RESULT UNKNOWN` | `SAFE TO PREFILE AGAIN` | A sidecar or shell timeout on the prefile specifically — outcome unknown; pressing PREFILE again is safe |

**Prefiled-leg scope and advisories:**

| CDU text | When |
|---|---|
| `CLR PREFILE>` | Shown on `DL-INDEX` R1 and `FPLN` R3 whenever a prefiled leg is held |
| `PREFILE CLEARED` | Advisory after a successful `CLR PREFILE>` |
| `SIMBRIEF PLAN PREFILED` | Advisory after a `PREFILED` result |
| `PLAN ALREADY FILED` | Advisory after an `ALREADY FILED` result |

## Router-level and CFG scratchpad messages

| CDU text | When |
|---|---|
| `PAGE UNAVAILABLE` | A lazily-loaded page (CFG/DATALINK/FPLN) failed to import |
| `KEY NOT ACTIVE` | A key or LSK pressed with no handler on the current page |
| `COMMAND FAILED` | A page's key/LSK handler threw |
| `NOT ALLOWED` | An inactive LSK (`L1`–`L5`) pressed on `STATUS` |
| `INVALID ENTRY` | A CFG field failed validation |
| `ENTRY OUT OF RANGE` | `trafficRadiusM` outside `[1000, 200000]` |
| `USING DEFAULT 40000` | A non-numeric `trafficRadiusM` entry, applied instead of rejected |
| `CHECKED ON SAVE` | Advisory after entering `certPath` — the shell only checks the file's readability once the page is saved |
| `CONFIG SAVED` | A CFG page save succeeded |
| `SAVE FAILED` | A CFG page save was rejected by the shell |
| `CONFIG READ FAILED` | The config read at boot failed |
| `SIDECAR EXIT <code> - RESTARTING` | The message line after an unexpected sidecar exit, while the shell auto-restarts it |

## Timeouts relevant to the user

| Timeout | Value | What it governs |
|---|---|---|
| Datalink HTTP | 8 s | Sidecar's own request to the server for any DATALINK/clearance route |
| Prefile HTTP | 25 s | Sidecar's own request to the server for the SimBrief prefile route |
| Shell relay (general) | 12 s | Shell gives up waiting on the sidecar for a DATALINK/clearance relay before reporting `shell-timeout` |
| Shell relay (prefile) | 30 s | Same, but for a SimBrief prefile relay |
| DATALINK poll interval | 20 s | How often a DATALINK page polls while on screen (backs off further on repeated failures) |
| DATALINK poll lease | 65 s | How long a `watch:true` request keeps the sidecar polling before it stops on its own if no page renews it |

See [troubleshooting](troubleshooting.md) for what to do when any of the
above times out or shows a fault state.
