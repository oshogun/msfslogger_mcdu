# Usage

Primary flows for running the msfslogger Windows client day to day. For key
and page conventions, the full page map and every CDU vocabulary table, see
[cdu-reference](cdu-reference.md). For build/run/debug commands, see
[operations](operations.md) and [development](development.md) — this page
only shows the CDU-side steps.

## 1. First launch and configuring

1. Launch the client. It opens on the `STATUS` page reading `NO CONFIG` (App
   axis) if no config file exists yet.
2. Press the `MENU` key.
3. On `MENU`, press the line-select key (LSK) next to `<NETWORK`.
4. On `CFG NETWORK`: type the server URL on the scratchpad and press `L1`;
   type the ingest token and press `L2`; type the certificate path (if the
   server runs HTTPS, which is the norm) and press `L3`.
5. Press `R6` (`SAVE>`) to write the file — `EXEC` does the same thing. The
   scratchpad shows `CONFIG SAVED`.
6. Press `MENU` again, then `<SIM` to set the SimConnect protocol version
   (`2020`/`2024`/`fsx`) and auto-start behaviour, or `<TRAFFIC` to set AI
   traffic on/off and the sweep radius (1000–200000 m). Each page saves the
   same way, `R6`/`EXEC`.
7. Back on `STATUS`, press `START>` (`R6`) to begin the uplink — skip this if
   `autoUplink` is on, since it starts by itself.

An entry that fails validation never reaches the file: the scratchpad shows a
one-line reason and the field keeps its previous value. `CFG NETWORK`:
`serverUrl` must be `http(s)://…`; `ingestToken` must be non-empty.
`CFG TRAFFIC`: `trafficRadiusM` outside `[1000, 200000]` shows
`ENTRY OUT OF RANGE`; a non-numeric entry falls back to `40000` with
`USING DEFAULT 40000` rather than being rejected. See
[cdu-reference § CFG validation](cdu-reference.md) for the full table.

The token itself is never redisplayed — `CFG NETWORK` L2 always reads
`••••••••` once one is set. Re-entering it replaces the stored token; leaving
it untouched preserves the one already on disk.

## 2. Starting/stopping the uplink and auto-start

- `STATUS` R6 toggles `START>`/`STOP>` depending on whether the uplink is
  running (App axis `UPLINK ACTIVE` vs `UPLINK STOPPED`).
- With `autoUplink` on (`CFG SIM`, L2), the uplink starts by itself the
  moment the sidecar has a valid config — no `START>` press needed at launch.
- Stopping the uplink does not stop the sidecar process itself, and has no
  effect on DATALINK or FPLN, which poll independently of the uplink state.

## 3. Reading STATUS during a flight

`STATUS` shows four axes — App, Sim, Backend, Pause — plus a traffic advisory
line and the config file path, all repainted on every status push from the
sidecar. The axes are independent by design: MSFS not being open yet and the
server being unreachable are different problems with different fixes, so
neither is ever hidden behind the other. The working state is App
`UPLINK ACTIVE`, Sim `SIM LINK ONLINE`, Backend `ACARS UPLINK`. See
[cdu-reference § STATUS vocabulary](cdu-reference.md) for every label,
severity and the recommended action.

## 4. Recovering from a sidecar crash

If the sidecar process dies unexpectedly, `STATUS`'s App axis reads
`SIDECAR FAULT` and the message line shows `SIDECAR EXIT <code> - RESTARTING`
while the shell's supervisor retries automatically (2 s delay, up to 5
restarts per rolling 60 s window). If it exhausts that budget, the App axis
sticks at `SIDECAR FAULT` and `STATUS` shows an `R5` prompt: press `R5` to
force a restart, which also clears the restart budget. `R5` only does
anything while the app is in this crashed state — on any other row it is
inactive.

If restarts keep exhausting the budget, see
[troubleshooting](troubleshooting.md) for the app/sidecar-won't-start table.

## 5. DATALINK: reading messages

DATALINK is a separate feature from the flight-data uplink above: it reads
and sends ACARS-style text messages against the msfslogger server, over the
same connection settings, with its own state line. `MENU` → `L5` `<DATALINK`
opens `DL-INDEX` (`ACARS DATALINK`), which shows the current scope and the
DATALINK state line (its own axis, separate from `STATUS`'s Backend line —
DATALINK faults never appear there).

