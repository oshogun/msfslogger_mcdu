// tests/navdata-schema.test.ts — tests src/navdata-schema.ts.
//
// The DDL in that module is a verbatim copy of a schema that is maintained by
// hand in two repositories which cannot share code. Nothing in TypeScript can
// catch a divergence, so these tests apply the DDL to a throwaway in-memory
// database and assert the shape it produces: the table count, the index count,
// that every table is STRICT, and that the columns match the list the store
// checks against at open.
//
// Then the two properties that are schema rules rather than code rules: STRICT
// really does reject a text value in a REAL column, and deleting an airport
// cascades to its runways, procedures, transitions and legs.
//
// Synthetic idents only (ZZZA, TESTA, ...). No real navdata, no %APPDATA%, no
// file on disk: every database here is ':memory:'.

import { describe, expect, it } from 'vitest';
import {
  NAVDATA_SCHEMA_SQL,
  NAVDATA_SCHEMA_VERSION,
  NAVDATA_TABLE_COLUMNS,
  NAVDATA_TABLES,
} from '../src/navdata-schema';

// The driver is required the same lazy way the store requires it.
const Database = require('better-sqlite3');

interface Row {
  [column: string]: unknown;
}

function freshDb(): {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...p: unknown[]): Row | undefined; all(...p: unknown[]): Row[]; run(...p: unknown[]): unknown };
  close(): void;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(NAVDATA_SCHEMA_SQL);
  return db;
}

describe('the embedded DDL', () => {
  it('creates 13 tables, 30 indexes, and every table is STRICT', () => {
    const db = freshDb();
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all();
    const strict = tables.filter((t) => String(t.sql).includes('STRICT'));

    expect(tables.map((t) => t.name)).toEqual([
      'nav_absent',
      'nav_airport',
      'nav_airport_frequency',
      'nav_airway_leg',
      'nav_coverage_cell',
      'nav_meta',
      'nav_navaid',
      'nav_procedure',
      'nav_procedure_leg',
      'nav_procedure_transition',
      'nav_runway',
      'nav_sync',
      'nav_waypoint',
    ]);
    expect(tables).toHaveLength(13);
    expect(indexes).toHaveLength(30);
    expect(strict).toHaveLength(13);
    db.close();
  });

  it('produces exactly the columns the store checks for, in order', () => {
    const db = freshDb();
    for (const table of NAVDATA_TABLES) {
      const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      expect(actual, table).toEqual([...NAVDATA_TABLE_COLUMNS[table]]);
    }
    db.close();
  });

  it('pins the schema version that both repositories check on the wire', () => {
    expect(NAVDATA_SCHEMA_VERSION).toBe(2);
    expect(NAVDATA_SCHEMA_SQL).toContain('NAVDATA_SCHEMA_VERSION = 2');
  });

  it('carries the displaced thresholds, in the position the contract puts them', () => {
    // Stated here rather than left to the loop above, which compares the DDL
    // against a list generated from the same DDL and would agree with itself.
    // Column order is load-bearing: the store reads it from PRAGMA table_info.
    const runway = [...NAVDATA_TABLE_COLUMNS.nav_runway];
    expect(runway.slice(runway.indexOf('length_m'), runway.indexOf('slope_deg'))).toEqual([
      'length_m',
      'width_m',
      'primary_threshold_m',
      'secondary_threshold_m',
      'pattern_altitude_m',
    ]);
  });

  it('enforces column types: STRICT rejects text in a REAL column', () => {
    const db = freshDb();
    expect(() =>
      db.prepare("INSERT INTO nav_airport (ident, lat, rev) VALUES ('ZZZX', 'not-a-number', 1)").run(),
    ).toThrow(/cannot store TEXT value in REAL column/);
    db.close();
  });

  it('cascades an airport delete to its runways, procedures and legs', () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO nav_airport (ident, lat, lon, detail_state, rev) VALUES ('ZZZA', 1.0, 2.0, 'detail', 1)",
    ).run();
    db.prepare(
      "INSERT INTO nav_runway (rwy_key, airport_ident, primary_number, rev) VALUES ('ZZZA|9|0', 'ZZZA', 9, 1)",
    ).run();
    db.prepare(
      "INSERT INTO nav_airport_frequency (freq_key, airport_ident, frequency_hz, rev)" +
        " VALUES ('ZZZA|1|118000000', 'ZZZA', 118000000, 1)",
    ).run();
    db.prepare(
      "INSERT INTO nav_procedure (proc_key, airport_ident, kind, name, rev)" +
        " VALUES ('ZZZA|SID|TEST1|||', 'ZZZA', 'SID', 'TEST1', 1)",
    ).run();
    db.prepare(
      "INSERT INTO nav_procedure_transition (trans_key, proc_key, role, name, rev)" +
        " VALUES ('ZZZA|SID|TEST1||||common|', 'ZZZA|SID|TEST1|||', 'common', '', 1)",
    ).run();
    db.prepare(
      "INSERT INTO nav_procedure_leg (trans_key, seq, leg_type, fix_ident, fix_lat, fix_lon, rev)" +
        " VALUES ('ZZZA|SID|TEST1||||common|', 0, 18, 'TESTA', 10.0, 20.0, 1)",
    ).run();

    db.prepare("DELETE FROM nav_airport WHERE ident = 'ZZZA'").run();

    const remaining = db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM nav_runway) AS runways,' +
          ' (SELECT COUNT(*) FROM nav_airport_frequency) AS frequencies,' +
          ' (SELECT COUNT(*) FROM nav_procedure) AS procedures,' +
          ' (SELECT COUNT(*) FROM nav_procedure_transition) AS transitions,' +
          ' (SELECT COUNT(*) FROM nav_procedure_leg) AS legs',
      )
      .get();
    expect(remaining).toEqual({
      runways: 0,
      frequencies: 0,
      procedures: 0,
      transitions: 0,
      legs: 0,
    });
    db.close();
  });

  it('stores three same-ident, same-region terminal fixes as three rows', () => {
    const db = freshDb();
    const insert = db.prepare(
      'INSERT INTO nav_waypoint (wpt_key, ident, region, lat, lon, rev) VALUES (?, ?, ?, ?, ?, 1)',
    );
    for (const [lat, lon] of [
      [10.1234, 20.5678],
      [11.2345, 21.6789],
      [12.3456, 22.7890],
    ]) {
      insert.run(`LOC10|ZZ|${Math.round(lat * 1e5)}|${Math.round(lon * 1e5)}`, 'LOC10', 'ZZ', lat, lon);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM nav_waypoint WHERE ident='LOC10'").get()?.n).toBe(3);
    db.close();
  });
});
