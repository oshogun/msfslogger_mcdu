// tests/navdata-detail.test.ts — tests src/navdata-detail.ts, the per-airport
// detail fetch, against a fake SimConnect handle and a real store in a temp
// directory.
//
// The simulator is not running and is not needed here. What these pin down is
// the handful of things that are expensive to get wrong and invisible when you
// do:
//
// 1. THE TREE COMES FROM THE RECORD IDS. `APPROACH_LEG` arrives under five
//    different parents and collapses to one entry name in the definition, so a
//    decoder that went by name could not tell a STAR's common legs from an
//    approach transition's. Records here carry a parent id and the tests assert
//    the legs land under the right transition.
// 2. A SID/STAR'S COMMON LEGS HANG STRAIGHT OFF DEPARTURE/ARRIVAL. Measured
//    live: with APPROACH_LEG opened only under the transitions, every STAR at
//    a large airport came back with ZERO legs.
// 3. NULL IS NOT 0. A displaced threshold that was not reported is NULL; one
//    reported as zero is 0. They render identically downstream, so a decoder
//    that substituted one for the other would be silently wrong for ever.
// 4. OUR BUG IS NEVER STORED AS A FACT ABOUT THE WORLD. 'absent' and 'failed'
//    write a nav_absent row — a replicated claim that this simulator install
//    does not have the airport. A decoder that throws, a record this build
//    cannot read and a store that will not write must not produce one.
//
// Every ident is synthetic, every database is under a fresh mkdtemp directory,
// and the only token anywhere is a sentinel asserted to appear nowhere.

import { afterEach, describe, expect, it } from 'vitest';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AIRPORT_DETAIL_DEFINITION,
  airportDetailSpec,
  approachName,
  collisionKeysFor,
  compareProcedureOrder,
  fetchAirportDetail,
  runwayLabel,
  type ProcedureOrderKeys,
} from '../src/navdata-detail';
import {
  FacilitySession,
  type FacilityDefinition,
  type FacilityNodeSpec,
} from '../src/navdata-facilities';
import type { NavdataStore } from '../src/navdata-store';
import { FakeFacilityConnection } from './helpers/fake-facility-connection';
import { encodeRecord, readerOver, throwingReader } from './helpers/facility-record';
import {
  REPO_ROOT,
  describeComparison,
  differingCopies,
  findCopies,
} from './helpers/contract-copies';
import { openFixtureStore, removeScratchDirs, scratchDir } from './helpers/navdata-fixture-store';

const SENTINEL_TOKEN = 'SENTINEL-NAVDATA-DETAIL-0000';

/** Record types, as the facilities API numbers them. */
const AIRPORT = 0;
const RUNWAY = 1;
const FREQUENCY = 3;
const APPROACH = 5;
const APPROACH_TRANSITION = 6;
const APPROACH_LEG = 7;
const FINAL_APPROACH_LEG = 8;
const MISSED_APPROACH_LEG = 9;
const DEPARTURE = 10;
const ARRIVAL = 11;
const RUNWAY_TRANSITION = 12;
const ENROUTE_TRANSITION = 13;
const THRESHOLD = 23;

const scratch: string[] = [];
const stores: NavdataStore[] = [];
const sessions: FacilitySession[] = [];
const logged: string[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.close('test over');
  while (stores.length > 0) stores.pop()?.close();
  while (scratch.length > 0) {
    fs.rmSync(scratch.pop() as string, { recursive: true, force: true, maxRetries: 10 });
  }
  removeScratchDirs();
  logged.length = 0;
});

const log = (level: string, message: string): void => {
  logged.push(`${level} ${message}`);
};

function freshStore(): NavdataStore {
  const store = openFixtureStore(scratchDir());
  stores.push(store);
  // Every nav_airport row comes from the bulk index; detail only ever updates
  // one the index already put there.
  store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZAA', detail_state: 'index' }));
  return store;
}

/** A session over a fake handle with the airport definition already built. */
async function preparedSession(handle: FakeFacilityConnection): Promise<{
  session: FacilitySession;
  definition: FacilityDefinition;
}> {
  const session = new FacilitySession(handle as never, { log, settleMs: 1 });
  sessions.push(session);
  const [definition] = await session.prepare([airportDetailSpec()]);
  return { session, definition };
}

/**
 * The request id, once the session has actually sent it. `fetch` clears the
 * definition gate and takes a concurrency slot before it sends, so a single
 * microtask is not enough and a fixed count of them would be a flake waiting
 * to happen.
 */
