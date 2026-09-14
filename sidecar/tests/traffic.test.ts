// tests/traffic.test.ts — tests src/traffic.ts.
//
// One describe per documented step of buildTrafficBatch, in the order the
// function applies them, because the steps interact: de-duplication happens
// after the drops, and truncation after de-duplication, so a batch of 250
// records that contains duplicates is a different answer depending on the
// order. The expectations are transcribed from the CLI agent's version of this
// function, which this file is a port of.

import { describe, expect, it } from 'vitest';
import { buildTrafficBatch, MAX_BATCH_OBJECTS, type TrafficRecord } from '../src/traffic';

const USER_ID = 1;
const USER_LAT = 37.6;
const USER_LON = -122.4;

/** A record that survives every filter, so each test varies one thing. */
function record(overrides: Partial<TrafficRecord> = {}): TrafficRecord {
  return {
    id: 100,
    lat: 38.0,
    lon: -121.0,
    altitudeFt: 5000,
    headingDeg: 90,
    groundSpeedKnots: 250,
    onGround: false,
    ...overrides,
  };
}

function build(sweep: TrafficRecord[]) {
  return buildTrafficBatch(sweep, USER_ID, USER_LAT, USER_LON);
}

describe('1. drop the user by object id', () => {
  it('removes the record whose id matches the user object', () => {
    const batch = build([record({ id: USER_ID }), record({ id: 2 })]);
    expect(batch.map((o) => o.id)).toEqual([2]);
  });
});

describe('2. drop the user by position', () => {
  it('drops anything within 0.0001 degrees of the user in both axes', () => {
    const batch = build([
      record({ id: 2, lat: USER_LAT + 0.00005, lon: USER_LON - 0.00005 }),
      record({ id: 3, lat: USER_LAT, lon: USER_LON }),
    ]);
    expect(batch).toEqual([]);
  });

  it('keeps an aircraft just outside the guard', () => {
    const batch = build([record({ id: 2, lat: USER_LAT + 0.0002, lon: USER_LON })]);
    expect(batch.map((o) => o.id)).toEqual([2]);
  });

  it('needs both axes inside the guard to drop', () => {
    const batch = build([record({ id: 2, lat: USER_LAT, lon: USER_LON + 1 })]);
    expect(batch.map((o) => o.id)).toEqual([2]);
  });
});

describe('3. drop malformed ids and non-finite numbers', () => {
  it('drops a non-integer or negative id', () => {
    const batch = build([
      record({ id: 2.5 }),
      record({ id: -1 }),
      record({ id: Number.NaN }),
      record({ id: 7 }),
    ]);
    expect(batch.map((o) => o.id)).toEqual([7]);
  });

  for (const field of ['lat', 'lon', 'altitudeFt', 'headingDeg'] as const) {
    it(`drops a record whose ${field} is not finite`, () => {
      const batch = build([
        record({ id: 2, [field]: Number.NaN }),
        record({ id: 3, [field]: Number.POSITIVE_INFINITY }),
        record({ id: 4 }),
      ]);
      expect(batch.map((o) => o.id)).toEqual([4]);
    });
  }
});

describe('4. drop parked aircraft', () => {
  it('drops an on-ground aircraft below 1 kt', () => {
    const batch = build([
      record({ id: 2, onGround: true, groundSpeedKnots: 0 }),
      record({ id: 3, onGround: true, groundSpeedKnots: 0.9 }),
    ]);
    expect(batch).toEqual([]);
  });

  it('keeps an on-ground aircraft taxiing at 1 kt or more', () => {
    const batch = build([record({ id: 2, onGround: true, groundSpeedKnots: 1 })]);
    expect(batch.map((o) => o.id)).toEqual([2]);
  });

  it('keeps an airborne aircraft at zero ground speed', () => {
    const batch = build([record({ id: 2, onGround: false, groundSpeedKnots: 0 })]);
    expect(batch.map((o) => o.id)).toEqual([2]);
  });
});

describe('5. de-duplicate by id', () => {
  it('keeps first-occurrence order with the last occurrence value', () => {
    const batch = build([
      record({ id: 10, altitudeFt: 1000 }),
      record({ id: 20, altitudeFt: 2000 }),
      record({ id: 10, altitudeFt: 3000 }),
    ]);
    expect(batch.map((o) => o.id)).toEqual([10, 20]);
    expect(batch[0].altitudeFt).toBe(3000);
  });
});

describe('6. truncate at 200 objects', () => {
  it('emits at most MAX_BATCH_OBJECTS, keeping the earliest ids', () => {
    const sweep = Array.from({ length: 250 }, (_, i) => record({ id: 1000 + i }));
    const batch = build(sweep);
    expect(MAX_BATCH_OBJECTS).toBe(200);
    expect(batch).toHaveLength(200);
    expect(batch[0].id).toBe(1000);
    expect(batch[199].id).toBe(1199);
  });

  it('counts de-duplicated objects, not raw records', () => {
    const sweep = [
      ...Array.from({ length: 250 }, (_, i) => record({ id: 1000 + (i % 100) })),
    ];
    expect(build(sweep)).toHaveLength(100);
  });
});

describe('7. the emitted shape', () => {
  it('carries six fields and drops groundSpeedKnots', () => {
    const [emitted] = build([record({ id: 42, onGround: false })]);
    expect(emitted).toEqual({
      id: 42,
      lat: 38.0,
      lon: -121.0,
      altitudeFt: 5000,
      headingDeg: 90,
      onGround: false,
    });
    expect('groundSpeedKnots' in emitted).toBe(false);
  });

  it('normalises onGround to a real boolean', () => {
    const [emitted] = build([record({ id: 42, onGround: 1 as unknown as boolean })]);
    expect(emitted.onGround).toBe(false);
  });

  it('does not round: that is the server job', () => {
    const [emitted] = build([record({ id: 42, lat: 38.123456789 })]);
    expect(emitted.lat).toBe(38.123456789);
  });

  it('returns an empty batch for an empty sweep', () => {
    expect(build([])).toEqual([]);
  });
});
