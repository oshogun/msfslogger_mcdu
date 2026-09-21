// tests/navdata-service.test.ts — tests src/navdata-service.ts, the service that
// owns the navdata store and the facility session, against a fake SimConnect
// handle and a real store in a temp directory.
//
// The simulator is not running and is not needed. What these tests pin down is
// the wiring the rest of navdata hangs off:
//
// 1. The configured simulator reaches the store the first time it is created.
//    A store that recorded a default would claim its rows came from a simulator
//    nobody chose.
// 2. Navdata fails alone. A driver that will not load, a store whose write
//    throws and a callback that throws are all reported on the status axis, and
//    none of them escapes into the process — an exception here reaches the
//    supervisor, and the supervisor answers a dying sidecar by taking flight
//    logging down with it.
// 3. A pass runs once per connection episode and is throttled after that, while
//    a pass interrupted by a disconnect leaves the store usable and is redone.
// 4. The axis text is safe to show: one line, no token, no path to the config.
//
// Every database is under a fresh mkdtemp directory, every ident is synthetic,
// and the only token that appears anywhere is a sentinel that must not turn up
// in a log line or on the axis.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { SimConnectConnection } from 'node-simconnect';

import type { NavdataDemandDeps, NavdataDemandLike } from '../src/navdata-demand';
import { FacilitySession, type FacilityConnection } from '../src/navdata-facilities';
import { listParseIsSafe, NavdataService, type NavdataServiceDeps } from '../src/navdata-service';
import {
  navdataDatabasePath,
  navdataDirectory,
  openNavdataStore,
  type NavdataMeta,
  type NavdataStore,
} from '../src/navdata-store';
import type { NavdataStatusAxis } from '../src/protocol';
import { FakeFacilityConnection, airportRow } from './helpers/fake-facility-connection';

const SENTINEL_TOKEN = 'SENTINEL-NAVDATA-SERVICE-TOKEN-0001';

const temporary: string[] = [];
const services: NavdataService[] = [];
const opened: NavdataStore[] = [];
let logged: string[] = [];
let changes = 0;

afterEach(() => {
  while (services.length > 0) services.pop()?.shutdown();
  while (opened.length > 0) opened.pop()?.close();
  while (temporary.length > 0) {
    fs.rmSync(temporary.pop() as string, { recursive: true, force: true });
  }
  logged = [];
  changes = 0;
});

/** A config directory with a sentinel token in it, the way a real one looks. */
function scratchConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navdata-service-'));
  temporary.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ serverUrl: 'http://127.0.0.1:1', ingestToken: SENTINEL_TOKEN }, null, 2),
  );
  return configPath;
}

function newService(
  configPath: string,
  overrides: Partial<NavdataServiceDeps> = {},
): NavdataService {
  const service = new NavdataService({
    configPath: () => configPath,
    simId: () => '2024',
    protocols: () => ({ ours: 'KittyHawk', sim: 'KittyHawk' }),
    log: (level, message) => {
      logged.push(`${level} ${message}`);
    },
    onChange: () => {
      changes++;
    },
    ...overrides,
  });
  services.push(service);
  return service;
}

const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Waits for a pass to leave the axis, bounded so a hang fails rather than spins. */
async function settled(service: NavdataService): Promise<NavdataStatusAxis | null> {
  for (let i = 0; i < 100 && service.snapshot()?.state === 'nav.bulk'; i++) await tick();
  return service.snapshot();
}

/** Answers whatever list the handle was last asked for, the way the simulator does. */
async function answerList(
  service: NavdataService,
  handle: FakeFacilityConnection,
  chunks: readonly (readonly ReturnType<typeof airportRow>[])[],
  options: { dropAfter?: number } = {},
): Promise<void> {
  await tick();
  const requestId = handle.lastListRequestId();
  if (requestId === null) return;
  for (let i = 0; i < chunks.length; i++) {
    if (options.dropAfter !== undefined && i >= options.dropAfter) {
      service.onSimDisconnected();
      break;
    }
    handle.emitAirportChunk(requestId, chunks[i], i, chunks.length);
    await tick();
  }
}

