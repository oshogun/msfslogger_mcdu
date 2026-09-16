// tests/datalink-service.test.ts — tests src/datalink-service.ts.
//
// The schedule is driven by fake timers and a scripted client, so intervals,
// backoff, the invalid-token latch, lease expiry and refresh coalescing are all
// asserted in exact milliseconds and exact request counts. The load sheet and
// weather ops also run against a scratch HTTP server through the real client.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpOutcome } from '../src/datalink-classify';
import { DatalinkClient, type DatalinkRoute } from '../src/datalink-client';
import {
  DatalinkService,
  nextPollDelayMs,
  DATALINK_POLL_INTERVAL_MS,
  type DatalinkRequester,
} from '../src/datalink-service';
import type { DatalinkOutcome, DatalinkRequestMessage, DatalinkStateMessage } from '../src/protocol';
import { Uplink } from '../src/uplink';
import {
  fixture,
  reply,
  scratchConfig,
  SENTINEL_TOKEN,
  startScratchServer,
} from './helpers/datalink-scratch-server';

type Responder = (route: DatalinkRoute) => HttpOutcome | Promise<HttpOutcome>;

function ok(body: unknown, status = 200): HttpOutcome {
  return { kind: 'response', status, scopeHeader: null, bodyText: JSON.stringify(body), bodyTooLarge: false };
}
function fromFixture(name: string): HttpOutcome {
  const { response } = fixture(name);
  const scope = Object.entries(response.headers).find(([k]) => k.toLowerCase() === 'x-ingest-token-scope');
  return {
    kind: 'response',
    status: response.status,
    scopeHeader: scope ? scope[1] : null,
    bodyText: JSON.stringify(response.body),
    bodyTooLarge: false,
  };
}
const UNREACHABLE: HttpOutcome = { kind: 'transport', errorName: 'TypeError', errorCode: 'ECONNREFUSED' };

function threadBody(ids: number[], plannedLegId: number | null = 12) {
  return {
    flight_id: 92,
    planned_leg_id: plannedLegId,
    messages: ids.map((id) => ({
      id, flight_id: 92, planned_leg_id: null, direction: 'uplink', category: 'wx', label: `M${id}`,
      body: `BODY ${id}`, payload_json: null, correlation_id: null, dedup_key: null,
      sent_at: '2026-09-16T12:00:00.000Z', read_at: null,
    })),
  };
}

/** Flying, flight 92, with the thread given by `ids`. */
function flyingServer(ids: () => number[]): Responder {
  return (route) => {
    if (route.key === 'status') return fromFixture('01a-get-status-flying');
    if (route.key === 'flight-thread') return ok(threadBody(ids()));
    return ok({}, 599);
  };
}

class ScriptedClient implements DatalinkRequester {
  routes: DatalinkRoute[] = [];
  times: number[] = [];
  constructor(public respond: Responder) {}
  async request(route: DatalinkRoute): Promise<HttpOutcome> {
    this.routes.push(route);
    this.times.push(Date.now());
    return this.respond(route);
  }
  count(key: DatalinkRoute['key']): number {
    return this.routes.filter((r) => r.key === key).length;
  }
}

let states: DatalinkStateMessage[];
let logs: string[];
let hasConfig: boolean;

function makeService(client: DatalinkRequester, token: string = SENTINEL_TOKEN): DatalinkService {
  return new DatalinkService({
    client,
    hasConfig: () => hasConfig,
    token: () => token,
    emitState: (message) => states.push(message),
    log: (level, message) => logs.push(`${level} ${message}`),
  });
}

