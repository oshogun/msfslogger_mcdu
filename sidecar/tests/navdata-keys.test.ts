// tests/navdata-keys.test.ts — tests src/navdata-keys.ts.
//
// These keys are computed independently in the msfslogger server repo, from
// the same written expression, and a difference of one character there does not
// fail anywhere: it stores the same facility twice and the two databases stop
// agreeing. So every case that pinned the expression down is pinned here too —
// the terminal fixes that share ident and region, the sub-metre jitter, the
// negative zero, and the string ordering that must not be a locale comparison.
//
// Pure: this module imports no native addon, so these tests pass with
// better-sqlite3 missing entirely. Synthetic idents only.

import { describe, expect, it } from 'vitest';
import {
  airwayLegKey,
  airwayLegRow,
  cellId,
  cellSouthWest,
  coveredCells,
  freqKey,
  greatCircleKm,
  mergeRow,
  NAV_COVERAGE_CELL_MAX,
  NAV_HARVEST_RADIUS_KM,
  orderedEndpoints,
  procKey,
  rwyKey,
  transKey,
  wptKey,
  wrapLon,
} from '../src/navdata-keys';

describe('wptKey', () => {
  it('separates three fixes that share ident and region', () => {
    const keys = [
      wptKey('LOC10', 'ZZ', 10.1234, 20.5678),
      wptKey('LOC10', 'ZZ', 11.2345, 21.6789),
      wptKey('LOC10', 'ZZ', 12.3456, 22.7890),
    ];
    expect(keys[0]).toBe('LOC10|ZZ|1012340|2056780');
    expect(new Set(keys).size).toBe(3);
  });

  it('does not split a row for 4e-7 degrees of jitter', () => {
    expect(wptKey('LOC10', 'ZZ', 10.1234 + 0.0000004, 20.5678)).toBe(
      wptKey('LOC10', 'ZZ', 10.1234, 20.5678),
    );
  });

  it('splits two positions that are a whole 1e-5 degree apart', () => {
    expect(wptKey('LOC10', 'ZZ', 10.1234, 20.5678)).not.toBe(
      wptKey('LOC10', 'ZZ', 10.12341, 20.5678),
    );
  });

  it('normalises negative zero', () => {
    expect(wptKey('TESTA', 'ZZ', -0.0000001, 0)).toBe('TESTA|ZZ|0|0');
    expect(wptKey('TESTA', 'ZZ', 0, -0)).toBe('TESTA|ZZ|0|0');
    expect(wptKey('TESTA', 'ZZ', -0.0000001, 0)).toBe(wptKey('TESTA', 'ZZ', 0, -0));
  });

  it('keeps the sign of a real southern or western position', () => {
    expect(wptKey('TESTB', 'ZZ', -12.345, -45.678)).toBe('TESTB|ZZ|-1234500|-4567800');
  });
});

describe('airway leg keys', () => {
  it('orders endpoints by code unit, not by locale', () => {
    // 'B' sorts before 'a' by code unit and after it under an en collation.
    // Both repositories must use the code-unit answer.
    expect(orderedEndpoints('a', 'B')).toEqual(['B', 'a']);
    expect('a'.localeCompare('B')).toBeLessThan(0);
  });

  it('gives one key for the two reports of one leg', () => {
    const a = wptKey('TESTA', 'ZZ', 10, 20);
    const b = wptKey('TESTB', 'ZZ', 11, 21);
    expect(airwayLegKey('ZZ1', a, b)).toBe(airwayLegKey('ZZ1', b, a));
    expect(airwayLegKey('ZZ1', a, b)).toBe(`ZZ1|${a}|${b}`);
  });

  it('builds the same row whichever endpoint reported it', () => {
    const a = { ident: 'TESTA', region: 'ZZ', lat: 10, lon: 20 };
    const b = { ident: 'TESTB', region: 'ZZ', lat: 11, lon: 21 };
    expect(airwayLegRow('ZZ1', 5, a, b)).toEqual(airwayLegRow('ZZ1', 5, b, a));
  });

  it('flags a leg whose short way crosses the antimeridian', () => {
    const west = { ident: 'TESTC', region: 'ZZ', lat: 51, lon: 179.5 };
    const east = { ident: 'TESTD', region: 'ZZ', lat: 52, lon: -179.5 };
    const row = airwayLegRow('ZZ2', null, west, east);
    expect(row.dateline).toBe(1);
    expect(airwayLegRow('ZZ3', null, a10(), b10()).dateline).toBe(0);
  });

  function a10() {
    return { ident: 'TESTA', region: 'ZZ', lat: 10, lon: 20 };
  }
  function b10() {
    return { ident: 'TESTB', region: 'ZZ', lat: 11, lon: 21 };
  }
});

