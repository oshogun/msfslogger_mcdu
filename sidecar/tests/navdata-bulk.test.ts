// tests/navdata-bulk.test.ts — tests src/navdata-bulk.ts, the bulk airport
// index, against a fake SimConnect handle and a real store in a temp directory.
//
// The simulator is not running and is not needed: what these tests pin down is
// what the pass writes, what it refuses to write, and what happens when it does
// not finish.
//
// 1. A list row is an INDEX entry and claims nothing more. It carries a
//    position and nothing else, so it may not demote an airport whose detail
//    was already fetched, may not erase a region it does not have, and may not
//    claim a position source without a position.
// 2. An interrupted pass leaves no completion stamp and is redone whole. There
//    is no cursor and there is not meant to be one.
// 3. A partial list is never evidence that the world lost an airport. Only a
//    list that ran to its own last chunk may decide the epoch.
// 4. Navdata fails alone. A store that will not open, and a store that throws
//    mid-write, both come back as a reported status rather than an exception —
//    because an exception here reaches the supervisor, and the supervisor
//    answers a dying sidecar by taking the whole client down.
//
// Every database is under a fresh mkdtemp directory, every ident is synthetic,
// and the only token that appears anywhere is a sentinel that must not turn up
// in a log line, a result or the database file.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { BulkAirportIndex, bulkAirportRow } from '../src/navdata-bulk';
import { FacilitySession } from '../src/navdata-facilities';
import {
  navdataDatabasePath,
  openNavdataStore,
  type NavdataStore,
  type NavdataUnavailable,
} from '../src/navdata-store';
import { FakeFacilityConnection, airportRow } from './helpers/fake-facility-connection';

const SENTINEL_TOKEN = 'SENTINEL-NAVDATA-TOKEN-0000';

const temporary: string[] = [];
const opened: NavdataStore[] = [];
const sessions: FacilitySession[] = [];
const logged: string[] = [];

afterEach(() => {
  while (sessions.length > 0) sessions.pop()?.close('test over');
  while (opened.length > 0) opened.pop()?.close();
  while (temporary.length > 0) {
    fs.rmSync(temporary.pop() as string, { recursive: true, force: true });
  }
  logged.length = 0;
});

const log = (level: string, message: string): void => {
  logged.push(`${level} ${message}`);
};

/** A config directory with a sentinel token in it, the way a real one looks. */
function scratchConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navdata-bulk-'));
  temporary.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ serverUrl: 'http://127.0.0.1:1', ingestToken: SENTINEL_TOKEN }, null, 2),
  );
  return dir;
}

function openStore(dir: string): NavdataStore {
  const store = openNavdataStore(navdataDatabasePath(path.join(dir, 'config.json')), {
    simId: '2024',
    log: log as never,
  });
  if (store === null) throw new Error('expected the store to open');
  opened.push(store);
  return store;
}

function newSession(handle: FakeFacilityConnection): FacilitySession {
  const session = new FacilitySession(handle, { log: log as never });
  sessions.push(session);
  return session;
}

const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

interface ListPlan {
  /** Rows per chunk as the simulator sends them. */
  readonly chunks: readonly (readonly ReturnType<typeof airportRow>[])[];
  /** Stop after this many chunks and drop the link instead of finishing. */
  readonly dropAfter?: number;
  /** outOf, when the simulator is to claim more chunks than it sends. */
  readonly claim?: number;
}

/** Runs one pass, feeding the list the way the simulator would. */
async function runPass(
  index: BulkAirportIndex,
  session: FacilitySession,
  handle: FakeFacilityConnection,
  store: NavdataStore | null,
  plan: ListPlan,
): Promise<Awaited<ReturnType<BulkAirportIndex['run']>>> {
  const running = index.run(session, store);
  await tick();
  const requestId = handle.lastListRequestId();
  if (requestId === null) return running;

  const outOf = plan.claim ?? plan.chunks.length;
  for (let i = 0; i < plan.chunks.length; i++) {
    if (plan.dropAfter !== undefined && i >= plan.dropAfter) {
      session.close('SimConnect disconnected');
      break;
    }
    handle.emitAirportChunk(requestId, plan.chunks[i], i, outOf);
    await tick();
  }
  return running;
}