let nextId = 1;
function req<K extends DatalinkRequestMessage['op']>(
  op: K,
  params: Extract<DatalinkRequestMessage, { op: K }>['params'],
): DatalinkRequestMessage {
  return { v: 1, type: 'datalink-request', id: `dl-${nextId++}`, op, params } as DatalinkRequestMessage;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const last = () => states[states.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  states = [];
  logs = [];
  hasConfig = true;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('schedule and backoff', () => {
  it('nextPollDelayMs is 20 s healthy, then 40/80/120/120 s', () => {
    expect(DATALINK_POLL_INTERVAL_MS).toBe(20000);
    expect([0, 1, 2, 3, 4, 10, 1000].map(nextPollDelayMs)).toEqual([20000, 40000, 80000, 120000, 120000, 120000, 120000]);
  });

  it('polls every 20 000 ms while healthy', async () => {
    const client = new ScriptedClient(flyingServer(() => [1, 2]));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(client.routes.map((r) => r.key)).toEqual(['status', 'flight-thread']);
    expect(last()).toMatchObject({ state: 'dl.ok', watching: true, nextPollAt: 1_000_000 + 20000 });

    await vi.advanceTimersByTimeAsync(19999);
    expect(client.count('status')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.count('status')).toBe(2);
  });

  it.each([
    ['unreachable', UNREACHABLE, 'dl.unreachable'],
    ['unavailable (401, no scope header)', fromFixture('err-401-pre-upgrade-no-scope-header'), 'dl.unavailable'],
  ])('backs off 40/80/120/120 s after %s', async (_name, outcome, state) => {
    const client = new ScriptedClient(() => outcome);
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(last()).toMatchObject({ state, nextPollAt: 1_000_000 + 40000 });
    // Keep the lease alive the way a showing DATALINK page does.
    for (let i = 0; i < 20; i++) {
      await service.handle(req('watch', { on: true }));
      await vi.advanceTimersByTimeAsync(20000);
    }
    const gaps = client.times.slice(1, 5).map((t, i) => t - client.times[i]);
    expect(gaps).toEqual([40000, 80000, 120000, 120000]);
  });

  it('recovers from backoff to the 20 s interval after a good cycle', async () => {
    let down = true;
    const good = flyingServer(() => [1]);
    const client = new ScriptedClient((route) => (down ? UNREACHABLE : good(route)));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    down = false;
    await service.handle(req('watch', { on: true }));
    await vi.advanceTimersByTimeAsync(40000);
    expect(last()).toMatchObject({ state: 'dl.ok', nextPollAt: Date.now() + 20000 });
  });
});

describe('invalid-token latch', () => {
  it('makes no request of any kind until a valid config reload', async () => {
    const client = new ScriptedClient(() => fromFixture('err-401-invalid-token'));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(last()).toMatchObject({
      state: 'dl.token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN', nextPollAt: null,
    });
    const made = client.routes.length;
    expect(made).toBe(1);

    const refused = { ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' } };
    for (let i = 0; i < 10; i++) {
      await service.handle(req('watch', { on: true }));
      await vi.advanceTimersByTimeAsync(60000);
    }
    expect(await service.handle(req('refresh', {}))).toEqual(refused);
    expect(await service.handle(req('canned-list', {}))).toEqual(refused);
    expect(await service.handle(req('send-canned', { target: { kind: 'flight', id: 92 }, cannedId: 'any' }))).toEqual(refused);
    expect(await service.handle(req('wx', { target: { kind: 'flight', id: 92 }, icao: 'EGLL' }))).toEqual(refused);
    expect(await service.handle(req('loadsheet', { plannedLegId: 12 }))).toEqual(refused);
    service.onConfigApplied(false);
    await vi.advanceTimersByTimeAsync(300000);
    expect(client.routes.length).toBe(made);

    client.respond = flyingServer(() => [1]);
    await service.handle(req('watch', { on: true }));
    expect(client.routes.length).toBe(made);
    service.onConfigApplied(true);
    await flush();
    expect(client.routes.length).toBe(made + 2);
    expect(last()).toMatchObject({ state: 'dl.ok' });
  });

  it('is also set by an op, and stops the poll schedule', async () => {
    const good = flyingServer(() => [1]);
    const client = new ScriptedClient((route) =>
      route.key === 'canned-list' ? fromFixture('err-401-invalid-token') : good(route));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(await service.handle(req('canned-list', {}))).toMatchObject({ ok: false, error: { code: 'token-invalid' } });
    expect(last()).toMatchObject({ state: 'dl.token-invalid', nextPollAt: null });
    const made = client.routes.length;
    await service.handle(req('watch', { on: true }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.routes.length).toBe(made);
  });

  it('keeps token-invalid when a poll in flight fails otherwise after an op latched', async () => {
    let releaseStatus: (() => void) | null = null;
    let holdStatus = true;
    const good = flyingServer(() => [1]);
    const client = new ScriptedClient(async (route) => {
      if (route.key === 'canned-list') return fromFixture('err-401-invalid-token');
      if (route.key === 'status' && holdStatus) {
        await new Promise<void>((resolve) => { releaseStatus = resolve; });
        return UNREACHABLE;
      }
      return good(route);
    });
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(client.routes.map((r) => r.key)).toEqual(['status']);

    expect(await service.handle(req('canned-list', {}))).toMatchObject({ ok: false, error: { code: 'token-invalid' } });
    expect(last()).toMatchObject({ state: 'dl.token-invalid', nextPollAt: null });
    releaseStatus!();
    await flush();
    expect(last()).toMatchObject({
      state: 'dl.token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN', nextPollAt: null,
    });
    expect(logs.some((line) => line.includes('dl.unreachable'))).toBe(false);

    const made = client.routes.length;
    for (let i = 0; i < 10; i++) {
      await service.handle(req('watch', { on: true }));
      await vi.advanceTimersByTimeAsync(60000);
    }
    expect(await service.handle(req('refresh', {}))).toMatchObject({ ok: false, error: { code: 'token-invalid' } });
    expect(last()).toMatchObject({ state: 'dl.token-invalid' });
    expect(client.routes.length).toBe(made);

    holdStatus = false;
    await service.handle(req('watch', { on: true }));
    service.onConfigApplied(true);
    await flush();
    expect(client.routes.slice(made).map((r) => r.key)).toEqual(['status', 'flight-thread']);
    expect(last()).toMatchObject({ state: 'dl.ok' });
  });
});

describe('a token that is a substring of a real server code', () => {
  it('INGEST_TOKEN: a 401 INVALID_INGEST_TOKEN still latches, and the emitted serverCode is null', async () => {
    const client = new ScriptedClient(() => fromFixture('err-401-invalid-token'));
    const service = makeService(client, 'INGEST_TOKEN');
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(last()).toMatchObject({ state: 'dl.token-invalid', httpStatus: 401, serverCode: null, nextPollAt: null });
    expect(client.routes).toHaveLength(1);

    const refused = { ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: null } };
    for (let i = 0; i < 10; i++) {
      await service.handle(req('watch', { on: true }));
      await vi.advanceTimersByTimeAsync(60000);
    }
    expect(await service.handle(req('refresh', {}))).toEqual(refused);
    expect(await service.handle(req('loadsheet', { plannedLegId: 12 }))).toEqual(refused);
    service.onConfigApplied(false);
    await vi.advanceTimersByTimeAsync(300000);
    expect(client.routes).toHaveLength(1);
    for (const line of [...logs, JSON.stringify(states)]) expect(line).not.toContain('INGEST_TOKEN');

    await service.handle(req('watch', { on: true }));
    service.onConfigApplied(true);
    await flush();
    expect(client.routes).toHaveLength(2);
  });

  it('DISPATCH_DATA: a 409 NO_DISPATCH_DATA on the load sheet is still no-dispatch-data, with serverCode null', async () => {
    const client = new ScriptedClient(() => fromFixture('err-409-no-dispatch-data'));
    const service = makeService(client, 'DISPATCH_DATA');
    expect(await service.handle(req('loadsheet', { plannedLegId: 12 }))).toEqual({
      ok: false, error: { code: 'no-dispatch-data', httpStatus: 409, serverCode: null },
    });
    expect(states).toEqual([]);
  });
});

describe('lease', () => {
  it('stops polling when the lease is not renewed', async () => {
    const client = new ScriptedClient(flyingServer(() => [1]));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.count('status')).toBe(4); // 0, 20, 40, 60 s; the lease runs to 65 s
    await vi.advanceTimersByTimeAsync(20000);
    expect(client.count('status')).toBe(4);
    expect(last()).toMatchObject({ watching: false, nextPollAt: null });
    await vi.advanceTimersByTimeAsync(600000);
    expect(client.count('status')).toBe(4);
  });

  it('watch off cancels the schedule and answers watching:false', async () => {
    const client = new ScriptedClient(flyingServer(() => [1]));
    const service = makeService(client);
    expect(await service.handle(req('watch', { on: true }))).toEqual({ ok: true, result: { watching: true, leaseMs: 65000 } });
    expect(states[0]).toMatchObject({ state: 'dl.pending', watching: true });
    await flush();
    expect(await service.handle(req('watch', { on: false }))).toEqual({ ok: true, result: { watching: false, leaseMs: 65000 } });
    await vi.advanceTimersByTimeAsync(100000);
    expect(client.count('status')).toBe(1);
  });
});

describe('manual refresh', () => {
  it('triggers exactly one immediate cycle, and coalesces while one is in flight', async () => {
    let release: (() => void) | null = null;
    let hold = false;
    const good = flyingServer(() => [1]);
    const client = new ScriptedClient(async (route) => {
      if (hold && route.key === 'status') await new Promise<void>((resolve) => { release = resolve; });
      return good(route);
    });
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(client.count('status')).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(await service.handle(req('refresh', {}))).toEqual({ ok: true, result: { accepted: true, coalesced: false } });
    await flush();
    expect(client.count('status')).toBe(2);
    expect(client.count('flight-thread')).toBe(2);

    hold = true;
    expect(await service.handle(req('refresh', {}))).toEqual({ ok: true, result: { accepted: true, coalesced: false } });
    await flush();
    expect(await service.handle(req('refresh', {}))).toEqual({ ok: true, result: { accepted: true, coalesced: true } });
    await flush();
    expect(client.count('status')).toBe(3);
    hold = false;
    release!();
    await flush();
    expect(client.count('status')).toBe(3);
    expect(last()).toMatchObject({ state: 'dl.ok', nextPollAt: Date.now() + 20000 });
  });

  it('answers no-config without a request when there is no valid config', async () => {
    hasConfig = false;
    const client = new ScriptedClient(flyingServer(() => [1]));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    expect(last()).toMatchObject({ state: 'dl.no-config', nextPollAt: null });
    expect(await service.handle(req('refresh', {}))).toEqual({ ok: false, error: { code: 'no-config', httpStatus: null, serverCode: null } });
    expect(await service.handle(req('canned-list', {}))).toMatchObject({ ok: false, error: { code: 'no-config' } });
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.routes).toEqual([]);

    hasConfig = true;
    service.onConfigApplied(true);
    await flush();
    expect(client.count('status')).toBe(1);
  });
});

describe('scope resolution in a cycle', () => {
  it('leg scope from status makes no ground-session request', async () => {
    const client = new ScriptedClient((route) => {
      if (route.key === 'status') return fromFixture('01b-get-status-ground-leg');
      if (route.key === 'leg-thread') return fromFixture('06-get-leg-thread');
      return ok({}, 599);
    });
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(client.routes.map((r) => r.key)).toEqual(['status', 'leg-thread']);
    expect(client.routes[1]).toEqual({ key: 'leg-thread', id: 12 });
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'leg', plannedLegId: 12, source: 'status' } });
  });

  it('falls back to GET /api/ground-sessions/current, and { session: null } is no flight plan', async () => {
    let session = 'open';
    const client = new ScriptedClient((route) => {
      if (route.key === 'status') return fromFixture('01c-get-status-ground-no-leg');
      if (route.key === 'ground-session-current') {
        return fromFixture(session === 'open' ? '10a-get-ground-session-open' : '10b-get-ground-session-none');
      }
      if (route.key === 'leg-thread') return fromFixture('06-get-leg-thread');
      return ok({}, 599);
    });
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(client.routes.map((r) => r.key)).toEqual(['status', 'ground-session-current', 'leg-thread']);
    expect(last()).toMatchObject({ scope: { kind: 'leg', plannedLegId: 12, source: 'ground-session' }, thread: { epoch: 1 } });

    session = 'none';
    await service.handle(req('refresh', {}));
    await flush();
    expect(client.routes.slice(3).map((r) => r.key)).toEqual(['status', 'ground-session-current']);
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'none' }, thread: null });
  });

  it('flight scope takes the linked leg from the thread when status has none', async () => {
    const client = new ScriptedClient((route) => {
      if (route.key === 'status') return ok({ currentFlightId: 92 });
      return ok(threadBody([1], 33));
    });
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(last()).toMatchObject({ scope: { kind: 'flight', flightId: 92, plannedLegId: 33 } });
  });
});

