// ── Navdata service ───────────────────────────────────────────────────────────
//
// Owns the navdata store's lifetime and the facility session that rides one
// SimConnect connection, and reports both on the status axis. Today it runs one
// thing — the bulk airport index, once per connection episode — and everything
// else the store is built for hangs off the same lifecycle later.
//
// The rules that shape it:
//
// - Navdata fails alone. Every entry point is wrapped, because an exception
//   escaping into the frame path or the connect callback reaches the
//   supervisor, and the supervisor answers a dying sidecar with five restarts
//   in a rolling minute and then a latched crash — taking flight logging down
//   over a cache that rebuilds itself in under a second. A store that will not
//   open, a driver that will not load and a write that throws are all reported
//   on the axis and nowhere else.
// - The store belongs to the process, the session to the connection. Definition
//   and request ids do not survive a reconnect, so the session is built on
//   connect and closed on disconnect, while the store stays open across both.
// - The configured simulator is passed at every open rather than left to a
//   default, and the store is let go of when that simulator changes: 2020 and
//   2024 ship different navdata, and the cache is rebuilt rather than
//   relabelled.
// - The store has no logger of its own: writing to stdout would corrupt the
//   framed protocol. Its one log sink and its unavailability callback are wired
//   here, or a store that quietly rebuilt itself would do so in silence.
// - Navdata never claims the backend status axis, never starts or stops the
//   uplink and never touches the reachability probe. It reports on its own axis
//   and on nothing else.

import type { SimConnectConnection } from 'node-simconnect';

import type { SimId } from './config';
import { BulkAirportIndex, type BulkResult } from './navdata-bulk';
import { asFacilityConnection, FacilitySession } from './navdata-facilities';
import {
  NavdataSync,
  type NavdataSyncStatus,
  type NavdataTransport,
} from './navdata-sync';
import {
  navdataDatabasePath,
  openNavdataStore,
  type NavdataOpenOptions,
  type NavdataStore,
  type NavdataUnavailable,
} from './navdata-store';
import type { NavdataStatusAxis } from './protocol';
import type { LogSink } from './uplink';

export interface NavdataServiceDeps {
  /** The config file in use; the store lives in a sibling directory. */
  configPath(): string;
  /** The configured simulator, or null while there is no valid config. */
  simId(): SimId | null;
  /**
   * The protocol this client opened the connection with, and the one the
   * simulator answered as — `null` until a connection has been made. A facility
   * list is only safe to ask for when the two agree; see `listParseIsSafe`.
   */
  protocols(): { ours: string; sim: string | null };
  /** The sidecar's log path. Nothing under navdata may write to stdout itself. */
  log: LogSink;
  /** Something the axis shows has changed and a status line is due. */
  onChange(): void;
  /**
   * The uplink, for the sync client, or null while there is no valid config.
   * Navdata borrows its config and its CA trust and nothing else: it never
   * starts or stops it and never touches the reachability probe.
   */
  transport?: () => NavdataTransport | null;
  /** This build's version, for the snapshot header. */
  sidecarVersion?: () => string;
  /** Test seams: a store and a session that never touch a simulator. */
  openStore?: (path: string, options: NavdataOpenOptions) => NavdataStore | null;
  createSession?: (handle: SimConnectConnection) => FacilitySession;
  bulk?: BulkAirportIndex;
  sync?: NavdataSyncLike;
}

/** What the service needs from the sync client, so a test can stand in for it. */
export interface NavdataSyncLike {
  start(): void;
  stop(): void;
  shutdown(): void;
  onConfigApplied(): void;
  reportState(axis: Pick<NavdataStatusAxis, 'state' | 'reason' | 'snapshotId' | 'rev'>): void;
  status(): NavdataSyncStatus;
}

export class NavdataService {
  private readonly deps: NavdataServiceDeps;
  /** The caller's sink, wrapped so a sink that throws cannot reach a caller. */
  private readonly log: LogSink;
  private readonly openStore: (path: string, options: NavdataOpenOptions) => NavdataStore | null;
  private readonly createSession: (handle: SimConnectConnection) => FacilitySession;
  private readonly bulk: BulkAirportIndex;
  private readonly sync: NavdataSyncLike;

  private store: NavdataStore | null = null;
  private storePath: string | null = null;
  /** The simulator the open store holds data for, as the store itself records it. */
  private storeSimId: SimId | null = null;
  /** Set once, when an open failed; the reason the axis shows for the rest of the process. */
  private unavailable: NavdataUnavailable | null = null;
  private session: FacilitySession | null = null;
  /** The live handle, so work can be restarted without waiting for a reconnect. */
  private handle: SimConnectConnection | null = null;

