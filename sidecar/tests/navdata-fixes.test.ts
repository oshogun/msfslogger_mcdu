// tests/navdata-fixes.test.ts — tests src/navdata-fixes.ts, one fix and its
// airways, against a fake SimConnect handle and a real store in a temp
// directory.
//
// What these pin down:
//
// 1. THE ROWS ARE THE ONES THE MAP WALKS. A fix's ROUTE children become
//    self-contained airway legs keyed by both endpoints, and the fix row and its
//    legs land in ONE transaction, so the incremental stream carries them as
//    one rev.
// 2. N_ROUTES IS CHECKED. A fix on no airway is stored as fetched with zero
//    routes; a fix that declared more routes than arrived is not stored at all.
// 3. AN AMBIGUOUS IDENT IS TERMINAL. The candidates' positions are stored, no
//    routes are claimed, and nothing waits for an end marker.
// 4. ABSENCE IS NARROW. Silence, or the immediate ERROR(1) a missing fix was
//    measured to answer with, is absence. Any other refusal, a refusal after
//    rows arrived, and a disconnect claim nothing.
// 5. A RECORD OF THE WRONG SIZE IS REFUSED, not misread.
//
// The record widths used here are the ones the fix decoder assumes and the
// simulator's documentation gives; they are stated again below, independently
// of the decoder, so a change to one is caught by the other. Every ident is
// synthetic and every coordinate invented.

import { afterEach, describe, expect, it } from 'vitest';

import { openNavdataReader } from '../src/navdata-export';
import { FacilitySession, type FacilityDefinition } from '../src/navdata-facilities';
import {
  FIX_ROUTES_DEFINITION,
  fetchFixRoutes,
  fixDefinitionUsable,
  fixRoutesSpec,
} from '../src/navdata-fixes';
import { airwayLegRow, wptKey } from '../src/navdata-keys';
import type { NavdataStore } from '../src/navdata-store';
import { buildBatch, NAVDATA_BATCH_MAX_BYTES, NAVDATA_BATCH_MAX_ROWS } from '../src/navdata-sync';
import { FakeFacilityConnection } from './helpers/fake-facility-connection';
import { readerOver } from './helpers/facility-record';
import { openFixtureStore, removeScratchDirs, scratchDir } from './helpers/navdata-fixture-store';

const WAYPOINT = 21;
const ROUTE = 22;

const stores: NavdataStore[] = [];
const sessions: FacilitySession[] = [];
let logged: string[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.close('test over');
  while (stores.length > 0) stores.pop()?.close();
  removeScratchDirs();
  logged = [];
});

const log = (level: string, message: string): void => {
  logged.push(`${level} ${message}`);
};

function freshStore(): NavdataStore {
  const store = openFixtureStore(scratchDir());
  stores.push(store);
  return store;
}

async function preparedSession(handle: FakeFacilityConnection): Promise<{
  session: FacilitySession;
  definition: FacilityDefinition;
}> {
  const session = new FacilitySession(handle as never, { log, settleMs: 1 });
  sessions.push(session);
  const [definition] = await session.prepare([fixRoutesSpec()]);
  return { session, definition };
}

/**
 * The id of the request the session sends next. `fetch` clears the definition
 * gate and takes a concurrency slot first, so this waits on the send itself,
 * against a clock rather than a count of turns, and fails loudly if it never
 * comes: a stale id would send the test's answer to the wrong request and the
 * test would time out somewhere that says nothing about why.
 */
