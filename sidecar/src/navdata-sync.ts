// ── Navdata sync: the snapshot upload, the incremental stream and the state report
//
// Three POSTs and one cursor. The snapshot resets the server's replica
// wholesale, incremental batches carry everything written since, and a state
// report tells the server what this sidecar's navdata is doing — including
// that it is doing nothing at all.
//
// THE EPOCH BEATS THE REV. `snapshot_id` identifies one extraction; `rev` is
// monotonic only within it, and comparing revs across epochs is undefined. So a
// batch carries its epoch and the server rejects a mismatch rather than
// interleaving two extractions. That rejection is THE resync signal: the
// sidecar re-exports the epoch it already has — it does not mint a new one,
// because minting would throw away the very distinction the epoch exists to
// carry, and because a re-export works with the simulator closed.
//
// THE CURSOR IS KEYED BY SERVER URL. Pointing the client at a different server
// invalidates what was acknowledged, exactly as the datalink drops a prefiled
// leg when the server changes.
//
// NOTHING HERE THROWS AT ITS CALLER and nothing here claims the backend status
// axis. A refused connection, a 500, a malformed acknowledgement and a store
// that will not read are all results, reported on the navdata axis and nowhere
// else. Navdata never starts or stops the uplink and never touches the
// reachability probe.
//
// THE TOKEN TRAVELS IN `x-ingest-token` AND NOWHERE ELSE — not in a URL, a file
// name, a log line or the payload — and redirects are not followed, so it is
// never replayed to wherever a 3xx points.

import * as fs from 'fs';
import * as path from 'path';

import type { EffectiveConfig } from './config';
import {
  exportSnapshot,
  openNavdataReader,
  SNAPSHOT_TABLE_ORDER,
  NAVDATA_WIRE_VERSION,
  type NavdataReader,
  type NavdataTaggedRow,
  type NavRowCounts,
  type SnapshotExportResult,
} from './navdata-export';
import { NAVDATA_SCHEMA_VERSION, type NavdataTable } from './navdata-schema';
import type { NavdataStore } from './navdata-store';
import type { NavdataStatusAxis } from './protocol';
import type { LogSink } from './uplink';

export const NAVDATA_SNAPSHOT_PATH = '/api/navdata/snapshot';
export const NAVDATA_ROWS_PATH = '/api/navdata/rows';
export const NAVDATA_STATE_PATH = '/api/navdata/state';

/** The multipart field name. The server tells its uploads apart by it. */
export const NAVDATA_SNAPSHOT_FIELD = 'navdataSnapshot';

export const NAVDATA_BATCH_MAX_ROWS = 2000;
export const NAVDATA_BATCH_MAX_BYTES = 4 * 1024 * 1024;
/** One batch in flight, and no more than one per this interval while a backlog exists. */
export const NAVDATA_BATCH_MIN_INTERVAL_MS = 2000;
/** A server that keeps rejecting the epoch must not be uploaded to in a loop. */
export const RESYNC_MIN_INTERVAL_MS = 300000;
export const NAVDATA_STATE_HEARTBEAT_MS = 300000;
/** What a 503 costs when the server names no Retry-After. */
export const NAVDATA_BUSY_DEFAULT_MS = 5000;
export const NAVDATA_BUSY_MAX_MS = 300000;
export const NAVDATA_SYNC_BACKOFF_MAX_MS = 120000;

export const NAVDATA_HTTP_TIMEOUT_MS = 15000;
/** The upload carries a file, so it gets the room a file needs. */
export const NAVDATA_SNAPSHOT_TIMEOUT_MS = 120000;
export const NAVDATA_STATE_TIMEOUT_MS = 10000;
/** Acknowledgements are a handful of scalars; anything larger is not one. */
export const NAVDATA_ACK_MAX_BYTES = 256 * 1024;

/** 2 s while healthy, doubling per consecutive failure, capped at 120 s. */
export function nextSyncDelayMs(consecutiveFailures: number): number {
  const f = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0 ? Math.floor(consecutiveFailures) : 0;
  if (f === 0) return NAVDATA_BATCH_MIN_INTERVAL_MS;
  return Math.min(NAVDATA_BATCH_MIN_INTERVAL_MS * 2 ** Math.min(f, 16), NAVDATA_SYNC_BACKOFF_MAX_MS);
}

/**
 * The tables that hold something a map can draw. `nav_coverage_cell` and
 * `nav_absent` are deliberately not among them: they record where the
 * extractor has looked and what it did not find, which is bookkeeping about
 * this client rather than knowledge of the world.
 */
const FACILITY_TABLES: readonly NavdataTable[] = SNAPSHOT_TABLE_ORDER.filter(
  (entry) => entry.type !== 'coverage_cell' && entry.type !== 'absent',
).map((entry) => entry.table);

export type NavdataErrorCode =
  | 'NAVDATA_SNAPSHOT_MISMATCH'
  | 'NAVDATA_SCHEMA_UNSUPPORTED'
  | 'NAVDATA_BAD_BATCH'
  | 'NAVDATA_TOO_LARGE'
  | 'NAVDATA_BUSY';

const ERROR_CODES: readonly string[] = [
  'NAVDATA_SNAPSHOT_MISMATCH',
  'NAVDATA_SCHEMA_UNSUPPORTED',
  'NAVDATA_BAD_BATCH',
  'NAVDATA_TOO_LARGE',
  'NAVDATA_BUSY',
];