const WORLD = [
  [airportRow('AAAA', 10.5, 20.25, 100)],
  [airportRow('BBBB', -12.34, 23.4, 55)],
  [airportRow('CCCC', -21.37, 121.345, 212)],
];

describe('what a list row becomes', () => {
  it('sends a position source only together with a position', () => {
    const withPosition = bulkAirportRow(airportRow('AAAA', 1, 2, 3), true);
    expect(withPosition).toEqual({
      ident: 'AAAA',
      lat: 1,
      lon: 2,
      alt_m: 3,
      position_source: 'list',
      detail_state: 'index',
    });

    const noPosition = bulkAirportRow(
      { icao: 'BBBB', region: '', latitude: Number.NaN, longitude: 2, altitude: 3 },
      true,
    );
    expect(noPosition).not.toHaveProperty('position_source');
    expect(noPosition).not.toHaveProperty('lat');
  });

  it('leaves an absent altitude out rather than calling it zero', () => {
    const row = bulkAirportRow(
      { icao: 'AAAA', region: '', latitude: 1, longitude: 2, altitude: Number.NaN },
      true,
    );
    expect(row).not.toHaveProperty('alt_m');
  });

  it('omits the empty region every airport list row carries', () => {
    expect(bulkAirportRow(airportRow('AAAA', 1, 2, 3, ''), true)).not.toHaveProperty('region');
    expect(bulkAirportRow(airportRow('AAAA', 1, 2, 3, 'EG'), true)).toHaveProperty('region', 'EG');
  });

  it('claims an index state only for a row that did not exist', () => {
    expect(bulkAirportRow(airportRow('AAAA', 1, 2, 3), false)).not.toHaveProperty('detail_state');
  });

  it('refuses a row with no ident', () => {
    expect(bulkAirportRow(airportRow('   ', 1, 2, 3), true)).toBeNull();
  });
});

describe('a completed pass', () => {
  it('writes every listed airport as an index row and stamps the completion', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2 });

    const result = await runPass(index, session, handle, store, { chunks: WORLD });

    expect(result.status).toBe('completed');
    expect(result.rows).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.written).toBe(3);
    expect(result.epochMinted).toBeNull();

    expect(store.count('nav_airport')).toBe(3);
    expect(store.row('nav_airport', { ident: 'CCCC' })).toMatchObject({
      ident: 'CCCC',
      region: '',
      lat: -21.37,
      lon: 121.345,
      alt_m: 212,
      detail_state: 'index',
      position_source: 'list',
      detail_fetched_at: null,
      name: null,
      magvar: null,
    });

    const meta = store.meta();
    expect(meta.bulkCompletedAt).not.toBeNull();
    expect(meta.bulkStartedAt).not.toBeNull();
    expect(meta.bulkRowCount).toBe(3);
    // The configured simulator, not the default a fresh meta row would take.
    expect(meta.simId).toBe('2024');
  });

  it('writes in bounded transactions rather than one', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2 });

    const chunks = [
      [airportRow('AAAA', 1, 2), airportRow('BBBB', 3, 4)],
      [airportRow('CCCC', 5, 6), airportRow('DDDD', 7, 8)],
      [airportRow('EEEE', 9, 10)],
    ];
    await runPass(index, session, handle, store, { chunks });

    // One rev per write transaction: five rows at two per transaction is three.
    expect(store.meta().rev).toBe(3);
    expect(store.count('nav_airport')).toBe(5);
  });

  it('re-running an unchanged world writes nothing and bumps no rev', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2, minIntervalMs: 0 });

    await runPass(index, session, handle, store, { chunks: WORLD });
    const revAfterFirst = store.meta().rev;

    const second = await runPass(index, session, handle, store, { chunks: WORLD });
    expect(second.status).toBe('completed');
    expect(second.written).toBe(0);
    expect(second.inserted).toBe(0);
    expect(store.meta().rev).toBe(revAfterFirst);
  });

  it('takes a repeated ident once', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 10 });

    const result = await runPass(index, session, handle, store, {
      chunks: [[airportRow('AAAA', 1, 2), airportRow('AAAA', 9, 9), airportRow('BBBB', 3, 4)]],
    });
    expect(result.rows).toBe(2);
    expect(store.row('nav_airport', { ident: 'AAAA' })).toMatchObject({ lat: 1, lon: 2 });
  });
});