describe('thread cache, epochs and the thread op', () => {
  it('keeps the epoch on append, bumps it on removal, scope change and after none', async () => {
    let ids = [1, 2, 3];
    let status: unknown = { currentFlightId: 92 };
    const client = new ScriptedClient((route) => {
      if (route.key === 'status') return ok(status);
      if (route.key === 'ground-session-current') return ok({ session: null });
      return ok(threadBody(ids));
    });
    const service = makeService(client);
    const cycle = async () => {
      await service.handle(req('refresh', {}));
      await flush();
      return last().thread;
    };
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(last().thread).toEqual({ epoch: 1, total: 3, firstSeq: 0, newestId: 3, droppedRows: 0 });

    ids = [1, 2, 3, 4];
    expect(await cycle()).toMatchObject({ epoch: 1, total: 4, newestId: 4 });
    ids = [1, 3, 4];
    expect(await cycle()).toMatchObject({ epoch: 2, total: 3 });
    status = { currentFlightId: 93 };
    expect(await cycle()).toMatchObject({ epoch: 3 });
    status = { currentFlightId: null };
    expect(await cycle()).toBeNull();
    status = { currentFlightId: 93 };
    expect(await cycle()).toMatchObject({ epoch: 4 });
  });

  it('clears the cache when the scope changes but the thread GET fails', async () => {
    let flight = 92;
    let threadDown = false;
    const client = new ScriptedClient((route) => {
      if (route.key === 'status') return ok({ currentFlightId: flight });
      return threadDown ? UNREACHABLE : ok(threadBody([1]));
    });
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    threadDown = true;
    await service.handle(req('refresh', {}));
    await flush();
    expect(last()).toMatchObject({ state: 'dl.unreachable', scope: { flightId: 92 }, thread: { epoch: 1 } });
    flight = 94;
    await service.handle(req('refresh', {}));
    await flush();
    expect(last()).toMatchObject({ state: 'dl.unreachable', scope: { flightId: 94 }, thread: null });
  });

  it('answers the thread op locally with windows and its errors', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const client = new ScriptedClient(flyingServer(() => ids));
    const service = makeService(client);
    expect(await service.handle(req('thread', { epoch: 1, endSeq: 0 }))).toMatchObject({ ok: false, error: { code: 'no-thread' } });
    await service.handle(req('watch', { on: true }));
    await flush();
    const made = client.routes.length;

    expect(await service.handle(req('thread', { epoch: 2, endSeq: 5 }))).toMatchObject({ ok: false, error: { code: 'stale-epoch' } });
    expect(await service.handle(req('thread', { epoch: 1, endSeq: 51 }))).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    expect(await service.handle(req('thread', { epoch: 1, endSeq: 0 }))).toEqual({
      ok: true, result: { epoch: 1, total: 50, firstSeq: 0, startSeq: 0, endSeq: 0, messages: [] },
    });
    const tail = (await service.handle(req('thread', { epoch: 1, endSeq: 50 }))) as DatalinkOutcome<'thread'>;
    expect(tail).toMatchObject({ ok: true, result: { epoch: 1, total: 50, startSeq: 10, endSeq: 50 } });
    expect(tail.ok && tail.result.messages.map((m) => m.seq)).toEqual(Array.from({ length: 40 }, (_, i) => 10 + i));
    expect(client.routes.length).toBe(made);
  });
});