/** Connects a fake handle to the service and answers the list it asks for. */
async function connect(
  service: NavdataService,
  handle: FakeFacilityConnection,
  chunks: readonly (readonly ReturnType<typeof airportRow>[])[],
  options: { dropAfter?: number } = {},
): Promise<void> {
  service.onSimConnected(handle as unknown as SimConnectConnection);
  await answerList(service, handle, chunks, options);
}

const sessionFactory = (): NavdataServiceDeps['createSession'] => (handle) =>
  new FacilitySession(handle as unknown as FacilityConnection, {
    log: (level, message) => {
      logged.push(`${level} ${message}`);
    },
  });

const WORLD = [
  [airportRow('AAAA', 10.5, 20.25, 100)],
  [airportRow('BBBB', -12.34, 23.4, 55)],
  [airportRow('CCCC', -21.37, 121.345, 212)],
];

/** A store that answers everything and throws on every write. */
function throwingStore(dbPath: string, message: string): NavdataStore {
  const meta: NavdataMeta = {
    schemaVersion: 1,
    snapshotId: 'S-TEST',
    rev: 7,
    simId: '2024',
    simAppName: null,
    simAppVersion: null,
    bulkStartedAt: null,
    bulkCompletedAt: null,
    bulkRowCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    path: dbPath,
    meta: () => meta,
    row: () => null,
    count: () => 0,
    write: () => {
      throw new Error(message);
    },
    checkpoint: () => undefined,
    close: () => undefined,
  };
}

describe('the store the service opens', () => {
  it('writes the configured simulator into a store it creates', () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, { simId: () => '2024' });
    service.start();
    service.shutdown();

    // Re-opened as the same simulator the service was configured for: the file
    // is accepted as it stands and says '2024'. Had the service opened it with
    // the store's own default the stored id would have been '2020', and this
    // open would have moved that file aside instead of using it.
    const store = openNavdataStore(navdataDatabasePath(configPath), { simId: '2024' });
    expect(store).not.toBeNull();
    opened.push(store as NavdataStore);
    expect((store as NavdataStore).meta().simId).toBe('2024');
    const beside = fs
      .readdirSync(navdataDirectory(configPath))
      .filter((name) => name.startsWith('navdata.db.'));
    expect(beside).toEqual([]);
  });

  it('opens nothing while there is no valid config, and no directory appears', () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, { simId: () => null });
    service.start();
    expect(service.snapshot()).toBeNull();
    expect(fs.existsSync(navdataDirectory(configPath))).toBe(false);
  });

  it('resets a detail fetch an earlier run left in flight, and says how many', () => {
    const configPath = scratchConfigPath();
    const dbPath = navdataDatabasePath(configPath);
    const earlier = openNavdataStore(dbPath, { simId: '2024' });
    expect(earlier).not.toBeNull();
    (earlier as NavdataStore).write((tx) => {
      tx.upsert('nav_airport', { ident: 'ZPND', lat: 1, lon: 2, detail_state: 'pending' });
      tx.upsert('nav_airport', { ident: 'ZDET', lat: 3, lon: 4, detail_state: 'detail' });
    });
    // The process that made the request is gone; the row still says it is out.
    (earlier as NavdataStore).close();

    const service = newService(configPath);
    service.start();

    const store = openNavdataStore(dbPath, { simId: '2024' });
    expect(store).not.toBeNull();
    opened.push(store as NavdataStore);
    expect((store as NavdataStore).row('nav_airport', { ident: 'ZPND' })?.detail_state).toBe('index');
    expect((store as NavdataStore).row('nav_airport', { ident: 'ZDET' })?.detail_state).toBe('detail');
    expect(logged.filter((line) => line.includes('reset 1 detail fetch'))).toHaveLength(1);
  });

  it('reports nav.off while the uplink is stopped and nav.ready while it runs', () => {
    const service = newService(scratchConfigPath());
    expect(service.snapshot()).toBeNull();
    service.start();
    expect(service.snapshot()?.state).toBe('nav.ready');
    service.stop();
    expect(service.snapshot()?.state).toBe('nav.off');
    expect(changes).toBeGreaterThan(0);
  });

  it('rebuilds the store when the configured simulator changes, keeping the old file', () => {
    const configPath = scratchConfigPath();
    let simId: '2020' | '2024' = '2020';
    const service = newService(configPath, { simId: () => simId });
    service.start();

    const store = openNavdataStore(navdataDatabasePath(configPath), { simId: '2020' });
    expect(store).not.toBeNull();
    (store as NavdataStore).write((tx) => tx.upsert('nav_airport', { ident: 'ZZZA', lat: 1, lon: 2 }));
    (store as NavdataStore).close();

    simId = '2024';
    service.onConfigApplied();

    // The rows came from a different simulator, so they are set aside rather
    // than relabelled, and the file they are in is still there.
    expect(service.snapshot()).toMatchObject({ state: 'nav.ready', airports: 0 });
    const aside = fs
      .readdirSync(navdataDirectory(configPath))
      .filter((name) => /^navdata\.db\.sim2020-\d+$/.test(name));
    expect(aside).toHaveLength(1);

    const moved = openNavdataStore(path.join(navdataDirectory(configPath), aside[0]), {
      simId: '2020',
    });
    expect(moved).not.toBeNull();
    opened.push(moved as NavdataStore);
    expect((moved as NavdataStore).count('nav_airport')).toBe(1);
  });

  it('moves to the store beside a config that moved, and keeps the old one', () => {
    const first = scratchConfigPath();
    const second = scratchConfigPath();
    let configPath = first;
    const service = newService(first, { configPath: () => configPath });
    service.start();
    expect(fs.existsSync(navdataDatabasePath(first))).toBe(true);

    configPath = second;
    service.onConfigApplied();
    expect(fs.existsSync(navdataDatabasePath(second))).toBe(true);
    expect(fs.existsSync(navdataDatabasePath(first))).toBe(true);
    expect(service.snapshot()?.state).toBe('nav.ready');
  });
});

