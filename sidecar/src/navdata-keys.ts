// ── Navdata keys, the coverage grid, and the row merge ────────────────────────
//
// Every derived key in the navdata schema is computed here, and the same
// expressions are implemented by hand in the Sabiá server repo, which
// cannot share code with this one. They must agree character for character: a
// key that differs by one separator does not fail, it silently stores the same
// facility twice and the two databases stop matching.
//
// The rules these functions encode, and why they are what they are:
//
// - A waypoint's key is position-qualified. Terminal fixes repeat their ident
//   inside one region (three LOC10/RJ fixes were seen in a single reality
//   bubble), and only the owning airport separates them — which the list API
//   does not report and the facility-data request cannot even be addressed by.
//   Position is the one discriminator present on every source path, so the key
//   carries it, rounded to 1e-5 degrees (~1.1 m). Two real fixes are never that
//   close, so it never merges two; two reports of one fix round the same way,
//   so it never splits one.
// - An airway leg is reported twice, once from each endpoint. The key orders
//   the two endpoint keys by plain string comparison so the second report is an
//   idempotent no-op, and `airwayLegRow` orders the whole row the same way so
//   the second report is byte-identical and writes nothing.
// - The coverage grid is fixed and global at 0.5 degrees. A cell counts as
//   harvested only when all four of its corners were inside the harvest radius,
//   which under-claims coverage — the safe direction.
//
// Pure: no I/O, no timers, and deliberately no native addon, so this module is
// unit-testable and importable with better-sqlite3 missing or broken.

/** A value as SQLite hands it back, and as a row is written. */
export type NavdataValue = string | number | null;

/** What a caller may pass: `undefined` and `null` both mean "no value". */
export type NavdataInput = string | number | boolean | null | undefined;

/** Kilometres from the aircraft within which a list result is trusted. */
export const NAV_HARVEST_RADIUS_KM = 200;

/** Degrees per coverage cell, on both axes. */
export const NAV_COVERAGE_CELL_DEG = 0.5;

/** Cells per row of the grid: 360 degrees of longitude at half a degree. */
const CELLS_PER_ROW = 720;

/** Highest valid cell id, matching the schema's CHECK. */
export const NAV_COVERAGE_CELL_MAX = 259199;

const EARTH_RADIUS_KM = 6371;

/**
 * How much a position source is trusted. Facility data beats a list row beats
 * a minimal list; a route child is as weak as a minimal list. Inert on the
 * simulator build this was written against — only `list` and `minimal` can
 * supply a VOR position there — and present so that a build which does fill in
 * a station position from facility data wins without a schema change.
 */
export const POSITION_PRECEDENCE: Readonly<Record<string, number>> = {
  minimal: 1,
  route: 1,
  list: 2,
  facility: 3,
};

/** `null` and `undefined` render as an empty field, never as "null". */
function part(value: NavdataInput): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** 1e-5 degrees, ~1.1 m. `Math.round` + `String` also normalises -0 to "0". */
function e5(degrees: number): string {
  return String(Math.round(degrees * 1e5));
}

/** The primary key of `nav_waypoint`. */
export function wptKey(ident: string, region: string, lat: number, lon: number): string {
  return `${ident}|${region}|${e5(lat)}|${e5(lon)}`;
}

/**
 * The two endpoint keys of a leg, ordered by ordinary string comparison — not
 * `localeCompare`, whose collation is locale- and ICU-build-dependent and would
 * put the two repositories in different orders for the same pair.
 */
