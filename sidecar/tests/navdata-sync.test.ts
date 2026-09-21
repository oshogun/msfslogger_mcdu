// tests/navdata-sync.test.ts — tests src/navdata-sync.ts: the snapshot upload,
// the incremental stream, the state report and everything that can go wrong
// with them.
//
// NO REAL SERVER IS CONTACTED BY ANY TEST IN THIS FILE. The network half runs
// against a throwaway listener on 127.0.0.1 on an ephemeral port, started and
// stopped by the test; the state-machine half runs against a fake client and
// touches no socket at all. Every store is a fresh temp directory and every
// ident is synthetic.
//
// What these pin down:
//
// 1. The upload is one multipart part named `navdataSnapshot`. The server tells
//    its uploads apart by that name, so it is a contract, not a label.
// 2. The cursor advances only on an acknowledgement that says what was applied.
//    A 500, a refused connection and an ack with no usable rev all leave it
//    where it was, or rows would be marked delivered and never re-sent.
// 3. A snapshot mismatch re-exports THE EPOCH THE STORE ALREADY HAS. Minting a
//    new one would throw away the distinction the epoch exists to carry.
// 4. A schema the server does not speak latches and stops; a busy server does
//    not count as a failure at all.
// 5. The state report works with no store open — the case it exists for.
// 6. Nothing throws at the caller, ever, and the token appears in exactly one
//    place: the `x-ingest-token` header.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { openNavdataReader, type NavdataReader } from '../src/navdata-export';
import {
  buildBatch,
  busyWaitMs,
  NAVDATA_BUSY_DEFAULT_MS,
  NAVDATA_BUSY_MIN_MS,
  NavdataSync,
  NavdataSyncClient,
  NAVDATA_BATCH_MIN_INTERVAL_MS,
  NAVDATA_ROWS_PATH,
  NAVDATA_SNAPSHOT_FIELD,
  NAVDATA_SNAPSHOT_PATH,
  NAVDATA_STATE_PATH,
  readCursor,
  RESYNC_MIN_INTERVAL_MS,
  type IncrementalBatch,
  type NavdataOutcome,
  type NavdataRequester,
  type NavdataStateReport,
} from '../src/navdata-sync';
import type { NavdataStore } from '../src/navdata-store';
import {
  fillAirports,
  openFixtureStore,
  populate,
  removeScratchDirs,
  scratchDir,
} from './helpers/navdata-fixture-store';
import {
  multipart,
  SENTINEL_TOKEN,
  snapshotLines,
  startNavdataServer,
  testConfig,
  testTransport,
  type NavdataHandler,
  type NavdataScratchServer,
} from './helpers/navdata-scratch-server';

/** Captured before any fake clock is installed, so a test can wait on real I/O. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realDelay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });

/** A Windows path of the shape a filesystem error quotes. */
const PATH_IN_ERROR = 'C:\\Users\\someone\\AppData\\navdata.db';

const stores: NavdataStore[] = [];
const servers: NavdataScratchServer[] = [];
let logged: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (stores.length > 0) stores.pop()?.close();
  removeScratchDirs();
  logged = [];
});

function openStore(): NavdataStore {
  const store = openFixtureStore(scratchDir());
  stores.push(store);
  return store;
}

async function serve(routes: Record<string, NavdataHandler>): Promise<NavdataScratchServer> {
  const server = await startNavdataServer(routes);
  servers.push(server);
  return server;
}

const log = (level: string, message: string): void => {
  logged.push(`${level} ${message}`);
};

const snapshotAck = (snapshotId: string, rev: number, counts: Record<string, number> = {}) => ({
  ok: true,
  snapshotId,
  rev,
  counts,
  appliedAt: 1,
});

// ── the client ────────────────────────────────────────────────────────────────

