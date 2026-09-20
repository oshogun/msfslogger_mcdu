// ── Mode A: the bulk airport index ───────────────────────────────────────────
//
// One list request returns every airport the simulator knows about — measured,
// 41 871 rows in 133 ms, pole to pole and across the antimeridian, with no
// duplicate idents. It is the cheapest thing in this whole feature and it is
// what makes everything else possible: an airport row always exists before any
// runway, frequency or procedure is ever fetched for it.
//
// The legacy list call is used deliberately. The newer per-type call is scoped
// to the simulator's reality bubble for airports as well as navaids — 25 rows
// against the legacy call's 41 871 — and the "all facilities" call is refused
// outright on one protocol and silently discarded on the other.
//
// WHAT A LIST ROW CARRIES is ident, region, latitude, longitude and altitude,
// and nothing else. That is an INDEX entry, not a detail one: a name, a
// magnetic variation and the procedure counts only ever arrive from a later
// per-airport fetch, and this pass must not claim otherwise — hence
// detail_state is written only for a row that did not exist yet, so a pass that
// re-sees an airport whose detail was already fetched does not demote it back
// to an index entry and re-ship it.
//
// INTERRUPTION IS THE WHOLE OF THE RESUME STORY. The pass clears the
// completion stamp before the first row and sets it only when the simulator's
// own final chunk arrives, so a stamp that is missing means the last pass did
// not finish and the next connection redoes it from the beginning. There is no
// cursor: at 133 ms a resume would be more code than the thing it saves, and
// the redo writes nothing new because identical content merges to no change.
//
// YIELDING. better-sqlite3 is synchronous and Node has one thread, so rows are
// buffered as they arrive and written in bounded transactions with a yield
// between them, never from inside the message listener. The frames are not
// lost while a transaction runs — the socket buffers them — but they are
// delayed, and the 1 Hz loop is the thing this client exists for.

import type { LogSink } from './uplink';
import type { AirportListEntry, FacilitySession } from './navdata-facilities';
import type { NavdataRowInput, NavdataStore, NavdataTx } from './navdata-store';

/** At most one bulk pass an hour per process; the world cannot change faster. */
export const BULK_MIN_INTERVAL_MS = 3_600_000;
/** No transaction writes more rows than this, so the frame loop gets its turn. */
export const NAV_WRITE_CHUNK_ROWS = 2000;

export type BulkStatus = 'completed' | 'interrupted' | 'skipped' | 'disabled' | 'failed';

export interface BulkResult {
  readonly status: BulkStatus;
  /** Distinct idents the simulator listed. */
  readonly rows: number;
  /** Rows the store actually changed; a re-run of an unchanged world writes 0. */
  readonly written: number;
  /** Rows that did not exist before this pass. */
  readonly inserted: number;
  /**
   * Set when the stored world was not a subset of the listed one, so rows have
   * to disappear from the replica and only a new epoch can express that.
   */
  readonly epochMinted: string | null;
  /** One line, safe for a status axis: no token, no path. */
  readonly reason: string | null;
}

export interface BulkAirportIndexOptions {
  readonly log?: LogSink;
  readonly now?: () => number;
  /** Rows per transaction. */
  readonly chunkRows?: number;
  readonly minIntervalMs?: number;
  /**
   * How a chunk hands the event loop back. The default is `setImmediate`, which
   * runs after pending I/O callbacks, so frame and facility messages waiting on
   * the socket are delivered between two transactions.
   */
  readonly yieldTick?: () => Promise<void>;
}

const defaultYield = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * Builds one `nav_airport` row from one list row.
 *
 * Three rules the whole store depends on are enforced here and nowhere else:
 *
 *   * a position source is only ever sent WITH a position. Sent alone it would
 *     claim better provenance for a position that came from somewhere else,
 *     after which a genuinely better position is refused — silently, and for
 *     good;
 *   * an absent value is NULL, never a substitute. A missing altitude is not a
 *     sea-level airport, and an empty region is not a region: list rows carry
 *     an empty one for every airport on earth, so sending it would erase a real
 *     region that a detail fetch had supplied;
 *   * detail_state is written only for a row that is new. It is a claim about
 *     how much is known, and this pass knows the least of any path.
 */
