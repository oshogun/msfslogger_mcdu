// tests/navdata-demand.test.ts — tests src/navdata-demand.ts, the poller that
// reads the server's demand list and the queue that fetches each airport on it.
//
// What these pin down:
//
// 1. THE CADENCE. 60 s while the list is quiet, at once while a truncated list
//    keeps bringing new work, doubling to 600 s on failure and back on the first
//    success. A busy server is a wait, not a failure. Nothing is polled while the
//    uplink is stopped, and no timer keeps the process alive.
// 2. THE SERVER KEEPS NO STATE, SO THIS SIDE DEDUPES. An airport the store holds
//    in detail, or holds as absent, costs a lookup and no request; one already
//    queued is not queued twice.
// 3. A FAULT IN THIS BUILD CANNOT SPIN. A decoder that throws settles aborted and
//    aborted re-queues, so consecutive aborts on a live link are counted and the
//    airport is set aside at the limit. Aborts from a dropped link are not held
//    against it.
// 4. THE ANSWER IS READ DEFENSIVELY and a malformed one is a failure. Neither the
//    token nor the body of a response reaches a log.
//
// The network tests talk only to a throwaway listener on 127.0.0.1 on an
// ephemeral port. Every ident is synthetic and the only token is a sentinel.

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AIRPORT_DETAIL_DEFINITION,
  fetchAirportDetail,
  type AirportDetailResult,
  type AirportDetailStatus,
} from '../src/navdata-detail';
import {
  DEMAND_FAULT_PARK_AFTER,
  DEMAND_QUEUE_HIGH_WATER,
  DEMAND_SKIP_MAX,
  NAVDATA_DEMAND_BACKOFF_MAX_MS,
  NAVDATA_DEMAND_POLL_MS,
  NavdataDemand,
  nextDemandDelayMs,
  parseDemand,
  type FetchDetail,
  type NavdataDemandDeps,
} from '../src/navdata-demand';
import { openNavdataReader } from '../src/navdata-export';
import { FacilitySession, type FacilityDefinition } from '../src/navdata-facilities';
import type { NavdataStore } from '../src/navdata-store';
import {
  buildBatch,
  NAVDATA_BATCH_MAX_BYTES,
  NAVDATA_BATCH_MAX_ROWS,
  NAVDATA_BUSY_MIN_MS,
  NAVDATA_DEMAND_PATH,
  NavdataSyncClient,
  demandPath,
  type DemandSkip,
  type NavdataOutcome,
  type NavdataTransport,
} from '../src/navdata-sync';
import { FakeFacilityConnection } from './helpers/fake-facility-connection';
import { throwingReader } from './helpers/facility-record';
import { openFixtureStore, removeScratchDirs, scratchDir } from './helpers/navdata-fixture-store';
import { SENTINEL_TOKEN, startNavdataServer, type NavdataScratchServer } from './helpers/navdata-scratch-server';

const demands: NavdataDemand[] = [];
const sessions: FacilitySession[] = [];
const stores: NavdataStore[] = [];
const servers: NavdataScratchServer[] = [];
let logged: string[] = [];
let changes = 0;

afterEach(async () => {
  while (demands.length > 0) demands.pop()?.shutdown();
  while (sessions.length > 0) sessions.pop()?.close('test over');
  while (stores.length > 0) stores.pop()?.close();
  while (servers.length > 0) await servers.pop()?.close();
  removeScratchDirs();
  vi.useRealTimers();
  logged = [];
  changes = 0;
});

// ── fakes ─────────────────────────────────────────────────────────────────────

function body(airports: unknown[], more = false, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, airports, waypoints: [], cap: 50, more, generatedAt: 1, ...extra };
}

function ok(payload: unknown, status = 200): NavdataOutcome {
  return { kind: 'response', status, code: null, retryAfterMs: null, body: payload };
}

const TRANSPORT_DOWN: NavdataOutcome = { kind: 'transport', errorName: 'TypeError', errorCode: 'ECONNREFUSED' };

class FakeClient {
  readonly replies: NavdataOutcome[] = [];
  fallback: NavdataOutcome = ok(body([]));
  calls = 0;
  /** What each poll asked the server to leave out. */
  readonly skips: (DemandSkip | undefined)[] = [];

  getDemand(skip?: DemandSkip): Promise<NavdataOutcome> {
    this.calls++;
    this.skips.push(skip);
    return Promise.resolve(this.replies.shift() ?? this.fallback);
  }
}

/** Only the two lookups the queue makes, over two sets a test can fill. */
function fakeStore(): { store: NavdataStore; detail: Set<string>; absent: Set<string> } {
  const detail = new Set<string>();
  const absent = new Set<string>();
  const store = {
    row(table: string, key: { ident?: string }) {
      const ident = key.ident ?? '';
      if (table === 'nav_airport') return detail.has(ident) ? { ident, detail_state: 'detail' } : null;
      if (table === 'nav_absent') return absent.has(ident) ? { kind: 'A', ident, region: '' } : null;
      return null;
    },
  } as unknown as NavdataStore;
  return { store, detail, absent };
}

