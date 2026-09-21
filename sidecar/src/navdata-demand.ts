// ── Navdata demand: the airports the server wants in detail ──────────────────
//
// The server lists what it would draw and does not yet hold — airports named by
// a filed plan, and the one a user asked for with "Fetch detail" — and this
// module collects that list, fetches each airport in turn and lets the
// incremental sync carry the result back. Nothing here talks to the server
// about what it did: rows go back as rows, and an airport the simulator does
// not have goes back as a `nav_absent` row in the same stream.
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
// ONE AIRPORT AT A TIME. A large airport's whole procedure tree is written in
// one transaction on the thread that also runs the 1 Hz frame loop, so the queue
// never has more than one fetch out and yields a turn between airports.
//
// A FETCH THAT KEEPS FAILING IN OUR OWN CODE IS SET ASIDE. A decoder that throws
// settles the request as aborted, and an aborted request goes back on the queue
// — which on its own would fetch, throw and re-queue for ever at full speed. So
// consecutive attempts that end without detail or absence, and not because the
// link went away, are counted per airport, and one that reaches the limit is
// parked with a single log line until the next connection or store, which gives
// it one fresh chance. An abort caused by a disconnect says nothing about the
// airport and is not counted. Every poll names the parked airports to the server
// so it can leave them out before it applies its cap; otherwise a server that
// sorts them first would fill every page with them.
//
// FIXES ARE LISTED, NOT FETCHED. The response names waypoints too; they are
// validated and their number is logged when it changes, and nothing else is
// done with them yet.
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
import type { NavdataStore } from './navdata-store';
import {
  busyWaitMs,
  NavdataSyncClient,
  type NavdataDemandRequester,
  type NavdataOutcome,
  type NavdataTransport,
} from './navdata-sync';
import type { LogSink } from './uplink';

/** How often the list is read while it has nothing new in it. */
export const NAVDATA_DEMAND_POLL_MS = 60_000;
export const NAVDATA_DEMAND_BACKOFF_MAX_MS = 600_000;
/** A truncated list is read again at once only while the queue is under this. */
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
}

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
  const { ident, region } = entry as { ident?: unknown; region?: unknown };
  if (typeof ident !== 'string' || !IDENT.test(ident)) return null;
  if (region === undefined) return { ident };
  if (region === null) return { ident, region: null };
  if (typeof region !== 'string' || !IDENT.test(region)) return null;
  return { ident, region };
}

// ── The queue ─────────────────────────────────────────────────────────────────

export type FetchDetail = (
  session: FacilitySession,
  store: NavdataStore | null,
  definition: FacilityDefinition,
  ident: string,
  options?: AirportDetailOptions,
) => Promise<AirportDetailResult>;

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
}

/** What the service needs from the queue, so a test can stand in for it. */
export interface NavdataDemandLike {
  start(): void;
  stop(): void;
  shutdown(): void;
  onConfigApplied(): void;
  /** A session may have become usable: fetch whatever is queued. */
  wake(): void;
  /** Airports queued or being fetched. */
  pending(): number;
  /** One line worth showing while nothing is wrong, or null. */
  note(): string | null;
}

export class NavdataDemand implements NavdataDemandLike {
  private readonly deps: NavdataDemandDeps;
  private readonly log: LogSink;
  private readonly client: NavdataDemandRequester;
  private readonly fetchDetail: FetchDetail;

  private running = false;
  private shuttingDown = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  /** The last poll failure logged, so a failing server is not one line per try. */
  private loggedError: string | null = null;
  /** A truncated list is waiting on the queue to drain before it is read again. */
  private moreWaiting = false;

  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private inFlight: string | null = null;
  private pumping = false;

  /** Consecutive attempts per airport that failed in this build's own code. */
  private readonly faults = new Map<string, number>();
  private readonly parked = new Set<string>();
  /** The session and store the counts above were earned on. */
  private faultSession: FacilitySession | null = null;
  private faultStore: NavdataStore | null = null;

  /** The detail definition, prepared once per session. */
  private definition: { session: FacilitySession; ready: Promise<FacilityDefinition | null> } | null = null;