  private running = false;
  private passing = false;
  /** A failure worth showing until the next pass succeeds. */
  private latched: string | null = null;
  private axis: NavdataStatusAxis | null = null;

  constructor(deps: NavdataServiceDeps) {
    this.deps = deps;
    this.log = (level, message) => {
      try {
        deps.log(level, message);
      } catch {
        // Reporting is not worth failing over: navdata says what it did or it
        // says nothing, and either way it carries on.
      }
    };
    this.openStore = deps.openStore ?? openNavdataStore;
    this.createSession =
      deps.createSession ?? ((handle) => new FacilitySession(asFacilityConnection(handle), { log: this.log }));
    this.bulk = deps.bulk ?? new BulkAirportIndex({ log: this.log });
    this.sync =
      deps.sync ??
      new NavdataSync({
        transport: () => deps.transport?.() ?? null,
        store: () => this.store,
        sidecarVersion: () => deps.sidecarVersion?.() ?? 'unknown',
        log: this.log,
        onChange: () => this.publish(),
      });
  }

  // ── what the shell sees ─────────────────────────────────────────────────────

  /**
   * The axis for the next status line, or null while this sidecar has no
   * navdata to report — which is exactly what an older sidecar, one that never
   * writes the key, says by omitting it.
   */
  snapshot(): NavdataStatusAxis | null {
    return this.axis === null ? null : { ...this.axis };
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /** START: the store opens here, so it exists before a simulator ever appears. */
  start(): void {
    this.running = true;
    this.guard('starting navdata', () => {
      this.ensureStore();
    });
    // Before the publish, so the first state report carries the state the
    // store's open just settled rather than the one before it.
    this.guard('starting the navdata sync', () => this.sync.start());
    this.publish();
  }

  /** STOP: the connection's work ends, the store stays open. */
  stop(): void {
    this.running = false;
    this.handle = null;
    this.closeSession('the uplink stopped');
    // Rows stop; the state report does not. A stopped uplink is exactly the
    // thing the server has no other way of hearing about.
    this.guard('stopping the navdata sync', () => this.sync.stop());
    this.publish();
  }

  /**
   * A config was accepted. Two things about it can change which store is the
   * right one: where the config lives, since the store sits beside it, and
   * which simulator it names, since the store holds that simulator's data.
   */
  onConfigApplied(): void {
    this.guard('applying a config to navdata', () => {
      const wanted = navdataDatabasePath(this.deps.configPath());
      const simId = this.deps.simId();
      const moved = this.storePath !== null && this.storePath !== wanted;
      // A different simulator is a different database. The store decides what
      // happens to the old file; letting go of it here is what gets it asked.
      const switched = this.store !== null && simId !== null && simId !== this.storeSimId;
      if (moved || switched) {
        this.closeStore();
        // A different file is a different question: whatever made the old one
        // unopenable says nothing about this one.
        this.unavailable = null;
      }
      if (this.running) {
        const store = this.ensureStore();
        // A store that was just replaced is empty, and a connection that is
        // already up will not announce itself again. Without restarting the
        // work here the axis would sit at ready over nothing until the next
        // reconnect, which may never come.
        if ((moved || switched) && store !== null && this.handle !== null) {
          this.startPass(this.handle, store);
        }
      }
      // The sync cursor is keyed by server URL, so a config naming a different
      // server resumes against whatever that one last acknowledged.
      this.sync.onConfigApplied();
    });
    this.publish();
  }

  /**
   * A live handle. The session is built here and the bulk pass starts on it:
   * the simulator's airport list is the index everything else is written
   * against, and one pass an hour is all the world can change in.
   */
  onSimConnected(handle: SimConnectConnection): void {
    this.handle = handle;
    this.guard('starting navdata on this connection', () => {
      const store = this.ensureStore();
      if (store === null) return;
      this.startPass(handle, store);
    });
    this.publish();
  }

  /**
   * Builds the session for a connection and starts the bulk pass on it, unless
   * this client and the simulator disagree about which simulator this is — in
   * which case asking for a list would take the connection down with it, frames
   * and all, so navdata says why and does nothing.
   */
  private startPass(handle: SimConnectConnection, store: NavdataStore): void {
    const { ours, sim } = this.deps.protocols();
    if (!listParseIsSafe(ours, sim)) {
      this.closeSession('the simulator is not the one this client is configured for');
      const reason =
        `navdata is off: this client is set up for ${ours} and ` +
        `${sim ?? 'the simulator'} answered — correct the simulator in the settings`;
      if (this.latched !== reason) this.log('warn', `navdata: ${reason}`);
      this.latched = reason;
      return;
    }
    this.latched = null;
    this.closeSession('a new connection replaced it');
    const session = this.createSession(handle);
    this.session = session;
    void this.runBulk(session, store);
  }

  /**
   * The handle is gone. Everything in flight settles as aborted, which records
   * nothing about the simulator's data: a disconnect is evidence about the link
   * and about nothing else.
   */
  onSimDisconnected(): void {
    this.handle = null;
    this.closeSession('SimConnect disconnected');
    this.publish();
  }

  /** Folds the write-ahead log back in and lets go of the file. */
  shutdown(): void {
    this.running = false;
    this.handle = null;
    this.closeSession('the sidecar is shutting down');
    this.guard('stopping the navdata sync', () => this.sync.shutdown());
    // The axis is computed while the store can still answer, so the last status
    // line the process writes carries counts rather than zeros.
    this.publish();
    this.guard('closing the navdata store', () => {
      this.store?.checkpoint();
    });
    this.closeStore();
  }

  // ── the store ───────────────────────────────────────────────────────────────

  private ensureStore(): NavdataStore | null {
    const wanted = navdataDatabasePath(this.deps.configPath());
    if (this.store !== null && this.storePath === wanted) return this.store;
    if (this.store !== null) this.closeStore();
    // An open that failed is not retried: a native addon that would not load is
    // not going to load later in the same process, and a retry would only
    // repeat the same line on every connection.
    if (this.unavailable !== null) return null;

    const simId = this.deps.simId();
    // Without a valid config there is no configured simulator, and a store
    // created now would record a guess about which simulator it came from.
    if (simId === null) return null;

    this.storePath = wanted;
    this.store = this.openStore(wanted, {
      simId,
      log: (level, message) => this.log(level, message),
      onUnavailable: (failure) => {
        this.unavailable = failure;
        this.log('warn', failure.reason);
      },
    });
    if (this.store !== null) {
      this.storeSimId = this.storedSimId(this.store) ?? simId;
      this.log('info', `navdata: the store is open (${this.count('nav_airport')} airports)`);
      this.resetPendingDetail(this.store);
    }
    return this.store;
  }

  /**
   * A detail fetch cannot still be in flight in a store that has only just been
   * opened, so anything the last process left marked that way is cleared here.
   * Nothing else looks for those rows, and one left behind is never re-fetched.
   */
  private resetPendingDetail(store: NavdataStore): void {
    try {
      const cleared = store.resetPendingDetail();
      if (cleared > 0) {
        this.log('info', `navdata: reset ${cleared} detail fetch(es) left behind by an earlier run`);
      }
    } catch (err) {
      // Worth saying, not worth disabling navdata over: the index still works.
      this.log(
        'warn',
        `navdata: the interrupted detail fetches could not be reset (${describe(err)})`,
      );
    }
  }

  private closeStore(): void {
    const store = this.store;
    this.store = null;
    this.storePath = null;
    this.storeSimId = null;
    if (store === null) return;
    try {
      store.close();
    } catch (err) {
      this.log('debug', `navdata: the store did not close cleanly (${describe(err)})`);
    }
  }

  private closeSession(reason: string): void {
    const session = this.session;
    this.session = null;
    if (session === null) return;
    try {
      session.close(reason);
    } catch (err) {
      this.log('debug', `navdata: a facility session did not close cleanly (${describe(err)})`);
    }
  }

  // ── the bulk pass ───────────────────────────────────────────────────────────

  private async runBulk(session: FacilitySession, store: NavdataStore): Promise<void> {
    this.passing = true;
    this.publish();
    let result: BulkResult;
    try {
      result = await this.bulk.run(session, store);
    } catch (err) {
      // The pass is built never to throw. If it ever does, navdata still fails
      // alone: the reason lands on the axis and the process carries on.
      result = {
        status: 'failed',
        rows: 0,
        written: 0,
        inserted: 0,
        epochMinted: null,
        reason: describe(err),
      };
    } finally {
      this.passing = false;
    }

    switch (result.status) {
      case 'completed':
        this.latched = null;
        this.log(
          'info',
          `navdata: the airport index has ${result.rows} airports (${result.written} written` +
            `${result.epochMinted === null ? '' : ', a new snapshot'})`,
        );
        break;
      case 'failed':
        // A failure against a store that has since been replaced says nothing
        // about the one open now.
        if (store === this.store) this.latched = result.reason ?? 'the bulk airport index failed';
        break;
      case 'interrupted':
        // Not a failure: an interrupted pass is redone whole at the next
        // connection, and until then the rows it did write are still true.
        this.log('debug', `navdata: ${result.reason ?? 'the airport index did not finish'}`);
        break;
      default:
        break;
    }
    this.publish();
  }

  // ── the axis ────────────────────────────────────────────────────────────────

  private publish(): void {
    const axis = this.buildAxis();
    this.axis = axis;
    if (axis !== null) {
      // The server hears the same vocabulary the shell does, from a report
      // that reads nothing from the store — which is what makes it able to
      // say that there is no store.
      try {
        this.sync.reportState(axis);
      } catch (err) {
        this.log('debug', `navdata: the state could not be reported (${describe(err)})`);
      }
    }
    try {
      this.deps.onChange();
    } catch {
      // A status emit that throws is the caller's problem, not a reason to stop.
    }
  }

  private buildAxis(): NavdataStatusAxis | null {
    if (this.unavailable !== null) {
      return {
        state: 'nav.unavailable',
        reason: this.unavailable.reason,
        snapshotId: null,
        rev: null,
        ackedRev: null,
        airports: 0,
        navaids: 0,
        waypoints: 0,
        pendingDemand: 0,
        lastSyncAt: null,
        lastSyncError: null,
      };
    }
    const store = this.store;
    if (store === null) return null;

    let snapshotId: string | null = null;
    let rev: number | null = null;
    try {
      const meta = store.meta();
      snapshotId = meta.snapshotId;
      rev = meta.rev;
    } catch (err) {
      this.latched = describe(err);
    }

    const sync = this.syncStatus();
    return {
      state: this.state(sync),
      reason: this.latched ?? sync.latched,
      snapshotId,
      rev,
      ackedRev: sync.ackedRev,
      airports: this.count('nav_airport'),
      navaids: this.count('nav_navaid'),
      waypoints: this.count('nav_waypoint'),
      // The demand queue does not exist yet; this stays at its empty value
      // until it does.
      pendingDemand: 0,
      lastSyncAt: sync.lastSyncAt,
      lastSyncError: sync.lastSyncError,
    };
  }

  private syncStatus(): NavdataSyncStatus {
    try {
      return this.sync.status();
    } catch {
      return { ackedRev: null, lastSyncAt: null, lastSyncError: null, sending: false, latched: null };
    }
  }

  private state(sync: NavdataSyncStatus): NavdataStatusAxis['state'] {
    if (this.latched !== null || sync.latched !== null) return 'nav.error';
    // A snapshot export or upload is a bulk operation like the pass itself.
    if (this.passing || sync.sending) return 'nav.bulk';
    return this.running ? 'nav.ready' : 'nav.off';
  }

  private storedSimId(store: NavdataStore): SimId | null {
    try {
      return store.meta().simId;
    } catch {
      return null;
    }
  }

  private count(table: 'nav_airport' | 'nav_navaid' | 'nav_waypoint'): number {
    try {
      return this.store?.count(table) ?? 0;
    } catch {
      return 0;
    }
  }

  /** Every entry point runs through this: navdata reports, it does not throw. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.latched = `${what} failed (${describe(err)})`;
      this.log('warn', `navdata: ${this.latched}`);
    }
  }
}

/**
 * Whether a facility list can be parsed on this connection.
 *
 * The list parsers size an ICAO by the protocol the connection was OPENED
 * with — nine characters for a 2024-era one, six below it — while the
 * simulator formats its rows for its own build whatever was negotiated. So a
 * client configured for the wrong simulator reads each list packet off the end
 * of its own buffer, inside the library's parser and before any handler of
 * ours, and the throw takes the connection's whole dispatch loop with it:
 * measured against MSFS 2020 with a 2024 handshake, 0 airports, one RangeError
 * per chunk, and THE 1 Hz FRAME LOOP STOPS DEAD. The same request at the
 * matching protocol returns all 41 871 airports with frames and traffic still
 * flowing on the same handle.
 *
 * Nothing about that is navdata's to fix — but it is navdata's to not trigger.
 */
export function listParseIsSafe(ours: string, sim: string | null): boolean {
  if (sim === null) return false;
  return (ours === 'SunRise') === (sim === 'SunRise');
}

/** One line, no stack: the axis text goes to a CDU scratchpad. */
function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0].slice(0, 200);
}