const DEFINITION: FacilityDefinition = {
  name: AIRPORT_DETAIL_DEFINITION,
  definitionId: 100,
  members: new Map(),
  rejectedEntries: [],
  rejectedMembers: [],
};

/** A session whose link a test can drop, and which prepares instantly. */
function fakeSession(): { session: FacilitySession; link: { open: boolean }; prepares: () => number } {
  const link = { open: true };
  let prepared = 0;
  const session = {
    isOpen: () => link.open,
    prepare: () => {
      prepared++;
      return Promise.resolve([DEFINITION]);
    },
  } as unknown as FacilitySession;
  return { session, link, prepares: () => prepared };
}

function result(ident: string, status: AirportDetailStatus, extra: Partial<AirportDetailResult> = {}): AirportDetailResult {
  return {
    ident,
    status,
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
    reason: null,
    ...extra,
  };
}

function transportFor(serverUrl: string): NavdataTransport {
  return {
    getConfig: () => ({ serverUrl, ingestToken: SENTINEL_TOKEN }) as never,
    dispatchInit: (init) => init as RequestInit,
  };
}

function newDemand(overrides: Partial<NavdataDemandDeps> = {}): NavdataDemand {
  const { store } = fakeStore();
  const demand = new NavdataDemand({
    transport: () => transportFor('http://127.0.0.1:9'),
    store: () => store,
    session: () => null,
    log: (level, message) => {
      logged.push(`${level} ${message}`);
    },
    onChange: () => {
      changes++;
    },
    ...overrides,
  });
  demands.push(demand);
  return demand;
}

