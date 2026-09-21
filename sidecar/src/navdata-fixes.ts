// ── Mode B, part three: one fix and its airways ──────────────────────────────
//
// A filed route's enroute middle is drawn by walking `nav_airway_leg` by airway
// name, and those rows arrive only from here: one `requestFacilityData` for a
// WAYPOINT, with its ROUTE children. Each ROUTE child names an airway and BOTH
// neighbours on it, complete with ident, region and position, so the legs this
// writes are self-contained and a map never has to join them to anything.
//
// A FIX HAS NO KEY UNTIL IT HAS A POSITION. `nav_waypoint` is keyed by ident,
// region AND position (terminal fixes repeat ident and region), so nothing can
// be written before the answer arrives — there is no 'pending' mark here, and
// no row a dead process could leave looking busy. The row and its legs are
// written together once the request has settled, in one transaction.
//
// N_ROUTES IS CHECKED, NOT JUST STORED. The simulator's own count of airways
// through the fix is compared with the ROUTE records that actually arrived: a
// fix on no airway is a real answer (most fixes are), and a short set of routes
// stored as 'fetched' would never be asked for again.
//
// AN AMBIGUOUS IDENT IS AN ANSWER, NOT A FAILURE. With no region, an ident
// several fixes share comes back as a minimal list of candidates and then
// nothing else; the request is over. Each candidate's position is stored, and
// no region is guessed to fetch routes for one of them — picking the wrong fix
// would put a plausible airway in the wrong place.
//
// EVERY RECORD IS EXACTLY THE SIZE THAT WAS MEASURED. The member order of a
// definition is the wire order, so a record is read front to back, and a
// member that came back wider or narrower than expected would shift every one
// after it into plausible numbers in the wrong columns. Measured on this build,
// a fix record is 56 bytes (MAGVAR a 32-bit float) and a route record is 100
// (NAME 32 bytes); any other size is refused and nothing is stored for the fix,
// so a simulator that changes the layout is noticed rather than misread.

import { airwayLegRow, wptKey, type AirwayEndpoint, type AirwayLegRow } from './navdata-keys';
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
import type { NavdataRowInput, NavdataStore } from './navdata-store';
import type { LogSink } from './uplink';

/** The name the fix definition is prepared and looked up under. */
export const FIX_ROUTES_DEFINITION = 'fix-routes';

/** `FacilityDataType`, restated so nothing here loads node-simconnect. */
const REC_WAYPOINT = 21;
const REC_ROUTE = 22;

const ENTRY_WAYPOINT = 'WAYPOINT';
const ENTRY_ROUTE = 'ROUTE';

/** In wire order. MAGVAR is last on purpose: see the header. */
const WAYPOINT_MEMBERS = [
  'LATITUDE',
  'LONGITUDE',
  'ALTITUDE',
  'TYPE',
  'N_ROUTES',
  'ICAO',
  'REGION',
  'IS_TERMINAL_WPT',
  'MAGVAR',
] as const;

/** In wire order. NAME is last on purpose: see the header. */
const ROUTE_MEMBERS = [
  'TYPE',
  'NEXT_ICAO',
  'NEXT_REGION',
  'NEXT_LATITUDE',
  'NEXT_LONGITUDE',
  'PREV_ICAO',
  'PREV_REGION',
  'PREV_LATITUDE',
  'PREV_LONGITUDE',
  'NAME',
] as const;

/** Three f64, two i32, two 8-byte strings, one i32, then MAGVAR as an f32. */
const WAYPOINT_RECORD_BYTES = 3 * 8 + 2 * 4 + 2 * 8 + 4 + 4;
/** A route's NAME, as measured. */
const ROUTE_NAME_BYTES = 32;
/** One i32, then per neighbour two 8-byte strings and two f64, then NAME. */
const ROUTE_RECORD_BYTES = 4 + 2 * (2 * 8 + 2 * 8) + ROUTE_NAME_BYTES;

/** The fix and every airway through it; no neighbour is fetched in its own right. */
export function fixRoutesSpec(): FacilityDefinitionSpec {
  return {
    name: FIX_ROUTES_DEFINITION,
    root: {
      entry: ENTRY_WAYPOINT,
      aliases: WAYPOINT_MEMBERS.map((m) => [m]),
      children: [{ entry: ENTRY_ROUTE, aliases: ROUTE_MEMBERS.map((m) => [m]) }],
    },
  };
}

/**
 * Whether the simulator accepted the definition exactly as sent. The records
 * are read by position, so a member it dropped would shift everything after
 * it; rather than guess, a definition with any member missing is not used.
 */
