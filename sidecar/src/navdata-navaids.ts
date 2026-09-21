// ── Mode B, part four: one VOR or NDB ─────────────────────────────────────────
//
// A plan's VOR and NDB points are drawn from `nav_navaid`, keyed by the request
// key (kind, ident, region): that is all `requestFacilityData` can name a
// navaid by, so anything finer could never be fetched again.
//
// A VOR IS UP TO THREE CALLS. On this build a VOR's facility data carries no station
// latitude, longitude or altitude — the simulator refuses those members — so
// the station position has to come from somewhere else, and on demand the only
// other source is a minimal list. So a VOR is fetched once with its region, for
// everything but the position, and then, if the store still has no position
// for it, once more WITHOUT a region: an ident that several stations share
// answers with a minimal list naming each of them with its position, which is
// the design's free world-wide resolver. Every candidate is stored as a
// position row. Nothing guesses: an ident only one station has answers the
// second call with data and no position, and the row keeps a NULL position
// until a list row supplies one later — unless the third call places it.
//
// THE THIRD CALL asks for the VOR as a WAYPOINT, with its region: the simulator
// keeps VORs in its waypoint database too, and a waypoint record carries a
// position. MEASURED, a waypoint request does NOT select by region — asked for
// one VOR it answered with a same-ident station in another region, thousands of
// kilometres away, three times out of four. So the answer's position is taken
// ONLY when its own ident and region are the ones asked for and it is a VOR
// (waypoint type 3, measured); anything else is thrown away and the position
// stays NULL. A VOR asked for without a region is looked up under the region
// its own answer gave. A key two stations share (marked ambiguous) is never
// looked up: which station would answer is arbitrary, and a position there
// would hide the very sign that the key is not unique. Nothing else from that answer is
// stored: its airways belong to the fix fetch. A localizer is not in the
// waypoint database and is not asked for.
//
// The calls merge into one row under the store's rules — a NULL never
// overwrites a value, and a position only yields to a better source — so they
// may land in either order.
//
// AN NDB IS ONE CALL. Its facility data does carry its position.
//
// NO ROW IS WRITTEN BEFORE THE ANSWER. A 'pending' mark would create a row for
// a navaid that may not exist, and that row would replicate.
//
// AN IMMEDIATE EXCEPTION 1 IS ABSENCE. Measured: a VOR or NDB the simulator
// does not have answers at once with exception 1 and nothing else, with or
// without a region — as a missing airport and a missing fix do. It is recorded
// under the region asked for ('' for none), and a request without a region
// marks no region-qualified row. Any other refusal, and a timeout, claim
// nothing: the queue counts them and parks.
//
// EVERY RECORD IS EXACTLY THE SIZE EXPECTED, or it is refused and nothing is
// stored: a member of another width would shift everything after it into
// plausible numbers in the wrong columns.

import {
  FACILITY_REQUEST_TIMEOUT_MS,
  type FacilityDataMessage,
  type FacilityDefinition,
  type FacilityDefinitionSpec,
  type FacilityFetchResult,
  type FacilityMinimalEntry,
  type FacilityReader,
  type FacilitySession,
} from './navdata-facilities';
import { FixRoutesDecoder } from './navdata-fixes';
import type { NavdataRowInput, NavdataStore } from './navdata-store';
import type { LogSink } from './uplink';

export type NavaidKind = 'V' | 'N';

/** The names the two definitions are prepared and looked up under. */
export const VOR_DEFINITION = 'vor-detail';
export const NDB_DEFINITION = 'ndb-detail';

/** `FacilityDataType`, restated so nothing here loads node-simconnect. */
const REC_VOR = 19;
const REC_NDB = 20;

type Width = 'f64' | 'f32' | 'i32' | 's8' | 's64';

const WIDTH_BYTES: Readonly<Record<Width, number>> = { f64: 8, f32: 4, i32: 4, s8: 8, s64: 64 };

/**
 * The VOR members, in wire order. No LATITUDE, LONGITUDE or ALTITUDE: the
 * simulator refuses them for a VOR. These are the members the simulator was
 * seen to accept, in the order it was asked for them, and that request came
 * back as a single 204-byte record — which is what these widths add up to.
 */