- `L3` `<MESSAGES` opens `DL-THREAD`: the message thread for the current
  scope, five per page, oldest first, opening on the newest page. `L1`–`L5`
  open a message; `R6` `REFRESH>` polls immediately.
- Opening a message shows `DL-MSG`, paged 10 lines at a time; `L6` `<RETURN`
  goes back to the thread page it came from.
- `R6` `REFRESH>` on `DL-INDEX` polls immediately without waiting for the
  next cycle.

DATALINK polls the server every 20 seconds, but only while a DATALINK page is
on screen — there is no background polling and no new-message annunciator
elsewhere. It works before `START>` is pressed and independently of the
uplink.

**Requirements**: the msfslogger server must support the DATALINK routes; on
an older server, DATALINK pages show `DATALINK UNAVAILABLE` and nothing else
works on them, with no effect on the regular flight-data uplink (`STATUS`
keeps reading `ACARS UPLINK`/`ACARS READY` normally). DATALINK uses the same
ingest token already set on `CFG NETWORK` — no separate login.

## 6. Sending a canned downlink

`DL-INDEX` `L4` `<DOWNLINK` opens `DL-CANNED`, the server's list of canned
messages. Picking one (`L1`–`L5`) stages it and opens `DL-CONFIRM`
(`CONFIRM SEND`). `R6` `SEND*` is the one press that actually sends it; `L6`
`<CANCEL` discards it without sending anything. No single key press anywhere
in DATALINK sends a message by itself — every write stops at `DL-CONFIRM`
first. On success the scratchpad shows `DOWNLINK SENT`.

## 7. Requesting weather (WX)

`DL-INDEX` `R3` `WX REQUEST>` opens `DL-WX`. Type a 4-letter ICAO on the
scratchpad and press `L1` to stage it, then `R6` `REQUEST>` opens
`DL-CONFIRM`. An empty or malformed ICAO shows `INVALID ENTRY` and stages
nothing. On success, `DL-WX-RESULT` shows the returned METAR and TAF, paged.

## 8. Requesting a loadsheet

`DL-INDEX` `R4` `LOADSHEET>` opens `DL-LOADSHEET`: the last illustrative
loadsheet received for the current leg, or `R6` `REQUEST>` to fetch one via
`DL-CONFIRM`. On success the scratchpad shows `LOADSHEET RECEIVED` (new
figures) or `LOADSHEET ON FILE` (same figures already on file). Loadsheets
are generated per planned leg; a flight scope with no linked leg shows
`NO LINKED LEG` instead of staging a request.

## 9. REQUEST CLEARANCE (simulated PDC clearance)

**This is a simulated exchange with the msfslogger server — NOT FOR REAL
WORLD USE.** It never contacts a real ATC system.

`DL-INDEX` `R5` `CLEARANCE>` requests a simulated pre-departure clearance for
whichever leg is the current scope. `R5` opens `DL-CLEARANCE-CONFIRM`
(`REQUEST CLEARANCE`), showing the leg as `LEG <id>`. `R6` `SEND*` is the one
press that sends the request — it re-checks the leg against the current
scope first, and if it has changed since the page opened, nothing is sent
and the scratchpad reads `CLEARANCE LEG CHANGED`. While in flight the page
reads `SENDING`; at most one clearance request is ever in flight. `L6`
`<CANCEL` discards a staged request.

On success, `DL-CLEARANCE` shows `SIMULATED CLEARANCE`, `<DEP> TO <DEST>`,
the initial altitude, the squawk, and the cleared route (paged); the last
line always reads `NOT FOR REAL WORLD USE`. The app keeps the last result for
up to 4 legs in memory for the rest of the session, so pressing `R5` again
for one of those legs reopens the kept result rather than sending a new
request, until the app restarts or `CFG NETWORK` saves a different server
URL or token.