export function fixDefinitionUsable(definition: FacilityDefinition): boolean {
  const matches = (entry: string, wanted: readonly string[]): boolean => {
    const accepted = definition.members.get(entry);
    return accepted !== undefined && accepted.length === wanted.length && accepted.every((m, i) => m === wanted[i]);
  };
  return matches(ENTRY_WAYPOINT, WAYPOINT_MEMBERS) && matches(ENTRY_ROUTE, ROUTE_MEMBERS);
}

// ── Decoding ──────────────────────────────────────────────────────────────────

interface FixRecord {
  readonly lat: number;
  readonly lon: number;
  readonly alt: number;
  readonly type: number;
  readonly nRoutes: number;
  readonly ident: string;
  readonly region: string;
  readonly terminal: number;
  readonly magvar: number;
}

interface RouteRecord {
  readonly type: number;
  readonly next: AirwayEndpoint | null;
  readonly prev: AirwayEndpoint | null;
  readonly name: string;
}

function trimmed(value: string): string {
  return value.replace(/\0/g, '').trim();
}

/** Finite, in range, and not the (0, 0) an unpopulated pair reads as. */
function isStorableCoordinate(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return lat !== 0 || lon !== 0;
}

/** A neighbour on an airway, or null at the end of one. */
function endpoint(ident: string, region: string, lat: number, lon: number): AirwayEndpoint | null {
  const name = trimmed(ident);
  if (name === '' || !isStorableCoordinate(lat, lon)) return null;
  return { ident: name, region: trimmed(region), lat, lon };
}

/**
 * Turns one fix's records into drafts. Runs inside the listener, so it reads
 * the buffer and keeps only plain values; like the airport decoder it counts
 * what it could not read rather than throwing, since a throw would settle the
 * request as aborted and put it straight back on the queue.
 */
export class FixRoutesDecoder {
  private fix: FixRecord | null = null;
  private fixes = 0;
  private routes: RouteRecord[] = [];
  private undecodedCount = 0;

  reset(): void {
    this.fix = null;
    this.fixes = 0;
    this.routes = [];
    this.undecodedCount = 0;
  }

  get undecoded(): number {
    return this.undecodedCount + (this.fixes > 1 ? this.fixes - 1 : 0);
  }

  accept(recv: FacilityDataMessage): void {
    if (recv.type === REC_WAYPOINT) {
      this.fixes++;
      const fix = readFix(recv.data);
      if (fix === null) this.undecodedCount++;
      else this.fix = fix;
      return;
    }
    if (recv.type === REC_ROUTE) {
      const route = readRoute(recv.data);
      if (route === null) this.undecodedCount++;
      else this.routes.push(route);
    }
    // Anything else was not opened by this definition and carries nothing to store.
  }

  /**
   * The rows, keyed in one pass now that every record is in: a leg's key
   * needs the fix's own position, and that is only certain at the end.
   */
  rows(fallbackIdent: string, at: number): FixRoutesRows | null {
    const fix = this.fix;
    if (fix === null || !isStorableCoordinate(fix.lat, fix.lon)) return null;
    const ident = fix.ident === '' ? fallbackIdent : fix.ident;
    const self: AirwayEndpoint = { ident, region: fix.region, lat: fix.lat, lon: fix.lon };
    const legs = new Map<string, AirwayLegRow>();
    for (const route of this.routes) {
      if (route.name === '') continue;
      for (const other of [route.prev, route.next]) {
        if (other === null) continue;
        const leg = airwayLegRow(route.name, route.type, other, self);
        if (!legs.has(leg.leg_key)) legs.set(leg.leg_key, leg);
      }
    }
    return {
      waypoint: {
        wpt_key: wptKey(ident, fix.region, fix.lat, fix.lon),
        ident,
        region: fix.region,
        lat: fix.lat,
        lon: fix.lon,
        alt_m: Number.isFinite(fix.alt) ? fix.alt : null,
        magvar: Number.isFinite(fix.magvar) ? fix.magvar : null,
        wpt_type: fix.type,
        is_terminal: fix.terminal !== 0 ? 1 : 0,
        n_routes: fix.nRoutes,
        routes_state: 'fetched',
        routes_fetched_at: at,
        position_source: 'facility',
      },
      legs: [...legs.values()],
      routeRecords: this.routes.length,
      declaredRoutes: fix.nRoutes,
    };
  }
}

function readFix(data: FacilityReader): FixRecord | null {
  if (data.remaining() !== WAYPOINT_RECORD_BYTES) return null;
  const lat = data.readFloat64();
  const lon = data.readFloat64();
  const alt = data.readFloat64();
  const type = data.readInt32();
  const nRoutes = data.readInt32();
  const ident = trimmed(data.readString(8));
  const region = trimmed(data.readString(8));
  const terminal = data.readInt32();
  const magvar = data.readFloat32();
  return { lat, lon, alt, type, nRoutes, ident, region, terminal, magvar };
}