async function sentRequestId(handle: FakeFacilityConnection): Promise<number> {
  const before = handle.dataRequests.length;
  for (let i = 0; i < 100 && handle.dataRequests.length === before; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return handle.lastDataRequestId() as number;
}

/**
 * The members one record of `entry` really carries.
 *
 * The definition's map is keyed by ENTRY NAME, so an entry opened under several
 * parents comes back with its member list repeated once per opening —
 * APPROACH_LEG hangs off seven parents and answers with seven copies. A RECORD
 * carries the list once. Taking the map at face value is the mistake that makes
 * every leg at a real airport fail its size check, so the fixtures here are
 * built the way the simulator builds them and not the way the map reads.
 */
function recordMembers(definition: FacilityDefinition, entry: string): string[] {
  return [...new Set(definition.members.get(entry) ?? [])];
}

/** Emits one record of `entry` with the members the definition agreed to. */
function emit(
  handle: FakeFacilityConnection,
  definition: FacilityDefinition,
  requestId: number,
  type: number,
  entry: string,
  uid: number,
  parent: number,
  values: Readonly<Record<string, number | string>> = {},
): void {
  const members = recordMembers(definition, entry);
  handle.emitRecord(requestId, type, uid, parent, readerOver(encodeRecord(entry, members, values)));
}

/** Walks a definition spec looking for an entry point by path. */
function child(node: FacilityNodeSpec, entry: string): FacilityNodeSpec | undefined {
  return node.children?.find((c) => c.entry === entry);
}

describe('the airport detail definition', () => {
  it('opens APPROACH_LEG as a DIRECT child of DEPARTURE and ARRIVAL', () => {
    const root = airportDetailSpec().root;
    for (const parent of ['DEPARTURE', 'ARRIVAL']) {
      const procedure = child(root, parent);
      expect(procedure, parent).toBeDefined();
      // Without this edge a procedure's common legs are never requested and
      // the middle of every SID and STAR is missing, with nothing saying so.
      expect(child(procedure as FacilityNodeSpec, 'APPROACH_LEG'), parent).toBeDefined();
      expect(child(procedure as FacilityNodeSpec, 'RUNWAY_TRANSITION'), parent).toBeDefined();
      expect(child(procedure as FacilityNodeSpec, 'ENROUTE_TRANSITION'), parent).toBeDefined();
    }
  });

  it('opens the thresholds as CHILDREN of RUNWAY, where they are accepted', () => {
    const runway = child(airportDetailSpec().root, 'RUNWAY') as FacilityNodeSpec;
    expect(child(runway, 'PRIMARY_THRESHOLD')).toBeDefined();
    expect(child(runway, 'SECONDARY_THRESHOLD')).toBeDefined();
    // As RUNWAY fields these are refused outright, so they must not be there.
    expect(runway.aliases.flat()).not.toContain('PRIMARY_THRESHOLD');
    expect(runway.aliases.flat()).not.toContain('SECONDARY_THRESHOLD');
  });

  it('never opens the taxi network or the jetways', () => {
    const entries: string[] = [];
    const walk = (node: FacilityNodeSpec): void => {
      entries.push(node.entry);
      for (const c of node.children ?? []) walk(c);
    };
    walk(airportDetailSpec().root);
    for (const banned of ['TAXI_POINT', 'TAXI_PATH', 'TAXI_NAME', 'TAXI_PARKING', 'JETWAY']) {
      expect(entries).not.toContain(banned);
    }
  });

  it('sends every member in UPPER_SNAKE_CASE and one spelling each', () => {
    const walk = (node: FacilityNodeSpec): void => {
      for (const group of node.aliases) {
        expect(group).toHaveLength(1);
        expect(group[0]).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
      for (const c of node.children ?? []) walk(c);
    };
    walk(airportDetailSpec().root);
  });

  it('is prepared under a name the caller can look it up by', async () => {
    const handle = new FakeFacilityConnection();
    const { definition } = await preparedSession(handle);
    expect(definition.name).toBe(AIRPORT_DETAIL_DEFINITION);
    expect(definition.rejectedEntries).toEqual([]);
    expect(definition.rejectedMembers).toEqual([]);
  });

  it('reports APPROACH_LEG once per opening, which a record does NOT repeat', async () => {
    const handle = new FakeFacilityConnection();
    const { definition } = await preparedSession(handle);
    const reported = definition.members.get('APPROACH_LEG') ?? [];
    const distinct = new Set(reported);
    // Seven parents, one member list each: the map is keyed by entry name and
    // cannot say so any other way. A decoder that sized a record off this would
    // expect seven times the bytes and store nothing at any real airport.
    expect(reported.length).toBe(distinct.size * 7);
    expect(distinct.size).toBe(36);
  });
});

describe('the derived names', () => {
  it('pads a runway number and names its designator', () => {
    expect(runwayLabel(9, 1)).toBe('09L');
    expect(runwayLabel(27, 2)).toBe('27R');
    expect(runwayLabel(15, 0)).toBe('15');
    expect(runwayLabel(null, 1)).toBe('');
  });

  it('gives an approach a name from its type and its runway', () => {
    expect(approachName(4, 9, 1)).toBe('4-09L');
    expect(approachName(null, null, null)).toBe('-');
  });
});

describe('one airport, decoded', () => {
  /**
   * A small but complete airport: one runway with both thresholds, one
   * frequency, one approach with a transition, a final and a missed list, and
   * one STAR whose legs hang straight off ARRIVAL.
   */
  async function fetchFixture(store: NavdataStore): Promise<ReturnType<typeof fetchAirportDetail>> {
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 42 });
    const requestId = await sentRequestId(handle);

    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, {
      LATITUDE: 10.5,
      LONGITUDE: 20.25,
      ALTITUDE: 111.5,
      MAGVAR: 3,
      NAME: 'TEST ALPHA',
      REGION: 'ZZ',
      N_RUNWAYS: 1,
      N_APPROACHES: 1,
      N_DEPARTURES: 0,
      N_ARRIVALS: 1,
    });
    // Reported as 23/05: the primary end is the HIGHER number here, which is
    // why the key and the heading are taken from PRIMARY_* and never inferred.
    emit(handle, definition, requestId, RUNWAY, 'RUNWAY', 2, 1, {
      LATITUDE: 10.51,
      LONGITUDE: 20.26,
      ALTITUDE: 110,
      HEADING: 231.25,
      LENGTH: 2750.5,
      WIDTH: 42.5,
      PATTERN_ALTITUDE: 250.5,
      SLOPE: 0.25,
      TRUE_SLOPE: -0.25,
      SURFACE: 4,
      PRIMARY_NUMBER: 23,
      PRIMARY_DESIGNATOR: 0,
      SECONDARY_NUMBER: 5,
      SECONDARY_DESIGNATOR: 0,
      PRIMARY_ILS_ICAO: 'IZZA',
      PRIMARY_ILS_REGION: 'ZZ',
    });
    emit(handle, definition, requestId, THRESHOLD, 'PRIMARY_THRESHOLD', 3, 2, {
      LENGTH: 71.25,
      WIDTH: 42.5,
    });
    emit(handle, definition, requestId, THRESHOLD, 'SECONDARY_THRESHOLD', 4, 2, {
      LENGTH: 188.5,
      WIDTH: 42.5,
    });
    emit(handle, definition, requestId, FREQUENCY, 'FREQUENCY', 5, 1, {
      TYPE: 8,
      FREQUENCY: 123450000,
      NAME: 'TEST TOWER',
    });

    emit(handle, definition, requestId, APPROACH, 'APPROACH', 10, 1, {
      TYPE: 4,
      SUFFIX: '0',
      RUNWAY_NUMBER: 23,
      RUNWAY_DESIGNATOR: 0,
      FAF_ICAO: 'ZZFAF',
      FAF_REGION: 'ZZ',
      FAF_ALTITUDE: 600.5,
      FAF_HEADING: 231,
      MISSED_ALTITUDE: 1000.5,
      HAS_LNAV: 1,
      N_TRANSITIONS: 1,
      N_FINAL_APPROACH_LEGS: 2,
      N_MISSED_APPROACH_LEGS: 1,
    });
    emit(handle, definition, requestId, APPROACH_TRANSITION, 'APPROACH_TRANSITION', 11, 10, {
      TYPE: 1,
      IAF_ICAO: 'ZZIAF',
      IAF_REGION: 'ZZ',
      IAF_ALTITUDE: 1500.5,
      NAME: 'ZZIAF',
      N_APPROACH_LEGS: 1,
    });
    emit(handle, definition, requestId, APPROACH_LEG, 'APPROACH_LEG', 12, 11, {
      TYPE: 15,
      FIX_ICAO: 'ZZIAF',
      FIX_REGION: 'ZZ',
      FIX_TYPE: 'W',
      FIX_LATITUDE: 10.7,
      FIX_LONGITUDE: 20.7,
      IS_IF: 1,
      SPEED_LIMIT: -1,
    });
    emit(handle, definition, requestId, FINAL_APPROACH_LEG, 'FINAL_APPROACH_LEG', 13, 10, {
      TYPE: 4,
      FIX_ICAO: 'ZZFAF',
      FIX_REGION: 'ZZ',
      FIX_TYPE: 'W',
      FIX_LATITUDE: 10.6,
      FIX_LONGITUDE: 20.6,
      ALTITUDE1: 600.5,
      APPROACH_ALT_DESC: 1,
      IS_FAF: 1,
    });
    emit(handle, definition, requestId, FINAL_APPROACH_LEG, 'FINAL_APPROACH_LEG', 14, 10, {
      TYPE: 4,
      FIX_ICAO: 'ZZRWY',
      FIX_REGION: 'ZZ',
      FIX_TYPE: 'R',
      FIX_LATITUDE: 10.55,
      FIX_LONGITUDE: 20.55,
      IS_MAP: 1,
    });
    emit(handle, definition, requestId, MISSED_APPROACH_LEG, 'MISSED_APPROACH_LEG', 15, 10, {
      TYPE: 2,
      ALTITUDE1: 1000.5,
    });

    // A STAR: two common legs straight off ARRIVAL, then a runway transition
    // and an enroute transition with one leg each.
    emit(handle, definition, requestId, ARRIVAL, 'ARRIVAL', 20, 1, {
      NAME: 'ZZST1A',
      N_RUNWAY_TRANSITIONS: 1,
      N_ENROUTE_TRANSITIONS: 1,
      N_APPROACH_LEGS: 2,
    });
    emit(handle, definition, requestId, APPROACH_LEG, 'APPROACH_LEG', 21, 20, {
      TYPE: 18,
      FIX_ICAO: 'ZZCOM1',
      FIX_REGION: 'ZZ',
      FIX_TYPE: 'W',
      FIX_LATITUDE: 11,
      FIX_LONGITUDE: 21,
      ALTITUDE1: 4000.5,
    });
    emit(handle, definition, requestId, APPROACH_LEG, 'APPROACH_LEG', 22, 20, {
      TYPE: 18,
      FIX_ICAO: 'ZZCOM2',
      FIX_REGION: 'ZZ',
      FIX_TYPE: 'W',
      FIX_LATITUDE: 10.9,
      FIX_LONGITUDE: 20.9,
    });
    emit(handle, definition, requestId, RUNWAY_TRANSITION, 'RUNWAY_TRANSITION', 23, 20, {
      RUNWAY_NUMBER: 23,
      RUNWAY_DESIGNATOR: 0,
      N_APPROACH_LEGS: 1,
    });
    emit(handle, definition, requestId, APPROACH_LEG, 'APPROACH_LEG', 24, 23, {
      TYPE: 18,
      FIX_ICAO: 'ZZRWT',
      FIX_REGION: 'ZZ',
      FIX_TYPE: 'W',
      FIX_LATITUDE: 10.8,
      FIX_LONGITUDE: 20.8,
    });
    emit(handle, definition, requestId, ENROUTE_TRANSITION, 'ENROUTE_TRANSITION', 25, 20, {
      NAME: 'ZZENR',
      N_APPROACH_LEGS: 1,
    });
    emit(handle, definition, requestId, APPROACH_LEG, 'APPROACH_LEG', 26, 25, {
      TYPE: 18,
      FIX_ICAO: 'ZZENR',
      FIX_REGION: 'ZZ',
      FIX_TYPE: 'W',
      FIX_LATITUDE: 11.5,
      FIX_LONGITUDE: 21.5,
    });

    handle.emitDataEnd(requestId);
    return pending;
  }

  it('lands the airport header, the runway, the frequency and the procedures', async () => {
    const store = freshStore();
    const result = await fetchFixture(store);

    expect(result.status).toBe('detail');
    expect(result.runways).toBe(1);
    expect(result.frequencies).toBe(1);
    expect(result.procedures).toBe(2);
    expect(result.undecoded).toBe(0);

    const airport = store.row('nav_airport', { ident: 'ZZAA' });
    expect(airport?.detail_state).toBe('detail');
    expect(airport?.detail_fetched_at).toBe(42);
    expect(airport?.detail_runways).toBe(1);
    expect(airport?.detail_procedures).toBe(2);
    expect(airport?.name).toBe('TEST ALPHA');
    expect(airport?.region).toBe('ZZ');
    expect(airport?.n_arrivals).toBe(1);
    expect(airport?.position_source).toBe('facility');
    expect(airport?.lat).toBeCloseTo(10.5, 10);
  });

  it('keys the runway off the PRIMARY end and stores the heading unturned', async () => {
    const store = freshStore();
    await fetchFixture(store);

    // 23/05: the primary end is the higher number. A matcher that assumed the
    // lower one would draw every approach here 180 degrees reversed.
    const runway = store.row('nav_runway', { rwy_key: 'ZZAA|23|0' });
    expect(runway).not.toBeNull();
    expect(runway?.primary_number).toBe(23);
    expect(runway?.secondary_number).toBe(5);
    // TRUE, not magnetic: no variation is applied to this anywhere.
    expect(runway?.heading_deg).toBeCloseTo(231.25, 3);
    // The CENTRE of the runway, not a threshold.
    expect(runway?.lat).toBeCloseTo(10.51, 6);
    expect(runway?.length_m).toBeCloseTo(2750.5, 2);
    expect(runway?.primary_ils_ident).toBe('IZZA');
  });

  it('pairs the two threshold records with the ends by the order they arrive', async () => {
    const store = freshStore();
    await fetchFixture(store);

    const runway = store.row('nav_runway', { rwy_key: 'ZZAA|23|0' });
    expect(runway?.primary_threshold_m).toBeCloseTo(71.25, 2);
    expect(runway?.secondary_threshold_m).toBeCloseTo(188.5, 2);
  });

  it('stores the frequency in whole hertz under its own key', async () => {
    const store = freshStore();
    await fetchFixture(store);

    const frequency = store.row('nav_airport_frequency', { freq_key: 'ZZAA|8|123450000' });
    expect(frequency?.frequency_hz).toBe(123450000);
    expect(frequency?.name).toBe('TEST TOWER');
  });

  it('gives a STAR its common legs, in the order the simulator sent them', async () => {
    const store = freshStore();
    await fetchFixture(store);

    // The edge the whole tree shape turns on: these legs arrived under ARRIVAL
    // itself, not under a transition, and they are the middle of the procedure.
    const common = 'ZZAA|STAR|ZZST1A|||' + '|common|';
    expect(store.row('nav_procedure_transition', { trans_key: common })?.n_legs).toBe(2);
    expect(store.row('nav_procedure_leg', { trans_key: common, seq: 0 })?.fix_ident).toBe('ZZCOM1');
    expect(store.row('nav_procedure_leg', { trans_key: common, seq: 1 })?.fix_ident).toBe('ZZCOM2');
    expect(store.row('nav_procedure_leg', { trans_key: common, seq: 0 })?.altitude1_m).toBeCloseTo(
      4000.5,
      1,
    );
  });

  it('keeps each leg list under its own parent rather than collapsing them', async () => {
    const store = freshStore();
    await fetchFixture(store);

    // All four of these arrived as APPROACH_LEG, which is ONE entry in the
    // definition's member map. Only the parent id tells them apart.
    const star = 'ZZAA|STAR|ZZST1A|||';
    const approach = 'ZZAA|APPROACH|4-23|23|0|0';
    expect(store.row('nav_procedure_leg', { trans_key: `${star}|runway|23`, seq: 0 })?.fix_ident).toBe(
      'ZZRWT',
    );
    expect(
      store.row('nav_procedure_leg', { trans_key: `${star}|enroute|ZZENR`, seq: 0 })?.fix_ident,
    ).toBe('ZZENR');
    expect(
      store.row('nav_procedure_leg', { trans_key: `${approach}|approach|ZZIAF`, seq: 0 })?.fix_ident,
    ).toBe('ZZIAF');
    expect(store.row('nav_procedure_leg', { trans_key: `${approach}|final|`, seq: 0 })?.fix_ident).toBe(
      'ZZFAF',
    );
  });

  it('stores the final and missed lists as transitions of their own', async () => {
    const store = freshStore();
    await fetchFixture(store);

    const approach = 'ZZAA|APPROACH|4-23|23|0|0';
    const final = store.row('nav_procedure_transition', { trans_key: `${approach}|final|` });
    expect(final?.role).toBe('final');
    expect(final?.n_legs).toBe(2);
    const missed = store.row('nav_procedure_transition', { trans_key: `${approach}|missed|` });
    expect(missed?.role).toBe('missed');
    expect(missed?.n_legs).toBe(1);
    expect(store.row('nav_procedure_leg', { trans_key: `${approach}|missed|`, seq: 0 })?.leg_type).toBe(
      2,
    );
  });

  it('stores the approach header, including its FAF and its minima flags', async () => {
    const store = freshStore();
    await fetchFixture(store);

    const approach = store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|4-23|23|0|0' });
    expect(approach?.kind).toBe('APPROACH');
    expect(approach?.approach_type).toBe(4);
    expect(approach?.suffix).toBe('0');
    expect(approach?.faf_ident).toBe('ZZFAF');
    expect(approach?.faf_alt_m).toBeCloseTo(600.5, 2);
    expect(approach?.has_lnav).toBe(1);
    expect(approach?.has_lpv).toBe(0);
    expect(approach?.n_transitions).toBe(1);
  });

  it('keeps the leg flags and the speed limit the simulator actually reported', async () => {
    const store = freshStore();
    await fetchFixture(store);

    const leg = store.row('nav_procedure_leg', {
      trans_key: 'ZZAA|APPROACH|4-23|23|0|0|approach|ZZIAF',
      seq: 0,
    });
    expect(leg?.leg_type).toBe(15);
    expect(leg?.is_if).toBe(1);
    expect(leg?.is_faf).toBe(0);
    expect(leg?.fix_type).toBe('W');
    // -1 is the simulator's "no limit". Rewriting it as NULL would lose the
    // difference between that and a member this fetch did not carry.
    expect(leg?.speed_limit_kt).toBeCloseTo(-1, 6);
  });

  it('re-ships none of the tree the second time it comes back unchanged', async () => {
    const store = freshStore();
    const first = await fetchFixture(store);
    expect(first.written).toBeGreaterThan(0);
    const runwayRev = store.row('nav_runway', { rwy_key: 'ZZAA|23|0' })?.rev;
    const legRev = store.row('nav_procedure_leg', {
      trans_key: 'ZZAA|STAR|ZZST1A||||common|',
      seq: 0,
    })?.rev;

    const second = await fetchFixture(store);
    expect(second.status).toBe('detail');
    // A re-fetch of an unchanged world must not re-ship its rows, or the
    // incremental stream never drains. The one row it does write is the
    // airport's own state coming back from 'pending', which is a real change.
    expect(second.written).toBe(1);
    expect(store.row('nav_runway', { rwy_key: 'ZZAA|23|0' })?.rev).toBe(runwayRev);
    expect(
      store.row('nav_procedure_leg', { trans_key: 'ZZAA|STAR|ZZST1A||||common|', seq: 0 })?.rev,
    ).toBe(legRev);
  });

  it('never lets the sentinel token reach a result or a log line', async () => {
    const store = freshStore();
    const result = await fetchFixture(store);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_TOKEN);
    expect(logged.join('\n')).not.toContain(SENTINEL_TOKEN);
  });
});

