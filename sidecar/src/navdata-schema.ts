// ── Navdata schema: the DDL, verbatim ─────────────────────────────────────────
//
// NAVDATA_SCHEMA_SQL is a verbatim copy of a schema that lives in two
// repositories which cannot share code: this file, and src/navdata-schema.sql
// in the msfslogger server repo. The two copies must stay byte-identical. A
// column added on one side is not a compile error on the other, it is a row
// that silently stops syncing, so a schema change is one edit, two pastes and
// a bump of NAVDATA_SCHEMA_VERSION, in one change set. The version travels in
// every wire payload and a peer whose version differs is refused outright,
// never half-applied. A local database of the wrong version is not refused: it
// is a rebuildable cache, and the store renames it aside and starts again.
//
// NAVDATA_TABLE_COLUMNS restates the column names in TypeScript. It types a
// row for the store and, more importantly, it is checked against what the DDL
// actually created when the database is opened, so a botched paste fails at
// open instead of at the first batch that quietly drops a column.
//
// Pure data: no import, no I/O, no native addon. Importing this module is safe
// with better-sqlite3 absent.

export const NAVDATA_SCHEMA_VERSION = 2;

/** Applied with `exec`, statement for statement, exactly as written. */
export const NAVDATA_SCHEMA_SQL = `-- ─────────────────────────────────────────────────────────────────────────────
-- msfslogger navdata schema — THE authoritative copy.
--
-- DUPLICATION HAZARD. This file is the single source of truth for a schema
-- that lives in two repositories which cannot share code:
--
--   * msfslogger_mcdu (Windows client)  — sidecar/src/navdata-schema.ts
--   * msfslogger      (Linux server)    — src/navdata-schema.sql
--
-- Paste it verbatim into both. Do not hand-edit one side. The server repo
-- already lives with this hazard between src/types.ts and client/src/types.ts,
-- and it bites in exactly the same way: a column added on one side is not a
-- compile error on the other, it is a row that silently stops syncing.
-- NAVDATA_SCHEMA_VERSION below is the tripwire: bump it on any change here,
-- and both sides reject a peer whose version differs.
--
-- Requires SQLite 3.37 or newer (STRICT tables). The sidecar gets this from
-- better-sqlite3; the server's better-sqlite3 ^9.4.3 bundles SQLite 3.45.
--
-- LICENCE / PRIVACY. On an install with navigraph-navdata in the Community
-- folder, every row below is Navigraph-derived. The database file and any
-- export of it are local-only: gitignored on both sides, bind-mounted into the
-- server container, never committed, never baked into a Docker image, never
-- used as a test fixture. Test fixtures are synthetic idents only.
--
-- UNITS. Distances and altitudes are metres, angles are degrees, frequencies
-- are whole hertz, timestamps are integer epoch milliseconds. Latitude and
-- longitude are WGS-84 degrees, longitude in [-180, 180]; nothing in this
-- schema stores an unwrapped longitude.
-- ─────────────────────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- NAVDATA_SCHEMA_VERSION = 2
-- Mirrored as a constant in sidecar/src/navdata-schema.ts and in the server's
-- src/navdata-schema.ts. Stored in nav_meta.schema_version and sent in every
-- wire payload so a mismatch is refused loudly instead of half-applied.
--
-- A PEER WHOSE VERSION DIFFERS IS REFUSED, NOT RECONCILED. A v2 sender against
-- a v1 replica, or the reverse, is answered NAVDATA_SCHEMA_UNSUPPORTED and the
-- exchange stops; neither side may guess at a missing or surplus column. A LOCAL
-- file of the wrong version is a different matter: it is a rebuildable cache, so
-- it is renamed aside and recreated rather than refused forever.
--
-- v2 (2026-09-20): nav_runway gains primary_threshold_m / secondary_threshold_m.
-- v1: initial.

-- ── nav_meta ─────────────────────────────────────────────────────────────────
-- Exactly one row. Owned by the sidecar; the server keeps its own copy of this
-- table describing the replica it holds.
--
-- snapshot_id is an opaque epoch minted per bulk extraction that has to reset
-- the replica wholesale. rev is a monotonic counter that is meaningful ONLY
-- within one epoch: comparing revs across snapshot_ids is undefined. A
-- snapshot always wins regardless of max(rev).
CREATE TABLE IF NOT EXISTS nav_meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version     INTEGER NOT NULL,
  -- Opaque. Format is deliberately unspecified to consumers; the sidecar mints
  -- it as <epoch-ms>-<8 hex of crypto.randomBytes(4)>. Never parsed, only
  -- compared for equality.
  snapshot_id        TEXT    NOT NULL,
  -- Bumped once per write transaction, not once per row. Every row written in
  -- that transaction carries that rev.
  rev                INTEGER NOT NULL DEFAULT 0,
  sim_id             TEXT    NOT NULL CHECK (sim_id IN ('2020','2024','fsx')),
  sim_app_name       TEXT,
  sim_app_version    TEXT,
  -- NULL until a bulk airport list has completed. A NULL here means the last
  -- bulk was interrupted and must be redone from scratch.
  bulk_started_at    INTEGER,
  bulk_completed_at  INTEGER,
  bulk_row_count     INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;

-- ── nav_sync ─────────────────────────────────────────────────────────────────
-- Sidecar-only. What a given server has acknowledged, so a sidecar restart
-- resumes instead of re-uploading. Keyed by server URL because pointing the
-- client at a different server invalidates the cursor, exactly as the datalink
-- drops a prefiled leg when serverUrl changes.
CREATE TABLE IF NOT EXISTS nav_sync (
  server_url       TEXT PRIMARY KEY,
  -- The epoch the server last confirmed. NULL = never synced to this server.
  snapshot_id      TEXT,
  acked_rev        INTEGER NOT NULL DEFAULT 0,
  state            TEXT    NOT NULL DEFAULT 'idle'
                     CHECK (state IN ('idle','snapshot-required','snapshot-sending',
                                      'incremental','resync-required','failed')),
  last_ok_at       INTEGER,
  last_error_at    INTEGER,
  last_error_code  TEXT,
  updated_at       INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- ── nav_airport ──────────────────────────────────────────────────────────────
-- Two populations in one table:
--   * the bulk index — 41 871 rows measured, from requestFacilitiesList(AIRPORT),
--     which carries ident/region/lat/lon/alt and nothing else;
--   * on-demand detail — from requestFacilityData(AIRPORT), which adds the
--     header fields and hangs runways, frequencies and procedures off this row.
--
-- KEY: ident alone. All 41 871 bulk rows carry an EMPTY region (measured), and
-- all 41 871 idents are distinct with zero duplicates (measured). Region is a
-- navaid/fix concept here, not an airport one, so it is stored but never keyed
-- on. requestFacilityData addresses an airport by ident alone, which makes
-- ident the only key the extractor can actually ask for.
CREATE TABLE IF NOT EXISTS nav_airport (
  ident              TEXT PRIMARY KEY,
  region             TEXT NOT NULL DEFAULT '',
  lat                REAL,
  lon                REAL,
  alt_m              REAL,
  magvar             REAL,
  name               TEXT,
  n_runways          INTEGER,
  n_approaches       INTEGER,
  n_departures       INTEGER,
  n_arrivals         INTEGER,
  -- Coverage, airport-shaped. 'index' = position only, from the bulk list.
  -- 'detail' = a requestFacilityData completed for it; combined with the four
  -- n_* counters this answers "was it fetched, and did it have procedures at
  -- all" — n_approaches = 0 with detail_state = 'detail' is a real answer
  -- (measured: a small airport can report 0 approaches, 0 SIDs and 0 STARs).
  detail_state       TEXT NOT NULL DEFAULT 'index'
                       CHECK (detail_state IN ('index','pending','detail','absent','failed')),
  detail_fetched_at  INTEGER,
  -- Counts actually stored after the last detail fetch, so the server can tell
  -- "no runways drawn because there are none" from "detail never arrived".
  detail_runways     INTEGER NOT NULL DEFAULT 0,
  detail_procedures  INTEGER NOT NULL DEFAULT 0,
  position_source    TEXT CHECK (position_source IN ('list','minimal','facility')),
  rev                INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_airport_bbox ON nav_airport (lat, lon);
CREATE INDEX IF NOT EXISTS nav_airport_rev  ON nav_airport (rev);
CREATE INDEX IF NOT EXISTS nav_airport_pending
  ON nav_airport (detail_state) WHERE detail_state = 'pending';

-- ── nav_navaid ───────────────────────────────────────────────────────────────
-- VORs (kind 'V', which includes VOR/DME, VORTAC, ILS/LOC and TACAN on this
-- API) and NDBs (kind 'N').
--
-- KEY: (kind, ident, region) — the request key. requestFacilityData can name a
-- navaid by ident + region + type and by nothing else, so anything finer could
-- never be re-fetched. kind is in the key because a VOR and an NDB routinely
-- share an ident within a region. Measured support: 59 VORs in the RJ bubble,
-- 59 distinct idents, 0 duplicates; an ident with no region resolves world-wide
-- to one row per region (STD -> EN, SV, RJ).
--
-- POSITION. On this build a VOR's facility data carries NO station
-- LATITUDE/LONGITUDE/ALTITUDE — those three members are rejected outright
-- (measured: "vor rejected: LATITUDE LONGITUDE ALTITUDE"). The station
-- position therefore comes only from the list API or from a minimal list,
-- while everything else comes from facility data. One row is assembled from
-- two calls that can arrive in either order. See the merge rules; in schema
-- terms that is why every non-identity column here is nullable.
CREATE TABLE IF NOT EXISTS nav_navaid (
  kind               TEXT NOT NULL CHECK (kind IN ('V','N')),
  ident              TEXT NOT NULL,
  region             TEXT NOT NULL,
  -- Station position. NULL until a list row or a minimal-list row supplies it.
  lat                REAL,
  lon                REAL,
  alt_m              REAL,
  position_source    TEXT CHECK (position_source IN ('list','minimal','facility')),
  position_fetched_at INTEGER,
  -- Detail, from requestFacilityData.
  frequency_hz       INTEGER,
  nav_type           INTEGER,
  name               TEXT,
  magvar             REAL,
  nav_range_m        REAL,
  is_nav             INTEGER CHECK (is_nav IN (0,1)),
  is_dme             INTEGER CHECK (is_dme IN (0,1)),
  is_tacan           INTEGER CHECK (is_tacan IN (0,1)),
  has_glide_slope    INTEGER CHECK (has_glide_slope IN (0,1)),
  has_back_course    INTEGER CHECK (has_back_course IN (0,1)),
  dme_at_nav         INTEGER CHECK (dme_at_nav IN (0,1)),
  dme_at_glide_slope INTEGER CHECK (dme_at_glide_slope IN (0,1)),
  localizer_deg      REAL,
  localizer_width_deg REAL,
  gs_lat             REAL,
  gs_lon             REAL,
  gs_alt_m           REAL,
  dme_lat            REAL,
  dme_lon            REAL,
  dme_alt_m          REAL,
  tacan_lat          REAL,
  tacan_lon          REAL,
  tacan_alt_m        REAL,
  -- Owning airport for a terminal navaid (an ILS/LOC), from a minimal list's
  -- Icao.airport field when that field is populated. Advisory only: it is not
  -- part of the key and nothing may require it.
  airport_ident      TEXT,
  detail_state       TEXT NOT NULL DEFAULT 'index'
                       CHECK (detail_state IN ('index','pending','detail','absent','failed')),
  detail_fetched_at  INTEGER,
  -- Set when a minimal list returned more than one station for this exact
  -- (kind, ident, region). Expected to stay 0; if it ever goes to 1 the key
  -- assumption above is wrong and the features route should say so.
  ambiguous          INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0,1)),
  rev                INTEGER NOT NULL,
  PRIMARY KEY (kind, ident, region)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_navaid_bbox  ON nav_navaid (lat, lon);
CREATE INDEX IF NOT EXISTS nav_navaid_rev   ON nav_navaid (rev);
CREATE INDEX IF NOT EXISTS nav_navaid_ident ON nav_navaid (ident);

-- ── nav_waypoint ─────────────────────────────────────────────────────────────
-- THE TERMINAL-WAYPOINT KEY PROBLEM, and why the key is what it is.
--
-- Measured: one ~350 km bubble returned 1349 waypoints with 1338 distinct
-- idents — LOC10 x3, 36LOC x2, CS25 x2, MA25 x2, CF10 x2 and four more. All of
-- them are terminal fixes repeated once per owning airport. All the duplicates
-- share ONE region (RJ), so (ident, region) is NOT a unique key and cannot be
-- the primary key. Only the owning airport separates them, and:
--
--   * requestFacilitiesList / subscribeToFacilities return ident, region,
--     lat, lon, alt and magvar. No airport.
--   * requestFacilityData(WAYPOINT) accepts ICAO, REGION and IS_TERMINAL_WPT
--     but has no airport member, and cannot be *addressed* by airport either —
--     its parameters are (ident, region, type) and nothing else.
--   * only the facilityMinimalList reply carries an owning airport, in
--     Icao.airport, and only for the ambiguous-ident case.
--
-- So an airport-scoped key would be unfillable on the path that produces most
-- of these rows. What every path does carry is the position: the list rows,
-- the minimal-list rows, the WAYPOINT facility data (LATITUDE/LONGITUDE are
-- accepted here, unlike on VOR) and the NEXT_/PREV_ endpoints of a ROUTE child
-- all carry lat/lon. The key is therefore position-qualified:
--
--   wpt_key = ident || '|' || region || '|' || latE5 || '|' || lonE5
--   latE5   = String(Math.round(lat * 1e5))      -- ~1.1 m resolution
--   lonE5   = String(Math.round(lon * 1e5))
--
-- Two distinct fixes are never within 1.1 m of each other, so this never
-- merges two real fixes; two rows for the same fix from two sources round to
-- the same key, so it never splits one. Negative zero is normalised to 0 by
-- Math.round + String, and both repos must use exactly this expression.
-- airport_ident stays as an advisory attribute for labelling, never a key.
CREATE TABLE IF NOT EXISTS nav_waypoint (
  wpt_key            TEXT PRIMARY KEY,
  ident              TEXT NOT NULL,
  region             TEXT NOT NULL,
  -- NOT NULL: the key cannot be computed without them, so a row cannot exist
  -- without a position. This is the structural difference from nav_navaid.
  lat                REAL NOT NULL,
  lon                REAL NOT NULL,
  alt_m              REAL,
  magvar             REAL,
  wpt_type           INTEGER,
  -- From IS_TERMINAL_WPT in facility data; NULL until a detail fetch. A five
  -- plain-letter ident is a strong hint but never authoritative.
  is_terminal        INTEGER CHECK (is_terminal IN (0,1)),
  airport_ident      TEXT,
  -- The simulator's own N_ROUTES. Its value lets a 0-child ROUTE fetch be told
  -- apart from a fetch that silently returned nothing: measured, the ROUTE
  -- child count matches N_ROUTES exactly (70*1 + 29*2 + 8*3 + 1*4 + 2*6 = 168).
  n_routes           INTEGER,
  routes_state       TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (routes_state IN ('unknown','pending','fetched','absent','failed')),
  routes_fetched_at  INTEGER,
  position_source    TEXT CHECK (position_source IN ('list','minimal','facility','route')),
  rev                INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_waypoint_bbox  ON nav_waypoint (lat, lon);
CREATE INDEX IF NOT EXISTS nav_waypoint_ident ON nav_waypoint (ident, region);
CREATE INDEX IF NOT EXISTS nav_waypoint_rev   ON nav_waypoint (rev);
CREATE INDEX IF NOT EXISTS nav_waypoint_unrouted
  ON nav_waypoint (routes_state) WHERE routes_state = 'unknown';

-- ── nav_airway_leg ───────────────────────────────────────────────────────────
-- One row per airway segment. A WAYPOINT's ROUTE children each carry the
-- airway name and BOTH neighbours complete with ident, region, type and
-- lat/lon/alt, so a leg is self-contained: drawing an airway needs no join.
--
-- Every physical leg is reported twice, once from each endpoint. The key
-- canonicalises direction so the second report is an idempotent no-op:
--
--   (a, b) = the two endpoint wpt_keys; lo = min(a,b), hi = max(a,b) by
--   ordinary JS string comparison (< on strings), which both repos must use.
--   leg_key = airway || '|' || lo || '|' || hi
--
-- Direction is not stored. These rows exist to be drawn, not to be flown: a
-- one-way airway drawn in both directions is the same line.
CREATE TABLE IF NOT EXISTS nav_airway_leg (
  leg_key        TEXT PRIMARY KEY,
  airway         TEXT NOT NULL,
  airway_type    INTEGER,
  from_key       TEXT NOT NULL,
  to_key         TEXT NOT NULL,
  from_ident     TEXT NOT NULL,
  from_region    TEXT NOT NULL,
  from_lat       REAL NOT NULL,
  from_lon       REAL NOT NULL,
  to_ident       TEXT NOT NULL,
  to_region      TEXT NOT NULL,
  to_lat         REAL NOT NULL,
  to_lon         REAL NOT NULL,
  -- Bounding box of the leg, stored rather than computed, so a bbox query is
  -- one indexed range scan in both repos with no SQL dialect games.
  -- dateline = 1 when |from_lon - to_lon| > 180, i.e. the short way round
  -- crosses the antimeridian; then min_lon/max_lon are meaningless and the
  -- bbox predicate must fall back to a latitude-only test for this row.
  min_lat        REAL NOT NULL,
  max_lat        REAL NOT NULL,
  min_lon        REAL NOT NULL,
  max_lon        REAL NOT NULL,
  dateline       INTEGER NOT NULL DEFAULT 0 CHECK (dateline IN (0,1)),
  rev            INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_airway_leg_name ON nav_airway_leg (airway);
CREATE INDEX IF NOT EXISTS nav_airway_leg_from ON nav_airway_leg (from_key);
CREATE INDEX IF NOT EXISTS nav_airway_leg_to   ON nav_airway_leg (to_key);
CREATE INDEX IF NOT EXISTS nav_airway_leg_bbox ON nav_airway_leg (min_lat, max_lat);
CREATE INDEX IF NOT EXISTS nav_airway_leg_rev  ON nav_airway_leg (rev);
CREATE INDEX IF NOT EXISTS nav_airway_leg_dateline
  ON nav_airway_leg (dateline) WHERE dateline = 1;

-- ── nav_runway ───────────────────────────────────────────────────────────────
-- One row per physical runway (both ends in one row, as the API reports it).
-- lat/lon/alt are the runway CENTRE; the two thresholds are derived from
-- centre + heading + length by the consumer, not stored.
--
-- KEY: (airport_ident, primary_number, primary_designator). The API gives no
-- stable runway id; the primary end designation is unique within an airport.
CREATE TABLE IF NOT EXISTS nav_runway (
  rwy_key                 TEXT PRIMARY KEY,
  airport_ident           TEXT NOT NULL,
  lat                     REAL,
  lon                     REAL,
  alt_m                   REAL,
  heading_deg             REAL,
  length_m                REAL,
  width_m                 REAL,
  -- Displaced threshold, in metres from the pavement end, per end. NULL and 0
  -- both mean not displaced. MEASURED: displaced thresholds are non-zero on
  -- real runways, and length_m INCLUDES the displaced portions, so the
  -- usable length is shorter than length_m. An instrument final is
  -- referenced to the LANDING threshold, so a final projected from the pavement
  -- end starts ~200 m off on such a runway. Derivation:
  --   pavement end      = lat/lon (the CENTRE) +/- length_m/2 along the bearing
  --   landing threshold = that point moved INBOARD by the matching value here
  -- primary_* pairs with the primary end, i.e. the heading_deg direction.
  -- PROVISIONAL: that pairing is confirmed by arithmetic on ONE runway (the
  -- only non-zero sample so far) plus the member naming.
  primary_threshold_m     REAL,
  secondary_threshold_m   REAL,
  pattern_altitude_m      REAL,
  slope_deg               REAL,
  true_slope_deg          REAL,
  surface                 INTEGER,
  primary_number          INTEGER,
  primary_designator      INTEGER,
  secondary_number        INTEGER,
  secondary_designator    INTEGER,
  primary_ils_ident       TEXT,
  primary_ils_region      TEXT,
  secondary_ils_ident     TEXT,
  secondary_ils_region    TEXT,
  rev                     INTEGER NOT NULL,
  FOREIGN KEY (airport_ident) REFERENCES nav_airport (ident) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_runway_airport ON nav_runway (airport_ident);
CREATE INDEX IF NOT EXISTS nav_runway_bbox    ON nav_runway (lat, lon);
CREATE INDEX IF NOT EXISTS nav_runway_rev     ON nav_runway (rev);

-- ── nav_airport_frequency ────────────────────────────────────────────────────
-- Near-free: a handful of rows per airport, a few dozen at the largest.
CREATE TABLE IF NOT EXISTS nav_airport_frequency (
  freq_key       TEXT PRIMARY KEY,   -- airport_ident || '|' || type || '|' || frequency_hz
  airport_ident  TEXT NOT NULL,
  freq_type      INTEGER,
  frequency_hz   INTEGER,
  name           TEXT,
  rev            INTEGER NOT NULL,
  FOREIGN KEY (airport_ident) REFERENCES nav_airport (ident) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_airport_frequency_airport ON nav_airport_frequency (airport_ident);
CREATE INDEX IF NOT EXISTS nav_airport_frequency_rev     ON nav_airport_frequency (rev);

-- ── nav_procedure ────────────────────────────────────────────────────────────
-- SIDs (DEPARTURE), STARs (ARRIVAL) and approaches (APPROACH).
--
-- KEY: airport || '|' || kind || '|' || name || '|' || runway_number || '|' ||
--      runway_designator || '|' || suffix, with NULLs rendered as ''. An
-- approach has no NAME member, so its name slot carries its TYPE and runway;
-- two approaches to the same runway are separated by SUFFIX.
CREATE TABLE IF NOT EXISTS nav_procedure (
  proc_key                TEXT PRIMARY KEY,
  airport_ident           TEXT NOT NULL,
  kind                    TEXT NOT NULL CHECK (kind IN ('SID','STAR','APPROACH')),
  name                    TEXT NOT NULL,
  runway_number           INTEGER,
  runway_designator       INTEGER,
  approach_type           INTEGER,
  suffix                  TEXT,
  faf_ident               TEXT,
  faf_region              TEXT,
  faf_alt_m               REAL,
  faf_heading_deg         REAL,
  missed_alt_m            REAL,
  has_lnav                INTEGER CHECK (has_lnav IN (0,1)),
  has_lnavvnav            INTEGER CHECK (has_lnavvnav IN (0,1)),
  has_lp                  INTEGER CHECK (has_lp IN (0,1)),
  has_lpv                 INTEGER CHECK (has_lpv IN (0,1)),
  n_transitions           INTEGER,
  n_runway_transitions    INTEGER,
  n_enroute_transitions   INTEGER,
  rev                     INTEGER NOT NULL,
  FOREIGN KEY (airport_ident) REFERENCES nav_airport (ident) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_procedure_airport ON nav_procedure (airport_ident, kind);
CREATE INDEX IF NOT EXISTS nav_procedure_name    ON nav_procedure (airport_ident, kind, name);
CREATE INDEX IF NOT EXISTS nav_procedure_rev     ON nav_procedure (rev);

-- ── nav_procedure_transition ─────────────────────────────────────────────────
-- Every leg list in the tree hangs off one of these, INCLUDING the procedure's
-- own common legs.
--
-- Measured and load-bearing: a SID/STAR's common legs hang straight off
-- DEPARTURE/ARRIVAL, not off a transition. With APPROACH_LEG only under the
-- transitions, EGLL's STARs gave ARRIVAL=18 and ZERO legs; adding APPROACH_LEG
-- as a direct child of ARRIVAL gives APPROACH_LEG=79 ARRIVAL=18. Those common
-- legs are stored here with role = 'common' and name = '' so that every leg in
-- the database has a parent of the same shape.
--
-- role:
--   'common'   — legs directly under DEPARTURE/ARRIVAL (the middle of the SID/STAR)
--   'runway'   — RUNWAY_TRANSITION
--   'enroute'  — ENROUTE_TRANSITION
--   'approach' — APPROACH_TRANSITION
--   'final'    — FINAL_APPROACH_LEG list (a synthetic transition; both this and
--                'missed' were measured to work: FINAL_APPROACH_LEG=40,
--                MISSED_APPROACH_LEG=25 at EGLL, no exception at OPEN or request)
--   'missed'   — MISSED_APPROACH_LEG list
CREATE TABLE IF NOT EXISTS nav_procedure_transition (
  trans_key           TEXT PRIMARY KEY,  -- proc_key || '|' || role || '|' || name
  proc_key            TEXT NOT NULL,
  role                TEXT NOT NULL
                        CHECK (role IN ('common','runway','enroute','approach','final','missed')),
  name                TEXT NOT NULL DEFAULT '',
  runway_number       INTEGER,
  runway_designator   INTEGER,
  trans_type          INTEGER,
  iaf_ident           TEXT,
  iaf_region          TEXT,
  iaf_alt_m           REAL,
  dme_arc_ident       TEXT,
  dme_arc_region      TEXT,
  dme_arc_radial_deg  REAL,
  dme_arc_distance_m  REAL,
  n_legs              INTEGER,
  rev                 INTEGER NOT NULL,
  FOREIGN KEY (proc_key) REFERENCES nav_procedure (proc_key) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_procedure_transition_proc ON nav_procedure_transition (proc_key);
CREATE INDEX IF NOT EXISTS nav_procedure_transition_rev  ON nav_procedure_transition (rev);

-- ── nav_procedure_leg ────────────────────────────────────────────────────────
-- One ARINC-424-style path terminator. seq is the order the simulator sent the
-- legs within its parent, 0-based, and is the ONLY ordering: nothing here may
-- be re-sorted by distance or by fix name.
--
-- leg_type is the SDK's INT32 leg-type enumeration, verified against the MSFS
-- SDK AddToFacilityDefinition reference:
--   0 UNKNOWN  1 AF  2 CA  3 CD  4 CF  5 CI  6 CR  7 DF  8 FA  9 FC  10 FD
--   11 FM  12 HA  13 HF  14 HM  15 IF  16 PI  17 RF  18 TF  19 VA  20 VD
--   21 VI  22 VM  23 VR
-- Which of those carry a drawable coordinate is a consumer rule, not a schema
-- rule, and both repos MUST classify identically:
--   coordinate-bearing  1 AF, 4 CF, 7 DF, 13 HF, 15 IF, 16 PI, 17 RF, 18 TF
--   coordinate-less     everything else — they terminate on a heading,
--                       altitude, intercept, radial, DME distance or a manual
--                       termination, so there is no end coordinate to draw.
-- Coordinate-less legs are COUNTED and reported, never synthesised.
CREATE TABLE IF NOT EXISTS nav_procedure_leg (
  trans_key             TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  leg_type              INTEGER NOT NULL,
  fix_ident             TEXT,
  fix_region            TEXT,
  fix_type              TEXT,
  fix_lat               REAL,
  fix_lon               REAL,
  fix_alt_m             REAL,
  origin_ident          TEXT,
  origin_region         TEXT,
  origin_type           TEXT,
  origin_lat            REAL,
  origin_lon            REAL,
  origin_alt_m          REAL,
  arc_center_ident      TEXT,
  arc_center_region     TEXT,
  arc_center_type       TEXT,
  arc_center_lat        REAL,
  arc_center_lon        REAL,
  arc_center_alt_m      REAL,
  fly_over              INTEGER CHECK (fly_over IN (0,1)),
  turn_direction        INTEGER,
  course_deg            REAL,
  true_degree           INTEGER CHECK (true_degree IN (0,1)),
  theta_deg             REAL,
  rho_m                 REAL,
  distance_minute       REAL,
  route_distance_m      REAL,
  alt_desc              INTEGER,
  altitude1_m           REAL,
  altitude2_m           REAL,
  speed_limit_kt        REAL,
  vertical_angle_deg    REAL,
  is_iaf                INTEGER CHECK (is_iaf IN (0,1)),
  is_if                 INTEGER CHECK (is_if IN (0,1)),
  is_faf                INTEGER CHECK (is_faf IN (0,1)),
  is_map                INTEGER CHECK (is_map IN (0,1)),
  rev                   INTEGER NOT NULL,
  PRIMARY KEY (trans_key, seq),
  FOREIGN KEY (trans_key) REFERENCES nav_procedure_transition (trans_key) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_procedure_leg_rev ON nav_procedure_leg (rev);

-- ── nav_coverage_cell ────────────────────────────────────────────────────────
-- AREA-SHAPED coverage, for the opportunistic bubble harvest only.
--
-- Airport coverage is not here: the bulk airport list is world-complete
-- (measured: 41 871 rows spanning effectively pole to pole and the full
-- longitude
-- range, farthest member 19 424 km from the aircraft), and airport DETAIL
-- coverage is airport-shaped and lives on nav_airport.detail_state. The two
-- mechanisms are genuinely different shapes and are deliberately not merged.
--
-- Navaid and fix coverage accumulates one reality bubble at a time, so
-- "no navaids here" and "never harvested here" have to be distinguishable.
-- The grid is fixed and global: 0.5 degree x 0.5 degree cells,
--   lat_index = floor((lat + 90) * 2)    -- 0 .. 359
--   lon_index = floor((lon + 180) * 2)   -- 0 .. 719
--   cell_id   = lat_index * 720 + lon_index,  0 .. 259199
-- 0.5 degrees rather than 1: with 1-degree cells and the corner test below, a
-- single 200 km sweep records only 8 cells (measured in the prototype), i.e.
-- it throws away most of what it just harvested. At 0.5 degrees the same sweep
-- records about 33 cells and roughly two thirds of the disc's area. Finer than
-- that buys little and multiplies the per-sweep upserts.
-- A cell is marked harvested for a kind when ALL FOUR of its corners were
-- within NAV_HARVEST_RADIUS_KM (200 km) of the aircraft at the moment the
-- list for that kind completed. 200 km is a conservative inner bound on the
-- observed bubble: measured farthest rows were 346 km (WAYPOINT), 308 km (VOR)
-- and 305 km (AIRPORT).
--
-- row_count = 0 with a non-NULL harvested_at is a real, reportable answer:
-- the NDB list returned 0 rows in the RJ bubble (measured) while NDBs resolve
-- fine elsewhere in the world (CH -> 3 matches in FQ/K7/UR).
CREATE TABLE IF NOT EXISTS nav_coverage_cell (
  kind           TEXT NOT NULL CHECK (kind IN ('V','N','W')),
  cell_id        INTEGER NOT NULL CHECK (cell_id BETWEEN 0 AND 259199),
  harvested_at   INTEGER NOT NULL,
  harvest_count  INTEGER NOT NULL DEFAULT 1,
  row_count      INTEGER NOT NULL DEFAULT 0,
  rev            INTEGER NOT NULL,
  PRIMARY KEY (kind, cell_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_coverage_cell_id  ON nav_coverage_cell (cell_id);
CREATE INDEX IF NOT EXISTS nav_coverage_cell_rev ON nav_coverage_cell (rev);

-- ── nav_absent ───────────────────────────────────────────────────────────────
-- "This simulator does not have this facility." The terminal state the demand
-- signal needs so the server stops asking, and the only way to record a
-- negative for an ident that has no row anywhere else.
--
-- Measured: an ident with no match at all produces SILENCE — no facilityData,
-- no facilityDataEnd and no facilityMinimalList ("SAM : NOTHING",
-- "MID : NOTHING"). A per-request timeout with zero messages received is the
-- only possible detector, which is why reason is recorded: a timeout is weaker
-- evidence than an exception and must be re-checkable.
--
-- Scope: rows are valid only within the current nav_meta.snapshot_id and are
-- deleted wholesale when a new epoch is minted. Absence is a claim about one
-- simulator install at one AIRAC, never a permanent fact.
CREATE TABLE IF NOT EXISTS nav_absent (
  kind             TEXT NOT NULL CHECK (kind IN ('A','V','N','W')),
  ident            TEXT NOT NULL,
  region           TEXT NOT NULL DEFAULT '',
  reason           TEXT NOT NULL CHECK (reason IN ('silent','exception')),
  first_seen_at    INTEGER NOT NULL,
  last_checked_at  INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 1,
  rev              INTEGER NOT NULL,
  PRIMARY KEY (kind, ident, region)
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS nav_absent_rev ON nav_absent (rev);
`;