describe('a store that will not open', () => {
  const failing = (): NavdataServiceDeps['openStore'] => (dbPath, options) =>
    openNavdataStore(dbPath, {
      ...options,
      loadDriver: () => ({
        ok: false,
        failure: {
          code: 'ERR_DLOPEN_FAILED',
          reason: 'navdata disabled: the SQLite driver did not load (ERR_DLOPEN_FAILED)',
        },
      }),
    });

  it('reports nav.unavailable with a reason, warns once, and never starts a session', async () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, { openStore: failing(), createSession: sessionFactory() });
    service.start();

    expect(service.snapshot()).toEqual({
      state: 'nav.unavailable',
      reason: 'navdata disabled: the SQLite driver did not load (ERR_DLOPEN_FAILED)',
      snapshotId: null,
      rev: null,
      ackedRev: null,
      airports: 0,
      navaids: 0,
      waypoints: 0,
      pendingDemand: 0,
      lastSyncAt: null,
      lastSyncError: null,
    });

    // Every entry point is still callable and still does nothing.
    const handle = new FakeFacilityConnection();
    await connect(service, handle, WORLD);
    service.onSimDisconnected();
    service.onConfigApplied();
    service.stop();
    expect(handle.listRequests).toHaveLength(0);
    expect(handle.listenerCount('airportList')).toBe(0);
    expect(service.snapshot()?.state).toBe('nav.unavailable');

    const warnings = logged.filter((line) => line.startsWith('warn '));
    expect(warnings).toHaveLength(1);
    expect(logged.join('\n')).not.toContain(SENTINEL_TOKEN);
    expect(logged.join('\n')).not.toContain('config.json');
  });

  it('keeps the axis clear of the token and of the config path when the directory is unusable', () => {
    const configPath = scratchConfigPath();
    fs.writeFileSync(path.join(path.dirname(configPath), 'wall'), 'not a directory');
    const blocked = path.join(path.dirname(configPath), 'wall', 'config.json');
    const service = newService(blocked, { configPath: () => blocked });
    service.start();

    const axis = service.snapshot();
    expect(axis?.state).toBe('nav.unavailable');
    expect(axis?.reason).toContain('navdata disabled');
    expect(axis?.reason).not.toContain(SENTINEL_TOKEN);
    expect(axis?.reason).not.toContain('config.json');
    expect(axis?.reason?.split('\n')).toHaveLength(1);
  });
});

