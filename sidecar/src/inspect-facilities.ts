#!/usr/bin/env ts-node
// ── Facilities inspector ──────────────────────────────────────────────────────
//
// A measurement CLI over SimConnect's facilities API. It opens its own
// connection under its own client name — never the sidecar's — and reports
// what the simulator's navdata actually costs to pull: how many rows the bulk
// list calls return and over what area, how many messages and bytes a single
// airport costs with and without its taxi network, which facility definition
// entry points this simulator build accepts, and what a waypoint's airway
// (ROUTE) children cost.
//
//   node dist/inspect-facilities.js probe   [--airports EGLL]
//   node dist/inspect-facilities.js list    [--all|--legacy] [--rows] [--out <path>]
//   node dist/inspect-facilities.js census  [--airports EGLL,KJFK,…]
//   node dist/inspect-facilities.js airport [--airports EGLL,KJFK,…] [--dump-runways]
//   node dist/inspect-facilities.js routes  [--count 50] [--concurrency 8]
//   node dist/inspect-facilities.js region  [--ident DVR] [--idents CH,OW --type N]
//
// Every command takes --sim 2020|2024|fsx (default 2020) and --wait <ms>, the
// ceiling on retrying the connection while the simulator is still starting.
//
// Read-only by construction: it registers data definitions and asks for
// facilities. Nothing here writes to the simulator, and no config file is
// read, so it can never touch an ingest token.
//
// Field and entry-point names are probed rather than assumed. The facilities
// API answers a bad member name with an asynchronous exception carrying the
// send id of the offending packet, so every definition is built by sending all
// candidate names, waiting for the simulator to complain, and keeping only the
// names it did not reject. That keeps the tool honest across simulator
// versions, where the accepted member set differs.

import { writeFileSync } from 'node:fs';
import {
  FacilityDataType,
  FacilityListType,
  Protocol,
  RawBuffer,
  SimConnectDataType,
  SimConnectPeriod,
  open,
  type RecvException,
  type RecvFacilityData,
  type RecvFacilityMinimalList,
  type SimConnectConnection,
} from 'node-simconnect';
import { SIM_PROTOCOL_NAME, type SimId } from './config';

const APP_NAME = 'msfslogger-spike';

/** How long to wait for the simulator to reject a definition packet. */
const SETTLE_MS = 700;

/** Default ceiling on a single facility-data request. */
const REQUEST_TIMEOUT_MS = 60_000;

/** A list request is finished when it has been quiet this long. */
const LIST_IDLE_MS = 20_000;

const DEFAULT_AIRPORTS = ['EGLL', 'KJFK', 'KBFI', 'KHAF'];

// ── argument handling ─────────────────────────────────────────────────────────

