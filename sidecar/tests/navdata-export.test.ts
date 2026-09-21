// tests/navdata-export.test.ts — tests src/navdata-export.ts, the gzipped
// NDJSON snapshot the server's replica is reset from.
//
// What these pin down:
//
// 1. The file round-trips. It gunzips, every line parses, the header's counts
//    equal the footer's equal the rows actually written, and the emission order
//    is the one a foreign-key-enforcing receiver streams in.
// 2. NULL and 0 stay different. Under the merge rules an incoming 0 overwrites
//    and an incoming NULL does not, so a serialiser that confused them would
//    quietly destroy a real displaced threshold.
// 3. The size guard is a guard. It aborts and leaves nothing behind.
// 4. A world-sized index — 41 871 rows, the measured count — exports whole, in
//    chunks, without holding the event loop.
// 5. The header states the bulk facts rather than leaving the receiver to infer
//    them: a replica decides whether its airport layer is world-complete from
//    bulkCompletedAt, and an unfinished pass says so with a null that is still
//    a key, because a missing key means only that the sender is older.
//
// Every store is under a fresh mkdtemp directory and every ident is synthetic.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import {
  exportSnapshot,
  openNavdataReader,
  removeStaleSnapshots,
  snapshotFileName,
  snapshotPath,
  SNAPSHOT_TABLE_ORDER,
  type NavRowType,
  type SnapshotFooterLine,
  type SnapshotHeaderLine,
} from '../src/navdata-export';
import { NAVDATA_SCHEMA_VERSION } from '../src/navdata-schema';
import type { NavdataStore } from '../src/navdata-store';
import {
  fillAirports,
  openFixtureStore,
  populate,
  removeScratchDirs,
  scratchDir,
} from './helpers/navdata-fixture-store';

const WORLD_AIRPORTS = 41871;

const stores: NavdataStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  removeScratchDirs();
});

function open(): { store: NavdataStore; directory: string } {
  const root = scratchDir();
  const store = openFixtureStore(root);
  stores.push(store);
  return { store, directory: path.dirname(store.path) };
}