export function orderedEndpoints(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** The primary key of `nav_airway_leg`, direction canonicalised away. */
export function airwayLegKey(airway: string, a: string, b: string): string {
  const [lo, hi] = orderedEndpoints(a, b);
  return `${airway}|${lo}|${hi}`;
}

/** One end of an airway leg, as a ROUTE child reports it. */
export interface AirwayEndpoint {
  readonly ident: string;
  readonly region: string;
  readonly lat: number;
  readonly lon: number;
}

/** A complete `nav_airway_leg` row, ready to upsert. */
export interface AirwayLegRow {
  readonly leg_key: string;
  readonly airway: string;
  readonly airway_type: number | null;
  readonly from_key: string;
  readonly to_key: string;
  readonly from_ident: string;
  readonly from_region: string;
  readonly from_lat: number;
  readonly from_lon: number;
  readonly to_ident: string;
  readonly to_region: string;
  readonly to_lat: number;
  readonly to_lon: number;
  readonly min_lat: number;
  readonly max_lat: number;
  readonly min_lon: number;
  readonly max_lon: number;
  readonly dateline: 0 | 1;
}

/**
 * Builds the whole leg row with both ends in key order, not in report order.
 * That matters beyond tidiness: the same leg arrives once from each endpoint,
 * and if `from_*` followed the reporting end the two reports would differ in
 * every column and each would look like a change worth a new rev. Ordered this
 * way the second report merges to exactly the stored row and writes nothing.
 *
 * `dateline` is set when the short way between the ends crosses the
 * antimeridian, in which case min_lon/max_lon describe nothing useful and a
 * bbox query has to fall back to a latitude-only test for the row.
 */
export function airwayLegRow(
  airway: string,
  airwayType: number | null,
  a: AirwayEndpoint,
  b: AirwayEndpoint,
): AirwayLegRow {
  const aKey = wptKey(a.ident, a.region, a.lat, a.lon);
  const bKey = wptKey(b.ident, b.region, b.lat, b.lon);
  const [from, to] = aKey < bKey ? [a, b] : [b, a];
  const [lo, hi] = orderedEndpoints(aKey, bKey);
  return {
    leg_key: `${airway}|${lo}|${hi}`,
    airway,
    airway_type: airwayType,
    from_key: lo,
    to_key: hi,
    from_ident: from.ident,
    from_region: from.region,
    from_lat: from.lat,
    from_lon: from.lon,
    to_ident: to.ident,
    to_region: to.region,
    to_lat: to.lat,
    to_lon: to.lon,
    min_lat: Math.min(from.lat, to.lat),
    max_lat: Math.max(from.lat, to.lat),
    min_lon: Math.min(from.lon, to.lon),
    max_lon: Math.max(from.lon, to.lon),
    dateline: Math.abs(from.lon - to.lon) > 180 ? 1 : 0,
  };
}

/** The primary key of `nav_runway`: the primary end is unique in an airport. */
export function rwyKey(
  airportIdent: string,
  primaryNumber: NavdataInput,
  primaryDesignator: NavdataInput,
): string {
  return `${airportIdent}|${part(primaryNumber)}|${part(primaryDesignator)}`;
}

/** The addressing fields of a procedure. An absent field is an empty slot. */
export interface ProcedureKeyParts {
  readonly airportIdent: string;
  readonly kind: 'SID' | 'STAR' | 'APPROACH';
  /** An approach has no NAME member, so its caller puts type and runway here. */
  readonly name: string;
  readonly runwayNumber?: NavdataInput;
  readonly runwayDesignator?: NavdataInput;
  readonly suffix?: NavdataInput;
}

/** The primary key of `nav_procedure`. */
export function procKey(parts: ProcedureKeyParts): string {
  return [
    parts.airportIdent,
    parts.kind,
    parts.name,
    part(parts.runwayNumber),
    part(parts.runwayDesignator),
    part(parts.suffix),
  ].join('|');
}

/** Roles a leg list can hang off, including a procedure's own common legs. */
export type TransitionRole = 'common' | 'runway' | 'enroute' | 'approach' | 'final' | 'missed';

/** The primary key of `nav_procedure_transition`. */
export function transKey(procedureKey: string, role: TransitionRole, name: string): string {
  return `${procedureKey}|${role}|${name}`;
}

/** The primary key of `nav_airport_frequency`. */
export function freqKey(
  airportIdent: string,
  freqType: NavdataInput,
  frequencyHz: NavdataInput,
): string {
  return `${airportIdent}|${part(freqType)}|${part(frequencyHz)}`;
}

/** The 0.5-degree cell a position falls in, 0 .. 259199. */
export function cellId(lat: number, lon: number): number {
  const latIndex = Math.floor((lat + 90) * 2);
  const lonIndex = Math.floor((lon + 180) * 2);
  return latIndex * CELLS_PER_ROW + lonIndex;
}

/** The south-west corner of a cell, which with the cell size gives its bounds. */
export function cellSouthWest(id: number): { lat: number; lon: number } {
  const latIndex = Math.floor(id / CELLS_PER_ROW);
  const lonIndex = id - latIndex * CELLS_PER_ROW;
  return { lat: latIndex / 2 - 90, lon: lonIndex / 2 - 180 };
}

/** Great-circle distance in kilometres, spherical earth: this is a radius test. */
export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Folds a longitude back into [-180, 180); exactly 180 becomes -180. */
export function wrapLon(lon: number): number {
  return (((lon + 180) % 360) + 360) % 360 - 180;
}

/**
 * Every cell all four of whose corners lie within `radiusKm` of the aircraft,
 * ascending. All four corners, not the centre: a list request only proves what
 * was inside the bubble, and claiming a cell whose far corner was outside it
 * would record "harvested, nothing here" over ground never looked at.
 *
 * The search window is sized, not guessed. Latitude is easy — degrees of
 * latitude are the same length everywhere. Longitude is not: a degree of it
 * shrinks towards the poles, so the window is computed per latitude band from
 * the same-latitude form of the haversine, sin(dsigma/2) = cos(phi) sin(dlon/2),
 * measured at the band's poleward edge where degrees are shortest and the reach
 * in degrees is therefore longest. When that has no solution the whole parallel
 * is inside the radius and the window is the whole row of cells. An earlier
 * version used a fixed number of cells either side and quietly lost 30 of the
 * 254 cells of a 200 km sweep at 82.5N.
 *
 * The window also wraps across the antimeridian. It has to: a sweep at 179.9E
 * covers ground on both sides of the line, and cutting the search at +-180
 * silently discarded a third of it.
 *
 * Over-claiming would be the dangerous direction — it would write "harvested,
 * nothing here" over ground never looked at — so the window carries two cells
 * of margin and the corner test, not the window, decides.
 *
 * The limit of that sizing, stated rather than implied: it is a bound only
 * while the disc stays clear of the pole. Checked against an exhaustive scan of
 * the whole grid, it is exact to 89.5 degrees; the first cells start going
 * missing just above it (13 of 2190 at 89.6) and by 89.9 — about 11 km from the
 * pole, and far beyond the 82.52 degrees the airport index itself reaches — the
 * disc encloses the pole, ground on the far side is reachable over the top at
 * any longitude, and this records 1959 cells of the true 2160. It misses cells,
 * never invents them, so the residue reads as "never harvested" and the next
 * sweep can still claim it.
 */
export function coveredCells(
  lat: number,
  lon: number,
  radiusKm: number = NAV_HARVEST_RADIUS_KM,
): number[] {
  const cells = new Set<number>();
  const rad = Math.PI / 180;
  const halfArc = Math.sin(radiusKm / EARTH_RADIUS_KM / 2);
  const margin = 2 * NAV_COVERAGE_CELL_DEG;

  const latReachDeg = (radiusKm / EARTH_RADIUS_KM) / rad + margin;
  const latSpan = Math.ceil(latReachDeg / NAV_COVERAGE_CELL_DEG);
  const baseLat = Math.floor(lat * 2) / 2;
  const baseLon = Math.floor(lon * 2) / 2;

  for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
    const cLat = baseLat + dLat * NAV_COVERAGE_CELL_DEG;
    if (cLat < -90 || cLat >= 90) continue;

    const poleward = Math.max(Math.abs(cLat), Math.abs(cLat + NAV_COVERAGE_CELL_DEG));
    const sine = halfArc / Math.cos(poleward * rad);
    const lonReachDeg = sine >= 1 ? 180 : (2 * Math.asin(sine)) / rad + margin;
    const lonSpan = Math.min(CELLS_PER_ROW, Math.ceil(lonReachDeg / NAV_COVERAGE_CELL_DEG));

    for (let dLon = -lonSpan; dLon <= lonSpan; dLon++) {
      const cLon = wrapLon(baseLon + dLon * NAV_COVERAGE_CELL_DEG);
      const corners: Array<[number, number]> = [
        [cLat, cLon],
        [cLat + NAV_COVERAGE_CELL_DEG, cLon],
        [cLat, cLon + NAV_COVERAGE_CELL_DEG],
        [cLat + NAV_COVERAGE_CELL_DEG, cLon + NAV_COVERAGE_CELL_DEG],
      ];
      if (corners.every(([cy, cx]) => greatCircleKm(lat, lon, cy, cx) <= radiusKm)) {
        cells.add(cellId(cLat, cLon));
      }
    }
  }
  return [...cells].sort((x, y) => x - y);
}