describe('what a bulk pass must not overwrite', () => {
  it('does not demote an airport whose detail was already fetched', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    store.write((tx) =>
      tx.upsert('nav_airport', {
        ident: 'AAAA',
        lat: 10.5,
        lon: 20.25,
        name: 'Somewhere',
        detail_state: 'detail',
        detail_fetched_at: 1_700_000_000_000,
        position_source: 'facility',
      }),
    );
    const revBefore = store.meta().rev;

    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 10 });
    const result = await runPass(index, session, handle, store, {
      chunks: [[airportRow('AAAA', 10.5, 20.25, 0)]],
    });

    expect(result.status).toBe('completed');
    expect(store.row('nav_airport', { ident: 'AAAA' })).toMatchObject({
      detail_state: 'detail',
      name: 'Somewhere',
      position_source: 'facility',
      lat: 10.5,
      lon: 20.25,
    });
    // Nothing was written at all: the list position loses to the facility one
    // and the whole position group moves together, so the altitude the list
    // carried does not land either. A pass over an airport that is already
    // known in full ships nothing.
    expect(store.meta().rev).toBe(revBefore);
    expect(result.written).toBe(0);
  });

  it('does not erase a region with the empty one every list row carries', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    store.write((tx) => tx.upsert('nav_airport', { ident: 'AAAA', region: 'EG' }));

    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never });
    await runPass(index, session, handle, store, { chunks: [[airportRow('AAAA', 1, 2, 3, '')]] });

    expect(store.row('nav_airport', { ident: 'AAAA' })).toMatchObject({ region: 'EG' });
  });

  it('does not take a lower-precedence position over a facility one', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    store.write((tx) =>
      tx.upsert('nav_airport', {
        ident: 'AAAA',
        lat: 1,
        lon: 2,
        position_source: 'facility',
      }),
    );

    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never });
    await runPass(index, session, handle, store, { chunks: [[airportRow('AAAA', 55, 66, 3)]] });

    expect(store.row('nav_airport', { ident: 'AAAA' })).toMatchObject({
      lat: 1,
      lon: 2,
      position_source: 'facility',
    });
  });
});

describe('an interrupted pass', () => {
  it('leaves no completion stamp and keeps the rows that did arrive', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 1 });

    const result = await runPass(index, session, handle, store, {
      chunks: WORLD,
      dropAfter: 2,
    });

    expect(result.status).toBe('interrupted');
    expect(result.reason).toBe('the simulator connection dropped during the airport list');
    expect(store.meta().bulkCompletedAt).toBeNull();
    expect(store.count('nav_airport')).toBe(2);
  });

  it('is redone from scratch on the next attempt, throttle or no throttle', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2 });

    const first = new FakeFacilityConnection();
    const firstSession = newSession(first);
    expect((await runPass(index, firstSession, first, store, { chunks: WORLD })).status).toBe(
      'completed',
    );

    // Inside the hour, an already-completed index is left alone.
    const second = new FakeFacilityConnection();
    const secondSession = newSession(second);
    const skipped = await runPass(index, secondSession, second, store, { chunks: WORLD });
    expect(skipped.status).toBe('skipped');
    expect(second.listRequests).toHaveLength(0);

    // A pass that did not finish is a different matter: the missing stamp
    // outranks the throttle and the whole list is fetched again.
    store.write((tx) => tx.updateMeta({ bulkCompletedAt: null }));
    const third = new FakeFacilityConnection();
    const thirdSession = newSession(third);
    const redone = await runPass(index, thirdSession, third, store, { chunks: WORLD });
    expect(redone.status).toBe('completed');
    expect(redone.rows).toBe(3);
    expect(third.listRequests).toHaveLength(1);
    expect(store.meta().bulkCompletedAt).not.toBeNull();
  });

  it('clears the completion stamp before the first row arrives', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2, minIntervalMs: 0 });

    await runPass(index, session, handle, store, { chunks: WORLD });
    expect(store.meta().bulkCompletedAt).not.toBeNull();

    const running = index.run(session, store);
    await tick();
    expect(store.meta().bulkCompletedAt).toBeNull();
    session.close('SimConnect disconnected');
    expect((await running).status).toBe('interrupted');
  });

  it('reports a list that stopped arriving as interrupted, not as a completed world', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2 });

    // The simulator claims 40 chunks and sends three.
    const running = index.run(session, store);
    await tick();
    const requestId = handle.lastListRequestId() as number;
    for (let i = 0; i < 3; i++) {
      handle.emitAirportChunk(requestId, WORLD[i], i, 40);
      await tick();
    }
    session.close('SimConnect disconnected');

    const result = await running;
    expect(result.status).toBe('interrupted');
    expect(store.meta().bulkCompletedAt).toBeNull();
  });
});