describe('the bulk pass on a connection', () => {
  it('runs once on connect and writes the simulator\'s airports', async () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, { createSession: sessionFactory() });
    service.start();
    const handle = new FakeFacilityConnection();
    await connect(service, handle, WORLD);

    const axis = await settled(service);
    expect(axis?.state).toBe('nav.ready');
    expect(axis?.airports).toBe(3);
    expect(axis?.reason).toBeNull();
    expect(axis?.rev).toBeGreaterThan(0);
    expect(handle.listRequests).toHaveLength(1);
  });

  it('does not run a second pass on a reconnect within the throttle', async () => {
    const service = newService(scratchConfigPath(), { createSession: sessionFactory() });
    service.start();
    const first = new FakeFacilityConnection();
    await connect(service, first, WORLD);
    await settled(service);

    service.onSimDisconnected();
    const second = new FakeFacilityConnection();
    await connect(service, second, WORLD);
    await settled(service);

    expect(second.listRequests).toHaveLength(0);
    expect(service.snapshot()?.state).toBe('nav.ready');
    expect(service.snapshot()?.airports).toBe(3);
  });

  it('survives a disconnect mid-pass, keeps the store, and redoes the pass next time', async () => {
    const service = newService(scratchConfigPath(), { createSession: sessionFactory() });
    service.start();
    const first = new FakeFacilityConnection();
    await connect(service, first, WORLD, { dropAfter: 1 });
    const interrupted = await settled(service);

    // A disconnect is evidence about the link and about nothing else: nothing
    // is latched, the pass is simply unfinished. Rows short of a full write
    // chunk were still buffered, so the store is left as it was.
    expect(interrupted?.state).toBe('nav.ready');
    expect(interrupted?.reason).toBeNull();
    expect(interrupted?.airports).toBe(0);
    expect(first.listenerCount('airportList')).toBe(0);

    const second = new FakeFacilityConnection();
    await connect(service, second, WORLD);
    const done = await settled(service);
    expect(second.listRequests).toHaveLength(1);
    expect(done?.airports).toBe(3);
  });

  it('reports a store whose write throws as nav.error instead of throwing', async () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, {
      createSession: sessionFactory(),
      openStore: (dbPath) => throwingStore(dbPath, 'disk I/O error'),
    });
    service.start();
    const handle = new FakeFacilityConnection();
    await expect(connect(service, handle, WORLD)).resolves.toBeUndefined();

    const axis = await settled(service);
    expect(axis?.state).toBe('nav.error');
    expect(axis?.reason).toContain('disk I/O error');
    expect(logged.join('\n')).not.toContain(SENTINEL_TOKEN);
  });

  it('survives a session that cannot be built at all', () => {
    const service = newService(scratchConfigPath(), {
      createSession: () => {
        throw new Error('no session today');
      },
    });
    service.start();
    expect(() =>
      service.onSimConnected(new FakeFacilityConnection() as unknown as SimConnectConnection),
    ).not.toThrow();
    expect(service.snapshot()?.state).toBe('nav.error');
    expect(service.snapshot()?.reason).toContain('no session today');
  });

  it('keeps its counts on the last axis it publishes at shutdown', async () => {
    const service = newService(scratchConfigPath(), { createSession: sessionFactory() });
    service.start();
    const handle = new FakeFacilityConnection();
    await connect(service, handle, WORLD);
    await settled(service);

    service.shutdown();
    expect(service.snapshot()).toMatchObject({ state: 'nav.off', airports: 3 });
  });
});