describe('ops', () => {
  it('a write that lands starts a cycle; a semantic refusal does not', async () => {
    const good = flyingServer(() => [1]);
    let sendReply: HttpOutcome = { kind: 'response', status: 201, scopeHeader: null, bodyText: '', bodyTooLarge: false };
    const client = new ScriptedClient((route) => (route.key === 'flight-send' ? sendReply : good(route)));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(client.count('status')).toBe(1);

    expect(await service.handle(req('send-canned', { target: { kind: 'flight', id: 92 }, cannedId: 'c1' }))).toEqual({
      ok: true, result: { sent: true, httpStatus: 201 },
    });
    await flush();
    expect(client.count('status')).toBe(2);

    sendReply = fromFixture('err-400-unknown-canned-message');
    const before = states.length;
    expect(await service.handle(req('send-canned', { target: { kind: 'flight', id: 92 }, cannedId: 'c1' }))).toEqual({
      ok: false, error: { code: 'unknown-canned-message', httpStatus: 400, serverCode: 'UNKNOWN_CANNED_MESSAGE' },
    });
    await flush();
    expect(client.count('status')).toBe(2);
    expect(states.length).toBe(before);
    expect(last().state).toBe('dl.ok');
  });

  it('a write whose fate is unknown also starts a cycle', async () => {
    const good = flyingServer(() => [1]);
    const client = new ScriptedClient((route) => (route.key === 'flight-wx' ? UNREACHABLE : good(route)));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(await service.handle(req('wx', { target: { kind: 'flight', id: 92 }, icao: 'EGLL' }))).toMatchObject({
      ok: false, error: { code: 'unreachable' },
    });
    await flush();
    expect(client.count('status')).toBe(2);
  });
});

