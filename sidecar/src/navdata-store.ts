// ── Navdata store: opening, the rev discipline, and all the SQL ───────────────
//
// The navdata cache is a SQLite database beside the config file, in its own
// `navdata` subdirectory — never the config file's own directory, and never
// anywhere a test can reach the user's copy, because the location is derived
// from whichever config path the process was started with.
//
// FAIL-SOFT IS THE POINT OF THIS MODULE'S SHAPE. better-sqlite3 is a native
// addon bound to a Node ABI, and the sidecar is launched with whatever `node`
// the shell resolves, so a driver that will not load is a real Tuesday. The
// shell restarts a dying sidecar five times in a rolling minute and then
// latches a crash that needs a manual restart, so a sidecar that throws during
// module load would take frames, datalink and traffic down with navdata. Two
// consequences, both load-bearing:
//
//   * the `require` is lazy and lives inside a function. A top-level
//     `import Database from 'better-sqlite3'` compiles to a require in the
//     module body, which throws while this module is being loaded — before any
//     try/catch in a caller can run, and before the sidecar says hello.
//   * `openNavdataStore` returns null for every failure and never throws:
//     driver missing, ABI mismatch, unwritable directory, corrupt file. The
//     caller reports it once and does nothing else with navdata.
//
// WRITES. Every write goes through `write()`, which is one transaction and one
// rev. The rev is bumped once per transaction, not once per row, so the sync
// cursor stays a plain `rev >` comparison and a batch boundary means something.
// A transaction that changed no row does not bump it at all: a harvest that
// re-sees the same ten thousand rows must ship nothing, or the incremental
// stream never drains. Each upsert reads the stored row, merges it in code and
// writes only when the result differs.
//
// WAL. The database is in WAL mode, so the file on disk is not the database:
// anything that copies the file must checkpoint first, or it ships a stale
// epoch and replays an old write-ahead log over a newer one.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { SimId } from './config';
import type { LogSink } from './uplink';
import {
  mergeRow,
  REV_COLUMN,
  type MergeSpec,
  type NavdataInput,
  type NavdataValue,
  type PositionRule,
} from './navdata-keys';
import {
  NAVDATA_SCHEMA_SQL,
  NAVDATA_SCHEMA_VERSION,
  NAVDATA_TABLE_COLUMNS,
  NAVDATA_TABLES,
  type NavdataColumn,
  type NavdataTable,
} from './navdata-schema';

/** The directory name that holds the store, beside the config file. */
const NAVDATA_DIR_NAME = 'navdata';
const NAVDATA_FILE_NAME = 'navdata.db';

/** Codes that mean the file is not a database this build can read. */
const CORRUPT_CODES = ['SQLITE_CORRUPT', 'SQLITE_NOTADB'];

/** The tables whose detail fetch a dead process can leave marked as running. */
const PENDING_DETAIL_TABLES = ['nav_airport', 'nav_navaid'] as const;

/** A row as it comes back from SQLite. */
export type NavdataRow<T extends NavdataTable> = Record<NavdataColumn<T>, NavdataValue>;

/** A row as a caller supplies it: keys required, everything else optional. */
export type NavdataRowInput<T extends NavdataTable> = Partial<
  Record<NavdataColumn<T>, NavdataInput>
>;

/** Why navdata is off. Safe to log and to show: it carries no credential. */
export interface NavdataUnavailable {
  /** The driver's or the filesystem's own code, or 'NAVDATA_SCHEMA_MISMATCH'. */
  readonly code: string;
  /** One line, already phrased for a status axis. */
  readonly reason: string;
}