describe('the simulator this client is configured for', () => {
  it.each([
    ['KittyHawk', 'KittyHawk', true],
    ['SunRise', 'SunRise', true],
    ['SunRise', 'KittyHawk', false],
    ['KittyHawk', 'SunRise', false],
    ['KittyHawk', null, false],
  ] as const)('opened as %s, answered by %s -> safe=%s', (ours, sim, safe) => {
    expect(listParseIsSafe(ours, sim)).toBe(safe);
  });

  it('asks for no list at all when the two disagree, and says so once', async () => {
    const service = newService(scratchConfigPath(), {
      createSession: sessionFactory(),
      protocols: () => ({ ours: 'SunRise', sim: 'KittyHawk' }),
    });
    service.start();
    const handle = new FakeFacilityConnection();
    await connect(service, handle, WORLD);

    // Not one request goes out: the parser that would read the answer is the
    // one sized by the protocol this connection opened with.
    expect(handle.listRequests).toHaveLength(0);
    expect(handle.listenerCount('airportList')).toBe(0);

    const axis = service.snapshot();
    expect(axis?.state).toBe('nav.error');
    expect(axis?.reason).toContain('SunRise');
    expect(axis?.reason).toContain('KittyHawk');
    expect(axis?.reason?.split('\n')).toHaveLength(1);
    expect(axis?.reason).not.toContain(SENTINEL_TOKEN);

    // A reconnect says nothing new: the same warning once, not once a minute.
    service.onSimDisconnected();
    await connect(service, new FakeFacilityConnection(), WORLD);
    expect(logged.filter((line) => line.startsWith('warn '))).toHaveLength(1);
  });

  it('runs the pass as soon as the two agree again', async () => {
    let sim: string | null = 'SunRise';
    const service = newService(scratchConfigPath(), {
      createSession: sessionFactory(),
      protocols: () => ({ ours: 'KittyHawk', sim }),
    });
    service.start();
    await connect(service, new FakeFacilityConnection(), WORLD);
    expect(service.snapshot()?.state).toBe('nav.error');

    sim = 'KittyHawk';
    service.onSimDisconnected();
    const handle = new FakeFacilityConnection();
    await connect(service, handle, WORLD);
    const axis = await settled(service);
    expect(handle.listRequests).toHaveLength(1);
    expect(axis?.state).toBe('nav.ready');
    expect(axis?.airports).toBe(3);
    expect(axis?.reason).toBeNull();
  });
});

