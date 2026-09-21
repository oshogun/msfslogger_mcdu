// tests/helpers/navdata-fixture-store.ts — synthetic navdata stores.
//
// Every ident here is invented. No row in this file, or in any test that uses
// it, came from a simulator's database: the cache holds third-party navdata
// and none of it may reach version control, a fixture or a test.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openNavdataStore, type NavdataStore } from '../../src/navdata-store';

const directories: string[] = [];

export function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navdata-test-'));
  directories.push(dir);
  return dir;
}

export function removeScratchDirs(): void {
  while (directories.length > 0) {
    // Windows holds a just-closed database file for a moment; retry rather
    // than fail a passing test on the cleanup.
    fs.rmSync(directories.pop() as string, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
  }
}

export function openFixtureStore(directory: string): NavdataStore {
  const store = openNavdataStore(path.join(directory, 'navdata', 'navdata.db'), { simId: '2020' });
  if (store === null) throw new Error('the fixture store did not open');
  return store;
}

/**
 * One row in every table the sync stream can carry, written parents first so
 * the foreign keys hold. Returns the rev each write landed on.
 */
export function populate(store: NavdataStore): number[] {
  const revs: number[] = [];
  const at = 1_700_000_000_000;

  revs.push(
    store.write((tx) => {
      tx.upsert('nav_airport', {
        ident: 'ZZAA',
        lat: 10.5,
        lon: 20.25,
        alt_m: 100,
        name: 'TEST ALPHA',
        position_source: 'list',
      });
      return tx.rev;
    }),
  );

  revs.push(
    store.write((tx) => {
      tx.upsert('nav_navaid', {
        kind: 'V',
        ident: 'ZZV1',
        region: 'ZZ',
        lat: 10.6,
        lon: 20.3,
        frequency_hz: 113400000,
        position_source: 'list',
      });
      tx.upsert('nav_waypoint', {
        wpt_key: 'ZZW1|ZZ|1060000|2030000',
        ident: 'ZZW1',
        region: 'ZZ',
        lat: 10.6,
        lon: 20.3,
        position_source: 'list',
      });
      tx.upsert('nav_waypoint', {
        wpt_key: 'ZZW2|ZZ|1070000|2040000',
        ident: 'ZZW2',
        region: 'ZZ',
        lat: 10.7,
        lon: 20.4,
        position_source: 'list',
      });
      return tx.rev;
    }),
  );

  revs.push(
    store.write((tx) => {
      tx.upsert('nav_airway_leg', {
        leg_key: 'ZZ1|ZZW1|ZZ|ZZW2|ZZ',
        airway: 'ZZ1',
        from_key: 'ZZW1|ZZ|1060000|2030000',
        to_key: 'ZZW2|ZZ|1070000|2040000',
        from_ident: 'ZZW1',
        from_region: 'ZZ',
        from_lat: 10.6,
        from_lon: 20.3,
        to_ident: 'ZZW2',
        to_region: 'ZZ',
        to_lat: 10.7,
        to_lon: 20.4,
        min_lat: 10.6,
        max_lat: 10.7,
        min_lon: 20.3,
        max_lon: 20.4,
        dateline: 0,
      });
      // NULL and 0 are different answers: one end reported no displacement,
      // the other carried no value at all.
      tx.upsert('nav_runway', {
        rwy_key: 'ZZAA|15|0',
        airport_ident: 'ZZAA',
        length_m: 3000,
        width_m: 45,
        heading_deg: 152.5,
        primary_threshold_m: 0,
      });
      tx.upsert('nav_airport_frequency', {
        freq_key: 'ZZAA|3|118000000',
        airport_ident: 'ZZAA',
        freq_type: 3,
        frequency_hz: 118000000,
        name: 'TOWER',
      });
      return tx.rev;
    }),
  );

  // One procedure tree in one transaction: parents and children share a rev,
  // which is what makes the table order within a rev meaningful.
  revs.push(
    store.write((tx) => {
      tx.upsert('nav_procedure', {
        proc_key: 'ZZAA|SID|ZZDEP1',
        airport_ident: 'ZZAA',
        kind: 'SID',
        name: 'ZZDEP1',
      });
      tx.upsert('nav_procedure_transition', {
        trans_key: 'ZZAA|SID|ZZDEP1|common|',
        proc_key: 'ZZAA|SID|ZZDEP1',
        role: 'common',
        name: '',
      });
      tx.upsert('nav_procedure_leg', {
        trans_key: 'ZZAA|SID|ZZDEP1|common|',
        seq: 0,
        leg_type: 15,
        fix_ident: 'ZZW1',
        fix_region: 'ZZ',
        fix_lat: 10.6,
        fix_lon: 20.3,
      });
      tx.upsert('nav_procedure_leg', {
        trans_key: 'ZZAA|SID|ZZDEP1|common|',
        seq: 1,
        leg_type: 18,
        fix_ident: 'ZZW2',
        fix_region: 'ZZ',
        fix_lat: 10.7,
        fix_lon: 20.4,
      });
      return tx.rev;
    }),
  );

  revs.push(
    store.write((tx) => {
      tx.recordCoverage('W', 123, at, 2);
      tx.recordAbsent({ kind: 'V', ident: 'ZZNO', region: 'ZZ', reason: 'silent', at });
      return tx.rev;
    }),
  );

  return revs;
}

/** A world-sized airport index, written in the chunks the store is built for. */
export function fillAirports(store: NavdataStore, count: number, chunk = 2000): void {
  for (let start = 0; start < count; start += chunk) {
    const end = Math.min(start + chunk, count);
    store.write((tx) => {
      for (let i = start; i < end; i++) {
        tx.upsert('nav_airport', {
          ident: syntheticIdent(i),
          lat: -89 + ((i * 0.004283) % 178),
          lon: -179 + ((i * 0.008571) % 358),
          alt_m: (i % 4000) + 0.5,
          name: `SYNTHETIC FIELD ${i}`,
          position_source: 'list',
        });
      }
    });
  }
}

/** `Z` plus a base-32 counter: never a real ICAO code. */
export function syntheticIdent(index: number): string {
  return `Z${index.toString(32).toUpperCase().padStart(4, '0')}`;
}