describe('the navdata sync client', () => {
  it('uploads the snapshot as one part named navdataSnapshot', async () => {
    const store = openStore();
    populate(store);
    const directory = path.dirname(store.path);
    const reader = openNavdataReader(store.path);
    const exported = await (await import('../src/navdata-export')).exportSnapshot(reader, {
      directory,
      sidecarVersion: '1.0.0',
    });
    reader.close();

    const server = await serve({
      [`POST ${NAVDATA_SNAPSHOT_PATH}`]: () => ({
        status: 200,
        body: snapshotAck(exported.snapshotId, exported.rev),
      }),
    });
    const client = new NavdataSyncClient(() => testTransport(testConfig(server.baseUrl)));

    const outcome = await client.postSnapshot({ path: exported.path, fileName: exported.fileName });

    expect(outcome).toMatchObject({ kind: 'response', status: 200 });
    expect(server.requests).toHaveLength(1);
    const parts = multipart(server.requests[0]);
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe(NAVDATA_SNAPSHOT_FIELD);
    expect(parts[0].name).toBe('navdataSnapshot');
    expect(parts[0].fileName).toBe(`navdata-${exported.snapshotId}.ndjson.gz`);
    expect(parts[0].contentType).toBe('application/gzip');

    const lines = snapshotLines(parts[0]);
    expect((lines[0] as { kind: string }).kind).toBe('header');
    expect((lines[lines.length - 1] as { kind: string }).kind).toBe('footer');
    expect(lines.length).toBe(exported.rows + 2);
  });

  it('carries the token in x-ingest-token and nowhere else', async () => {
    const server = await serve({
      [`POST ${NAVDATA_ROWS_PATH}`]: () => ({ status: 200, body: { ok: true, rev: 1, applied: 0 } }),
    });
    const client = new NavdataSyncClient(() => testTransport(testConfig(server.baseUrl)));

    const batch: IncrementalBatch = {
      v: 1,
      schemaVersion: 2,
      snapshotId: 'epoch-1',
      fromRev: 0,
      toRev: 1,
      rows: [{ t: 'airport', r: { ident: 'ZZAA', rev: 1 } }],
      more: false,
    };
    await client.postRows(batch);

    const request = server.requests[0];
    expect(request.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
    expect(request.path).toBe(NAVDATA_ROWS_PATH);
    expect(request.path).not.toContain(SENTINEL_TOKEN);
    expect(request.body.toString('utf8')).not.toContain(SENTINEL_TOKEN);
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === 'x-ingest-token') continue;
      expect(String(value)).not.toContain(SENTINEL_TOKEN);
    }
  });

  it('does not follow a redirect', async () => {
    const server = await serve({
      [`POST ${NAVDATA_ROWS_PATH}`]: () => ({
        status: 302,
        headers: { location: '/api/navdata/elsewhere' },
        body: '',
      }),
      'POST /api/navdata/elsewhere': () => ({ status: 200, body: { ok: true, rev: 9, applied: 1 } }),
    });
    const client = new NavdataSyncClient(() => testTransport(testConfig(server.baseUrl)));

    const outcome = await client.postRows({
      v: 1,
      schemaVersion: 2,
      snapshotId: 'epoch-1',
      fromRev: 0,
      toRev: 1,
      rows: [],
      more: false,
    });

    expect(outcome).toMatchObject({ kind: 'response', status: 302 });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].path).toBe(NAVDATA_ROWS_PATH);
  });

  it('reads a Retry-After and a navdata error code off a 503', async () => {
    const server = await serve({
      [`POST ${NAVDATA_ROWS_PATH}`]: () => ({
        status: 503,
        headers: { 'retry-after': '7' },
        body: { ok: false, code: 'NAVDATA_BUSY', message: 'importing' },
      }),
    });
    const client = new NavdataSyncClient(() => testTransport(testConfig(server.baseUrl)));

    const outcome = await client.postRows({
      v: 1,
      schemaVersion: 2,
      snapshotId: 'epoch-1',
      fromRev: 0,
      toRev: 1,
      rows: [],
      more: false,
    });

    expect(outcome).toMatchObject({ kind: 'response', status: 503, code: 'NAVDATA_BUSY', retryAfterMs: 7000 });
  });

  it('answers a refused connection with an outcome rather than a throw', async () => {
    const server = await serve({});
    const url = server.baseUrl;
    await server.close();
    servers.pop();
    const client = new NavdataSyncClient(() => testTransport(testConfig(url)));

    const outcome = await client.postState({
      v: 1,
      state: 'nav.ready',
      reason: null,
      snapshotId: null,
      rev: null,
      sentAt: 1,
    });

    expect(outcome.kind).toBe('transport');
  });

  it('reports the state with no store anywhere in sight', async () => {
    const posted: NavdataStateReport[] = [];
    const server = await serve({
      [`POST ${NAVDATA_STATE_PATH}`]: (request) => {
        posted.push(JSON.parse(request.body.toString('utf8')) as NavdataStateReport);
        return { status: 204 };
      },
    });
    const sync = new NavdataSync({
      transport: () => testTransport(testConfig(server.baseUrl)),
      // The case this endpoint exists for: the driver did not load and there
      // is no store to read anything from.
      store: () => null,
      sidecarVersion: () => '1.0.0',
      log,
      onChange: () => undefined,
    });

    sync.reportState({
      state: 'nav.unavailable',
      reason: 'navdata disabled: the driver did not load',
      snapshotId: null,
      rev: null,
    });
    for (let i = 0; i < 50 && posted.length === 0; i++) await realDelay(10);
    sync.shutdown();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      v: 1,
      state: 'nav.unavailable',
      reason: 'navdata disabled: the driver did not load',
      snapshotId: null,
      rev: null,
    });
    expect(JSON.stringify(posted[0])).not.toContain(SENTINEL_TOKEN);
  });
});

