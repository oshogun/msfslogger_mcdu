// ── Navdata demand: the airports and fixes the server wants in detail ────────
//
// The server lists what it would draw and does not yet hold — airports named by
// a filed plan, the one a user asked for with "Fetch detail", the fixes a
// route's airways run through, and the plan's VORs and NDBs — and this module
// collects that list, fetches
// each item in turn and lets the incremental sync carry the result back.
// Nothing here talks to the server about what it did: rows go back as rows, and
// something the simulator does not have goes back as a `nav_absent` row in the
// same stream.
//
// THE SERVER KEEPS NO BOOKKEEPING, SO THIS SIDE MUST. It answers with current
// need only — its own planned legs minus what its replica holds — and truncates
// at a `cap` it chooses. There is no acknowledgement: it stops asking for an
// airport once the rows or the absence have replicated to it. Two things follow.
// An airport this store already holds is dropped for the cost of one lookup,
// because the server will go on naming it until the sync catches up. And a
// truncated list (`more`) comes back the same until then, so it is only polled
// again at once when the last page added work; otherwise it is polled again
// when the queue has drained, and after that at the normal interval.
//
// ONE ITEM AT A TIME: AIRPORTS, THEN FIXES, THEN NAVAIDS. A large airport's whole procedure tree is
// written in one transaction on the thread that also runs the 1 Hz frame loop,
// so the queue never has more than one fetch out and yields a turn between
// items. Fixes are cheap — a few dozen in well under two seconds, one after the
// other — and could be fetched several at a time, but nothing has measured what
// that does to the frame loop, so they are not.
//
// A FETCH THAT KEEPS FAILING IN OUR OWN CODE IS SET ASIDE. A decoder that throws
// settles the request as aborted, and an aborted request goes back on the queue
// — which on its own would fetch, throw and re-queue for ever at full speed. So
// consecutive attempts that end without an answer, and not because the link
// went away, are counted per item, and one that reaches the limit is
// parked with a single log line until the next connection or store, which gives
// it one fresh chance. An abort caused by a disconnect says nothing about the
// item and is not counted. Every poll names the parked items to the server
// so it can leave them out before it applies its cap; otherwise a server that
// sorts them first would fill every page with them.
//
// NOTHING HERE THROWS AT ITS CALLER, nothing here logs the token or a response
// body, and nothing here touches the backend status axis.

import {
  AIRPORT_DETAIL_DEFINITION,
  airportDetailSpec,
  fetchAirportDetail,
  type AirportDetailOptions,
  type AirportDetailResult,
} from './navdata-detail';
import { NAVDATA_WIRE_VERSION } from './navdata-export';
import type { FacilityDefinition, FacilitySession } from './navdata-facilities';
import {
  FIX_ROUTES_DEFINITION,
  fetchFixRoutes,
  fixDefinitionUsable,
  fixRoutesSpec,
  type FixRoutesOptions,
  type FixRoutesResult,
} from './navdata-fixes';
import {
  fetchNavaid,
  NDB_DEFINITION,
  ndbDetailSpec,
  navaidDefinitionUsable,
  VOR_DEFINITION,
  vorDetailSpec,
  type NavaidKind,
  type NavaidOptions,
  type NavaidResult,
} from './navdata-navaids';
import type { NavdataStore } from './navdata-store';
import {
  busyWaitMs,
  NavdataSyncClient,
  type DemandSkip,
  type NavdataDemandRequester,
  type NavdataOutcome,
  type NavdataTransport,
} from './navdata-sync';
import type { LogSink } from './uplink';

/** How often the list is read while it has nothing new in it. */
export const NAVDATA_DEMAND_POLL_MS = 60_000;
export const NAVDATA_DEMAND_BACKOFF_MAX_MS = 600_000;
/**
 * The most items of ONE kind the queue holds, and the size under which a
 * truncated list is read again at once. Airports, fixes and navaids each have
 * their own allowance, so one kind that cannot be fetched never keeps another
 * out.
 */
export const DEMAND_QUEUE_HIGH_WATER = 200;
/** Consecutive attempts that fail in this build's own code before an airport is set aside. */
export const DEMAND_FAULT_PARK_AFTER = 3;
/** The most parked idents one poll reports; the server refuses a longer list. */
export const DEMAND_SKIP_MAX = 200;

/** 60 s while healthy, doubling per consecutive failure, capped at 600 s. */
export function nextDemandDelayMs(consecutiveFailures: number): number {
  const f = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0 ? Math.floor(consecutiveFailures) : 0;
  if (f === 0) return NAVDATA_DEMAND_POLL_MS;
  return Math.min(NAVDATA_DEMAND_POLL_MS * 2 ** Math.min(f, 16), NAVDATA_DEMAND_BACKOFF_MAX_MS);
}