export function bulkAirportRow(
  entry: AirportListEntry,
  isNew: boolean,
): NavdataRowInput<'nav_airport'> | null {
  const ident = entry.icao.trim();
  if (ident === '') return null;

  const row: NavdataRowInput<'nav_airport'> = { ident };
  const region = entry.region.trim();
  if (region !== '') row.region = region;
  if (Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude)) {
    row.lat = entry.latitude;
    row.lon = entry.longitude;
    row.position_source = 'list';
  }
  if (Number.isFinite(entry.altitude)) row.alt_m = entry.altitude;
  if (isNew) row.detail_state = 'index';

  return row;
}

interface PassCounters {
  rows: number;
  written: number;
  inserted: number;
  matched: number;
  duplicates: number;
}

/**
 * Mode A. One instance per process: it remembers when the last pass finished so
 * a reconnect storm cannot re-run it, while an interrupted pass is always
 * redone at the next opportunity regardless of when it was attempted.
 */
export class BulkAirportIndex {
  private readonly log: LogSink;
  private readonly now: () => number;
  private readonly chunkRows: number;
  private readonly minIntervalMs: number;
  private readonly yieldTick: () => Promise<void>;

  private lastCompletedAt: number | null = null;
  private running = false;

  constructor(options: BulkAirportIndexOptions = {}) {
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.chunkRows = options.chunkRows ?? NAV_WRITE_CHUNK_ROWS;
    this.minIntervalMs = options.minIntervalMs ?? BULK_MIN_INTERVAL_MS;
    this.yieldTick = options.yieldTick ?? defaultYield;
  }

  /**
   * Runs a pass and never throws. Navdata is one axis of this sidecar and the
   * only one allowed to fail: an escaping error would reach the supervisor,
   * which answers a dying sidecar with five restarts in a rolling minute and
   * then a latched crash — taking frames, events, traffic and the datalink down
   * with it over a cache that rebuilds itself in a fraction of a second.
   */
  async run(session: FacilitySession, store: NavdataStore | null): Promise<BulkResult> {
    if (store === null) {
      return this.result('disabled', null, 'navdata disabled: no store is open');
    }
    if (this.running) {
      return this.result('skipped', null, 'a bulk airport index is already running');
    }
    this.running = true;
    try {
      return await this.pass(session, store);
    } catch (err) {
      const reason = describeFailure(err);
      this.log('warn', `navdata: the bulk airport index failed (${reason})`);
      return this.result('failed', null, reason);
    } finally {
      this.running = false;
    }
  }