/** The bookkeeping column every facility table carries; never merged. */
export const REV_COLUMN = 'rev';

/** Which columns move together with a position, and where its source is kept. */
export interface PositionRule {
  readonly sourceColumn: string;
  /**
   * Position columns, most significant first: the first one decides whether the
   * stored row has a position at all.
   */
  readonly columns: readonly string[];
}

export interface MergeSpec {
  readonly columns: readonly string[];
  /** Values for NOT NULL columns the caller left empty, from the schema. */
  readonly defaults?: Readonly<Record<string, NavdataValue>>;
  readonly position?: PositionRule;
}

export interface MergeResult {
  readonly row: Record<string, NavdataValue>;
  /** False when the merge reproduced the stored row exactly, field for field. */
  readonly changed: boolean;
}

function normalize(value: NavdataInput): NavdataValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * Read-merge-write, in code, over the whole row. The rules, in order:
 *
 * 1. Identity is never merged. A row is found by its key and by nothing else;
 *    the caller passes the key columns in `incoming` and they carry through.
 * 2. An incoming NULL — or an absent key, which means the same thing — leaves
 *    the stored value alone. A present incoming value replaces it. This one
 *    rule covers a detail message arriving before its position, a position
 *    arriving before its detail, and a re-fetch that came back thinner than the
 *    first: a VOR's station position is not in its facility data at all, so one
 *    row is assembled from two calls that may arrive in either order, and
 *    neither may erase what the other supplied.
 * 3. A position from a source of equal or higher precedence overwrites; one
 *    from a lower-precedence source fills an empty position but does not
 *    overwrite. A position whose source the caller did not declare is treated
 *    as ordinary data under rule 2, rather than being silently dropped.
 * 4. `rev` is neither merged nor compared: it is the write's own bookkeeping,
 *    and comparing it would make every re-seen row look changed.
 *
 * `changed` is what keeps the incremental stream draining. A harvest that
 * re-sees ten thousand unchanged rows must write none of them and bump no rev,
 * or every pass re-sends the world.
 */