async function sentRequestId(handle: FakeFacilityConnection, withinMs = 4000): Promise<number> {
  const before = handle.dataRequests.length;
  const deadline = Date.now() + withinMs;
  while (handle.dataRequests.length === before) {
    if (Date.now() > deadline) throw new Error(`no facility request was sent within ${withinMs} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return handle.lastDataRequestId() as number;
}

// ── the records, stated independently of the decoder ─────────────────────────

function text(value: string, width: number): Buffer {
  const buffer = Buffer.alloc(width);
  buffer.write(value, 'latin1');
  return buffer;
}
function f64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return buffer;
}
function f32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return buffer;
}
function i32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

interface FixValues {
  ident: string;
  region: string;
  lat: number;
  lon: number;
  alt?: number;
  nRoutes: number;
  terminal?: number;
  magvar?: number;
  magvarBytes?: 4 | 8;
  /** The width ICAO is written at; the measured layout has 8. */
  icaoBytes?: number;
}

/** LATITUDE LONGITUDE ALTITUDE f64, TYPE N_ROUTES i32, ICAO REGION s8, IS_TERMINAL_WPT i32, MAGVAR f32: 56 bytes as measured. */
function fixRecord(v: FixValues): Buffer {
  return Buffer.concat([
    f64(v.lat),
    f64(v.lon),
    f64(v.alt ?? 250),
    i32(1),
    i32(v.nRoutes),
    text(v.ident, v.icaoBytes ?? 8),
    text(v.region, 8),
    i32(v.terminal ?? 0),
    v.magvarBytes === 8 ? f64(v.magvar ?? -3.5) : f32(v.magvar ?? -3.5),
  ]);
}

interface End {
  ident: string;
  region: string;
  lat: number;
  lon: number;
}

const NO_END: End = { ident: '', region: '', lat: 0, lon: 0 };

/** TYPE i32, NEXT_ICAO NEXT_REGION s8, NEXT_LATITUDE NEXT_LONGITUDE f64, the same for PREV, NAME 32 bytes: 100 as measured. */
function routeRecord(name: string, type: number, next: End, prev: End, nameBytes = 32, nextIcaoBytes = 8): Buffer {
  return Buffer.concat([
    i32(type),
    text(next.ident, nextIcaoBytes),
    text(next.region, 8),
    f64(next.lat),
    f64(next.lon),
    text(prev.ident, 8),
    text(prev.region, 8),
    f64(prev.lat),
    f64(prev.lon),
    text(name, nameBytes),
  ]);
}

const SELF: FixValues = { ident: 'ZZFXA', region: 'ZZ', lat: 12.5, lon: 34.25, nRoutes: 2 };
const PREV_B: End = { ident: 'ZZFXB', region: 'ZZ', lat: 12.1, lon: 33.9 };
const NEXT_C: End = { ident: 'ZZFXC', region: 'ZZ', lat: 12.9, lon: 34.6 };
const NEXT_D: End = { ident: 'ZZFXD', region: 'ZY', lat: 13.4, lon: 35.05 };

function emitFix(handle: FakeFacilityConnection, requestId: number, fix: Buffer, routes: Buffer[]): void {
  handle.emitRecord(requestId, WAYPOINT, 1, 0, readerOver(fix));
  routes.forEach((route, index) => handle.emitRecord(requestId, ROUTE, 2 + index, 1, readerOver(route)));
  handle.emitDataEnd(requestId);
}

// ── the definition ────────────────────────────────────────────────────────────

describe('the fix definition', () => {
  it('asks for the fix and its ROUTE children in upper snake case, width-uncertain members last', async () => {
    const handle = new FakeFacilityConnection();
    const { definition } = await preparedSession(handle);
    expect(definition.name).toBe(FIX_ROUTES_DEFINITION);
    expect(fixDefinitionUsable(definition)).toBe(true);
    const sent = handle.definitionSends.map((s) => s.fieldName);
    expect(sent[0]).toBe('OPEN WAYPOINT');
    expect(sent).toContain('OPEN ROUTE');
    for (const name of sent) expect(name).toBe(name.toUpperCase());
    expect(definition.members.get('WAYPOINT')?.at(-1)).toBe('MAGVAR');
    expect(definition.members.get('ROUTE')?.at(-1)).toBe('NAME');
  });

  it('is not used when the simulator refused any member of it', async () => {
    const handle = new FakeFacilityConnection();
    handle.rejectedMembers.add('NEXT_REGION');
    const { definition } = await preparedSession(handle);
    expect(fixDefinitionUsable(definition)).toBe(false);
  });
});

// ── the fetch ─────────────────────────────────────────────────────────────────

describe('fetching a fix', () => {
  it('writes the fix and one self-contained leg per neighbour, in one rev, as the stream will send them', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const revBefore = store.meta().rev;
    const pending = fetchFixRoutes(session, store, definition, 'ZZFXA', 'ZZ', { log, now: () => 77 });
    const requestId = await sentRequestId(handle);
    expect(handle.dataRequests[0]).toMatchObject({ ident: 'ZZFXA', region: 'ZZ', icaoType: 'W' });
    emitFix(handle, requestId, fixRecord(SELF), [
      routeRecord('ZZJ1', 2, NEXT_C, PREV_B),
      routeRecord('ZZK2', 3, NEXT_D, NO_END),
    ]);
    const result = await pending;

    expect(result).toMatchObject({ status: 'fetched', routes: 2, legs: 3 });
    const key = wptKey('ZZFXA', 'ZZ', 12.5, 34.25);
    const row = store.row('nav_waypoint', { wpt_key: key });
    expect(row).toMatchObject({
      ident: 'ZZFXA',
      region: 'ZZ',
      lat: 12.5,
      lon: 34.25,
      alt_m: 250,
      n_routes: 2,
      is_terminal: 0,
      routes_state: 'fetched',
      routes_fetched_at: 77,
      position_source: 'facility',
    });
    expect(row?.magvar).toBeCloseTo(-3.5, 5);

    const self = { ident: 'ZZFXA', region: 'ZZ', lat: 12.5, lon: 34.25 };
    const expected = [
      airwayLegRow('ZZJ1', 2, PREV_B, self),
      airwayLegRow('ZZJ1', 2, self, NEXT_C),
      airwayLegRow('ZZK2', 3, self, NEXT_D),
    ];
    for (const leg of expected) {
      expect(store.row('nav_airway_leg', { leg_key: leg.leg_key })).toMatchObject(leg);
    }
    expect(store.meta().rev).toBe(revBefore + 1);

    const reader = openNavdataReader(store.path);
    try {
      reader.begin();
      const batch = buildBatch(reader, revBefore, { maxRows: NAVDATA_BATCH_MAX_ROWS, maxBytes: NAVDATA_BATCH_MAX_BYTES });
      expect(batch?.toRev).toBe(revBefore + 1);
      expect(batch?.rows.map((r) => r.t)).toEqual(['waypoint', 'airway_leg', 'airway_leg', 'airway_leg']);
      expect(batch?.rows.filter((r) => r.t === 'airway_leg').map((r) => r.r.leg_key).sort()).toEqual(
        expected.map((l) => l.leg_key).sort(),
      );
    } finally {
      reader.close();
    }
  });

  it('writes nothing new when a neighbour reports the same leg from its end', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const first = fetchFixRoutes(session, store, definition, 'ZZFXA', 'ZZ', { log });
    emitFix(handle, await sentRequestId(handle), fixRecord({ ...SELF, nRoutes: 1 }), [
      routeRecord('ZZJ1', 2, NEXT_C, NO_END),
    ]);
    await first;
    const legs = store.count('nav_airway_leg');

    const second = fetchFixRoutes(session, store, definition, 'ZZFXC', 'ZZ', { log });
    emitFix(handle, await sentRequestId(handle), fixRecord({ ...NEXT_C, nRoutes: 1 }), [
      routeRecord('ZZJ1', 2, NO_END, { ident: 'ZZFXA', region: 'ZZ', lat: 12.5, lon: 34.25 }),
    ]);
    const result = await second;
    expect(result).toMatchObject({ status: 'fetched', legs: 1, written: 1 });
    expect(store.count('nav_airway_leg')).toBe(legs);
  });

  it('stores a fix on no airway as fetched with zero routes', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZFXE', null, { log });
    expect(handle.dataRequests).toHaveLength(0);
    const requestId = await sentRequestId(handle);
    expect(handle.dataRequests[0].region).toBeUndefined();
    emitFix(handle, requestId, fixRecord({ ident: 'ZZFXE', region: 'ZX', lat: -8.25, lon: 101.5, nRoutes: 0 }), []);
    const result = await pending;
    expect(result).toMatchObject({ status: 'fetched', routes: 0, legs: 0 });
    // The region comes from the answer, not the request.
    expect(store.waypoints('ZZFXE', 'ZX')).toHaveLength(1);
    expect(store.waypoints('ZZFXE', null)[0]).toMatchObject({ n_routes: 0, routes_state: 'fetched' });
    expect(store.count('nav_airway_leg')).toBe(0);
  });

  it('stores nothing when fewer routes arrive than the fix declared', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZFXA', 'ZZ', { log });
    emitFix(handle, await sentRequestId(handle), fixRecord(SELF), [routeRecord('ZZJ1', 2, NEXT_C, PREV_B)]);
    const result = await pending;
    expect(result.status).toBe('undecodable');
    expect(store.count('nav_waypoint')).toBe(0);
    expect(store.count('nav_airway_leg')).toBe(0);
  });

  it.each([
    // A fixed member widened by one word: the trailing member would otherwise
    // soak it up and every field after the widened one would be misread.
    ['a fix record whose ICAO grew to 12 bytes (60 B)', fixRecord({ ...SELF, nRoutes: 0, icaoBytes: 12 }), []],
    ['a route record whose NEXT_ICAO grew to 12 bytes (104 B)', fixRecord({ ...SELF, nRoutes: 1 }), [routeRecord('ZZJ1', 2, NEXT_C, PREV_B, 32, 12)]],
    ['a fix record with an 8-byte MAGVAR (60 B)', fixRecord({ ...SELF, nRoutes: 0, magvarBytes: 8 }), []],
    ['a route record with an 8-byte NAME (76 B)', fixRecord({ ...SELF, nRoutes: 1 }), [routeRecord('ZZJ1', 2, NEXT_C, PREV_B, 8)]],
    ['a fix with no position', fixRecord({ ...SELF, lat: 0, lon: 0, nRoutes: 0 }), []],
  ])('refuses %s rather than misread it', async (_label, fix, routes) => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZFXA', 'ZZ', { log });
    emitFix(handle, await sentRequestId(handle), fix as Buffer, routes as Buffer[]);
    const result = await pending;
    expect(result.status).toBe('undecodable');
    expect(store.count('nav_waypoint')).toBe(0);
  });

  it('stores each candidate of an ambiguous ident, claims no routes, and does not wait for an end marker', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZAMB', null, { log, timeoutMs: 60_000 });
    const requestId = await sentRequestId(handle);
    handle.emitMinimalList(requestId, [
      { icao: { type: 'W', ident: 'ZZAMB', region: 'ZZ', airport: '' }, latLonAlt: { latitude: 5.5, longitude: 6.5, altitude: 10 } },
      { icao: { type: 'W', ident: 'ZZAMB', region: 'ZY', airport: 'ZZAA' }, latLonAlt: { latitude: -5.5, longitude: -6.5, altitude: 20 } },
      { icao: { type: 'V', ident: 'ZZAMB', region: 'ZX', airport: '' }, latLonAlt: { latitude: 1, longitude: 2, altitude: 0 } },
    ]);
    const started = Date.now();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ status: 'ambiguous', candidates: 2 });
    const rows = store.waypoints('ZZAMB', null);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.routes_state).toBe('unknown');
      expect(row.position_source).toBe('minimal');
    }
    expect(store.waypoints('ZZAMB', 'ZY')[0].airport_ident).toBe('ZZAA');
    // One request, no guessed region afterwards.
    expect(handle.dataRequests).toHaveLength(1);
  });

  it('does not read silence as a missing fix: a timeout with nothing received is a failure', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const inRegion = await fetchFixRoutes(session, store, definition, 'ZZNOF', 'ZZ', { log, timeoutMs: 20, now: () => 5 });
    const noRegion = await fetchFixRoutes(session, store, definition, 'ZZNOG', null, { log, timeoutMs: 20, now: () => 5 });
    expect(inRegion.status).toBe('failed');
    expect(noRegion.status).toBe('failed');
    expect(store.count('nav_absent')).toBe(0);
    expect(store.count('nav_waypoint')).toBe(0);
  });

  it('reads an immediate ERROR(1) as a fix this install does not have, under the region asked for', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    // A candidate position learned earlier, in the region about to be refused.
    const stale = wptKey('ZZNOF', 'ZZ', 7.25, 8.75);
    store.write((tx) =>
      tx.upsert('nav_waypoint', { wpt_key: stale, ident: 'ZZNOF', region: 'ZZ', lat: 7.25, lon: 8.75, position_source: 'minimal' }),
    );
    const revBefore = store.meta().rev;

    const pending = fetchFixRoutes(session, store, definition, 'ZZNOF', 'ZZ', { log, now: () => 42 });
    await sentRequestId(handle);
    // Measured: what a fix the simulator does not have answers with, at once.
    handle.emitException(handle.dataRequests[0].sendId, 'ERROR', 1, 3);
    const result = await pending;

    expect(result).toMatchObject({ status: 'absent', exceptionCode: 1 });
    expect(store.row('nav_absent', { kind: 'W', ident: 'ZZNOF', region: 'ZZ' })).toMatchObject({
      reason: 'exception',
      first_seen_at: 42,
    });
    expect(store.row('nav_waypoint', { wpt_key: stale })?.routes_state).toBe('absent');

    // The absence rides the incremental stream as a normal row.
    const reader = openNavdataReader(store.path);
    try {
      reader.begin();
      const batch = buildBatch(reader, revBefore, { maxRows: NAVDATA_BATCH_MAX_ROWS, maxBytes: NAVDATA_BATCH_MAX_BYTES });
      const absent = batch?.rows.filter((row) => row.t === 'absent');
      expect(absent?.map((row) => [row.r.kind, row.r.ident, row.r.region, row.r.reason])).toEqual([
        ['W', 'ZZNOF', 'ZZ', 'exception'],
      ]);
      expect(batch?.rows.some((row) => row.t === 'waypoint' && row.r.routes_state === 'absent')).toBe(true);
    } finally {
      reader.close();
    }
  });

  it('records an ERROR(1) for a fix asked for without a region under no region, and touches no region-qualified row', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    // A position learned earlier in one region. A request that named no
    // region says nothing about it, whatever the simulator answers.
    const known = wptKey('ZZNOG', 'ZZ', 6.5, 9.5);
    store.write((tx) =>
      tx.upsert('nav_waypoint', { wpt_key: known, ident: 'ZZNOG', region: 'ZZ', lat: 6.5, lon: 9.5, position_source: 'minimal' }),
    );
    const pending = fetchFixRoutes(session, store, definition, 'ZZNOG', null, { log });
    await sentRequestId(handle);
    handle.emitException(handle.dataRequests[0].sendId, 'ERROR', 1, 3);
    const result = await pending;
    expect(result.status).toBe('absent');
    expect(store.row('nav_absent', { kind: 'W', ident: 'ZZNOG', region: '' })?.reason).toBe('exception');
    expect(store.row('nav_absent', { kind: 'W', ident: 'ZZNOG', region: 'ZZ' })).toBeNull();
    expect(store.row('nav_waypoint', { wpt_key: known })?.routes_state).toBe('unknown');
    expect(store.count('nav_waypoint')).toBe(1);
  });

  it('keeps any other refusal as failed, and claims nothing', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZNOF', 'ZZ', { log });
    await sentRequestId(handle);
    handle.emitException(handle.dataRequests[0].sendId, 'DATA_ERROR', 20, 0);
    const result = await pending;
    expect(result).toMatchObject({ status: 'failed', exceptionCode: 20 });
    expect(store.count('nav_absent')).toBe(0);
  });

  it('keeps an ERROR(1) that arrives after the fix answered as failed', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZFXA', 'ZZ', { log });
    const requestId = await sentRequestId(handle);
    handle.emitRecord(requestId, WAYPOINT, 1, 0, readerOver(fixRecord(SELF)));
    handle.emitException(handle.dataRequests[0].sendId, 'ERROR', 1, 3);
    const result = await pending;
    expect(result.status).toBe('failed');
    expect(store.count('nav_absent')).toBe(0);
    expect(store.count('nav_waypoint')).toBe(0);
  });

  it('gives up on a fix that answers in part twice, and stores none of it', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZFXA', 'ZZ', { log, timeoutMs: 20 });
    for (let attempt = 1; attempt <= 2; attempt++) {
      while (handle.dataRequests.length < attempt) await new Promise((resolve) => setImmediate(resolve));
      handle.emitRecord(handle.dataRequests[attempt - 1].requestId, WAYPOINT, 1, 0, readerOver(fixRecord(SELF)));
    }
    const result = await pending;
    expect(result.status).toBe('failed');
    expect(store.count('nav_waypoint')).toBe(0);
    expect(store.count('nav_absent')).toBe(0);
  });

  it('writes nothing when the link drops mid-fetch', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const pending = fetchFixRoutes(session, store, definition, 'ZZFXA', 'ZZ', { log });
    const requestId = await sentRequestId(handle);
    handle.emitRecord(requestId, WAYPOINT, 1, 0, readerOver(fixRecord(SELF)));
    session.close('SimConnect disconnected');
    const result = await pending;
    expect(result.status).toBe('aborted');
    expect(store.count('nav_waypoint')).toBe(0);
    expect(store.count('nav_absent')).toBe(0);
  });

  it('reports a missing store as disabled and sends nothing', async () => {
    const handle = new FakeFacilityConnection();
    const { session, definition } = await preparedSession(handle);
    const result = await fetchFixRoutes(session, null, definition, 'ZZFXA', 'ZZ', { log });
    expect(result.status).toBe('disabled');
    expect(handle.dataRequests).toHaveLength(0);
  });
});

describe('looking fixes up by ident', () => {
  it('finds every fix of an ident without a region, and only the fixes in that region with one', () => {
    const store = freshStore();
    store.write((tx) => {
      tx.upsert('nav_waypoint', { wpt_key: wptKey('ZZDUP', 'ZZ', 1, 1), ident: 'ZZDUP', region: 'ZZ', lat: 1, lon: 1 });
      tx.upsert('nav_waypoint', { wpt_key: wptKey('ZZDUP', 'ZZ', 2, 2), ident: 'ZZDUP', region: 'ZZ', lat: 2, lon: 2 });
      tx.upsert('nav_waypoint', { wpt_key: wptKey('ZZDUP', 'ZY', 3, 3), ident: 'ZZDUP', region: 'ZY', lat: 3, lon: 3 });
      tx.upsert('nav_waypoint', { wpt_key: wptKey('ZZOTH', 'ZZ', 4, 4), ident: 'ZZOTH', region: 'ZZ', lat: 4, lon: 4 });
    });
    expect(store.waypoints('ZZDUP', null)).toHaveLength(3);
    expect(store.waypoints('ZZDUP', 'ZZ')).toHaveLength(2);
    expect(store.waypoints('ZZDUP', 'ZY').map((row) => row.lat)).toEqual([3]);
    expect(store.waypoints('ZZDUP', 'ZX')).toEqual([]);
  });
});

describe('a fix left pending by an earlier process', () => {
  it('is put back to unknown when the store is next opened', () => {
    const store = freshStore();
    const key = wptKey('ZZPND', 'ZZ', 1.5, 2.5);
    store.write((tx) =>
      tx.upsert('nav_waypoint', { wpt_key: key, ident: 'ZZPND', region: 'ZZ', lat: 1.5, lon: 2.5, routes_state: 'pending' }),
    );
    expect(store.resetPendingDetail()).toBe(1);
    expect(store.row('nav_waypoint', { wpt_key: key })?.routes_state).toBe('unknown');
  });
});