export interface NavdataMeta {
  readonly schemaVersion: number;
  readonly snapshotId: string;
  readonly rev: number;
  readonly simId: SimId;
  readonly simAppName: string | null;
  readonly simAppVersion: string | null;
  readonly bulkStartedAt: number | null;
  readonly bulkCompletedAt: number | null;
  readonly bulkRowCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a caller may change about the one meta row, outside the epoch itself. */
export interface NavdataMetaPatch {
  readonly simId?: SimId;
  readonly simAppName?: string | null;
  readonly simAppVersion?: string | null;
  readonly bulkStartedAt?: number | null;
  readonly bulkCompletedAt?: number | null;
  readonly bulkRowCount?: number;
}

/** Facility kinds a coverage cell can be stamped for. */
export type CoverageKind = 'V' | 'N' | 'W';

/** Facility kinds an absence can be recorded for; 'A' is an airport. */
export type AbsentKind = 'A' | 'V' | 'N' | 'W';

export interface AbsentEntry {
  readonly kind: AbsentKind;
  readonly ident: string;
  readonly region?: string;
  /** 'silent' is a timeout with no message at all; 'exception' is the
   *  simulator refusing. The second is stronger evidence and re-checkable. */
  readonly reason: 'silent' | 'exception';
  readonly at: number;
}

/** The handle a write transaction hands to its body. */
export interface NavdataTx {
  /** The rev every row written in this transaction carries. */
  readonly rev: number;
  /** Reads the stored row, merges, writes only if something changed. */
  upsert<T extends NavdataTable>(table: T, row: NavdataRowInput<T>): boolean;
  /** Reads a row inside the transaction, so a caller can see its own writes. */
  row<T extends NavdataTable>(table: T, key: NavdataRowInput<T>): NavdataRow<T> | null;
  /**
   * Stamps a cell as harvested for a kind. `rowCount` may be 0 and that is a
   * real answer: "harvested, nothing here" is not "never looked".
   */
  recordCoverage(kind: CoverageKind, cellId: number, harvestedAt: number, rowCount: number): void;
  /**
   * Records that the simulator does not have a facility. `first_seen_at` only
   * ever moves backwards — the oldest evidence of absence is the one worth
   * keeping — while `last_checked_at` and `attempts` follow each re-check.
   */
  recordAbsent(entry: AbsentEntry): void;
  /** Updates the meta row. Ships nothing, so it does not bump the rev. */
  updateMeta(patch: NavdataMetaPatch): void;
  /**
   * Mints a new epoch and returns its id. Everything the server holds is
   * invalidated wholesale, so this is for a bulk pass that has to make the
   * replica lose rows. Absences are wiped with it: absence is a claim about
   * one install at one AIRAC, not a permanent fact. The rev is deliberately
   * not reset — rows written after a mint must not sort below rows written
   * before it, and comparing revs across epochs is undefined anyway.
   */
  mintEpoch(): string;
}

export interface NavdataStore {
  /** The database file, WAL sidecars aside. */
  readonly path: string;
  meta(): NavdataMeta;
  row<T extends NavdataTable>(table: T, key: NavdataRowInput<T>): NavdataRow<T> | null;
  count(table: NavdataTable): number;
  /** One transaction, one rev. Rolls back and rethrows if the body throws. */
  write<T>(fn: (tx: NavdataTx) => T): T;
  /**
   * Clears every detail fetch the store still believes is in flight, and
   * returns how many rows that was. 'pending' means a request is out with the
   * simulator right now, which cannot be true of a store that has just been
   * opened: the process that made the request is gone. Left alone the row
   * would look busy for ever and never be re-fetched.
   */
  resetPendingDetail(): number;
  /** Folds the write-ahead log back into the file. Any copy of the file needs
   *  this first, or it captures a database older than the store. */
  checkpoint(): void;
  close(): void;
}

export interface NavdataOpenOptions {
  /**
   * Loads the SQLite driver. Defaults to the lazy require of better-sqlite3;
   * a test supplies its own to exercise a driver that will not load without
   * breaking the installed one.
   */
  readonly loadDriver?: () => DriverLoad;
  /** Called once, and only when the store could not be opened. */
  readonly onUnavailable?: (failure: NavdataUnavailable) => void;
  /** Called at most once during the open, when a file had to be moved aside. */
  readonly log?: LogSink;
  /** Written into a freshly created meta row; the configured simulator. */
  readonly simId?: SimId;
  readonly now?: () => number;
}

// ── The driver, loaded lazily and at most once ────────────────────────────────

interface SqliteStatement {
  get(...params: readonly NavdataValue[]): Record<string, NavdataValue> | undefined;
  all(...params: readonly NavdataValue[]): Array<Record<string, NavdataValue>>;
  run(...params: readonly NavdataValue[]): unknown;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  pragma(source: string): unknown;
  close(): void;
}

type SqliteDriver = new (file: string) => SqliteDatabase;

export type DriverLoad =
  | { readonly ok: true; readonly driver: SqliteDriver }
  | { readonly ok: false; readonly failure: NavdataUnavailable };

function describeLoadFailure(err: unknown): NavdataUnavailable {
  const code = errorCode(err) ?? 'UNKNOWN';
  return {
    code,
    reason: `navdata disabled: the SQLite driver did not load (${code})`,
  };
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Wraps a loader so the answer — success or failure — is remembered. A native
 * addon that failed to load is not going to start working later in the same
 * process, and retrying it would re-log the same line on every open.
 */
export function cachingDriverLoader(load: () => unknown): () => DriverLoad {
  let cached: DriverLoad | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = { ok: true, driver: load() as SqliteDriver };
    } catch (err) {
      cached = { ok: false, failure: describeLoadFailure(err) };
    }
    return cached;
  };
}