export function mergeRow(
  stored: Readonly<Record<string, NavdataValue>> | null,
  incoming: Readonly<Record<string, NavdataInput>>,
  spec: MergeSpec,
): MergeResult {
  const columns = spec.columns.filter((c) => c !== REV_COLUMN);
  const merged: Record<string, NavdataValue> = {};
  const rule = spec.position;

  let dropPosition = false;
  if (rule && stored) {
    const incomingSource = normalize(incoming[rule.sourceColumn]);
    const storedSource = stored[rule.sourceColumn];
    const anchor = stored[rule.columns[0]];
    const incomingRank =
      typeof incomingSource === 'string' ? POSITION_PRECEDENCE[incomingSource] : undefined;
    const storedRank = typeof storedSource === 'string' ? POSITION_PRECEDENCE[storedSource] : undefined;
    dropPosition =
      anchor !== null &&
      anchor !== undefined &&
      incomingRank !== undefined &&
      storedRank !== undefined &&
      incomingRank < storedRank;
  }

  for (const column of columns) {
    const ignored =
      dropPosition && rule !== undefined && (column === rule.sourceColumn || rule.columns.includes(column));
    const candidate = ignored ? undefined : normalize(incoming[column]);
    const previous = stored ? stored[column] ?? null : null;
    let value: NavdataValue = candidate !== undefined ? candidate : previous;
    if (value === null && spec.defaults && column in spec.defaults) {
      value = spec.defaults[column];
    }
    merged[column] = value;
  }

  let changed = stored === null;
  if (!changed && stored) {
    for (const column of columns) {
      if (merged[column] !== (stored[column] ?? null)) {
        changed = true;
        break;
      }
    }
  }

  return { row: merged, changed };
}
