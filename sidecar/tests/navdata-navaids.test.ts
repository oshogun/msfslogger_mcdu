// tests/navdata-navaids.test.ts — tests src/navdata-navaids.ts, one VOR or NDB,
// against a fake SimConnect handle and a real store in a temp directory.
//
// What these pin down:
//
// 1. A VOR IS TWO CALLS. Its facility data carries no station position, so the
//    detail lands with a NULL position and a second, region-less request
//    supplies one from a minimal list when the ident is shared. When it is not,
//    the position stays NULL: nothing is guessed, and the DME's position is
//    never passed off as the station's.
// 2. THE TWO CALLS MERGE. A position already stored is not erased by detail,
//    and no second call is made for it.
// 3. AN NDB IS ONE CALL, with its position from facility data.
// 4. A MINIMAL LIST IS TERMINAL and stores every candidate; two candidates in
//    one region mark that key ambiguous rather than picking one.
// 5. AN IMMEDIATE ERROR(1) IS ABSENCE, recorded under the region asked for; a
//    request without a region marks no region-qualified row. Nothing is
//    claimed on any other refusal, a timeout or a disconnect, and a record of
//    the wrong size is refused, not misread.
// 6. THE THIRD CALL. A VOR still without a position is asked for as a
//    waypoint, and the answer's position is taken ONLY when the answer names
//    the same ident in the same region. Its airways are not stored from it, a
//    localizer is never asked, and a failed third call leaves the VOR as it
//    was.
//
// The record widths below are stated independently of the decoder. Every ident
// is synthetic and every coordinate invented.

import { afterEach, describe, expect, it } from 'vitest';

import { openNavdataReader } from '../src/navdata-export';
import { FacilitySession, type FacilityDefinition, type FacilityMinimalEntry } from '../src/navdata-facilities';
import {
  fetchNavaid,
  NDB_RECORD_BYTES,
  navaidDefinitionUsable,
  ndbDetailSpec,
  VOR_RECORD_BYTES,
  vorDetailSpec,
} from '../src/navdata-navaids';
import { fixRoutesSpec } from '../src/navdata-fixes';
import type { NavdataStore } from '../src/navdata-store';
import { buildBatch, NAVDATA_BATCH_MAX_BYTES, NAVDATA_BATCH_MAX_ROWS } from '../src/navdata-sync';
import { FakeFacilityConnection } from './helpers/fake-facility-connection';
import { readerOver } from './helpers/facility-record';
import { openFixtureStore, removeScratchDirs, scratchDir } from './helpers/navdata-fixture-store';

const VOR = 19;
const NDB = 20;

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

async function prepared(handle: FakeFacilityConnection): Promise<{
  session: FacilitySession;
  vor: FacilityDefinition;
  ndb: FacilityDefinition;
  fix: FacilityDefinition;
}> {
  const session = new FacilitySession(handle as never, { log, settleMs: 1 });
  sessions.push(session);
  const [vor, ndb, fix] = await session.prepare([vorDetailSpec(), ndbDetailSpec(), fixRoutesSpec()]);
  return { session, vor, ndb, fix };
}

/** Waits for the next request to go out, against a clock, and fails loudly if it never does. */
async function nextRequest(handle: FakeFacilityConnection, count: number, withinMs = 4000): Promise<number> {
  const deadline = Date.now() + withinMs;
  while (handle.dataRequests.length < count) {
    if (Date.now() > deadline) throw new Error(`request ${count} was not sent within ${withinMs} ms`);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return handle.dataRequests[count - 1].requestId;
}

// ── the records, stated independently of the decoder ─────────────────────────

const text = (value: string, width: number): Buffer => {
  const buffer = Buffer.alloc(width);
  buffer.write(value, 'latin1');
  return buffer;
};
const f64 = (value: number): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return buffer;
};
const f32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return buffer;
};
const i32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
};

interface VorValues {
  ident: string;
  region: string;
  type?: number;
  frequency?: number;
  dme?: [number, number, number];
  gs?: [number, number, number];
  nameBytes?: number;
}