A leg with no SimBrief dispatch release on file (for example one imported
only from Little Navmap, with no SimBrief import run for it) cannot be
cleared — the scratchpad reads `CLEARANCE UNAVAILABLE` first, and pressing
`R5` again shows the hint `IMPORT THE PLAN FROM SIMBRIEF` on the reopened
confirm page. See [cdu-reference § CLEARANCE vocabulary](cdu-reference.md)
for every refusal and error code.

**Requirements**: requesting a clearance needs a msfslogger server build with
the clearance route, later than DATALINK's own floor. Until then, `SEND*`
fails with `CLEARANCE UNAVAILABLE` (hint `SERVER UPDATE NEEDED` on the
reopened confirm page) and every other DATALINK page and the flight-data
uplink keep working normally.

## 10. FPLN: SimBrief prefile

FPLN is a separate feature from DATALINK: it imports your latest SimBrief
OFP into the msfslogger server as a new, trip-less planned leg, which
DATALINK can then be used against. It shares DATALINK's connection settings
and ingest token. `MENU` → `L6` `<FPLN` opens `FPLN` (`FLIGHT PLAN`), which
behaves identically before and after `START>`.

- `FPLN` row 2 shows `CONFIGURED` or `NOT SET` for the SimBrief Pilot ID,
  read fresh each time the page opens. **The Pilot ID is set only on the
  msfslogger web app** — there is no CDU page to enter or change it; FPLN
  only reads whether one is configured.
- With a Pilot ID configured, `R6` `PREFILE>` opens `FPLN-CONFIRM`
  (`PREFILE SIMBRIEF`), a staging page — nothing is sent yet.
- `R6` `CONFIRM*` on that page sends the request. It reads `SENDING` /
  `WAIT UP TO 30 SEC` while in flight; pressing `R6` again while sending is
  ignored, not a second request.
- On success, `FPLN-RESULT` shows `PREFILED` (a new leg was created) or
  `ALREADY FILED` (this OFP was already prefiled), plus the label and the
  leg id. PREFILE is never retried automatically; if the result comes back
  unknown after a timeout, pressing PREFILE again is safe — the server
  checks for a duplicate before writing.

**Requirements**: the msfslogger server must support SimBrief prefile —
later than DATALINK's own floor. Before that, FPLN reads
`SIMBRIEF UNAVAILABLE` (hint `SERVER UPDATE NEEDED`) and `PREFILE>` stays
hidden, with no effect on DATALINK or the flight-data uplink.

### CLR PREFILE and the prefiled-leg scope

Once PREFILE succeeds, DATALINK picks up the new leg as the active scope:
`DL-INDEX`'s scope line reads `PREFILE`, `R1` shows `CLR PREFILE>`, and the
leg id shows on its own row, `PREFILED LEG`. `DL-THREAD`'s label row reads
`PREFILE <id>`. DATALINK's message thread, WX request and loadsheet all
target that leg. Precedence: an active flight always outranks a prefiled
leg, which in turn outranks any ground-session leg the server reports.

The prefiled leg clears automatically the moment a flight is detected, if
the leg is gone from the server, on a token rejection, or on a `CFG NETWORK`
change that alters the server URL or token. It also clears manually with
`CLR PREFILE>` (`DL-INDEX` `R1` or `FPLN` `R3`), which answers
`PREFILE CLEARED`. It lives only in the sidecar's memory — it is not saved
to `config.json` and does not survive a sidecar restart. A newer successful
PREFILE simply replaces the leg already held.

## Server-side requirements summary

DATALINK, FPLN and PDC clearance all use the same ingest token already set
on `CFG NETWORK` — there is no separate login for any of them, and the token
is never shown on the CDU. Each feature needs the msfslogger server to be
running a build that has its corresponding route; on an older server the
CDU shows the relevant `UNAVAILABLE` state (`DATALINK UNAVAILABLE`,
`SIMBRIEF UNAVAILABLE`, or `CLEARANCE UNAVAILABLE`), and every other feature,
including the base flight-data uplink, is unaffected. FPLN additionally
requires a SimBrief Pilot ID configured on the msfslogger server itself
(never on the CDU). See [cdu-reference](cdu-reference.md) for the exact CDU
text and hints for every case, and [troubleshooting](troubleshooting.md) for
diagnosing which one you are seeing.