describe('the composite string keys', () => {
  it('renders an absent field as an empty slot, never as "null"', () => {
    expect(rwyKey('ZZZA', 9, null)).toBe('ZZZA|9|');
    expect(rwyKey('ZZZA', null, undefined)).toBe('ZZZA||');
    expect(freqKey('ZZZA', null, 118000000)).toBe('ZZZA||118000000');
    expect(
      procKey({ airportIdent: 'ZZZA', kind: 'SID', name: 'TEST1' }),
    ).toBe('ZZZA|SID|TEST1|||');
    expect(
      procKey({
        airportIdent: 'ZZZA',
        kind: 'APPROACH',
        name: 'ILS 09L',
        runwayNumber: 9,
        runwayDesignator: 1,
        suffix: 'Z',
      }),
    ).toBe('ZZZA|APPROACH|ILS 09L|9|1|Z');
  });

  it('hangs a transition off its procedure key', () => {
    const proc = procKey({ airportIdent: 'ZZZA', kind: 'STAR', name: 'TEST2' });
    expect(transKey(proc, 'common', '')).toBe('ZZZA|STAR|TEST2||||common|');
    expect(transKey(proc, 'enroute', 'TESTA')).toBe('ZZZA|STAR|TEST2||||enroute|TESTA');
  });
});