export interface IncrementalBatch {
  v: number;
  schemaVersion: number;
  snapshotId: string;
  /** Exclusive: the rev the sidecar believes the server holds. */
  fromRev: number;
  /** Inclusive: the highest rev in `rows`. */
  toRev: number;
  rows: NavdataTaggedRow[];
  more: boolean;
}

export interface NavdataStateReport {
  v: number;
  state: NavdataStatusAxis['state'];
  reason: string | null;
  snapshotId: string | null;
  rev: number | null;
  sentAt: number;
}

/** What the client needs from the uplink: its config and its CA trust. */
export interface NavdataTransport {
  getConfig(): EffectiveConfig;
  dispatchInit(init: Record<string, unknown>): RequestInit;
}

export type NavdataOutcome =
  | {
      kind: 'response';
      status: number;
      /** The server's own code when it sent one of ours, else null. */
      code: NavdataErrorCode | null;
      retryAfterMs: number | null;
      body: unknown;
    }
  | { kind: 'transport'; errorName: string | null; errorCode: string | null };

export interface NavdataRequester {
  postSnapshot(file: { path: string; fileName: string }): Promise<NavdataOutcome>;
  postRows(batch: IncrementalBatch): Promise<NavdataOutcome>;
  postState(report: NavdataStateReport): Promise<NavdataOutcome>;
}

/** Node nests the useful code a few `cause` levels down. */
function stringCodeOf(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function errorNameOf(err: unknown): string | null {
  const causeName = (err as { cause?: { name?: unknown } } | null)?.cause?.name;
  if (causeName === 'TimeoutError') return causeName;
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : null;
}

function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.round(seconds * 1000), NAVDATA_BUSY_MAX_MS);
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function codeOf(body: unknown): NavdataErrorCode | null {
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && ERROR_CODES.includes(code) ? (code as NavdataErrorCode) : null;
}

/**
 * The only navdata code that talks to the network. Three routes, no path is
 * ever composed from a value, and every attempt resolves to an outcome.
 */
export class NavdataSyncClient implements NavdataRequester {
  private readonly transport: () => NavdataTransport | null;
  private readonly timeouts: { rows: number; snapshot: number; state: number };

  constructor(
    transport: () => NavdataTransport | null,
    timeouts: Partial<{ rows: number; snapshot: number; state: number }> = {},
  ) {
    this.transport = transport;
    this.timeouts = {
      rows: timeouts.rows ?? NAVDATA_HTTP_TIMEOUT_MS,
      snapshot: timeouts.snapshot ?? NAVDATA_SNAPSHOT_TIMEOUT_MS,
      state: timeouts.state ?? NAVDATA_STATE_TIMEOUT_MS,
    };
  }

  async postSnapshot(file: { path: string; fileName: string }): Promise<NavdataOutcome> {
    let body: Buffer;
    try {
      body = await fs.promises.readFile(file.path);
    } catch (err) {
      return { kind: 'transport', errorName: errorNameOf(err), errorCode: stringCodeOf(err) };
    }
    const form = new FormData();
    // The field name is load-bearing: the server tells one upload from another
    // by it, so it must be this and must not be shared with any other route.
    form.append(
      NAVDATA_SNAPSHOT_FIELD,
      new Blob([body], { type: 'application/gzip' }),
      file.fileName,
    );
    return this.send(NAVDATA_SNAPSHOT_PATH, form, this.timeouts.snapshot, false);
  }

  postRows(batch: IncrementalBatch): Promise<NavdataOutcome> {
    return this.send(NAVDATA_ROWS_PATH, JSON.stringify(batch), this.timeouts.rows, true);
  }

  postState(report: NavdataStateReport): Promise<NavdataOutcome> {
    return this.send(NAVDATA_STATE_PATH, JSON.stringify(report), this.timeouts.state, true);
  }

  private async send(
    routePath: string,
    body: string | FormData,
    timeoutMs: number,
    json: boolean,
  ): Promise<NavdataOutcome> {
    const transport = this.transport();
    if (!transport) return { kind: 'transport', errorName: 'NoConfig', errorCode: null };
    const config = transport.getConfig();

    const headers: Record<string, string> = {
      'x-ingest-token': config.ingestToken,
      accept: 'application/json',
    };
    // A multipart body sets its own content type, boundary and all.
    if (json) headers['content-type'] = 'application/json';

    const init: Record<string, unknown> = {
      method: 'POST',
      headers,
      body,
      // A 3xx is a fault, not a hop: the token is never sent to its target.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };

    try {
      const res = await fetch(`${config.serverUrl}${routePath}`, transport.dispatchInit(init));
      const text = await readCapped(res, NAVDATA_ACK_MAX_BYTES);
      let parsed: unknown = null;
      if (text !== null && text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // An answer that is not JSON is an answer this route cannot use; the
          // status still says what happened.
          parsed = null;
        }
      }
      return {
        kind: 'response',
        status: res.status,
        code: codeOf(parsed),
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
        body: parsed,
      };
    } catch (err) {
      return { kind: 'transport', errorName: errorNameOf(err), errorCode: stringCodeOf(err) };
    }
  }
}