  private collisions = 0;
  private readonly collidedAirports = new Set<string>();
  private waypointsLogged = 0;
  /** Whether the last poll had to cut its skip list short, so that is said once. */
  private skipTruncated = false;

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
  }

  pending(): number {
    return this.queue.length + (this.inFlight === null ? 0 : 1);
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

  private schedule(delayMs: number): void {
    this.cancelTimer();
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
    let delay = NAVDATA_DEMAND_POLL_MS;
    try {
      delay = await this.poll();
    } catch (err) {
      delay = this.fail(`the demand poll failed (${describe(err)})`);
    } finally {
      this.polling = false;
    }
    this.schedule(delay);
  }

  private async poll(): Promise<number> {
    // Only while there is a server to ask and a store to hold the answer.
    if (this.serverUrl() === null || this.deps.store() === null) return NAVDATA_DEMAND_POLL_MS;

    // A new connection forgives what was parked on the last one, and that has
    // to happen before the skip list is built, not after the answer arrives.
    this.noticeContext();
    const skipAirports = this.skipList();

    let outcome: NavdataOutcome;
    try {
      outcome = await this.client.getDemand(skipAirports.length > 0 ? { airports: skipAirports } : undefined);
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
          'the server named with an ident this client does not accept',
      );
    }
    let airports = demand.airports;
    if (airports.length > demand.cap) {
      this.log('debug', `navdata: the server named ${airports.length} airports under a cap of ${demand.cap}`);
      airports = airports.slice(0, demand.cap);
    }
    this.noteWaypoints(demand.waypoints.length);

    const added = this.enqueue(airports);
    if (added > 0) {
      this.log(
        'info',
        `navdata: the server wants ${added} more airport(s) in detail (${this.pending()} pending, cap ${demand.cap})`,
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
    if (added > 0 && this.pending() < DEMAND_QUEUE_HIGH_WATER) return 0;
    this.moreWaiting = true;
    if (this.pending() === 0) {
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

  private noteWaypoints(count: number): void {
    if (count === this.waypointsLogged) return;
    this.waypointsLogged = count;
    this.log('info', `navdata: the server wants ${count} fix(es) in detail; this build fetches airports only`);
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
   * The parked airports, for the server to leave out of its answer. Without
   * this a stateless server that sorts them first hands back the same full
   * page for ever and the airports behind them are never reached. Sorted, so
   * a list cut at the limit is the same list every time.
   */
  private skipList(): string[] {
    const parked = [...this.parked].sort();
    if (parked.length <= DEMAND_SKIP_MAX) {
      this.skipTruncated = false;
      return parked;
    }
    if (!this.skipTruncated) {
      this.skipTruncated = true;
      this.log(
        'warn',
        `navdata: ${parked.length} airports are set aside; the server is told about the first ${DEMAND_SKIP_MAX}`,
      );
    }
    return parked.slice(0, DEMAND_SKIP_MAX);
  }

  /** Adds what is new and returns how many that was. */
  private enqueue(idents: readonly string[]): number {
    this.noticeContext();
    const store = this.deps.store();
    let added = 0;
    let overflow = 0;
    for (const ident of idents) {
      if (this.queued.has(ident) || this.inFlight === ident || this.parked.has(ident)) continue;
      if (store !== null && this.held(store, ident)) continue;
      if (this.pending() >= DEMAND_QUEUE_HIGH_WATER) {
        // Not lost: the server names it again on a later poll.
        overflow++;
        continue;
      }
      this.queue.push(ident);
      this.queued.add(ident);
      added++;
    }
    if (overflow > 0) {
      this.log('debug', `navdata: the demand queue is full; ${overflow} airport(s) wait for a later poll`);
    }
    return added;
  }

  /**
   * Whether the store already answers for this airport: fetched in detail, or
   * known to be missing from this install in the current epoch. Absences are
   * wiped when an epoch is minted, so any row at all is a current one.
   */
  private held(store: NavdataStore, ident: string): boolean {
    try {
      if (store.row('nav_airport', { ident })?.detail_state === 'detail') return true;
      return store.row('nav_absent', { kind: 'A', ident, region: '' }) !== null;
    } catch {
      // A lookup that fails costs a fetch, not the queue.
      return false;
    }
  }

  // ── fetching ────────────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (!this.shuttingDown && this.queue.length > 0) {
        this.noticeContext();
        const session = this.deps.session();
        const store = this.deps.store();
        if (session === null || store === null) break;
        const definition = await this.definitionFor(session);
        if (definition === null || this.shuttingDown) break;
        // The prepare took a while; the connection or the store may have moved.
        // Looked at again after a turn, so this can never become a tight loop.
        if (this.deps.session() !== session || this.deps.store() !== store) {
          await yieldTurn();
          continue;
        }

        const ident = this.queue.shift() as string;
        this.queued.delete(ident);
        if (this.held(store, ident)) {
          this.deps.onChange();
          continue;
        }

        this.inFlight = ident;
        this.deps.onChange();
        let result: AirportDetailResult | null = null;
        let thrown: string | null = null;
        try {
          result = await this.fetchDetail(session, store, definition, ident, { log: this.log });
        } catch (err) {
          thrown = describe(err);
        }
        this.inFlight = null;
        if (this.shuttingDown) break;
        this.settle(ident, result, thrown, session);
        this.deps.onChange();
        await yieldTurn();
      }
    } catch (err) {
      this.log('warn', `navdata: the demand queue stopped (${describe(err)})`);
    } finally {
      this.pumping = false;
    }
    if (this.queue.length === 0 && this.moreWaiting && this.running && !this.shuttingDown) {
      // The truncated list was waiting on this queue; it may say more now.
      this.moreWaiting = false;
      this.schedule(0);
    }
  }

  private settle(
    ident: string,
    result: AirportDetailResult | null,
    thrown: string | null,
    session: FacilitySession,
  ): void {
    if (result === null) {
      this.fault(ident, `the fetch threw (${thrown ?? 'unknown'})`, false);
      return;
    }
    switch (result.status) {
      case 'detail':
        this.faults.delete(ident);
        if (result.collisions > 0) {
          this.collisions += result.collisions;
          this.collidedAirports.add(ident);
        }
        return;
      case 'absent':
        // Recorded in the store; the sync carries it back and the server
        // stops asking.
        this.faults.delete(ident);
        return;
      case 'aborted':
        if (!isOpen(session)) {
          // The link went away. Nothing is known about the airport, so it goes
          // back where it was and the attempt is not held against it.
          this.requeue(ident, true);
          return;
        }
        // The link is still up, so the abort was ours: a decoder that threw, or
        // a buffer that could not be cleared. It goes round again until the
        // limit, which is what stops a deterministic fault spinning for ever.
        this.fault(ident, 'aborted with the link still up', true);
        return;
      case 'disabled':
        this.requeue(ident, true);
        return;
      default:
        // undecodable, failed or ambiguous: nothing was stored and nothing is
        // claimed. The server names it again on its next poll if it still
        // wants it, and the count stops that becoming a loop.
        this.fault(ident, result.reason ?? result.status, false);
    }
  }

  /**
   * Parking lasts for one connection and one store. A new session — a
   * reconnect, a replaced connection — or a different store forgives every
   * count and gives each parked airport one fresh chance: what failed three
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
      this.log('info', `navdata: giving ${this.parked.size} parked airport(s) a fresh chance on this connection`);
    }
    this.parked.clear();
    this.faults.clear();
  }

  /** Counts an attempt that failed in this build's own code; parks at the limit. */
  private fault(ident: string, reason: string, requeue: boolean): void {
    const count = (this.faults.get(ident) ?? 0) + 1;
    if (count >= DEMAND_FAULT_PARK_AFTER) {
      this.faults.delete(ident);
      this.parked.add(ident);
      this.log(
        'warn',
        `navdata: ${ident} is set aside after ${count} attempts that failed in this client ` +
          `(last: ${reason}); it is not fetched again on this connection`,
      );
      return;
    }
    this.faults.set(ident, count);
    if (requeue) this.requeue(ident, false);
  }

  private requeue(ident: string, front: boolean): void {
    if (this.queued.has(ident) || this.parked.has(ident)) return;
    if (front) this.queue.unshift(ident);
    else this.queue.push(ident);
    this.queued.add(ident);
  }

  /**
   * The detail definition for this session. Definitions are per connection, so
   * a new session prepares its own; the promise is kept so every fetch on one
   * session shares the one prepare.
   */
  private definitionFor(session: FacilitySession): Promise<FacilityDefinition | null> {
    if (this.definition === null || this.definition.session !== session) {
      const ready = session.prepare([airportDetailSpec()]).then(
        (definitions) => definitions.find((d) => d.name === AIRPORT_DETAIL_DEFINITION) ?? null,
        (err: unknown) => {
          this.log('warn', `navdata: the airport detail definition could not be prepared (${describe(err)})`);
          return null;
        },
      );
      this.definition = { session, ready };
    }
    return this.definition.ready;
  }
}

function isOpen(session: FacilitySession): boolean {
  try {
    return session.isOpen();
  } catch {
    return false;
  }
}

/** A turn of the event loop between airports, so frames are not held up. */
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
