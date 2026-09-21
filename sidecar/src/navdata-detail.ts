// ── Mode B, part one: one airport's detail ───────────────────────────────────
//
// This is the module that finally moves GEOMETRY. The bulk index puts an
// airport's position in the store; everything a map actually draws for an
// approach — the runway it lands on, the fixes a SID strings together, the
// altitude a STAR crosses them at — arrives only from a per-airport
// `requestFacilityData`, and only through here.
//
// THE TREE IS REBUILT FROM THE RECORD IDS, NOT FROM THE MEMBER NAMES. A
// facility definition is a flat list of entry points keyed by name, and
// `APPROACH_LEG` appears under five different parents — approach, runway and
// enroute transitions, and directly under DEPARTURE and ARRIVAL. By name those
// five collapse into one, and a decoder that went by name could not tell a
// SID's common legs from an approach transition's. Every record carries its own
// id and its parent's, so the parent chain is read off the wire and the tree is
// reassembled exactly as the simulator sent it.
//
// A SID/STAR'S COMMON LEGS HANG STRAIGHT OFF DEPARTURE/ARRIVAL. Measured: with
// APPROACH_LEG opened only under the transitions, a large airport's STARs all
// arrived with ZERO legs — the middle of every procedure missing, and nothing
// anywhere saying so. Those legs are stored under a transition of their own
// with role 'common' and an empty name, so that every leg in the database hangs
// off a parent of the same shape and §-free consumer code has one case, not two.
//
// DECODE IN PLACE. The buffer a listener is handed belongs to the packet being
// parsed and is recycled the moment the listener returns, so every record is
// read inside the callback and only plain values are kept. Nothing here writes
// to the store from inside a listener: rows are buffered and written in one
// transaction per airport once the request has settled, because half a
// procedure tree in the database is worse than none — it looks complete.
//
// AN ERROR IN OUR CODE IS NEVER STORED AS A FACT ABOUT THE WORLD. 'absent' and
// 'failed' both write a `nav_absent` row, which is a durable, replicated claim
// that this simulator install does not have the airport. A record this build
// cannot decode, or a decoder that throws, is a bug here — so it discards what
// it buffered, puts the airport's detail state back exactly as it found it, and
// reports the fault as a fault.
//
// THE TAXI NETWORK IS NOT OPENED. Measured, adding TAXI_*/JETWAY multiplies the
// message count by 12.7x to 86x for rows a map never draws, and the facilities
// API's only filter is on VALUES, not on node types, so the sole way to exclude
// them is not to open them.

import {
  freqKey,
  procKey,
  rwyKey,
  transKey,
  type NavdataInput,
  type TransitionRole,
} from './navdata-keys';
import {
  AIRPORT_REQUEST_TIMEOUT_MS,
  type FacilityDataMessage,
  type FacilityDefinition,
  type FacilityDefinitionSpec,
  type FacilityFetchResult,
  type FacilityMinimalEntry,
  type FacilityNodeSpec,
  type FacilityReader,
  type FacilitySession,
} from './navdata-facilities';
import type { NavdataRowInput, NavdataStore, NavdataTx } from './navdata-store';
import type { LogSink } from './uplink';

/** The name the airport definition is prepared and looked up under. */
export const AIRPORT_DETAIL_DEFINITION = 'airport-detail';

// ── The wire ──────────────────────────────────────────────────────────────────

/**
 * How one member is laid out in a facility record. Measured on this build by
 * asking for definitions whose member list was known and reading the widths off
 * the returned bytes; the record size is re-checked against the sum on every
 * record, so a build that lays them out differently is caught rather than
 * silently misread.
 *
 *   f64  latitude, longitude and altitude, everywhere they appear
 *   f32  every other real: headings, lengths, slopes, altitude limits, speeds
 *   i32  counts, enumerations, designators and booleans
 *   s4   a one-character code padded to four bytes (a fix type, a suffix)
 *   s8   an ident or a region
 *   s32  AIRPORT.NAME          — the widths of NAME differ per entry point,
 *   s64  FREQUENCY.NAME          which is why the table is keyed by entry
 */
type FieldKind = 'f64' | 'f32' | 'i32' | 's4' | 's8' | 's32' | 's64';

const FIELD_BYTES: Readonly<Record<FieldKind, number>> = {
  f64: 8,
  f32: 4,
  i32: 4,
  s4: 4,
  s8: 8,
  s32: 32,
  s64: 64,
};

interface Field {
  readonly name: string;
  readonly kind: FieldKind;
}

function field(kind: FieldKind): (name: string) => Field {
  return (name) => ({ name, kind });
}

const f64 = field('f64');
const f32 = field('f32');
const i32 = field('i32');
const s4 = field('s4');
const s8 = field('s8');
const s32 = field('s32');
const s64 = field('s64');

/**
 * `FacilityDataType`, restated. Spelled out rather than imported so this module
 * pulls nothing from node-simconnect at run time and stays testable on a
 * machine with no simulator, the same reason the session does it.
 *
 * PAVEMENT is the one surprise and it is load-bearing: `PRIMARY_THRESHOLD` and
 * `SECONDARY_THRESHOLD` are refused as RUNWAY fields but accepted as child
 * entry points, and BOTH come back typed PAVEMENT. Nothing in the record says
 * which end it describes — only the order they arrive in under their runway.
 */
const REC_AIRPORT = 0;
const REC_RUNWAY = 1;
const REC_FREQUENCY = 3;
const REC_APPROACH = 5;
const REC_APPROACH_TRANSITION = 6;
const REC_APPROACH_LEG = 7;
const REC_FINAL_APPROACH_LEG = 8;
const REC_MISSED_APPROACH_LEG = 9;
const REC_DEPARTURE = 10;
const REC_ARRIVAL = 11;
const REC_RUNWAY_TRANSITION = 12;
const REC_ENROUTE_TRANSITION = 13;
const REC_THRESHOLD = 23;

/** Entry points, in the order the definition opens them. */
const ENTRY_AIRPORT = 'AIRPORT';
const ENTRY_RUNWAY = 'RUNWAY';
const ENTRY_PRIMARY_THRESHOLD = 'PRIMARY_THRESHOLD';
const ENTRY_SECONDARY_THRESHOLD = 'SECONDARY_THRESHOLD';
const ENTRY_FREQUENCY = 'FREQUENCY';
const ENTRY_APPROACH = 'APPROACH';
const ENTRY_APPROACH_TRANSITION = 'APPROACH_TRANSITION';
const ENTRY_APPROACH_LEG = 'APPROACH_LEG';
const ENTRY_FINAL_APPROACH_LEG = 'FINAL_APPROACH_LEG';
const ENTRY_MISSED_APPROACH_LEG = 'MISSED_APPROACH_LEG';
const ENTRY_DEPARTURE = 'DEPARTURE';
const ENTRY_ARRIVAL = 'ARRIVAL';
const ENTRY_RUNWAY_TRANSITION = 'RUNWAY_TRANSITION';
const ENTRY_ENROUTE_TRANSITION = 'ENROUTE_TRANSITION';

/**
 * Every leg entry carries the same member list, so the three of them share one.
 * The three coordinate blocks are each ident + region + type + lat/lon/alt,
 * which is what lets a consumer draw an arc or a radial without a single join.
 */