describe('the epoch decision', () => {
  it('keeps the epoch when the new list only adds airports', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2, minIntervalMs: 0 });

    const first = new FakeFacilityConnection();
    await runPass(index, newSession(first), first, store, { chunks: WORLD });
    const epoch = store.meta().snapshotId;

    const second = new FakeFacilityConnection();
    const grown = await runPass(index, newSession(second), second, store, {
      chunks: [...WORLD, [airportRow('DDDD', 1, 2, 3)]],
    });

    expect(grown.status).toBe('completed');
    expect(grown.epochMinted).toBeNull();
    expect(store.meta().snapshotId).toBe(epoch);
    expect(store.count('nav_airport')).toBe(4);
  });

  it('mints a new epoch when a stored airport is no longer listed', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2, minIntervalMs: 0 });

    const first = new FakeFacilityConnection();
    await runPass(index, newSession(first), first, store, { chunks: WORLD });
    const epoch = store.meta().snapshotId;
    store.write((tx) =>
      tx.recordAbsent({ kind: 'A', ident: 'ZZZZ', reason: 'silent', at: 1_700_000_000_000 }),
    );

    const second = new FakeFacilityConnection();
    const shrunk = await runPass(index, newSession(second), second, store, {
      chunks: [WORLD[0], WORLD[1], [airportRow('DDDD', 1, 2, 3)]],
    });

    expect(shrunk.status).toBe('completed');
    expect(shrunk.epochMinted).not.toBeNull();
    expect(store.meta().snapshotId).not.toBe(epoch);
    // A new epoch throws away what this install was known to be missing.
    expect(store.count('nav_absent')).toBe(0);
  });

  it('never mints from a list that carried no rows at all', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2, minIntervalMs: 0 });

    const first = new FakeFacilityConnection();
    await runPass(index, newSession(first), first, store, { chunks: WORLD });
    const epoch = store.meta().snapshotId;
    expect(store.count('nav_airport')).toBe(3);

    // One chunk, no airports, outOf 0 — which the simulator ends as a complete
    // list. Read as a completed pass it says every stored airport vanished,
    // and the epoch it would mint is the thing that makes the replica drop
    // them all.
    const second = new FakeFacilityConnection();
    const session = newSession(second);
    const running = index.run(session, store);
    await tick();
    second.emitAirportChunk(second.lastListRequestId() as number, [], 0, 0);
    const empty = await running;

    expect(empty.status).toBe('interrupted');
    expect(empty.rows).toBe(0);
    expect(empty.epochMinted).toBeNull();
    expect(store.meta().snapshotId).toBe(epoch);
    expect(store.meta().bulkCompletedAt).toBeNull();
    expect(store.count('nav_airport')).toBe(3);
  });

  it('never decides the epoch from a list that did not finish', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2, minIntervalMs: 0 });

    const first = new FakeFacilityConnection();
    await runPass(index, newSession(first), first, store, { chunks: WORLD });
    const epoch = store.meta().snapshotId;

    // Half a world looks exactly like a world that lost half its airports.
    const second = new FakeFacilityConnection();
    const partial = await runPass(index, newSession(second), second, store, {
      chunks: WORLD,
      dropAfter: 1,
    });

    expect(partial.status).toBe('interrupted');
    expect(partial.epochMinted).toBeNull();
    expect(store.meta().snapshotId).toBe(epoch);
  });
});