describe('the coverage grid', () => {
  it('maps a position to its cell and back to the cell corner', () => {
    expect(cellId(-90, -180)).toBe(0);
    expect(cellId(89.9, 179.9)).toBe(NAV_COVERAGE_CELL_MAX);
    expect(cellId(10.3456, 20.3456)).toBe(144400);
    expect(cellId(10.2, 20.4)).toBe(cellId(10.3456, 20.3456));
    expect(cellId(10.6, 20.4)).not.toBe(cellId(10.3456, 20.3456));
    expect(cellSouthWest(cellId(10.3456, 20.3456))).toEqual({ lat: 10, lon: 20 });
    expect(cellSouthWest(0)).toEqual({ lat: -90, lon: -180 });
  });

  it('covers 28 cells for one 200 km sweep, all four corners inside', () => {
    const cells = coveredCells(10.3456, 20.3456);
    expect(cells).toHaveLength(28);
    expect(new Set(cells).size).toBe(28);
    for (const id of cells) {
      const sw = cellSouthWest(id);
      const corners: Array<[number, number]> = [
        [sw.lat, sw.lon],
        [sw.lat + 0.5, sw.lon],
        [sw.lat, sw.lon + 0.5],
        [sw.lat + 0.5, sw.lon + 0.5],
      ];
      for (const [lat, lon] of corners) {
        expect(greatCircleKm(10.3456, 20.3456, lat, lon)).toBeLessThanOrEqual(
          NAV_HARVEST_RADIUS_KM,
        );
      }
    }
  });

  it('records far fewer cells on a 1 degree grid, which is why it is 0.5', () => {
    // The same disc measured with whole-degree cells: the corner test throws
    // away most of what the sweep actually harvested.
    const wide = coveredCells(10.3456, 20.3456, 100);
    expect(wide.length).toBeLessThan(coveredCells(10.3456, 20.3456).length);
  });

  it('records the cells on both sides of the antimeridian', () => {
    const cells = coveredCells(0, 179.9);
    const west = cells.map((id) => cellSouthWest(id).lon).filter((l) => l > 0);
    const east = cells.map((id) => cellSouthWest(id).lon).filter((l) => l < 0);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    expect(wrapLon(180)).toBe(-180);
    expect(wrapLon(180.5)).toBe(-179.5);
    expect(wrapLon(-180.5)).toBe(179.5);
  });

  // The window the search walks is sized by formula; this is the check that it
  // is not smaller than the disc it claims to cover. An exhaustive scan of all
  // 259 200 cells is the ground truth, and the poles and the antimeridian are
  // where a hand-sized window went wrong before.
  it.each([
    [10.3456, 20.3456],
    [0, 0],
    [82.5, 10],
    [-82.5, -10],
    [88.7, 100],
    [89.5, 100],
    [0, 179.9],
    [51.4, 180],
    [-33.9, 179.99],
    [45, -180],
  ])('matches an exhaustive scan of the whole grid at %s, %s', (lat, lon) => {
    const mine = new Set(coveredCells(lat, lon));
    const exhaustive: number[] = [];
    for (let id = 0; id <= NAV_COVERAGE_CELL_MAX; id++) {
      const sw = cellSouthWest(id);
      const corners: Array<[number, number]> = [
        [sw.lat, sw.lon],
        [sw.lat + 0.5, sw.lon],
        [sw.lat, sw.lon + 0.5],
        [sw.lat + 0.5, sw.lon + 0.5],
      ];
      if (corners.every(([a, b]) => greatCircleKm(lat, lon, a, b) <= NAV_HARVEST_RADIUS_KM)) {
        exhaustive.push(id);
      }
    }
    expect({
      missing: exhaustive.filter((id) => !mine.has(id)).length,
      extra: [...mine].filter((id) => !exhaustive.includes(id)).length,
      count: mine.size,
    }).toEqual({ missing: 0, extra: 0, count: exhaustive.length });
  });

  // The stated limit of the window sizing, as a test rather than a promise:
  // once the disc encloses the pole the far side is reachable over the top at
  // any longitude and the same-latitude bound stops holding. It costs cells,
  // never invents them, 11 km from a pole that the airport index does not even
  // reach. If someone widens the window, these numbers move and this test says
  // so instead of the comment quietly going stale.
  it('under-claims next to the pole, and never over-claims', () => {
    const mine = new Set(coveredCells(89.9, 100));
    const exhaustive: number[] = [];
    for (let id = 0; id <= NAV_COVERAGE_CELL_MAX; id++) {
      const sw = cellSouthWest(id);
      const corners: Array<[number, number]> = [
        [sw.lat, sw.lon],
        [sw.lat + 0.5, sw.lon],
        [sw.lat, sw.lon + 0.5],
        [sw.lat + 0.5, sw.lon + 0.5],
      ];
      if (corners.every(([a, b]) => greatCircleKm(89.9, 100, a, b) <= NAV_HARVEST_RADIUS_KM)) {
        exhaustive.push(id);
      }
    }
    expect({
      recorded: mine.size,
      truth: exhaustive.length,
      missing: exhaustive.filter((id) => !mine.has(id)).length,
      extra: [...mine].filter((id) => !exhaustive.includes(id)).length,
    }).toEqual({ recorded: 1959, truth: 2160, missing: 201, extra: 0 });
  });
});