/**
 * The lazy require. It must stay inside a function body: at module scope it
 * would throw while this module loads, which is exactly the failure the whole
 * fail-soft seam exists to avoid.
 */
const loadSqliteDriver = cachingDriverLoader(() => require('better-sqlite3'));

// ── Where the store lives ─────────────────────────────────────────────────────

/** The navdata directory beside a config file — never the config's own dir. */
export function navdataDirectory(configPath: string): string {
  return path.join(path.dirname(configPath), NAVDATA_DIR_NAME);
}

/** The store's path for a given config path, real or temporary. */
export function navdataDatabasePath(configPath: string): string {
  return path.join(navdataDirectory(configPath), NAVDATA_FILE_NAME);
}

// ── Table specifications, derived from the schema the database really has ─────

interface TableSpec {
  readonly name: NavdataTable;
  readonly columns: readonly string[];
  readonly keys: readonly string[];
  readonly merge: MergeSpec;
  readonly select: SqliteStatement;
  readonly upsert: SqliteStatement;
}

const POSITION_RULES: Partial<Record<NavdataTable, PositionRule>> = {
  nav_airport: { sourceColumn: 'position_source', columns: ['lat', 'lon', 'alt_m'] },
  nav_navaid: {
    sourceColumn: 'position_source',
    columns: ['lat', 'lon', 'alt_m', 'position_fetched_at'],
  },
  nav_waypoint: { sourceColumn: 'position_source', columns: ['lat', 'lon', 'alt_m'] },
};

/** A column default as the DDL wrote it: `0`, `''`, `'index'`. */
function parseDefault(raw: unknown): NavdataValue | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return undefined;
}

interface ColumnInfo {
  readonly name: string;
  readonly notnull: number;
  readonly dflt_value: unknown;
  readonly pk: number;
}

function tableInfo(db: SqliteDatabase, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
}

/**
 * The embedded DDL and the database that came out of it must describe the same
 * thing. This is the tripwire for a botched paste of a schema that is
 * maintained by hand in two repositories: it fails at open, loudly, instead of
 * at the first batch that quietly stops carrying a column.
 */
function verifySchema(db: SqliteDatabase): string | null {
  for (const table of NAVDATA_TABLES) {
    const actual = tableInfo(db, table).map((c) => c.name);
    if (actual.length === 0) return `table ${table} is missing`;
    const expected = NAVDATA_TABLE_COLUMNS[table] as readonly string[];
    if (actual.length !== expected.length || actual.some((c, i) => c !== expected[i])) {
      return `table ${table} has columns [${actual.join(',')}], expected [${expected.join(',')}]`;
    }
  }
  return null;
}