describe('an airport with no procedures', () => {
  it('is a fetched airport, not a missing one', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 7 });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, {
      LATITUDE: 12.25,
      LONGITUDE: 22.75,
      ALTITUDE: 1500.5,
      MAGVAR: 2,
      NAME: 'TEST QUIET',
      REGION: 'ZZ',
      N_RUNWAYS: 1,
      N_APPROACHES: 0,
      N_DEPARTURES: 0,
      N_ARRIVALS: 0,
    });
    handle.emitDataEnd(requestId);
    const result = await pending;

    expect(result.status).toBe('detail');
    expect(result.procedures).toBe(0);
    const airport = store.row('nav_airport', { ident: 'ZZAA' });
    // 'absent' would be a claim that the simulator does not have the airport.
    // It has it; it simply has no instrument procedures for it.
    expect(airport?.detail_state).toBe('detail');
    expect(airport?.detail_procedures).toBe(0);
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' })).toBeNull();
  });
});

describe('the detail state lifecycle', () => {
  it('marks the airport pending while the request is out', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log });
    const requestId = await sentRequestId(handle);

    // Written before the send, so a sidecar that dies mid-fetch leaves a row
    // that the next open can find and clear.
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('pending');

    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, { N_RUNWAYS: 0 });
    handle.emitDataEnd(requestId);
    await pending;
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('detail');
  });

  it('records an ident the simulator answers nothing for as absent', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);

    const result = await fetchAirportDetail(session, store, definition, 'ZZAA', {
      log,
      now: () => 99,
      timeoutMs: 5,
    });

    expect(result.status).toBe('absent');
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('absent');
    const absent = store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' });
    expect(absent?.kind).toBe('A');
    expect(absent?.reason).toBe('silent');
    expect(absent?.first_seen_at).toBe(99);
  });

  it('reads an immediate ERROR(1) as an airport this install does not have', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 5 });
    await sentRequestId(handle);
    // Measured: an ident the simulator does not have answers with this at once
    // and never with the silence a missing navaid answers with.
    handle.emitException(handle.dataRequests.at(-1)?.sendId as number, 'ERROR', 1, 3);
    const result = await pending;

    // 'absent' is a fact about the simulator and the server clears a manual
    // request on it. 'failed' is a fault in this code, and would leave the
    // user's "fetch detail" spinning on an airport that simply is not there.
    expect(result.status).toBe('absent');
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('absent');
    // The reason stays what actually happened: an exception is stronger
    // evidence than silence, and it is what makes the row re-checkable.
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' })?.reason).toBe(
      'exception',
    );
  });

  it('will not call an airport absent once its own records have arrived', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 5 });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, { N_RUNWAYS: 1 });
    // The simulator answered, so whatever went wrong afterwards, the airport
    // exists. Only an IMMEDIATE refusal is evidence that it does not.
    handle.emitException(handle.dataRequests.at(-1)?.sendId as number, 'ERROR', 1, 3);
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('failed');
  });

  it('keeps a refusal that means OUR request was wrong as failed', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 5 });
    await sentRequestId(handle);
    // A member the simulator would not accept is a defect in what THIS build
    // sent. Recorded as an absence it would teach the store that the world is
    // missing an airport because we asked for it wrongly.
    handle.emitException(handle.dataRequests.at(-1)?.sendId as number, 'DATA_ERROR', 20, 0);
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('failed');
    expect(result.reason).toContain('refused');
    // AND NO ABSENCE. `nav_absent` is a durable, replicated claim that this
    // install does not have the airport, and the server's demand predicate acts
    // on it. A malformed request is a fault in THIS code; recording it here
    // would turn our bug into data about the world.
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' })).toBeNull();
  });

  it('puts the state back when the link drops mid-fetch, and claims nothing', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, { N_RUNWAYS: 1 });
    session.close('the simulator went away');
    const result = await pending;

    expect(result.status).toBe('aborted');
    // A disconnect is evidence about the link and about nothing else.
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('index');
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' })).toBeNull();
    expect(store.row('nav_runway', { rwy_key: 'ZZAA|0|0' })).toBeNull();
  });

  it('does not demote an airport whose detail was already fetched', async () => {
    const store = freshStore();
    store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZAA', detail_state: 'detail' }));
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log });
    await sentRequestId(handle);
    session.close('the simulator went away');
    await pending;

    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('detail');
  });
});