function flagValue(argv: string[], name: string): string | undefined {
  const prefixed = argv.find((a) => a.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function parseSim(argv: string[]): SimId {
  const raw = flagValue(argv, 'sim') ?? '2020';
  if (raw === '2020' || raw === '2024' || raw === 'fsx') return raw;
  throw new Error(`unknown --sim ${raw}`);
}

function parseList(argv: string[], name: string, fallback: string[]): string[] {
  const raw = flagValue(argv, name);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

// ── facility definition shapes ────────────────────────────────────────────────

/**
 * A node of a facility definition. `aliases` holds candidate spellings for one
 * logical member; the first spelling the simulator accepts is the one used.
 */
interface NodeSpec {
  entry: string;
  aliases: string[][];
  children?: NodeSpec[];
}

const POSITION: string[][] = [['LATITUDE'], ['LONGITUDE'], ['ALTITUDE']];

const LEG_ALIASES: string[][] = [
  ['TYPE'],
  ['FIX_ICAO'],
  ['FIX_REGION'],
  ['FIX_TYPE'],
  ['FIX_LATITUDE'],
  ['FIX_LONGITUDE'],
  ['FIX_ALTITUDE'],
  ['FLY_OVER'],
  ['DISTANCE_MINUTE'],
  ['TRUE_DEGREE'],
  ['TURN_DIRECTION'],
  ['ORIGIN_ICAO'],
  ['ORIGIN_REGION'],
  ['ORIGIN_TYPE'],
  ['ORIGIN_LATITUDE'],
  ['ORIGIN_LONGITUDE'],
  ['ORIGIN_ALTITUDE'],
  ['THETA'],
  ['RHO'],
  ['COURSE'],
  ['ROUTE_DISTANCE'],
  ['APPROACH_ALT_DESC'],
  ['ALTITUDE1'],
  ['ALTITUDE2'],
  ['SPEED_LIMIT'],
  ['VERTICAL_ANGLE'],
  ['ARC_CENTER_FIX_ICAO'],
  ['ARC_CENTER_FIX_REGION'],
  ['ARC_CENTER_FIX_TYPE'],
  ['ARC_CENTER_FIX_LATITUDE'],
  ['ARC_CENTER_FIX_LONGITUDE'],
  ['ARC_CENTER_FIX_ALTITUDE'],
  ['IS_IAF'],
  ['IS_IF'],
  ['IS_FAF'],
  ['IS_MAP'],
];

const RUNWAY_NODE: NodeSpec = {
  entry: 'RUNWAY',
  aliases: [
    ...POSITION,
    ['HEADING'],
    ['LENGTH'],
    ['WIDTH'],
    ['PATTERN_ALTITUDE'],
    ['SLOPE'],
    ['TRUE_SLOPE'],
    ['SURFACE'],
    ['PRIMARY_NUMBER'],
    ['PRIMARY_DESIGNATOR'],
    ['SECONDARY_NUMBER'],
    ['SECONDARY_DESIGNATOR'],
    ['PRIMARY_ILS_ICAO'],
    ['PRIMARY_ILS_REGION'],
    ['PRIMARY_ILS_TYPE'],
    ['SECONDARY_ILS_ICAO'],
    ['SECONDARY_ILS_REGION'],
    ['SECONDARY_ILS_TYPE'],
  ],
};

const APPROACH_TRANSITION_NODE: NodeSpec = {
  entry: 'APPROACH_TRANSITION',
  aliases: [
    ['TYPE'],
    ['IAF_ICAO'],
    ['IAF_REGION'],
    ['IAF_TYPE'],
    ['IAF_ALTITUDE'],
    ['DME_ARC_ICAO'],
    ['DME_ARC_REGION'],
    ['DME_ARC_TYPE'],
    ['DME_ARC_RADIAL'],
    ['DME_ARC_DISTANCE'],
    ['NAME'],
    ['N_APPROACH_LEGS'],
  ],
  children: [{ entry: 'APPROACH_LEG', aliases: LEG_ALIASES }],
};

const APPROACH_HEADER: string[][] = [
  ['TYPE'],
  ['SUFFIX'],
  ['RUNWAY_NUMBER'],
  ['RUNWAY_DESIGNATOR'],
  ['FAF_ICAO'],
  ['FAF_REGION'],
  ['FAF_TYPE'],
  ['FAF_ALTITUDE'],
  ['FAF_HEADING'],
  ['MISSED_ALTITUDE'],
  ['HAS_LNAV'],
  ['HAS_LNAVVNAV'],
  ['HAS_LP'],
  ['HAS_LPV'],
  ['N_TRANSITIONS'],
  ['N_FINAL_APPROACH_LEGS'],
  ['N_MISSED_APPROACH_LEGS'],
];

/** The whole approach subtree, including the two leg entries known to be fragile. */
const APPROACH_NODE: NodeSpec = {
  entry: 'APPROACH',
  aliases: APPROACH_HEADER,
  children: [
    APPROACH_TRANSITION_NODE,
    { entry: 'FINAL_APPROACH_LEG', aliases: LEG_ALIASES },
    { entry: 'MISSED_APPROACH_LEG', aliases: LEG_ALIASES },
  ],
};

const DEPARTURE_ARRIVAL_CHILDREN: NodeSpec[] = [
  {
    entry: 'RUNWAY_TRANSITION',
    aliases: [['RUNWAY_NUMBER'], ['RUNWAY_DESIGNATOR'], ['N_APPROACH_LEGS']],
    children: [{ entry: 'APPROACH_LEG', aliases: LEG_ALIASES }],
  },
  {
    entry: 'ENROUTE_TRANSITION',
    aliases: [['NAME'], ['N_APPROACH_LEGS']],
    children: [{ entry: 'APPROACH_LEG', aliases: LEG_ALIASES }],
  },
  // A SID/STAR's common legs hang straight off DEPARTURE/ARRIVAL, not off a
  // transition, so without this child the middle of every procedure is missing.
  { entry: 'APPROACH_LEG', aliases: LEG_ALIASES },
];

const PROCEDURE_HEADER: string[][] = [
  ['NAME'],
  ['N_RUNWAY_TRANSITIONS'],
  ['N_ENROUTE_TRANSITIONS'],
  ['N_APPROACH_LEGS'],
];

const AIRPORT_HEADER: string[][] = [
  ...POSITION,
  ['MAGVAR'],
  ['NAME'],
  ['NAME64'],
  ['ICAO'],
  ['REGION'],
  ['N_RUNWAYS'],
  ['N_APPROACHES'],
  ['N_DEPARTURES'],
  ['N_ARRIVALS'],
];

/** Position and procedure counts only, in an order that is safe to read back. */
const AIRPORT_CENSUS: string[][] = [
  ['LATITUDE'],
  ['LONGITUDE'],
  ['N_RUNWAYS'],
  ['N_APPROACHES'],
  ['N_DEPARTURES'],
  ['N_ARRIVALS'],
];

/** Everything a map would draw for an airport: no taxi network, no jetways. */
function navAirportSpec(): NodeSpec {
  return {
    entry: 'AIRPORT',
    aliases: AIRPORT_HEADER,
    children: [
      RUNWAY_NODE,
      { entry: 'START', aliases: [...POSITION, ['HEADING'], ['NUMBER'], ['DESIGNATOR'], ['TYPE']] },
      { entry: 'FREQUENCY', aliases: [['TYPE'], ['FREQUENCY'], ['NAME']] },
      {
        entry: 'HELIPAD',
        aliases: [...POSITION, ['HEADING'], ['LENGTH'], ['WIDTH'], ['SURFACE'], ['TYPE']],
      },
      APPROACH_NODE,
      { entry: 'DEPARTURE', aliases: PROCEDURE_HEADER, children: DEPARTURE_ARRIVAL_CHILDREN },
      { entry: 'ARRIVAL', aliases: PROCEDURE_HEADER, children: DEPARTURE_ARRIVAL_CHILDREN },
    ],
  };
}

/** The nav definition plus the ground layout: taxi network and jetways. */
function fullAirportSpec(): NodeSpec {
  const spec = navAirportSpec();
  spec.children = [
    ...(spec.children ?? []),
    { entry: 'TAXI_POINT', aliases: [['TYPE'], ['ORIENTATION'], ['BIAS_X'], ['BIAS_Z']] },
    {
      entry: 'TAXI_PARKING',
      aliases: [
        ['TYPE'],
        ['TAXI_POINT_TYPE'],
        ['NAME'],
        ['SUFFIX'],
        ['NUMBER'],
        ['ORIENTATION'],
        ['HEADING'],
        ['RADIUS'],
        ['BIAS_X'],
        ['BIAS_Z'],
      ],
    },
    {
      entry: 'TAXI_PATH',
      aliases: [
        ['TYPE'],
        ['WIDTH'],
        ['START'],
        ['END'],
        ['NAME_INDEX'],
        ['LEFT_EDGE'],
        ['RIGHT_EDGE'],
        ['RUNWAY_NUMBER'],
        ['RUNWAY_DESIGNATOR'],
      ],
    },
    { entry: 'TAXI_NAME', aliases: [['NAME']] },
    { entry: 'JETWAY', aliases: [['PARKING_GATE'], ['PARKING_SUFFIX'], ['PARKING_SPOT']] },
  ];
  return spec;
}

const WAYPOINT_SPEC: NodeSpec = {
  entry: 'WAYPOINT',
  aliases: [
    ...POSITION,
    ['TYPE'],
    ['MAGVAR'],
    ['N_ROUTES'],
    ['ICAO'],
    ['REGION'],
    ['IS_TERMINAL_WPT'],
  ],
  children: [
    {
      entry: 'ROUTE',
      aliases: [
        ['NAME'],
        ['TYPE'],
        ['NEXT_ICAO'],
        ['NEXT_REGION'],
        ['NEXT_TYPE'],
        ['NEXT_LATITUDE'],
        ['NEXT_LONGITUDE'],
        ['NEXT_ALTITUDE'],
        ['PREV_ICAO'],
        ['PREV_REGION'],
        ['PREV_TYPE'],
        ['PREV_LATITUDE'],
        ['PREV_LONGITUDE'],
        ['PREV_ALTITUDE'],
      ],
    },
  ],
};

/**
 * A VOR does not carry a station position on every simulator build, so
 * LATITUDE and friends stay in the candidate list and the probe reports
 * whether this one accepts them.
 */
const VOR_ALIASES: string[][] = [
  ...POSITION,
  ['FREQUENCY'],
  ['TYPE'],
  ['IS_NAV'],
  ['IS_DME'],
  ['IS_TACAN'],
  ['HAS_GLIDE_SLOPE'],
  ['DME_AT_NAV'],
  ['DME_AT_GLIDE_SLOPE'],
  ['HAS_BACK_COURSE'],
  ['LOCALIZER'],
  ['LOCALIZER_WIDTH'],
  ['MAGVAR'],
  ['NAME'],
  ['ICAO'],
  ['REGION'],
  ['NAV_RANGE'],
  ['GS_LATITUDE'],
  ['GS_LONGITUDE'],
  ['GS_ALTITUDE'],
  ['TACAN_LATITUDE'],
  ['TACAN_LONGITUDE'],
  ['TACAN_ALTITUDE'],
  ['DME_LATITUDE'],
  ['DME_LONGITUDE'],
  ['DME_ALTITUDE'],
];

const NDB_ALIASES: string[][] = [
  ...POSITION,
  ['FREQUENCY'],
  ['TYPE'],
  ['RANGE'],
  ['MAGVAR'],
  ['NAME'],
  ['ICAO'],
  ['REGION'],
];

// ── session ───────────────────────────────────────────────────────────────────

interface FetchResult {
  messages: number;
  bytes: number;
  byType: Map<FacilityDataType, number>;
  ms: number;
  ended: boolean;
  exceptions: string[];
  /** Populated instead of data when an ident matches more than one facility. */
  minimalList: string[] | null;
}

interface BuildResult {
  definitionId: number;
  accepted: Map<string, string[]>;
  rejectedEntries: { entry: string; verb: string; exception: string }[];
  rejectedFields: { entry: string; field: string; exception: string }[];
}

class Spike {
  private nextDefinitionId = 100;
  private nextRequestId = 100;
  private readonly pendingExceptions = new Map<number, RecvException>();
  private readonly sink: ((recv: RecvFacilityData) => void)[] = [];

  constructor(readonly handle: SimConnectConnection) {
    // Pipelined requests each attach their own end-of-data listener.
    handle.setMaxListeners(0);
    handle.on('exception', (recv) => {
      this.pendingExceptions.set(recv.sendId, recv);
    });
    handle.on('facilityData', (recv) => {
      for (const listener of this.sink) listener(recv);
    });
  }

  allocateDefinitionId(): number {
    return this.nextDefinitionId++;
  }

  allocateRequestId(): number {
    return this.nextRequestId++;
  }

  exceptionFor(sendId: number): string | null {
    const recv = this.pendingExceptions.get(sendId);
    return recv ? `${recv.exceptionName}(${recv.exception}) index=${recv.index}` : null;
  }

  /**
   * Sends every candidate member name, then reports which ones the simulator
   * rejected. An entry point whose OPEN is rejected takes its fields with it.
   */
  async buildDefinition(spec: NodeSpec): Promise<BuildResult> {
    const definitionId = this.allocateDefinitionId();
    const sends: { entry: string; verb: string; field: string; sendId: number }[] = [];

    const emit = (node: NodeSpec): void => {
      sends.push({
        entry: node.entry,
        verb: 'OPEN',
        field: '',
        sendId: this.handle.addToFacilityDefinition(definitionId, `OPEN ${node.entry}`),
      });
      for (const group of node.aliases) {
        for (const name of group) {
          sends.push({
            entry: node.entry,
            verb: 'FIELD',
            field: name,
            sendId: this.handle.addToFacilityDefinition(definitionId, name),
          });
        }
      }
      for (const child of node.children ?? []) emit(child);
      sends.push({
        entry: node.entry,
        verb: 'CLOSE',
        field: '',
        sendId: this.handle.addToFacilityDefinition(definitionId, `CLOSE ${node.entry}`),
      });
    };

    emit(spec);
    await sleep(SETTLE_MS);

    const accepted = new Map<string, string[]>();
    const rejectedEntries: BuildResult['rejectedEntries'] = [];
    const rejectedFields: BuildResult['rejectedFields'] = [];
    for (const send of sends) {
      const failure = this.exceptionFor(send.sendId);
      if (send.verb === 'FIELD') {
        if (failure) rejectedFields.push({ entry: send.entry, field: send.field, exception: failure });
        else accepted.set(send.entry, [...(accepted.get(send.entry) ?? []), send.field]);
      } else if (failure) {
        rejectedEntries.push({ entry: send.entry, verb: send.verb, exception: failure });
      }
    }
    return { definitionId, accepted, rejectedEntries, rejectedFields };
  }

  /**
   * Rebuilds `spec` keeping only one accepted spelling per member, using the
   * rejections a probe pass found. Entry points that were rejected outright
   * are dropped along with their children.
   */
  async buildAcceptedDefinition(spec: NodeSpec, probe: BuildResult): Promise<number> {
    const rejectedEntry = new Set(probe.rejectedEntries.map((r) => r.entry));
    const rejectedField = new Set(probe.rejectedFields.map((r) => `${r.entry}.${r.field}`));

    const prune = (node: NodeSpec): NodeSpec | null => {
      if (rejectedEntry.has(node.entry)) return null;
      const aliases = node.aliases
        .map((group) => group.find((name) => !rejectedField.has(`${node.entry}.${name}`)))
        .filter((name): name is string => name !== undefined)
        .map((name) => [name]);
      const children = (node.children ?? [])
        .map(prune)
        .filter((child): child is NodeSpec => child !== null);
      return { entry: node.entry, aliases, children };
    };

    const pruned = prune(spec);
    if (!pruned) throw new Error(`entry point ${spec.entry} was rejected outright`);
    const built = await this.buildDefinition(pruned);
    return built.definitionId;
  }

  /** Issues one facility request and collects every message until its end marker. */
  async fetch(
    definitionId: number,
    icao: string,
    region?: string,
    icaoType?: 'V' | 'N' | 'W',
    timeoutMs = REQUEST_TIMEOUT_MS,
    onMessage?: (recv: RecvFacilityData) => void,
  ): Promise<FetchResult> {
    const requestId = this.allocateRequestId();
    const result: FetchResult = {
      messages: 0,
      bytes: 0,
      byType: new Map(),
      ms: 0,
      ended: false,
      exceptions: [],
      minimalList: null,
    };

    const started = Date.now();
    return await new Promise<FetchResult>((resolve) => {
      let settled = false;
      const onData = (recv: RecvFacilityData): void => {
        if (recv.userRequestId !== requestId) return;
        result.messages++;
        result.bytes += recv.data.remaining();
        result.byType.set(recv.type, (result.byType.get(recv.type) ?? 0) + 1);
        if (onMessage) onMessage(recv);
      };
      const onEnd = (recv: { userRequestId: number }): void => {
        if (recv.userRequestId !== requestId) return;
        finish();
      };
      const onMinimal = (recv: RecvFacilityMinimalList): void => {
        if (recv.requestID !== requestId) return;
        result.minimalList = recv.data.map(
          (item) =>
            `${item.icao.ident}/${item.icao.region || '-'}/${item.icao.type}` +
            `@${item.latLonAlt.latitude.toFixed(3)},${item.latLonAlt.longitude.toFixed(3)}`,
        );
        finish();
      };
      const timer = setTimeout(finish, timeoutMs);

      function finish(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result.ms = Date.now() - started;
        resolve(result);
      }

      this.sink.push(onData);
      this.handle.on('facilityDataEnd', onEnd);
      this.handle.on('facilityMinimalList', onMinimal);

      const sendId = this.handle.requestFacilityData(definitionId, requestId, icao, region, icaoType);
      setTimeout(() => {
        const failure = this.exceptionFor(sendId);
        if (failure) {
          result.exceptions.push(failure);
          finish();
        }
      }, SETTLE_MS);

      const cleanup = (): void => {
        const index = this.sink.indexOf(onData);
        if (index >= 0) this.sink.splice(index, 1);
        this.handle.off('facilityDataEnd', onEnd);
        this.handle.off('facilityMinimalList', onMinimal);
      };
      void Promise.resolve().then(async () => {
        while (!settled) await sleep(50);
        cleanup();
      });
    }).then((value) => {
      value.ended = !value.exceptions.length && value.ms < timeoutMs;
      return value;
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── connection ────────────────────────────────────────────────────────────────

async function connect(sim: SimId, deadlineMs: number): Promise<SimConnectConnection> {
  const protocolName = SIM_PROTOCOL_NAME[sim];
  const until = Date.now() + deadlineMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const { recvOpen, handle } = await open(APP_NAME, Protocol[protocolName]);
      console.log(
        `connected   : ${recvOpen.applicationName} ${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor} ` +
          `(Protocol.${protocolName}, attempt ${attempt})`,
      );
      handle.on('error', () => {
        /* reported through the request paths below */
      });
      return handle;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (Date.now() >= until) throw new Error(`could not connect after ${attempt} attempts: ${message}`);
      console.log(`waiting     : ${message} (attempt ${attempt})`);
      await sleep(5000);
    }
  }
}

/** Reads the user aircraft position once, so list results can be sized against it. */
async function aircraftPosition(handle: SimConnectConnection): Promise<{ lat: number; lon: number } | null> {
  const definitionId = 90;
  const requestId = 90;
  handle.addToDataDefinition(definitionId, 'PLANE LATITUDE', 'degrees', SimConnectDataType.FLOAT64);
  handle.addToDataDefinition(definitionId, 'PLANE LONGITUDE', 'degrees', SimConnectDataType.FLOAT64);
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    handle.on('simObjectData', ({ requestID, data }) => {
      if (requestID !== requestId) return;
      clearTimeout(timer);
      resolve({ lat: data.readFloat64(), lon: data.readFloat64() });
    });
    handle.requestDataOnSimObject(requestId, definitionId, 0, SimConnectPeriod.ONCE);
  });
}

// ── commands ──────────────────────────────────────────────────────────────────

interface ListRow {
  icao: string;
  region: string;
  lat: number;
  lon: number;
}

interface ListSummary {
  type: string;
  rows: number;
  ms: number;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  distinctRegions: number;
  farthestKm: number;
  sample: ListRow[];
  rows_detail?: ListRow[];
}

function summarise(type: string, rows: ListRow[], ms: number, from: { lat: number; lon: number } | null): ListSummary {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  let farthestKm = 0;
  const regions = new Set<string>();
  for (const row of rows) {
    minLat = Math.min(minLat, row.lat);
    maxLat = Math.max(maxLat, row.lat);
    minLon = Math.min(minLon, row.lon);
    maxLon = Math.max(maxLon, row.lon);
    regions.add(row.region);
    if (from) farthestKm = Math.max(farthestKm, greatCircleKm(from.lat, from.lon, row.lat, row.lon));
  }
  return {
    type,
    rows: rows.length,
    ms,
    minLat,
    maxLat,
    minLon,
    maxLon,
    distinctRegions: regions.size,
    farthestKm: Math.round(farthestKm),
    sample: rows.slice(0, 5),
  };
}

function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Runs one list request and collects rows until the simulator stops sending.
 * `useAll` picks requestAllFacilities over the bubble-scoped list call.
 */
async function runList(
  spike: Spike,
  type: FacilityListType,
  useAll: boolean,
  legacy = false,
): Promise<{ rows: ListRow[]; ms: number; exception: string | null; outOf: number | null }> {
  const handle = spike.handle;
  const requestId = spike.allocateRequestId();
  const rows: ListRow[] = [];
  const started = Date.now();
  let outOf: number | null = null;
  let exception: string | null = null;

  return await new Promise((resolve) => {
    let idle: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      handle.off('airportList', onAirport);
      handle.off('vorList', onNavaid);
      handle.off('ndbList', onNavaid);
      handle.off('waypointList', onNavaid);
      resolve({ rows, ms: Date.now() - started, exception, outOf });
    };

    const bump = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(finish, LIST_IDLE_MS);
    };

    const collect = (
      recv: { requestID: number; entryNumber: number; outOf: number },
      items: { icao: string; region: string; latitude: number; longitude: number }[],
    ): void => {
      if (recv.requestID !== requestId) return;
      outOf = recv.outOf;
      for (const item of items) {
        rows.push({ icao: item.icao, region: item.region, lat: item.latitude, lon: item.longitude });
      }
      bump();
      if (recv.entryNumber >= recv.outOf - 1) finish();
    };

    const onAirport = (recv: { requestID: number; entryNumber: number; outOf: number; airports: { icao: string; region: string; latitude: number; longitude: number }[] }): void =>
      collect(recv, recv.airports);
    const onNavaid = (recv: { requestID: number; entryNumber: number; outOf: number; facilities?: unknown }): void => {
      const items = (recv as unknown as { [key: string]: unknown })['vors'] ??
        (recv as unknown as { [key: string]: unknown })['ndbs'] ??
        (recv as unknown as { [key: string]: unknown })['waypoints'] ??
        (recv as unknown as { [key: string]: unknown })['facilities'];
      collect(recv, (items ?? []) as { icao: string; region: string; latitude: number; longitude: number }[]);
    };

    handle.on('airportList', onAirport);
    handle.on('vorList', onNavaid);
    handle.on('ndbList', onNavaid);
    handle.on('waypointList', onNavaid);

    let sendId: number;
    try {
      if (useAll) sendId = handle.requestAllFacilities(requestId, type);
      else if (legacy) sendId = handle.requestFacilitiesList(type, requestId);
      else sendId = handle.requestFacilitiesListEx1(type, requestId);
    } catch (err) {
      exception = err instanceof Error ? err.message : String(err);
      finish();
      return;
    }

    bump();
    setTimeout(() => {
      const failure = spike.exceptionFor(sendId);
      if (failure) {
        exception = failure;
        finish();
      }
    }, SETTLE_MS);
  });
}

async function commandList(spike: Spike, argv: string[]): Promise<number> {
  const useAll = hasFlag(argv, 'all');
  const legacy = hasFlag(argv, 'legacy');
  const outPath = flagValue(argv, 'out') ?? null;
  const here = await aircraftPosition(spike.handle);
  console.log(`aircraft    : ${here ? `${here.lat.toFixed(4)},${here.lon.toFixed(4)}` : '<unavailable>'}`);
  const call = useAll ? 'requestAllFacilities' : legacy ? 'requestFacilitiesList' : 'requestFacilitiesListEx1';
  console.log(`call        : ${call}`);

  const summaries: ListSummary[] = [];
  for (const name of ['AIRPORT', 'VOR', 'NDB', 'WAYPOINT'] as const) {
    const result = await runList(spike, FacilityListType[name], useAll, legacy);
    if (result.exception) {
      console.log(`${name.padEnd(9)} : EXCEPTION ${result.exception}`);
      continue;
    }
    const summary = summarise(name, result.rows, result.ms, here);
    if (hasFlag(argv, 'rows')) summary.rows_detail = result.rows;
    summaries.push(summary);
    console.log(
      `${name.padEnd(9)} : rows=${summary.rows} ms=${summary.ms} outOf=${result.outOf ?? '-'} ` +
        `lat=[${summary.minLat.toFixed(2)},${summary.maxLat.toFixed(2)}] lon=[${summary.minLon.toFixed(2)},${summary.maxLon.toFixed(2)}] ` +
        `regions=${summary.distinctRegions} farthestKm=${summary.farthestKm}`,
    );
    console.log(`            sample: ${summary.sample.map((r) => `${r.icao}/${r.region}`).join(' ')}`);
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ call, aircraft: here, summaries }, null, 2));
    console.log(`written     : ${outPath}`);
  }
  return 0;
}