const LEG_FIELDS: readonly Field[] = [
  i32('TYPE'),
  s8('FIX_ICAO'),
  s8('FIX_REGION'),
  s4('FIX_TYPE'),
  f64('FIX_LATITUDE'),
  f64('FIX_LONGITUDE'),
  f64('FIX_ALTITUDE'),
  s8('ORIGIN_ICAO'),
  s8('ORIGIN_REGION'),
  s4('ORIGIN_TYPE'),
  f64('ORIGIN_LATITUDE'),
  f64('ORIGIN_LONGITUDE'),
  f64('ORIGIN_ALTITUDE'),
  s8('ARC_CENTER_FIX_ICAO'),
  s8('ARC_CENTER_FIX_REGION'),
  s4('ARC_CENTER_FIX_TYPE'),
  f64('ARC_CENTER_FIX_LATITUDE'),
  f64('ARC_CENTER_FIX_LONGITUDE'),
  f64('ARC_CENTER_FIX_ALTITUDE'),
  i32('FLY_OVER'),
  i32('TURN_DIRECTION'),
  f32('COURSE'),
  i32('TRUE_DEGREE'),
  f32('THETA'),
  f32('RHO'),
  f32('DISTANCE_MINUTE'),
  f32('ROUTE_DISTANCE'),
  i32('APPROACH_ALT_DESC'),
  f32('ALTITUDE1'),
  f32('ALTITUDE2'),
  f32('SPEED_LIMIT'),
  f32('VERTICAL_ANGLE'),
  i32('IS_IAF'),
  i32('IS_IF'),
  i32('IS_FAF'),
  i32('IS_MAP'),
];

/** A SID and a STAR are the same record shape under two entry points. */
const PROCEDURE_FIELDS: readonly Field[] = [
  s8('NAME'),
  i32('N_RUNWAY_TRANSITIONS'),
  i32('N_ENROUTE_TRANSITIONS'),
  i32('N_APPROACH_LEGS'),
];

/** Only members this store has a column for; an unread byte is a byte wasted. */
const ENTRY_FIELDS: ReadonlyMap<string, readonly Field[]> = new Map([
  [
    ENTRY_AIRPORT,
    [
      f64('LATITUDE'),
      f64('LONGITUDE'),
      f64('ALTITUDE'),
      f32('MAGVAR'),
      s32('NAME'),
      s8('REGION'),
      i32('N_RUNWAYS'),
      i32('N_APPROACHES'),
      i32('N_DEPARTURES'),
      i32('N_ARRIVALS'),
    ],
  ],
  [
    ENTRY_RUNWAY,
    [
      f64('LATITUDE'),
      f64('LONGITUDE'),
      f64('ALTITUDE'),
      f32('HEADING'),
      f32('LENGTH'),
      f32('WIDTH'),
      f32('PATTERN_ALTITUDE'),
      f32('SLOPE'),
      f32('TRUE_SLOPE'),
      i32('SURFACE'),
      i32('PRIMARY_NUMBER'),
      i32('PRIMARY_DESIGNATOR'),
      i32('SECONDARY_NUMBER'),
      i32('SECONDARY_DESIGNATOR'),
      s8('PRIMARY_ILS_ICAO'),
      s8('PRIMARY_ILS_REGION'),
      s8('SECONDARY_ILS_ICAO'),
      s8('SECONDARY_ILS_REGION'),
    ],
  ],
  // WIDTH is read and thrown away. The pair is the shape that was measured to
  // come back, and a threshold record is two floats whether or not the second
  // is wanted; asking for the proven shape is cheaper than a surprise.
  [ENTRY_PRIMARY_THRESHOLD, [f32('LENGTH'), f32('WIDTH')]],
  [ENTRY_SECONDARY_THRESHOLD, [f32('LENGTH'), f32('WIDTH')]],
  [ENTRY_FREQUENCY, [i32('TYPE'), i32('FREQUENCY'), s64('NAME')]],
  [
    ENTRY_APPROACH,
    [
      i32('TYPE'),
      s4('SUFFIX'),
      i32('RUNWAY_NUMBER'),
      i32('RUNWAY_DESIGNATOR'),
      s8('FAF_ICAO'),
      s8('FAF_REGION'),
      f32('FAF_ALTITUDE'),
      f32('FAF_HEADING'),
      f32('MISSED_ALTITUDE'),
      i32('HAS_LNAV'),
      i32('HAS_LNAVVNAV'),
      i32('HAS_LP'),
      i32('HAS_LPV'),
      i32('N_TRANSITIONS'),
      i32('N_FINAL_APPROACH_LEGS'),
      i32('N_MISSED_APPROACH_LEGS'),
    ],
  ],
  [
    ENTRY_APPROACH_TRANSITION,
    [
      i32('TYPE'),
      s8('IAF_ICAO'),
      s8('IAF_REGION'),
      f32('IAF_ALTITUDE'),
      s8('DME_ARC_ICAO'),
      s8('DME_ARC_REGION'),
      f32('DME_ARC_RADIAL'),
      f32('DME_ARC_DISTANCE'),
      s8('NAME'),
      i32('N_APPROACH_LEGS'),
    ],
  ],
  [ENTRY_APPROACH_LEG, LEG_FIELDS],
  [ENTRY_FINAL_APPROACH_LEG, LEG_FIELDS],
  [ENTRY_MISSED_APPROACH_LEG, LEG_FIELDS],
  [ENTRY_DEPARTURE, PROCEDURE_FIELDS],
  [ENTRY_ARRIVAL, PROCEDURE_FIELDS],
  [
    ENTRY_RUNWAY_TRANSITION,
    [i32('RUNWAY_NUMBER'), i32('RUNWAY_DESIGNATOR'), i32('N_APPROACH_LEGS')],
  ],
  [ENTRY_ENROUTE_TRANSITION, [s8('NAME'), i32('N_APPROACH_LEGS')]],
]);

function node(entry: string, children?: readonly FacilityNodeSpec[]): FacilityNodeSpec {
  const fields = ENTRY_FIELDS.get(entry) ?? [];
  // One spelling per member, not a list of candidates: two spellings of one
  // member can have two different widths, and the decoder reads widths off the
  // member name it was given. A rejected member is still dropped and reported
  // by the definition pass; it just is not silently replaced by a wider one.
  return { entry, aliases: fields.map((f) => [f.name]), children };
}

/** The transitions a SID and a STAR share, plus the common legs edge. */
function procedureChildren(): readonly FacilityNodeSpec[] {
  return [
    node(ENTRY_RUNWAY_TRANSITION, [node(ENTRY_APPROACH_LEG)]),
    node(ENTRY_ENROUTE_TRANSITION, [node(ENTRY_APPROACH_LEG)]),
    // Not optional. Without it the middle of every SID and STAR is missing.
    node(ENTRY_APPROACH_LEG),
  ];
}

/** Everything a map draws for one airport: no taxi network, no jetways. */
export function airportDetailSpec(): FacilityDefinitionSpec {
  return {
    name: AIRPORT_DETAIL_DEFINITION,
    root: node(ENTRY_AIRPORT, [
      node(ENTRY_RUNWAY, [node(ENTRY_PRIMARY_THRESHOLD), node(ENTRY_SECONDARY_THRESHOLD)]),
      node(ENTRY_FREQUENCY),
      node(ENTRY_APPROACH, [
        node(ENTRY_APPROACH_TRANSITION, [node(ENTRY_APPROACH_LEG)]),
        node(ENTRY_FINAL_APPROACH_LEG),
        node(ENTRY_MISSED_APPROACH_LEG),
      ]),
      node(ENTRY_DEPARTURE, procedureChildren()),
      node(ENTRY_ARRIVAL, procedureChildren()),
    ]),
  };
}

// ── Decoding ──────────────────────────────────────────────────────────────────

/** Decoded members of one record, by member name; a missing member is absent. */
type Record_ = Map<string, string | number>;

/** What one record of an entry point looks like on the wire, worked out once. */
interface EntryLayout {
  readonly fields: readonly Field[];
  readonly size: number;
}

/**
 * The wire layout of every entry point in a prepared definition.
 *
 * DE-DUPLICATED, and that is not tidying. The definition's member map is keyed
 * by ENTRY NAME, so an entry opened more than once in the tree comes back with
 * its member list repeated once per opening — `APPROACH_LEG` hangs off seven
 * parents here and answers with 252 names for a 36-member record. Taking the
 * list at face value made every leg, every runway transition and every enroute
 * transition at a real airport fail its size check and store nothing.
 *
 * Working the widths out once per connection rather than once per record also
 * matters: the heaviest airport measured sends 2254 records of up to 36 members
 * each, and that arithmetic would otherwise run eighty thousand times.
 */