describe('a fault in this code is never stored as a fact about the world', () => {
  it('a decoder that throws produces no absence and no failed state', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log });
    const requestId = await sentRequestId(handle);
    handle.emitRecord(requestId, AIRPORT, 1, 0, throwingReader());
    const result = await pending;

    // The session settles a throwing decoder as aborted precisely so that this
    // cannot become a durable claim that the simulator lacks the airport.
    expect(result.status).toBe('aborted');
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' })).toBeNull();
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('index');
  });

  it('a record this build cannot read is reported, not stored and not blamed on the simulator', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log });
    const requestId = await sentRequestId(handle);
    // A record two bytes short of what the agreed member list says. Read
    // anyway, it would put plausible numbers in the wrong columns.
    const members = definition.members.get('AIRPORT') ?? [];
    const short = encodeRecord('AIRPORT', members, { N_RUNWAYS: 1 }).subarray(0, -2);
    handle.emitRecord(requestId, AIRPORT, 1, 0, readerOver(short));
    handle.emitDataEnd(requestId);
    const result = await pending;

    expect(result.status).toBe('undecodable');
    expect(result.undecoded).toBe(1);
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' })).toBeNull();
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('index');
    expect(logged.join('\n')).toContain('nothing was stored for it');
  });

  it('a store that will not write leaves no half-written tree and no absence', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    let calls = 0;
    const real = store.write.bind(store);
    const brittle = {
      ...store,
      row: store.row.bind(store),
      write: <T>(fn: (tx: never) => T): T => {
        // The first write is the pending mark; the one that carries the tree
        // is the one that fails.
        if (++calls === 2) throw new Error('disk is full');
        return real(fn as never);
      },
    } as unknown as NavdataStore;

    const pending = fetchAirportDetail(session, brittle, definition, 'ZZAA', { log });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, { N_RUNWAYS: 1 });
    handle.emitDataEnd(requestId);
    const result = await pending;

    expect(result.status).toBe('undecodable');
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZAA', region: '' })).toBeNull();
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('index');
  });

  it('answers a missing store with a status rather than an exception', async () => {
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const result = await fetchAirportDetail(session, null, definition, 'ZZAA', { log });
    expect(result.status).toBe('disabled');
    expect(result.reason).toContain('no store');
  });
});