function readRoute(data: FacilityReader): RouteRecord | null {
  if (data.remaining() !== ROUTE_RECORD_BYTES) return null;
  const type = data.readInt32();
  const next = endpoint(data.readString(8), data.readString(8), data.readFloat64(), data.readFloat64());
  const prev = endpoint(data.readString(8), data.readString(8), data.readFloat64(), data.readFloat64());
  const name = trimmed(data.readString(ROUTE_NAME_BYTES));
  return { type, next, prev, name };
}

// ── The fetch ─────────────────────────────────────────────────────────────────

export interface FixRoutesRows {
  readonly waypoint: NavdataRowInput<'nav_waypoint'>;
  readonly legs: readonly AirwayLegRow[];
  readonly routeRecords: number;
  readonly declaredRoutes: number;
}

export type FixRoutesStatus =
  /** The fix and its airway legs are written, `routes_state = 'fetched'`. */
  | 'fetched'
  /** No region, several fixes: their positions are written, no routes. */
  | 'ambiguous'
  /** The simulator refused at once with exception 1: `nav_absent` kind 'W'. */
  | 'absent'
  /** Any other refusal, a timeout, or a partial answer twice. Nothing is claimed. */
  | 'failed'
  /** The link went away, or the buffer could not be cleared. */
  | 'aborted'
  /** Records this build could not read, or a route count that does not add up. */
  | 'undecodable'
  /** There is no store to write to. */
  | 'disabled';

export interface FixRoutesResult {
  readonly ident: string;
  readonly region: string | null;
  readonly status: FixRoutesStatus;
  readonly routes: number;
  readonly legs: number;
  readonly written: number;
  readonly candidates: number;
  readonly messages: number;
  readonly ms: number;
  /** The simulator's own exception number, when that is what ended it. */
  readonly exceptionCode: number | null;
  /** One line, safe for a log: no token, no path. */
  readonly reason: string | null;
}