// ── the batch ─────────────────────────────────────────────────────────────────

describe('an incremental batch', () => {
  function withReader<T>(store: NavdataStore, fn: (reader: NavdataReader) => T): T {
    const reader = openNavdataReader(store.path);
    try {
      reader.begin();
      return fn(reader);
    } finally {
      reader.close();
    }
  }

  it('orders by rev first and by the emission order within a rev', () => {
    const store = openStore();
    populate(store);

    const batch = withReader(store, (reader) => buildBatch(reader, 0, { maxRows: 2000, maxBytes: 4194304 }));

    expect(batch).not.toBeNull();
    const revs = (batch as { rows: { r: { rev: number } }[] }).rows.map((row) => row.r.rev);
    expect([...revs]).toEqual([...revs].sort((a, b) => a - b));
    const kinds = (batch as { rows: { t: string }[] }).rows.map((row) => row.t);
    // The procedure tree shares one rev, so within it the table order applies
    // and a parent still precedes its children.
    expect(kinds.indexOf('procedure')).toBeLessThan(kinds.indexOf('procedure_transition'));
    expect(kinds.indexOf('procedure_transition')).toBeLessThan(kinds.indexOf('procedure_leg'));
    expect(batch?.toRev).toBe(store.meta().rev);
    expect(batch?.more).toBe(false);
  });

  it('stops at a rev boundary rather than halfway through one', () => {
    const store = openStore();
    // Three transactions of 100 airports each: three revs, 300 rows.
    fillAirports(store, 300, 100);

    const batch = withReader(store, (reader) => buildBatch(reader, 0, { maxRows: 150, maxBytes: 4194304 }));

    expect(batch?.rows.length).toBe(100);
    expect(batch?.more).toBe(true);
    const revs = new Set((batch as { rows: { r: { rev: number } }[] }).rows.map((row) => row.r.rev));
    expect(revs.size).toBe(1);
    expect(batch?.toRev).toBe([...revs][0]);
  });

  it('sends a transaction larger than a whole batch rather than deadlocking behind it', () => {
    const store = openStore();
    fillAirports(store, 300, 300);

    const batch = withReader(store, (reader) => buildBatch(reader, 0, { maxRows: 10, maxBytes: 4194304 }));

    expect(batch?.rows.length).toBe(300);
    expect(batch?.more).toBe(true);
  });

  it('is nothing at all when the cursor is level with the store', () => {
    const store = openStore();
    populate(store);
    const batch = withReader(store, (reader) =>
      buildBatch(reader, store.meta().rev, { maxRows: 2000, maxBytes: 4194304 }),
    );
    expect(batch).toBeNull();
  });
});