describe('navdata fails alone', () => {
  it('reports a store that never opened instead of throwing', async () => {
    const failures: NavdataUnavailable[] = [];
    const dir = scratchConfigDir();
    const store = openNavdataStore(navdataDatabasePath(path.join(dir, 'config.json')), {
      simId: '2024',
      loadDriver: () => ({
        ok: false,
        failure: {
          code: 'ERR_DLOPEN_FAILED',
          reason: 'navdata disabled: the SQLite driver did not load (ERR_DLOPEN_FAILED)',
        },
      }),
      onUnavailable: (failure) => failures.push(failure),
    });

    expect(store).toBeNull();
    expect(failures).toHaveLength(1);
    expect(failures[0].code).toBe('ERR_DLOPEN_FAILED');
    // Nothing was created for a store that never opened.
    expect(fs.existsSync(path.join(dir, 'navdata', 'navdata.db'))).toBe(false);

    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never });
    const result = await index.run(session, store);

    expect(result.status).toBe('disabled');
    expect(result.reason).toBe('navdata disabled: no store is open');
    expect(handle.listRequests).toHaveLength(0);
  });

  it('catches a store that throws on the very first write', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const failing: NavdataStore = {
      ...store,
      write: () => {
        throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      },
    };

    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2 });
    const result = await index.run(session, failing);

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('SQLITE_FULL');
    expect(logged.some((line) => line.includes('SQLITE_FULL'))).toBe(true);
    expect(handle.listRequests).toHaveLength(0);
  });

  it('catches a store that throws part way through a pass', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    let writes = 0;
    const failing: NavdataStore = {
      ...store,
      write: (<T,>(fn: Parameters<NavdataStore['write']>[0]): T => {
        writes++;
        if (writes === 3) {
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        }
        return store.write(fn) as T;
      }) as NavdataStore['write'],
    };

    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 1 });
    const result = await runPass(index, session, handle, failing, { chunks: WORLD });

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('SQLITE_BUSY');
    // The store is intact and the pass is marked unfinished, so it is redone.
    expect(store.meta().bulkCompletedAt).toBeNull();
    expect(store.count('nav_airport')).toBeLessThan(3);
  });

  it('never runs two passes at once', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2 });

    const first = index.run(session, store);
    await tick();
    const second = await index.run(session, store);
    expect(second.status).toBe('skipped');
    expect(handle.listRequests).toHaveLength(1);

    session.close('SimConnect disconnected');
    await first;
  });
});

describe('secrets', () => {
  it('puts the store beside the config it was given and never near the real one', () => {
    const dir = scratchConfigDir();
    expect(navdataDatabasePath(path.join(dir, 'config.json'))).toBe(
      path.join(dir, 'navdata', 'navdata.db'),
    );
    expect(navdataDatabasePath(path.join(dir, 'config.json')).startsWith(dir)).toBe(true);
  });

  it('leaves the sentinel token out of every log line, result and stored byte', async () => {
    const dir = scratchConfigDir();
    const store = openStore(dir);
    const handle = new FakeFacilityConnection();
    const session = newSession(handle);
    const index = new BulkAirportIndex({ log: log as never, chunkRows: 2 });

    const result = await runPass(index, session, handle, store, { chunks: WORLD });
    store.checkpoint();

    expect(result.status).toBe('completed');
    expect(logged.join('\n')).not.toContain(SENTINEL_TOKEN);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_TOKEN);
    expect(logged.length).toBeGreaterThan(0);

    const dbPath = navdataDatabasePath(path.join(dir, 'config.json'));
    const bytes = fs.readFileSync(dbPath).toString('latin1');
    expect(bytes).not.toContain(SENTINEL_TOKEN);
    // And the config it was derived from is untouched.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).ingestToken).toBe(
      SENTINEL_TOKEN,
    );
  });
});