  private async pass(session: FacilitySession, store: NavdataStore): Promise<BulkResult> {
    const startedAt = this.now();
    const interrupted = store.meta().bulkCompletedAt === null;
    if (
      !interrupted &&
      this.lastCompletedAt !== null &&
      startedAt - this.lastCompletedAt < this.minIntervalMs
    ) {
      return this.result('skipped', null, 'the bulk airport index ran less than an hour ago');
    }
    if (interrupted && this.lastCompletedAt !== null) {
      this.log('info', 'navdata: the last bulk airport index did not finish — redoing it');
    }

    // Clearing the completion stamp first is what makes an interrupted pass
    // detectable: from here until the simulator's final chunk, the store says
    // its index is unfinished.
    store.write((tx) => tx.updateMeta({ bulkStartedAt: startedAt, bulkCompletedAt: null }));

    // Every nav_airport row comes from this list: a detail fetch only ever
    // updates an airport the index already put there, and nothing else inserts
    // one. That is what makes the count below a fair comparison — if some later
    // path ever inserts an airport the list does not carry, this comparison
    // would find it "missing" and mint a new epoch on every single pass.
    const countBefore = store.count('nav_airport');
    const counters: PassCounters = { rows: 0, written: 0, inserted: 0, matched: 0, duplicates: 0 };
    const seen = new Set<string>();
    const buffer: AirportListEntry[] = [];
    let drain: Promise<void> | null = null;
    let drainError: unknown = null;

    const pump = async (): Promise<void> => {
      // The first thing a drain does is give the listener its stack back: a
      // transaction must never run inside a SimConnect handler.
      await this.yieldTick();
      while (drainError === null && buffer.length >= this.chunkRows) {
        this.writeChunk(store, buffer.splice(0, this.chunkRows), seen, counters);
        await this.yieldTick();
      }
    };

    const list = await session.requestAirportList({
      onChunk: (airports) => {
        if (drainError !== null) return;
        for (const airport of airports) buffer.push(airport);
        if (drain === null && buffer.length >= this.chunkRows) {
          drain = pump()
            .catch((err: unknown) => {
              drainError = err;
            })
            .finally(() => {
              drain = null;
            });
        }
      },
    });

    if (drain !== null) await drain;
    if (drainError !== null) throw drainError;

    if (list.outcome !== 'ok') {
      // Whatever arrived stays: the rows are true, they are simply not all of
      // them. The missing completion stamp is what tells the next pass to start
      // again, and no epoch decision may be taken on a partial list — half a
      // world looks exactly like a world that lost half its airports.
      const reason =
        list.outcome === 'failed'
          ? `the airport list failed (${list.exception ?? 'no reason given'})`
          : list.outcome === 'aborted'
            ? 'the simulator connection dropped during the airport list'
            : 'the airport list stopped arriving before its last chunk';
      this.log('warn', `navdata: ${reason} — the index will be redone`);
      return this.result('interrupted', counters, reason);
    }

    while (buffer.length > 0) {
      this.writeChunk(store, buffer.splice(0, this.chunkRows), seen, counters);
      if (buffer.length > 0) await this.yieldTick();
    }

    // A LIST THAT CARRIED NO ROWS IS NOT A COMPLETED PASS, whatever the
    // simulator claimed by ending it. The world has airports in it; an empty
    // answer means the request did not really run, and the epoch comparison
    // below would read it as every stored airport having disappeared — which
    // is the one conclusion that destroys data rather than merely costing a
    // re-fetch. So: no stamp, no mint, redo it next time.
    if (counters.rows === 0) {
      const reason = 'the airport list ended without carrying a single row';
      this.log('warn', `navdata: ${reason} — the index will be redone`);
      return this.result('interrupted', counters, reason);
    }

    // Additions ship as incrementals and the epoch stands: a new scenery
    // package is the common case. A stored airport that the simulator no longer
    // lists is the other case, and the incremental protocol has no delete, so
    // the only way to make the replica lose a row is to mint a new epoch and
    // let a snapshot replace it wholesale.
    const missing = countBefore > 0 && counters.matched < countBefore;
    const completedAt = this.now();
    const epochMinted = store.write((tx) => {
      const minted = missing ? tx.mintEpoch() : null;
      tx.updateMeta({ bulkCompletedAt: completedAt, bulkRowCount: counters.rows });
      return minted;
    });
    this.lastCompletedAt = completedAt;

    if (counters.duplicates > 0) {
      this.log(
        'info',
        `navdata: the airport list repeated ${counters.duplicates} ident(s); each was taken once`,
      );
    }
    if (epochMinted !== null) {
      this.log(
        'info',
        `navdata: ${countBefore - counters.matched} stored airport(s) are no longer listed — ` +
          'starting a new snapshot epoch',
      );
    }
    this.log(
      'info',
      `navdata: airport index ${counters.rows} row(s), ${counters.inserted} new, ` +
        `${counters.written} written, ${completedAt - startedAt} ms`,
    );
    return {
      status: 'completed',
      rows: counters.rows,
      written: counters.written,
      inserted: counters.inserted,
      epochMinted,
      reason: null,
    };
  }

  private writeChunk(
    store: NavdataStore,
    chunk: readonly AirportListEntry[],
    seen: Set<string>,
    counters: PassCounters,
  ): void {
    store.write((tx: NavdataTx) => {
      for (const entry of chunk) {
        const ident = entry.icao.trim();
        if (ident === '') continue;
        if (seen.has(ident)) {
          counters.duplicates++;
          continue;
        }
        seen.add(ident);
        const stored = tx.row('nav_airport', { ident });
        const row = bulkAirportRow(entry, stored === null);
        if (row === null) continue;
        counters.rows++;
        if (stored === null) counters.inserted++;
        else counters.matched++;
        if (tx.upsert('nav_airport', row)) counters.written++;
      }
    });
  }

  private result(status: BulkStatus, counters: PassCounters | null, reason: string): BulkResult {
    return {
      status,
      rows: counters?.rows ?? 0,
      written: counters?.written ?? 0,
      inserted: counters?.inserted ?? 0,
      epochMinted: null,
      reason,
    };
  }
}

/** An error reduced to one safe line: a code when there is one, never a path. */
function describeFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