// ── The shared collision vectors ──────────────────────────────────────────────

interface VectorRecord {
  readonly id: string;
  readonly fafIdent: string | null;
  readonly nTransitions: number | null;
  readonly missedLegCount: number | null;
  readonly missedAltM: number | string | null;
}

interface CollisionVector {
  readonly name: string;
  readonly baseKey: string;
  readonly orderIndependent: boolean;
  readonly records: readonly VectorRecord[];
  readonly first: string;
  readonly expected: Readonly<Record<string, string>>;
  readonly expectedReversed: Readonly<Record<string, string>>;
}

/**
 * The vectors are DATA, not a fixture, and the file is the contract.
 *
 * The msfslogger server orders the same colliding pairs with its own
 * implementation and shares no code with this repository, so it loads these
 * same bytes into its own suite. A copy also sits with the run's contracts for
 * hand-off; the two are byte-identical and neither may be edited alone.
 */
const VECTOR_FILE_NAME = 'approach-collision-vectors.json';

const VECTORS: readonly CollisionVector[] = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', VECTOR_FILE_NAME), 'utf8'),
  ) as { vectors: CollisionVector[] }
).vectors;

/** JSON has no NaN literal, so the file spells it and the loader restores it. */
function orderKeys(record: VectorRecord, arrivalIndex: number): ProcedureOrderKeys {
  const altitude = record.missedAltM;
  return {
    fafIdent: record.fafIdent,
    nTransitions: record.nTransitions,
    missedLegCount: record.missedLegCount,
    missedAltM: altitude === 'NaN' ? Number.NaN : (altitude as number | null),
    arrivalIndex,
  };
}