describe('the simulator recorded on the store', () => {
  /** The store as a later export sees it: the service's own is closed first. */
  function reopen(configPath: string): NavdataMeta {
    const store = openNavdataStore(navdataDatabasePath(configPath), { simId: '2024' });
    expect(store).not.toBeNull();
    opened.push(store as NavdataStore);
    return (store as NavdataStore).meta();
  }

  it('keeps what the simulator answered, for a snapshot taken long after', async () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, {
      createSession: sessionFactory(),
      protocols: () => ({ ours: 'KittyHawk', sim: 'KittyHawk', simVersion: '11.0' }),
    });
    service.start();
    await connect(service, new FakeFacilityConnection(), WORLD);
    await settled(service);
    service.shutdown();

    const meta = reopen(configPath);
    expect(meta.simAppName).toBe('KittyHawk');
    expect(meta.simAppVersion).toBe('11.0');
  });

  it('names no simulator while none has connected', () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath);
    service.start();
    service.shutdown();

    const meta = reopen(configPath);
    expect(meta.simAppName).toBeNull();
    expect(meta.simAppVersion).toBeNull();
  });

  it('names none either when the connection is one it cannot read a list from', async () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, {
      createSession: sessionFactory(),
      protocols: () => ({ ours: 'SunRise', sim: 'KittyHawk', simVersion: '11.0' }),
    });
    service.start();
    await connect(service, new FakeFacilityConnection(), WORLD);
    service.shutdown();

    // The simulator running is not the simulator these rows came from, and the
    // header says where the rows came from.
    const meta = reopen(configPath);
    expect(meta.simAppName).toBeNull();
    expect(meta.simAppVersion).toBeNull();
  });

  it('follows the simulator to a new build', async () => {
    const configPath = scratchConfigPath();
    let version = '11.0';
    const service = newService(configPath, {
      createSession: sessionFactory(),
      protocols: () => ({ ours: 'KittyHawk', sim: 'KittyHawk', simVersion: version }),
    });
    service.start();
    await connect(service, new FakeFacilityConnection(), WORLD);
    await settled(service);

    version = '11.1';
    service.onSimDisconnected();
    await connect(service, new FakeFacilityConnection(), WORLD);
    await settled(service);
    service.shutdown();

    expect(reopen(configPath).simAppVersion).toBe('11.1');
  });

  it('carries on when the identity cannot be written', () => {
    const configPath = scratchConfigPath();
    const dbPath = navdataDatabasePath(configPath);
    const service = newService(configPath, {
      createSession: sessionFactory(),
      openStore: () => throwingStore(dbPath, 'the store is read-only'),
    });
    service.start();
    service.onSimConnected(new FakeFacilityConnection() as unknown as SimConnectConnection);

    // A write that throws is one unnamed simulator, not a pass that did not run
    // and not an axis in error.
    expect(service.snapshot()?.state).not.toBe('nav.error');
    expect(logged.some((line) => line.includes("the simulator's identity was not recorded"))).toBe(
      true,
    );
  });
});

describe('a simulator switched while the connection is up', () => {
  it('rebuilds the store and runs the pass again, without waiting for a reconnect', async () => {
    const configPath = scratchConfigPath();
    let simId: '2020' | '2024' = '2020';
    const service = newService(configPath, {
      simId: () => simId,
      createSession: sessionFactory(),
    });
    service.start();
    const first = new FakeFacilityConnection();
    await connect(service, first, WORLD);
    expect((await settled(service))?.airports).toBe(3);

    simId = '2024';
    service.onConfigApplied();
    await answerList(service, first, WORLD);
    const axis = await settled(service);

    // The new store is a different simulator's, so it is empty — and it does
    // not stay empty behind a ready axis until something reconnects.
    expect(axis?.state).toBe('nav.ready');
    expect(axis?.airports).toBe(3);
    expect(first.listRequests).toHaveLength(2);
  });
});

describe('a log sink that throws', () => {
  it('escapes no entry point, from open to shutdown', async () => {
    const configPath = scratchConfigPath();
    const service = newService(configPath, {
      createSession: sessionFactory(),
      log: () => {
        throw new Error('the log sink is broken');
      },
    });
    const handle = new FakeFacilityConnection();

    expect(() => service.start()).not.toThrow();
    await expect(connect(service, handle, WORLD)).resolves.toBeUndefined();
    await settled(service);
    expect(() => service.onConfigApplied()).not.toThrow();
    expect(() => service.onSimDisconnected()).not.toThrow();
    expect(() => service.stop()).not.toThrow();
    expect(() => service.shutdown()).not.toThrow();

    // And the work still happened: the pass wrote its rows.
    const store = openNavdataStore(navdataDatabasePath(configPath), { simId: '2024' });
    opened.push(store as NavdataStore);
    expect((store as NavdataStore).count('nav_airport')).toBe(3);
  });
});

