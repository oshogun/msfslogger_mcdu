// ── Navdata snapshot export ───────────────────────────────────────────────────
//
// Turns the whole local store into one gzipped NDJSON file: a header line, then
// every row tagged with the table it came from, then a footer whose counts must
// equal the header's. That file is what resets the server's replica wholesale,
// so the two rules below are what the rest of the module is shaped around.
//
// A CONSISTENT VIEW. The header carries the rev the export was taken at, and
// the server resumes incrementals from it. If a facility write landed halfway
// through the read, the file would carry rows above that rev while claiming to
// be complete at it, and those rows would then never be re-sent. So every read
// — the meta row, the per-table counts and the rows themselves — happens inside
// one deferred read transaction on a connection of its own. In WAL mode that
// reader sees a fixed snapshot of the database while the store keeps writing.
//
// A READ THAT CANNOT WRITE. That second connection is opened with
// `query_only`, and read-only as well when the caller asks for it, because it
// is pointed at the same file the live store is using. The export is a copy;
// nothing about it may modify the original.
//
// The event loop is not held. 41 871 airport rows are read and written in
// chunks with a yield between them, for the same reason every navdata write is
// chunked: better-sqlite3 is synchronous and the 1 Hz frame loop shares this
// thread.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { once } from 'events';
import { pipeline } from 'stream/promises';

import type { SimId } from './config';
import { cachingDriverLoader, type DriverLoad } from './navdata-store';
import { NAVDATA_SCHEMA_VERSION, type NavdataTable } from './navdata-schema';
import type { LogSink } from './uplink';

/** Envelope version. Separate from the schema version; bumped on a reshape. */
export const NAVDATA_WIRE_VERSION = 1;

/**
 * A guard against a bug, not a working limit: the measured airport index is
 * well under a megabyte compressed, and a snapshot with harvested fixes and
 * fetched airport detail lands in single-digit megabytes.
 */
export const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

/** Rows read and written per macrotask. Matches the store's write chunk. */
export const SNAPSHOT_CHUNK_ROWS = 2000;

/** Every row type the sync stream can carry, in the order a snapshot emits them. */
export type NavRowType =
  | 'airport'
  | 'navaid'
  | 'waypoint'
  | 'airway_leg'
  | 'runway'
  | 'frequency'
  | 'procedure'
  | 'procedure_transition'
  | 'procedure_leg'
  | 'coverage_cell'
  | 'absent';

/**
 * The emission order is part of the contract: a receiver that enforces foreign
 * keys streams the file in this order and never sees a child before its parent.
 * It is also the tie-break for rows sharing a rev in an incremental batch.
 */
export const SNAPSHOT_TABLE_ORDER: readonly { table: NavdataTable; type: NavRowType }[] = [
  { table: 'nav_airport', type: 'airport' },
  { table: 'nav_navaid', type: 'navaid' },
  { table: 'nav_waypoint', type: 'waypoint' },
  { table: 'nav_airway_leg', type: 'airway_leg' },
  { table: 'nav_runway', type: 'runway' },
  { table: 'nav_airport_frequency', type: 'frequency' },
  { table: 'nav_procedure', type: 'procedure' },
  { table: 'nav_procedure_transition', type: 'procedure_transition' },
  { table: 'nav_procedure_leg', type: 'procedure_leg' },
  { table: 'nav_coverage_cell', type: 'coverage_cell' },
  { table: 'nav_absent', type: 'absent' },
];

/** A row exactly as the database holds it; column names go on the wire unchanged. */
export type NavdataWireRow = Record<string, string | number | null>;

/** A row on the wire is always tagged with the table it belongs to. */
export interface NavdataTaggedRow {
  t: NavRowType;
  r: NavdataWireRow;
}

export type NavRowCounts = Partial<Record<NavRowType, number>>;

export interface SnapshotHeaderLine {
  kind: 'header';
  v: number;
  schemaVersion: number;
  snapshotId: string;
  rev: number;
  simId: SimId;
  simAppName: string | null;
  simAppVersion: string | null;
  sidecarVersion: string;
  createdAt: number;
  /**
   * What the bulk airport index did, copied from the store's metadata. A
   * receiver reads `bulkCompletedAt` to decide whether the airport layer it
   * has just been handed is the whole world or part of one — it cannot work
   * that out from the rows, and guessing from a row count would be a rule
   * nobody agreed.
   *
   * `null` means the pass has not finished. That is NOT the same as the key
   * being absent, which is what a sender older than these fields writes and
   * which says nothing either way; the exporter here always emits all three.
   */
  bulkStartedAt: number | null;
  bulkCompletedAt: number | null;
  bulkRowCount: number;
  counts: NavRowCounts;
}