function keysFor(vector: CollisionVector, records: readonly VectorRecord[]): Record<string, string> {
  const assigned = collisionKeysFor(
    vector.baseKey,
    records.map((record, index) => orderKeys(record, index)),
  );
  const byId: Record<string, string> = {};
  records.forEach((record, index) => {
    byId[record.id] = assigned[index];
  });
  return byId;
}

const CANONICAL_VECTORS = path.resolve(__dirname, 'fixtures', VECTOR_FILE_NAME);

describe('the shared vectors exist in exactly one form', () => {
  it('finds no copy in this checkout that differs from the one the suite loads', () => {
    const others = findCopies(REPO_ROOT, VECTOR_FILE_NAME).filter(
      (file) => file !== CANONICAL_VECTORS,
    );
    console.info(describeComparison(VECTOR_FILE_NAME, others));
    expect(differingCopies(others, fs.readFileSync(CANONICAL_VECTORS))).toEqual([]);
  });

  it('WOULD fail if a copy drifted, by one byte', () => {
    // The tripwire proving itself. Without this, the test above is green both
    // when the copies match and when the search silently found nothing.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navdata-vectors-'));
    scratch.push(root);
    const canonical = path.join(root, 'canonical', VECTOR_FILE_NAME);
    const drifted = path.join(root, 'handed-over', VECTOR_FILE_NAME);
    const same = path.join(root, 'third', VECTOR_FILE_NAME);
    for (const file of [canonical, drifted, same]) fs.mkdirSync(path.dirname(file));
    const bytes = fs.readFileSync(CANONICAL_VECTORS);
    fs.writeFileSync(canonical, bytes);
    fs.writeFileSync(same, bytes);
    fs.writeFileSync(drifted, Buffer.concat([bytes, Buffer.from(' ')]));

    const copies = findCopies(root, VECTOR_FILE_NAME);
    expect(copies).toHaveLength(3);
    const others = copies.filter((file) => file !== path.resolve(canonical));
    expect(differingCopies(others, bytes)).toEqual([path.resolve(drifted)]);
  });
});

describe('procedures that key alike', () => {
  it('loads the shared vectors', () => {
    expect(VECTORS.length).toBeGreaterThan(0);
  });

  for (const vector of VECTORS) {
    it(`orders: ${vector.name}`, () => {
      expect(keysFor(vector, vector.records)).toEqual(vector.expected);
    });

    it(`orders the same fed backwards: ${vector.name}`, () => {
      // THE PROPERTY THAT MATTERS. Arrival order must be unreachable except as
      // the final tiebreak, so a navdata update that re-ordered the records
      // cannot move real content between two keys that both still exist.
      expect(keysFor(vector, [...vector.records].reverse())).toEqual(vector.expectedReversed);
      if (vector.orderIndependent) {
        expect(vector.expectedReversed).toEqual(vector.expected);
      } else {
        // The single exception, and it is declared in the file: records that
        // are identical on every member the API exposes have nothing else to
        // be ordered by.
        expect(vector.expectedReversed).not.toEqual(vector.expected);
      }
    });

    it(`names the first: ${vector.name}`, () => {
      expect(vector.expected[vector.first]).toBe(vector.baseKey);
      // There is never a #1: a procedure that collides with nothing must
      // produce exactly the key the base derivation produces.
      for (const key of Object.values(vector.expected)) {
        expect(key.endsWith('#1')).toBe(false);
      }
    });
  }

  it('leaves a procedure that collides with nothing exactly as it was', () => {
    expect(collisionKeysFor('ZZAA|APPROACH|4-09L|9|1|0', [
      { fafIdent: 'ZZF', nTransitions: 1, missedLegCount: 1, missedAltM: 100, arrivalIndex: 0 },
    ])).toEqual(['ZZAA|APPROACH|4-09L|9|1|0']);
  });

  it('treats null, undefined, an empty string and NaN alike as absent', () => {
    const present: ProcedureOrderKeys = {
      fafIdent: 'ZZF',
      nTransitions: 1,
      missedLegCount: 1,
      missedAltM: 1,
      arrivalIndex: 1,
    };
    const absent: readonly (string | null)[] = ['', null];
    for (const faf of absent) {
      // The absent one arrives FIRST and still sorts last.
      expect(compareProcedureOrder({ ...present, fafIdent: faf, arrivalIndex: 0 }, present)).toBe(1);
    }
    expect(
      compareProcedureOrder(
        { ...present, missedAltM: Number.NaN, arrivalIndex: 0 },
        { ...present, missedAltM: 5 },
      ),
    ).toBe(1);
  });
});