describe('ops against a scratch server through the real client', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('load sheet 201 then 200 gives equal results; 409 gives no-dispatch-data; wx unavailable gives nulls', async () => {
    let loadsheetCalls = 0;
    const server = await startScratchServer({
      'POST /api/planned-legs/12/acars-messages/loadsheet': (r) => {
        loadsheetCalls++;
        return reply(loadsheetCalls === 1 ? '09a-post-leg-loadsheet-created' : '09b-post-leg-loadsheet-existing')(r);
      },
      'POST /api/planned-legs/13/acars-messages/loadsheet': reply('err-409-no-dispatch-data'),
      'POST /api/flights/92/acars-messages/wx': reply('05b-post-flight-wx-unavailable'),
    });
    const uplink = new Uplink(scratchConfig(server.baseUrl));
    const service = makeService(new DatalinkClient(() => uplink));
    try {
      const first = (await service.handle(req('loadsheet', { plannedLegId: 12 }))) as DatalinkOutcome<'loadsheet'>;
      const second = (await service.handle(req('loadsheet', { plannedLegId: 12 }))) as DatalinkOutcome<'loadsheet'>;
      expect(first).toMatchObject({ ok: true, result: { plannedLegId: 12, created: true, httpStatus: 201 } });
      expect(second).toMatchObject({ ok: true, result: { plannedLegId: 12, created: false, httpStatus: 200 } });
      if (first.ok && second.ok) {
        expect(second.result.sheet).toEqual(first.result.sheet);
        expect(second.result.plannedLegId).toEqual(first.result.plannedLegId);
      }

      expect(await service.handle(req('loadsheet', { plannedLegId: 13 }))).toEqual({
        ok: false, error: { code: 'no-dispatch-data', httpStatus: 409, serverCode: 'NO_DISPATCH_DATA' },
      });
      expect(await service.handle(req('wx', { target: { kind: 'flight', id: 92 }, icao: 'ZZZZ' }))).toEqual({
        ok: true, result: { icao: 'ZZZZ', available: false, metar: null, taf: null, fetchedAt: null },
      });
      // None of those ops is a poll: the availability axis never moved.
      expect(states).toEqual([]);
      expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /api/planned-legs/12/acars-messages/loadsheet',
        'POST /api/planned-legs/12/acars-messages/loadsheet',
        'POST /api/planned-legs/13/acars-messages/loadsheet',
        'POST /api/flights/92/acars-messages/wx',
      ]);
    } finally {
      await uplink.close();
      await server.close();
    }
  });
});

describe('shutdown', () => {
  it('cancels the schedule, emits nothing more, and answers ops with sidecar-unavailable', async () => {
    const client = new ScriptedClient(flyingServer(() => [1]));
    const service = makeService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    const emitted = states.length;
    service.shutdown();
    await vi.advanceTimersByTimeAsync(120000);
    expect(client.count('status')).toBe(1);
    expect(states.length).toBe(emitted);
    expect(await service.handle(req('refresh', {}))).toMatchObject({ ok: false, error: { code: 'sidecar-unavailable' } });
    expect(await service.handle(req('watch', { on: true }))).toMatchObject({ ok: false, error: { code: 'sidecar-unavailable' } });
  });
});