/**
 * FREQUENCY TYPE i32; IS_NAV IS_DME IS_TACAN HAS_GLIDE_SLOPE DME_AT_NAV
 * DME_AT_GLIDE_SLOPE HAS_BACK_COURSE i32; LOCALIZER LOCALIZER_WIDTH MAGVAR f32;
 * NAME 64 B; ICAO REGION 8 B; NAV_RANGE f32; GS, TACAN, DME lat/lon/alt f64.
 */
function vorRecord(v: VorValues): Buffer {
  const [dLat, dLon, dAlt] = v.dme ?? [0, 0, 0];
  const [gLat, gLon, gAlt] = v.gs ?? [0, 0, 0];
  return Buffer.concat([
    i32(v.frequency ?? 113_900_000),
    i32(v.type ?? 3),
    i32(1),
    i32(v.dme ? 1 : 0),
    i32(0),
    i32(v.gs ? 1 : 0),
    i32(v.dme ? 1 : 0),
    i32(0),
    i32(0),
    f32(v.gs ? 271.5 : 0),
    f32(v.gs ? 4.5 : 0),
    f32(-2.5),
    text('ZZ TEST VOR', v.nameBytes ?? 64),
    text(v.ident, 8),
    text(v.region, 8),
    f32(185_200),
    f64(gLat),
    f64(gLon),
    f64(gAlt),
    f64(0),
    f64(0),
    f64(0),
    f64(dLat),
    f64(dLon),
    f64(dAlt),
  ]);
}

/** LATITUDE LONGITUDE ALTITUDE f64; FREQUENCY TYPE i32; RANGE MAGVAR f32; NAME 64 B; ICAO REGION 8 B. */
function ndbRecord(ident: string, region: string, lat: number, lon: number, extra = 0): Buffer {
  return Buffer.concat([
    f64(lat),
    f64(lon),
    f64(120),
    i32(375_000),
    i32(2),
    f32(46_300),
    f32(1.5),
    text('ZZ TEST NDB', 64),
    text(ident, 8),
    text(region, 8),
    Buffer.alloc(extra),
  ]);
}

function candidate(ident: string, region: string, lat: number, lon: number, type = 'V', airport = ''): FacilityMinimalEntry {
  return { icao: { type, ident, region, airport }, latLonAlt: { latitude: lat, longitude: lon, altitude: 300 } };
}

// ── the definitions ───────────────────────────────────────────────────────────

describe('the navaid definitions', () => {
  it('ask for a VOR without a station position, and add up to the sizes expected', async () => {
    const handle = new FakeFacilityConnection();
    const { vor, ndb } = await prepared(handle);
    const vorMembers = vor.members.get('VOR') ?? [];
    expect(vorMembers).not.toContain('LATITUDE');
    expect(vorMembers).not.toContain('LONGITUDE');
    expect(vorMembers).not.toContain('ALTITUDE');
    expect(ndb.members.get('NDB')?.slice(0, 3)).toEqual(['LATITUDE', 'LONGITUDE', 'ALTITUDE']);
    expect(VOR_RECORD_BYTES).toBe(204);
    expect(vorRecord({ ident: 'ZZVOA', region: 'ZZ' }).length).toBe(204);
    expect(NDB_RECORD_BYTES).toBe(120);
    expect(ndbRecord('ZZNDA', 'ZZ', 1, 2).length).toBe(120);
    expect(navaidDefinitionUsable(vor, 'V')).toBe(true);
    expect(navaidDefinitionUsable(ndb, 'N')).toBe(true);
    for (const name of handle.definitionSends.map((send) => send.fieldName)) expect(name).toBe(name.toUpperCase());
  });

  it('are not used when the simulator refused a member', async () => {
    const handle = new FakeFacilityConnection();
    handle.rejectedMembers.add('NAV_RANGE');
    handle.rejectedMembers.add('RANGE');
    const { vor, ndb } = await prepared(handle);
    expect(navaidDefinitionUsable(vor, 'V')).toBe(false);
    expect(navaidDefinitionUsable(ndb, 'N')).toBe(false);
  });
});

// ── a VOR ─────────────────────────────────────────────────────────────────────

