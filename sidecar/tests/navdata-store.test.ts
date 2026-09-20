// tests/navdata-store.test.ts — tests src/navdata-store.ts.
//
// Three things are being pinned down here.
//
// 1. Fail-soft. A driver that will not load must disable navdata and nothing
//    else: no throw, one reason, no retry. It is simulated with an injected
//    loader, so the installed better-sqlite3 is never disturbed.
// 2. The rev discipline. One rev per write transaction, never one per row, and
//    no rev at all for a transaction that changed nothing — otherwise every
//    harvest re-ships everything it re-saw and the incremental stream never
//    drains.
// 3. The merge rules, through the store rather than in the abstract: a VOR row
//    assembled from two calls in either order, an airway leg reported from both
//    of its endpoints, a harvest that found nothing, and an absence whose first
//    sighting must never move forward.
//
// Every database here is under a fresh mkdtemp directory. Synthetic idents
// only, and nothing reads or writes the real store or the real config: the
// path derivation is exercised as string arithmetic on a temp path.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { wptKey, airwayLegRow } from '../src/navdata-keys';
import {
  cachingDriverLoader,
  moveStoreAside,
  navdataDatabasePath,
  navdataDirectory,
  openNavdataStore,
  type NavdataStore,
  type NavdataUnavailable,
} from '../src/navdata-store';

const temporary: string[] = [];
const opened: NavdataStore[] = [];

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navdata-store-'));
  temporary.push(dir);
  return dir;
}

function openIn(dir: string, options = {}): NavdataStore {
  const store = openNavdataStore(path.join(dir, 'navdata', 'navdata.db'), options);
  if (store === null) throw new Error('expected the store to open');
  opened.push(store);
  return store;
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (temporary.length > 0) {
    fs.rmSync(temporary.pop() as string, { recursive: true, force: true });
  }
});

describe('where the store lives', () => {
  it('sits in a navdata subdirectory beside the config file, never in it', () => {
    const configPath = path.join(os.tmpdir(), 'msfslogger-test', 'config.json');
    expect(navdataDirectory(configPath)).toBe(
      path.join(os.tmpdir(), 'msfslogger-test', 'navdata'),
    );
    expect(navdataDatabasePath(configPath)).toBe(
      path.join(os.tmpdir(), 'msfslogger-test', 'navdata', 'navdata.db'),
    );
    expect(path.dirname(navdataDatabasePath(configPath))).not.toBe(path.dirname(configPath));
  });

  it('derives nothing until a caller opens it', () => {
    const dir = scratchDir();
    const dbPath = navdataDatabasePath(path.join(dir, 'config.json'));
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false);
  });
});