// ── the state machine ─────────────────────────────────────────────────────────

interface FakeClient extends NavdataRequester {
  snapshots: { path: string; fileName: string }[];
  batches: IncrementalBatch[];
  states: NavdataStateReport[];
  onSnapshot: (file: { path: string; fileName: string }) => NavdataOutcome | Promise<NavdataOutcome>;
  onRows: (batch: IncrementalBatch) => NavdataOutcome | Promise<NavdataOutcome>;
}

function fakeClient(): FakeClient {
  const client: FakeClient = {
    snapshots: [],
    batches: [],
    states: [],
    onSnapshot: () => ({ kind: 'response', status: 200, code: null, retryAfterMs: null, body: { ok: true } }),
    onRows: () => ({ kind: 'response', status: 200, code: null, retryAfterMs: null, body: { ok: true } }),
    async postSnapshot(file) {
      client.snapshots.push(file);
      return await client.onSnapshot(file);
    },
    async postRows(batch) {
      client.batches.push(batch);
      return await client.onRows(batch);
    },
    async postState(report) {
      client.states.push(report);
      return { kind: 'response', status: 204, code: null, retryAfterMs: null, body: null };
    },
  };
  return client;
}

const response = (status: number, body: unknown, retryAfterMs: number | null = null): NavdataOutcome => ({
  kind: 'response',
  status,
  code:
    typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string'
      ? ((body as { code: string }).code as NavdataOutcome extends { code: infer C } ? C : never)
      : null,
  retryAfterMs,
  body,
});