// ── The wire ──────────────────────────────────────────────────────────────────

export interface DemandResponse {
  v: typeof NAVDATA_WIRE_VERSION;
  /** Airport idents wanted in full detail. Uppercase, 1..8 chars. */
  airports: string[];
  /** Fixes wanted with their ROUTE (airway) children. */
  waypoints: DemandWaypoint[];
  /** The per-poll cap the server applied. Echoed so the sidecar can log it. */
  cap: number;
  /** True when the server truncated at `cap`: poll again immediately. */
  more: boolean;
  generatedAt: number;
}

export interface DemandWaypoint {
  ident: string;
  /** Omitted or null when the server does not know it — a legal, common case. */
  region?: string | null;
  /**
   * What the plan says this point is: 'W' is an enroute fix, 'V' a VOR and 'N'
   * an NDB. Omitted by an older server, and then the point is a fix.
   */
  kind?: 'W' | 'V' | 'N';
}

/** The kinds of point the server may name, as the `kind` field spells them. */
const WAYPOINT_KINDS: readonly string[] = ['W', 'V', 'N'];

export type ParsedDemand =
  | {
      ok: true;
      demand: DemandResponse;
      /** Entries that did not validate and were left out, by list. */
      droppedAirports: number;
      droppedWaypoints: number;
    }
  | { ok: false; reason: string };

/** Uppercase letters and digits, one to eight of them. */
const IDENT = /^[A-Z0-9]{1,8}$/;

/**
 * Reads a demand response defensively. The shape — version, both lists, the
 * cap and the flag — has to be right or the whole answer is refused, since a
 * list read out of a malformed answer cannot be trusted to be the server's.
 * Single entries that do not validate are left out and counted. The reason
 * names the field, never its value: this text reaches a log.
 */
export function parseDemand(body: unknown): ParsedDemand {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'not an object' };
  }
  const raw = body as Record<string, unknown>;
  if (raw.v !== NAVDATA_WIRE_VERSION) return { ok: false, reason: 'unsupported version' };
  if (!Array.isArray(raw.airports)) return { ok: false, reason: 'airports is not a list' };
  if (!Array.isArray(raw.waypoints)) return { ok: false, reason: 'waypoints is not a list' };
  if (typeof raw.cap !== 'number' || !Number.isInteger(raw.cap) || raw.cap < 1) {
    return { ok: false, reason: 'cap is missing or invalid' };
  }
  if (typeof raw.more !== 'boolean') return { ok: false, reason: 'more is missing or invalid' };

  const airports: string[] = [];
  const seen = new Set<string>();
  let droppedAirports = 0;
  for (const entry of raw.airports) {
    if (typeof entry !== 'string' || !IDENT.test(entry)) {
      droppedAirports++;
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    airports.push(entry);
  }

  const waypoints: DemandWaypoint[] = [];
  let droppedWaypoints = 0;
  for (const entry of raw.waypoints) {
    const waypoint = parseWaypoint(entry);
    if (waypoint === null) droppedWaypoints++;
    else waypoints.push(waypoint);
  }

  return {
    ok: true,
    demand: {
      v: NAVDATA_WIRE_VERSION,
      airports,
      waypoints,
      cap: raw.cap,
      more: raw.more,
      generatedAt: typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt) ? raw.generatedAt : 0,
    },
    droppedAirports,
    droppedWaypoints,
  };
}

function parseWaypoint(entry: unknown): DemandWaypoint | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { ident, region, kind } = entry as { ident?: unknown; region?: unknown; kind?: unknown };
  if (typeof ident !== 'string' || !IDENT.test(ident)) return null;
  // A kind this build does not know is not guessed at: asking for a VOR as a
  // fix is exactly the mistake the field exists to prevent.
  if (kind !== undefined && (typeof kind !== 'string' || !WAYPOINT_KINDS.includes(kind))) return null;
  const typed = kind === undefined ? {} : { kind: kind as 'W' | 'V' | 'N' };
  if (region === undefined) return { ident, ...typed };
  if (region === null) return { ident, region: null, ...typed };
  if (typeof region !== 'string' || !IDENT.test(region)) return null;
  return { ident, region, ...typed };
}

// ── The queue ─────────────────────────────────────────────────────────────────

export type FetchDetail = (
  session: FacilitySession,
  store: NavdataStore | null,
  definition: FacilityDefinition,
  ident: string,
  options?: AirportDetailOptions,
) => Promise<AirportDetailResult>;