function buildTableSpec(db: SqliteDatabase, table: NavdataTable): TableSpec {
  const info = tableInfo(db, table);
  const columns = info.map((c) => c.name);
  const keys = info
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

  const defaults: Record<string, NavdataValue> = {};
  for (const column of info) {
    if (column.notnull !== 1) continue;
    const value = parseDefault(column.dflt_value);
    if (value !== undefined) defaults[column.name] = value;
  }

  const assignable = columns.filter((c) => !keys.includes(c));
  const select = db.prepare(
    `SELECT * FROM ${table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`,
  );
  // An upsert, not an INSERT OR REPLACE: REPLACE deletes the conflicting row
  // first, which fires ON DELETE CASCADE and would take an airport's runways
  // and procedures with it every time the airport row was touched. The merge
  // itself already happened in code, so the SET list is a plain assignment of
  // the merged row and never a column-wise COALESCE.
  const upsert = db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')})` +
      ` VALUES (${columns.map(() => '?').join(', ')})` +
      ` ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ` +
      assignable.map((c) => `${c} = excluded.${c}`).join(', '),
  );

  return {
    name: table,
    columns,
    keys,
    merge: { columns, defaults, position: POSITION_RULES[table] },
    select,
    upsert,
  };
}

// ── Opening ───────────────────────────────────────────────────────────────────