/** Every table the DDL creates, with its columns in declaration order. */
export const NAVDATA_TABLE_COLUMNS = {
  nav_meta: [
    'id', 'schema_version', 'snapshot_id', 'rev', 'sim_id', 'sim_app_name', 'sim_app_version',
    'bulk_started_at', 'bulk_completed_at', 'bulk_row_count', 'created_at', 'updated_at',
  ],
  nav_sync: [
    'server_url', 'snapshot_id', 'acked_rev', 'state', 'last_ok_at', 'last_error_at',
    'last_error_code', 'updated_at',
  ],
  nav_airport: [
    'ident', 'region', 'lat', 'lon', 'alt_m', 'magvar', 'name', 'n_runways', 'n_approaches',
    'n_departures', 'n_arrivals', 'detail_state', 'detail_fetched_at', 'detail_runways',
    'detail_procedures', 'position_source', 'rev',
  ],
  nav_navaid: [
    'kind', 'ident', 'region', 'lat', 'lon', 'alt_m', 'position_source', 'position_fetched_at',
    'frequency_hz', 'nav_type', 'name', 'magvar', 'nav_range_m', 'is_nav', 'is_dme', 'is_tacan',
    'has_glide_slope', 'has_back_course', 'dme_at_nav', 'dme_at_glide_slope', 'localizer_deg',
    'localizer_width_deg', 'gs_lat', 'gs_lon', 'gs_alt_m', 'dme_lat', 'dme_lon', 'dme_alt_m',
    'tacan_lat', 'tacan_lon', 'tacan_alt_m', 'airport_ident', 'detail_state', 'detail_fetched_at',
    'ambiguous', 'rev',
  ],
  nav_waypoint: [
    'wpt_key', 'ident', 'region', 'lat', 'lon', 'alt_m', 'magvar', 'wpt_type', 'is_terminal',
    'airport_ident', 'n_routes', 'routes_state', 'routes_fetched_at', 'position_source', 'rev',
  ],
  nav_airway_leg: [
    'leg_key', 'airway', 'airway_type', 'from_key', 'to_key', 'from_ident', 'from_region',
    'from_lat', 'from_lon', 'to_ident', 'to_region', 'to_lat', 'to_lon', 'min_lat', 'max_lat',
    'min_lon', 'max_lon', 'dateline', 'rev',
  ],
  nav_runway: [
    'rwy_key', 'airport_ident', 'lat', 'lon', 'alt_m', 'heading_deg', 'length_m', 'width_m',
    'primary_threshold_m', 'secondary_threshold_m', 'pattern_altitude_m', 'slope_deg',
    'true_slope_deg', 'surface', 'primary_number', 'primary_designator', 'secondary_number',
    'secondary_designator', 'primary_ils_ident', 'primary_ils_region', 'secondary_ils_ident',
    'secondary_ils_region', 'rev',
  ],
  nav_airport_frequency: ['freq_key', 'airport_ident', 'freq_type', 'frequency_hz', 'name', 'rev'],
  nav_procedure: [
    'proc_key', 'airport_ident', 'kind', 'name', 'runway_number', 'runway_designator',
    'approach_type', 'suffix', 'faf_ident', 'faf_region', 'faf_alt_m', 'faf_heading_deg',
    'missed_alt_m', 'has_lnav', 'has_lnavvnav', 'has_lp', 'has_lpv', 'n_transitions',
    'n_runway_transitions', 'n_enroute_transitions', 'rev',
  ],
  nav_procedure_transition: [
    'trans_key', 'proc_key', 'role', 'name', 'runway_number', 'runway_designator', 'trans_type',
    'iaf_ident', 'iaf_region', 'iaf_alt_m', 'dme_arc_ident', 'dme_arc_region',
    'dme_arc_radial_deg', 'dme_arc_distance_m', 'n_legs', 'rev',
  ],
  nav_procedure_leg: [
    'trans_key', 'seq', 'leg_type', 'fix_ident', 'fix_region', 'fix_type', 'fix_lat', 'fix_lon',
    'fix_alt_m', 'origin_ident', 'origin_region', 'origin_type', 'origin_lat', 'origin_lon',
    'origin_alt_m', 'arc_center_ident', 'arc_center_region', 'arc_center_type', 'arc_center_lat',
    'arc_center_lon', 'arc_center_alt_m', 'fly_over', 'turn_direction', 'course_deg',
    'true_degree', 'theta_deg', 'rho_m', 'distance_minute', 'route_distance_m', 'alt_desc',
    'altitude1_m', 'altitude2_m', 'speed_limit_kt', 'vertical_angle_deg', 'is_iaf', 'is_if',
    'is_faf', 'is_map', 'rev',
  ],
  nav_coverage_cell: ['kind', 'cell_id', 'harvested_at', 'harvest_count', 'row_count', 'rev'],
  nav_absent: [
    'kind', 'ident', 'region', 'reason', 'first_seen_at', 'last_checked_at', 'attempts', 'rev',
  ],
} as const;

/** The tables of the schema, in the order the DDL creates them. */
export type NavdataTable = keyof typeof NAVDATA_TABLE_COLUMNS;

export const NAVDATA_TABLES = Object.keys(NAVDATA_TABLE_COLUMNS) as readonly NavdataTable[];

/** A column of `T`, so a row shape cannot name a column that does not exist. */
export type NavdataColumn<T extends NavdataTable> = (typeof NAVDATA_TABLE_COLUMNS)[T][number];