function buildLayout(definition: FacilityDefinition): Map<string, EntryLayout> {
  const layout = new Map<string, EntryLayout>();
  for (const [entry, accepted] of definition.members) {
    const known = ENTRY_FIELDS.get(entry);
    if (known === undefined) continue;
    const fields: Field[] = [];
    const seen = new Set<string>();
    for (const name of accepted) {
      if (seen.has(name)) continue;
      const match = known.find((f) => f.name === name);
      if (match === undefined) continue;
      seen.add(name);
      fields.push(match);
    }
    const size = fields.reduce((total, f) => total + FIELD_BYTES[f.kind], 0);
    layout.set(entry, { fields, size });
  }
  return layout;
}

function num(record: Record_, name: string): number | null {
  const value = record.get(name);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(record: Record_, name: string): string | null {
  const value = record.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Whether a reported coordinate may be stored as a position.
 *
 * Finite, in range, and NOT BOTH EXACTLY ZERO. That last clause is the one that
 * earns its keep: (0, 0) is in the Gulf of Guinea, no facility is there, and it
 * is the value an unpopulated FLOAT64 pair takes. Storing it is worse than
 * storing nothing, because a position from a facility fetch OUTRANKS one from
 * the bulk index — so a zeroed record would overwrite a good position with the
 * Gulf of Guinea and no later index pass could ever repair it.
 *
 * Fail closed: a coordinate that does not pass this is no coordinate at all,
 * which means no position and, with it, no position source.
 */
function isStorableCoordinate(lat: number | null, lon: number | null): boolean {
  if (lat === null || lon === null) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return lat !== 0 || lon !== 0;
}

/** A CHECK-constrained flag: anything the simulator reports is 0 or 1 here. */
function flag(record: Record_, name: string): 0 | 1 | null {
  const value = num(record, name);
  if (value === null) return null;
  return value !== 0 ? 1 : 0;
}

/**
 * Runway designators, as the SDK enumerates them. Used for the human-readable
 * half of a runway transition's name and of an approach's; the numeric
 * designator is stored in its own column either way, so this only ever affects
 * a label, never a lookup.
 */
const DESIGNATOR = ['', 'L', 'R', 'C', 'W', 'A', 'B'];

/** `9`,`1` -> `09L`. An unknown designator keeps its number rather than lying. */
export function runwayLabel(
  number: number | null,
  designator: number | null,
): string {
  if (number === null) return '';
  const suffix = designator === null ? '' : (DESIGNATOR[designator] ?? `#${designator}`);
  return `${String(number).padStart(2, '0')}${suffix}`;
}

/**
 * An approach has no NAME member, so its name slot carries its type and its
 * runway — the two things that distinguish one approach to an airport from
 * another, with SUFFIX separating two of the same to the same runway in the
 * key.
 *
 * The type is rendered as the number the simulator reported, NOT as an ILS/RNAV
 * style letter. This name is a key component that the server repository has to
 * reproduce character for character with no shared code, and a letter would
 * mean shipping a private enumeration of approach types to both sides that
 * nothing has measured. Every part of this string is a column of the same row.
 */
export function approachName(
  approachType: number | null,
  runwayNumber: number | null,
  runwayDesignator: number | null,
): string {
  return `${approachType ?? ''}-${runwayLabel(runwayNumber, runwayDesignator)}`;
}

/** The rows one airport's detail produced, ready to write in one transaction. */
export interface AirportDetailRows {
  readonly airport: NavdataRowInput<'nav_airport'>;
  readonly runways: NavdataRowInput<'nav_runway'>[];
  readonly frequencies: NavdataRowInput<'nav_airport_frequency'>[];
  readonly procedures: NavdataRowInput<'nav_procedure'>[];
  readonly transitions: NavdataRowInput<'nav_procedure_transition'>[];
  readonly legs: NavdataRowInput<'nav_procedure_leg'>[];
}

type NodeKind = 'airport' | 'runway' | 'procedure' | 'transition' | 'other';

/**
 * One leg list, still unkeyed.
 *
 * Its `trans_key` depends on its procedure's key, and that key is not known
 * until every record has arrived — see `ProcedureDraft`. So the rows are built
 * as they are decoded and keyed at the end, in one pass.
 */
interface TransitionDraft {
  readonly role: TransitionRole;
  readonly name: string;
  readonly row: NavdataRowInput<'nav_procedure_transition'>;
  readonly legs: NavdataRowInput<'nav_procedure_leg'>[];
}

/** The fields a collision is broken on, gathered as the header is decoded. */
export interface ProcedureOrderKeys {
  readonly fafIdent: string | null;
  readonly nTransitions: number | null;
  readonly missedLegCount: number | null;
  readonly missedAltM: number | null;
  /** 0-based position within this fetch. Always present, always distinct. */
  readonly arrivalIndex: number;
}

/**
 * One procedure, still unkeyed.
 *
 * MEASURED, and the reason this is a draft rather than a row: across 250
 * airports the simulator declared 2962 approaches and only 2954 survived
 * keying. The eight lost were four colliding pairs, each two approaches of
 * the same type to the same runway with the same suffix, indistinguishable to
 * the key. Some pairs were identical on every member the API exposes; others
 * differed materially, so real approaches were disappearing with nothing
 * logged.
 */
interface ProcedureDraft {
  readonly baseKey: string;
  readonly order: ProcedureOrderKeys;
  readonly row: NavdataRowInput<'nav_procedure'>;
  readonly transitions: TransitionDraft[];
  common: TransitionDraft | null;
  final: TransitionDraft | null;
  missed: TransitionDraft | null;
}

interface TreeNode {
  readonly kind: NodeKind;
  /** `rwy_key` for a runway; empty for everything that is keyed at the end. */
  readonly key: string;
  /** Thresholds seen under a runway: the first is primary, the second is not. */
  thresholds: number;
  readonly procedure: ProcedureDraft | null;
  readonly transition: TransitionDraft | null;
}

/** Procedure rows and their descendants, once every key has been decided. */
interface KeyedProcedures {
  readonly procedures: NavdataRowInput<'nav_procedure'>[];
  readonly transitions: NavdataRowInput<'nav_procedure_transition'>[];
  readonly legs: NavdataRowInput<'nav_procedure_leg'>[];
}

/** A stored column value read back as a number, for building a log line. */
function asNumber(value: NavdataInput): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Whether a sort field carries no value, and therefore sorts LAST.
 *
 * One rule at every level: null, undefined, an empty string and NaN are all
 * absent. NaN is named explicitly because a float that failed to decode must
 * not be allowed to order unpredictably — every comparison against NaN is
 * false, which would make the comparator intransitive and the sort's result
 * depend on the algorithm rather than on the data.
 */
function isAbsent(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value === '';
  return Number.isNaN(value);
}

/** One level of the comparison: absent last, otherwise ascending. */
function byValue(a: string | number | null, b: string | number | null): number {
  const left = isAbsent(a);
  const right = isAbsent(b);
  if (left || right) return left === right ? 0 : left ? 1 : -1;
  if (a === null || b === null) return 0;
  // Ordinary `<` on strings is a CODE-UNIT comparison, deliberately: the same
  // choice the airway leg key rests on. `localeCompare` disagrees with it on
  // mixed case and its collation depends on the ICU build, so two repositories
  // implementing this independently would order the same pair differently.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order in which procedures sharing a key take that key.
 *
 * THE POINT OF IT IS THAT ARRIVAL ORDER IS UNREACHABLE except as the last
 * tiebreak. Two approaches that differ materially must hold the same keys after
 * a navdata update as before it; if the base key followed arrival order, a
 * re-ordering of the records would move real content between two keys that both
 * still exist, with nothing erroring and nothing to compare against.
 *
 * Applied only to a set already sharing airport, kind, name, runway number,
 * runway designator and suffix. Absent sorts last at every level. The float is
 * next to last and only ever separates records that are otherwise identical, so
 * no float is a primary discriminator.
 */
export function compareProcedureOrder(a: ProcedureOrderKeys, b: ProcedureOrderKeys): number {
  return (
    byValue(a.fafIdent, b.fafIdent) ||
    byValue(a.nTransitions, b.nTransitions) ||
    byValue(a.missedLegCount, b.missedLegCount) ||
    byValue(a.missedAltM, b.missedAltM) ||
    a.arrivalIndex - b.arrivalIndex
  );
}

/**
 * The key the `index`-th member of a colliding set takes.
 *
 * THERE IS NEVER A `#1`. A procedure that collides with nothing must produce
 * exactly the key it produced before this rule existed — 99.7% of them never
 * collide, and they keep the keys they have.
 */
export function collisionKey(baseKey: string, index: number): string {
  return index === 0 ? baseKey : `${baseKey}#${index + 1}`;
}

/**
 * The keys a set of procedures sharing one base key take, parallel to the input.
 *
 * The whole disambiguation rule, in one pure function, because the msfslogger
 * server has to reproduce it exactly and shares no code with this repository.
 * A set of one gets the base key untouched — that is the 99.7% case and it must
 * keep the key it has.
 */
export function collisionKeysFor(
  baseKey: string,
  order: readonly ProcedureOrderKeys[],
): string[] {
  if (order.length <= 1) return order.map(() => baseKey);
  const ranked = order
    .map((keys, index) => ({ keys, index }))
    .sort((a, b) => compareProcedureOrder(a.keys, b.keys));
  const assigned = new Array<string>(order.length);
  ranked.forEach((entry, rank) => {
    assigned[entry.index] = collisionKey(baseKey, rank);
  });
  return assigned;
}

/**
 * Turns one airport's record stream into rows.
 *
 * Every `accept` call runs inside the SimConnect listener, so it reads the
 * buffer and keeps nothing but numbers and strings. It is also the reason the
 * decoder counts its own failures instead of throwing: a throw settles the
 * request as aborted, which re-queues for ever, and the counted alternative
 * makes the same fault visible without turning it into a claim about the
 * simulator's data.
 *
 * Rows are keyed in one pass at the end rather than as they arrive, because a
 * procedure's key can depend on which OTHER procedures the airport turned out
 * to have. The counters are therefore read after the request settles; reading
 * one mid-stream would key a tree that is not all there yet.
 */
export class AirportDetailDecoder {
  private readonly layout: ReadonlyMap<string, EntryLayout>;
  private readonly byType: ReadonlyMap<number, string>;
  private readonly log: LogSink;

  private nodes = new Map<number, TreeNode>();
  private airportRow: NavdataRowInput<'nav_airport'>;
  private runwayRows: NavdataRowInput<'nav_runway'>[] = [];
  private runwaysByKey = new Map<string, NavdataRowInput<'nav_runway'>>();
  private frequencyRows: NavdataRowInput<'nav_airport_frequency'>[] = [];
  private drafts: ProcedureDraft[] = [];
  private seenKeys = new Set<string>();
  private keyed: KeyedProcedures | null = null;

  /** Records this build could not read, and therefore did not store. */
  private undecodedCount = 0;
  /** Procedures that had to be separated by a disambiguator. */
  private collisionCount = 0;

  constructor(
    private readonly ident: string,
    definition: FacilityDefinition,
    options: { readonly log?: LogSink } = {},
  ) {
    this.layout = buildLayout(definition);
    this.log = options.log ?? ((): void => {});
    this.byType = new Map([
      [REC_AIRPORT, ENTRY_AIRPORT],
      [REC_RUNWAY, ENTRY_RUNWAY],
      [REC_FREQUENCY, ENTRY_FREQUENCY],
      [REC_APPROACH, ENTRY_APPROACH],
      [REC_APPROACH_TRANSITION, ENTRY_APPROACH_TRANSITION],
      [REC_APPROACH_LEG, ENTRY_APPROACH_LEG],
      [REC_FINAL_APPROACH_LEG, ENTRY_FINAL_APPROACH_LEG],
      [REC_MISSED_APPROACH_LEG, ENTRY_MISSED_APPROACH_LEG],
      [REC_DEPARTURE, ENTRY_DEPARTURE],
      [REC_ARRIVAL, ENTRY_ARRIVAL],
      [REC_RUNWAY_TRANSITION, ENTRY_RUNWAY_TRANSITION],
      [REC_ENROUTE_TRANSITION, ENTRY_ENROUTE_TRANSITION],
    ]);
    this.airportRow = { ident };
    this.reset();
  }

  /** Drops everything buffered. The session calls this before every attempt. */
  reset(): void {
    this.nodes = new Map();
    this.airportRow = { ident: this.ident };
    this.runwayRows = [];
    this.runwaysByKey = new Map();
    this.frequencyRows = [];
    this.drafts = [];
    this.seenKeys = new Set();
    this.keyed = null;
    this.undecodedCount = 0;
    this.collisionCount = 0;
  }

  get undecoded(): number {
    this.assignKeys();
    return this.undecodedCount;
  }

  get collisions(): number {
    this.assignKeys();
    return this.collisionCount;
  }

  rows(): AirportDetailRows {
    const keyed = this.assignKeys();
    return {
      airport: this.airportRow,
      runways: this.runwayRows,
      frequencies: this.frequencyRows,
      procedures: keyed.procedures,
      transitions: keyed.transitions,
      legs: keyed.legs,
    };
  }

  /** Decoded rows, counted the way the airport row reports them. */
  counts(): { runways: number; procedures: number } {
    return { runways: this.runwayRows.length, procedures: this.assignKeys().procedures.length };
  }

  /** One record. Runs inside the listener; reads the buffer, keeps no part of it. */
  accept(recv: FacilityDataMessage): void {
    const entry = this.byType.get(recv.type);
    const parent = this.nodes.get(recv.parentUniqueRequestId);

    if (recv.type === REC_THRESHOLD) {
      this.acceptThreshold(recv, parent);
      return;
    }
    if (entry === undefined) {
      // A record type nothing in the definition opened. Not a decode failure:
      // there is no claim to make about it and no bytes to get wrong.
      this.register(recv, 'other');
      return;
    }

    const record = this.read(entry, recv.data);
    if (record === null) {
      this.undecodedCount++;
      this.register(recv, 'other');
      return;
    }

    switch (recv.type) {
      case REC_AIRPORT:
        this.acceptAirport(recv, record);
        return;
      case REC_RUNWAY:
        this.acceptRunway(recv, record);
        return;
      case REC_FREQUENCY:
        this.acceptFrequency(record);
        this.register(recv, 'other');
        return;
      case REC_APPROACH:
        this.acceptApproach(recv, record);
        return;
      case REC_DEPARTURE:
        this.acceptProcedure(recv, record, 'SID');
        return;
      case REC_ARRIVAL:
        this.acceptProcedure(recv, record, 'STAR');
        return;
      case REC_APPROACH_TRANSITION:
        this.acceptApproachTransition(recv, record, parent);
        return;
      case REC_RUNWAY_TRANSITION:
        this.acceptRunwayTransition(recv, record, parent);
        return;
      case REC_ENROUTE_TRANSITION:
        this.acceptEnrouteTransition(recv, record, parent);
        return;
      case REC_APPROACH_LEG:
        this.acceptLeg(recv, record, this.legParent(parent));
        return;
      case REC_FINAL_APPROACH_LEG:
        this.acceptLeg(recv, record, this.synthetic(parent, 'final'));
        return;
      case REC_MISSED_APPROACH_LEG:
        this.acceptLeg(recv, record, this.synthetic(parent, 'missed'));
        return;
      default:
        this.register(recv, 'other');
    }
  }

  // ── Record readers ──────────────────────────────────────────────────────────

  /**
   * Reads one record against the members the simulator agreed to, in the order
   * it agreed to them, and checks the total against the record's own size. The
   * size check is the whole safety net: a member whose width this build lays
   * out differently would otherwise shift every field after it, and the result
   * would be plausible numbers in the wrong columns rather than an error.
   */
  private read(entry: string, data: FacilityReader): Record_ | null {
    const layout = this.layout.get(entry);
    if (layout === undefined || data.remaining() !== layout.size) return null;

    const record: Record_ = new Map();
    for (const known of layout.fields) {
      switch (known.kind) {
        case 'f64':
          record.set(known.name, data.readFloat64());
          break;
        case 'f32':
          record.set(known.name, data.readFloat32());
          break;
        case 'i32':
          record.set(known.name, data.readInt32());
          break;
        default:
          record.set(known.name, data.readString(FIELD_BYTES[known.kind]));
      }
    }
    return record;
  }

  private register(
    recv: FacilityDataMessage,
    kind: NodeKind,
    key = '',
    procedure: ProcedureDraft | null = null,
    transition: TransitionDraft | null = null,
  ): TreeNode {
    const created: TreeNode = { kind, key, thresholds: 0, procedure, transition };
    this.nodes.set(recv.uniqueRequestId, created);
    return created;
  }

  // ── The airport, its runways and its frequencies ────────────────────────────

  private acceptAirport(recv: FacilityDataMessage, record: Record_): void {
    const lat = num(record, 'LATITUDE');
    const lon = num(record, 'LONGITUDE');
    const row: NavdataRowInput<'nav_airport'> = { ident: this.ident };
    // A position source is only ever sent WITH a position: sent alone it claims
    // provenance for a position that came from somewhere else, after which a
    // genuinely better one is refused, silently and for good.
    if (isStorableCoordinate(lat, lon)) {
      row.lat = lat;
      row.lon = lon;
      row.position_source = 'facility';
    }
    row.alt_m = num(record, 'ALTITUDE');
    row.magvar = num(record, 'MAGVAR');
    row.name = text(record, 'NAME');
    row.region = text(record, 'REGION');
    row.n_runways = num(record, 'N_RUNWAYS');
    row.n_approaches = num(record, 'N_APPROACHES');
    row.n_departures = num(record, 'N_DEPARTURES');
    row.n_arrivals = num(record, 'N_ARRIVALS');
    this.airportRow = row;
    this.register(recv, 'airport', this.ident);
  }

  private acceptRunway(recv: FacilityDataMessage, record: Record_): void {
    const primaryNumber = num(record, 'PRIMARY_NUMBER');
    const primaryDesignator = num(record, 'PRIMARY_DESIGNATOR');
    const key = rwyKey(this.ident, primaryNumber, primaryDesignator);
    const reportedLat = num(record, 'LATITUDE');
    const reportedLon = num(record, 'LONGITUDE');
    const placed = isStorableCoordinate(reportedLat, reportedLon);
    const row: NavdataRowInput<'nav_runway'> = {
      rwy_key: key,
      airport_ident: this.ident,
      // The reported point is the runway CENTRE, not a threshold: measured, the
      // two ends are equidistant from it to within a tenth of a metre.
      lat: placed ? reportedLat : null,
      lon: placed ? reportedLon : null,
      alt_m: num(record, 'ALTITUDE'),
      // TRUE, not magnetic. Measured across four airports chosen for large and
      // opposite variation; no magvar correction belongs on this value.
      heading_deg: num(record, 'HEADING'),
      // Includes the displaced portions at both ends, so the usable length is
      // shorter than this wherever a threshold below is non-zero.
      length_m: num(record, 'LENGTH'),
      width_m: num(record, 'WIDTH'),
      pattern_altitude_m: num(record, 'PATTERN_ALTITUDE'),
      slope_deg: num(record, 'SLOPE'),
      true_slope_deg: num(record, 'TRUE_SLOPE'),
      surface: num(record, 'SURFACE'),
      // Primary is NOT always the lower-numbered end — measured, some airports
      // report the higher-numbered end as primary — so the end is keyed off
      // these explicitly and never inferred from which number is smaller.
      primary_number: primaryNumber,
      primary_designator: primaryDesignator,
      secondary_number: num(record, 'SECONDARY_NUMBER'),
      secondary_designator: num(record, 'SECONDARY_DESIGNATOR'),
      primary_ils_ident: text(record, 'PRIMARY_ILS_ICAO'),
      primary_ils_region: text(record, 'PRIMARY_ILS_REGION'),
      secondary_ils_ident: text(record, 'SECONDARY_ILS_ICAO'),
      secondary_ils_region: text(record, 'SECONDARY_ILS_REGION'),
    };
    if (this.claim(key)) {
      this.runwayRows.push(row);
      this.runwaysByKey.set(key, row);
    }
    this.register(recv, 'runway', key);
  }

  /**
   * A displaced threshold. Both ends come back under the same record type with
   * nothing in them to say which end they are, so the order they arrive in
   * under their runway is the only discriminator: first primary, then
   * secondary. An unexpected third is counted rather than guessed at.
   */
  private acceptThreshold(recv: FacilityDataMessage, parent: TreeNode | undefined): void {
    this.register(recv, 'other');
    if (parent === undefined || parent.kind !== 'runway') {
      this.undecodedCount++;
      return;
    }
    const which = parent.thresholds++;
    const entry = which === 0 ? ENTRY_PRIMARY_THRESHOLD : ENTRY_SECONDARY_THRESHOLD;
    const record = this.read(entry, recv.data);
    if (record === null || which > 1) {
      this.undecodedCount++;
      return;
    }
    const row = this.runwaysByKey.get(parent.key);
    if (row === undefined) return;
    // NULL means this fetch carried no value; 0 means the simulator reported
    // zero. They are not interchangeable: an absent member written as 0 would
    // overwrite a real displacement with "not displaced", which renders
    // identically and so is never noticed.
    const length = num(record, 'LENGTH');
    if (which === 0) row.primary_threshold_m = length;
    else row.secondary_threshold_m = length;
  }

  private acceptFrequency(record: Record_): void {
    const freqType = num(record, 'TYPE');
    const hz = num(record, 'FREQUENCY');
    const key = freqKey(this.ident, freqType, hz);
    if (!this.claim(key)) return;
    this.frequencyRows.push({
      freq_key: key,
      airport_ident: this.ident,
      freq_type: freqType,
      frequency_hz: hz,
      name: text(record, 'NAME'),
    });
  }

  // ── Procedures ──────────────────────────────────────────────────────────────

  private acceptApproach(recv: FacilityDataMessage, record: Record_): void {
    const approachType = num(record, 'TYPE');
    const runwayNumber = num(record, 'RUNWAY_NUMBER');
    const runwayDesignator = num(record, 'RUNWAY_DESIGNATOR');
    const suffix = text(record, 'SUFFIX');
    const name = approachName(approachType, runwayNumber, runwayDesignator);
    const baseKey = procKey({
      airportIdent: this.ident,
      kind: 'APPROACH',
      name,
      runwayNumber,
      runwayDesignator,
      suffix,
    });
    const missedLegs = num(record, 'N_MISSED_APPROACH_LEGS');
    const missedAlt = num(record, 'MISSED_ALTITUDE');
    const nTransitions = num(record, 'N_TRANSITIONS');
    const draft: ProcedureDraft = {
      baseKey,
      order: {
        fafIdent: text(record, 'FAF_ICAO'),
        nTransitions,
        missedLegCount: missedLegs,
        missedAltM: missedAlt,
        arrivalIndex: this.drafts.length,
      },
      row: {
        airport_ident: this.ident,
        kind: 'APPROACH',
        name,
        runway_number: runwayNumber,
        runway_designator: runwayDesignator,
        approach_type: approachType,
        suffix,
        faf_ident: text(record, 'FAF_ICAO'),
        faf_region: text(record, 'FAF_REGION'),
        faf_alt_m: num(record, 'FAF_ALTITUDE'),
        faf_heading_deg: num(record, 'FAF_HEADING'),
        missed_alt_m: missedAlt,
        has_lnav: flag(record, 'HAS_LNAV'),
        has_lnavvnav: flag(record, 'HAS_LNAVVNAV'),
        has_lp: flag(record, 'HAS_LP'),
        has_lpv: flag(record, 'HAS_LPV'),
        n_transitions: nTransitions,
      },
      transitions: [],
      common: null,
      final: null,
      missed: null,
    };
    this.drafts.push(draft);
    this.register(recv, 'procedure', '', draft);
    // The final and missed leg lists are not transitions on the wire; they are
    // stored as ones so that every leg hangs off a parent of the same shape.
    // Their declared counts go on those rows, which is the only place a short
    // final can be told from a silent one.
    const finals = num(record, 'N_FINAL_APPROACH_LEGS');
    if (finals !== null && finals > 0) draft.final = this.makeTransition(draft, 'final', '', finals);
    if (missedLegs !== null && missedLegs > 0) {
      draft.missed = this.makeTransition(draft, 'missed', '', missedLegs);
    }
  }

  private acceptProcedure(recv: FacilityDataMessage, record: Record_, kind: 'SID' | 'STAR'): void {
    const name = text(record, 'NAME') ?? '';
    const draft: ProcedureDraft = {
      baseKey: procKey({ airportIdent: this.ident, kind, name }),
      // A SID or a STAR carries none of the approach discriminators, so two of
      // them sharing a name fall straight through to arrival order. That is the
      // honest answer: nothing the API reports tells them apart.
      order: {
        fafIdent: null,
        nTransitions: null,
        missedLegCount: null,
        missedAltM: null,
        arrivalIndex: this.drafts.length,
      },
      row: {
        airport_ident: this.ident,
        kind,
        name,
        n_runway_transitions: num(record, 'N_RUNWAY_TRANSITIONS'),
        n_enroute_transitions: num(record, 'N_ENROUTE_TRANSITIONS'),
      },
      transitions: [],
      common: null,
      final: null,
      missed: null,
    };
    this.drafts.push(draft);
    this.register(recv, 'procedure', '', draft);
    const commonLegs = num(record, 'N_APPROACH_LEGS');
    if (commonLegs !== null && commonLegs > 0) {
      draft.common = this.makeTransition(draft, 'common', '', commonLegs);
    }
  }

  private acceptApproachTransition(
    recv: FacilityDataMessage,
    record: Record_,
    parent: TreeNode | undefined,
  ): void {
    const draft = parent?.procedure ?? null;
    if (draft === null) {
      this.undecodedCount++;
      this.register(recv, 'other');
      return;
    }
    const created = this.makeTransition(
      draft,
      'approach',
      text(record, 'NAME') ?? '',
      num(record, 'N_APPROACH_LEGS'),
      {
        trans_type: num(record, 'TYPE'),
        iaf_ident: text(record, 'IAF_ICAO'),
        iaf_region: text(record, 'IAF_REGION'),
        iaf_alt_m: num(record, 'IAF_ALTITUDE'),
        dme_arc_ident: text(record, 'DME_ARC_ICAO'),
        dme_arc_region: text(record, 'DME_ARC_REGION'),
        dme_arc_radial_deg: num(record, 'DME_ARC_RADIAL'),
        dme_arc_distance_m: num(record, 'DME_ARC_DISTANCE'),
      },
    );
    this.register(recv, 'transition', '', null, created);
  }

  private acceptRunwayTransition(
    recv: FacilityDataMessage,
    record: Record_,
    parent: TreeNode | undefined,
  ): void {
    const draft = parent?.procedure ?? null;
    if (draft === null) {
      this.undecodedCount++;
      this.register(recv, 'other');
      return;
    }
    const number = num(record, 'RUNWAY_NUMBER');
    const designator = num(record, 'RUNWAY_DESIGNATOR');
    // The runway goes in the NAME. A SID has one of these per runway it serves
    // and they would otherwise all key to the same empty name, so the second
    // would overwrite the first and the store would hold one runway transition
    // for a procedure that has four.
    const created = this.makeTransition(
      draft,
      'runway',
      runwayLabel(number, designator),
      num(record, 'N_APPROACH_LEGS'),
      { runway_number: number, runway_designator: designator },
    );
    this.register(recv, 'transition', '', null, created);
  }

  private acceptEnrouteTransition(
    recv: FacilityDataMessage,
    record: Record_,
    parent: TreeNode | undefined,
  ): void {
    const draft = parent?.procedure ?? null;
    if (draft === null) {
      this.undecodedCount++;
      this.register(recv, 'other');
      return;
    }
    const created = this.makeTransition(
      draft,
      'enroute',
      text(record, 'NAME') ?? '',
      num(record, 'N_APPROACH_LEGS'),
    );
    this.register(recv, 'transition', '', null, created);
  }

  /** A leg list under a procedure, with the row it will be keyed into. */
  private makeTransition(
    draft: ProcedureDraft,
    role: TransitionRole,
    name: string,
    legs: number | null,
    extra: Partial<NavdataRowInput<'nav_procedure_transition'>> = {},
  ): TransitionDraft {
    const created: TransitionDraft = {
      role,
      name,
      row: { role, name, n_legs: legs, ...extra },
      legs: [],
    };
    draft.transitions.push(created);
    return created;
  }

  /**
   * The parent a plain APPROACH_LEG hangs off. Under a transition it is that
   * transition; directly under a DEPARTURE or an ARRIVAL it is the procedure's
   * common-leg list, which is created here if the declared count did not
   * already create it — a procedure that reports zero common legs and then
   * sends some is still a procedure whose middle has to be stored.
   */
  private legParent(parent: TreeNode | undefined): TransitionDraft | null {
    if (parent === undefined) return null;
    if (parent.transition !== null) return parent.transition;
    const draft = parent.procedure;
    if (draft === null) return null;
    if (draft.common === null) draft.common = this.makeTransition(draft, 'common', '', null);
    return draft.common;
  }

  /** An approach's final or missed leg list, created on the first leg if need be. */
  private synthetic(parent: TreeNode | undefined, role: 'final' | 'missed'): TransitionDraft | null {
    const draft = parent?.procedure ?? null;
    if (draft === null) return null;
    const existing = role === 'final' ? draft.final : draft.missed;
    if (existing !== null) return existing;
    const created = this.makeTransition(draft, role, '', null);
    if (role === 'final') draft.final = created;
    else draft.missed = created;
    return created;
  }

  private acceptLeg(
    recv: FacilityDataMessage,
    record: Record_,
    parent: TransitionDraft | null,
  ): void {
    this.register(recv, 'other');
    if (parent === null) {
      this.undecodedCount++;
      return;
    }
    const legType = num(record, 'TYPE');
    parent.legs.push({
      // seq is the order the simulator sent them, and nothing re-sorts it.
      seq: parent.legs.length,
      // The SDK's path-terminator enumeration, stored as the code. Which of
      // them carry a drawable coordinate is a consumer rule, not this one's.
      leg_type: legType ?? 0,
      fix_ident: text(record, 'FIX_ICAO'),
      fix_region: text(record, 'FIX_REGION'),
      fix_type: text(record, 'FIX_TYPE'),
      fix_lat: num(record, 'FIX_LATITUDE'),
      fix_lon: num(record, 'FIX_LONGITUDE'),
      fix_alt_m: num(record, 'FIX_ALTITUDE'),
      origin_ident: text(record, 'ORIGIN_ICAO'),
      origin_region: text(record, 'ORIGIN_REGION'),
      origin_type: text(record, 'ORIGIN_TYPE'),
      origin_lat: num(record, 'ORIGIN_LATITUDE'),
      origin_lon: num(record, 'ORIGIN_LONGITUDE'),
      origin_alt_m: num(record, 'ORIGIN_ALTITUDE'),
      arc_center_ident: text(record, 'ARC_CENTER_FIX_ICAO'),
      arc_center_region: text(record, 'ARC_CENTER_FIX_REGION'),
      arc_center_type: text(record, 'ARC_CENTER_FIX_TYPE'),
      arc_center_lat: num(record, 'ARC_CENTER_FIX_LATITUDE'),
      arc_center_lon: num(record, 'ARC_CENTER_FIX_LONGITUDE'),
      arc_center_alt_m: num(record, 'ARC_CENTER_FIX_ALTITUDE'),
      fly_over: flag(record, 'FLY_OVER'),
      turn_direction: num(record, 'TURN_DIRECTION'),
      course_deg: num(record, 'COURSE'),
      true_degree: flag(record, 'TRUE_DEGREE'),
      theta_deg: num(record, 'THETA'),
      rho_m: num(record, 'RHO'),
      distance_minute: num(record, 'DISTANCE_MINUTE'),
      route_distance_m: num(record, 'ROUTE_DISTANCE'),
      alt_desc: num(record, 'APPROACH_ALT_DESC'),
      altitude1_m: num(record, 'ALTITUDE1'),
      altitude2_m: num(record, 'ALTITUDE2'),
      // MEASURED: the simulator reports -1 where a leg has no speed limit, and
      // it is stored exactly as given — substituting NULL would lose the
      // difference between "unrestricted" and "this fetch carried no value".
      // The consequence belongs to whoever displays it: a NEGATIVE speed limit
      // means unrestricted and is shown as no limit, never as a number.
      speed_limit_kt: num(record, 'SPEED_LIMIT'),
      vertical_angle_deg: num(record, 'VERTICAL_ANGLE'),
      is_iaf: flag(record, 'IS_IAF'),
      is_if: flag(record, 'IS_IF'),
      is_faf: flag(record, 'IS_FAF'),
      is_map: flag(record, 'IS_MAP'),
    });
  }

  // ── Keying, once every record is in ─────────────────────────────────────────

  /**
   * Assigns every procedure its key, then keys its transitions and their legs.
   *
   * Two procedures that key alike are SEPARATED rather than merged. Merging was
   * the old behaviour and it was silent: the second procedure's leg lists
   * re-used seq 0..n under the first's transition keys and overwrote them, so
   * one whole approach disappeared into another with nothing to show for it.
   *
   * Which of them keeps the base key is decided from the DATA — see
   * `compareProcedureOrder` — and never from the order the records arrived in.
   *
   * A TRANSITION collision inside one procedure is a different animal and is
   * still refused: there is no agreed disambiguator for one, and the cost of
   * getting it wrong is the same lost leg list, so it is counted as a record
   * this build could not place. That discards the airport rather than storing a
   * tree that is quietly wrong.
   */
  private assignKeys(): KeyedProcedures {
    if (this.keyed !== null) return this.keyed;

    const groups = new Map<string, ProcedureDraft[]>();
    for (const draft of this.drafts) {
      const group = groups.get(draft.baseKey);
      if (group === undefined) groups.set(draft.baseKey, [draft]);
      else group.push(draft);
    }

    const keys = new Map<ProcedureDraft, string>();
    for (const [baseKey, group] of groups) {
      const assigned = collisionKeysFor(
        baseKey,
        group.map((draft) => draft.order),
      );
      group.forEach((draft, index) => {
        const key = assigned[index];
        keys.set(draft, key);
        if (key === baseKey) return;
        this.collisionCount++;
        // Never silent. Before this, a second procedure keying like the first
        // was dropped without a word, and four real approaches were
        // disappearing across five airports with nothing anywhere to show it.
        this.log(
          'warn',
          `navdata: ${this.ident} reports ${group.length} ${String(draft.row.kind)} rows keyed alike ` +
            `(type ${String(draft.row.approach_type ?? '-')}, runway ` +
            `${runwayLabel(asNumber(draft.row.runway_number), asNumber(draft.row.runway_designator)) || '-'}) — ` +
            `keeping this one as ${key}`,
        );
      });
    }

    const procedures: NavdataRowInput<'nav_procedure'>[] = [];
    const transitions: NavdataRowInput<'nav_procedure_transition'>[] = [];
    const legs: NavdataRowInput<'nav_procedure_leg'>[] = [];
    // Emitted in ARRIVAL order, whatever order the keys were decided in: the
    // rows a fetch writes should not shuffle because one pair of them collided.
    for (const draft of this.drafts) {
      const procKeyValue = keys.get(draft) as string;
      procedures.push({ ...draft.row, proc_key: procKeyValue });
      const seen = new Set<string>();
      for (const transition of draft.transitions) {
        const key = transKey(procKeyValue, transition.role, transition.name);
        if (seen.has(key)) {
          this.undecodedCount++;
          continue;
        }
        seen.add(key);
        transitions.push({ ...transition.row, trans_key: key, proc_key: procKeyValue });
        for (const leg of transition.legs) legs.push({ ...leg, trans_key: key });
      }
    }

    this.keyed = { procedures, transitions, legs };
    return this.keyed;
  }

  /**
   * True the first time a LEAF key is seen in this fetch — a runway, a
   * frequency. A second sighting is a duplicate row with no children to lose,
   * so it is simply dropped. Procedures and transitions do not come through
   * here: a collision there costs a whole leg list and is handled in
   * `assignKeys`.
   */
  private claim(key: string): boolean {
    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    return true;
  }
}

// ── The fetch ─────────────────────────────────────────────────────────────────

export type AirportDetailStatus =
  /** Rows written, `detail_state = 'detail'`. */
  | 'detail'
  /**
   * This install does not have the airport — either it said nothing at all, or
   * it refused the request outright, which is what an airport actually does.
   */
  | 'absent'
  /** The simulator refused for a reason that says the request was wrong. */
  | 'failed'
  /** The link went away, or the caller could not clear its buffer. */
  | 'aborted'
  /** The ident matched several facilities; the candidates are in `minimal`. */
  | 'ambiguous'
  /** Records arrived that THIS BUILD could not read. Our fault, not the sim's. */
  | 'undecodable'
  /** There is no store to write to. */
  | 'disabled';

export interface AirportDetailResult {
  readonly ident: string;
  readonly status: AirportDetailStatus;
  readonly runways: number;
  readonly frequencies: number;
  readonly procedures: number;
  readonly transitions: number;
  readonly legs: number;
  /** Rows the transaction actually changed; a re-fetch of a known airport is 0. */
  readonly written: number;
  readonly undecoded: number;
  /**
   * Procedures that shared a key and had to be kept apart by a disambiguator.
   * Not an error — the rows are all there — but it is the only signal that this
   * airport's approach keys are not what a naive reading of the schema would
   * produce, and the server has asked to be able to see the number.
   */
  readonly collisions: number;
  readonly messages: number;
  readonly ms: number;
  readonly minimal: readonly FacilityMinimalEntry[] | null;
  /** One line, safe for a status axis: no token, no path. */
  readonly reason: string | null;
}

export interface AirportDetailOptions {
  readonly log?: LogSink;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Higher runs first when the concurrency cap makes requests queue. */
  readonly priority?: number;
}

/**
 * Fetches one airport's detail and lands it in the store.
 *
 * The detail state moves 'index' -> 'pending' -> one of 'detail', 'absent' or
 * 'failed', and the pending mark is written before the request goes out so a
 * process that dies mid-fetch leaves a row that `resetPendingDetail` can find.
 * Anything that is OUR fault — a record this build cannot read, a dropped link
 * — puts the state back exactly as it was found and writes no absence: a
 * `nav_absent` row is a claim that the simulator lacks the airport, and it
 * replicates.
 */
export async function fetchAirportDetail(
  session: FacilitySession,
  store: NavdataStore | null,
  definition: FacilityDefinition,
  ident: string,
  options: AirportDetailOptions = {},
): Promise<AirportDetailResult> {
  const log = options.log ?? ((): void => {});
  const now = options.now ?? Date.now;
  const empty = {
    ident,
    runways: 0,
    frequencies: 0,
    procedures: 0,
    transitions: 0,
    legs: 0,
    written: 0,
    undecoded: 0,
    collisions: 0,
    messages: 0,
    ms: 0,
    minimal: null,
  } as const;

  if (store === null) {
    return { ...empty, status: 'disabled', reason: 'navdata disabled: no store is open' };
  }

  const before = store.row('nav_airport', { ident });
  const priorState = typeof before?.detail_state === 'string' ? before.detail_state : 'index';
  // 'pending' means a request is out with the simulator right now. It is
  // written before the send so that a sidecar that dies mid-fetch leaves
  // evidence of it, and cleared on every path out of here.
  store.write((tx) => tx.upsert('nav_airport', { ident, detail_state: 'pending' }));

  const decoder = new AirportDetailDecoder(ident, definition, { log });
  let result: FacilityFetchResult;
  try {
    result = await session.fetch({
      definitionId: definition.definitionId,
      ident,
      timeoutMs: options.timeoutMs ?? AIRPORT_REQUEST_TIMEOUT_MS,
      priority: options.priority,
      onAttempt: () => decoder.reset(),
      onMessage: (recv) => decoder.accept(recv),
    });
  } catch (err) {
    restore(store, ident, priorState);
    const reason = describeFailure(err);
    log('warn', `navdata: the ${ident} detail request could not be sent (${reason})`);
    return { ...empty, status: 'failed', reason };
  }

  const base = { ...empty, messages: result.messages, ms: result.ms };

  if (result.outcome === 'aborted') {
    restore(store, ident, priorState);
    return { ...base, status: 'aborted', reason: 'the simulator connection dropped mid-fetch' };
  }
  if (result.outcome === 'resolved-ambiguous') {
    // Terminal, and not a detail fetch: the simulator answered with candidates
    // and will never send facility data for this request. Airport idents are
    // distinct world-wide on this API, so this is a surprise worth a line.
    restore(store, ident, priorState);
    log('info', `navdata: ${ident} matched ${result.minimal?.length ?? 0} facilities, not one`);
    return {
      ...base,
      status: 'ambiguous',
      minimal: result.minimal,
      reason: 'the ident matched more than one facility',
    };
  }
  if (result.outcome === 'absent' || result.outcome === 'failed' || result.outcome === 'partial') {
    const exception = result.outcome !== 'absent';
    const missing = !exception || isMissingFacility(result);
    const state = missing ? 'absent' : 'failed';
    const at = now();
    store.write((tx) => {
      tx.upsert('nav_airport', { ident, detail_state: state, detail_fetched_at: at });
      // ONLY AN ABSENCE RECORDS AN ABSENCE. `nav_absent` is a durable,
      // replicated claim that this simulator install does not have the
      // facility, and the server's demand predicate acts on it. A refusal that
      // means our request was malformed is a fault in THIS code; recording it
      // here would turn our bug into data about the world, and the airport
      // would stay missing from the map until someone noticed by hand.
      // The accepted cost: a malformed request never clears the server's queued
      // item. The fix for that is to repair the request.
      if (missing) {
        // The reason is what actually happened, not what it means. An exception
        // is stronger evidence than silence and stays distinguishable from it,
        // which is what makes an absence worth re-checking later.
        tx.recordAbsent({ ident, kind: 'A', reason: exception ? 'exception' : 'silent', at });
      }
    });
    const reason = missing
      ? `the simulator does not have ${ident}` +
        (exception ? ` (${result.exception ?? 'no reason given'})` : '')
      : `the simulator refused the ${ident} detail request (${result.exception ?? 'no reason given'})`;
    log('info', `navdata: ${reason}`);
    return { ...base, status: state, reason };
  }

  // From here the request completed. Anything still wrong is OURS.
  // Reading the rows is what assigns the keys, and a transition that keys like
  // another is only discovered there — so the tree is built before it is judged.
  const rows = decoder.rows();
  if (decoder.undecoded > 0) {
    restore(store, ident, priorState);
    const reason = `${decoder.undecoded} ${ident} record(s) did not match the definition this build sent`;
    log('warn', `navdata: ${reason} — nothing was stored for it`);
    return { ...base, status: 'undecodable', undecoded: decoder.undecoded, reason };
  }

  const counts = decoder.counts();
  const at = now();
  let written: number;
  try {
    written = store.write((tx) => writeDetail(tx, rows, counts, at));
  } catch (err) {
    // A write that throws leaves the transaction rolled back, so nothing landed
    // and nothing may be claimed. Same rule as a bad decode: our fault, our
    // state restored, no absence recorded.
    restore(store, ident, priorState);
    const reason = describeFailure(err);
    log('warn', `navdata: the ${ident} detail could not be stored (${reason})`);
    return { ...base, status: 'undecodable', reason };
  }

  return {
    ...base,
    status: 'detail',
    runways: rows.runways.length,
    frequencies: rows.frequencies.length,
    procedures: rows.procedures.length,
    transitions: rows.transitions.length,
    legs: rows.legs.length,
    written,
    collisions: decoder.collisions,
    reason: null,
  };
}

/**
 * One airport, one transaction. The order is the foreign keys' order — airport,
 * then its runways and frequencies, then procedures, their transitions and
 * their legs — so nothing is ever inserted against a parent that is not there
 * yet, and a failure anywhere rolls the whole tree back rather than leaving a
 * procedure with half its legs, which would look complete.
 */
function writeDetail(
  tx: NavdataTx,
  rows: AirportDetailRows,
  counts: { runways: number; procedures: number },
  at: number,
): number {
  let written = 0;
  const airport: NavdataRowInput<'nav_airport'> = {
    ...rows.airport,
    detail_state: 'detail',
    detail_fetched_at: at,
    detail_runways: counts.runways,
    detail_procedures: counts.procedures,
  };
  if (tx.upsert('nav_airport', airport)) written++;
  for (const row of rows.runways) if (tx.upsert('nav_runway', row)) written++;
  for (const row of rows.frequencies) if (tx.upsert('nav_airport_frequency', row)) written++;
  for (const row of rows.procedures) if (tx.upsert('nav_procedure', row)) written++;
  for (const row of rows.transitions) if (tx.upsert('nav_procedure_transition', row)) written++;
  for (const row of rows.legs) if (tx.upsert('nav_procedure_leg', row)) written++;
  return written;
}

/**
 * The simulator's generic refusal of a request. It is read as a NUMBER and not
 * matched against the exception's printed form: the printed form exists to be
 * read in a log, and branching on it would keep working until someone reworded
 * it and then stop being taken, silently, with every missing airport reverting
 * to a state that is re-requested for ever.
 */
const EXCEPTION_ERROR = 1;

/**
 * Whether an exception means "this install has no such airport" rather than
 * "that request was wrong".
 *
 * MEASURED, and the reason this distinction exists at all: an airport ident the
 * simulator does not have answers IMMEDIATELY with exception 1 and no rows —
 * never with the silence a missing navaid answers with. The difference matters
 * to a user, not just to a schema: `failed` is a fault in THIS code and stays
 * re-requestable for ever, so a "fetch detail" button pressed on an airport the
 * simulator lacks would spin until the request expired. `absent` is a fact
 * about the simulator, and the server clears the request on it.
 *
 * Narrow on purpose, in both halves. A refusal that arrives AFTER the simulator
 * has sent rows is not evidence of a missing airport — it answered, so the
 * airport is there. And every other exception code — a member it would not
 * accept, an id it did not recognise — is a defect in what WE sent; recording
 * that as an absence would teach the store that the world is missing an airport
 * because this build asked for it wrongly.
 */
function isMissingFacility(result: FacilityFetchResult): boolean {
  return result.messages === 0 && result.exceptionCode === EXCEPTION_ERROR;
}

/** Puts the detail state back where it was found, and never throws. */
function restore(store: NavdataStore, ident: string, state: NavdataInput): void {
  try {
    store.write((tx) => tx.upsert('nav_airport', { ident, detail_state: state }));
  } catch {
    // Nothing useful can be done about it here, and an escaping error from a
    // navdata path reaches the supervisor, which answers a dying sidecar by
    // taking frames, traffic and the datalink down with it.
  }
}

/** An error reduced to one safe line: a code when there is one, never a path. */
function describeFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