function readLines(file: string): unknown[] {
  return zlib
    .gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function runExport(store: NavdataStore, directory: string, options: Record<string, unknown> = {}) {
  const reader = openNavdataReader(store.path);
  try {
    return await exportSnapshot(reader, {
      directory,
      sidecarVersion: '1.0.0',
      ...options,
    });
  } finally {
    reader.close();
  }
}

describe('the snapshot export', () => {
  it('writes a header, tagged rows and a footer whose counts agree', async () => {
    const { store, directory } = open();
    populate(store);
    const meta = store.meta();

    const result = await runExport(store, directory);

    expect(result.snapshotId).toBe(meta.snapshotId);
    expect(result.rev).toBe(meta.rev);
    expect(result.path).toBe(snapshotPath(directory, meta.snapshotId));
    expect(fs.existsSync(`${result.path}.tmp`)).toBe(false);

    const lines = readLines(result.path);
    const header = lines[0] as SnapshotHeaderLine;
    const footer = lines[lines.length - 1] as SnapshotFooterLine;
    const rows = lines.slice(1, -1) as { t: NavRowType; r: Record<string, unknown> }[];

    expect(header.kind).toBe('header');
    expect(header.v).toBe(1);
    expect(header.schemaVersion).toBe(2);
    expect(header.simId).toBe('2020');
    expect(header.sidecarVersion).toBe('1.0.0');
    expect(footer.kind).toBe('footer');
    expect(footer.rows).toBe(rows.length);
    expect(result.rows).toBe(rows.length);
    expect(footer.counts).toEqual(header.counts);

    const actual: Record<string, number> = {};
    for (const row of rows) actual[row.t] = (actual[row.t] ?? 0) + 1;
    expect(actual).toEqual(header.counts);

    // Every table is represented, and one row per table plus the extras the
    // fixture writes.
    expect(header.counts).toEqual({
      airport: 1,
      navaid: 1,
      waypoint: 2,
      airway_leg: 1,
      runway: 1,
      frequency: 1,
      procedure: 1,
      procedure_transition: 1,
      procedure_leg: 2,
      coverage_cell: 1,
      absent: 1,
    });
  });

  it('emits the tables in the order a receiver can stream', async () => {
    const { store, directory } = open();
    populate(store);

    const result = await runExport(store, directory);
    const rows = readLines(result.path).slice(1, -1) as { t: NavRowType }[];

    const expected = SNAPSHOT_TABLE_ORDER.map((entry) => entry.type);
    const seen: NavRowType[] = [];
    for (const row of rows) if (seen[seen.length - 1] !== row.t) seen.push(row.t);
    expect(seen).toEqual(expected);
    // The parents really do come first: the airport before its runway, the
    // procedure before its transition before its legs.
    expect(seen.indexOf('airport')).toBeLessThan(seen.indexOf('runway'));
    expect(seen.indexOf('procedure')).toBeLessThan(seen.indexOf('procedure_transition'));
    expect(seen.indexOf('procedure_transition')).toBeLessThan(seen.indexOf('procedure_leg'));
  });

  it('carries the columns unchanged, and never turns a NULL into a 0', async () => {
    const { store, directory } = open();
    populate(store);

    const result = await runExport(store, directory);
    const rows = readLines(result.path).slice(1, -1) as { t: NavRowType; r: Record<string, unknown> }[];
    const runway = rows.find((row) => row.t === 'runway')?.r;

    expect(runway?.rwy_key).toBe('ZZAA|15|0');
    expect(runway?.primary_threshold_m).toBe(0);
    expect(runway?.secondary_threshold_m).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(runway ?? {}, 'secondary_threshold_m')).toBe(true);
    expect(runway?.rev).toBe(store.row('nav_runway', { rwy_key: 'ZZAA|15|0' })?.rev);
  });

  it('states what the bulk pass did, and which simulator answered', async () => {
    const { store, directory } = open();
    populate(store);
    store.write((tx) =>
      tx.updateMeta({
        simAppName: 'KittyHawk',
        simAppVersion: '11.0',
        bulkStartedAt: 1_758_300_000_000,
        bulkCompletedAt: 1_758_300_040_000,
        bulkRowCount: WORLD_AIRPORTS,
      }),
    );

    const result = await runExport(store, directory);
    const header = readLines(result.path)[0] as SnapshotHeaderLine;

    expect(header.simAppName).toBe('KittyHawk');
    expect(header.simAppVersion).toBe('11.0');
    expect(header.bulkStartedAt).toBe(1_758_300_000_000);
    // The one field a replica reads to decide that its airport layer is the
    // whole world rather than part of one.
    expect(header.bulkCompletedAt).toBe(1_758_300_040_000);
    expect(header.bulkRowCount).toBe(WORLD_AIRPORTS);
    // Additive fields on the payload; the schema is untouched.
    expect(header.schemaVersion).toBe(NAVDATA_SCHEMA_VERSION);
    expect(NAVDATA_SCHEMA_VERSION).toBe(2);
  });

  it('says an unfinished bulk pass with a null that is still a key', async () => {
    const { store, directory } = open();
    populate(store);
    store.write((tx) => tx.updateMeta({ bulkStartedAt: 1_758_300_000_000, bulkCompletedAt: null }));

    const result = await runExport(store, directory);
    const emitted = zlib
      .gunzipSync(fs.readFileSync(result.path))
      .toString('utf8')
      .split('\n')[0];
    const header = JSON.parse(emitted) as Record<string, unknown>;

    expect(header.bulkCompletedAt).toBeNull();
    expect(header.bulkRowCount).toBe(0);
    // A sender older than these fields omits them and is making no claim at
    // all; this sender says "the pass has not finished". The two must not look
    // alike on the wire, and JSON.stringify drops an undefined silently.
    expect(Object.prototype.hasOwnProperty.call(header, 'bulkCompletedAt')).toBe(true);
    expect(emitted).toContain('"bulkCompletedAt":null');
    const older = { ...header };
    delete older.bulkCompletedAt;
    expect(Object.prototype.hasOwnProperty.call(older, 'bulkCompletedAt')).toBe(false);
    expect(JSON.stringify(older)).not.toContain('bulkCompletedAt');
  });

  it('leaves the simulator unnamed when no session has ever connected', async () => {
    const { store, directory } = open();
    populate(store);

    const result = await runExport(store, directory);
    const header = readLines(result.path)[0] as SnapshotHeaderLine;

    expect(header.simAppName).toBeNull();
    expect(header.simAppVersion).toBeNull();
    expect(header.bulkStartedAt).toBeNull();
    expect(header.bulkCompletedAt).toBeNull();
    expect(header.bulkRowCount).toBe(0);
  });

  it('abandons an export that passes the size guard and leaves no file', async () => {
    const { store, directory } = open();
    fillAirports(store, 5000);

    await expect(runExport(store, directory, { maxBytes: 1024 })).rejects.toThrow(/passed 1024 bytes/);

    const left = fs.readdirSync(directory).filter((entry) => entry.startsWith('snapshot-'));
    expect(left).toEqual([]);
  });

  it('removes the files earlier exports left behind, and nothing else', async () => {
    const { store, directory } = open();
    populate(store);
    fs.writeFileSync(path.join(directory, 'snapshot-older-epoch.ndjson.gz'), 'stale');
    fs.writeFileSync(path.join(directory, 'snapshot-older-epoch.ndjson.gz.tmp'), 'stale');

    const result = await runExport(store, directory);

    const left = fs.readdirSync(directory).sort();
    expect(left).toContain(path.basename(result.path));
    expect(left).toContain('navdata.db');
    expect(left.filter((entry) => entry.includes('older-epoch'))).toEqual([]);
    expect(removeStaleSnapshots(directory, result.path)).toBe(0);
  });

  it('names the upload after the epoch and nothing else', () => {
    expect(snapshotFileName('1758300000000-a1b2c3d4')).toBe('navdata-1758300000000-a1b2c3d4.ndjson.gz');
    // An id is opaque; it still may not become a path.
    expect(snapshotFileName('../../etc/passwd')).toBe('navdata-.._.._etc_passwd.ndjson.gz');
  });

  it(
    'exports a world-sized index in chunks',
    async () => {
      const { store, directory } = open();
      fillAirports(store, WORLD_AIRPORTS);
      expect(store.count('nav_airport')).toBe(WORLD_AIRPORTS);

      // Every yield between chunks is counted, and the loop is given something
      // to do in each of them: a pass that blocked would run none of these.
      let yields = 0;
      const startedAt = Date.now();
      const result = await runExport(store, directory, {
        yieldToLoop: async () => {
          yields++;
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      });
      const wallMs = Date.now() - startedAt;

      expect(result.rows).toBe(WORLD_AIRPORTS);
      expect(result.counts.airport).toBe(WORLD_AIRPORTS);
      expect(yields).toBeGreaterThanOrEqual(WORLD_AIRPORTS / 2000);

      const lines = readLines(result.path);
      expect(lines.length).toBe(WORLD_AIRPORTS + 2);
      expect((lines[0] as SnapshotHeaderLine).counts.airport).toBe(WORLD_AIRPORTS);
      expect((lines[lines.length - 1] as SnapshotFooterLine).rows).toBe(WORLD_AIRPORTS);

      console.log(
        `world-sized export: rows=${result.rows} bytes=${result.bytes} ` +
          `exportMs=${result.durationMs} wallMs=${wallMs} yields=${yields}`,
      );
      // Well inside the 64 MiB guard, as the sizing this was designed against.
      expect(result.bytes).toBeLessThan(8 * 1024 * 1024);
    },
    120000,
  );

  it('takes one consistent view while the store keeps writing', async () => {
    const { store, directory } = open();
    fillAirports(store, 4000);
    const before = store.meta();

    let wrote = false;
    const result = await runExport(store, directory, {
      chunkRows: 500,
      yieldToLoop: async () => {
        // A facility write landing mid-export must not appear in a file that
        // claims to be complete at the header's rev — those rows would never
        // be sent again.
        if (!wrote) {
          wrote = true;
          store.write((tx) => tx.upsert('nav_airport', { ident: 'ZLATE', lat: 1, lon: 2 }));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    });

    expect(wrote).toBe(true);
    expect(store.meta().rev).toBeGreaterThan(before.rev);
    expect(result.rev).toBe(before.rev);
    expect(result.rows).toBe(4000);
    const rows = readLines(result.path).slice(1, -1) as { r: { ident: string } }[];
    expect(rows.some((row) => row.r.ident === 'ZLATE')).toBe(false);
  });

  it('refuses to export a store that is not there', () => {
    const directory = scratchDir();
    expect(() => openNavdataReader(path.join(directory, 'missing.db'))).toThrow(/no store to export/);
  });
});