describe('two approaches that key alike, through the decoder', () => {
  /** Emits an airport with two approaches sharing a base key. */
  async function fetchColliding(
    store: NavdataStore,
    order: readonly { faf: string; transitions: number }[],
  ): Promise<ReturnType<typeof fetchAirportDetail>> {
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 9 });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, { N_APPROACHES: 2 });
    order.forEach((approach, index) => {
      const uid = 10 + index * 10;
      // Same type, same runway, same suffix: nothing in the key tells them
      // apart, which is the shape of every collision this rule exists for.
      emit(handle, definition, requestId, APPROACH, 'APPROACH', uid, 1, {
        TYPE: 2,
        SUFFIX: '0',
        RUNWAY_NUMBER: 12,
        RUNWAY_DESIGNATOR: 0,
        FAF_ICAO: approach.faf,
        FAF_REGION: 'ZZ',
        N_TRANSITIONS: approach.transitions,
        N_FINAL_APPROACH_LEGS: 1,
      });
      emit(handle, definition, requestId, FINAL_APPROACH_LEG, 'FINAL_APPROACH_LEG', uid + 1, uid, {
        TYPE: 4,
        FIX_ICAO: approach.faf,
        FIX_REGION: 'ZZ',
        FIX_TYPE: 'W',
        FIX_LATITUDE: 10 + index,
        FIX_LONGITUDE: 20 + index,
      });
    });
    handle.emitDataEnd(requestId);
    return pending;
  }

  it('keeps BOTH, with the base key going to the smaller FAF', async () => {
    const store = freshStore();
    const result = await fetchColliding(store, [
      { faf: 'ZZFBB', transitions: 5 },
      { faf: 'ZZFAA', transitions: 3 },
    ]);

    expect(result.status).toBe('detail');
    expect(result.procedures).toBe(2);
    expect(result.collisions).toBe(1);
    // 'ZZFAA' < 'ZZFBB', and it arrived SECOND.
    const base = store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0' });
    expect(base?.faf_ident).toBe('ZZFAA');
    const second = store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0#2' });
    expect(second?.faf_ident).toBe('ZZFBB');
  });

  it('gives each one its own legs instead of one overwriting the other', async () => {
    const store = freshStore();
    await fetchColliding(store, [
      { faf: 'ZZFBB', transitions: 5 },
      { faf: 'ZZFAA', transitions: 3 },
    ]);

    // The old failure: the second approach's leg list re-used seq 0..n under
    // the first's transition key and silently replaced it.
    expect(
      store.row('nav_procedure_leg', { trans_key: 'ZZAA|APPROACH|2-12|12|0|0|final|', seq: 0 })
        ?.fix_ident,
    ).toBe('ZZFAA');
    expect(
      store.row('nav_procedure_leg', { trans_key: 'ZZAA|APPROACH|2-12|12|0|0#2|final|', seq: 0 })
        ?.fix_ident,
    ).toBe('ZZFBB');
  });

  it('puts the same key on the same approach whichever order they arrive in', async () => {
    const forward = freshStore();
    await fetchColliding(forward, [
      { faf: 'ZZFBB', transitions: 5 },
      { faf: 'ZZFAA', transitions: 3 },
    ]);
    const backward = freshStore();
    await fetchColliding(backward, [
      { faf: 'ZZFAA', transitions: 3 },
      { faf: 'ZZFBB', transitions: 5 },
    ]);

    for (const store of [forward, backward]) {
      expect(store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0' })?.faf_ident).toBe(
        'ZZFAA',
      );
      expect(
        store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0#2' })?.faf_ident,
      ).toBe('ZZFBB');
    }
  });

  it('counts and LOGS the collision rather than losing one quietly', async () => {
    const store = freshStore();
    const result = await fetchColliding(store, [
      { faf: 'ZZFBB', transitions: 5 },
      { faf: 'ZZFAA', transitions: 3 },
    ]);

    expect(result.collisions).toBe(1);
    const warning = logged.find((line) => line.startsWith('warn') && line.includes('keyed alike'));
    expect(warning).toBeDefined();
    expect(warning).toContain('ZZAA');
    expect(warning).toContain('type 2');
    expect(warning).toContain('runway 12');
    expect(warning).toContain('#2');
  });

  it('separates a three-way collision into the base, #2 and #3', async () => {
    const store = freshStore();
    const result = await fetchColliding(store, [
      { faf: 'ZZFCC', transitions: 1 },
      { faf: 'ZZFAA', transitions: 1 },
      { faf: 'ZZFBB', transitions: 1 },
    ]);

    expect(result.procedures).toBe(3);
    expect(result.collisions).toBe(2);
    expect(store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0' })?.faf_ident).toBe(
      'ZZFAA',
    );
    expect(store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0#2' })?.faf_ident).toBe(
      'ZZFBB',
    );
    expect(store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0#3' })?.faf_ident).toBe(
      'ZZFCC',
    );
  });

  it('reports no collision for an airport whose approaches all key apart', async () => {
    const store = freshStore();
    const result = await fetchColliding(store, [{ faf: 'ZZFAA', transitions: 3 }]);
    expect(result.collisions).toBe(0);
    expect(store.row('nav_procedure', { proc_key: 'ZZAA|APPROACH|2-12|12|0|0' })).not.toBeNull();
    expect(logged.some((line) => line.includes('keyed alike'))).toBe(false);
  });
});

describe('a transition that keys like another is refused, not merged', () => {
  it('counts it rather than letting one leg list overwrite the other', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, { N_DEPARTURES: 1 });
    emit(handle, definition, requestId, DEPARTURE, 'DEPARTURE', 20, 1, {
      NAME: 'ZZSID1',
      N_RUNWAY_TRANSITIONS: 2,
    });
    // Two runway transitions for the SAME runway. There is no agreed
    // disambiguator for a transition, and merging them would give the second
    // list seq 0..n under the first's key and silently replace it — so the
    // whole airport is discarded instead of storing a tree that is wrong.
    for (const uid of [21, 23]) {
      emit(handle, definition, requestId, RUNWAY_TRANSITION, 'RUNWAY_TRANSITION', uid, 20, {
        RUNWAY_NUMBER: 9,
        RUNWAY_DESIGNATOR: 1,
        N_APPROACH_LEGS: 1,
      });
      emit(handle, definition, requestId, APPROACH_LEG, 'APPROACH_LEG', uid + 1, uid, {
        TYPE: 18,
        FIX_ICAO: `ZZF${uid}`,
        FIX_REGION: 'ZZ',
        FIX_LATITUDE: 10.65,
        FIX_LONGITUDE: 20.65,
      });
    }
    handle.emitDataEnd(requestId);
    const result = await pending;

    expect(result.status).toBe('undecodable');
    expect(result.undecoded).toBe(1);
    expect(store.row('nav_procedure', { proc_key: 'ZZAA|STAR|ZZSID1|||' })).toBeNull();
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.detail_state).toBe('index');
  });
});

