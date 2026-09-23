# Usage

Primary flows for running the Sabiá Windows client day to day. For key
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
and sends ACARS-style text messages against the Sabiá server, over the
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

**Requirements**: the Sabiá server must support the DATALINK routes; on
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

**This is a simulated exchange with the Sabiá server — NOT FOR REAL
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

**Requirements**: requesting a clearance needs a Sabiá server build with
the clearance route, later than DATALINK's own floor. Until then, `SEND*`
fails with `CLEARANCE UNAVAILABLE` (hint `SERVER UPDATE NEEDED` on the
reopened confirm page) and every other DATALINK page and the flight-data
uplink keep working normally.

## 10. SayIntentions: linking, importing and pushing a PDC

This is a front end to the Sabiá server's own, optional SayIntentions.AI
integration — the server holds the SayIntentions API key and does all the
talking to SayIntentions; the CDU only ever reads a boolean (`KEY ON FILE` /
`NO KEY ON FILE`) and never sees, collects or types the key itself. See
[security](security.md) for why that boundary is permanent.

`DL-INDEX` `R2` `SAYINTENTIONS>` opens `DL-SI` and never refuses — it is
always shown, whatever the scope, because the page itself is where every
refusal gets explained rather than hiding the explanation behind a missing
prompt.

**No key configured.** `DL-SI` row 2 reads `NO KEY ON FILE` and row 11 reads
`SET KEY ON WEB PREFILES PAGE`. This is reachable on the ground, in leg
scope, before a flight exists — leave the CDU, open the Sabiá web app's
Prefiles page, and save the key there. There is no CDU field for it.

**Link, unlink and import all need a live flight, not just a flight plan.**
`DL-SI` L4 `<LINK`, L5 `<UNLINK` and R5 `IMPORT>` each stage onto
`DL-SI-CONFIRM`, exactly like every other datalink write — nothing sends on
the first press. All three refuse with `NEEDS ACTIVE FLIGHT` in leg scope,
including the common pre-flight state of a SimBrief-prefiled leg with no
engines running yet. This is not a CDU limitation: the server's SayIntentions
routes require a `flights` row to bind the link to, and its own web client
has no link control on a planned leg either — a leg-scoped import would land
in the thread of whichever flight later happened to claim that leg, a
correlation the operator never made. Row 11 shows `LINK AVAILABLE ONCE
FLYING` while the refusal applies; the transition is automatic and needs no
action once the flight starts.

**`FROM NOW` versus `SESSION START`.** `DL-SI` R4 toggles the `LINK FROM`
choice shown on row 8. `SESSION START` is the default, and the one to use
normally: linking binds to whatever SayIntentions session the saved key
currently holds, and `SESSION START` backfills that session's whole history,
including the taxi and ready-to-taxi calls from before the link was pressed.
`NOW` is the escape hatch for a pilot who has already been flying for a while
across several legs and does not want the previous leg's radio chatter
pulled into this flight's thread — pick it before pressing L4, because the
choice is not recoverable after linking.

**`IMPORT>` is a manual, operator-pressed action by design — not a missing
poll.** Unlike the DATALINK thread, which polls the server every 20 seconds
on its own, nothing on `DL-SI` imports automatically. Every import reaches
the real SayIntentions upstream, which is undocumented, preview-status and
carries no documented rate limits of its own; the server's own web client is
manual for exactly that reason, and the Sabiá server team recommended
the same restraint here. Press R5 `IMPORT>`, then `SEND*` on the confirm
page, whenever fresh comms are wanted. A repeat import is always safe — the
server dedups on its own cursor — but it is never triggered for you.
Imported rows show up in the existing `DL-THREAD`, with no separate SayIntentions
message view: an ATC row renders through the same unknown-category fallback
every other unrecognized category already uses, `UP`/`DN` by the same
ground-relative convention as everything else in the thread.

**`NO_ACTIVE_SESSION` is a normal outcome, not a fault.** Pressing `SEND*`
against SayIntentions (an import, or the PDC push below) while SayIntentions
is simply not running that day shows `SAYINTENTIONS NOT RUNNING` — worded as
an advisory, never as an error, because a pilot flying without SayIntentions
open is expected and common, not broken. Start SayIntentions and press
`SEND*` again; the staged action is not cleared by this outcome.

**Pushing a PDC.** `DL-CLEARANCE` `R5` `SEND PDC>` (present once a clearance
is on file) opens `DL-SI-PDC`, staging a push of that leg's on-file PDC as a
real CPDLC message into the pilot's live SayIntentions session. `R6` `SEND*`
sends once; while in flight the page reads `SENDING`. On success the
scratchpad reads `PDC SENT` and `DL-SI-PDC` keeps the text actually sent as
`LAST SENT`. `NO PDC ON FILE` means `REQUEST CLEARANCE` (`DL-INDEX` R5) has
not been run for this leg yet. If the push times out, the CDU shows
`PDC MAY HAVE BEEN SENT` rather than a "safe to retry" wording — a repeat
press is a real decision, since it files a second CPDLC message into the live
session, and neither the CDU nor the server can tell afterwards whether the
first one arrived.

**A note on `DL-CLEARANCE`'s paging.** Adding `SEND PDC>` cost the route
block one line per page — page 1 now shows 4 route lines instead of 5, and
page 2 onward shows 8 instead of 9 — so a clearance route of five to nine
lines pages one more time than it used to. See
[cdu-reference § Page map](cdu-reference.md) for the exact row layout.

**Requirements**: SayIntentions needs a Sabiá server build with the six
SayIntentions routes; on an older server `DL-SI` and the `SEND PDC>` prompt
read `SAYINTENTIONS NOT SUPPORTED` / `SIDECAR UPDATE REQUIRED` as appropriate,
with no effect on DATALINK, FPLN or the flight-data uplink. See
[cdu-reference § SAYINTENTIONS vocabulary](cdu-reference.md) for every string
and [api](api.md) for the six routes.

## 11. FPLN: SimBrief prefile

FPLN is a separate feature from DATALINK: it imports your latest SimBrief
OFP into the Sabiá server as a new, trip-less planned leg, which
DATALINK can then be used against. It shares DATALINK's connection settings
and ingest token. `MENU` → `L6` `<FPLN` opens `FPLN` (`FLIGHT PLAN`), which
behaves identically before and after `START>`.

- `FPLN` row 2 shows `CONFIGURED` or `NOT SET` for the SimBrief Pilot ID,
  read fresh each time the page opens. **The Pilot ID is set only on the
  Sabiá web app** — there is no CDU page to enter or change it; FPLN
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

**Requirements**: the Sabiá server must support SimBrief prefile —
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

DATALINK, FPLN, PDC clearance and SayIntentions all use the same ingest token
already set on `CFG NETWORK` — there is no separate login for any of them,
and the token is never shown on the CDU. Each feature needs the Sabiá
server to be running a build that has its corresponding route; on an older
server the CDU shows the relevant `UNAVAILABLE`/`NOT SUPPORTED` state
(`DATALINK UNAVAILABLE`, `SIMBRIEF UNAVAILABLE`, `CLEARANCE UNAVAILABLE`, or
`SAYINTENTIONS NOT SUPPORTED`), and every other feature, including the base
flight-data uplink, is unaffected. FPLN additionally requires a SimBrief
Pilot ID configured on the Sabiá server itself, and SayIntentions
additionally requires a SayIntentions API key saved on the server's own web
Prefiles page (never on the CDU, for either). See
[cdu-reference](cdu-reference.md) for the exact CDU text and hints for every
case, and [troubleshooting](troubleshooting.md) for diagnosing which one you
are seeing.