describe('fetching a VOR', () => {
  it('stores the detail, then takes the station position from the region-less minimal list', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const revBefore = store.meta().rev;
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOA', 'ZZ', { log, now: () => 50 });

    const first = await nextRequest(handle, 1);
    expect(handle.dataRequests[0]).toMatchObject({ ident: 'ZZVOA', region: 'ZZ', icaoType: 'V' });
    handle.emitRecord(first, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOA', region: 'ZZ', dme: [10.01, 20.01, 150], gs: [10.2, 20.2, 90] })));
    handle.emitDataEnd(first);

    const second = await nextRequest(handle, 2);
    expect(handle.dataRequests[1]).toMatchObject({ ident: 'ZZVOA', region: undefined, icaoType: 'V' });
    handle.emitMinimalList(second, [
      candidate('ZZVOA', 'ZZ', 10, 20, 'V', 'ZZAA'),
      candidate('ZZVOA', 'ZY', -30, 40),
      candidate('ZZVOA', 'ZX', 5, 5, 'N'),
    ]);
    const result = await pending;

    expect(result).toMatchObject({ status: 'detail', positioned: true, candidates: 2 });
    const row = store.row('nav_navaid', { kind: 'V', ident: 'ZZVOA', region: 'ZZ' });
    expect(row).toMatchObject({
      lat: 10,
      lon: 20,
      alt_m: 300,
      position_source: 'minimal',
      position_fetched_at: 50,
      frequency_hz: 113_900_000,
      nav_type: 3,
      name: 'ZZ TEST VOR',
      is_nav: 1,
      is_dme: 1,
      is_tacan: 0,
      has_glide_slope: 1,
      dme_at_nav: 1,
      has_back_course: 0,
      nav_range_m: 185_200,
      dme_lat: 10.01,
      dme_lon: 20.01,
      dme_alt_m: 150,
      gs_lat: 10.2,
      gs_lon: 20.2,
      gs_alt_m: 90,
      tacan_lat: null,
      airport_ident: 'ZZAA',
      detail_state: 'detail',
      detail_fetched_at: 50,
      ambiguous: 0,
    });
    expect(row?.magvar).toBeCloseTo(-2.5, 5);
    expect(row?.localizer_deg).toBeCloseTo(271.5, 3);
    // The other region's station is a position row, with no detail claimed for it.
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOA', region: 'ZY' })).toMatchObject({
      lat: -30,
      lon: 40,
      position_source: 'minimal',
      detail_state: 'index',
    });
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOA', region: 'ZX' })).toBeNull();

    // The rows ride the incremental stream like any other.
    const reader = openNavdataReader(store.path);
    try {
      reader.begin();
      const batch = buildBatch(reader, revBefore, { maxRows: NAVDATA_BATCH_MAX_ROWS, maxBytes: NAVDATA_BATCH_MAX_BYTES });
      expect(batch?.rows.filter((r) => r.t === 'navaid').map((r) => r.r.region).sort()).toEqual(['ZY', 'ZZ']);
    } finally {
      reader.close();
    }
  });

  it('invents no position when the ident is unique: the region-less request answers with data, and lat stays empty', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOB', 'ZZ', { log });
    for (const count of [1, 2]) {
      const id = await nextRequest(handle, count);
      handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOB', region: 'ZZ', dme: [11, 21, 0] })));
      handle.emitDataEnd(id);
    }
    const result = await pending;
    expect(result).toMatchObject({ status: 'detail', positioned: false, candidates: 0 });
    const row = store.row('nav_navaid', { kind: 'V', ident: 'ZZVOB', region: 'ZZ' });
    expect(row).toMatchObject({ lat: null, lon: null, position_source: null, dme_lat: 11, detail_state: 'detail' });
    expect(store.count('nav_navaid')).toBe(1);
  });

  it('keeps a position already stored, and does not ask for it again', async () => {
    const store = freshStore();
    store.write((tx) =>
      tx.upsert('nav_navaid', { kind: 'V', ident: 'ZZVOC', region: 'ZZ', lat: 12.5, lon: 22.5, position_source: 'list' }),
    );
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOC', 'ZZ', { log });
    const id = await nextRequest(handle, 1);
    handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOC', region: 'ZZ' })));
    handle.emitDataEnd(id);
    const result = await pending;
    expect(result).toMatchObject({ status: 'detail', positioned: true });
    expect(handle.dataRequests).toHaveLength(1);
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOC', region: 'ZZ' })).toMatchObject({
      lat: 12.5,
      lon: 22.5,
      position_source: 'list',
      detail_state: 'detail',
    });
  });

  it('stores a region-less VOR that answers with data under the region it answered with, in one call', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOD', null, { log });
    const id = await nextRequest(handle, 1);
    expect(handle.dataRequests[0].region).toBeUndefined();
    handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOD', region: 'ZQ' })));
    handle.emitDataEnd(id);
    const result = await pending;
    expect(result).toMatchObject({ status: 'detail', positioned: false });
    expect(handle.dataRequests).toHaveLength(1);
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOD', region: 'ZQ' })?.detail_state).toBe('detail');
  });

  it('stores every candidate of a region-less ambiguous VOR, ends there, and marks a key two stations share', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOE', null, { log, timeoutMs: 60_000 });
    const id = await nextRequest(handle, 1);
    handle.emitMinimalList(id, [
      candidate('ZZVOE', 'ZZ', 1, 1),
      candidate('ZZVOE', 'ZY', 2, 2),
      candidate('ZZVOE', 'ZY', 3, 3),
    ]);
    const started = Date.now();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ status: 'ambiguous', candidates: 3 });
    expect(handle.dataRequests).toHaveLength(1);
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOE', region: 'ZZ' })).toMatchObject({
      lat: 1,
      position_source: 'minimal',
      ambiguous: 0,
    });
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOE', region: 'ZY' })).toMatchObject({
      lat: null,
      ambiguous: 1,
    });
  });

  it.each([
    ['VOR', 'V'],
    ['NDB', 'N'],
  ] as const)('refuses an answer carrying two %s records', async (_noun, kind) => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, ndb } = await prepared(handle);
    const pending = fetchNavaid(session, store, kind === 'V' ? vor : ndb, kind, 'ZZTWO', 'ZZ', { log });
    const id = await nextRequest(handle, 1);
    for (const unique of [1, 2]) {
      const record = kind === 'V' ? vorRecord({ ident: 'ZZTWO', region: 'ZZ' }) : ndbRecord('ZZTWO', 'ZZ', 1 + unique, 2);
      handle.emitRecord(id, kind === 'V' ? VOR : NDB, unique, 0, readerOver(record));
    }
    handle.emitDataEnd(id);
    expect((await pending).status).toBe('undecodable');
    expect(store.count('nav_navaid')).toBe(0);
  });

  it('refuses a record of the wrong size rather than misread it', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOF', 'ZZ', { log });
    const id = await nextRequest(handle, 1);
    handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOF', region: 'ZZ', nameBytes: 68 })));
    handle.emitDataEnd(id);
    const result = await pending;
    expect(result.status).toBe('undecodable');
    expect(store.count('nav_navaid')).toBe(0);
  });
});