describe('the navdata sync state machine', { timeout: 20000 }, () => {
  const SERVER = 'https://navdata.invalid:9';
  let tracked: NavdataSync | null = null;

  beforeEach(() => {
    // setImmediate and nextTick stay real: the export writes a real file.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    tracked = null;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /**
   * Advances the clock, then lets the export's real file I/O finish. The clock
   * is fake and the gzip write is not, so the wait has to be a real one.
   */
  async function pump(ms = 1): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    // The clock is fake and the export's gzip write is not, so this waits on
    // something observable rather than on a tuned sleep: `sending` is true for
    // the whole of an export and upload. Event-loop turns are what let the
    // real write complete, and they cost nothing when there is nothing to wait
    // for.
    for (let i = 0; i < 400; i++) {
      const sending = tracked?.status().sending === true;
      if (!sending && i >= 20) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Event-loop turns alone can spin past a slow disk on a loaded machine,
      // so waiting on an export costs real milliseconds too.
      if (sending) await realDelay(1);
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  /** The sync `pump` watches; every test here has exactly one. */
  function track(sync: NavdataSync): NavdataSync {
    tracked = sync;
    return sync;
  }

  function makeSync(store: NavdataStore | null, client: FakeClient, changes: { n: number } = { n: 0 }) {
    return track(
      new NavdataSync({
        transport: () => testTransport(testConfig(SERVER)),
        store: () => store,
        sidecarVersion: () => '1.0.0',
        log,
        onChange: () => {
          changes.n++;
        },
        client,
      }),
    );
  }

  it('sends a snapshot first, then advances the cursor to the header rev', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    sync.shutdown();

    expect(client.snapshots).toHaveLength(1);
    expect(client.snapshots[0].fileName).toBe(`navdata-${store.meta().snapshotId}.ndjson.gz`);
    const cursor = readCursor(store, SERVER);
    expect(cursor?.snapshotId).toBe(store.meta().snapshotId);
    expect(cursor?.state).toBe('incremental');
    expect(cursor?.ackedRev).toBeGreaterThan(0);
    // Deleted on the 2xx.
    expect(fs.existsSync(client.snapshots[0].path)).toBe(false);
  });

  it('sends the rows written since, and advances only on an ack that says what was applied', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    const afterSnapshot = readCursor(store, SERVER)?.ackedRev ?? 0;

    store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZAB', lat: 1, lon: 2 }));
    client.onRows = (batch) => response(200, { ok: true, snapshotId: batch.snapshotId, rev: batch.toRev, applied: batch.rows.length });
    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);

    expect(client.batches).toHaveLength(1);
    expect(client.batches[0]).toMatchObject({
      v: 1,
      schemaVersion: 2,
      snapshotId: store.meta().snapshotId,
      fromRev: afterSnapshot,
      more: false,
    });
    expect(client.batches[0].rows.map((row) => row.r.ident)).toEqual(['ZZAB']);
    expect(readCursor(store, SERVER)?.ackedRev).toBe(client.batches[0].toRev);

    sync.shutdown();
  });

  it('leaves the cursor where it was when the ack fails or makes no sense', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    const acked = readCursor(store, SERVER)?.ackedRev ?? 0;

    store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZAC', lat: 1, lon: 2 }));
    client.onRows = () => response(500, { error: 'boom' });
    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);
    expect(client.batches.length).toBeGreaterThanOrEqual(1);
    expect(readCursor(store, SERVER)?.ackedRev).toBe(acked);

    // A 200 for the right epoch but with no usable rev is not an
    // acknowledgement either.
    client.onRows = (batch) => response(200, { ok: true, snapshotId: batch.snapshotId });
    await pump(60000);
    expect(readCursor(store, SERVER)?.ackedRev).toBe(acked);
    expect(logged.join(String.fromCharCode(10))).toContain('without a usable rev');

    sync.shutdown();
  });

  it('refuses an acknowledgement that names another epoch', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    const acked = readCursor(store, SERVER)?.ackedRev ?? 0;

    store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZAE', lat: 1, lon: 2 }));
    // A well-formed rev, applied to somebody else's replica. Taking it would
    // step the cursor over rows this server never received.
    client.onRows = (batch) =>
      response(200, {
        ok: true,
        snapshotId: 'A-COMPLETELY-DIFFERENT-EPOCH',
        rev: batch.toRev,
        applied: batch.rows.length,
      });
    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);

    expect(client.batches.length).toBeGreaterThanOrEqual(1);
    expect(readCursor(store, SERVER)?.ackedRev).toBe(acked);
    expect(logged.join(String.fromCharCode(10))).toContain('under a different epoch');

    sync.shutdown();
  });

  it('stops sending rows once the server has rejected the epoch', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();

    store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZAF', lat: 1, lon: 2 }));
    client.onRows = () =>
      response(409, { ok: false, code: 'NAVDATA_SNAPSHOT_MISMATCH', message: 'different epoch' });
    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);
    const posted = client.batches.length;
    expect(posted).toBeGreaterThanOrEqual(1);
    expect(readCursor(store, SERVER)?.state).toBe('resync-required');

    // The re-send fails, and the rate limit holds the next one off for five
    // minutes. Nothing may go out on the rows route in the meantime: the
    // server has already said this epoch is wrong.
    client.onSnapshot = () => response(500, { error: 'no' });
    for (let i = 0; i < 6; i++) await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);

    expect(client.batches).toHaveLength(posted);
    expect(readCursor(store, SERVER)?.state).toBe('resync-required');
    expect(readCursor(store, SERVER)?.ackedRev).toBe(0);

    sync.shutdown();
  });

  it('re-exports the epoch it already has when the server says the epoch differs', async () => {
    const store = openStore();
    populate(store);
    const epoch = store.meta().snapshotId;
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    expect(client.snapshots).toHaveLength(1);

    store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZAD', lat: 1, lon: 2 }));
    client.onRows = () =>
      response(409, {
        ok: false,
        code: 'NAVDATA_SNAPSHOT_MISMATCH',
        message: 'different epoch',
        serverSnapshotId: 'something-else',
      });
    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);

    // The cursor is reset and a snapshot goes out again — of the SAME epoch.
    expect(readCursor(store, SERVER)?.ackedRev).toBe(0);
    await pump(10);
    expect(client.snapshots.length).toBeGreaterThanOrEqual(2);
    expect(store.meta().snapshotId).toBe(epoch);
    expect(client.snapshots[client.snapshots.length - 1].fileName).toBe(`navdata-${epoch}.ndjson.gz`);

    sync.shutdown();
  });

  it('will not re-upload to a server that keeps rejecting the epoch', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () =>
      response(409, { ok: false, code: 'NAVDATA_SNAPSHOT_MISMATCH', message: 'still no' });
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    const first = client.snapshots.length;
    expect(first).toBeGreaterThanOrEqual(1);

    await pump(RESYNC_MIN_INTERVAL_MS - 10000);
    expect(client.snapshots.length).toBe(first);

    await pump(20000);
    expect(client.snapshots.length).toBeGreaterThan(first);

    sync.shutdown();
  });

  it('latches on a schema the server does not speak and stops', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () =>
      response(409, {
        ok: false,
        code: 'NAVDATA_SCHEMA_UNSUPPORTED',
        message: 'no',
        serverSchemaVersion: 7,
      });
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    const sent = client.snapshots.length;
    expect(sent).toBe(1);

    await pump(600000);
    expect(client.snapshots.length).toBe(sent);
    expect(client.batches).toHaveLength(0);

    const status = sync.status();
    expect(status.latched).toContain('7');
    expect(status.latched).toContain('2');
    expect(logged.join('\n')).toContain('navdata schema version 7');

    sync.shutdown();
  });

  it('treats a busy server as a wait, not a failure', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    let busy = true;
    client.onSnapshot = () =>
      busy
        ? response(503, { ok: false, code: 'NAVDATA_BUSY', message: 'importing' }, 30000)
        : response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    expect(client.snapshots).toHaveLength(1);
    expect(sync.status().lastSyncError).toBeNull();

    // Nothing is tried before the Retry-After the server named.
    await pump(20000);
    expect(client.snapshots).toHaveLength(1);

    busy = false;
    await pump(15000);
    expect(client.snapshots.length).toBeGreaterThan(1);
    expect(readCursor(store, SERVER)?.state).toBe('incremental');

    sync.shutdown();
  });

  it('gives a busy server that says Retry-After: 0 a second, not a tight loop', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(503, { ok: false, code: 'NAVDATA_BUSY', message: 'importing' }, 0);
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    expect(client.snapshots).toHaveLength(1);
    await pump(NAVDATA_BUSY_MIN_MS - 50);
    expect(client.snapshots).toHaveLength(1);
    await pump(100);
    expect(client.snapshots).toHaveLength(2);

    sync.shutdown();
  });

  it('halves a batch the server calls too large, and skips one it cannot halve', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    const sync = makeSync(store, client);

    sync.start();
    await pump();

    // Forty transactions, so there are rev boundaries to cut on.
    fillAirports(store, 40, 1);
    client.onRows = () => response(413, { ok: false, code: 'NAVDATA_TOO_LARGE', message: 'too big' });
    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);
    const first = client.batches[0].rows.length;
    expect(first).toBe(40);

    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);
    expect(client.batches[1].rows.length).toBeLessThan(first);
    expect(logged.join('\n')).toContain('halving');

    // It keeps shrinking until the batch is one transaction, which cannot be
    // cut further; that one is skipped rather than retried for ever.
    const acked = readCursor(store, SERVER)?.ackedRev ?? 0;
    for (let i = 0; i < 8; i++) await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);
    expect(client.batches[client.batches.length - 1].rows.length).toBe(1);
    expect(readCursor(store, SERVER)?.ackedRev).toBeGreaterThan(acked);
    expect(logged.join(String.fromCharCode(10))).toContain('skipping them');

    sync.shutdown();
  });

  it('survives an export that cannot happen at all', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    const sync = track(
      new NavdataSync({
        transport: () => testTransport(testConfig(SERVER)),
        store: () => store,
        sidecarVersion: () => '1.0.0',
        log,
        onChange: () => undefined,
        client,
        openReader: () => {
          // A filesystem or SQLite error quotes the file it was about, and
          // this text reaches the status axis and the CDU scratchpad.
          throw new Error('SQLITE_CANTOPEN: unable to open ' + PATH_IN_ERROR);
        },
      }),
    );

    sync.start();
    await pump();

    expect(client.snapshots).toHaveLength(0);
    expect(sync.status().lastSyncError).toContain('could not be exported');
    expect(readCursor(store, SERVER)?.lastErrorCode).toBe('EXPORT_FAILED');
    // The reason is shown to a user; the user's directory layout is not.
    expect(sync.status().lastSyncError).not.toContain(PATH_IN_ERROR);
    expect(sync.status().lastSyncError).toContain('<path>');
    expect(logged.join(String.fromCharCode(10))).not.toContain(PATH_IN_ERROR);

    sync.shutdown();
  });

  it('survives a client that throws instead of answering', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => {
      throw new Error('the client exploded');
    };
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    expect(sync.status().lastSyncError).toContain('could not reach the server');

    // And it keeps trying rather than giving up or dying.
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    await pump(60000);
    expect(readCursor(store, SERVER)?.state).toBe('incremental');

    sync.shutdown();
  });

  it('keeps one cursor per server, so a different server starts again', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    let serverUrl = SERVER;
    const sync = track(
      new NavdataSync({
        transport: () => testTransport(testConfig(serverUrl)),
        store: () => store,
        sidecarVersion: () => '1.0.0',
        log,
        onChange: () => undefined,
        client,
      }),
    );

    sync.start();
    await pump();
    expect(readCursor(store, SERVER)?.state).toBe('incremental');

    // Pointing at another server invalidates nothing that was acknowledged by
    // the first one, and asks the new one for a snapshot of its own.
    serverUrl = 'https://other.invalid:9';
    sync.onConfigApplied();
    await pump();

    expect(readCursor(store, SERVER)?.state).toBe('incremental');
    expect(readCursor(store, serverUrl)?.state).toBe('incremental');
    expect(client.snapshots).toHaveLength(2);

    sync.shutdown();
  });

  it('never uploads an empty store', async () => {
    const store = openStore();
    const client = fakeClient();
    const sync = makeSync(store, client);

    sync.start();
    await pump(60000);

    // A snapshot resets the replica wholesale; an empty one would claim the
    // world is empty and throw away what the server has.
    expect(client.snapshots).toHaveLength(0);
    expect(client.batches).toHaveLength(0);

    // Once the store has something to say, it goes.
    client.onSnapshot = () => response(200, snapshotAck(store.meta().snapshotId, store.meta().rev));
    populate(store);
    await pump(NAVDATA_BATCH_MIN_INTERVAL_MS);
    expect(client.snapshots).toHaveLength(1);

    sync.shutdown();
  });

  it('never posts an export that came out empty', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    const sync = track(
      new NavdataSync({
        transport: () => testTransport(testConfig(SERVER)),
        store: () => store,
        sidecarVersion: () => '1.0.0',
        log,
        onChange: () => undefined,
        client,
        // A store that empties between the check and the read: the rows are
        // there when the snapshot is decided on and gone when it is taken.
        openReader: (dbPath) => {
          const real = openNavdataReader(dbPath);
          return { ...real, count: () => 0, page: () => [] };
        },
      }),
    );

    sync.start();
    await pump(60000);

    expect(client.snapshots).toHaveLength(0);
    expect(logged.join(String.fromCharCode(10))).toContain('came out empty');
    // And it left nothing behind to be picked up later.
    const directory = path.dirname(store.path);
    expect(fs.readdirSync(directory).filter((entry) => entry.startsWith('snapshot-'))).toEqual([]);

    sync.shutdown();
  });

  it('does not count coverage and absence rows as something to snapshot', async () => {
    const store = openStore();
    // Everything the harvest records about where it has looked, and nothing
    // it found. A snapshot of this would wipe every facility the server holds.
    store.write((tx) => {
      tx.recordCoverage('W', 4242, 1_700_000_000_000, 0);
      tx.recordAbsent({ kind: 'V', ident: 'ZZXX', region: 'ZZ', reason: 'silent', at: 1_700_000_000_000 });
    });
    expect(store.count('nav_coverage_cell')).toBe(1);
    expect(store.count('nav_absent')).toBe(1);

    const client = fakeClient();
    const sync = makeSync(store, client);
    sync.start();
    await pump(60000);

    expect(client.snapshots).toHaveLength(0);
    expect(client.batches).toHaveLength(0);

    sync.shutdown();
  });

  it('does nothing at all without a store', async () => {
    const client = fakeClient();
    const sync = makeSync(null, client);

    sync.start();
    await pump(60000);

    expect(client.snapshots).toHaveLength(0);
    expect(client.batches).toHaveLength(0);

    sync.reportState({ state: 'nav.unavailable', reason: 'no driver', snapshotId: null, rev: null });
    await pump(1);
    expect(client.states).toHaveLength(1);

    sync.shutdown();
  });

  it('reports a transition once and then on the heartbeat', async () => {
    const client = fakeClient();
    const sync = makeSync(null, client);
    sync.start();

    sync.reportState({ state: 'nav.off', reason: null, snapshotId: null, rev: null });
    await pump(1);
    sync.reportState({ state: 'nav.off', reason: null, snapshotId: null, rev: null });
    await pump(1);
    expect(client.states).toHaveLength(1);

    sync.reportState({ state: 'nav.ready', reason: null, snapshotId: 'epoch-1', rev: 3 });
    await pump(1);
    expect(client.states).toHaveLength(2);

    await pump(300000);
    expect(client.states.length).toBeGreaterThanOrEqual(3);
    expect(client.states[client.states.length - 1]).toMatchObject({ state: 'nav.ready', snapshotId: 'epoch-1' });

    sync.shutdown();
  });

  it('keeps the token out of every log line, file name and payload', async () => {
    const store = openStore();
    populate(store);
    const client = fakeClient();
    const files: string[] = [];
    client.onSnapshot = (file) => {
      files.push(file.path, file.fileName);
      // Read the bytes that would have gone on the wire.
      const bytes = fs.readFileSync(file.path);
      expect(bytes.includes(Buffer.from(SENTINEL_TOKEN))).toBe(false);
      return response(500, { error: 'no' });
    };
    const sync = makeSync(store, client);

    sync.start();
    await pump();
    await pump(60000);
    sync.shutdown();

    expect(files.length).toBeGreaterThan(0);
    for (const name of files) expect(name).not.toContain(SENTINEL_TOKEN);
    expect(logged.join('\n')).not.toContain(SENTINEL_TOKEN);
    expect(sync.status().lastSyncError ?? '').not.toContain(SENTINEL_TOKEN);
    const directory = path.dirname(store.path);
    for (const entry of fs.readdirSync(directory)) expect(entry).not.toContain(SENTINEL_TOKEN);
  });
});

describe('busyWaitMs', () => {
  it('takes the Retry-After, never below a second, and a default when there is none', () => {
    expect(busyWaitMs(0)).toBe(NAVDATA_BUSY_MIN_MS);
    expect(busyWaitMs(250)).toBe(NAVDATA_BUSY_MIN_MS);
    expect(busyWaitMs(NAVDATA_BUSY_MIN_MS)).toBe(NAVDATA_BUSY_MIN_MS);
    expect(busyWaitMs(7000)).toBe(7000);
    expect(busyWaitMs(null)).toBe(NAVDATA_BUSY_DEFAULT_MS);
    expect(busyWaitMs(Number.NaN)).toBe(NAVDATA_BUSY_DEFAULT_MS);
    expect(busyWaitMs(-5)).toBe(NAVDATA_BUSY_MIN_MS);
  });
});