// ── the batch ─────────────────────────────────────────────────────────────────

export interface BatchBounds {
  maxRows: number;
  maxBytes: number;
}

export interface BuiltBatch {
  rows: NavdataTaggedRow[];
  toRev: number;
  more: boolean;
  bytes: number;
}

interface Candidate {
  rev: number;
  order: number;
  row: NavdataTaggedRow;
  bytes: number;
}

/**
 * The rows above `fromRev`, ordered by rev and then by the emission order of a
 * snapshot, truncated at the first bound hit.
 *
 * TRUNCATION IS AT A REV BOUNDARY, always. `toRev` becomes the cursor, so
 * cutting inside a rev would acknowledge rows that were never sent and they
 * would never be re-sent. A rev is only taken when all of it fits — the one
 * exception being a rev that cannot fit at all, which is sent whole rather
 * than deadlocking the stream behind it.
 */
export function buildBatch(reader: NavdataReader, fromRev: number, bounds: BatchBounds): BuiltBatch | null {
  const maxRows = Math.max(1, bounds.maxRows);
  const maxBytes = Math.max(1, bounds.maxBytes);

  const candidates: Candidate[] = [];
  let safeMax = Number.POSITIVE_INFINITY;
  let limited = false;

  for (let order = 0; order < SNAPSHOT_TABLE_ORDER.length; order++) {
    const { table, type } = SNAPSHOT_TABLE_ORDER[order];
    const rows = reader.since(table, fromRev, maxRows + 1);
    if (rows.length === 0) continue;
    if (rows.length > maxRows) {
      // Ordered by rev, so everything below the last rev returned is complete
      // and everything at it may not be.
      limited = true;
      safeMax = Math.min(safeMax, Number(rows[rows.length - 1].rev) - 1);
    }
    for (const row of rows) {
      const tagged: NavdataTaggedRow = { t: type, r: row };
      candidates.push({
        rev: Number(row.rev),
        order,
        row: tagged,
        bytes: Buffer.byteLength(JSON.stringify(tagged)),
      });
    }
  }

  const usable = candidates.filter((candidate) => candidate.rev <= safeMax);
  if (usable.length === 0) {
    if (candidates.length === 0) return null;
    // Every row waiting belongs to one transaction, and that transaction is
    // larger than a whole batch. It goes whole: splitting it would move the
    // cursor past rows that were never sent.
    return wholeRev(reader, Math.min(...candidates.map((candidate) => candidate.rev)));
  }
  usable.sort((a, b) => (a.rev === b.rev ? a.order - b.order : a.rev - b.rev));

  const rows: NavdataTaggedRow[] = [];
  let bytes = 0;
  let toRev = fromRev;
  let taken = 0;
  let index = 0;

  while (index < usable.length) {
    const rev = usable[index].rev;
    let end = index;
    let groupBytes = 0;
    while (end < usable.length && usable[end].rev === rev) {
      groupBytes += usable[end].bytes;
      end++;
    }
    const groupRows = end - index;
    if (rows.length > 0 && (rows.length + groupRows > maxRows || bytes + groupBytes > maxBytes)) break;
    if (rows.length === 0 && (groupRows > maxRows || groupBytes > maxBytes)) {
      return wholeRev(reader, rev);
    }
    for (let i = index; i < end; i++) rows.push(usable[i].row);
    bytes += groupBytes;
    toRev = rev;
    taken = end;
    index = end;
  }

  if (rows.length === 0) return null;
  return { rows, toRev, more: limited || taken < usable.length, bytes };
}

/**
 * One whole transaction, read back complete — a per-table limit may have
 * clipped it — and always with more to follow, since it only exists as an
 * answer to a rev that would not fit.
 */
function wholeRev(reader: NavdataReader, rev: number): BuiltBatch {
  const rows: NavdataTaggedRow[] = [];
  for (let order = 0; order < SNAPSHOT_TABLE_ORDER.length; order++) {
    const { table, type } = SNAPSHOT_TABLE_ORDER[order];
    for (const row of reader.atRev(table, rev)) rows.push({ t: type, r: row });
  }
  return { rows, toRev: rev, more: true, bytes: Buffer.byteLength(JSON.stringify(rows)) };
}

// ── the cursor ────────────────────────────────────────────────────────────────

export type SyncState =
  | 'idle'
  | 'snapshot-required'
  | 'snapshot-sending'
  | 'incremental'
  | 'resync-required'
  | 'failed';

export interface SyncCursor {
  snapshotId: string | null;
  ackedRev: number;
  state: SyncState;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastErrorCode: string | null;
}

export interface SyncCursorPatch {
  snapshotId?: string;
  ackedRev?: number;
  state?: SyncState;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastErrorCode?: string;
}

export function readCursor(store: NavdataStore, serverUrl: string): SyncCursor | null {
  const row = store.row('nav_sync', { server_url: serverUrl });
  if (row === null) return null;
  return {
    snapshotId: row.snapshot_id === null ? null : String(row.snapshot_id),
    ackedRev: Number(row.acked_rev),
    state: String(row.state) as SyncState,
    lastOkAt: row.last_ok_at === null ? null : Number(row.last_ok_at),
    lastErrorAt: row.last_error_at === null ? null : Number(row.last_error_at),
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
  };
}