function readMeta(db: SqliteDatabase): NavdataMeta | null {
  const row = db.prepare('SELECT * FROM nav_meta WHERE id = 1').get();
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
    bulkRowCount: Number(row.bulk_row_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** `<epoch-ms>-<8 hex>`. Opaque to everyone: compared for equality, never parsed. */
function mintSnapshotId(now: number): string {
  return `${now}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Opens the store, creating and migrating nothing it does not have to. Returns
 * null for every failure — a missing driver, an ABI mismatch, an unwritable
 * directory, a corrupt file, a schema this build does not understand — and
 * never throws at its caller. `onUnavailable` gets the reason exactly once.
 */
export function openNavdataStore(
  dbPath: string,
  options: NavdataOpenOptions = {},
): NavdataStore | null {
  const now = options.now ?? Date.now;
  const fail = (failure: NavdataUnavailable): null => {
    options.onUnavailable?.(failure);
    return null;
  };

  const loaded = (options.loadDriver ?? loadSqliteDriver)();
  if (!loaded.ok) return fail(loaded.failure);

  const directory = path.dirname(dbPath);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (err) {
    const code = errorCode(err) ?? 'UNKNOWN';
    return fail({
      code,
      reason: `navdata disabled: ${directory} could not be created (${code})`,
    });
  }

  let db: SqliteDatabase;
  try {
    db = openDatabase(loaded.driver, dbPath, now);
  } catch (err) {
    const code = errorCode(err) ?? 'UNKNOWN';
    return fail({
      code,
      reason: `navdata disabled: the store under ${directory} could not be opened (${code})`,
    });
  }

  const problem = verifySchema(db);
  if (problem !== null) {
    db.close();
    return fail({
      code: 'NAVDATA_SCHEMA_MISMATCH',
      reason: `navdata disabled: the embedded schema does not match the database (${problem})`,
    });
  }

  let meta = readMeta(db);

  /**
   * Replaces the file with a fresh one, keeping the old.
   *
   * Every reason for doing it is the same reason: the local store is a cache
   * of the simulator's own data, rebuilding it costs a fraction of a second,
   * and refusing to open would leave navdata off until someone deleted a file
   * they have no reason to know exists. The old file is never deleted — it is
   * the only copy of whatever was in it — and if it cannot even be moved, the
   * caller's refusal stands and nothing here is touched.
   */
  const rebuildStore = (
    asidePath: string,
    refusal: NavdataUnavailable,
    announce: (movedTo: string) => string,
  ): NavdataUnavailable | null => {
    db.close();
    const movedTo = moveStoreAside(dbPath, asidePath);
    if (movedTo === null) return refusal;
    options.log?.('info', announce(movedTo));
    try {
      db = openDatabase(loaded.driver, dbPath, now);
    } catch (err) {
      const code = errorCode(err) ?? 'UNKNOWN';
      return {
        code,
        reason: `navdata disabled: the store under ${directory} could not be opened (${code})`,
      };
    }
    const replacement = verifySchema(db);
    if (replacement !== null) {
      db.close();
      return {
        code: 'NAVDATA_SCHEMA_MISMATCH',
        reason: `navdata disabled: the embedded schema does not match the database (${replacement})`,
      };
    }
    meta = readMeta(db);
    return null;
  };

  // A version this build does not understand is moved aside rather than
  // refused: refusing would fire for every user on the next version bump and
  // leave navdata off for good. A later build can still migrate out of the
  // file that was kept. This is only true of the local file — two peers
  // disagreeing on the wire still needs a human.
  if (meta !== null && meta.schemaVersion !== NAVDATA_SCHEMA_VERSION) {
    const stored = meta.schemaVersion;
    const failure = rebuildStore(
      `${dbPath}.v${stored}-${now()}`,
      {
        code: 'NAVDATA_SCHEMA_UNSUPPORTED',
        reason:
          `navdata disabled: the store under ${directory} is schema version ` +
          `${stored}, this build speaks ${NAVDATA_SCHEMA_VERSION}, and it could not be moved aside`,
      },
      (movedTo) =>
        `Navdata store is schema version ${stored} and this build speaks ` +
        `${NAVDATA_SCHEMA_VERSION}; moved it to ${movedTo} and started a new one`,
    );
    if (failure !== null) return fail(failure);
  }

  // A store built from a different simulator goes the same way, and is
  // deliberately NOT relabelled: the rows in it are one simulator's own
  // navdata, and 2020 and 2024 do not ship the same database. Rewriting sim_id
  // would leave real rows claiming a provenance they do not have, which is
  // worse than the cost of rebuilding — and the old file is kept, so switching
  // back finds its cache still there.
  if (meta !== null && options.simId !== undefined && meta.simId !== options.simId) {
    const stored = meta.simId;
    const failure = rebuildStore(
      `${dbPath}.sim${stored}-${now()}`,
      {
        code: 'NAVDATA_SIM_MISMATCH',
        reason:
          `navdata disabled: the store under ${directory} was built from simulator ` +
          `${stored}, this session is ${options.simId}, and it could not be moved aside`,
      },
      (movedTo) =>
        `Navdata store was built from simulator ${stored} and this session is ` +
        `${options.simId}; moved it to ${movedTo} and started a new one`,
    );
    if (failure !== null) return fail(failure);
  }

  if (meta === null) {
    const created = now();
    db.prepare(
      'INSERT INTO nav_meta (id, schema_version, snapshot_id, rev, sim_id,' +
        ' bulk_row_count, created_at, updated_at) VALUES (1, ?, ?, 0, ?, 0, ?, ?)',
    ).run(NAVDATA_SCHEMA_VERSION, mintSnapshotId(created), options.simId ?? '2020', created, created);
    meta = readMeta(db);
  }
  if (meta === null) {
    db.close();
    return fail({
      code: 'NAVDATA_NO_META',
      reason: `navdata disabled: the store under ${directory} has no metadata row`,
    });
  }

  return createStore(db, dbPath, now);
}

/**
 * Moves a store out of the way, write-ahead log and all, and returns where it
 * went, or null if it could not be done.
 *
 * Two things have to hold at once, and the order is how they are reconciled.
 *
 * The database moves FIRST. It is the file that matters and the one whose
 * rename is most likely to fail, so failing there leaves everything exactly as
 * it was — including the write-ahead log, which still belongs to the database
 * still sitting beside it and may hold rows that were committed but not yet
 * folded in.
 *
 * The -wal and -shm files follow. Neither may be left at the old path once the
 * database has gone from it: a write-ahead log there belongs to a database that
 * is no longer present, and SQLite would replay what it could of it into the
 * next file created in its place — which is how a clean rebuild quietly comes
 * back holding half of the store it replaced. So each is moved, or failing that
 * deleted, being worthless without its database. If one can be neither moved
 * nor deleted the database is put back where it was, best effort, and null
 * returned; the caller must then leave the path alone rather than open a
 * replacement over a log that could replay into it.
 *
 * The moved file is never deleted. It is the only copy of whatever was in it.
 */
export function moveStoreAside(dbPath: string, targetPath: string): string | null {
  try {
    fs.renameSync(dbPath, targetPath);
  } catch {
    return null;
  }

  for (const suffix of ['-wal', '-shm']) {
    const from = `${dbPath}${suffix}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, `${targetPath}${suffix}`);
    } catch {
      try {
        fs.rmSync(from, { force: true });
      } catch {
        try {
          fs.renameSync(targetPath, dbPath);
        } catch {
          // Nothing further to try. Returning null keeps a replacement from
          // being opened over whatever is left here.
        }
        return null;
      }
    }
  }
  return targetPath;
}