export type FetchFix = (
  session: FacilitySession,
  store: NavdataStore | null,
  definition: FacilityDefinition,
  ident: string,
  region: string | null,
  options?: FixRoutesOptions,
) => Promise<FixRoutesResult>;

export type FetchNavaid = (
  session: FacilitySession,
  store: NavdataStore | null,
  definition: FacilityDefinition,
  kind: NavaidKind,
  ident: string,
  region: string | null,
  options?: NavaidOptions,
) => Promise<NavaidResult>;

export interface NavdataDemandDeps {
  /** The uplink, or null while there is no valid config. */
  transport(): NavdataTransport | null;
  /** The open store, or null when navdata has none. */
  store(): NavdataStore | null;
  /**
   * The facility session detail may be fetched on right now, or null — no
   * connection, a connection this client cannot read, or a bulk pass that has
   * the connection to itself.
   */
  session(): FacilitySession | null;
  log: LogSink;
  /** Something the navdata axis shows has changed. */
  onChange(): void;
  /** Test seams. */
  client?: NavdataDemandRequester;
  fetchDetail?: FetchDetail;
  fetchFix?: FetchFix;
  fetchNavaid?: FetchNavaid;
}

/** What the service needs from the queue, so a test can stand in for it. */
export interface NavdataDemandLike {
  start(): void;
  stop(): void;
  shutdown(): void;
  onConfigApplied(): void;
  /** A session may have become usable: fetch whatever is queued. */
  wake(): void;
  /** Airports queued or being fetched. Fixes and navaids are not counted. */
  pending(): number;
  /** One line worth showing while nothing is wrong, or null. */
  note(): string | null;
}

/**
 * One thing the server asked for: an airport, a fix ('W'), a VOR ('V') or an
 * NDB ('N'). A point's region is null when the server did not know it.
 */
type DemandItem =
  | { readonly kind: 'A'; readonly ident: string }
  | { readonly kind: 'W' | NavaidKind; readonly ident: string; readonly region: string | null };

/** The queues: airports, then fixes, then navaids, each bounded on its own. */
type Lane = 'A' | 'W' | 'NAV';

function laneOf(item: DemandItem): Lane {
  return item.kind === 'A' || item.kind === 'W' ? item.kind : 'NAV';
}

/**
 * The queue's key for an item. A point asked for without a region is its own
 * item, distinct from the same ident in any region: what comes back for it may
 * be a different facility, or several.
 */
function itemKey(item: DemandItem): string {
  return item.kind === 'A' ? `A:${item.ident}` : `${item.kind}:${item.ident}|${item.region ?? ''}`;
}

function itemLabel(item: DemandItem): string {
  const noun = item.kind === 'V' ? 'VOR ' : item.kind === 'N' ? 'NDB ' : '';
  return item.kind !== 'A' && item.region !== null ? `${noun}${item.ident}/${item.region}` : `${noun}${item.ident}`;
}

/** The prepared definitions of one session; any may be missing. */
interface SessionDefinitions {
  readonly airport: FacilityDefinition | null;
  readonly fix: FacilityDefinition | null;
  readonly vor: FacilityDefinition | null;
  readonly ndb: FacilityDefinition | null;
}

export class NavdataDemand implements NavdataDemandLike {
  private readonly deps: NavdataDemandDeps;
  private readonly log: LogSink;
  private readonly client: NavdataDemandRequester;
  private readonly fetchDetail: FetchDetail;
  private readonly fetchFix: FetchFix;
  private readonly fetchNavaid: FetchNavaid;

  private running = false;
  private shuttingDown = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  /** The last poll failure logged, so a failing server is not one line per try. */
  private loggedError: string | null = null;
  /** A truncated list is waiting on the queue to drain before it is read again. */
  private moreWaiting = false;
  /** Whether the poll now scheduled is an immediate re-read, not a timed one. */
  private nextIsRepoll = false;
  /**
   * Items that ended without an answer since the last timed poll. A stateless
   * server names them again on every re-read of a truncated list, and without
   * this each re-read would count them as new work and try them again at once:
   * measured live, a missing fix was tried three times and parked in 0.2 s.
   * Holding them until the next timed poll makes it one attempt per cycle.
   */
  private readonly unansweredThisCycle = new Set<string>();

  /** Airports go first: they are what a map draws at both ends of a route. */
  private readonly airports: DemandItem[] = [];
  private readonly fixes: DemandItem[] = [];
  private readonly navaids: DemandItem[] = [];
  private readonly queued = new Set<string>();
  private inFlight: DemandItem | null = null;
  private pumping = false;