// ── an NDB ────────────────────────────────────────────────────────────────────

describe('fetching an NDB', () => {
  it('is one call, with the station position from its facility data', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, ndb } = await prepared(handle);
    const pending = fetchNavaid(session, store, ndb, 'N', 'ZZNDA', 'ZZ', { log, now: () => 70 });
    const id = await nextRequest(handle, 1);
    expect(handle.dataRequests[0]).toMatchObject({ ident: 'ZZNDA', region: 'ZZ', icaoType: 'N' });
    handle.emitRecord(id, NDB, 1, 0, readerOver(ndbRecord('ZZNDA', 'ZZ', 45.25, -12.5)));
    handle.emitDataEnd(id);
    const result = await pending;
    expect(result).toMatchObject({ status: 'detail', positioned: true });
    expect(handle.dataRequests).toHaveLength(1);
    expect(store.row('nav_navaid', { kind: 'N', ident: 'ZZNDA', region: 'ZZ' })).toMatchObject({
      lat: 45.25,
      lon: -12.5,
      alt_m: 120,
      position_source: 'facility',
      position_fetched_at: 70,
      frequency_hz: 375_000,
      nav_type: 2,
      nav_range_m: 46_300,
      name: 'ZZ TEST NDB',
      detail_state: 'detail',
    });
  });

  it('refuses a record of the wrong size', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, ndb } = await prepared(handle);
    const pending = fetchNavaid(session, store, ndb, 'N', 'ZZNDB', 'ZZ', { log });
    const id = await nextRequest(handle, 1);
    handle.emitRecord(id, NDB, 1, 0, readerOver(ndbRecord('ZZNDB', 'ZZ', 1, 2, 4)));
    handle.emitDataEnd(id);
    expect((await pending).status).toBe('undecodable');
    expect(store.count('nav_navaid')).toBe(0);
  });
});