describe('the fail-soft seam', () => {
  it('returns null with a reason when the driver will not load', () => {
    const dir = scratchDir();
    const failures: NavdataUnavailable[] = [];
    const abi = Object.assign(new Error('compiled against NODE_MODULE_VERSION 108'), {
      code: 'ERR_DLOPEN_FAILED',
    });

    const store = openNavdataStore(path.join(dir, 'navdata', 'navdata.db'), {
      loadDriver: cachingDriverLoader(() => {
        throw abi;
      }),
      onUnavailable: (failure) => failures.push(failure),
    });

    expect(store).toBeNull();
    expect(failures).toEqual([
      {
        code: 'ERR_DLOPEN_FAILED',
        reason: 'navdata disabled: the SQLite driver did not load (ERR_DLOPEN_FAILED)',
      },
    ]);
  });

  it('survives a driver that was never installed', () => {
    const dir = scratchDir();
    const failures: NavdataUnavailable[] = [];
    const store = openNavdataStore(path.join(dir, 'navdata', 'navdata.db'), {
      loadDriver: cachingDriverLoader(() => require('better-sqlite3-not-installed')),
      onUnavailable: (failure) => failures.push(failure),
    });
    expect(store).toBeNull();
    expect(failures[0].code).toBe('MODULE_NOT_FOUND');
  });

  it('remembers the failure instead of retrying the load', () => {
    let attempts = 0;
    const loader = cachingDriverLoader(() => {
      attempts++;
      throw Object.assign(new Error('nope'), { code: 'ERR_DLOPEN_FAILED' });
    });
    const dir = scratchDir();
    for (let i = 0; i < 3; i++) {
      expect(openNavdataStore(path.join(dir, 'navdata', 'navdata.db'), { loadDriver: loader })).toBeNull();
    }
    expect(attempts).toBe(1);
  });

  it('returns null rather than throwing when the directory cannot be made', () => {
    const dir = scratchDir();
    const blocker = path.join(dir, 'navdata');
    fs.writeFileSync(blocker, 'not a directory');
    const failures: NavdataUnavailable[] = [];
    const store = openNavdataStore(path.join(blocker, 'navdata.db'), {
      onUnavailable: (failure) => failures.push(failure),
    });
    expect(store).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain('could not be created');
  });

  it('moves a file that is not a database aside, write-ahead log and all', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata', 'navdata.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a database, it is a text file');
    fs.writeFileSync(`${dbPath}-wal`, 'stale write-ahead log');
    fs.writeFileSync(`${dbPath}-shm`, 'stale shared memory');

    const store = openNavdataStore(dbPath, { now: () => 1_700_000_000_000 });
    expect(store).not.toBeNull();
    opened.push(store as NavdataStore);

    expect(fs.existsSync(`${dbPath}.corrupt-1700000000000`)).toBe(true);
    // Whatever is beside the fresh database is its own. Nothing of the file
    // that was here survives at this path to be replayed into it.
    const freshWal = fs.existsSync(`${dbPath}-wal`) ? fs.readFileSync(`${dbPath}-wal`, 'utf8') : '';
    const freshShm = fs.existsSync(`${dbPath}-shm`) ? fs.readFileSync(`${dbPath}-shm`, 'utf8') : '';
    expect(freshWal).not.toContain('stale');
    expect(freshShm).not.toContain('stale');
    expect((store as NavdataStore).count('nav_airport')).toBe(0);
  });

  // The recovery move itself, which both the corruption path and the
  // schema-version path go through. In practice SQLite has already discarded a
  // stale -wal by the time either of them runs, so these exercise the helper
  // directly. Both of its promises are load-bearing: a failed move leaves the
  // store whole, and a move that succeeds leaves no write-ahead log behind to
  // be replayed into the file created in its place.
  it('moves the write-ahead log and shared memory with the database', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata.db');
    fs.writeFileSync(dbPath, 'database');
    fs.writeFileSync(`${dbPath}-wal`, 'log');
    fs.writeFileSync(`${dbPath}-shm`, 'shared');

    expect(moveStoreAside(dbPath, `${dbPath}.aside`)).toBe(`${dbPath}.aside`);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(fs.readFileSync(`${dbPath}.aside`, 'utf8')).toBe('database');
    expect(fs.readFileSync(`${dbPath}.aside-wal`, 'utf8')).toBe('log');
    expect(fs.readFileSync(`${dbPath}.aside-shm`, 'utf8')).toBe('shared');
  });

  it('deletes a write-ahead log it cannot move rather than leaving it behind', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata.db');
    fs.writeFileSync(dbPath, 'database');
    fs.writeFileSync(`${dbPath}-wal`, 'log');
    // Something already occupies the name the log would be moved to.
    fs.mkdirSync(`${dbPath}.aside-wal`);
    fs.writeFileSync(path.join(`${dbPath}.aside-wal`, 'occupied'), 'x');

    expect(moveStoreAside(dbPath, `${dbPath}.aside`)).toBe(`${dbPath}.aside`);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.readFileSync(`${dbPath}.aside`, 'utf8')).toBe('database');
  });

  it('moves nothing at all — log included — when the database cannot be moved', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata.db');
    fs.writeFileSync(dbPath, 'database');
    fs.writeFileSync(`${dbPath}-wal`, 'log');
    fs.writeFileSync(`${dbPath}-shm`, 'shared');
    fs.mkdirSync(`${dbPath}.aside`);
    fs.writeFileSync(path.join(`${dbPath}.aside`, 'occupied'), 'x');

    expect(moveStoreAside(dbPath, `${dbPath}.aside`)).toBeNull();
    // The store that stayed put keeps the log it may have uncheckpointed rows
    // in. Taking that out from under it would be the one way this helper could
    // destroy data.
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('database');
    expect(fs.readFileSync(`${dbPath}-wal`, 'utf8')).toBe('log');
    expect(fs.readFileSync(`${dbPath}-shm`, 'utf8')).toBe('shared');
    expect(fs.existsSync(`${dbPath}.aside-wal`)).toBe(false);
  });

  it('leaves a corrupt file alone, and navdata off, when it cannot be moved', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata', 'navdata.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a database, it is a text file');
    fs.mkdirSync(`${dbPath}.corrupt-1700000000000`);
    fs.writeFileSync(path.join(`${dbPath}.corrupt-1700000000000`, 'occupied'), 'x');

    const failures: NavdataUnavailable[] = [];
    const store = openNavdataStore(dbPath, {
      now: () => 1_700_000_000_000,
      onUnavailable: (f) => failures.push(f),
    });

    expect(store).toBeNull();
    expect(failures[0].code).toBe('SQLITE_NOTADB');
    expect(fs.readFileSync(dbPath, 'utf8')).toBe('this is not a database, it is a text file');
  });

  it('refuses a database whose tables do not match the embedded schema', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata', 'navdata.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = require('better-sqlite3');
    const raw = new Database(dbPath);
    raw.exec('CREATE TABLE nav_meta (id INTEGER PRIMARY KEY, surprise TEXT)');
    raw.close();

    const failures: NavdataUnavailable[] = [];
    const store = openNavdataStore(dbPath, { onUnavailable: (f) => failures.push(f) });
    expect(store).toBeNull();
    expect(failures[0].code).toBe('NAVDATA_SCHEMA_MISMATCH');
  });

  it('moves a store from another schema version aside and starts a fresh one', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata', 'navdata.db');
    const Database = require('better-sqlite3');

    const first = openNavdataStore(dbPath);
    first?.write((tx) => tx.upsert('nav_airport', { ident: 'ZZZA', lat: 1, lon: 2 }));
    const before = first?.meta();
    first?.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE nav_meta SET schema_version = 99 WHERE id = 1').run();
    raw.close();

    const failures: NavdataUnavailable[] = [];
    const logs: Array<[string, string]> = [];
    const store = openNavdataStore(dbPath, {
      now: () => 1_700_000_000_000,
      onUnavailable: (f) => failures.push(f),
      log: (level, message) => logs.push([level, message]),
    });

    expect(failures).toEqual([]);
    expect(store).not.toBeNull();
    opened.push(store as NavdataStore);

    const moved = `${dbPath}.v99-1700000000000`;
    expect(fs.existsSync(moved)).toBe(true);

    // The replacement is empty and usable, and it is a new epoch.
    expect((store as NavdataStore).count('nav_airport')).toBe(0);
    expect((store as NavdataStore).meta().rev).toBe(0);
    expect((store as NavdataStore).meta().schemaVersion).toBe(2);
    expect((store as NavdataStore).meta().snapshotId).not.toBe(before?.snapshotId);
    (store as NavdataStore).write((tx) => tx.upsert('nav_airport', { ident: 'ZZZB', lat: 3, lon: 4 }));
    expect((store as NavdataStore).count('nav_airport')).toBe(1);

    // Nothing of the user's was destroyed: the old rows are in the moved file.
    const kept = new Database(moved);
    expect(kept.prepare('SELECT COUNT(*) AS n FROM nav_airport').get().n).toBe(1);
    expect(kept.prepare('SELECT schema_version AS v FROM nav_meta WHERE id = 1').get().v).toBe(99);
    kept.close();

    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe('info');
    expect(logs[0][1]).toContain('schema version 99');
    expect(logs[0][1]).toContain('this build speaks 2');
    expect(logs[0][1]).toContain(moved);
  });

  it('rebuilds a store left behind by the previous schema version', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata', 'navdata.db');
    const Database = require('better-sqlite3');

    const first = openNavdataStore(dbPath);
    first?.write((tx) => tx.upsert('nav_airport', { ident: 'ZZZA', lat: 1, lon: 2 }));
    first?.close();
    // What a store written by the build before the displaced thresholds looks
    // like. There is no migration: the cache is cheaper to rebuild from the
    // simulator than to migrate, and the old file is kept in case it is not.
    const raw = new Database(dbPath);
    raw.prepare('UPDATE nav_meta SET schema_version = 1 WHERE id = 1').run();
    raw.close();

    const store = openNavdataStore(dbPath, { now: () => 1_700_000_000_000 });
    expect(store).not.toBeNull();
    opened.push(store as NavdataStore);
    expect(fs.existsSync(`${dbPath}.v1-1700000000000`)).toBe(true);
    expect((store as NavdataStore).meta().schemaVersion).toBe(2);
    expect((store as NavdataStore).count('nav_airport')).toBe(0);
  });

  it('keeps the store it has when the old file cannot be moved aside', () => {
    const dir = scratchDir();
    const dbPath = path.join(dir, 'navdata', 'navdata.db');
    const Database = require('better-sqlite3');

    const first = openNavdataStore(dbPath);
    first?.close();
    const raw = new Database(dbPath);
    raw.prepare('UPDATE nav_meta SET schema_version = 99 WHERE id = 1').run();
    raw.close();

    // A directory already sitting on the name the move wants.
    fs.mkdirSync(`${dbPath}.v99-1700000000000`, { recursive: true });
    fs.writeFileSync(path.join(`${dbPath}.v99-1700000000000`, 'occupied'), 'x');

    const failures: NavdataUnavailable[] = [];
    const store = openNavdataStore(dbPath, {
      now: () => 1_700_000_000_000,
      onUnavailable: (f) => failures.push(f),
    });

    expect(store).toBeNull();
    expect(failures[0].code).toBe('NAVDATA_SCHEMA_UNSUPPORTED');
    expect(failures[0].reason).toContain('could not be moved aside');
    // The file is still there, untouched, for a later build to migrate.
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

describe('the epoch and the rev', () => {
  it('mints an opaque snapshot id on the first open', () => {
    const meta = openIn(scratchDir()).meta();
    expect(meta.snapshotId).toMatch(/^\d+-[0-9a-f]{8}$/);
    expect(meta.rev).toBe(0);
    expect(meta.schemaVersion).toBe(2);
    expect(meta.bulkCompletedAt).toBeNull();
  });

  it('records the configured simulator on a fresh store', () => {
    expect(openIn(scratchDir(), { simId: '2024' }).meta().simId).toBe('2024');
  });

  it('bumps the rev once for a transaction, whatever the row count', () => {
    const store = openIn(scratchDir());
    store.write((tx) => {
      for (const ident of ['ZZZA', 'ZZZB', 'ZZZC']) {
        expect(tx.upsert('nav_airport', { ident, lat: 1, lon: 2, position_source: 'list' })).toBe(true);
      }
    });
    expect(store.meta().rev).toBe(1);
    expect(store.count('nav_airport')).toBe(3);
    for (const ident of ['ZZZA', 'ZZZB', 'ZZZC']) {
      expect(store.row('nav_airport', { ident })?.rev).toBe(1);
    }
  });

  it('does not bump the rev for a transaction that changed nothing', () => {
    const store = openIn(scratchDir());
    const row = { ident: 'ZZZA', lat: 1, lon: 2, alt_m: 30, position_source: 'list' };
    store.write((tx) => tx.upsert('nav_airport', row));
    expect(store.meta().rev).toBe(1);

    const changed = store.write((tx) => tx.upsert('nav_airport', row));
    expect(changed).toBe(false);
    expect(store.meta().rev).toBe(1);
    expect(store.row('nav_airport', { ident: 'ZZZA' })?.rev).toBe(1);
  });

  it('rolls back and bumps nothing when the body throws', () => {
    const store = openIn(scratchDir());
    expect(() =>
      store.write((tx) => {
        tx.upsert('nav_airport', { ident: 'ZZZA', lat: 1, lon: 2 });
        throw new Error('extractor gave up');
      }),
    ).toThrow('extractor gave up');
    expect(store.count('nav_airport')).toBe(0);
    expect(store.meta().rev).toBe(0);
  });

  it('refuses to nest write transactions', () => {
    const store = openIn(scratchDir());
    expect(() => store.write(() => store.write(() => undefined))).toThrow(/do not nest/);
  });

  it('refuses a row with no key', () => {
    const store = openIn(scratchDir());
    expect(() => store.write((tx) => tx.upsert('nav_airport', { lat: 1 }))).toThrow(
      /nav_airport.ident is part of the key/,
    );
  });

  it('mints a new epoch, wipes absences and keeps the rev climbing', () => {
    const store = openIn(scratchDir());
    store.write((tx) => {
      tx.upsert('nav_airport', { ident: 'ZZZA', lat: 1, lon: 2 });
      tx.recordAbsent({ kind: 'W', ident: 'NOTHR', reason: 'silent', at: 1000 });
    });
    const before = store.meta();

    const minted = store.write((tx) => tx.mintEpoch());
    const after = store.meta();

    expect(minted).not.toBe(before.snapshotId);
    expect(after.snapshotId).toBe(minted);
    expect(store.count('nav_absent')).toBe(0);
    expect(store.count('nav_airport')).toBe(1);
    expect(after.rev).toBeGreaterThanOrEqual(before.rev);
  });

  it('updates the meta row without pretending a row shipped', () => {
    const store = openIn(scratchDir());
    store.write((tx) => tx.updateMeta({ bulkStartedAt: 1000 }));
    expect(store.meta().bulkStartedAt).toBe(1000);
    expect(store.meta().rev).toBe(0);

    store.write((tx) => tx.updateMeta({ bulkCompletedAt: 2000, bulkRowCount: 41871 }));
    expect(store.meta().bulkCompletedAt).toBe(2000);
    expect(store.meta().bulkRowCount).toBe(41871);
    expect(store.meta().rev).toBe(0);
  });
});

describe('the merge rules through the store', () => {
  it('keeps three terminal fixes that share ident and region', () => {
    const store = openIn(scratchDir());
    store.write((tx) => {
      for (const [lat, lon] of [
        [10.1234, 20.5678],
        [11.2345, 21.6789],
        [12.3456, 22.7890],
      ]) {
        tx.upsert('nav_waypoint', {
          wpt_key: wptKey('LOC10', 'ZZ', lat, lon),
          ident: 'LOC10',
          region: 'ZZ',
          lat,
          lon,
          position_source: 'list',
        });
      }
    });
    expect(store.count('nav_waypoint')).toBe(3);

    // The same fix again from another path, jittered below the key's resolution.
    const again = store.write((tx) =>
      tx.upsert('nav_waypoint', {
        wpt_key: wptKey('LOC10', 'ZZ', 10.1234 + 0.0000004, 20.5678),
        ident: 'LOC10',
        region: 'ZZ',
        lat: 10.1234,
        lon: 20.5678,
        position_source: 'list',
      }),
    );
    expect(again).toBe(false);
    expect(store.count('nav_waypoint')).toBe(3);
  });

  it('assembles a VOR from detail then position', () => {
    const store = openIn(scratchDir());
    store.write((tx) =>
      tx.upsert('nav_navaid', {
        kind: 'V',
        ident: 'TSTA',
        region: 'ZZ',
        frequency_hz: 113400000,
        name: 'TEST ALPHA',
        detail_state: 'detail',
      }),
    );
    store.write((tx) =>
      tx.upsert('nav_navaid', {
        kind: 'V',
        ident: 'TSTA',
        region: 'ZZ',
        lat: 12.5,
        lon: 34.5,
        alt_m: 100,
        position_source: 'list',
      }),
    );
    expect(store.row('nav_navaid', { kind: 'V', ident: 'TSTA', region: 'ZZ' })).toMatchObject({
      lat: 12.5,
      frequency_hz: 113400000,
      detail_state: 'detail',
      rev: 2,
    });
  });

  it('assembles a VOR from position then detail, and survives a thin re-fetch', () => {
    const store = openIn(scratchDir());
    const key = { kind: 'V', ident: 'TSTB', region: 'ZZ' } as const;
    store.write((tx) =>
      tx.upsert('nav_navaid', { ...key, lat: -5.25, lon: 100.75, position_source: 'list' }),
    );
    store.write((tx) =>
      tx.upsert('nav_navaid', { ...key, frequency_hz: 115000000, detail_state: 'detail' }),
    );
    expect(store.row('nav_navaid', key)).toMatchObject({
      lat: -5.25,
      lon: 100.75,
      frequency_hz: 115000000,
    });

    // A definition pruned because the simulator rejected members writes less
    // than it did before, and must erase none of it.
    const thin = store.write((tx) => tx.upsert('nav_navaid', { ...key }));
    expect(thin).toBe(false);
    expect(store.row('nav_navaid', key)).toMatchObject({
      lat: -5.25,
      lon: 100.75,
      frequency_hz: 115000000,
    });
  });

  it('stores an NDB, whose position does arrive with its detail, in one call', () => {
    const store = openIn(scratchDir());
    const key = { kind: 'N', ident: 'TSTC', region: 'ZZ' } as const;
    store.write((tx) =>
      tx.upsert('nav_navaid', {
        ...key,
        lat: 50.5,
        lon: 7.25,
        position_source: 'facility',
        frequency_hz: 385000,
        detail_state: 'detail',
      }),
    );
    expect(store.row('nav_navaid', key)).toMatchObject({
      lat: 50.5,
      position_source: 'facility',
      detail_state: 'detail',
    });

    // A later list row is weaker evidence and must not move the station.
    const moved = store.write((tx) =>
      tx.upsert('nav_navaid', { ...key, lat: 50.6, lon: 7.3, position_source: 'minimal' }),
    );
    expect(moved).toBe(false);
    expect(store.row('nav_navaid', key)?.lat).toBe(50.5);
  });

  it('keeps a displaced threshold, including the zero that means none', () => {
    const store = openIn(scratchDir());
    store.write((tx) => {
      tx.upsert('nav_airport', { ident: 'ZZZA', lat: 10.75, lon: 20.75 });
      // Not displaced, said two different ways: the simulator reports 0 for a
      // runway end with no displacement, and a definition that never carried
      // the member at all leaves it NULL. Both must survive as written.
      tx.upsert('nav_runway', {
        rwy_key: 'ZZZA|15|0',
        airport_ident: 'ZZZA',
        length_m: 3000,
        width_m: 45,
        primary_threshold_m: 120.5,
        secondary_threshold_m: 250.25,
      });
      tx.upsert('nav_runway', {
        rwy_key: 'ZZZA|7|0',
        airport_ident: 'ZZZA',
        length_m: 3000,
        primary_threshold_m: 0,
      });
    });

    expect(store.row('nav_runway', { rwy_key: 'ZZZA|15|0' })).toMatchObject({
      length_m: 3000,
      primary_threshold_m: 120.5,
      secondary_threshold_m: 250.25,
    });
    const plain = store.row('nav_runway', { rwy_key: 'ZZZA|7|0' });
    expect(plain?.primary_threshold_m).toBe(0);
    expect(plain?.secondary_threshold_m).toBeNull();

    // A re-fetch that carries neither erases neither, and changes nothing.
    const again = store.write((tx) =>
      tx.upsert('nav_runway', { rwy_key: 'ZZZA|7|0', airport_ident: 'ZZZA', length_m: 3000 }),
    );
    expect(again).toBe(false);
    expect(store.row('nav_runway', { rwy_key: 'ZZZA|7|0' })?.primary_threshold_m).toBe(0);
  });

  it('stores one airway leg for two opposing reports', () => {
    const store = openIn(scratchDir());
    const a = { ident: 'TESTA', region: 'ZZ', lat: 10, lon: 20 };
    const b = { ident: 'TESTB', region: 'ZZ', lat: 11, lon: 21 };

    const first = store.write((tx) => tx.upsert('nav_airway_leg', airwayLegRow('ZZ1', 5, a, b)));
    const second = store.write((tx) => tx.upsert('nav_airway_leg', airwayLegRow('ZZ1', 5, b, a)));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(store.count('nav_airway_leg')).toBe(1);
    expect(store.meta().rev).toBe(1);
  });
});

describe('coverage and absence', () => {
  it('tells a harvest that found nothing from ground never looked at', () => {
    const store = openIn(scratchDir());
    store.write((tx) => tx.recordCoverage('N', 144400, 1_700_000_000_000, 0));

    expect(store.row('nav_coverage_cell', { kind: 'N', cell_id: 144400 })).toMatchObject({
      harvested_at: 1_700_000_000_000,
      harvest_count: 1,
      row_count: 0,
    });
    expect(store.row('nav_coverage_cell', { kind: 'N', cell_id: 150000 })).toBeNull();
    expect(store.row('nav_coverage_cell', { kind: 'V', cell_id: 144400 })).toBeNull();
  });

  it('counts every sweep over a cell', () => {
    const store = openIn(scratchDir());
    store.write((tx) => {
      tx.recordCoverage('W', 144400, 1000, 12);
      tx.recordCoverage('W', 144400, 2000, 14);
    });
    store.write((tx) => tx.recordCoverage('W', 144400, 3000, 14));
    expect(store.row('nav_coverage_cell', { kind: 'W', cell_id: 144400 })).toMatchObject({
      harvested_at: 3000,
      harvest_count: 3,
      row_count: 14,
    });
  });

  it('never moves first_seen_at forward', () => {
    const store = openIn(scratchDir());
    const entry = { kind: 'W', ident: 'NOTHR', reason: 'silent' } as const;

    store.write((tx) => tx.recordAbsent({ ...entry, at: 2000 }));
    expect(store.row('nav_absent', { kind: 'W', ident: 'NOTHR', region: '' })).toMatchObject({
      first_seen_at: 2000,
      last_checked_at: 2000,
      attempts: 1,
    });

    store.write((tx) => tx.recordAbsent({ ...entry, at: 9000 }));
    expect(store.row('nav_absent', { kind: 'W', ident: 'NOTHR', region: '' })).toMatchObject({
      first_seen_at: 2000,
      last_checked_at: 9000,
      attempts: 2,
    });

    // A clock that went backwards, or evidence found out of order: the oldest
    // sighting is the one worth keeping.
    store.write((tx) => tx.recordAbsent({ ...entry, at: 500 }));
    expect(store.row('nav_absent', { kind: 'W', ident: 'NOTHR', region: '' })).toMatchObject({
      first_seen_at: 500,
      last_checked_at: 500,
      attempts: 3,
    });
  });

  it('separates an absence by kind and region', () => {
    const store = openIn(scratchDir());
    store.write((tx) => {
      tx.recordAbsent({ kind: 'W', ident: 'TESTA', reason: 'silent', at: 1000 });
      tx.recordAbsent({ kind: 'V', ident: 'TESTA', reason: 'exception', at: 1000 });
      tx.recordAbsent({ kind: 'W', ident: 'TESTA', region: 'ZZ', reason: 'silent', at: 1000 });
    });
    expect(store.count('nav_absent')).toBe(3);
  });
});

describe('the file on disk', () => {
  it('folds the write-ahead log back into the database on checkpoint', () => {
    const dir = scratchDir();
    const store = openIn(dir);
    const dbPath = store.path;
    store.write((tx) => {
      for (let i = 0; i < 200; i++) {
        tx.upsert('nav_airport', { ident: `Z${i}`, lat: i / 10, lon: i / 10 });
      }
    });
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    store.checkpoint();
    expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
  });

  it('reopens an existing store without disturbing its epoch or its rows', () => {
    const dir = scratchDir();
    const first = openIn(dir);
    first.write((tx) => tx.upsert('nav_airport', { ident: 'ZZZA', lat: 1, lon: 2 }));
    const meta = first.meta();
    first.close();

    const second = openIn(dir);
    expect(second.meta().snapshotId).toBe(meta.snapshotId);
    expect(second.meta().rev).toBe(1);
    expect(second.count('nav_airport')).toBe(1);
  });
});