export interface FixRoutesOptions {
  readonly log?: LogSink;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * The simulator's generic refusal, read as a number: the printed form is for
 * logs, and branching on it would stop working the day it was reworded.
 */
const EXCEPTION_ERROR = 1;

/**
 * Whether a refusal means "this install has no such fix". MEASURED: a fix the
 * simulator does not have answers IMMEDIATELY with exception 1 and no rows,
 * with or without a region — the same answer a missing airport gives. Narrow
 * on purpose: a refusal after rows have arrived means the fix is there, and
 * any other exception code is a defect in what we sent, not a fact about the
 * world.
 */
function isMissingFix(result: FacilityFetchResult): boolean {
  return result.outcome === 'failed' && result.messages === 0 && result.exceptionCode === EXCEPTION_ERROR;
}

/**
 * Fetches one fix with its airways and lands the result in the store.
 *
 * One answer means "this install has no such fix": an immediate refusal with
 * exception 1, which is what a missing fix was measured to send. It is recorded
 * as an absence under the region the request named ('' for none), so an
 * absence found without a region never stands in for a region-qualified fix.
 * Silence is NOT absence: a missing fix was never seen to answer that way, so a
 * request that simply ran out of time says nothing about the fix and ends as a
 * failure, which the queue counts and parks.
 */
export async function fetchFixRoutes(
  session: FacilitySession,
  store: NavdataStore | null,
  definition: FacilityDefinition,
  ident: string,
  region: string | null,
  options: FixRoutesOptions = {},
): Promise<FixRoutesResult> {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const empty = {
    ident,
    region,
    routes: 0,
    legs: 0,
    written: 0,
    candidates: 0,
    messages: 0,
    ms: 0,
    exceptionCode: null,
  } as const;
  const label = region === null ? ident : `${ident}/${region}`;

  if (store === null) return { ...empty, status: 'disabled', reason: 'navdata disabled: no store is open' };

  const decoder = new FixRoutesDecoder();
  let result: FacilityFetchResult;
  try {
    result = await session.fetch({
      definitionId: definition.definitionId,
      ident,
      region: region ?? undefined,
      icaoType: 'W',
      timeoutMs: options.timeoutMs ?? FACILITY_REQUEST_TIMEOUT_MS,
      onAttempt: () => decoder.reset(),
      onMessage: (recv) => decoder.accept(recv),
    });
  } catch (err) {
    const reason = describeFailure(err);
    log('warn', `navdata: the ${label} fix request could not be sent (${reason})`);
    return { ...empty, status: 'failed', reason };
  }
  const base = { ...empty, messages: result.messages, ms: result.ms, exceptionCode: result.exceptionCode };

  if (result.outcome === 'aborted') {
    return { ...base, status: 'aborted', reason: 'the request was abandoned before it finished' };
  }

  if (result.outcome === 'resolved-ambiguous') {
    const candidates = candidateRows(result.minimal ?? []);
    const written = store.write((tx) => {
      let changed = 0;
      for (const row of candidates) if (tx.upsert('nav_waypoint', row)) changed++;
      return changed;
    });
    log(
      'info',
      `navdata: ${label} matched ${result.minimal?.length ?? 0} fixes; their positions are stored ` +
        'and no airway is fetched for any of them',
    );
    return {
      ...base,
      status: 'ambiguous',
      candidates: candidates.length,
      written,
      reason: 'the ident matched more than one fix',
    };
  }

  if (isMissingFix(result)) {
    const at = now();
    store.write((tx) => {
      tx.recordAbsent({ kind: 'W', ident, region: region ?? '', reason: 'exception', at });
      // A fix has no row until its position is known, so there is usually
      // nothing to mark. A row that does exist in the region asked for — a
      // candidate from an earlier minimal list — is a position the simulator
      // now says it does not have. A request without a region marks nothing
      // but its own absence: it never overrides what a region-qualified row says.
      if (region !== null) {
        for (const row of store.waypoints(ident, region)) {
          tx.upsert('nav_waypoint', { wpt_key: String(row.wpt_key), routes_state: 'absent', routes_fetched_at: at });
        }
      }
    });
    const reason = `the simulator does not have ${label} (${result.exception ?? 'no reason given'})`;
    log('info', `navdata: ${reason}`);
    return { ...base, status: 'absent', reason };
  }

  if (result.outcome === 'absent') {
    // The session's name for a timeout with nothing received. For a fix that
    // is not evidence of anything; see above.
    const reason = `the ${label} fix request timed out with no answer`;
    log('info', `navdata: ${reason}`);
    return { ...base, status: 'failed', reason };
  }

  if (result.outcome === 'failed' || result.outcome === 'partial') {
    const reason = `the simulator refused the ${label} fix request (${result.exception ?? 'no reason given'})`;
    log('info', `navdata: ${reason}`);
    return { ...base, status: 'failed', reason };
  }

  // Completed. Anything still wrong is ours.
  const at = now();
  const rows = decoder.undecoded > 0 ? null : decoder.rows(ident, at);
  if (rows === null) {
    const reason = `the ${label} fix record(s) did not match the definition this build sent`;
    log('warn', `navdata: ${reason} — nothing was stored for it`);
    return { ...base, status: 'undecodable', reason };
  }
  if (rows.routeRecords !== rows.declaredRoutes) {
    const reason =
      `${label} declared ${rows.declaredRoutes} airway(s) and sent ${rows.routeRecords}; ` +
      'a short set is not stored as complete';
    log('warn', `navdata: ${reason}`);
    return { ...base, status: 'undecodable', reason };
  }

  let written: number;
  try {
    written = store.write((tx) => {
      let changed = 0;
      if (tx.upsert('nav_waypoint', rows.waypoint)) changed++;
      for (const leg of rows.legs) if (tx.upsert('nav_airway_leg', leg)) changed++;
      return changed;
    });
  } catch (err) {
    const reason = describeFailure(err);
    log('warn', `navdata: the ${label} fix could not be stored (${reason})`);
    return { ...base, status: 'undecodable', reason };
  }
  return { ...base, status: 'fetched', routes: rows.routeRecords, legs: rows.legs.length, written, reason: null };
}

/** One position row per candidate fix, weakest source, no routes claimed. */
function candidateRows(minimal: readonly FacilityMinimalEntry[]): NavdataRowInput<'nav_waypoint'>[] {
  const rows: NavdataRowInput<'nav_waypoint'>[] = [];
  const seen = new Set<string>();
  for (const entry of minimal) {
    const ident = trimmed(entry.icao.ident);
    const type = trimmed(entry.icao.type);
    const { latitude: lat, longitude: lon, altitude } = entry.latLonAlt;
    if (ident === '' || (type !== '' && type !== 'W') || !isStorableCoordinate(lat, lon)) continue;
    const region = trimmed(entry.icao.region);
    const key = wptKey(ident, region, lat, lon);
    if (seen.has(key)) continue;
    seen.add(key);
    const airport = trimmed(entry.icao.airport);
    rows.push({
      wpt_key: key,
      ident,
      region,
      lat,
      lon,
      alt_m: Number.isFinite(altitude) ? altitude : null,
      airport_ident: airport === '' ? null : airport,
      position_source: 'minimal',
    });
  }
  return rows;
}

/** An error reduced to one safe line: a code when there is one, never a path. */
function describeFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0].slice(0, 200);
}