const VOR_MEMBERS: readonly (readonly [string, Width])[] = [
  ['FREQUENCY', 'i32'],
  ['TYPE', 'i32'],
  ['IS_NAV', 'i32'],
  ['IS_DME', 'i32'],
  ['IS_TACAN', 'i32'],
  ['HAS_GLIDE_SLOPE', 'i32'],
  ['DME_AT_NAV', 'i32'],
  ['DME_AT_GLIDE_SLOPE', 'i32'],
  ['HAS_BACK_COURSE', 'i32'],
  ['LOCALIZER', 'f32'],
  ['LOCALIZER_WIDTH', 'f32'],
  ['MAGVAR', 'f32'],
  ['NAME', 's64'],
  ['ICAO', 's8'],
  ['REGION', 's8'],
  ['NAV_RANGE', 'f32'],
  ['GS_LATITUDE', 'f64'],
  ['GS_LONGITUDE', 'f64'],
  ['GS_ALTITUDE', 'f64'],
  ['TACAN_LATITUDE', 'f64'],
  ['TACAN_LONGITUDE', 'f64'],
  ['TACAN_ALTITUDE', 'f64'],
  ['DME_LATITUDE', 'f64'],
  ['DME_LONGITUDE', 'f64'],
  ['DME_ALTITUDE', 'f64'],
];

/** The NDB members, in wire order. Widths from the simulator's documentation. */
const NDB_MEMBERS: readonly (readonly [string, Width])[] = [
  ['LATITUDE', 'f64'],
  ['LONGITUDE', 'f64'],
  ['ALTITUDE', 'f64'],
  ['FREQUENCY', 'i32'],
  ['TYPE', 'i32'],
  ['RANGE', 'f32'],
  ['MAGVAR', 'f32'],
  ['NAME', 's64'],
  ['ICAO', 's8'],
  ['REGION', 's8'],
];

function recordBytes(members: readonly (readonly [string, Width])[]): number {
  return members.reduce((total, [, width]) => total + WIDTH_BYTES[width], 0);
}

export const VOR_RECORD_BYTES = recordBytes(VOR_MEMBERS);
export const NDB_RECORD_BYTES = recordBytes(NDB_MEMBERS);

function spec(name: string, entry: string, members: readonly (readonly [string, Width])[]): FacilityDefinitionSpec {
  return { name, root: { entry, aliases: members.map(([member]) => [member]) } };
}

export function vorDetailSpec(): FacilityDefinitionSpec {
  return spec(VOR_DEFINITION, 'VOR', VOR_MEMBERS);
}

export function ndbDetailSpec(): FacilityDefinitionSpec {
  return spec(NDB_DEFINITION, 'NDB', NDB_MEMBERS);
}

/**
 * Whether the simulator accepted a navaid definition exactly as sent. The
 * record is read by position, so a dropped member would shift the rest.
 */
export function navaidDefinitionUsable(definition: FacilityDefinition, kind: NavaidKind): boolean {
  const [entry, members] = kind === 'V' ? ['VOR', VOR_MEMBERS] : ['NDB', NDB_MEMBERS];
  const accepted = definition.members.get(entry);
  return (
    accepted !== undefined &&
    accepted.length === members.length &&
    accepted.every((member, index) => member === members[index][0])
  );
}

// ── Decoding ──────────────────────────────────────────────────────────────────

type Decoded = Map<string, number | string>;

function trimmed(value: string): string {
  return value.replace(/\0/g, '').trim();
}

/** Finite, in range, and not the (0, 0) an unpopulated pair reads as. */
function isStorableCoordinate(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return lat !== 0 || lon !== 0;
}

function readRecord(data: FacilityReader, members: readonly (readonly [string, Width])[]): Decoded | null {
  if (data.remaining() !== recordBytes(members)) return null;
  const decoded: Decoded = new Map();
  for (const [member, width] of members) {
    switch (width) {
      case 'f64':
        decoded.set(member, data.readFloat64());
        break;
      case 'f32':
        decoded.set(member, data.readFloat32());
        break;
      case 'i32':
        decoded.set(member, data.readInt32());
        break;
      default:
        decoded.set(member, trimmed(data.readString(WIDTH_BYTES[width])));
    }
  }
  return decoded;
}