export interface SnapshotFooterLine {
  kind: 'footer';
  rows: number;
  counts: NavRowCounts;
}

export interface NavdataReaderMeta {
  schemaVersion: number;
  snapshotId: string;
  rev: number;
  simId: SimId;
  simAppName: string | null;
  simAppVersion: string | null;
  bulkStartedAt: number | null;
  bulkCompletedAt: number | null;
  bulkRowCount: number;
}

/**
 * Bulk reads the store itself does not offer. The store's API is keyed
 * single-row access by design; an export and an incremental batch both need to
 * walk tables, and they do it through their own connection so that a long read
 * never sits inside the writer's.
 */
export interface NavdataReader {
  meta(): NavdataReaderMeta | null;
  count(table: NavdataTable): number;
  /** Rows in primary-key order. */
  page(table: NavdataTable, limit: number, offset: number): NavdataWireRow[];
  /** Rows with `rev` above `since`, lowest rev first, at most `limit` of them. */
  since(table: NavdataTable, since: number, limit: number): NavdataWireRow[];
  /** Every row at exactly this rev. */
  atRev(table: NavdataTable, rev: number): NavdataWireRow[];
  /** One consistent view across several reads. */
  begin(): void;
  end(): void;
  close(): void;
}

export interface NavdataReaderOptions {
  readonly loadDriver?: () => DriverLoad;
  /**
   * Opens the file read-only as well as query-only. SQLite needs the shared
   * memory file to already exist for that, which is true exactly when another
   * connection has the database open — so it is offered rather than assumed.
   */
  readonly readonly?: boolean;
}

interface ReaderStatement {
  get(...params: readonly (string | number | null)[]): Record<string, unknown> | undefined;
  all(...params: readonly (string | number | null)[]): Array<Record<string, unknown>>;
}

interface ReaderDatabase {
  prepare(sql: string): ReaderStatement;
  exec(sql: string): unknown;
  pragma(source: string): unknown;
  close(): void;
}

type ReaderDriver = new (file: string, options?: { readonly?: boolean }) => ReaderDatabase;

const loadReaderDriver = cachingDriverLoader(() => require('better-sqlite3'));

/**
 * Opens a second connection for reading. Throws — unlike the store's own open,
 * which fails soft because it decides whether navdata exists at all. By the
 * time this is reached the store is already open, so a failure here is one
 * export that did not happen and the caller reports it on the navdata axis.
 */