  /** Consecutive attempts per item that failed in this build's own code. */
  private readonly faults = new Map<string, number>();
  private readonly parked = new Map<string, DemandItem>();
  /**
   * Parked items the server is NOT told about. A fix answered by another
   * station is one: its ident is very likely a VOR's, and `skipWaypoints` names
   * idents alone for fixes, VORs and NDBs together, so skipping it would hide
   * the VOR the plan also wants. It is dropped here instead, when the server
   * lists it again, for the cost of one lookup and one slot on the page.
   */
  private readonly parkedLocally = new Set<string>();
  /** The session and store the counts above were earned on. */
  private faultSession: FacilitySession | null = null;
  private faultStore: NavdataStore | null = null;

  /** The definitions, prepared once per session. */
  private definitions: { session: FacilitySession; ready: Promise<SessionDefinitions> } | null = null;

  private collisions = 0;
  private readonly collidedAirports = new Set<string>();
  /** Whether the last poll had to cut a skip list short, so that is said once. */
  private readonly skipTruncated = { A: false, W: false };

  constructor(deps: NavdataDemandDeps) {
    this.deps = deps;
    this.log = (level, message) => {
      try {
        deps.log(level, message);
      } catch {
        // Reporting is not worth failing over.
      }
    };
    this.client = deps.client ?? new NavdataSyncClient(() => deps.transport());
    this.fetchDetail = deps.fetchDetail ?? fetchAirportDetail;
    this.fetchFix = deps.fetchFix ?? fetchFixRoutes;
    this.fetchNavaid = deps.fetchNavaid ?? fetchNavaid;
  }

  /**
   * Airports only. The axis says how much map detail is outstanding, and a fix
   * is a fraction of a second of work that nobody watches for; counting fifty
   * of them would make a queue with nothing visible in it look busy.
   */
  pending(): number {
    return this.airports.length + (this.inFlight?.kind === 'A' ? 1 : 0);
  }

  /** Everything queued or in flight. */
  private size(): number {
    return this.airports.length + this.fixes.length + this.navaids.length + (this.inFlight === null ? 0 : 1);
  }

  private queueOf(lane: Lane): DemandItem[] {
    return lane === 'A' ? this.airports : lane === 'W' ? this.fixes : this.navaids;
  }

  /** Queued or in flight in one lane: each is bounded on its own. */
  private sizeOf(lane: Lane): number {
    return this.queueOf(lane).length + (this.inFlight !== null && laneOf(this.inFlight) === lane ? 1 : 0);
  }

  note(): string | null {
    if (this.collisions === 0) return null;
    // Not a fault: every procedure is stored. It is the one sign that an
    // airport's procedure keys carry a disambiguator, and worth being able to see.
    return (
      `${this.collisions} procedure(s) at ${this.collidedAirports.size} airport(s) ` +
      'shared a key with another and were stored apart'
    );
  }

  /** The uplink is running: the list may be read. */
  start(): void {
    if (this.shuttingDown) return;
    this.running = true;
    this.schedule(0);
  }

  /**
   * The uplink stopped. Polling stops; the queue stays, since what the server
   * asked for is still worth fetching when it comes back.
   */
  stop(): void {
    this.running = false;
    this.moreWaiting = false;
    this.cancelTimer();
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.stop();
  }

  /** A config was applied; the server it names may be a different one. */
  onConfigApplied(): void {
    this.failures = 0;
    this.loggedError = null;
    if (this.running) this.schedule(0);
  }

  wake(): void {
    if (this.pumping || this.shuttingDown) return;
    void this.pump();
  }