describe('a value the fetch did not carry is NULL, never a substitute', () => {
  it('leaves a stored value alone when the simulator refused the member', async () => {
    const store = freshStore();
    // What the index and an earlier, fuller fetch already knew.
    store.write((tx) => {
      tx.upsert('nav_airport', { ident: 'ZZAA', magvar: 7.5 });
      tx.upsert('nav_runway', { rwy_key: 'ZZAA|23|0', airport_ident: 'ZZAA', slope_deg: 0.25 });
    });

    const handle = new FakeFacilityConnection();
    // A build that refuses a member is the reason the definition is probed at
    // all, and the pruned tree is what a record then carries.
    handle.rejectedMembers.add('MAGVAR');
    handle.rejectedMembers.add('SLOPE');
    const { session, definition } = await preparedSession(handle);
    expect(definition.rejectedMembers).toContain('AIRPORT.MAGVAR');
    expect(definition.members.get('AIRPORT')).not.toContain('MAGVAR');

    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 3 });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, { N_RUNWAYS: 1 });
    emit(handle, definition, requestId, RUNWAY, 'RUNWAY', 2, 1, {
      LATITUDE: 10.51,
      LONGITUDE: 20.26,
      PRIMARY_NUMBER: 23,
      PRIMARY_DESIGNATOR: 0,
    });
    handle.emitDataEnd(requestId);
    expect((await pending).status).toBe('detail');

    // A member that was never fetched must not be written as 0: under the merge
    // rule an incoming NULL leaves the stored value alone while an incoming 0
    // OVERWRITES it, and 0 renders exactly like a real zero, so the loss is
    // invisible everywhere afterwards.
    expect(store.row('nav_airport', { ident: 'ZZAA' })?.magvar).toBeCloseTo(7.5, 6);
    expect(store.row('nav_runway', { rwy_key: 'ZZAA|23|0' })?.slope_deg).toBeCloseTo(0.25, 6);
  });
});

describe('a coordinate that fails the validity test is no coordinate', () => {
  async function fetchWithPosition(
    store: NavdataStore,
    lat: number,
    lon: number,
  ): Promise<ReturnType<typeof fetchAirportDetail>> {
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchAirportDetail(session, store, definition, 'ZZAA', { log, now: () => 4 });
    const requestId = await sentRequestId(handle);
    emit(handle, definition, requestId, AIRPORT, 'AIRPORT', 1, 0, {
      LATITUDE: lat,
      LONGITUDE: lon,
      NAME: 'TEST ALPHA',
      N_RUNWAYS: 1,
    });
    emit(handle, definition, requestId, RUNWAY, 'RUNWAY', 2, 1, {
      LATITUDE: lat,
      LONGITUDE: lon,
      PRIMARY_NUMBER: 23,
      PRIMARY_DESIGNATOR: 0,
      LENGTH: 3000,
    });
    handle.emitDataEnd(requestId);
    return pending;
  }

  /** The index position this airport already had, from the bulk list. */
  function indexed(store: NavdataStore): void {
    store.write((tx) =>
      tx.upsert('nav_airport', {
        ident: 'ZZAA',
        lat: 10.5,
        lon: 20.25,
        position_source: 'list',
      }),
    );
  }

  it('refuses a zeroed position, which would otherwise be UNREPAIRABLE', async () => {
    const store = freshStore();
    indexed(store);
    const result = await fetchWithPosition(store, 0, 0);

    expect(result.status).toBe('detail');
    const airport = store.row('nav_airport', { ident: 'ZZAA' });
    // (0, 0) is in the Gulf of Guinea and is what an unpopulated FLOAT64 pair
    // reads as. Stored with source 'facility' it would OUTRANK the index, and
    // no later bulk pass could ever put the airport back where it belongs.
    expect(airport?.lat).toBeCloseTo(10.5, 6);
    expect(airport?.lon).toBeCloseTo(20.25, 6);
    expect(airport?.position_source).toBe('list');
    // The rest of the record is fine and is still stored.
    expect(airport?.name).toBe('TEST ALPHA');
    // A runway carries no position source, so a zeroed centre is repairable —
    // but it is still not worth drawing in the Gulf of Guinea.
    const runway = store.row('nav_runway', { rwy_key: 'ZZAA|23|0' });
    expect(runway?.lat).toBeNull();
    expect(runway?.length_m).toBeCloseTo(3000, 3);
  });

  it('refuses a position outside the range of the earth', async () => {
    const store = freshStore();
    indexed(store);
    await fetchWithPosition(store, 91, 20.25);

    const airport = store.row('nav_airport', { ident: 'ZZAA' });
    expect(airport?.lat).toBeCloseTo(10.5, 6);
    expect(airport?.position_source).toBe('list');
  });

  it('accepts a real position and lets it outrank the index', async () => {
    const store = freshStore();
    indexed(store);
    await fetchWithPosition(store, 10.55, 20.3);

    const airport = store.row('nav_airport', { ident: 'ZZAA' });
    expect(airport?.lat).toBeCloseTo(10.55, 6);
    expect(airport?.position_source).toBe('facility');
    expect(store.row('nav_runway', { rwy_key: 'ZZAA|23|0' })?.lat).toBeCloseTo(10.55, 6);
  });

  it('accepts a position on the equator or the prime meridian, but not both', async () => {
    const store = freshStore();
    indexed(store);
    await fetchWithPosition(store, 0, 20.25);

    // Only BOTH being exactly zero is the unpopulated-buffer signature. An
    // airport genuinely on the equator keeps its position.
    const airport = store.row('nav_airport', { ident: 'ZZAA' });
    expect(airport?.lat).toBe(0);
    expect(airport?.position_source).toBe('facility');
  });
});