describe('mergeRow', () => {
  const spec = {
    columns: ['kind', 'ident', 'region', 'lat', 'lon', 'position_source', 'frequency_hz', 'name', 'detail_state', 'rev'],
    defaults: { detail_state: 'index' },
    position: { sourceColumn: 'position_source', columns: ['lat', 'lon'] },
  };

  const stored = (row: Record<string, string | number | null>) => ({
    kind: 'V',
    ident: 'TSTA',
    region: 'ZZ',
    lat: null,
    lon: null,
    position_source: null,
    frequency_hz: null,
    name: null,
    detail_state: 'index',
    rev: 1,
    ...row,
  });

  it('fills a position that arrives after the detail', () => {
    const first = mergeRow(null, {
      kind: 'V',
      ident: 'TSTA',
      region: 'ZZ',
      frequency_hz: 113400000,
      name: 'TEST ALPHA',
      detail_state: 'detail',
    }, spec);
    expect(first.changed).toBe(true);

    const second = mergeRow(stored(first.row), {
      kind: 'V',
      ident: 'TSTA',
      region: 'ZZ',
      lat: 12.5,
      lon: 34.5,
      position_source: 'list',
    }, spec);
    expect(second.row).toMatchObject({
      lat: 12.5,
      frequency_hz: 113400000,
      detail_state: 'detail',
    });
  });

  it('does not let a detail with no position erase one already stored', () => {
    const positioned = stored({ lat: -5.25, lon: 100.75, position_source: 'list' });
    const merged = mergeRow(positioned, {
      kind: 'V',
      ident: 'TSTB',
      region: 'ZZ',
      frequency_hz: 115000000,
      detail_state: 'detail',
    }, spec);
    expect(merged.row).toMatchObject({ lat: -5.25, lon: 100.75, frequency_hz: 115000000 });
  });

  it('writes nothing it does not have when a re-fetch comes back thin', () => {
    const full = stored({
      ident: 'TSTB',
      lat: -5.25,
      lon: 100.75,
      frequency_hz: 115000000,
      detail_state: 'detail',
    });
    const merged = mergeRow(full, { kind: 'V', ident: 'TSTB', region: 'ZZ' }, spec);
    expect(merged.changed).toBe(false);
    expect(merged.row).toMatchObject({ lat: -5.25, lon: 100.75, frequency_hz: 115000000 });
  });

  it('ignores rev when deciding whether anything changed', () => {
    const full = stored({ lat: 1, lon: 2, position_source: 'list', rev: 7 });
    const merged = mergeRow(full, { kind: 'V', ident: 'TSTA', region: 'ZZ', rev: 99 }, spec);
    expect(merged.changed).toBe(false);
    expect(merged.row.rev).toBeUndefined();
  });

  it('keeps a facility position against a weaker minimal-list one', () => {
    const strong = stored({ lat: 10, lon: 20, position_source: 'facility' });
    const merged = mergeRow(strong, {
      kind: 'V',
      ident: 'TSTA',
      region: 'ZZ',
      lat: 11,
      lon: 21,
      position_source: 'minimal',
    }, spec);
    expect(merged.changed).toBe(false);
    expect(merged.row).toMatchObject({ lat: 10, lon: 20, position_source: 'facility' });
  });

  it('takes a position from an equal or stronger source', () => {
    const weak = stored({ lat: 10, lon: 20, position_source: 'minimal' });
    const equal = mergeRow(weak, { lat: 11, lon: 21, position_source: 'minimal' }, spec);
    expect(equal.row).toMatchObject({ lat: 11, lon: 21 });
    const stronger = mergeRow(weak, { lat: 12, lon: 22, position_source: 'list' }, spec);
    expect(stronger.row).toMatchObject({ lat: 12, lon: 22, position_source: 'list' });
  });

  it('fills an empty position from a weak source', () => {
    const empty = stored({ position_source: 'facility' });
    const merged = mergeRow(empty, { lat: 5, lon: 6, position_source: 'minimal' }, spec);
    expect(merged.row).toMatchObject({ lat: 5, lon: 6, position_source: 'minimal' });
  });

  it('applies a NOT NULL default rather than writing a null', () => {
    const merged = mergeRow(null, { kind: 'N', ident: 'TSTC', region: 'ZZ' }, spec);
    expect(merged.row.detail_state).toBe('index');
  });

  it('turns a boolean into the 0 or 1 a STRICT column will take', () => {
    const merged = mergeRow(null, { kind: 'N', ident: 'TSTD', region: 'ZZ', frequency_hz: true }, spec);
    expect(merged.row.frequency_hz).toBe(1);
  });
});