  // ── polling ─────────────────────────────────────────────────────────────────

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number, repoll = false): void {
    this.cancelTimer();
    this.nextIsRepoll = repoll;
    if (!this.running || this.shuttingDown) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  /** One poll. Never throws: every path out of it is a scheduled one. */
  private async tick(): Promise<void> {
    if (!this.running || this.shuttingDown || this.polling) return;
    this.polling = true;
    const repoll = this.nextIsRepoll;
    this.nextIsRepoll = false;
    // A timed poll starts a new cycle, in which everything may be tried once more.
    if (!repoll) this.unansweredThisCycle.clear();
    let delay = NAVDATA_DEMAND_POLL_MS;
    try {
      delay = await this.poll();
    } catch (err) {
      delay = this.fail(`the demand poll failed (${describe(err)})`);
    } finally {
      this.polling = false;
    }
    // Zero is only ever returned for a truncated list worth reading again at once.
    this.schedule(delay, delay === 0);
  }

  private async poll(): Promise<number> {
    // Only while there is a server to ask and a store to hold the answer.
    if (this.serverUrl() === null || this.deps.store() === null) return NAVDATA_DEMAND_POLL_MS;

    // A new connection forgives what was parked on the last one, and that has
    // to happen before the skip lists are built, not after the answer arrives.
    this.noticeContext();
    const skipAirports = this.skipList('A');
    const skipWaypoints = this.skipList('W');
    const skip: DemandSkip = {
      ...(skipAirports.length > 0 ? { airports: skipAirports } : {}),
      ...(skipWaypoints.length > 0 ? { waypoints: skipWaypoints } : {}),
    };

    let outcome: NavdataOutcome;
    try {
      outcome = await this.client.getDemand(Object.keys(skip).length > 0 ? skip : undefined);
    } catch (err) {
      outcome = { kind: 'transport', errorName: describe(err), errorCode: null };
    }

    if (outcome.kind === 'response' && outcome.status === 503 && outcome.code === 'NAVDATA_BUSY') {
      // Not a failure. The server is mid-swap and says when to come back.
      const wait = busyWaitMs(outcome.retryAfterMs);
      this.log('debug', `navdata: the server is importing a snapshot; reading demand again in ${wait} ms`);
      return wait;
    }
    if (outcome.kind !== 'response') {
      return this.fail(`the demand list could not be read (${outcome.errorCode ?? outcome.errorName ?? 'unknown'})`);
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      const code = outcome.code === null ? '' : ` ${outcome.code}`;
      return this.fail(`the demand list was refused (HTTP ${outcome.status}${code})`);
    }

    const parsed = parseDemand(outcome.body);
    if (!parsed.ok) return this.fail(`the server's demand list was malformed (${parsed.reason})`);

    this.failures = 0;
    this.loggedError = null;
    const { demand } = parsed;
    if (parsed.droppedAirports > 0 || parsed.droppedWaypoints > 0) {
      this.log(
        'warn',
        `navdata: left out ${parsed.droppedAirports} airport(s) and ${parsed.droppedWaypoints} fix(es) ` +
          'the server named in a form this client does not accept (an ident, a region or a kind)',
      );
    }
    let airports = demand.airports;
    let waypoints = demand.waypoints;
    if (airports.length > demand.cap || waypoints.length > demand.cap) {
      this.log(
        'debug',
        `navdata: the server named ${airports.length} airports and ${waypoints.length} fixes under a cap of ${demand.cap}`,
      );
      airports = airports.slice(0, demand.cap);
      waypoints = waypoints.slice(0, demand.cap);
    }

    const addedAirports = this.enqueue(airports.map((ident): DemandItem => ({ kind: 'A', ident })));
    // A point the server gives no kind is a fix: that is what an older server meant.
    const addedFixes = this.enqueue(
      waypoints
        .filter((w) => (w.kind ?? 'W') === 'W')
        .map((w): DemandItem => ({ kind: 'W', ident: w.ident, region: w.region ?? null })),
    );
    const addedNavaids = this.enqueue(
      waypoints
        .filter((w) => w.kind === 'V' || w.kind === 'N')
        .map((w): DemandItem => ({ kind: w.kind as NavaidKind, ident: w.ident, region: w.region ?? null })),
    );
    const added = addedAirports + addedFixes + addedNavaids;
    if (added > 0) {
      this.log(
        'info',
        `navdata: the server wants ${addedAirports} more airport(s) in detail, ${addedFixes} more fix(es) ` +
          `with their airways and ${addedNavaids} more VOR/NDB(s) (${this.pending()} airport(s) pending, cap ${demand.cap})`,
      );
      this.deps.onChange();
      this.wake();
    }

    if (!demand.more) {
      this.moreWaiting = false;
      return NAVDATA_DEMAND_POLL_MS;
    }
    // The server truncated. Asking again at once only helps when this page
    // brought something new: an unchanged page means the rest of the list is
    // behind work this side has queued and the server has not yet heard about.
    const room = (['A', 'W', 'NAV'] as const).every((lane) => this.sizeOf(lane) < DEMAND_QUEUE_HIGH_WATER);
    if (added > 0 && room) return 0;
    this.moreWaiting = true;
    if (this.size() === 0) {
      // Nothing is queued, so there is no drain to wait for.
      this.moreWaiting = false;
    }
    return NAVDATA_DEMAND_POLL_MS;
  }

  private fail(reason: string): number {
    this.failures++;
    if (this.loggedError !== reason) {
      this.loggedError = reason;
      this.log('warn', `navdata: ${reason}`);
    }
    return nextDemandDelayMs(this.failures);
  }

  /** The server in use, or null while there is no usable config. */
  private serverUrl(): string | null {
    try {
      const url = this.deps.transport()?.getConfig()?.serverUrl;
      return typeof url === 'string' && url.length > 0 ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * The parked idents the server should leave out of its answer: airports in
   * `skipAirports`, and fixes, VORs and NDBs together in `skipWaypoints`, which
   * is where the server lists all three. Without this a stateless server that
   * sorts them first hands back the same full page for ever and whatever is
   * behind them is never reached. Sorted, so a list cut at the limit is the
   * same list every time. A point is named by its ident alone, which is all
   * the parameter carries.
   */
  private skipList(param: 'A' | 'W'): string[] {
    const idents = new Set<string>();
    for (const [key, item] of this.parked) {
      if (this.parkedLocally.has(key)) continue;
      if ((item.kind === 'A') === (param === 'A')) idents.add(item.ident);
    }
    const parked = [...idents].sort();
    if (parked.length <= DEMAND_SKIP_MAX) {
      this.skipTruncated[param] = false;
      return parked;
    }
    if (!this.skipTruncated[param]) {
      this.skipTruncated[param] = true;
      this.log(
        'warn',
        `navdata: ${parked.length} ${param === 'A' ? 'airports' : 'fixes and navaids'} are set aside; ` +
          `the server is told about the first ${DEMAND_SKIP_MAX}`,
      );
    }
    return parked.slice(0, DEMAND_SKIP_MAX);
  }

  /** Adds what is new and returns how many that was. */
  private enqueue(items: readonly DemandItem[]): number {
    this.noticeContext();
    const store = this.deps.store();
    let added = 0;
    let overflow = 0;
    for (const item of items) {
      const key = itemKey(item);
      if (this.queued.has(key) || this.parked.has(key) || this.unansweredThisCycle.has(key)) continue;
      if (this.inFlight !== null && itemKey(this.inFlight) === key) continue;
      if (store !== null && this.held(store, item)) continue;
      if (this.sizeOf(laneOf(item)) >= DEMAND_QUEUE_HIGH_WATER) {
        // Not lost: the server names it again on a later poll.
        overflow++;
        continue;
      }
      this.queueOf(laneOf(item)).push(item);
      this.queued.add(key);
      added++;
    }
    if (overflow > 0) {
      this.log('debug', `navdata: the demand queue is full; ${overflow} item(s) wait for a later poll`);
    }
    return added;
  }

  /**
   * Whether the store already answers for this item: an airport fetched in
   * detail, a fix whose airways are fetched, or either known to be missing from
   * this install in the current epoch. Absences are wiped when an epoch is
   * minted, so any row at all is a current one.
   *
   * A fix asked for without a region is answered by any fix of that ident;
   * one asked for in a region only by a fix in that region, so a fix learned
   * without a region never stands in for a region-qualified one.
   */
  private held(store: NavdataStore, item: DemandItem): boolean {
    try {
      if (item.kind === 'A') {
        if (store.row('nav_airport', { ident: item.ident })?.detail_state === 'detail') return true;
        return store.row('nav_absent', { kind: 'A', ident: item.ident, region: '' }) !== null;
      }
      if (item.kind !== 'W') {
        // A VOR or NDB is answered by its detail or its absence, in the region
        // asked for, or in any region when none was given.
        const navaids = store.navaids(item.kind, item.ident, item.region);
        if (navaids.some((row) => row.detail_state === 'detail' || row.detail_state === 'absent')) return true;
        return store.row('nav_absent', { kind: item.kind, ident: item.ident, region: item.region ?? '' }) !== null;
      }
      const fixes = store.waypoints(item.ident, item.region);
      if (fixes.some((row) => row.routes_state === 'fetched' || row.routes_state === 'absent')) return true;
      return store.row('nav_absent', { kind: 'W', ident: item.ident, region: item.region ?? '' }) !== null;
    } catch {
      // A lookup that fails costs a fetch, not the queue.
      return false;
    }
  }

  // ── fetching ────────────────────────────────────────────────────────────────

  private next(): DemandItem | null {
    return this.airports[0] ?? this.fixes[0] ?? this.navaids[0] ?? null;
  }

  /**
   * The first item, in lane order, whose definition this session has. An item
   * whose kind cannot be fetched on this session is passed over, not taken: it
   * stays queued and counts against its lane, but nothing behind it waits on it.
   */
  private takeRunnable(definitions: SessionDefinitions): { item: DemandItem; definition: FacilityDefinition } | null {
    for (const queue of [this.airports, this.fixes, this.navaids]) {
      const index = queue.findIndex((candidate) => definitionOf(definitions, candidate.kind) !== null);
      if (index === -1) continue;
      const [item] = queue.splice(index, 1);
      this.queued.delete(itemKey(item));
      return { item, definition: definitionOf(definitions, item.kind) as FacilityDefinition };
    }
    return null;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (!this.shuttingDown && this.next() !== null) {
        this.noticeContext();
        const session = this.deps.session();
        const store = this.deps.store();
        if (session === null || store === null) break;
        const definitions = await this.definitionsFor(session);
        if (this.shuttingDown) break;
        // The prepare took a while; the connection or the store may have moved.
        // Looked at again after a turn, so this can never become a tight loop.
        if (this.deps.session() !== session || this.deps.store() !== store) {
          await yieldTurn();
          continue;
        }
        // Nothing whose definition is missing is fetched on this session, and
        // nothing else waits for it.
        const runnable = this.takeRunnable(definitions);
        if (runnable === null) break;
        const { item, definition } = runnable;
        if (this.held(store, item)) {
          this.deps.onChange();
          continue;
        }

        this.inFlight = item;
        this.deps.onChange();
        let outcome: Settled = { status: 'thrown', reason: 'unknown', collisions: 0 };
        try {
          if (item.kind === 'A') {
            const result = await this.fetchDetail(session, store, definition, item.ident, { log: this.log });
            outcome = { status: result.status, reason: result.reason, collisions: result.collisions };
          } else if (item.kind === 'W') {
            const result = await this.fetchFix(session, store, definition, item.ident, item.region, { log: this.log });
            outcome = { status: result.status, reason: result.reason, collisions: 0 };
          } else {
            const result = await this.fetchNavaid(session, store, definition, item.kind, item.ident, item.region, {
              log: this.log,
              waypointDefinition: definitions.fix,
            });
            outcome = { status: result.status, reason: result.reason, collisions: 0 };
          }
        } catch (err) {
          outcome = { status: 'thrown', reason: describe(err), collisions: 0 };
        }
        this.inFlight = null;
        if (this.shuttingDown) break;
        this.settle(item, outcome, session);
        this.deps.onChange();
        await yieldTurn();
      }
    } catch (err) {
      this.log('warn', `navdata: the demand queue stopped (${describe(err)})`);
    } finally {
      this.pumping = false;
    }
    if (this.next() === null && this.moreWaiting && this.running && !this.shuttingDown) {
      // The truncated list was waiting on this queue; it may say more now.
      this.moreWaiting = false;
      this.schedule(0, true);
    }
  }

  private settle(item: DemandItem, outcome: Settled, session: FacilitySession): void {
    const key = itemKey(item);
    switch (outcome.status) {
      case 'detail':
        // An airport's detail, or a navaid's. A navaid's detail is its answer
        // with or without a station position: a VOR's may only arrive later,
        // from a list.
        this.faults.delete(key);
        if (outcome.collisions > 0) {
          this.collisions += outcome.collisions;
          this.collidedAirports.add(item.ident);
        }
        return;
      case 'fetched':
      case 'absent':
        // Recorded in the store; the sync carries it back and the server
        // stops asking.
        this.faults.delete(key);
        return;
      case 'aborted':
        if (!isOpen(session)) {
          // The link went away. Nothing is known about the item, so it goes
          // back where it was and the attempt is not held against it.
          this.requeue(item, true);
          return;
        }
        // The link is still up, so the abort was ours: a decoder that threw, or
        // a buffer that could not be cleared. It goes round again until the
        // limit, which is what stops a deterministic fault spinning for ever.
        this.fault(item, 'aborted with the link still up', true);
        return;
      case 'disabled':
        this.requeue(item, true);
        return;
      case 'thrown':
        this.fault(item, `the fetch threw (${outcome.reason ?? 'unknown'})`, false);
        return;
      case 'ambiguous':
        // Deterministic: the same ident without a region matches the same set
        // of candidates every time, and their positions are already stored. No
        // region is guessed, so there is nothing a second attempt could add.
        this.faults.delete(key);
        this.park(item, `because ${outcome.reason ?? 'it matched more than one fix'}`);
        return;
      case 'mismatched':
        // Deterministic too — the same question gets the same other station —
        // but parked here only, and not named to the server: see parkedLocally.
        this.faults.delete(key);
        this.park(item, `because ${outcome.reason ?? 'another station answered'}`, true);
        return;
      default:
        // undecodable or failed: nothing was stored as an answer to the
        // request. The server names it again on its next poll if it still
        // wants it, and the count stops that becoming a loop.
        this.fault(item, outcome.reason ?? outcome.status, false);
    }
  }

  /**
   * Parking lasts for one connection and one store. A new session — a
   * reconnect, a replaced connection — or a different store forgives every
   * count and gives each parked item one fresh chance: what failed three
   * times on one link can be transient, and a deterministic fault is parked
   * again within three attempts on the next. A moment with no session at all
   * (a bulk pass, a disconnect) is not a new one.
   */
  private noticeContext(): void {
    const session = this.deps.session();
    const store = this.deps.store();
    const newSession = session !== null && session !== this.faultSession;
    const newStore = store !== null && store !== this.faultStore;
    if (!newSession && !newStore) return;
    if (session !== null) this.faultSession = session;
    if (store !== null) this.faultStore = store;
    if (this.parked.size > 0) {
      this.log('info', `navdata: giving ${this.parked.size} parked item(s) a fresh chance on this connection`);
    }
    this.parked.clear();
    this.parkedLocally.clear();
    this.faults.clear();
  }

  /** Counts an attempt that failed in this build's own code; parks at the limit. */
  private fault(item: DemandItem, reason: string, requeue: boolean): void {
    const key = itemKey(item);
    // Held back from re-reads of this cycle. An abort on a live link is still
    // retried at once below: the queue itself puts it back, and parking is
    // what stops a deterministic one.
    if (!requeue) this.unansweredThisCycle.add(key);
    const count = (this.faults.get(key) ?? 0) + 1;
    if (count >= DEMAND_FAULT_PARK_AFTER) {
      this.faults.delete(key);
      this.park(item, `after ${count} attempts that failed in this client (last: ${reason})`);
      return;
    }
    this.faults.set(key, count);
    if (requeue) this.requeue(item, false);
  }

  private park(item: DemandItem, why: string, locally = false): void {
    this.parked.set(itemKey(item), item);
    if (locally) this.parkedLocally.add(itemKey(item));
    this.log('warn', `navdata: ${itemLabel(item)} is set aside ${why}; it is not fetched again on this connection`);
  }

  private requeue(item: DemandItem, front: boolean): void {
    const key = itemKey(item);
    if (this.queued.has(key) || this.parked.has(key)) return;
    const queue = this.queueOf(laneOf(item));
    if (front) queue.unshift(item);
    else queue.push(item);
    this.queued.add(key);
  }

  /**
   * Both definitions for this session. Definitions are per connection, so a
   * new session prepares its own, in one pass; the promise is kept so every
   * fetch on one session shares it. A fix definition the simulator changed in
   * any way is not used, since its records are read by position.
   */
  private definitionsFor(session: FacilitySession): Promise<SessionDefinitions> {
    if (this.definitions === null || this.definitions.session !== session) {
      const ready = session.prepare([airportDetailSpec(), fixRoutesSpec(), vorDetailSpec(), ndbDetailSpec()]).then(
        (definitions): SessionDefinitions => {
          const airport = definitions.find((d) => d.name === AIRPORT_DETAIL_DEFINITION) ?? null;
          let fix = definitions.find((d) => d.name === FIX_ROUTES_DEFINITION) ?? null;
          let vor = definitions.find((d) => d.name === VOR_DEFINITION) ?? null;
          let ndb = definitions.find((d) => d.name === NDB_DEFINITION) ?? null;
          if (vor !== null && !navaidDefinitionUsable(vor, 'V')) {
            this.log('warn', 'navdata: the simulator changed the VOR definition; VORs are not fetched on this connection');
            vor = null;
          }
          if (ndb !== null && !navaidDefinitionUsable(ndb, 'N')) {
            this.log('warn', 'navdata: the simulator changed the NDB definition; NDBs are not fetched on this connection');
            ndb = null;
          }
          if (fix !== null && !fixDefinitionUsable(fix)) {
            this.log('warn', 'navdata: the simulator changed the fix definition; fixes are not fetched on this connection');
            fix = null;
          }
          return { airport, fix, vor, ndb };
        },
        (err: unknown): SessionDefinitions => {
          this.log('warn', `navdata: the facility definitions could not be prepared (${describe(err)})`);
          return { airport: null, fix: null, vor: null, ndb: null };
        },
      );
      this.definitions = { session, ready };
    }
    return this.definitions.ready;
  }
}

function definitionOf(definitions: SessionDefinitions, kind: DemandItem['kind']): FacilityDefinition | null {
  switch (kind) {
    case 'A':
      return definitions.airport;
    case 'W':
      return definitions.fix;
    case 'V':
      return definitions.vor;
    default:
      return definitions.ndb;
  }
}

/** What one fetch came to, whichever kind it was. */
interface Settled {
  readonly status: AirportDetailResult['status'] | FixRoutesResult['status'] | NavaidResult['status'] | 'thrown';
  readonly reason: string | null;
  readonly collisions: number;
}

function isOpen(session: FacilitySession): boolean {
  try {
    return session.isOpen();
  } catch {
    return false;
  }
}

/** A turn of the event loop between items, so frames are not held up. */
function yieldTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve).unref?.();
  });
}

/** One line, no stack, and a code in place of a message when there is one. */
function describe(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0].slice(0, 200);
}