// ── nothing claimed ───────────────────────────────────────────────────────────

describe('a navaid that does not answer', () => {
  it('records an immediate ERROR(1) as absent, under the region asked for, and marks that region\u2019s row', async () => {
    const store = freshStore();
    // A position row the VOR was known by in the region about to be refused.
    store.write((tx) => tx.upsert('nav_navaid', { kind: 'V', ident: 'ZZNOV', region: 'ZZ', lat: 4.5, lon: 5.5, position_source: 'minimal' }));
    const handle = new FakeFacilityConnection();
    const { session, vor, ndb } = await prepared(handle);
    for (const [kind, definition, ident] of [
      ['V', vor, 'ZZNOV'],
      ['N', ndb, 'ZZNON'],
    ] as const) {
      const pending = fetchNavaid(session, store, definition, kind, ident, 'ZZ', { log, now: () => 60 });
      await nextRequest(handle, handle.dataRequests.length + 1);
      // Measured: what a VOR or NDB the simulator does not have answers with, at once.
      handle.emitException(handle.dataRequests.at(-1)?.sendId as number, 'ERROR', 1, 3);
      const result = await pending;
      expect(result).toMatchObject({ status: 'absent', exceptionCode: 1 });
      expect(store.row('nav_absent', { kind, ident, region: 'ZZ' })).toMatchObject({ reason: 'exception', first_seen_at: 60 });
    }
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZNOV', region: 'ZZ' })).toMatchObject({ detail_state: 'absent', lat: 4.5 });
    // No row is made up for the NDB that never had one.
    expect(store.row('nav_navaid', { kind: 'N', ident: 'ZZNON', region: 'ZZ' })).toBeNull();
  });

  it('records a region-less ERROR(1) under no region, and touches no region-qualified row', async () => {
    const store = freshStore();
    store.write((tx) => tx.upsert('nav_navaid', { kind: 'N', ident: 'ZZNOB', region: 'ZZ', lat: 6.5, lon: 7.5, position_source: 'minimal' }));
    const handle = new FakeFacilityConnection();
    const { session, ndb } = await prepared(handle);
    const pending = fetchNavaid(session, store, ndb, 'N', 'ZZNOB', null, { log });
    await nextRequest(handle, 1);
    handle.emitException(handle.dataRequests[0].sendId, 'ERROR', 1, 3);
    expect((await pending).status).toBe('absent');
    expect(store.row('nav_absent', { kind: 'N', ident: 'ZZNOB', region: '' })?.reason).toBe('exception');
    expect(store.row('nav_absent', { kind: 'N', ident: 'ZZNOB', region: 'ZZ' })).toBeNull();
    expect(store.row('nav_navaid', { kind: 'N', ident: 'ZZNOB', region: 'ZZ' })?.detail_state).toBe('index');
  });

  it('keeps any other refusal, and an ERROR(1) after data arrived, as failed', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const other = fetchNavaid(session, store, vor, 'V', 'ZZNOW', 'ZZ', { log });
    await nextRequest(handle, 1);
    handle.emitException(handle.dataRequests[0].sendId, 'DATA_ERROR', 20, 0);
    expect(await other).toMatchObject({ status: 'failed', exceptionCode: 20 });

    const late = fetchNavaid(session, store, vor, 'V', 'ZZNOX', 'ZZ', { log });
    const id = await nextRequest(handle, 2);
    handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZNOX', region: 'ZZ' })));
    handle.emitException(handle.dataRequests[1].sendId, 'ERROR', 1, 3);
    expect((await late).status).toBe('failed');
    expect(store.count('nav_absent')).toBe(0);
    expect(store.count('nav_navaid')).toBe(0);
  });

  it('keeps a timeout as failed', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, ndb } = await prepared(handle);
    const result = await fetchNavaid(session, store, ndb, 'N', 'ZZNOT', 'ZZ', { log, timeoutMs: 20 });
    expect(result.status).toBe('failed');
    expect(store.count('nav_absent')).toBe(0);
  });

  it('writes nothing when the link drops mid-fetch', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOG', 'ZZ', { log });
    await nextRequest(handle, 1);
    session.close('SimConnect disconnected');
    expect((await pending).status).toBe('aborted');
    expect(store.count('nav_navaid')).toBe(0);
  });

  it('reports a missing store as disabled and sends nothing', async () => {
    const handle = new FakeFacilityConnection();
    const { session, vor } = await prepared(handle);
    expect((await fetchNavaid(session, null, vor, 'V', 'ZZVOH', 'ZZ', { log })).status).toBe('disabled');
    expect(handle.dataRequests).toHaveLength(0);
  });
});