/**
 * Writes the cursor. Only the fields named are changed: the store merges, so
 * an absent field keeps what is stored — which is why nothing here ever needs
 * to clear one.
 */
export function writeCursor(
  store: NavdataStore,
  serverUrl: string,
  patch: SyncCursorPatch,
  at: number,
): void {
  store.write((tx) =>
    tx.upsert('nav_sync', {
      server_url: serverUrl,
      ...(patch.snapshotId === undefined ? {} : { snapshot_id: patch.snapshotId }),
      ...(patch.ackedRev === undefined ? {} : { acked_rev: patch.ackedRev }),
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.lastOkAt === undefined ? {} : { last_ok_at: patch.lastOkAt }),
      ...(patch.lastErrorAt === undefined ? {} : { last_error_at: patch.lastErrorAt }),
      ...(patch.lastErrorCode === undefined ? {} : { last_error_code: patch.lastErrorCode }),
      updated_at: at,
    }),
  );
}

// ── the service ───────────────────────────────────────────────────────────────

export interface NavdataSyncDeps {
  /** The uplink, or null while there is no valid config. */
  transport(): NavdataTransport | null;
  /** The open store, or null when navdata has none. */
  store(): NavdataStore | null;
  sidecarVersion(): string;
  log: LogSink;
  /** Something the navdata axis shows has changed. */
  onChange(): void;
  now?(): number;
  /** Test seams. */
  client?: NavdataRequester;
  openReader?(dbPath: string): NavdataReader;
}

export interface NavdataSyncStatus {
  ackedRev: number | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
  /** True while a snapshot is being exported or uploaded. */
  sending: boolean;
  /** Set once and for good when a human has to ship code. */
  latched: string | null;
}

export class NavdataSync {
  private readonly deps: NavdataSyncDeps;
  private readonly log: LogSink;
  private readonly now: () => number;
  private readonly client: NavdataRequester;
  private readonly openReader: (dbPath: string) => NavdataReader;

  private running = false;
  private shuttingDown = false;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private nextAllowedAt = 0;
  private lastResyncAt: number | null = null;
  /** The rev a scan last found nothing above; below it there is nothing to look for. */
  private scannedEmptyAt = -1;
  private bounds: BatchBounds = { maxRows: NAVDATA_BATCH_MAX_ROWS, maxBytes: NAVDATA_BATCH_MAX_BYTES };

  private ackedRev: number | null = null;
  private lastSyncAt: number | null = null;
  private lastSyncError: string | null = null;
  private sending = false;
  private latched: string | null = null;
  /** The last error text logged, so a failing server is not one line per try. */
  private loggedError: string | null = null;

  private heartbeat: NodeJS.Timeout | null = null;
  private reported: NavdataStateReport | null = null;
  private statePosting = false;

  constructor(deps: NavdataSyncDeps) {
    this.deps = deps;
    this.log = (level, message) => {
      try {
        deps.log(level, message);
      } catch {
        // Reporting is not worth failing over.
      }
    };
    this.now = deps.now ?? Date.now;
    this.client = deps.client ?? new NavdataSyncClient(() => deps.transport());
    this.openReader = deps.openReader ?? ((dbPath) => openNavdataReader(dbPath));
  }

  status(): NavdataSyncStatus {
    return {
      ackedRev: this.ackedRev,
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      sending: this.sending,
      latched: this.latched,
    };
  }

  /** The uplink is running: the snapshot and the incremental stream may run. */
  start(): void {
    if (this.shuttingDown) return;
    this.running = true;
    this.startHeartbeat();
    this.schedule(0);
  }