export function openNavdataReader(dbPath: string, options: NavdataReaderOptions = {}): NavdataReader {
  if (!fs.existsSync(dbPath)) throw new Error('navdata: there is no store to export');
  const loaded = (options.loadDriver ?? loadReaderDriver)();
  if (!loaded.ok) throw new Error(loaded.failure.reason);

  const driver = loaded.driver as unknown as ReaderDriver;
  const db = options.readonly ? new driver(dbPath, { readonly: true }) : new driver(dbPath);
  try {
    // The live store owns this file. Nothing read through here may change it.
    db.pragma('query_only = true');
    db.pragma('busy_timeout = 5000');
  } catch (err) {
    db.close();
    throw err;
  }

  const keys = new Map<NavdataTable, string[]>();
  const primaryKey = (table: NavdataTable): string[] => {
    let columns = keys.get(table);
    if (!columns) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>;
      columns = info
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => column.name);
      keys.set(table, columns);
    }
    return columns;
  };

  const cache = new Map<string, ReaderStatement>();
  const statement = (sql: string): ReaderStatement => {
    let prepared = cache.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      cache.set(sql, prepared);
    }
    return prepared;
  };

  let open = true;
  let inView = false;

  const endView = (): void => {
    if (!inView) return;
    inView = false;
    try {
      db.exec('COMMIT');
    } catch {
      // A read transaction has nothing to lose by failing to close; the
      // connection is about to go away with it.
    }
  };

  return {
    meta(): NavdataReaderMeta | null {
      const row = statement('SELECT * FROM nav_meta WHERE id = 1').get();
      if (!row) return null;
      return {
        schemaVersion: Number(row.schema_version),
        snapshotId: String(row.snapshot_id),
        rev: Number(row.rev),
        simId: String(row.sim_id) as SimId,
        simAppName: row.sim_app_name === null ? null : String(row.sim_app_name),
        simAppVersion: row.sim_app_version === null ? null : String(row.sim_app_version),
        bulkStartedAt: row.bulk_started_at === null ? null : Number(row.bulk_started_at),
        bulkCompletedAt: row.bulk_completed_at === null ? null : Number(row.bulk_completed_at),
        bulkRowCount: Number(row.bulk_row_count ?? 0),
      };
    },

    count(table: NavdataTable): number {
      return Number(statement(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
    },

    page(table: NavdataTable, limit: number, offset: number): NavdataWireRow[] {
      const order = primaryKey(table).join(', ');
      return statement(
        `SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ).all(limit, offset) as NavdataWireRow[];
    },

    since(table: NavdataTable, since: number, limit: number): NavdataWireRow[] {
      const order = ['rev', ...primaryKey(table)].join(', ');
      return statement(
        `SELECT * FROM ${table} WHERE rev > ? ORDER BY ${order} LIMIT ?`,
      ).all(since, limit) as NavdataWireRow[];
    },

    atRev(table: NavdataTable, rev: number): NavdataWireRow[] {
      const order = primaryKey(table).join(', ');
      return statement(`SELECT * FROM ${table} WHERE rev = ? ORDER BY ${order}`).all(
        rev,
      ) as NavdataWireRow[];
    },

    begin(): void {
      if (inView) return;
      db.exec('BEGIN DEFERRED');
      inView = true;
    },

    end(): void {
      endView();
    },

    close(): void {
      if (!open) return;
      open = false;
      endView();
      db.close();
    },
  };
}

export interface SnapshotExportOptions {
  /** Where the file is written: the store's own directory. */
  directory: string;
  sidecarVersion: string;
  maxBytes?: number;
  chunkRows?: number;
  now?: () => number;
  log?: LogSink;
  /** Yields to the event loop between chunks; a test can make it synchronous. */
  yieldToLoop?: () => Promise<void>;
}

export interface SnapshotExportResult {
  /** The finished file, renamed into place. */
  path: string;
  /** The name the upload gives the part; not the name on disk. */
  fileName: string;
  snapshotId: string;
  rev: number;
  rows: number;
  counts: NavRowCounts;
  bytes: number;
  durationMs: number;
}

/** `<epoch-ms>-<hex>` in practice, but the id is opaque and this is a file name. */
function safeName(snapshotId: string): string {
  const cleaned = snapshotId.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length === 0 ? 'unnamed' : cleaned.slice(0, 80);
}

export function snapshotFileName(snapshotId: string): string {
  return `navdata-${safeName(snapshotId)}.ndjson.gz`;
}

export function snapshotPath(directory: string, snapshotId: string): string {
  return path.join(directory, `snapshot-${safeName(snapshotId)}.ndjson.gz`);
}

const SNAPSHOT_FILE_PATTERN = /^snapshot-[A-Za-z0-9._-]+\.ndjson\.gz(\.tmp)?$/;

/**
 * Removes snapshot files left by earlier exports. A failed upload keeps its
 * file — it is the evidence of what was sent — so without this the directory
 * would collect one per epoch for ever. Only files this module writes are
 * matched; the store itself is never a candidate.
 */
export function removeStaleSnapshots(directory: string, keep?: string): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!SNAPSHOT_FILE_PATTERN.test(entry)) continue;
    const full = path.join(directory, entry);
    if (keep !== undefined && (full === keep || full === `${keep}.tmp`)) continue;
    try {
      fs.rmSync(full, { force: true });
      removed++;
    } catch {
      // A file that will not delete is litter, not a failure: the export it
      // belongs to is long finished.
    }
  }
  return removed;
}

async function defaultYield(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Writes the whole store to `snapshot-<id>.ndjson.gz.tmp` and renames it into
 * place. Rejects — and leaves no partial file — on any failure, including the
 * size guard.
 */
export async function exportSnapshot(
  reader: NavdataReader,
  options: SnapshotExportOptions,
): Promise<SnapshotExportResult> {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
  const chunkRows = Math.max(1, options.chunkRows ?? SNAPSHOT_CHUNK_ROWS);
  const yieldToLoop = options.yieldToLoop ?? defaultYield;
  const startedAt = now();

  reader.begin();
  try {
    const meta = reader.meta();
    if (meta === null) throw new Error('navdata: the store has no metadata row');

    const counts: NavRowCounts = {};
    for (const { table, type } of SNAPSHOT_TABLE_ORDER) {
      const rows = reader.count(table);
      if (rows > 0) counts[type] = rows;
    }

    const target = snapshotPath(options.directory, meta.snapshotId);
    const temporary = `${target}.tmp`;
    fs.mkdirSync(options.directory, { recursive: true });
    fs.rmSync(temporary, { force: true });

    const file = fs.createWriteStream(temporary);
    const gzip = zlib.createGzip({ level: 6 });
    const finished = pipeline(gzip, file);
    // A rejected pipeline with no other listener is an unhandled rejection
    // until it is awaited at the end; this keeps it handled from the start.
    finished.catch(() => undefined);

    const written: NavRowCounts = {};
    let rows = 0;

    const write = async (lines: string): Promise<void> => {
      if (!gzip.write(lines)) await once(gzip, 'drain');
      if (file.bytesWritten > maxBytes) {
        throw new Error(
          `navdata: the snapshot passed ${maxBytes} bytes compressed and was abandoned`,
        );
      }
    };

    try {
      const header: SnapshotHeaderLine = {
        kind: 'header',
        v: NAVDATA_WIRE_VERSION,
        schemaVersion: meta.schemaVersion,
        snapshotId: meta.snapshotId,
        rev: meta.rev,
        simId: meta.simId,
        simAppName: meta.simAppName,
        simAppVersion: meta.simAppVersion,
        sidecarVersion: options.sidecarVersion,
        createdAt: now(),
        // Read in the same transaction as the rev and the counts, so the whole
        // header describes one view of the store.
        bulkStartedAt: meta.bulkStartedAt,
        bulkCompletedAt: meta.bulkCompletedAt,
        bulkRowCount: meta.bulkRowCount,
        counts,
      };
      await write(`${JSON.stringify(header)}\n`);

      for (const { table, type } of SNAPSHOT_TABLE_ORDER) {
        const total = counts[type] ?? 0;
        if (total === 0) continue;
        let emitted = 0;
        for (let offset = 0; ; offset += chunkRows) {
          const chunk = reader.page(table, chunkRows, offset);
          if (chunk.length === 0) break;
          const lines: string[] = [];
          for (const row of chunk) lines.push(JSON.stringify({ t: type, r: row }));
          await write(`${lines.join('\n')}\n`);
          emitted += chunk.length;
          rows += chunk.length;
          // One chunk per macrotask: the frame handler runs between them.
          await yieldToLoop();
        }
        written[type] = emitted;
      }

      // The counts were taken inside the same read transaction as the rows, so
      // a difference is a defect in this module rather than a race.
      for (const { type } of SNAPSHOT_TABLE_ORDER) {
        if ((counts[type] ?? 0) !== (written[type] ?? 0)) {
          throw new Error(
            `navdata: the snapshot promised ${counts[type] ?? 0} ${type} rows and wrote ${written[type] ?? 0}`,
          );
        }
      }

      const footer: SnapshotFooterLine = { kind: 'footer', rows, counts: written };
      await write(`${JSON.stringify(footer)}\n`);
      gzip.end();
      await finished;
    } catch (err) {
      gzip.destroy();
      file.destroy();
      try {
        await finished;
      } catch {
        // The failure that got us here is the one worth reporting.
      }
      fs.rmSync(temporary, { force: true });
      throw err;
    }

    const bytes = file.bytesWritten;
    fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
    removeStaleSnapshots(options.directory, target);

    return {
      path: target,
      fileName: snapshotFileName(meta.snapshotId),
      snapshotId: meta.snapshotId,
      rev: meta.rev,
      rows,
      counts: written,
      bytes,
      durationMs: now() - startedAt,
    };
  } finally {
    reader.end();
  }
}

/** The schema version every payload this build sends is stamped with. */
export const NAVDATA_WIRE_SCHEMA_VERSION = NAVDATA_SCHEMA_VERSION;