function typeBreakdown(byType: Map<FacilityDataType, number>): string {
  return [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${FacilityDataType[type] ?? type}=${count}`)
    .join(' ');
}

/** Size and procedure counts per airport, one message each, read back as values. */
async function commandCensus(spike: Spike, argv: string[]): Promise<number> {
  const airports = parseList(argv, 'airports', DEFAULT_AIRPORTS);
  const spec: NodeSpec = { entry: 'AIRPORT', aliases: AIRPORT_CENSUS };
  const probe = await spike.buildDefinition(spec);
  console.log(`rejected    : ${probe.rejectedFields.map((r) => r.field).join(' ') || '<none>'}`);
  const definitionId = await spike.buildAcceptedDefinition(spec, probe);

  for (const icao of airports) {
    let decoded = '<no data>';
    const result = await spike.fetch(definitionId, icao, undefined, undefined, 15_000, (recv) => {
      if (recv.type !== FacilityDataType.AIRPORT || recv.data.remaining() < 32) return;
      const lat = recv.data.readFloat64();
      const lon = recv.data.readFloat64();
      const runways = recv.data.readInt32();
      const approaches = recv.data.readInt32();
      const departures = recv.data.readInt32();
      const arrivals = recv.data.readInt32();
      decoded =
        `pos=${lat.toFixed(4)},${lon.toFixed(4)} runways=${runways} approaches=${approaches} ` +
        `sids=${departures} stars=${arrivals}`;
    });
    console.log(
      `${icao.padEnd(6)}      : ${decoded} messages=${result.messages} bytes=${result.bytes} ms=${result.ms}` +
        (result.exceptions.length ? ` EXCEPTION ${result.exceptions.join(',')}` : ''),
    );
  }
  return 0;
}

/**
 * Values only, in an order that is safe to read back: enough to compare a
 * runway's HEADING against the number painted on its threshold. Runway numbers
 * come from the magnetic bearing rounded to ten degrees, so the comparison
 * says whether HEADING is magnetic or true without needing any variation.
 */
const RUNWAY_DUMP_SPEC: NodeSpec = {
  entry: 'AIRPORT',
  aliases: [['LATITUDE'], ['LONGITUDE'], ['MAGVAR'], ['N_RUNWAYS']],
  children: [
    {
      entry: 'RUNWAY',
      aliases: [
        ['LATITUDE'],
        ['LONGITUDE'],
        ['HEADING'],
        ['LENGTH'],
        ['WIDTH'],
        ['PRIMARY_NUMBER'],
        ['PRIMARY_DESIGNATOR'],
        ['SECONDARY_NUMBER'],
        ['SECONDARY_DESIGNATOR'],
      ],
    },
    {
      entry: 'START',
      aliases: [['LATITUDE'], ['LONGITUDE'], ['ALTITUDE'], ['HEADING'], ['NUMBER'], ['DESIGNATOR'], ['TYPE']],
    },
  ],
};

/**
 * Candidate members for a displaced threshold. Each is probed on its own so a
 * rejection cannot cascade: first as a plain RUNWAY field, then as a child
 * entry point of RUNWAY.
 */
const THRESHOLD_FIELD_CANDIDATES = [
  'PRIMARY_THRESHOLD',
  'SECONDARY_THRESHOLD',
  'PRIMARY_THRESHOLD_LENGTH',
  'SECONDARY_THRESHOLD_LENGTH',
  'PRIMARY_DISPLACED_THRESHOLD',
  'SECONDARY_DISPLACED_THRESHOLD',
  'PRIMARY_BLASTPAD',
  'SECONDARY_BLASTPAD',
  'PRIMARY_OVERRUN',
  'SECONDARY_OVERRUN',
];

const THRESHOLD_ENTRY_CANDIDATES = [
  'PRIMARY_THRESHOLD',
  'SECONDARY_THRESHOLD',
  'PRIMARY_BLASTPAD',
  'SECONDARY_BLASTPAD',
  'PRIMARY_OVERRUN',
  'SECONDARY_OVERRUN',
  'PAVEMENT',
  'DEFORMATION',
];

const DESIGNATOR = ['NONE', 'L', 'R', 'C', 'WATER', 'A', 'B'];

function designatorName(value: number): string {
  return DESIGNATOR[value] ?? `?${value}`;
}

/** The whole record as hex, so a wrong assumption about field widths is recoverable. */
function hexOf(data: RawBuffer): string {
  const offset = data.getOffset();
  const bytes = data.readBytes(data.remaining());
  data.setOffset(offset);
  return bytes.toString('hex');
}

function normaliseDegrees(value: number): number {
  let out = value % 360;
  if (out > 180) out -= 360;
  if (out < -180) out += 360;
  return out;
}

function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return greatCircleKm(lat1, lon1, lat2, lon2) * 1000;
}

/** Flat-earth projection; over a runway length the error is centimetres. */
function project(lat: number, lon: number, bearingDeg: number, metres: number): { lat: number; lon: number } {
  const rad = (bearingDeg * Math.PI) / 180;
  const dLat = (metres * Math.cos(rad)) / 111_320;
  const dLon = (metres * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

interface RunwayRow {
  lat: number;
  lon: number;
  heading: number;
  length: number;
  primaryNumber: number;
  primaryDesignator: number;
  secondaryNumber: number;
  secondaryDesignator: number;
}

interface StartRow {
  lat: number;
  lon: number;
  heading: number;
  number: number;
  designator: number;
  type: number;
}

function runwayLabel(number: number, designator: number): string {
  return `${String(number).padStart(2, '0')}${designator ? designatorName(designator) : ''}`;
}

/**
 * Asks whether the reported runway point is the centre or a threshold, by
 * measuring it against the takeoff positions at each end.
 */
function compareStarts(runways: RunwayRow[], starts: StartRow[]): string[] {
  const lines: string[] = [];
  for (const runway of runways) {
    const half = runway.length / 2;
    const primaryEnd = project(runway.lat, runway.lon, runway.heading + 180, half);
    const secondaryEnd = project(runway.lat, runway.lon, runway.heading, half);
    lines.push(
      `    ${runwayLabel(runway.primaryNumber, runway.primaryDesignator)}/` +
        `${runwayLabel(runway.secondaryNumber, runway.secondaryDesignator)} len=${runway.length.toFixed(1)} ` +
        `half=${half.toFixed(1)} endSeparation=${metresBetween(primaryEnd.lat, primaryEnd.lon, secondaryEnd.lat, secondaryEnd.lon).toFixed(1)}`,
    );
    const ends = [
      ['primaryEnd  ', runway.primaryNumber, runway.primaryDesignator, primaryEnd],
      ['secondaryEnd', runway.secondaryNumber, runway.secondaryDesignator, secondaryEnd],
    ] as const;
    for (const [label, number, designator, end] of ends) {
      const matching = starts.filter((s) => s.number === number && s.designator === designator);
      if (!matching.length) {
        lines.push(`      ${label} ${runwayLabel(number, designator)}: no matching START`);
        continue;
      }
      for (const start of matching) {
        lines.push(
          `      ${label} ${runwayLabel(number, designator)}: ` +
            `toReported=${metresBetween(runway.lat, runway.lon, start.lat, start.lon).toFixed(1)} ` +
            `toThisEnd=${metresBetween(end.lat, end.lon, start.lat, start.lon).toFixed(1)} ` +
            `startHeading=${start.heading.toFixed(2)} startType=${start.type}`,
        );
      }
    }
  }
  return lines;
}

/** Prints every runway's heading next to its painted number, plus the airport MAGVAR. */
async function commandDumpRunways(spike: Spike, airports: string[]): Promise<number> {
  const probe = await spike.buildDefinition(RUNWAY_DUMP_SPEC);
  console.log(`rejected    : ${probe.rejectedFields.map((r) => `${r.entry}.${r.field}`).join(' ') || '<none>'}`);
  const definitionId = await spike.buildAcceptedDefinition(RUNWAY_DUMP_SPEC, probe);

  for (const icao of airports) {
    const lines: string[] = [];
    const runways: RunwayRow[] = [];
    const starts: StartRow[] = [];
    const result = await spike.fetch(definitionId, icao, undefined, undefined, 30_000, (recv) => {
      const size = recv.data.remaining();
      const raw = hexOf(recv.data);
      if (recv.type === FacilityDataType.AIRPORT) {
        const lat = recv.data.readFloat64();
        const lon = recv.data.readFloat64();
        // MAGVAR's width is not documented; the record size tells which it is.
        const magvar = size >= 28 ? recv.data.readFloat64() : recv.data.readFloat32();
        const runways = recv.data.readInt32();
        lines.push(
          `  airport   : pos=${lat.toFixed(5)},${lon.toFixed(5)} magvar=${magvar.toFixed(4)} ` +
            `n_runways=${runways} size=${size} raw=${raw}`,
        );
        return;
      }
      if (recv.type === FacilityDataType.START) {
        const lat = recv.data.readFloat64();
        const lon = recv.data.readFloat64();
        const altitude = recv.data.readFloat64();
        const heading = size >= 48 ? recv.data.readFloat64() : recv.data.readFloat32();
        const number = recv.data.readInt32();
        const designator = recv.data.readInt32();
        const type = recv.data.readInt32();
        starts.push({ lat, lon, heading, number, designator, type });
        lines.push(
          `  start     : ${runwayLabel(number, designator)} type=${type} heading=${heading.toFixed(4)} ` +
            `pos=${lat.toFixed(6)},${lon.toFixed(6)} alt=${altitude.toFixed(1)} size=${size} raw=${raw}`,
        );
        return;
      }
      if (recv.type !== FacilityDataType.RUNWAY) return;
      const lat = recv.data.readFloat64();
      const lon = recv.data.readFloat64();
      const wide = size >= 56;
      const heading = wide ? recv.data.readFloat64() : recv.data.readFloat32();
      const length = wide ? recv.data.readFloat64() : recv.data.readFloat32();
      const width = wide ? recv.data.readFloat64() : recv.data.readFloat32();
      const primaryNumber = recv.data.readInt32();
      const primaryDesignator = recv.data.readInt32();
      const secondaryNumber = recv.data.readInt32();
      const secondaryDesignator = recv.data.readInt32();
      const delta =
        primaryNumber >= 1 && primaryNumber <= 36
          ? normaliseDegrees(heading - primaryNumber * 10).toFixed(2)
          : 'n/a';
      const deltaSecondary =
        secondaryNumber >= 1 && secondaryNumber <= 36
          ? normaliseDegrees(heading - 180 - secondaryNumber * 10).toFixed(2)
          : 'n/a';
      runways.push({
        lat,
        lon,
        heading,
        length,
        primaryNumber,
        primaryDesignator,
        secondaryNumber,
        secondaryDesignator,
      });
      lines.push(
        `  runway    : ${String(primaryNumber).padStart(2)}${designatorName(primaryDesignator).padEnd(5)}/` +
          `${String(secondaryNumber).padStart(2)}${designatorName(secondaryDesignator).padEnd(5)} ` +
          `heading=${heading.toFixed(4)} delta1=${String(delta).padStart(8)} delta2=${String(deltaSecondary).padStart(8)} ` +
          `len=${length.toFixed(1)} wid=${width.toFixed(1)} centre=${lat.toFixed(5)},${lon.toFixed(5)} ` +
          `size=${size} raw=${raw}`,
      );
    });
    console.log(
      `${icao.padEnd(6)}      : messages=${result.messages} ms=${result.ms}` +
        (result.exceptions.length ? ` EXCEPTION ${result.exceptions.join(',')}` : ''),
    );
    for (const line of lines) console.log(line);
    console.log(`  centre-vs-threshold, metres:`);
    for (const line of compareStarts(runways, starts)) console.log(line);
  }

  await probeThresholdMembers(spike);
  return 0;
}

/** Asks only whether a displaced-threshold member exists; builds no pavement tree. */
async function probeThresholdMembers(spike: Spike): Promise<void> {
  const fieldSpec: NodeSpec = {
    entry: 'AIRPORT',
    aliases: [],
    children: [{ entry: 'RUNWAY', aliases: THRESHOLD_FIELD_CANDIDATES.map((name) => [name]) }],
  };
  const fieldProbe = await spike.buildDefinition(fieldSpec);
  const rejected = new Set(fieldProbe.rejectedFields.map((r) => r.field));
  for (const name of THRESHOLD_FIELD_CANDIDATES) {
    console.log(`RUNWAY.${name.padEnd(30)}: ${rejected.has(name) ? 'REJECTED' : 'ACCEPTED'}`);
  }

  for (const entry of THRESHOLD_ENTRY_CANDIDATES) {
    const spec: NodeSpec = {
      entry: 'AIRPORT',
      aliases: [],
      children: [{ entry: 'RUNWAY', aliases: [], children: [{ entry, aliases: [['LENGTH'], ['WIDTH']] }] }],
    };
    const probe = await spike.buildDefinition(spec);
    const entryRejected = probe.rejectedEntries.filter((r) => r.entry === entry);
    const fieldsRejected = probe.rejectedFields.filter((r) => r.entry === entry).map((r) => r.field);
    console.log(
      `RUNWAY>${entry.padEnd(30)}: ${entryRejected.length ? `REJECTED ${entryRejected[0]?.exception}` : 'ACCEPTED'}` +
        (entryRejected.length ? '' : ` rejectedFields=${fieldsRejected.join(',') || '<none>'}`),
    );
  }

  // Accepting an entry point is not the same as returning rows for it, so ask
  // one airport what a threshold child actually carries.
  const spec: NodeSpec = {
    entry: 'AIRPORT',
    aliases: [],
    children: [
      {
        entry: 'RUNWAY',
        aliases: [['PRIMARY_NUMBER'], ['PRIMARY_DESIGNATOR']],
        children: [
          { entry: 'PRIMARY_THRESHOLD', aliases: [['LENGTH'], ['WIDTH']] },
          { entry: 'SECONDARY_THRESHOLD', aliases: [['LENGTH'], ['WIDTH']] },
        ],
      },
    ],
  };
  const probe = await spike.buildDefinition(spec);
  const definitionId = await spike.buildAcceptedDefinition(spec, probe);
  const lines: string[] = [];
  const result = await spike.fetch(definitionId, 'PANC', undefined, undefined, 20_000, (recv) => {
    const size = recv.data.remaining();
    const raw = hexOf(recv.data);
    if (recv.type === FacilityDataType.RUNWAY) {
      const number = recv.data.readInt32();
      const designator = recv.data.readInt32();
      lines.push(`  runway    : ${runwayLabel(number, designator)} size=${size}`);
      return;
    }
    if (size < 8) {
      lines.push(`  ${FacilityDataType[recv.type] ?? recv.type}(${recv.type}) : empty record, size=${size}`);
      return;
    }
    const length = size >= 16 ? recv.data.readFloat64() : recv.data.readFloat32();
    const width = size >= 16 ? recv.data.readFloat64() : recv.data.readFloat32();
    lines.push(
      `  threshold : type=${FacilityDataType[recv.type] ?? recv.type}(${recv.type}) ` +
        `length=${length.toFixed(2)} width=${width.toFixed(2)} size=${size} raw=${raw}`,
    );
  });
  console.log(`PANC thresholds : messages=${result.messages} ms=${result.ms}${result.exceptions.length ? ` EXCEPTION ${result.exceptions.join(',')}` : ''}`);
  for (const line of lines) console.log(line);
}

async function commandAirport(spike: Spike, argv: string[]): Promise<number> {
  const airports = parseList(argv, 'airports', DEFAULT_AIRPORTS);
  if (hasFlag(argv, 'dump-runways')) return await commandDumpRunways(spike, airports);

  const navProbe = await spike.buildDefinition(navAirportSpec());
  const fullProbe = await spike.buildDefinition(fullAirportSpec());
  console.log(`nav rejected fields : ${navProbe.rejectedFields.map((r) => `${r.entry}.${r.field}`).join(' ') || '<none>'}`);
  console.log(`nav rejected entries: ${navProbe.rejectedEntries.map((r) => `${r.verb} ${r.entry}`).join(' ') || '<none>'}`);
  console.log(`full rejected entries: ${fullProbe.rejectedEntries.map((r) => `${r.verb} ${r.entry}`).join(' ') || '<none>'}`);

  const navDefinition = await spike.buildAcceptedDefinition(navAirportSpec(), navProbe);
  const fullDefinition = await spike.buildAcceptedDefinition(fullAirportSpec(), fullProbe);

  for (const icao of airports) {
    for (const [label, definitionId] of [
      ['nav  (no TAXI_*/JETWAY)', navDefinition],
      ['full (with ground)     ', fullDefinition],
    ] as const) {
      const result = await spike.fetch(definitionId, icao);
      console.log(
        `${icao.padEnd(6)} ${label}: messages=${String(result.messages).padStart(6)} bytes=${String(result.bytes).padStart(8)} ms=${String(result.ms).padStart(6)}` +
          (result.exceptions.length ? ` EXCEPTION ${result.exceptions.join(',')}` : ''),
      );
      console.log(`         ${' '.repeat(label.length)}  ${typeBreakdown(result.byType)}`);
    }
  }
  return 0;
}

/** Probes every entry point the design might want, one definition each. */
async function commandProbe(spike: Spike, argv: string[]): Promise<number> {
  const icao = parseList(argv, 'airports', ['EGLL'])[0] ?? 'EGLL';

  const cases: { label: string; spec: NodeSpec; icao: string; region?: string; type?: 'V' | 'N' | 'W' }[] = [
    { label: 'AIRPORT', spec: { entry: 'AIRPORT', aliases: AIRPORT_HEADER }, icao },
    { label: 'AIRPORT>RUNWAY', spec: { entry: 'AIRPORT', aliases: [], children: [RUNWAY_NODE] }, icao },
    { label: 'AIRPORT>APPROACH>APPROACH_TRANSITION>APPROACH_LEG', spec: { entry: 'AIRPORT', aliases: [], children: [APPROACH_NODE] }, icao },
    {
      label: 'AIRPORT>APPROACH>FINAL_APPROACH_LEG',
      spec: {
        entry: 'AIRPORT',
        aliases: [],
        children: [{ entry: 'APPROACH', aliases: APPROACH_HEADER, children: [{ entry: 'FINAL_APPROACH_LEG', aliases: LEG_ALIASES }] }],
      },
      icao,
    },
    {
      label: 'AIRPORT>APPROACH>MISSED_APPROACH_LEG',
      spec: {
        entry: 'AIRPORT',
        aliases: [],
        children: [{ entry: 'APPROACH', aliases: APPROACH_HEADER, children: [{ entry: 'MISSED_APPROACH_LEG', aliases: LEG_ALIASES }] }],
      },
      icao,
    },
    {
      label: 'AIRPORT>DEPARTURE>RUNWAY_TRANSITION>APPROACH_LEG',
      spec: { entry: 'AIRPORT', aliases: [], children: [{ entry: 'DEPARTURE', aliases: PROCEDURE_HEADER, children: DEPARTURE_ARRIVAL_CHILDREN }] },
      icao,
    },
    {
      label: 'AIRPORT>ARRIVAL>ENROUTE_TRANSITION>APPROACH_LEG',
      spec: { entry: 'AIRPORT', aliases: [], children: [{ entry: 'ARRIVAL', aliases: PROCEDURE_HEADER, children: DEPARTURE_ARRIVAL_CHILDREN }] },
      icao,
    },
  ];

  for (const testCase of cases) {
    const probe = await spike.buildDefinition(testCase.spec);
    const rejected = [
      ...probe.rejectedEntries.map((r) => `${r.verb} ${r.entry}: ${r.exception}`),
      ...probe.rejectedFields.map((r) => `${r.entry}.${r.field}: ${r.exception}`),
    ];
    let fetched = 'not attempted';
    if (!probe.rejectedEntries.length) {
      const definitionId = await spike.buildAcceptedDefinition(testCase.spec, probe);
      const result = await spike.fetch(definitionId, testCase.icao, testCase.region, testCase.type, 45_000);
      fetched = result.exceptions.length
        ? `EXCEPTION ${result.exceptions.join(',')}`
        : `messages=${result.messages} ms=${result.ms} ${typeBreakdown(result.byType)}`;
    }
    console.log(`${testCase.label}`);
    console.log(`   open/close : ${probe.rejectedEntries.length ? 'REJECTED' : 'accepted'}`);
    console.log(`   request    : ${fetched}`);
    if (rejected.length) {
      for (const line of rejected.slice(0, 8)) console.log(`   rejected   : ${line}`);
      if (rejected.length > 8) console.log(`   rejected   : … ${rejected.length - 8} more`);
    }
  }
  return 0;
}

/** Enroute fixes are five plain letters; anything else is a terminal fix. */
const ENROUTE_IDENT = /^[A-Z]{5}$/;

/** Position and airway count only, in an order that is safe to read back. */
const WAYPOINT_CENSUS: string[][] = [['LATITUDE'], ['LONGITUDE'], ['N_ROUTES']];

async function commandRoutes(spike: Spike, argv: string[]): Promise<number> {
  const count = Number(flagValue(argv, 'count') ?? '50');
  const concurrency = Number(flagValue(argv, 'concurrency') ?? '1');
  const listed = await runList(spike, FacilityListType.WAYPOINT, false);
  const seen = new Set<string>();
  const enroute: ListRow[] = [];
  const terminal: ListRow[] = [];
  for (const row of listed.rows) {
    if (seen.has(row.icao)) continue;
    seen.add(row.icao);
    (ENROUTE_IDENT.test(row.icao) ? enroute : terminal).push(row);
  }
  console.log(
    `waypoints   : listed=${listed.rows.length} in ${listed.ms}ms distinct=${seen.size} ` +
      `enroute=${enroute.length} terminal=${terminal.length}`,
  );
  const picked = [...enroute, ...terminal].slice(0, count);

  const probe = await spike.buildDefinition(WAYPOINT_SPEC);
  console.log(`rejected    : ${probe.rejectedFields.map((r) => `${r.entry}.${r.field}`).join(' ') || '<none>'}`);
  const definitionId = await spike.buildAcceptedDefinition(WAYPOINT_SPEC, probe);

  let totalMessages = 0;
  let totalBytes = 0;
  let totalRoutes = 0;
  let failures = 0;
  const perRequest: number[] = [];
  const wall = Date.now();

  const queue = [...picked];
  const worker = async (): Promise<void> => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const result = await spike.fetch(definitionId, row.icao, row.region, 'W', 15_000);
      if (result.exceptions.length) {
        failures++;
        continue;
      }
      totalMessages += result.messages;
      totalBytes += result.bytes;
      totalRoutes += result.byType.get(FacilityDataType.ROUTE) ?? 0;
      perRequest.push(result.ms);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const wallMs = Date.now() - wall;
  perRequest.sort((a, b) => a - b);
  const median = perRequest.length ? perRequest[Math.floor(perRequest.length / 2)] : 0;
  console.log(
    `routes      : requested=${picked.length} ok=${perRequest.length} failed=${failures} ` +
      `concurrency=${concurrency} wallMs=${wallMs} perRequestMs=${(wallMs / Math.max(1, picked.length)).toFixed(1)} ` +
      `latencyMedianMs=${median} latencyMaxMs=${perRequest[perRequest.length - 1] ?? 0}`,
  );
  console.log(
    `            messages=${totalMessages} routeChildren=${totalRoutes} bytes=${totalBytes} ` +
      `routesPerWaypoint=${(totalRoutes / Math.max(1, perRequest.length)).toFixed(1)} ` +
      `bytesPerWaypoint=${(totalBytes / Math.max(1, perRequest.length)).toFixed(0)}`,
  );

  // The simulator's own N_ROUTES, so a low ROUTE-child count can be told apart
  // from a request that silently returned nothing.
  const censusSpec: NodeSpec = { entry: 'WAYPOINT', aliases: WAYPOINT_CENSUS };
  const censusProbe = await spike.buildDefinition(censusSpec);
  const censusDefinition = await spike.buildAcceptedDefinition(censusSpec, censusProbe);
  const histogram = new Map<number, number>();
  const censusQueue = [...picked];
  const censusWorker = async (): Promise<void> => {
    for (;;) {
      const row = censusQueue.shift();
      if (!row) return;
      await spike.fetch(censusDefinition, row.icao, row.region, 'W', 15_000, (recv) => {
        if (recv.type !== FacilityDataType.WAYPOINT || recv.data.remaining() < 20) return;
        recv.data.readFloat64();
        recv.data.readFloat64();
        const routes = recv.data.readInt32();
        histogram.set(routes, (histogram.get(routes) ?? 0) + 1);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, censusWorker));
  console.log(
    `n_routes    : ${[...histogram.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([routes, waypoints]) => `${routes}:${waypoints}`)
      .join(' ')}`,
  );
  return 0;
}

/** Asks whether region is needed, and what a duplicate ident does. */
async function commandRegion(spike: Spike, argv: string[]): Promise<number> {
  const listed = await runList(spike, FacilityListType.VOR, false);
  const byIdent = new Map<string, ListRow[]>();
  for (const row of listed.rows) byIdent.set(row.icao, [...(byIdent.get(row.icao) ?? []), row]);
  const duplicates = [...byIdent.entries()].filter(([, rows]) => rows.length > 1);
  console.log(`vors        : rows=${listed.rows.length} distinctIdents=${byIdent.size} duplicateIdents=${duplicates.length}`);
  if (duplicates.length) {
    console.log(`duplicates  : ${duplicates.slice(0, 10).map(([ident, rows]) => `${ident}x${rows.length}`).join(' ')}`);
  }

  const probe = await spike.buildDefinition({ entry: 'VOR', aliases: VOR_ALIASES });
  console.log(`vor rejected: ${probe.rejectedFields.map((r) => r.field).join(' ') || '<none>'}`);
  const definitionId = await spike.buildAcceptedDefinition({ entry: 'VOR', aliases: VOR_ALIASES }, probe);

  const ndbProbe = await spike.buildDefinition({ entry: 'NDB', aliases: NDB_ALIASES });
  console.log(`ndb rejected: ${ndbProbe.rejectedFields.map((r) => r.field).join(' ') || '<none>'}`);

  const identArg = flagValue(argv, 'ident');
  const target = identArg
    ? byIdent.get(identArg.toUpperCase())?.[0] ?? { icao: identArg.toUpperCase(), region: '', lat: 0, lon: 0 }
    : listed.rows[0];
  if (!target) {
    console.log('region      : no VOR in range to test with');
    return 0;
  }

  for (const [label, region] of [
    ['with region   ', target.region],
    ['without region', undefined],
  ] as const) {
    const result = await spike.fetch(definitionId, target.icao, region, 'V', 10_000);
    console.log(
      `${target.icao} ${label}: messages=${result.messages} bytes=${result.bytes} ms=${result.ms} minimal=${result.minimalList?.join(' ') ?? '-'}` +
        (result.exceptions.length ? ` EXCEPTION ${result.exceptions.join(',')}` : ''),
    );
  }

  // Idents given on the command line are looked up with no region at all, which
  // is the only way to ask the simulator "where in the world is this one?".
  const idents = flagValue(argv, 'idents');
  if (idents) {
    const rawType = (flagValue(argv, 'type') ?? 'V').toUpperCase();
    const icaoType = rawType === 'N' ? 'N' : rawType === 'W' ? 'W' : 'V';
    const specs: Record<string, NodeSpec> = {
      V: { entry: 'VOR', aliases: VOR_ALIASES },
      N: { entry: 'NDB', aliases: NDB_ALIASES },
      W: WAYPOINT_SPEC,
    };
    const spec = specs[icaoType];
    const lookupProbe = await spike.buildDefinition(spec);
    const lookupDefinition = await spike.buildAcceptedDefinition(spec, lookupProbe);
    for (const ident of parseList(argv, 'idents', [])) {
      const result = await spike.fetch(lookupDefinition, ident, undefined, icaoType, 8_000);
      console.log(
        `${ident.padEnd(6)} ${icaoType} : messages=${result.messages} ms=${result.ms} ` +
          `minimal=${result.minimalList?.join(' ') ?? '-'}`,
      );
    }
  }

  const ambiguous = duplicates[0];
  if (ambiguous) {
    const result = await spike.fetch(definitionId, ambiguous[0], undefined, 'V', 10_000);
    console.log(
      `${ambiguous[0]} duplicate ident: messages=${result.messages} minimal=${result.minimalList?.join(' ') ?? '-'} ms=${result.ms}` +
        (result.exceptions.length ? ` EXCEPTION ${result.exceptions.join(',')}` : ''),
    );
  }
  return 0;
}

// ── entry point ───────────────────────────────────────────────────────────────

export async function runInspector(argv: string[]): Promise<number> {
  const command = argv.find((a) => !a.startsWith('-')) ?? 'probe';
  const sim = parseSim(argv);
  const waitMs = Number(flagValue(argv, 'wait') ?? '180000');

  console.log(`command     : ${command}`);
  const handle = await connect(sim, waitMs);
  const spike = new Spike(handle);
  try {
    switch (command) {
      case 'list':
        return await commandList(spike, argv);
      case 'census':
        return await commandCensus(spike, argv);
      case 'airport':
        return await commandAirport(spike, argv);
      case 'probe':
        return await commandProbe(spike, argv);
      case 'routes':
        return await commandRoutes(spike, argv);
      case 'region':
        return await commandRegion(spike, argv);
      default:
        console.error(`unknown command ${command}`);
        return 2;
    }
  } finally {
    handle.close();
  }
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runInspector(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`inspector failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