describe('the demand queue', () => {
  interface FakeDemand extends NavdataDemandLike {
    calls: string[];
    deps: NavdataDemandDeps | null;
    count: number;
    text: string | null;
  }

  function fakeDemand(overrides: Partial<NavdataDemandLike> = {}): FakeDemand {
    const demand: FakeDemand = {
      calls: [],
      deps: null,
      count: 0,
      text: null,
      start: () => demand.calls.push('start'),
      stop: () => demand.calls.push('stop'),
      shutdown: () => demand.calls.push('shutdown'),
      onConfigApplied: () => demand.calls.push('onConfigApplied'),
      wake: () => demand.calls.push('wake'),
      pending: () => demand.count,
      note: () => demand.text,
      ...overrides,
    };
    return demand;
  }

  function withDemand(demand: FakeDemand): Pick<NavdataServiceDeps, 'createDemand'> {
    return {
      createDemand: (deps) => {
        demand.deps = deps;
        return demand;
      },
    };
  }

  it('is driven through the lifecycle with the uplink', () => {
    const demand = fakeDemand();
    const service = newService(scratchConfigPath(), withDemand(demand));
    service.start();
    service.onConfigApplied();
    service.stop();
    service.shutdown();
    services.pop();
    expect(demand.calls).toEqual(['start', 'onConfigApplied', 'stop', 'shutdown']);
  });

  it('shows what is pending, and the collision note while nothing is wrong', () => {
    const demand = fakeDemand();
    const service = newService(scratchConfigPath(), withDemand(demand));
    service.start();
    expect(service.snapshot()).toMatchObject({ state: 'nav.ready', pendingDemand: 0, reason: null });

    demand.count = 4;
    demand.text = '2 procedure(s) at 1 airport(s) shared a key with another and were stored apart';
    demand.deps?.onChange();
    expect(service.snapshot()).toMatchObject({
      state: 'nav.ready',
      pendingDemand: 4,
      reason: '2 procedure(s) at 1 airport(s) shared a key with another and were stored apart',
    });
  });

  it('lets a real failure take the reason over from the note', () => {
    const demand = fakeDemand();
    demand.text = 'a note';
    const service = newService(scratchConfigPath(), {
      ...withDemand(demand),
      createSession: () => {
        throw new Error('no session today');
      },
    });
    service.start();
    service.onSimConnected(new FakeFacilityConnection() as unknown as SimConnectConnection);
    expect(service.snapshot()?.state).toBe('nav.error');
    expect(service.snapshot()?.reason).toContain('no session today');
  });

  it('survives a queue that throws from every entry point', async () => {
    const boom = (): never => {
      throw new Error('queue broke');
    };
    const demand = fakeDemand({ start: boom, stop: boom, shutdown: boom, onConfigApplied: boom, wake: boom, pending: boom, note: boom });
    const service = newService(scratchConfigPath(), { ...withDemand(demand), createSession: sessionFactory() });
    expect(() => service.start()).not.toThrow();
    expect(() => service.onConfigApplied()).not.toThrow();
    const handle = new FakeFacilityConnection();
    await connect(service, handle, WORLD);
    await settled(service);
    expect(service.snapshot()?.pendingDemand).toBe(0);
    expect(() => service.stop()).not.toThrow();
    expect(() => service.shutdown()).not.toThrow();
    services.pop();
  });

  it('gets the session only once the bulk pass has let go of it, and is woken then', async () => {
    const demand = fakeDemand();
    const service = newService(scratchConfigPath(), { ...withDemand(demand), createSession: sessionFactory() });
    service.start();
    expect(demand.deps?.session()).toBeNull();

    const handle = new FakeFacilityConnection();
    service.onSimConnected(handle as unknown as SimConnectConnection);
    // The pass has the connection to itself.
    expect(service.snapshot()?.state).toBe('nav.bulk');
    expect(demand.deps?.session()).toBeNull();
    expect(demand.calls).not.toContain('wake');

    await answerList(service, handle, WORLD);
    await settled(service);
    expect(demand.deps?.session()).toBeInstanceOf(FacilitySession);
    expect(demand.calls).toContain('wake');
    expect(demand.deps?.store()).not.toBeNull();

    service.onSimDisconnected();
    expect(demand.deps?.session()).toBeNull();
  });
});