/**
 * One navaid's record, read inside the listener. Like the other decoders it
 * counts what it could not read rather than throwing: a throw settles the
 * request as aborted and puts it straight back on the queue.
 */
export class NavaidDecoder {
  private record: Decoded | null = null;
  private records = 0;
  private undecodedCount = 0;

  constructor(private readonly kind: NavaidKind) {}

  reset(): void {
    this.record = null;
    this.records = 0;
    this.undecodedCount = 0;
  }

  get undecoded(): number {
    return this.undecodedCount + (this.records > 1 ? this.records - 1 : 0);
  }

  accept(recv: FacilityDataMessage): void {
    const expected = this.kind === 'V' ? REC_VOR : REC_NDB;
    if (recv.type !== expected) return;
    this.records++;
    const record = readRecord(recv.data, this.kind === 'V' ? VOR_MEMBERS : NDB_MEMBERS);
    if (record === null) this.undecodedCount++;
    else this.record = record;
  }

  /** The detail row, or null when no record could be read. */
  row(ident: string, region: string | null, at: number): NavdataRowInput<'nav_navaid'> | null {
    const r = this.record;
    if (r === null) return null;
    const num = (name: string): number | null => {
      const value = r.get(name);
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const str = (name: string): string | null => {
      const value = r.get(name);
      return typeof value === 'string' && value !== '' ? value : null;
    };
    const flag = (name: string): 0 | 1 | null => {
      const value = num(name);
      return value === null ? null : value !== 0 ? 1 : 0;
    };
    /** A secondary antenna's position, or nothing at all when it has none. */
    const place = (prefix: string): { lat: number | null; lon: number | null; alt: number | null } => {
      const lat = num(`${prefix}_LATITUDE`);
      const lon = num(`${prefix}_LONGITUDE`);
      if (lat === null || lon === null || !isStorableCoordinate(lat, lon)) return { lat: null, lon: null, alt: null };
      return { lat, lon, alt: num(`${prefix}_ALTITUDE`) };
    };

    // The key is what the request named. The answer's own region is used only
    // when the request named none — then it is the only region there is.
    const answeredRegion = str('REGION');
    const row: NavdataRowInput<'nav_navaid'> = {
      kind: this.kind,
      ident,
      region: region ?? answeredRegion ?? '',
      frequency_hz: num('FREQUENCY'),
      nav_type: num('TYPE'),
      name: str('NAME'),
      magvar: num('MAGVAR'),
      detail_state: 'detail',
      detail_fetched_at: at,
    };
    if (this.kind === 'N') {
      row.nav_range_m = num('RANGE');
      const lat = num('LATITUDE');
      const lon = num('LONGITUDE');
      // A position source is only ever sent WITH a position.
      if (lat !== null && lon !== null && isStorableCoordinate(lat, lon)) {
        row.lat = lat;
        row.lon = lon;
        row.alt_m = num('ALTITUDE');
        row.position_source = 'facility';
        row.position_fetched_at = at;
      }
      return row;
    }
    const gs = place('GS');
    const dme = place('DME');
    const tacan = place('TACAN');
    return {
      ...row,
      nav_range_m: num('NAV_RANGE'),
      is_nav: flag('IS_NAV'),
      is_dme: flag('IS_DME'),
      is_tacan: flag('IS_TACAN'),
      has_glide_slope: flag('HAS_GLIDE_SLOPE'),
      has_back_course: flag('HAS_BACK_COURSE'),
      dme_at_nav: flag('DME_AT_NAV'),
      dme_at_glide_slope: flag('DME_AT_GLIDE_SLOPE'),
      localizer_deg: num('LOCALIZER'),
      localizer_width_deg: num('LOCALIZER_WIDTH'),
      gs_lat: gs.lat,
      gs_lon: gs.lon,
      gs_alt_m: gs.alt,
      dme_lat: dme.lat,
      dme_lon: dme.lon,
      dme_alt_m: dme.alt,
      tacan_lat: tacan.lat,
      tacan_lon: tacan.lon,
      tacan_alt_m: tacan.alt,
    };
  }
}

// ── The fetch ─────────────────────────────────────────────────────────────────

export type NavaidStatus =
  /** Detail written, `detail_state = 'detail'`; see `positioned` for a VOR. */
  | 'detail'
  /** The simulator refused at once with exception 1: `nav_absent`. */
  | 'absent'
  /** No region, several stations: their positions are written, no detail. */
  | 'ambiguous'
  /** Any other refusal, a timeout, or a partial answer twice. Nothing is claimed. */
  | 'failed'
  /** The link went away, or the buffer could not be cleared. */
  | 'aborted'
  /** A record this build could not read. */
  | 'undecodable'
  /** There is no store to write to. */
  | 'disabled';

export interface NavaidResult {
  readonly kind: NavaidKind;
  readonly ident: string;
  readonly region: string | null;
  readonly status: NavaidStatus;
  /** Whether the stored row has a station position after this fetch. */
  readonly positioned: boolean;
  /** Candidates a minimal list named, from either call. */
  readonly candidates: number;
  readonly written: number;
  readonly messages: number;
  readonly ms: number;
  readonly exceptionCode: number | null;
  readonly reason: string | null;
}

export interface NavaidOptions {
  readonly log?: LogSink;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /**
   * The fix definition prepared on this session, for a VOR's third call. With
   * none, a VOR the first two calls could not place keeps a NULL position.
   */
  readonly waypointDefinition?: FacilityDefinition | null;
}

export async function fetchNavaid(
  session: FacilitySession,
  store: NavdataStore | null,
  definition: FacilityDefinition,
  kind: NavaidKind,
  ident: string,
  region: string | null,
  options: NavaidOptions = {},
): Promise<NavaidResult> {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? FACILITY_REQUEST_TIMEOUT_MS;
  const noun = kind === 'V' ? 'VOR' : 'NDB';
  const label = region === null ? `${noun} ${ident}` : `${noun} ${ident}/${region}`;
  const empty = {
    kind,
    ident,
    region,
    positioned: false,
    candidates: 0,
    written: 0,
    messages: 0,
    ms: 0,
    exceptionCode: null,
  } as const;

  if (store === null) return { ...empty, status: 'disabled', reason: 'navdata disabled: no store is open' };

  const decoder = new NavaidDecoder(kind);
  let result: FacilityFetchResult;
  try {
    result = await session.fetch({
      definitionId: definition.definitionId,
      ident,
      region: region ?? undefined,
      icaoType: kind,
      timeoutMs,
      onAttempt: () => decoder.reset(),
      onMessage: (recv) => decoder.accept(recv),
    });
  } catch (err) {
    const reason = describeFailure(err);
    log('warn', `navdata: the ${label} request could not be sent (${reason})`);
    return { ...empty, status: 'failed', reason };
  }
  const base = { ...empty, messages: result.messages, ms: result.ms, exceptionCode: result.exceptionCode };

  switch (result.outcome) {
    case 'aborted':
      return { ...base, status: 'aborted', reason: 'the request was abandoned before it finished' };
    case 'resolved-ambiguous': {
      const { stored, written } = storeCandidates(store, kind, ident, result.minimal ?? [], now());
      log('info', `navdata: ${label} matched ${result.minimal?.length ?? 0} stations; their positions are stored`);
      return { ...base, status: 'ambiguous', candidates: stored, written, reason: 'the ident matched more than one station' };
    }
    case 'absent': {
      const reason = `the ${label} request timed out with no answer`;
      log('info', `navdata: ${reason}`);
      return { ...base, status: 'failed', reason };
    }
    case 'failed':
    case 'partial': {
      if (isMissingNavaid(result)) {
        const at = now();
        store.write((tx) => {
          tx.recordAbsent({ kind, ident, region: region ?? '', reason: 'exception', at });
          // Only the row in the region asked for: a request without a region
          // says nothing about any region-qualified station.
          if (region !== null && store.row('nav_navaid', { kind, ident, region }) !== null) {
            tx.upsert('nav_navaid', { kind, ident, region, detail_state: 'absent', detail_fetched_at: at });
          }
        });
        const reason = `the simulator does not have ${label} (${result.exception ?? 'no reason given'})`;
        log('info', `navdata: ${reason}`);
        return { ...base, status: 'absent', reason };
      }
      const reason = `the simulator refused the ${label} request (${result.exception ?? 'no reason given'})`;
      log('info', `navdata: ${reason}`);
      return { ...base, status: 'failed', reason };
    }
    default:
      break;
  }

  const at = now();
  const row = decoder.undecoded > 0 ? null : decoder.row(ident, region, at);
  if (row === null) {
    const reason = `the ${label} record did not match the definition this build sent`;
    log('warn', `navdata: ${reason} — nothing was stored for it`);
    return { ...base, status: 'undecodable', reason };
  }
  let written: number;
  try {
    written = store.write((tx) => (tx.upsert('nav_navaid', row) ? 1 : 0));
  } catch (err) {
    const reason = describeFailure(err);
    log('warn', `navdata: the ${label} detail could not be stored (${reason})`);
    return { ...base, status: 'undecodable', reason };
  }
  const key = { kind, ident, region: String(row.region) };
  let positioned = hasPosition(store, key);
  let candidates = 0;

  // The second call, for a VOR's station position. Only for a request that
  // named a region: without one, the first call already was the region-less
  // request, and it answered with data rather than candidates.
  if (kind === 'V' && region !== null && !positioned) {
    const second = await fetchPosition(session, store, definition, ident, timeoutMs, now);
    candidates = second.candidates;
    written += second.written;
    positioned = hasPosition(store, key);
  }

  // The third call: the VOR as a waypoint, taken only if the answer is the
  // station asked for. Under the region asked for, or the one the answer gave
  // when none was asked — the station's own region either way. Not for a
  // localizer, which is not a waypoint; not with no region at all, since that
  // is what the answer is checked against; and not for a shared key.
  if (
    kind === 'V' &&
    key.region !== '' &&
    !positioned &&
    row.nav_type !== VOR_TYPE_ILS &&
    store.row('nav_navaid', key)?.ambiguous !== 1
  ) {
    const third = await fetchAsWaypoint(session, store, options.waypointDefinition ?? null, ident, key.region, timeoutMs, now);
    written += third.written;
    positioned = hasPosition(store, key);
    if (third.mismatch) {
      log('info', `navdata: the waypoint answer for ${label} was another station; its position was not used`);
    }
  }
  if (kind === 'V' && !positioned) {
    log('debug', `navdata: no station position for ${label} yet; it stays empty until a list supplies one`);
  }

  return { ...base, status: 'detail', positioned, candidates, written, reason: null };
}

/** The VOR `TYPE` of an ILS or localizer, which the waypoint database does not hold. */
const VOR_TYPE_ILS = 4;

/** The waypoint `TYPE` a VOR has in the waypoint database, as measured. */
const WAYPOINT_TYPE_VOR = 3;

/** The simulator's generic refusal, read as a number rather than from its printed form. */
const EXCEPTION_ERROR = 1;

/**
 * Whether a refusal means "this install has no such navaid": an IMMEDIATE
 * exception 1 with nothing received. A refusal after data arrived means the
 * station is there, and any other code is a defect in what was sent.
 */
function isMissingNavaid(result: FacilityFetchResult): boolean {
  return result.outcome === 'failed' && result.messages === 0 && result.exceptionCode === EXCEPTION_ERROR;
}

/**
 * Asks for a VOR as a WAYPOINT, with its region, and stores the answer's
 * position on the VOR's row only when the answer names the same ident in the
 * same region. The position is from facility data, so it is stored as such.
 * A refusal or a timeout here says nothing about the VOR — it exists, its
 * detail just arrived — so the row simply keeps a NULL position.
 */
async function fetchAsWaypoint(
  session: FacilitySession,
  store: NavdataStore,
  definition: FacilityDefinition | null,
  ident: string,
  region: string,
  timeoutMs: number,
  now: () => number,
): Promise<{ written: number; mismatch: boolean }> {
  if (definition === null) return { written: 0, mismatch: false };
  const decoder = new FixRoutesDecoder();
  let result: FacilityFetchResult;
  try {
    result = await session.fetch({
      definitionId: definition.definitionId,
      ident,
      region,
      icaoType: 'W',
      timeoutMs,
      onAttempt: () => decoder.reset(),
      onMessage: (recv) => decoder.accept(recv),
    });
  } catch {
    return { written: 0, mismatch: false };
  }
  if (result.outcome !== 'ok' || decoder.undecoded > 0) return { written: 0, mismatch: false };
  const at = now();
  // No fallback ident: an answer that does not name itself is not a match.
  const answer = decoder.rows('', at)?.waypoint ?? null;
  if (answer === null) return { written: 0, mismatch: false };
  if (answer.ident !== ident || answer.region !== region || answer.wpt_type !== WAYPOINT_TYPE_VOR) {
    return { written: 0, mismatch: true };
  }
  const written = store.write((tx) =>
    tx.upsert('nav_navaid', {
      kind: 'V',
      ident,
      region,
      lat: answer.lat,
      lon: answer.lon,
      alt_m: answer.alt_m,
      position_source: 'facility',
      position_fetched_at: at,
    })
      ? 1
      : 0,
  );
  return { written, mismatch: false };
}

/**
 * Asks for a VOR ident with no region. An ident several stations share
 * answers with a minimal list, which carries each one's position; every one is
 * stored. An ident only one station has answers with data, which has no
 * position in it on this build — nothing is stored, and nothing is guessed.
 */
async function fetchPosition(
  session: FacilitySession,
  store: NavdataStore,
  definition: FacilityDefinition,
  ident: string,
  timeoutMs: number,
  now: () => number,
): Promise<{ candidates: number; written: number; reason: string }> {
  let result: FacilityFetchResult;
  try {
    result = await session.fetch({ definitionId: definition.definitionId, ident, icaoType: 'V', timeoutMs });
  } catch (err) {
    return { candidates: 0, written: 0, reason: describeFailure(err) };
  }
  if (result.outcome !== 'resolved-ambiguous') {
    return { candidates: 0, written: 0, reason: `the region-less request answered ${result.outcome}` };
  }
  const { stored, written } = storeCandidates(store, 'V', ident, result.minimal ?? [], now());
  return { candidates: stored, written, reason: 'no candidate in the requested region' };
}

/**
 * One position row per candidate station of this kind and ident, at the
 * weakest position source. Two candidates in ONE region mean the request key
 * is not unique after all: that row is marked `ambiguous` and given no
 * position, since there is nothing to choose one station over the other by.
 */
function storeCandidates(
  store: NavdataStore,
  kind: NavaidKind,
  ident: string,
  minimal: readonly FacilityMinimalEntry[],
  at: number,
): { stored: number; written: number } {
  const byRegion = new Map<string, FacilityMinimalEntry[]>();
  for (const entry of minimal) {
    const type = trimmed(entry.icao.type);
    if (trimmed(entry.icao.ident) !== ident || (type !== '' && type !== kind)) continue;
    const { latitude, longitude } = entry.latLonAlt;
    if (!isStorableCoordinate(latitude, longitude)) continue;
    const region = trimmed(entry.icao.region);
    byRegion.set(region, [...(byRegion.get(region) ?? []), entry]);
  }
  let stored = 0;
  const written = store.write((tx) => {
    let changed = 0;
    for (const [region, entries] of byRegion) {
      stored += entries.length;
      if (entries.length > 1) {
        if (tx.upsert('nav_navaid', { kind, ident, region, ambiguous: 1 })) changed++;
        continue;
      }
      const [entry] = entries;
      const airport = trimmed(entry.icao.airport);
      const row: NavdataRowInput<'nav_navaid'> = {
        kind,
        ident,
        region,
        lat: entry.latLonAlt.latitude,
        lon: entry.latLonAlt.longitude,
        alt_m: Number.isFinite(entry.latLonAlt.altitude) ? entry.latLonAlt.altitude : null,
        position_source: 'minimal',
        position_fetched_at: at,
        airport_ident: airport === '' ? null : airport,
      };
      if (tx.upsert('nav_navaid', row)) changed++;
    }
    return changed;
  });
  return { stored, written };
}

function hasPosition(store: NavdataStore, key: { kind: NavaidKind; ident: string; region: string }): boolean {
  const row = store.row('nav_navaid', key);
  return row !== null && row.lat !== null && row.lon !== null;
}

/** An error reduced to one safe line: a code when there is one, never a path. */
function describeFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].slice(0, 200);
}