/**
 * Opens the file and applies the schema, retrying once through a rename if the
 * file turns out not to be a database. The bad file is kept for inspection and
 * never goes anywhere near the server.
 */
function openDatabase(driver: SqliteDriver, dbPath: string, now: () => number): SqliteDatabase {
  for (let attempt = 0; ; attempt++) {
    let db: SqliteDatabase | undefined;
    try {
      db = new driver(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      db.exec(NAVDATA_SCHEMA_SQL);
      return db;
    } catch (err) {
      try {
        db?.close();
      } catch {
        // Already gone; the open failure is the interesting one.
      }
      const code = errorCode(err) ?? '';
      if (attempt > 0 || !CORRUPT_CODES.includes(code)) throw err;
      // If it cannot be moved there is nothing to retry: opening a replacement
      // over a file that would not move is how a stale write-ahead log gets
      // replayed into it. The caller reports the original code instead.
      if (moveStoreAside(dbPath, `${dbPath}.corrupt-${now()}`) === null) throw err;
    }
  }
}

// ── The store ─────────────────────────────────────────────────────────────────

function createStore(db: SqliteDatabase, dbPath: string, now: () => number): NavdataStore {
  const specs = new Map<NavdataTable, TableSpec>();
  for (const table of NAVDATA_TABLES) specs.set(table, buildTableSpec(db, table));

  const specFor = (table: NavdataTable): TableSpec => {
    const spec = specs.get(table);
    if (!spec) throw new Error(`navdata: unknown table ${table}`);
    return spec;
  };

  const keyValues = (spec: TableSpec, row: Record<string, NavdataInput>): NavdataValue[] =>
    spec.keys.map((key) => {
      const value = row[key];
      if (value === undefined || value === null) {
        throw new Error(`navdata: ${spec.name}.${key} is part of the key and must be supplied`);
      }
      return typeof value === 'boolean' ? (value ? 1 : 0) : value;
    });

  const readRow = (table: NavdataTable, key: Record<string, NavdataInput>) => {
    const spec = specFor(table);
    return spec.select.get(...keyValues(spec, key)) ?? null;
  };

  const countStatements = new Map<NavdataTable, SqliteStatement>();

  let inTransaction = false;
  let closed = false;

  const requireOpen = (): void => {
    if (closed) throw new Error('navdata: the store is closed');
  };

  const store: NavdataStore = {
    path: dbPath,

    meta(): NavdataMeta {
      requireOpen();
      const meta = readMeta(db);
      if (meta === null) throw new Error('navdata: the store has no metadata row');
      return meta;
    },

    row<T extends NavdataTable>(table: T, key: NavdataRowInput<T>): NavdataRow<T> | null {
      requireOpen();
      return readRow(table, key as Record<string, NavdataInput>) as NavdataRow<T> | null;
    },

    count(table: NavdataTable): number {
      requireOpen();
      let statement = countStatements.get(table);
      if (!statement) {
        statement = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
        countStatements.set(table, statement);
      }
      return Number(statement.get()?.n ?? 0);
    },

    write<T>(fn: (tx: NavdataTx) => T): T {
      requireOpen();
      if (inTransaction) throw new Error('navdata: write transactions do not nest');
      const meta = store.meta();
      const rev = meta.rev + 1;
      let dirty = false;

      const tx: NavdataTx = {
        rev,

        upsert<K extends NavdataTable>(table: K, row: NavdataRowInput<K>): boolean {
          const spec = specFor(table);
          const incoming = row as Record<string, NavdataInput>;
          const stored = spec.select.get(...keyValues(spec, incoming)) ?? null;
          const merged = mergeRow(stored, incoming, spec.merge);
          if (!merged.changed) return false;
          merged.row[REV_COLUMN] = rev;
          spec.upsert.run(...spec.columns.map((c) => merged.row[c] ?? null));
          dirty = true;
          return true;
        },

        row<K extends NavdataTable>(table: K, key: NavdataRowInput<K>): NavdataRow<K> | null {
          return readRow(table, key as Record<string, NavdataInput>) as NavdataRow<K> | null;
        },

        recordCoverage(kind, cellId, harvestedAt, rowCount): void {
          const stored = readRow('nav_coverage_cell', { kind, cell_id: cellId });
          const previous = stored === null ? 0 : Number(stored.harvest_count);
          tx.upsert('nav_coverage_cell', {
            kind,
            cell_id: cellId,
            harvested_at: harvestedAt,
            harvest_count: previous + 1,
            row_count: rowCount,
          });
        },

        recordAbsent(entry): void {
          const region = entry.region ?? '';
          const stored = readRow('nav_absent', {
            kind: entry.kind,
            ident: entry.ident,
            region,
          });
          const firstSeen =
            stored === null ? entry.at : Math.min(Number(stored.first_seen_at), entry.at);
          const attempts = stored === null ? 1 : Number(stored.attempts) + 1;
          tx.upsert('nav_absent', {
            kind: entry.kind,
            ident: entry.ident,
            region,
            reason: entry.reason,
            first_seen_at: firstSeen,
            last_checked_at: entry.at,
            attempts,
          });
        },

        updateMeta(patch): void {
          const assignments: string[] = [];
          const values: NavdataValue[] = [];
          const set = (column: string, value: NavdataValue): void => {
            assignments.push(`${column} = ?`);
            values.push(value);
          };
          if (patch.simId !== undefined) set('sim_id', patch.simId);
          if (patch.simAppName !== undefined) set('sim_app_name', patch.simAppName);
          if (patch.simAppVersion !== undefined) set('sim_app_version', patch.simAppVersion);
          if (patch.bulkStartedAt !== undefined) set('bulk_started_at', patch.bulkStartedAt);
          if (patch.bulkCompletedAt !== undefined) set('bulk_completed_at', patch.bulkCompletedAt);
          if (patch.bulkRowCount !== undefined) set('bulk_row_count', patch.bulkRowCount);
          if (assignments.length === 0) return;
          set('updated_at', now());
          db.prepare(`UPDATE nav_meta SET ${assignments.join(', ')} WHERE id = 1`).run(...values);
        },

        mintEpoch(): string {
          const snapshotId = mintSnapshotId(now());
          db.prepare('DELETE FROM nav_absent').run();
          db.prepare('UPDATE nav_meta SET snapshot_id = ?, updated_at = ? WHERE id = 1').run(
            snapshotId,
            now(),
          );
          return snapshotId;
        },
      };

      inTransaction = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(tx);
        if (dirty) {
          db.prepare('UPDATE nav_meta SET rev = ?, updated_at = ? WHERE id = 1').run(rev, now());
        }
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Already rolled back by SQLite; the body's error is the real one.
        }
        throw err;
      } finally {
        inTransaction = false;
      }
    },

    resetPendingDetail(): number {
      requireOpen();
      return store.write((tx) => {
        let cleared = 0;
        for (const table of PENDING_DETAIL_TABLES) {
          const spec = specFor(table);
          const keys = spec.keys.join(', ');
          const stale = db
            .prepare(`SELECT ${keys} FROM ${table} WHERE detail_state = 'pending'`)
            .all();
          for (const row of stale) {
            // Back to the weakest claim the table has: a row whose detail never
            // arrived knows only what the index put there.
            const reset = { ...row, detail_state: 'index' } as NavdataRowInput<typeof table>;
            if (tx.upsert(table, reset)) cleared++;
          }
        }
        return cleared;
      });
    },

    checkpoint(): void {
      requireOpen();
      db.pragma('wal_checkpoint(TRUNCATE)');
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };

  return store;
}