/**
 * Lets resolved promises and chains of zero-delay timers run, under fake timers.
 * A zero delay set while the fake clock is ticking lands a millisecond later,
 * so the clock is moved on a millisecond at a time, 20 ms in all.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1);
}

/** Lets resolved promises run without moving the fake clock at all. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Waits on something observable with real timers, bounded so a hang fails. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ── the backoff ───────────────────────────────────────────────────────────────

describe('nextDemandDelayMs', () => {
  it('is the poll interval while healthy and doubles to the cap on failure', () => {
    expect(nextDemandDelayMs(0)).toBe(NAVDATA_DEMAND_POLL_MS);
    expect(nextDemandDelayMs(1)).toBe(120_000);
    expect(nextDemandDelayMs(2)).toBe(240_000);
    expect(nextDemandDelayMs(3)).toBe(480_000);
    expect(nextDemandDelayMs(4)).toBe(NAVDATA_DEMAND_BACKOFF_MAX_MS);
    expect(nextDemandDelayMs(1000)).toBe(NAVDATA_DEMAND_BACKOFF_MAX_MS);
    expect(nextDemandDelayMs(Number.NaN)).toBe(NAVDATA_DEMAND_POLL_MS);
    expect(nextDemandDelayMs(-3)).toBe(NAVDATA_DEMAND_POLL_MS);
  });
});

// ── the answer ────────────────────────────────────────────────────────────────

describe('parseDemand', () => {
  it('reads a well-formed answer and keeps the cap the server chose', () => {
    const parsed = parseDemand(
      body(['ZZAA', 'ZZ1B'], true, { cap: 7, waypoints: [{ ident: 'ZZWPT', region: 'ZZ' }, { ident: 'ZZWPU' }] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.demand.airports).toEqual(['ZZAA', 'ZZ1B']);
    expect(parsed.demand.waypoints).toEqual([{ ident: 'ZZWPT', region: 'ZZ' }, { ident: 'ZZWPU' }]);
    expect(parsed.demand.cap).toBe(7);
    expect(parsed.demand.more).toBe(true);
  });

  it.each([
    ['not an object', null],
    ['not an object', ['ZZAA']],
    ['unsupported version', body([], false, { v: 2 })],
    ['unsupported version', { airports: [], waypoints: [], cap: 5, more: false }],
    ['airports is not a list', body([], false, { airports: 'ZZAA' })],
    ['waypoints is not a list', body([], false, { waypoints: {} })],
    ['cap is missing or invalid', body([], false, { cap: undefined })],
    ['cap is missing or invalid', body([], false, { cap: 0 })],
    ['cap is missing or invalid', body([], false, { cap: 2.5 })],
    ['cap is missing or invalid', body([], false, { cap: '50' })],
    ['more is missing or invalid', body([], false, { more: 'yes' })],
  ])('refuses an answer whose shape is wrong (%s)', (reason, payload) => {
    expect(parseDemand(payload)).toEqual({ ok: false, reason });
  });

  it('leaves out idents it does not accept, counts them, and collapses repeats', () => {
    const parsed = parseDemand(
      body(['ZZAA', 'zzab', 'ZZAAAAAAA', '', 42, null, 'ZZ-A', 'ZZAA', 'ZZAC'], false, {
        waypoints: [
          { ident: 'ZZWPT', region: null },
          { ident: 'zzwpt' },
          { ident: 'ZZWPU', region: 'z z' },
          'ZZWPV',
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.demand.airports).toEqual(['ZZAA', 'ZZAC']);
    expect(parsed.droppedAirports).toBe(6);
    expect(parsed.demand.waypoints).toEqual([{ ident: 'ZZWPT', region: null }]);
    expect(parsed.droppedWaypoints).toBe(3);
  });
});

// ── the cadence ───────────────────────────────────────────────────────────────

describe('polling cadence', () => {
  it('polls at once on start and then every 60 s while the list is quiet', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const demand = newDemand({ client });
    demand.start();
    await settle();
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS - 1);
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toBe(2);
  });

  it('backs off doubling to 600 s on failure and returns to 60 s on the first success', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(
      TRANSPORT_DOWN,
      ok({ error: 'boom' }, 500),
      TRANSPORT_DOWN,
      TRANSPORT_DOWN,
      TRANSPORT_DOWN,
      ok(body([])),
      TRANSPORT_DOWN,
    );
    const demand = newDemand({ client });
    demand.start();
    await settle();
    expect(client.calls).toBe(1);

    const gaps = [120_000, 240_000, 480_000, 600_000, 600_000];
    for (const gap of gaps) {
      const before = client.calls;
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(client.calls).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.calls).toBe(before + 1);
    }
    // That last one succeeded, so the next is back at the healthy interval.
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(gaps.length + 2);
    // And that one failed: the count started again from nothing.
    await vi.advanceTimersByTimeAsync(120_000 - 1);
    expect(client.calls).toBe(gaps.length + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toBe(gaps.length + 3);
    // The same failure is one line, not one per try: three runs of it here,
    // split by the 500 and by the success.
    expect(logged.filter((line) => line.includes('ECONNREFUSED'))).toHaveLength(3);
  });

  it('treats a malformed answer as a failure, in one line that quotes nothing from it', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok({ v: 1, airports: [SENTINEL_TOKEN], waypoints: [], more: false, secret: SENTINEL_TOKEN }));
    const demand = newDemand({ client });
    demand.start();
    await settle();
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(2);
    expect(logged).toEqual(["warn navdata: the server's demand list was malformed (cap is missing or invalid)"]);
    expect(demand.pending()).toBe(0);
  });

  it('waits out a busy server as told, without counting it as a failure', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(
      { kind: 'response', status: 503, code: 'NAVDATA_BUSY', retryAfterMs: 7000, body: { code: 'NAVDATA_BUSY' } },
      TRANSPORT_DOWN,
    );
    const demand = newDemand({ client });
    demand.start();
    await settle();
    await vi.advanceTimersByTimeAsync(6999);
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toBe(2);
    // One failure since the busy answer, so 120 s rather than 240 s.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.calls).toBe(3);
    expect(logged.some((line) => line.startsWith('warn') && line.includes('busy'))).toBe(false);
  });

  it('gives a busy server that says Retry-After: 0 a second before asking again', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push({ kind: 'response', status: 503, code: 'NAVDATA_BUSY', retryAfterMs: 0, body: null });
    const demand = newDemand({ client });
    demand.start();
    await settle();
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(NAVDATA_BUSY_MIN_MS - 1);
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toBe(2);
  });

  it('does not poll while the uplink is stopped, or before it has started', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const demand = newDemand({ client });
    await vi.advanceTimersByTimeAsync(10 * NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(0);

    demand.start();
    await flush();
    expect(client.calls).toBe(1);
    demand.stop();
    await vi.advanceTimersByTimeAsync(20 * NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(1);
  });

  it('does not ask while there is no store or no server to ask', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    let store: NavdataStore | null = null;
    let transport: NavdataTransport | null = transportFor('http://127.0.0.1:9');
    const demand = newDemand({ client, store: () => store, transport: () => transport });
    demand.start();
    await vi.advanceTimersByTimeAsync(3 * NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(0);

    store = fakeStore().store;
    transport = null;
    await vi.advanceTimersByTimeAsync(3 * NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(0);

    transport = transportFor('http://127.0.0.1:9');
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(1);
  });

  it('keeps no timer the process would wait on', async () => {
    // Only what the module under test creates: the runner schedules its own.
    // Each is looked at once the code that made it has had its synchronous
    // turn, which is when an unref would have happened, and before an
    // immediate could have fired.
    const refs: { kind: 'timeout' | 'immediate'; refed: boolean }[] = [];
    const ours = (): boolean => (new Error().stack ?? '').includes('navdata-demand.ts');
    const realSetTimeout = globalThis.setTimeout;
    const realSetImmediate = globalThis.setImmediate;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = realSetTimeout(...args);
      if (ours()) queueMicrotask(() => refs.push({ kind: 'timeout', refed: timer.hasRef() }));
      return timer;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((...args: Parameters<typeof setImmediate>) => {
      const immediate = realSetImmediate(...args);
      if (ours()) queueMicrotask(() => refs.push({ kind: 'immediate', refed: immediate.hasRef() }));
      return immediate;
    }) as typeof setImmediate);

    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA'])));
    const { session } = fakeSession();
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'detail'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await until(() => fetchDetail.mock.calls.length === 1 && demand.pending() === 0);
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    vi.restoreAllMocks();

    // The poll timers, and the turn yielded after the airport.
    expect(refs.filter((entry) => entry.kind === 'timeout').length).toBeGreaterThanOrEqual(2);
    expect(refs.filter((entry) => entry.kind === 'immediate').length).toBeGreaterThanOrEqual(1);
    expect(refs.filter((entry) => entry.refed)).toEqual([]);
  });
});

// ── a truncated list ──────────────────────────────────────────────────────────

describe('a truncated list', () => {
  it('is read again at once while it brings new work, and not while it repeats itself', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(
      ok(body(['ZZAA', 'ZZAB'], true, { cap: 2 })),
      ok(body(['ZZAC', 'ZZAD'], true, { cap: 2 })),
      ok(body(['ZZAC', 'ZZAD'], true, { cap: 2 })),
    );
    // No session: nothing is fetched, so the queue only grows.
    const demand = newDemand({ client });
    demand.start();
    await flush();
    expect(client.calls).toBe(3);
    expect(demand.pending()).toBe(4);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS - 100);
    expect(client.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.calls).toBe(4);
  });

  it('stops asking at once when the queue reaches the high-water mark, and holds no more than that', async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: DEMAND_QUEUE_HIGH_WATER + 50 }, (_, i) => `ZZ${i.toString(36).toUpperCase()}`);
    const client = new FakeClient();
    client.replies.push(ok(body(many, true, { cap: many.length })));
    const demand = newDemand({ client });
    demand.start();
    await flush();
    expect(client.calls).toBe(1);
    expect(demand.pending()).toBe(DEMAND_QUEUE_HIGH_WATER);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(2);
  });

  it('never takes more airports from one answer than the cap it declares', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA', 'ZZAB', 'ZZAC'], false, { cap: 2 })));
    const demand = newDemand({ client });
    demand.start();
    await flush();
    expect(demand.pending()).toBe(2);
  });

  it('is read again as soon as the queue it was waiting on has drained', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA'], true, { cap: 1 })), ok(body(['ZZAA'], true, { cap: 1 })));
    const { store, detail } = fakeStore();
    const { session } = fakeSession();
    let release: () => void = () => undefined;
    const fetchDetail = vi.fn<FetchDetail>(
      (_s, _st, _d, ident) =>
        new Promise<AirportDetailResult>((resolve) => {
          release = () => {
            detail.add(ident);
            resolve(result(ident, 'detail'));
          };
        }),
    );
    const demand = newDemand({ client, store: () => store, session: () => session, fetchDetail });
    demand.start();
    await flush();
    // The second page repeated the first while it was still being fetched.
    expect(client.calls).toBe(2);
    expect(demand.pending()).toBe(1);
    release();
    await flush();
    expect(demand.pending()).toBe(0);
    expect(client.calls).toBe(3);
    // And that read found nothing new, so it is back to the normal interval.
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS - 100);
    expect(client.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.calls).toBe(4);
  });
});

// ── dedupe ────────────────────────────────────────────────────────────────────

describe('what is already known', () => {
  it('costs a lookup and no request: held in detail, held as absent, or already queued', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(
      ok(body(['ZZAA', 'ZZAB', 'ZZAC', 'ZZAC'])),
      ok(body(['ZZAA', 'ZZAB', 'ZZAC'])),
    );
    const { store, detail, absent } = fakeStore();
    detail.add('ZZAA');
    absent.add('ZZAB');
    let session: FacilitySession | null = null;
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'detail'));
    const demand = newDemand({ client, store: () => store, session: () => session, fetchDetail });
    demand.start();
    await flush();
    expect(demand.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(2);
    expect(demand.pending()).toBe(1);

    session = fakeSession().session;
    demand.wake();
    await flush();
    expect(fetchDetail.mock.calls.map((call) => call[3])).toEqual(['ZZAC']);
    expect(demand.pending()).toBe(0);
  });

  it('checks again before fetching, in case the store learned it meanwhile', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA', 'ZZAB'])));
    const { store, detail } = fakeStore();
    let session: FacilitySession | null = null;
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'detail'));
    const demand = newDemand({ client, store: () => store, session: () => session, fetchDetail });
    demand.start();
    await flush();
    detail.add('ZZAA');
    session = fakeSession().session;
    demand.wake();
    await flush();
    expect(fetchDetail.mock.calls.map((call) => call[3])).toEqual(['ZZAB']);
  });

  it('fetches one airport at a time and prepares the definition once per session', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA', 'ZZAB', 'ZZAC'])));
    const { session, prepares } = fakeSession();
    let out = 0;
    let most = 0;
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => {
      out++;
      most = Math.max(most, out);
      await Promise.resolve();
      out--;
      return result(ident, 'detail');
    });
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    expect(fetchDetail).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
    expect(prepares()).toBe(1);
  });

  it('says how many fixes the server wants when that changes, and fetches none of them', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const wp = [{ ident: 'ZZWPA' }, { ident: 'ZZWPB', region: 'ZZ' }];
    client.replies.push(
      ok(body([], false, { waypoints: wp })),
      ok(body([], false, { waypoints: wp })),
      ok(body([], false, { waypoints: [] })),
    );
    const demand = newDemand({ client });
    demand.start();
    await flush();
    await vi.advanceTimersByTimeAsync(2 * NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(3);
    expect(logged.filter((line) => line.includes('fix(es) in detail'))).toEqual([
      'info navdata: the server wants 2 fix(es) in detail; this build fetches airports only',
      'info navdata: the server wants 0 fix(es) in detail; this build fetches airports only',
    ]);
    expect(demand.pending()).toBe(0);
  });
});

// ── faults and disconnects ────────────────────────────────────────────────────

describe('an airport that keeps failing', () => {
  it('is set aside after consecutive aborts on a live link, with one log line', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA', 'ZZAB'])));
    client.fallback = ok(body(['ZZAA']));
    const { session } = fakeSession();
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) =>
      result(ident, ident === 'ZZAA' ? 'aborted' : 'detail'),
    );
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    const tries = (): number => fetchDetail.mock.calls.filter((call) => call[3] === 'ZZAA').length;
    expect(tries()).toBe(DEMAND_FAULT_PARK_AFTER);
    expect(demand.pending()).toBe(0);
    // The other airport was not held up behind it.
    expect(fetchDetail.mock.calls.some((call) => call[3] === 'ZZAB')).toBe(true);

    // The server keeps naming it; it is not fetched again.
    await vi.advanceTimersByTimeAsync(3 * NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBe(4);
    expect(tries()).toBe(DEMAND_FAULT_PARK_AFTER);
    expect(logged.filter((line) => line.includes('set aside'))).toHaveLength(1);
  });

  it('gives a parked airport one fresh chance on a new connection, and parks it again if it still fails', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.fallback = ok(body(['ZZAA']));
    const first = fakeSession();
    let session: FacilitySession | null = first.session;
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'failed'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    await vi.advanceTimersByTimeAsync(3 * NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(DEMAND_FAULT_PARK_AFTER);

    // Parked for the rest of this connection, however often it is named.
    await vi.advanceTimersByTimeAsync(3 * NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(DEMAND_FAULT_PARK_AFTER);

    // A disconnect alone is not a new connection.
    session = null;
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    session = first.session;
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(DEMAND_FAULT_PARK_AFTER);

    // A new session: the next poll's naming of it is fetched, with a fresh count.
    session = fakeSession().session;
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(DEMAND_FAULT_PARK_AFTER + 1);
    expect(fetchDetail.mock.calls.at(-1)?.[0]).toBe(session);
    await vi.advanceTimersByTimeAsync(5 * NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(2 * DEMAND_FAULT_PARK_AFTER);
    expect(logged.filter((line) => line.includes('ZZAA is set aside'))).toHaveLength(2);
    expect(logged.filter((line) => line.includes('1 parked airport(s) a fresh chance'))).toHaveLength(1);
  });

  it('gives a parked airport a fresh chance when the store changes too', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.fallback = ok(body(['ZZAA']));
    const { session } = fakeSession();
    let store = fakeStore().store;
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'undecodable'));
    const demand = newDemand({ client, session: () => session, store: () => store, fetchDetail });
    demand.start();
    await flush();
    await vi.advanceTimersByTimeAsync(4 * NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(DEMAND_FAULT_PARK_AFTER);

    store = fakeStore().store;
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(DEMAND_FAULT_PARK_AFTER + 1);
  });

  it('does not hold a dropped link against the airport', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA'])));
    const { session, link } = fakeSession();
    let drops = 0;
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => {
      if (drops < 5) {
        drops++;
        link.open = false;
        return result(ident, 'aborted');
      }
      return result(ident, 'detail');
    });
    const demand = newDemand({ client, session: () => (link.open ? session : null), fetchDetail });
    demand.start();
    for (let i = 0; i < 5; i++) {
      await flush();
      // Back on the queue, waiting for a connection.
      expect(demand.pending()).toBe(1);
      link.open = true;
      demand.wake();
    }
    await flush();
    expect(fetchDetail).toHaveBeenCalledTimes(6);
    expect(demand.pending()).toBe(0);
    expect(logged.some((line) => line.includes('set aside'))).toBe(false);
  });

  it('counts only faults: disconnects in between neither count nor reset', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA'])));
    const { session, link } = fakeSession();
    // fault, drop, fault, drop, fault -> set aside on the third fault.
    const script: ('fault' | 'drop')[] = ['fault', 'drop', 'fault', 'drop', 'fault', 'drop'];
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => {
      const step = script.shift();
      if (step === 'drop') link.open = false;
      return result(ident, 'aborted');
    });
    const demand = newDemand({ client, session: () => (link.open ? session : null), fetchDetail });
    demand.start();
    for (let i = 0; i < 6; i++) {
      await flush();
      link.open = true;
      demand.wake();
    }
    await flush();
    expect(fetchDetail).toHaveBeenCalledTimes(5);
    expect(demand.pending()).toBe(0);
    expect(logged.filter((line) => line.includes('ZZAA is set aside after 3 attempts'))).toHaveLength(1);
  });

  it('forgets earlier faults once an airport succeeds', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    // The server goes on naming it: the fake store never learns the detail.
    client.fallback = ok(body(['ZZAA']));
    const { session } = fakeSession();
    const script: AirportDetailStatus[] = ['aborted', 'aborted', 'detail', 'aborted', 'aborted', 'detail'];
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, script.shift() ?? 'detail'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    expect(fetchDetail).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    // Four aborts in all, never three in a row.
    expect(fetchDetail).toHaveBeenCalledTimes(6);
    expect(logged.some((line) => line.includes('set aside'))).toBe(false);
  });

  it('sets aside at the limit even when the faults are of different kinds', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.fallback = ok(body(['ZZAA']));
    const { session } = fakeSession();
    const script: AirportDetailStatus[] = ['aborted', 'aborted', 'failed'];
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, script.shift() ?? 'detail'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    expect(fetchDetail).toHaveBeenCalledTimes(3);
    expect(logged.filter((line) => line.includes('ZZAA is set aside after 3 attempts'))).toHaveLength(1);
  });

  it('counts a failed, undecodable or ambiguous answer without re-queueing it', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.fallback = ok(body(['ZZAA']));
    const { session } = fakeSession();
    const script: AirportDetailStatus[] = ['failed', 'undecodable', 'ambiguous'];
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, script.shift() ?? 'detail'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    // One try per poll, not a loop.
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3 * NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(3);
  });

  it('keeps going when a fetch throws, counts it, and says why by its code', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA', 'ZZAB'])));
    client.fallback = ok(body(['ZZAA']));
    const { session } = fakeSession();
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => {
      if (ident === 'ZZAA') throw Object.assign(new Error('C:\\somewhere\\navdata.db is locked'), { code: 'SQLITE_BUSY' });
      return result(ident, 'detail');
    });
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    // Not re-queued on the spot: once per poll.
    expect(fetchDetail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * NAVDATA_DEMAND_POLL_MS);
    expect(fetchDetail).toHaveBeenCalledTimes(4);
    const aside = logged.filter((line) => line.includes('ZZAA is set aside'));
    expect(aside).toHaveLength(1);
    expect(aside[0]).toContain('SQLITE_BUSY');
    expect(logged.join('\n')).not.toContain('somewhere');
  });
});

// ── the collision count ───────────────────────────────────────────────────────

describe('the collision note', () => {
  it('is null until a fetch separates procedures, then counts them and their airports', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZAA', 'ZZAB', 'ZZAC'])));
    const { session } = fakeSession();
    const collisions: Record<string, number> = { ZZAA: 2, ZZAB: 0, ZZAC: 1 };
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) =>
      result(ident, 'detail', { collisions: collisions[ident] }),
    );
    const demand = newDemand({ client, session: () => session, fetchDetail });
    expect(demand.note()).toBeNull();
    demand.start();
    await flush();
    expect(demand.note()).toBe('3 procedure(s) at 2 airport(s) shared a key with another and were stored apart');
  });
});

// ── through the real session and the real store ───────────────────────────────

describe('against a real session and store', () => {
  function realStore(): NavdataStore {
    const store = openFixtureStore(scratchDir());
    stores.push(store);
    store.write((tx) => tx.upsert('nav_airport', { ident: 'ZZQX', detail_state: 'index' }));
    return store;
  }

  function realSession(handle: FakeFacilityConnection): FacilitySession {
    const session = new FacilitySession(handle as never, { settleMs: 1 });
    sessions.push(session);
    return session;
  }

  it('records an airport the simulator refuses as absent, in the row stream, and does not ask again', async () => {
    const store = realStore();
    const handle = new FakeFacilityConnection();
    const session = realSession(handle);
    const client = new FakeClient();
    client.fallback = ok(body(['ZZQX']));
    const demand = newDemand({ client, store: () => store, session: () => session, fetchDetail: fetchAirportDetail });
    demand.start();
    await until(() => handle.dataRequests.length === 1);
    // What an airport this install does not have answers with, at once.
    handle.emitException(handle.dataRequests[0].sendId, 'ERROR', 1, 3);
    await until(() => demand.pending() === 0);

    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZQX', region: '' })?.reason).toBe('exception');
    const reader = openNavdataReader(store.path);
    try {
      reader.begin();
      const batch = buildBatch(reader, 0, { maxRows: NAVDATA_BATCH_MAX_ROWS, maxBytes: NAVDATA_BATCH_MAX_BYTES });
      expect(batch?.rows.some((row) => row.t === 'absent' && row.r.ident === 'ZZQX')).toBe(true);
    } finally {
      reader.close();
    }

    // The server has not replicated it yet and names it again: no request.
    demand.onConfigApplied();
    await until(() => client.calls >= 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.dataRequests).toHaveLength(1);
    expect(demand.pending()).toBe(0);
  });

  it('parks an airport whose decoder throws on a live link, and writes nothing for it', async () => {
    const store = realStore();
    const handle = new FakeFacilityConnection();
    const session = realSession(handle);
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZQX'])));
    const demand = newDemand({ client, store: () => store, session: () => session, fetchDetail: fetchAirportDetail });
    demand.start();
    for (let attempt = 1; attempt <= DEMAND_FAULT_PARK_AFTER; attempt++) {
      await until(() => handle.dataRequests.length === attempt);
      handle.emitRecord(handle.dataRequests[attempt - 1].requestId, 0, 1, 0, throwingReader());
    }
    await until(() => logged.some((line) => line.includes('ZZQX is set aside')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.dataRequests).toHaveLength(DEMAND_FAULT_PARK_AFTER);
    expect(demand.pending()).toBe(0);
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZQX', region: '' })).toBeNull();
    expect(store.row('nav_airport', { ident: 'ZZQX' })?.detail_state).toBe('index');
  });

  it('puts an airport cut off by a disconnect back on the queue, uncounted', async () => {
    const store = realStore();
    const handle = new FakeFacilityConnection();
    let session: FacilitySession | null = realSession(handle);
    const client = new FakeClient();
    client.replies.push(ok(body(['ZZQX'])));
    const demand = newDemand({ client, store: () => store, session: () => session, fetchDetail: fetchAirportDetail });
    demand.start();
    await until(() => handle.dataRequests.length === 1);
    const dropped = session;
    session = null;
    dropped?.close('SimConnect disconnected');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(demand.pending()).toBe(1);
    expect(store.row('nav_absent', { kind: 'A', ident: 'ZZQX', region: '' })).toBeNull();
    expect(store.row('nav_airport', { ident: 'ZZQX' })?.detail_state).toBe('index');

    // A new connection prepares its own definition and picks the airport up.
    const again = new FakeFacilityConnection();
    session = realSession(again);
    demand.wake();
    await until(() => again.dataRequests.length === 1);
    expect(again.definitionSends.length).toBeGreaterThan(0);
    expect(logged.some((line) => line.includes('set aside'))).toBe(false);
  });
});

// ── the request itself ────────────────────────────────────────────────────────

describe('the demand request', () => {
  it('is a GET with the token in the header and nowhere else, and never follows a redirect', async () => {
    const server = await startNavdataServer({
      [`GET ${NAVDATA_DEMAND_PATH}`]: () => ({ status: 200, body: body(['ZZAA']) }),
    });
    servers.push(server);
    const client = new NavdataSyncClient(() => transportFor(server.baseUrl));
    const outcome = await client.getDemand();
    expect(outcome).toMatchObject({ kind: 'response', status: 200 });
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request.method).toBe('GET');
    expect(request.path).toBe(NAVDATA_DEMAND_PATH);
    expect(request.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
    expect(request.body.length).toBe(0);

    server.routes[`GET ${NAVDATA_DEMAND_PATH}`] = () => ({
      status: 302,
      headers: { location: `${server.baseUrl}/elsewhere` },
    });
    const redirected = await client.getDemand();
    expect(redirected).toMatchObject({ kind: 'response', status: 302 });
    expect(server.requests).toHaveLength(2);
  });

  it('keeps the token and the body out of every log line, whatever the server answers', async () => {
    let reply: { status: number; body?: unknown } = { status: 500, body: { error: SENTINEL_TOKEN } };
    const server = await startNavdataServer({ [`GET ${NAVDATA_DEMAND_PATH}`]: () => reply });
    servers.push(server);
    const demand = newDemand({ transport: () => transportFor(server.baseUrl) });
    demand.start();
    await until(() => server.requests.length === 1 && logged.length > 0);
    reply = { status: 200, body: { v: 1, airports: [SENTINEL_TOKEN.toLowerCase()], waypoints: [], cap: 5, more: false } };
    demand.onConfigApplied();
    await until(() => server.requests.length === 2 && logged.length > 1);
    expect(logged.join('\n')).not.toContain(SENTINEL_TOKEN);
    expect(logged.join('\n').toLowerCase()).not.toContain(SENTINEL_TOKEN.toLowerCase());
    expect(logged[0]).toBe('warn navdata: the demand list was refused (HTTP 500)');
  });
});

// ── telling the server what is parked ─────────────────────────────────────────

describe('the skip list', () => {
  it('builds the query with URLSearchParams and leaves an empty list out', () => {
    expect(demandPath()).toBe(NAVDATA_DEMAND_PATH);
    expect(demandPath({ airports: [], waypoints: [] })).toBe(NAVDATA_DEMAND_PATH);
    expect(demandPath({ airports: ['ZZAA', 'ZZAB'] })).toBe(`${NAVDATA_DEMAND_PATH}?skipAirports=ZZAA%2CZZAB`);
    expect(demandPath({ waypoints: ['ZZWPA'] })).toBe(`${NAVDATA_DEMAND_PATH}?skipWaypoints=ZZWPA`);
    // Nothing in a value can change the shape of the URL.
    const odd = new URL(`http://127.0.0.1${demandPath({ airports: ['ZZ&x=1#'] })}`);
    expect([...odd.searchParams.keys()]).toEqual(['skipAirports']);
    expect(odd.searchParams.get('skipAirports')).toBe('ZZ&x=1#');
  });

  it('is not sent while nothing is parked', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.fallback = ok(body(['ZZAA']));
    const { session } = fakeSession();
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'detail'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.calls).toBeGreaterThanOrEqual(2);
    expect(client.skips.every((skip) => skip === undefined)).toBe(true);
  });

  it('names the parked airports, sorted, on every poll after they are parked', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.fallback = ok(body(['ZZAD', 'ZZAC', 'ZZAB']));
    const { session } = fakeSession();
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) =>
      result(ident, ident === 'ZZAB' ? 'detail' : 'aborted'),
    );
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    expect(client.skips).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.skips.slice(1)).toEqual([{ airports: ['ZZAC', 'ZZAD'] }, { airports: ['ZZAC', 'ZZAD'] }]);
  });

  it(`never names more than ${DEMAND_SKIP_MAX}, cuts the list the same way each time, and says so once`, async () => {
    vi.useFakeTimers();
    const many = Array.from({ length: DEMAND_SKIP_MAX + 50 }, (_, i) => `ZZ${String(1000 + i)}`);
    // Handed out in reverse, so sorting is what puts them in order.
    const client = new FakeClient();
    client.fallback = ok(body([...many].reverse(), false, { cap: many.length }));
    const { session } = fakeSession();
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'aborted'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    const [third, fourth] = client.skips.slice(2);
    expect(third?.airports).toEqual([...many].sort().slice(0, DEMAND_SKIP_MAX));
    expect(fourth).toEqual(third);
    expect(logged.filter((line) => line.includes('the server is told about the first'))).toEqual([
      `warn navdata: ${many.length} airports are set aside; the server is told about the first ${DEMAND_SKIP_MAX}`,
    ]);
  });

  it('is dropped once a new connection forgives what was parked', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.fallback = ok(body(['ZZAA']));
    let session: FacilitySession | null = fakeSession().session;
    const fetchDetail = vi.fn<FetchDetail>(async (_s, _st, _d, ident) => result(ident, 'aborted'));
    const demand = newDemand({ client, session: () => session, fetchDetail });
    demand.start();
    await flush();
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.skips.at(-1)).toEqual({ airports: ['ZZAA'] });

    session = fakeSession().session;
    await vi.advanceTimersByTimeAsync(NAVDATA_DEMAND_POLL_MS);
    expect(client.skips.at(-1)).toBeUndefined();
  });

  it('reaches the server as one URL-encoded parameter, with the token still only in the header', async () => {
    const server = await startNavdataServer({});
    servers.push(server);
    const client = new NavdataSyncClient(() => transportFor(server.baseUrl));
    await client.getDemand({ airports: ['ZZAB', 'ZZAC'] });
    await client.getDemand();
    expect(server.requests.map((request) => request.path)).toEqual([
      `${NAVDATA_DEMAND_PATH}?skipAirports=ZZAB%2CZZAC`,
      NAVDATA_DEMAND_PATH,
    ]);
    for (const request of server.requests) {
      expect(request.path).not.toContain(SENTINEL_TOKEN);
      expect(request.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
    }
  });

  it('backs off on a 400 NAVDATA_BAD_BATCH like any other failure, naming the code and not the body', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.replies.push({
      kind: 'response',
      status: 400,
      code: 'NAVDATA_BAD_BATCH',
      retryAfterMs: null,
      body: { ok: false, code: 'NAVDATA_BAD_BATCH', message: `skip list refused ${SENTINEL_TOKEN}` },
    });
    const demand = newDemand({ client });
    demand.start();
    await settle();
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000 - 1);
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toBe(2);
    expect(logged).toEqual(['warn navdata: the demand list was refused (HTTP 400 NAVDATA_BAD_BATCH)']);
  });
});