  /**
   * The uplink stopped. Rows stop flowing, and the state report does not: what
   * the server most needs to hear is exactly that navdata is not running.
   */
  stop(): void {
    this.running = false;
    this.cancelTimer();
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.running = false;
    this.cancelTimer();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** A config was applied; the server it names may be a different one. */
  onConfigApplied(): void {
    // The cursor is keyed by server URL, so the stored one for the new server
    // is authoritative. Only the in-memory pacing is reset.
    this.failures = 0;
    this.nextAllowedAt = 0;
    this.lastResyncAt = null;
    this.bounds = { maxRows: NAVDATA_BATCH_MAX_ROWS, maxBytes: NAVDATA_BATCH_MAX_BYTES };
    this.ackedRev = null;
    this.scannedEmptyAt = -1;
    if (this.running) this.schedule(0);
  }

  // ── the state report ────────────────────────────────────────────────────────

  /**
   * Sent on every transition and otherwise as a heartbeat. It reads nothing
   * from the store ON PURPOSE: the state that matters most is the one where
   * there is no store to read.
   */
  reportState(axis: Pick<NavdataStatusAxis, 'state' | 'reason' | 'snapshotId' | 'rev'>): void {
    const previous = this.reported;
    const changed =
      previous === null ||
      previous.state !== axis.state ||
      previous.reason !== axis.reason ||
      previous.snapshotId !== axis.snapshotId;
    this.reported = {
      v: NAVDATA_WIRE_VERSION,
      state: axis.state,
      reason: axis.reason,
      snapshotId: axis.snapshotId,
      rev: axis.rev,
      sentAt: this.now(),
    };
    if (changed) this.postState();
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null || this.shuttingDown) return;
    this.heartbeat = setInterval(() => this.postState(), NAVDATA_STATE_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Fire and forget: a failed report is superseded by the next one. */
  private postState(): void {
    if (this.shuttingDown || this.statePosting) return;
    const report = this.reported;
    if (report === null) return;
    // No server named, nothing to report to. Not a failure and not a log line:
    // the sidecar runs perfectly well before a config has ever been applied.
    if (this.serverUrl() === null) return;
    this.statePosting = true;
    const body: NavdataStateReport = { ...report, sentAt: this.now() };
    void (async () => {
      try {
        const outcome = await this.client.postState(body);
        if (outcome.kind !== 'response' || outcome.status < 200 || outcome.status >= 300) {
          this.log('debug', `navdata: the state report was not accepted (${describeOutcome(outcome)})`);
        }
      } catch (err) {
        this.log('debug', `navdata: the state report failed (${describe(err)})`);
      } finally {
        this.statePosting = false;
      }
    })();
  }

  // ── the loop ────────────────────────────────────────────────────────────────

  /** The server in use, or null while there is no usable config. */
  private serverUrl(): string | null {
    try {
      const url = this.deps.transport()?.getConfig()?.serverUrl;
      return typeof url === 'string' && url.length > 0 ? url : null;
    } catch {
      return null;
    }
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    if (!this.running || this.shuttingDown || this.latched !== null) return;
    const delay = Math.max(0, delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    this.timer.unref?.();
  }

  /** One step. Never throws: every path out of it is a scheduled retry. */
  private async tick(): Promise<void> {
    if (!this.running || this.shuttingDown || this.busy || this.latched !== null) return;
    this.busy = true;
    let delay = NAVDATA_BATCH_MIN_INTERVAL_MS;
    try {
      delay = await this.step();
    } catch (err) {
      // The step is built not to throw. If it ever does, navdata still fails
      // alone: the reason lands on the axis and the process carries on.
      this.fail(`navdata sync failed (${describe(err)})`);
      delay = nextSyncDelayMs(this.failures);
    } finally {
      this.busy = false;
    }
    this.schedule(delay);
  }

  private async step(): Promise<number> {
    const serverUrl = this.serverUrl();
    const store = this.deps.store();
    if (serverUrl === null || !store) return NAVDATA_BATCH_MIN_INTERVAL_MS;

    const waitFor = this.nextAllowedAt - this.now();
    if (waitFor > 0) return waitFor;

    const meta = store.meta();
    let cursor = readCursor(store, serverUrl);
    if (cursor === null) {
      writeCursor(store, serverUrl, { state: 'snapshot-required', ackedRev: 0 }, this.now());
      cursor = readCursor(store, serverUrl);
      if (cursor === null) return nextSyncDelayMs(++this.failures);
    }
    this.publishCursor(cursor);

    const epochChanged = cursor.snapshotId === null || cursor.snapshotId !== meta.snapshotId;
    // INCREMENTALS RUN IN EXACTLY ONE STATE. A mismatch stops them, and so does
    // every other state that is not the steady one: a cursor left at
    // 'snapshot-sending' means a snapshot went out and was never acknowledged,
    // and a cursor at 'resync-required' means the server has already said this
    // epoch is wrong. Posting rows in either case is how a client talks past a
    // server that has told it to start again.
    const needsSnapshot = epochChanged || cursor.state !== 'incremental';

    if (needsSnapshot) {
      // An empty store has nothing to say. A snapshot resets the replica
      // WHOLESALE, so uploading one now would tell the server that the world
      // is empty and throw away whatever it holds — and this store cannot
      // make that claim until a bulk pass has filled it. It happens on a
      // freshly created or rebuilt store, before the simulator has ever been
      // reached. Coverage and absence rows do not count: they are bookkeeping
      // about where we have looked, and a snapshot carrying only those would
      // wipe every facility the server holds.
      if (!this.hasFacilityRows(store)) return NAVDATA_BATCH_MIN_INTERVAL_MS;
      if (cursor.state === 'resync-required' && this.lastResyncAt !== null) {
        const since = this.now() - this.lastResyncAt;
        if (since < RESYNC_MIN_INTERVAL_MS) return RESYNC_MIN_INTERVAL_MS - since;
      }
      return await this.runSnapshot(store, serverUrl, cursor);
    }

    if (meta.rev <= cursor.ackedRev || meta.rev <= this.scannedEmptyAt) {
      return NAVDATA_BATCH_MIN_INTERVAL_MS;
    }
    return await this.runBatch(store, serverUrl, cursor, meta.snapshotId);
  }

  /**
   * Whether the store holds a FACILITY row — anything a map can draw. A store
   * with nothing but coverage cells and absences has looked at the world and
   * found nothing in it yet, which is not the same as knowing the world.
   */
  private hasFacilityRows(store: NavdataStore): boolean {
    for (const table of FACILITY_TABLES) {
      if (store.count(table) > 0) return true;
    }
    return false;
  }

  // ── the snapshot ────────────────────────────────────────────────────────────

  private async runSnapshot(store: NavdataStore, serverUrl: string, cursor: SyncCursor): Promise<number> {
    const resyncing = cursor.state === 'resync-required';
    if (resyncing) this.lastResyncAt = this.now();
    this.sending = true;
    // A resync KEEPS its state until it succeeds. Marking it 'snapshot-sending'
    // would lose the fact that the server rejected this epoch, and lose the
    // rate limit with it, the moment this attempt failed.
    if (!resyncing) this.setCursorState(store, serverUrl, 'snapshot-sending');
    this.deps.onChange();

    let exported: SnapshotExportResult;
    try {
      exported = await this.export(store);
    } catch (err) {
      this.sending = false;
      this.fail(`the navdata snapshot could not be exported (${describe(err)})`);
      this.recordError(store, serverUrl, 'EXPORT_FAILED');
      return nextSyncDelayMs(this.failures);
    }

    // THE GUARD, not the check before it. The store can empty between the two
    // — and a file with no rows in it, whatever produced it, would reset the
    // replica to nothing. An export that came out empty is never posted.
    if (exported.rows === 0) {
      this.sending = false;
      this.removeExport(exported.path);
      this.logOnce('navdata: the snapshot came out empty and was not sent');
      this.deps.onChange();
      return NAVDATA_BATCH_MIN_INTERVAL_MS;
    }

    let outcome: NavdataOutcome;
    try {
      outcome = await this.client.postSnapshot({ path: exported.path, fileName: exported.fileName });
    } catch (err) {
      outcome = { kind: 'transport', errorName: errorNameOf(err), errorCode: stringCodeOf(err) };
    }
    this.sending = false;

    if (outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300) {
      const counts = ackCounts(outcome.body);
      if (counts !== null) this.warnOnCountMismatch(exported.counts, counts);
      const epoch = ackSnapshotId(outcome.body);
      if (epoch !== null && epoch !== exported.snapshotId) {
        // The cursor records OUR epoch either way, so the next batch carries
        // it and a server that really holds another one answers 409 and sends
        // us round the resync path. Worth saying out loud all the same.
        this.log('warn', 'navdata: the server acknowledged the snapshot under a different epoch');
      }
      this.succeed(store, serverUrl, {
        snapshotId: exported.snapshotId,
        ackedRev: exported.rev,
        state: 'incremental',
      });
      this.log(
        'info',
        `navdata: the server took the snapshot (${exported.rows} rows, ${exported.bytes} bytes, rev ${exported.rev})`,
      );
      this.removeExport(exported.path);
      this.deps.onChange();
      return NAVDATA_BATCH_MIN_INTERVAL_MS;
    }

    // The file is kept: it is the evidence of what was sent, and the next
    // export removes whatever it replaces.
    return this.handleFailure(store, serverUrl, outcome, 'snapshot');
  }

  private async export(store: NavdataStore): Promise<SnapshotExportResult> {
    const directory = path.dirname(store.path);
    // The write-ahead log is folded back in first: the export reads the same
    // file through a connection of its own, and a checkpoint keeps that read
    // cheap rather than a replay of everything since the last one.
    try {
      store.checkpoint();
    } catch (err) {
      this.log('debug', `navdata: the store did not checkpoint before the export (${describe(err)})`);
    }
    const reader = this.openReader(store.path);
    try {
      return await exportSnapshot(reader, {
        directory,
        sidecarVersion: this.deps.sidecarVersion(),
        now: this.now,
        log: this.log,
      });
    } finally {
      try {
        reader.close();
      } catch {
        // A reader that will not close takes its connection with it anyway.
      }
    }
  }

  private removeExport(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      this.log('debug', `navdata: the snapshot file could not be removed (${describe(err)})`);
    }
  }

  private warnOnCountMismatch(sent: NavRowCounts, applied: NavRowCounts): void {
    const differing: string[] = [];
    for (const { type } of SNAPSHOT_TABLE_ORDER) {
      const ours = sent[type] ?? 0;
      const theirs = applied[type] ?? 0;
      if (ours !== theirs) differing.push(`${type} ${ours}/${theirs}`);
    }
    if (differing.length === 0) return;
    // Not retried: the epoch is applied either way, and a real divergence
    // surfaces on the next incremental.
    this.log('warn', `navdata: the server applied different counts (sent/applied ${differing.join(', ')})`);
  }

  // ── the incremental stream ──────────────────────────────────────────────────

  private async runBatch(
    store: NavdataStore,
    serverUrl: string,
    cursor: SyncCursor,
    snapshotId: string,
  ): Promise<number> {
    let batch: BuiltBatch | null;
    const reader = this.openReader(store.path);
    try {
      reader.begin();
      batch = buildBatch(reader, cursor.ackedRev, this.bounds);
    } catch (err) {
      this.fail(`the navdata rows could not be read (${describe(err)})`);
      return nextSyncDelayMs(this.failures);
    } finally {
      try {
        reader.close();
      } catch {
        // Nothing to salvage from a reader that will not close.
      }
    }

    // A rev with no rows of its own — the cursor's own write bumps one — is not
    // a batch. Nothing is sent and nothing is acknowledged, and the rev it was
    // scanned at is remembered so the next tick does not open the database
    // again to learn the same thing.
    if (batch === null) {
      this.scannedEmptyAt = store.meta().rev;
      return NAVDATA_BATCH_MIN_INTERVAL_MS;
    }

    const body: IncrementalBatch = {
      v: NAVDATA_WIRE_VERSION,
      schemaVersion: NAVDATA_SCHEMA_VERSION,
      snapshotId,
      fromRev: cursor.ackedRev,
      toRev: batch.toRev,
      rows: batch.rows,
      more: batch.more,
    };

    let outcome: NavdataOutcome;
    try {
      outcome = await this.client.postRows(body);
    } catch (err) {
      outcome = { kind: 'transport', errorName: errorNameOf(err), errorCode: stringCodeOf(err) };
    }

    if (outcome.kind === 'response' && outcome.status >= 200 && outcome.status < 300) {
      // AN ACK FOR ANOTHER EPOCH IS NOT AN ACK FOR OURS. Taking it would move
      // the cursor over rows a different replica applied, and the rows we sent
      // would never be sent again — the silent divergence the epoch exists to
      // prevent, arriving as a 200.
      const epoch = ackSnapshotId(outcome.body);
      if (epoch !== snapshotId) {
        this.fail('the server acknowledged a navdata batch under a different epoch');
        return nextSyncDelayMs(this.failures);
      }
      const acked = ackRev(outcome.body);
      if (acked === null || acked < cursor.ackedRev || acked > batch.toRev) {
        // An acknowledgement that does not say what was applied cannot advance
        // the cursor: the rows are resent rather than assumed delivered.
        this.fail('the server acknowledged a navdata batch without a usable rev');
        return nextSyncDelayMs(this.failures);
      }
      this.succeed(store, serverUrl, { ackedRev: acked, state: 'incremental' });
      this.bounds = { maxRows: NAVDATA_BATCH_MAX_ROWS, maxBytes: NAVDATA_BATCH_MAX_BYTES };
      this.deps.onChange();
      return NAVDATA_BATCH_MIN_INTERVAL_MS;
    }

    if (outcome.kind === 'response' && outcome.code === 'NAVDATA_TOO_LARGE') {
      return this.handleTooLarge(store, serverUrl, batch);
    }

    return this.handleFailure(store, serverUrl, outcome, 'rows');
  }

  /**
   * Halves the batch for this cursor and tries again.
   *
   * A batch that is ALL ONE REV cannot be halved: a batch boundary is a
   * transaction boundary, and cutting inside one would acknowledge rows that
   * were never sent. So that batch is skipped instead — named at `warn`, the
   * cursor stepped past it, and the rows carried again by the next snapshot —
   * because the alternative is a stream that never moves again behind rows no
   * server will take.
   */
  private handleTooLarge(store: NavdataStore, serverUrl: string, batch: BuiltBatch): number {
    const oneRev = batch.rows.every((row) => Number(row.r.rev) === batch.toRev);
    if (oneRev) {
      this.log(
        'warn',
        `navdata: the server refused ${batch.rows.length} row(s) at rev ${batch.toRev} as too large; skipping them`,
      );
      this.lastSyncError = `the server refused rev ${batch.toRev} as too large`;
      this.guardStore(() => {
        const at = this.now();
        writeCursor(
          store,
          serverUrl,
          { ackedRev: batch.toRev, state: 'incremental', lastErrorAt: at, lastErrorCode: 'NAVDATA_TOO_LARGE' },
          at,
        );
        this.ackedRev = batch.toRev;
      });
      this.deps.onChange();
      return NAVDATA_BATCH_MIN_INTERVAL_MS;
    }
    this.bounds = {
      // Halved against what was actually refused, not against the configured
      // cap: the cap may be far above the batch the server just turned down.
      maxRows: Math.max(1, Math.floor(batch.rows.length / 2)),
      maxBytes: Math.max(1024, Math.floor(batch.bytes / 2)),
    };
    this.logOnce(`navdata: the server refused a batch as too large; halving to ${this.bounds.maxRows} rows`);
    return NAVDATA_BATCH_MIN_INTERVAL_MS;
  }

  // ── outcomes ────────────────────────────────────────────────────────────────

  private handleFailure(
    store: NavdataStore,
    serverUrl: string,
    outcome: NavdataOutcome,
    what: 'snapshot' | 'rows',
  ): number {
    if (outcome.kind === 'response' && outcome.code === 'NAVDATA_BUSY') {
      // Not a failure. The server is mid-swap and says when to come back.
      const wait = outcome.retryAfterMs ?? NAVDATA_BUSY_DEFAULT_MS;
      this.nextAllowedAt = this.now() + wait;
      this.log('debug', `navdata: the server is importing a snapshot; retrying in ${wait} ms`);
      return wait;
    }

    if (outcome.kind === 'response' && outcome.code === 'NAVDATA_SCHEMA_UNSUPPORTED') {
      const theirs = serverSchemaVersion(outcome.body);
      this.latched =
        `navdata sync is off: the server speaks navdata schema version ${theirs ?? 'unknown'} ` +
        `and this build speaks ${NAVDATA_SCHEMA_VERSION}`;
      this.lastSyncError = this.latched;
      this.log('error', `navdata: ${this.latched}`);
      this.recordError(store, serverUrl, outcome.code, 'failed');
      this.cancelTimer();
      this.deps.onChange();
      return NAVDATA_SYNC_BACKOFF_MAX_MS;
    }

    if (outcome.kind === 'response' && outcome.code === 'NAVDATA_SNAPSHOT_MISMATCH') {
      // THE resync signal. The epoch is not re-minted: this store's current
      // one is exported again, which needs no simulator.
      this.fail('the server holds a different navdata epoch; re-sending the snapshot');
      writeCursor(
        store,
        serverUrl,
        {
          state: 'resync-required',
          ackedRev: 0,
          lastErrorAt: this.now(),
          lastErrorCode: outcome.code,
        },
        this.now(),
      );
      this.ackedRev = 0;
      this.deps.onChange();
      return 0;
    }

    if (outcome.kind === 'response' && outcome.code === 'NAVDATA_BAD_BATCH') {
      // A repeat is a client bug and stays visible; nothing is advanced.
      this.fail(`the server rejected the navdata ${what} as malformed`);
      this.recordError(store, serverUrl, outcome.code);
      return nextSyncDelayMs(this.failures);
    }

    if (outcome.kind === 'response') {
      this.fail(`the navdata ${what} was refused (HTTP ${outcome.status})`);
      this.recordError(store, serverUrl, `HTTP_${outcome.status}`);
      return nextSyncDelayMs(this.failures);
    }

    this.fail(`the navdata ${what} could not reach the server (${describeOutcome(outcome)})`);
    this.recordError(store, serverUrl, outcome.errorCode ?? outcome.errorName ?? 'TRANSPORT');
    return nextSyncDelayMs(this.failures);
  }

  private succeed(store: NavdataStore, serverUrl: string, patch: SyncCursorPatch): void {
    const at = this.now();
    this.failures = 0;
    this.nextAllowedAt = 0;
    this.lastSyncAt = at;
    this.lastSyncError = null;
    this.loggedError = null;
    this.guardStore(() => {
      writeCursor(store, serverUrl, { ...patch, lastOkAt: at }, at);
      const cursor = readCursor(store, serverUrl);
      if (cursor !== null) this.publishCursor(cursor);
    });
  }

  private recordError(
    store: NavdataStore,
    serverUrl: string,
    code: string,
    state?: SyncState,
  ): void {
    const at = this.now();
    this.guardStore(() => {
      writeCursor(
        store,
        serverUrl,
        { lastErrorAt: at, lastErrorCode: code, ...(state === undefined ? {} : { state }) },
        at,
      );
    });
  }

  private setCursorState(store: NavdataStore, serverUrl: string, state: SyncState): void {
    this.guardStore(() => writeCursor(store, serverUrl, { state }, this.now()));
  }

  private guardStore(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // A cursor that will not write costs a re-send, not the process.
      this.log('debug', `navdata: the sync cursor could not be written (${describe(err)})`);
    }
  }

  private publishCursor(cursor: SyncCursor): void {
    this.ackedRev = cursor.ackedRev;
  }

  private fail(reason: string): void {
    this.failures++;
    this.lastSyncError = reason;
    this.logOnce(`navdata: ${reason}`);
    this.deps.onChange();
  }

  /** The same failure every two seconds is one line, not a log full of them. */
  private logOnce(message: string): void {
    if (this.loggedError === message) return;
    this.loggedError = message;
    this.log('warn', message);
  }
}

/** The epoch the server says it applied the rows to, or null if it named none. */
function ackSnapshotId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const snapshotId = (body as { snapshotId?: unknown }).snapshotId;
  return typeof snapshotId === 'string' && snapshotId.length > 0 ? snapshotId : null;
}