describe('looking navaids up by ident', () => {
  it('finds one kind of an ident in one region, or in any', () => {
    const store = freshStore();
    store.write((tx) => {
      tx.upsert('nav_navaid', { kind: 'V', ident: 'ZZDUP', region: 'ZZ' });
      tx.upsert('nav_navaid', { kind: 'V', ident: 'ZZDUP', region: 'ZY' });
      tx.upsert('nav_navaid', { kind: 'N', ident: 'ZZDUP', region: 'ZZ' });
    });
    expect(store.navaids('V', 'ZZDUP', null)).toHaveLength(2);
    expect(store.navaids('V', 'ZZDUP', 'ZY').map((row) => row.region)).toEqual(['ZY']);
    expect(store.navaids('N', 'ZZDUP', null)).toHaveLength(1);
    expect(store.navaids('V', 'ZZDUP', 'ZX')).toEqual([]);
  });
});

// ── the third call ────────────────────────────────────────────────────────────

describe('a VOR the first two calls could not place', () => {
  const WAYPOINT = 21;
  const ROUTE = 22;

  /** A fix record as the waypoint database answers: 56 bytes. */
  /** `type` 3 is what a VOR is in the waypoint database (measured); 1 is a named fix. */
  function waypointRecord(ident: string, region: string, lat: number, lon: number, nRoutes: number, type = 3): Buffer {
    return Buffer.concat([
      f64(lat),
      f64(lon),
      f64(410),
      i32(type),
      i32(nRoutes),
      text(ident, 8),
      text(region, 8),
      i32(0),
      f32(2.5),
    ]);
  }

  /** A route record: 100 bytes, one neighbour. */
  function routeRecord(): Buffer {
    return Buffer.concat([
      i32(1),
      text('ZZFXN', 8),
      text('ZZ', 8),
      f64(13.9),
      f64(23.9),
      text('', 8),
      text('', 8),
      f64(0),
      f64(0),
      text('ZZJ9', 32),
    ]);
  }

  /** Answers the detail call and the region-less call with data, as a unique ident does. */
  async function uniqueVor(handle: FakeFacilityConnection, ident: string, type = 3): Promise<void> {
    for (const count of [1, 2]) {
      const id = await nextRequest(handle, count);
      handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident, region: 'ZZ', type })));
      handle.emitDataEnd(id);
    }
  }

  it('takes the position from the waypoint answer that names the same ident and region, and nothing else from it', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, fix } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOM', 'ZZ', { log, now: () => 80, waypointDefinition: fix });
    await uniqueVor(handle, 'ZZVOM');
    const third = await nextRequest(handle, 3);
    expect(handle.dataRequests[2]).toMatchObject({ ident: 'ZZVOM', region: 'ZZ', icaoType: 'W', definitionId: fix.definitionId });
    handle.emitRecord(third, WAYPOINT, 1, 0, readerOver(waypointRecord('ZZVOM', 'ZZ', 13.5, 23.5, 1)));
    handle.emitRecord(third, ROUTE, 2, 1, readerOver(routeRecord()));
    handle.emitDataEnd(third);
    const result = await pending;
    expect(result).toMatchObject({ status: 'detail', positioned: true });
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOM', region: 'ZZ' })).toMatchObject({
      lat: 13.5,
      lon: 23.5,
      alt_m: 410,
      position_source: 'facility',
      position_fetched_at: 80,
      detail_state: 'detail',
    });
    // Its airways belong to the fix fetch, and the fix row is not made from it.
    expect(store.count('nav_waypoint')).toBe(0);
    expect(store.count('nav_airway_leg')).toBe(0);
  });

  it.each([
    ['another region (a same-ident station elsewhere)', 'ZZVON', 'ZY'],
    ['another ident', 'ZZVOX', 'ZZ'],
    ['no ident at all', '', 'ZZ'],
  ])('leaves the position empty when the waypoint answer is %s', async (_label, answeredIdent, answeredRegion) => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, fix } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVON', 'ZZ', { log, waypointDefinition: fix });
    await uniqueVor(handle, 'ZZVON');
    const third = await nextRequest(handle, 3);
    handle.emitRecord(third, WAYPOINT, 1, 0, readerOver(waypointRecord(answeredIdent, answeredRegion, -44.3, -69.8, 0)));
    handle.emitDataEnd(third);
    const result = await pending;
    expect(result).toMatchObject({ status: 'detail', positioned: false });
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVON', region: 'ZZ' })).toMatchObject({ lat: null, lon: null, position_source: null });
    const said = logged.filter((line) => line.includes('was another station'));
    expect(said).toEqual(['info navdata: the waypoint answer for VOR ZZVON/ZZ was another station; its position was not used']);
    expect(said[0]).not.toMatch(/\d+\.\d+/);
  });

  it('leaves the VOR in detail with no position when the third call is refused or times out', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, fix } = await prepared(handle);
    const refused = fetchNavaid(session, store, vor, 'V', 'ZZVOR', 'ZZ', { log, waypointDefinition: fix });
    await uniqueVor(handle, 'ZZVOR');
    await nextRequest(handle, 3);
    handle.emitException(handle.dataRequests[2].sendId, 'ERROR', 1, 3);
    expect(await refused).toMatchObject({ status: 'detail', positioned: false });

    const silent = fetchNavaid(session, store, vor, 'V', 'ZZVOS', 'ZZ', { log, waypointDefinition: fix, timeoutMs: 30 });
    for (const count of [4, 5]) {
      const id = await nextRequest(handle, count);
      handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOS', region: 'ZZ' })));
      handle.emitDataEnd(id);
    }
    expect(await silent).toMatchObject({ status: 'detail', positioned: false });
    expect(handle.dataRequests).toHaveLength(6);

    for (const ident of ['ZZVOR', 'ZZVOS']) {
      expect(store.row('nav_navaid', { kind: 'V', ident, region: 'ZZ' })).toMatchObject({ detail_state: 'detail', lat: null });
    }
    // The VOR exists: a refused waypoint request is no absence of it.
    expect(store.count('nav_absent')).toBe(0);
  });

  it('never asks for a localizer or an NDB as a waypoint', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, ndb, fix } = await prepared(handle);
    const localizer = fetchNavaid(session, store, vor, 'V', 'ZZLOC', 'ZZ', { log, waypointDefinition: fix });
    await uniqueVor(handle, 'ZZLOC', 4);
    expect(await localizer).toMatchObject({ status: 'detail', positioned: false });
    expect(handle.dataRequests).toHaveLength(2);

    const beacon = fetchNavaid(session, store, ndb, 'N', 'ZZNDC', 'ZZ', { log, waypointDefinition: fix });
    const id = await nextRequest(handle, 3);
    handle.emitRecord(id, 20, 1, 0, readerOver(ndbRecord('ZZNDC', 'ZZ', 0, 0)));
    handle.emitDataEnd(id);
    expect(await beacon).toMatchObject({ status: 'detail', positioned: false });
    expect(handle.dataRequests.every((request) => request.icaoType !== 'W')).toBe(true);
  });

  it('looks a VOR asked for without a region up under the region its own answer gave', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, fix } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOQ', null, { log, waypointDefinition: fix });
    const id = await nextRequest(handle, 1);
    // The ident is unique: the region-less request answers with data, from ZQ.
    handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOQ', region: 'ZQ' })));
    handle.emitDataEnd(id);
    const third = await nextRequest(handle, 2);
    expect(handle.dataRequests[1]).toMatchObject({ ident: 'ZZVOQ', region: 'ZQ', icaoType: 'W' });
    handle.emitRecord(third, WAYPOINT, 1, 0, readerOver(waypointRecord('ZZVOQ', 'ZQ', 14.25, 24.75, 0)));
    handle.emitDataEnd(third);
    expect(await pending).toMatchObject({ status: 'detail', positioned: true });
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOQ', region: 'ZQ' })).toMatchObject({
      lat: 14.25,
      lon: 24.75,
      position_source: 'facility',
    });
  });

  it('still checks the answered region for a VOR asked for without one', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, fix } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOT', null, { log, waypointDefinition: fix });
    const id = await nextRequest(handle, 1);
    handle.emitRecord(id, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOT', region: 'ZQ' })));
    handle.emitDataEnd(id);
    const third = await nextRequest(handle, 2);
    handle.emitRecord(third, WAYPOINT, 1, 0, readerOver(waypointRecord('ZZVOT', 'ZR', 14.25, 24.75, 0)));
    handle.emitDataEnd(third);
    expect(await pending).toMatchObject({ status: 'detail', positioned: false });
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOT', region: 'ZQ' })?.lat).toBeNull();
  });

  it('rejects a same-ident, same-region answer that is not a VOR in the waypoint database', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, fix } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOU', 'ZZ', { log, waypointDefinition: fix });
    await uniqueVor(handle, 'ZZVOU');
    const third = await nextRequest(handle, 3);
    // A named fix sharing the ident and the region, not the VOR itself.
    handle.emitRecord(third, WAYPOINT, 1, 0, readerOver(waypointRecord('ZZVOU', 'ZZ', 33, 44, 0, 1)));
    handle.emitDataEnd(third);
    expect(await pending).toMatchObject({ status: 'detail', positioned: false });
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOU', region: 'ZZ' })).toMatchObject({ lat: null, position_source: null });
    expect(logged.filter((line) => line.includes('was another station'))).toHaveLength(1);
  });

  it('never looks up a key two stations share, and leaves it without a position', async () => {
    const store = freshStore();
    const handle = new FakeFacilityConnection();
    const { session, vor, fix } = await prepared(handle);
    const pending = fetchNavaid(session, store, vor, 'V', 'ZZVOV', 'ZZ', { log, waypointDefinition: fix });
    const first = await nextRequest(handle, 1);
    handle.emitRecord(first, VOR, 1, 0, readerOver(vorRecord({ ident: 'ZZVOV', region: 'ZZ' })));
    handle.emitDataEnd(first);
    const second = await nextRequest(handle, 2);
    // Two stations under the very key that was asked for.
    handle.emitMinimalList(second, [candidate('ZZVOV', 'ZZ', 11, 21), candidate('ZZVOV', 'ZZ', 12, 22)]);
    expect(await pending).toMatchObject({ status: 'detail', positioned: false });
    expect(handle.dataRequests).toHaveLength(2);
    expect(store.row('nav_navaid', { kind: 'V', ident: 'ZZVOV', region: 'ZZ' })).toMatchObject({
      ambiguous: 1,
      lat: null,
      detail_state: 'detail',
    });
  });
});