function ackRev(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const rev = (body as { rev?: unknown }).rev;
  return typeof rev === 'number' && Number.isFinite(rev) ? rev : null;
}

function ackCounts(body: unknown): NavRowCounts | null {
  if (typeof body !== 'object' || body === null) return null;
  const counts = (body as { counts?: unknown }).counts;
  if (typeof counts !== 'object' || counts === null) return null;
  const out: NavRowCounts = {};
  for (const { type } of SNAPSHOT_TABLE_ORDER) {
    const value = (counts as Record<string, unknown>)[type];
    if (typeof value === 'number' && Number.isFinite(value)) out[type] = value;
  }
  return out;
}

function serverSchemaVersion(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const version = (body as { serverSchemaVersion?: unknown }).serverSchemaVersion;
  return typeof version === 'number' && Number.isFinite(version) ? version : null;
}

/** Never the server's own text: only what this side observed. */
function describeOutcome(outcome: NavdataOutcome): string {
  if (outcome.kind === 'response') return `HTTP ${outcome.status}`;
  return outcome.errorCode ?? outcome.errorName ?? 'unknown';
}

/**
 * One line, no stack, no file path: this text reaches the status axis and the
 * CDU scratchpad. Filesystem and SQLite errors quote the file they were about,
 * which on this axis says nothing useful and puts a user's directory layout on
 * a screen — and one path along is the config file's own.
 */
function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return withoutPaths(text.split('\n')[0]).slice(0, 200);
}

/** Replaces anything that looks like an absolute path with a placeholder. */
function withoutPaths(text: string): string {
  return text
    .split(' ')
    .map((word) => (looksLikePath(word) ? '<path>' : word))
    .join(' ');
}

function looksLikePath(word: string): boolean {
  const bare = word.replace(/["'(),;]/g, '');
  // A drive letter, or a UNC share: this runs on Windows, and a leading slash
  // is far more likely to be one of our own route paths than a file.
  return DRIVE_PATH.test(bare) || bare.startsWith(UNC_PREFIX);
}

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = '\\\\';
