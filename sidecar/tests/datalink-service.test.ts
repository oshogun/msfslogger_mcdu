// tests/datalink-service.test.ts — tests src/datalink-service.ts.
//
// The schedule is driven by fake timers and a scripted client, so intervals,
// backoff, the invalid-token latch, lease expiry and refresh coalescing are all
// asserted in exact milliseconds and exact request counts. The load sheet and
// weather ops also run against a scratch HTTP server through the real client.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpOutcome } from '../src/datalink-classify';
import { buildRequest, DatalinkClient, type DatalinkRoute } from '../src/datalink-client';
import {
  DatalinkService,
  nextPollDelayMs,
  DATALINK_POLL_INTERVAL_MS,
  type DatalinkRequester,
} from '../src/datalink-service';
import type { DatalinkOutcome, DatalinkRequestMessage, DatalinkStateMessage } from '../src/protocol';
import { Uplink } from '../src/uplink';
import {
  CLEARANCE_SENTINEL_TOKEN,
  CLEARANCE_SERVER_TEXT,
  clearanceFixture,
  clearanceFixtureNames,
  clearanceReply,
  fixture,
  reply,
  scratchConfig,
  SENTINEL_TOKEN,
  SIMBRIEF_SENTINEL_TOKEN,
  simbriefFixture,
  simbriefFixtureNames,
  simbriefReply,
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
    serverUrl: () => 'http://scratch.invalid',
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

// ── SimBrief ops and the prefiled-leg scope ─────────────────────────────────

function fromSimbrief(name: string): HttpOutcome {
  const { response } = simbriefFixture(name);
  const scope = Object.entries(response.headers).find(([k]) => k.toLowerCase() === 'x-ingest-token-scope');
  return {
    kind: 'response',
    status: response.status,
    scopeHeader: scope ? scope[1] : null,
    bodyText: typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
    bodyTooLarge: false,
  };
}
const TIMED_OUT: HttpOutcome = { kind: 'transport', errorName: 'TimeoutError', errorCode: null };
const RESET: HttpOutcome = { kind: 'transport', errorName: 'TypeError', errorCode: 'ECONNRESET' };

function legThread(id: number) {
  return ok({ planned_leg_id: id, messages: threadBody([1]).messages });
}

/** A mutable config the prefiled-leg tests change under the service. */
let config: { token: string; serverUrl: string };

function makePrefileService(client: DatalinkRequester): DatalinkService {
  return new DatalinkService({
    client,
    hasConfig: () => hasConfig,
    token: () => config.token,
    serverUrl: () => config.serverUrl,
    emitState: (message) => states.push(message),
    log: (level, message) => logs.push(`${level} ${message}`),
  });
}

/**
 * On the ground with no leg in status and no ground session, unless `status`
 * says otherwise. SimBrief routes answer with `prefile` / `settings`.
 */
function groundServer(opts: {
  status?: () => HttpOutcome;
  prefile?: () => HttpOutcome | Promise<HttpOutcome>;
  settings?: () => HttpOutcome;
  legThread?: (id: number) => HttpOutcome;
} = {}): Responder {
  return (route) => {
    switch (route.key) {
      case 'status':
        return opts.status ? opts.status() : fromFixture('01c-get-status-ground-no-leg');
      case 'ground-session-current':
        return fromFixture('10b-get-ground-session-none');
      case 'leg-thread':
        return opts.legThread ? opts.legThread(route.id) : legThread(route.id);
      case 'flight-thread':
        return ok(threadBody([1]));
      case 'simbrief-prefile':
        return opts.prefile ? opts.prefile() : fromSimbrief('post-201-imported');
      case 'simbrief-settings':
        return opts.settings ? opts.settings() : fromSimbrief('get-settings-configured');
      default:
        return ok({}, 599);
    }
  };
}

function paths(client: ScriptedClient, from = 0): string[] {
  return client.routes.slice(from).map((route) => {
    const built = buildRequest(route);
    return built ? `${built.method} ${built.path}` : route.key;
  });
}

/** Keeps the lease alive the way a showing DATALINK page does, across `ms`. */
async function watchFor(service: DatalinkService, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 20000) {
    await service.handle(req('watch', { on: true }));
    await vi.advanceTimersByTimeAsync(Math.min(20000, left));
  }
}

function withoutAt(message: DatalinkStateMessage) {
  const { at: _at, ...rest } = message;
  return rest;
}

describe('SimBrief prefile sets the prefiled leg', () => {
  beforeEach(() => {
    config = { token: SIMBRIEF_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  it.each([
    ['post-201-imported', 'imported', 201],
    ['post-200-duplicate', 'duplicate', 200],
  ])('%s: answers the projection, holds leg 123, and the next cycle polls that leg with no ground-session GET', async (sample, status, httpStatus) => {
    const client = new ScriptedClient(groundServer({ prefile: () => fromSimbrief(sample) }));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(paths(client)).toEqual(['GET /api/status', 'GET /api/ground-sessions/current']);
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'none' } });
    expect(last()).not.toHaveProperty('prefiledLeg');

    const made = client.routes.length;
    expect(await service.handle(req('simbrief-prefile', {}))).toEqual({
      ok: true,
      result: { status, plannedLegId: 123, label: 'KJFK → EGLL (BAW178)', warningCount: 0, httpStatus },
    });
    await flush();
    expect(paths(client, made)).toEqual([
      'POST /api/planned-legs/simbrief',
      'GET /api/status',
      'GET /api/planned-legs/123/acars-messages',
    ]);
    expect(last()).toMatchObject({
      state: 'dl.ok',
      scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' },
      prefiledLeg: { plannedLegId: 123, label: 'KJFK → EGLL (BAW178)' },
    });
    expect(states.some((s) => s.prefiledLeg && s.scope?.kind === 'none')).toBe(true);

    const polled = client.routes.length;
    await watchFor(service, 20000);
    expect(paths(client, polled)).toEqual(['GET /api/status', 'GET /api/planned-legs/123/acars-messages']);
    expect(logs).toContain(`info SimBrief prefile ${status} (HTTP ${httpStatus})`);
    for (const line of logs) {
      expect(line).not.toContain('123');
      expect(line).not.toContain('KJFK');
    }
  });

  it('(c) outranks a different leg from status; (d) the same leg keeps one scope key and its epoch', async () => {
    let prefileId = 123;
    const client = new ScriptedClient(groundServer({
      status: () => fromFixture('01b-get-status-ground-leg'),
      prefile: () => ok({ result: { status: 'imported', planned_leg_id: prefileId, label: 'L', warnings: [] } }, 201),
    }));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(last()).toMatchObject({ scope: { kind: 'leg', plannedLegId: 12, source: 'status' }, thread: { epoch: 1 } });

    const made = client.routes.length;
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    expect(paths(client, made)).toEqual([
      'POST /api/planned-legs/simbrief', 'GET /api/status', 'GET /api/planned-legs/123/acars-messages',
    ]);
    expect(last()).toMatchObject({ scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' }, thread: { epoch: 2 } });

    // The prefiled leg is the ground-session leg itself: same key, same epoch.
    await service.handle(req('prefile-clear', {}));
    await flush();
    expect(last()).toMatchObject({ scope: { kind: 'leg', plannedLegId: 12, source: 'status' }, thread: { epoch: 3 } });
    prefileId = 12;
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    expect(last()).toMatchObject({ scope: { kind: 'leg', plannedLegId: 12, source: 'prefile' }, thread: { epoch: 3 } });
  });

  it('wx, canned and load sheet ops aimed at the prefiled leg hit the leg-scoped routes', async () => {
    const client = new ScriptedClient((route) => {
      if (route.key === 'leg-wx') return fromFixture('08-post-leg-wx');
      if (route.key === 'leg-loadsheet') return fromFixture('09a-post-leg-loadsheet-created');
      if (route.key === 'leg-send') return { kind: 'response', status: 201, scopeHeader: null, bodyText: '', bodyTooLarge: false };
      return groundServer()(route);
    });
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    const scope = last().scope;
    expect(scope).toEqual({ kind: 'leg', plannedLegId: 123, source: 'prefile' });
    const id = scope && scope.kind === 'leg' ? scope.plannedLegId : 0;

    const made = client.routes.length;
    await service.handle(req('wx', { target: { kind: 'leg', id }, icao: 'LFPG' }));
    await service.handle(req('loadsheet', { plannedLegId: id }));
    await service.handle(req('send-canned', { target: { kind: 'leg', id }, cannedId: 'gate-request' }));
    await flush();
    const ops = paths(client, made).filter((p) => p.startsWith('POST '));
    expect(ops).toEqual([
      'POST /api/planned-legs/123/acars-messages/wx',
      'POST /api/planned-legs/123/acars-messages/loadsheet',
      'POST /api/planned-legs/123/acars-messages',
    ]);
    expect(last()).toMatchObject({ prefiledLeg: { plannedLegId: 123 } });
  });
});

describe('every event that clears the prefiled leg', () => {
  beforeEach(() => {
    config = { token: SIMBRIEF_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  /** Watching, one cycle with no scope, then a prefile of leg 123 and its cycle. */
  async function prefiled(client: ScriptedClient) {
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    const before = withoutAt(last());
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    expect(last()).toMatchObject({ prefiledLeg: { plannedLegId: 123 }, scope: { source: 'prefile' } });
    return { service, before };
  }

  async function expectSelectsAsBefore(client: ScriptedClient, service: DatalinkService) {
    const made = client.routes.length;
    await service.handle(req('refresh', {}));
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status', 'GET /api/ground-sessions/current']);
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'none' }, thread: null });
    expect(last()).not.toHaveProperty('prefiledLeg');
  }

  it('C1 prefile-clear: cleared:true once, then cleared:false with no emit', async () => {
    const client = new ScriptedClient(groundServer());
    const { service } = await prefiled(client);
    const emitted = states.length;
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: true } });
    expect(states.length).toBeGreaterThan(emitted);
    expect(states[emitted]).not.toHaveProperty('prefiledLeg');
    await flush();
    const settled = states.length;
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: false } });
    expect(states.length).toBe(settled);
    await expectSelectsAsBefore(client, service);
  });

  it('C1 works with no config and while latched, and makes no request', async () => {
    const client = new ScriptedClient(groundServer());
    const { service } = await prefiled(client);
    hasConfig = false;
    const made = client.routes.length;
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: true } });
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: false } });
    hasConfig = true;
    client.respond = () => fromFixture('err-401-invalid-token');
    await service.handle(req('refresh', {}));
    await flush();
    expect(last()).toMatchObject({ state: 'dl.token-invalid' });
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: false } });
    expect(client.routes.length).toBe(made + 1);
  });

  it.each([
    ['serverUrl', () => { config.serverUrl = 'http://other.invalid'; }],
    ['token', () => { config.token = 'SENTINEL-SIMBRIEF-TOKEN-1111'; }],
  ])('C2 a valid reload that changes the %s clears it; an invalid reload or an unchanged one does not', async (_name, change) => {
    const client = new ScriptedClient(groundServer());
    const { service } = await prefiled(client);
    service.onConfigApplied(true);
    await flush();
    expect(last()).toMatchObject({ prefiledLeg: { plannedLegId: 123 } });
    change();
    service.onConfigApplied(false);
    await flush();
    expect(last()).toMatchObject({ prefiledLeg: { plannedLegId: 123 } });
    service.onConfigApplied(true);
    expect(last()).not.toHaveProperty('prefiledLeg');
    await flush();
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'none' } });
    await expectSelectsAsBefore(client, service);
  });

  it.each([
    ['a poll', (service: DatalinkService) => service.handle(req('refresh', {})), 'status'],
    ['a datalink op', (service: DatalinkService) => service.handle(req('canned-list', {})), 'canned-list'],
    ['the SimBrief settings op', (service: DatalinkService) => service.handle(req('simbrief-settings', {})), 'simbrief-settings'],
    ['the SimBrief prefile op itself', (service: DatalinkService) => service.handle(req('simbrief-prefile', {})), 'simbrief-prefile'],
  ])('C3 the token latch set by %s clears it', async (_name, act, key) => {
    let refuse = false;
    const good = groundServer();
    const client = new ScriptedClient((route) =>
      refuse && route.key === key ? fromFixture('err-401-invalid-token') : good(route));
    const { service } = await prefiled(client);
    refuse = true;
    await act(service);
    await flush();
    expect(last()).toMatchObject({ state: 'dl.token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN', nextPollAt: null });
    expect(last()).not.toHaveProperty('prefiledLeg');
    const made = client.routes.length;
    await watchFor(service, 120000);
    expect(client.routes.length).toBe(made);
    refuse = false;
    service.onConfigApplied(true);
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status', 'GET /api/ground-sessions/current']);
    await expectSelectsAsBefore(client, service);
  });

  it('C5 a cycle that sees a flight clears it; after the flight, scope is selected as before the prefile', async () => {
    let flying = false;
    const client = new ScriptedClient(groundServer({
      status: () => fromFixture(flying ? '01a-get-status-flying' : '01c-get-status-ground-no-leg'),
    }));
    const { service } = await prefiled(client);
    flying = true;
    const made = client.routes.length;
    await watchFor(service, 20000);
    expect(paths(client, made)).toEqual(['GET /api/status', 'GET /api/flights/92/acars-messages']);
    expect(last()).toMatchObject({ scope: { kind: 'flight', flightId: 92, plannedLegId: 12 } });
    expect(last()).not.toHaveProperty('prefiledLeg');
    flying = false;
    await expectSelectsAsBefore(client, service);
  });

  it('C6(i) the poll 404s the prefiled leg: scope null at once, no backoff, and an immediate rerun without it', async () => {
    let gone = false;
    const client = new ScriptedClient(groundServer({
      legThread: (id) => (gone && id === 123 ? fromFixture('err-404-leg-not-found') : legThread(id)),
    }));
    const { service } = await prefiled(client);
    gone = true;
    const made = client.routes.length;
    const emitted = states.length;
    await service.handle(req('refresh', {}));
    await flush();
    expect(paths(client, made)).toEqual([
      'GET /api/status',
      'GET /api/planned-legs/123/acars-messages',
      'GET /api/status',
      'GET /api/ground-sessions/current',
    ]);
    const failed = states.slice(emitted).find((s) => s.state === 'dl.http-error');
    expect(failed).toMatchObject({ scope: null, thread: null, httpStatus: 404, serverCode: 'PLANNED_LEG_NOT_FOUND' });
    expect(failed).not.toHaveProperty('prefiledLeg');
    // The failure did not count towards backoff: the schedule is still 20 s.
    expect(failed!.nextPollAt).toBe(Date.now() + 20000);
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'none' }, nextPollAt: Date.now() + 20000 });
    await expectSelectsAsBefore(client, service);
  });

  it.each([
    ['wx', { target: { kind: 'leg', id: 123 }, icao: 'LFPG' }],
    ['loadsheet', { plannedLegId: 123 }],
    ['send-canned', { target: { kind: 'leg', id: 123 }, cannedId: 'gate-request' }],
  ] as const)('C6(ii) %s aimed at the prefiled leg answering 404 clears it; one aimed elsewhere does not', async (op, params) => {
    const good = groundServer();
    const client = new ScriptedClient((route) =>
      route.key === 'leg-wx' || route.key === 'leg-loadsheet' || route.key === 'leg-send'
        ? fromFixture('err-404-leg-not-found')
        : good(route));
    const { service } = await prefiled(client);
    const elsewhere = JSON.parse(JSON.stringify(params).replace('123', '77'));
    expect(await service.handle(req(op, elsewhere))).toMatchObject({ ok: false, error: { code: 'leg-not-found' } });
    await flush();
    expect(last()).toMatchObject({ prefiledLeg: { plannedLegId: 123 } });
    expect(await service.handle(req(op, params as never))).toMatchObject({ ok: false, error: { code: 'leg-not-found' } });
    expect(last()).not.toHaveProperty('prefiledLeg');
    await flush();
    await expectSelectsAsBefore(client, service);
  });

  it('C7 a newer successful prefile replaces it; a failed or unknown one leaves it', async () => {
    let next: HttpOutcome = fromSimbrief('post-201-imported');
    const client = new ScriptedClient(groundServer({ prefile: () => next }));
    const { service } = await prefiled(client);
    for (const outcome of [fromSimbrief('post-504-timeout'), fromSimbrief('post-409-unknown-code'), fromSimbrief('post-201-malformed-body'), TIMED_OUT, RESET, fromSimbrief('post-401-no-scope-header')]) {
      next = outcome;
      expect(await service.handle(req('simbrief-prefile', {}))).toMatchObject({ ok: false });
      expect(service.buildState()).toMatchObject({ prefiledLeg: { plannedLegId: 123 } });
    }
    next = fromSimbrief('post-201-label-contains-token');
    expect(await service.handle(req('simbrief-prefile', {}))).toMatchObject({ ok: true, result: { plannedLegId: 124 } });
    await flush();
    expect(last()).toMatchObject({
      prefiledLeg: { plannedLegId: 124, label: 'KJFK → EGLL ([REDACTED])' },
      scope: { kind: 'leg', plannedLegId: 124, source: 'prefile' },
    });
  });

  it('C7 a prefile that succeeds after the token latched while it was in flight still sets the leg', async () => {
    let release: ((outcome: HttpOutcome) => void) | null = null;
    const good = groundServer();
    const client = new ScriptedClient((route) => {
      if (route.key === 'simbrief-prefile') return new Promise<HttpOutcome>((resolve) => { release = resolve; });
      if (route.key === 'canned-list') return fromFixture('err-401-invalid-token');
      return good(route);
    });
    const service = makePrefileService(client);
    const pending = service.handle(req('simbrief-prefile', {}));
    await flush();
    await service.handle(req('canned-list', {}));
    expect(last()).toMatchObject({ state: 'dl.token-invalid' });
    release!(fromSimbrief('post-201-imported'));
    expect(await pending).toMatchObject({ ok: true, result: { plannedLegId: 123 } });
    expect(last()).toMatchObject({ state: 'dl.token-invalid', prefiledLeg: { plannedLegId: 123 } });
  });

  it('C4 a new service (a new sidecar process) holds none, and its state has no prefiledLeg key', () => {
    const service = makePrefileService(new ScriptedClient(groundServer()));
    expect(service.buildState()).not.toHaveProperty('prefiledLeg');
  });
});

describe('SimBrief failures and the datalink state', () => {
  beforeEach(() => {
    config = { token: SIMBRIEF_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  const NON_LATCHING: [string, HttpOutcome][] = [
    ...simbriefFixtureNames()
      .filter((name) => !simbriefFixture(name).expect.ok && simbriefFixture(name).expect.code !== 'token-invalid')
      .map((name): [string, HttpOutcome] => [name, fromSimbrief(name)]),
    ['timeout', TIMED_OUT],
    ['reset', RESET],
    ['unreachable', UNREACHABLE],
    ['tls', { kind: 'transport', errorName: 'TypeError', errorCode: 'SELF_SIGNED_CERT_IN_CHAIN' }],
  ];

  it.each(NON_LATCHING)('%s leaves every availability member, the schedule and the held leg identical, with no emit', async (_name, outcome) => {
    let failing = false;
    const good = groundServer();
    const client = new ScriptedClient((route) =>
      failing && (route.key === 'simbrief-prefile' || route.key === 'simbrief-settings') ? outcome : good(route));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    const before = withoutAt(service.buildState());
    const emitted = states.length;
    failing = true;
    expect(await service.handle(req('simbrief-prefile', {}))).toMatchObject({ ok: false });
    expect(await service.handle(req('simbrief-settings', {}))).toMatchObject({ ok: false });
    expect(withoutAt(service.buildState())).toEqual(before);
    expect(states.length).toBe(emitted);
    expect(logs.filter((line) => line.startsWith('warn SimBrief '))).toHaveLength(2);
    for (const line of logs) expect(line).toMatch(/^(info|warn) (Datalink dl\.\S+ \(HTTP [^)]*\)( on .*)?|SimBrief (prefile|settings) [a-z-]+ \(HTTP (\d{3}|---)\))$/);
  });

  it('A1 401 INVALID_INGEST_TOKEN on the prefile latches: no request of any kind until a valid reload', async () => {
    let refuse = true;
    const good = groundServer();
    const client = new ScriptedClient((route) =>
      refuse && route.key === 'simbrief-prefile' ? fromSimbrief('post-401-invalid-token') : good(route));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(await service.handle(req('simbrief-prefile', {}))).toEqual({
      ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' },
    });
    expect(last()).toMatchObject({ state: 'dl.token-invalid', nextPollAt: null });
    const made = client.routes.length;
    const refused = { ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' } };
    await watchFor(service, 300000);
    expect(await service.handle(req('simbrief-prefile', {}))).toEqual(refused);
    expect(await service.handle(req('simbrief-settings', {}))).toEqual(refused);
    expect(await service.handle(req('refresh', {}))).toEqual(refused);
    service.onConfigApplied(false);
    await watchFor(service, 60000);
    expect(client.routes.length).toBe(made);
    refuse = false;
    service.onConfigApplied(true);
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status', 'GET /api/ground-sessions/current']);
  });

  it('settings: configured and not configured; no config and latched are refused locally', async () => {
    let name = 'get-settings-configured';
    const client = new ScriptedClient(groundServer({ settings: () => fromSimbrief(name) }));
    const service = makePrefileService(client);
    expect(await service.handle(req('simbrief-settings', {}))).toEqual({ ok: true, result: { configured: true } });
    name = 'get-settings-blank';
    expect(await service.handle(req('simbrief-settings', {}))).toEqual({ ok: true, result: { configured: false } });
    name = 'get-settings-malformed';
    expect(await service.handle(req('simbrief-settings', {}))).toEqual({
      ok: false, error: { code: 'bad-response', httpStatus: 200, serverCode: null },
    });
    expect(logs).toEqual([
      'info SimBrief settings ok (HTTP 200)',
      'info SimBrief settings ok (HTTP 200)',
      'warn SimBrief settings bad-response (HTTP 200)',
    ]);
    expect(states).toEqual([]);
    hasConfig = false;
    const made = client.routes.length;
    expect(await service.handle(req('simbrief-settings', {}))).toEqual({ ok: false, error: { code: 'no-config', httpStatus: null, serverCode: null } });
    expect(await service.handle(req('simbrief-prefile', {}))).toEqual({ ok: false, error: { code: 'no-config', httpStatus: null, serverCode: null } });
    expect(client.routes.length).toBe(made);
    // The in-flight flag was released by the refusal.
    hasConfig = true;
    expect(await service.handle(req('simbrief-prefile', {}))).toMatchObject({ ok: true });
  });
});

describe('a cleared prefiled leg leaves no scope or thread behind, even when the next cycle fails', () => {
  beforeEach(() => {
    config = { token: SIMBRIEF_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  /**
   * Watching, prefiled leg 123 shown with its thread. `down` makes every
   * status GET unreachable; `refuse` makes the named route answer
   * INVALID_INGEST_TOKEN; `flying` puts a flight in status.
   */
  async function shownPrefile() {
    const net = { down: false, flying: false, refuse: null as DatalinkRoute['key'] | null, threadDown: false };
    const good = groundServer({
      status: () => fromFixture(net.flying ? '01a-get-status-flying' : '01c-get-status-ground-no-leg'),
    });
    const client = new ScriptedClient((route) => {
      if (net.refuse === route.key) return fromFixture('err-401-invalid-token');
      if (net.down && route.key === 'status') return UNREACHABLE;
      if (net.threadDown && (route.key === 'flight-thread' || route.key === 'leg-thread')) return UNREACHABLE;
      if (route.key === 'leg-wx' || route.key === 'leg-loadsheet' || route.key === 'leg-send') {
        return fromFixture('err-404-leg-not-found');
      }
      return good(route);
    });
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    expect(last()).toMatchObject({
      state: 'dl.ok',
      scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' },
      prefiledLeg: { plannedLegId: 123 },
    });
    const epoch = last().thread!.epoch;
    expect(await service.handle(req('thread', { epoch, endSeq: 1 }))).toMatchObject({ ok: true });
    return { client, service, net, epoch };
  }

  /** Nothing published still points at leg 123, and no write can be aimed at it from the state. */
  async function expectNoPrefileLeft(service: DatalinkService, epoch: number) {
    for (const state of [last(), service.buildState()]) {
      expect(state).not.toHaveProperty('prefiledLeg');
      expect(state.thread).toBeNull();
      expect(JSON.stringify(state.scope ?? null)).not.toContain('prefile');
    }
    expect(await service.handle(req('thread', { epoch, endSeq: 1 }))).toMatchObject({
      ok: false, error: { code: 'no-thread' },
    });
  }

  /** Fails the next cycle's status GET and checks the scope stays empty. */
  async function failNextCycle(client: ScriptedClient, service: DatalinkService, net: { down: boolean }) {
    net.down = true;
    const made = client.routes.length;
    await service.handle(req('refresh', {}));
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status']);
    expect(last()).toMatchObject({ state: 'dl.unreachable', scope: null, thread: null });
  }

  /** Once the server is back, the scope resolves as before the prefile and a new thread gets a new epoch. */
  async function recovers(client: ScriptedClient, service: DatalinkService, net: { down: boolean }, epoch: number) {
    net.down = false;
    const made = client.routes.length;
    await service.handle(req('refresh', {}));
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status', 'GET /api/ground-sessions/current']);
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'none' }, thread: null });
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: false } });
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    expect(last().thread!.epoch).toBeGreaterThan(epoch);
  }

  it('C1 prefile-clear', async () => {
    const { client, service, net, epoch } = await shownPrefile();
    net.down = true;
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: true } });
    expect(last()).toMatchObject({ scope: null, thread: null });
    await flush();
    await expectNoPrefileLeft(service, epoch);
    await failNextCycle(client, service, net);
    await expectNoPrefileLeft(service, epoch);
    await recovers(client, service, net, epoch);
  });

  it.each([
    ['serverUrl', () => { config.serverUrl = 'http://other.invalid'; }],
    ['token', () => { config.token = 'SENTINEL-SIMBRIEF-TOKEN-2222'; }],
  ])('C2 a reload that changes the %s', async (_name, change) => {
    const { client, service, net, epoch } = await shownPrefile();
    net.down = true;
    change();
    service.onConfigApplied(true);
    expect(last()).toMatchObject({ scope: null, thread: null });
    await flush();
    await expectNoPrefileLeft(service, epoch);
    await failNextCycle(client, service, net);
    await expectNoPrefileLeft(service, epoch);
    await recovers(client, service, net, epoch);
  });

  it.each([
    ['a poll', 'status', (service: DatalinkService) => service.handle(req('refresh', {}))],
    ['a datalink op', 'canned-list', (service: DatalinkService) => service.handle(req('canned-list', {}))],
    ['the SimBrief settings op', 'simbrief-settings', (service: DatalinkService) => service.handle(req('simbrief-settings', {}))],
  ] as const)('C3 the token latch set by %s: nothing is polled, and the scope is already empty', async (_name, key, act) => {
    const { client, service, net, epoch } = await shownPrefile();
    net.refuse = key;
    await act(service);
    await flush();
    expect(last()).toMatchObject({ state: 'dl.token-invalid', scope: null, thread: null });
    await expectNoPrefileLeft(service, epoch);
    const made = client.routes.length;
    await watchFor(service, 60000);
    expect(client.routes.length).toBe(made);
    await expectNoPrefileLeft(service, epoch);
    net.refuse = null;
    service.onConfigApplied(true);
    await flush();
    await recovers(client, service, net, epoch);
  });

  it('C5 a flight: the scope becomes the flight even when its thread GET fails, and a failed status after keeps it', async () => {
    const { client, service, net, epoch } = await shownPrefile();
    net.flying = true;
    net.threadDown = true;
    await service.handle(req('refresh', {}));
    await flush();
    expect(last()).toMatchObject({ state: 'dl.unreachable', scope: { kind: 'flight', flightId: 92 }, thread: null });
    await expectNoPrefileLeft(service, epoch);
    net.down = true;
    const made = client.routes.length;
    await service.handle(req('refresh', {}));
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status']);
    expect(last()).toMatchObject({ state: 'dl.unreachable', scope: { kind: 'flight', flightId: 92 }, thread: null });
    await expectNoPrefileLeft(service, epoch);
    net.flying = false;
    net.threadDown = false;
    await recovers(client, service, net, epoch);
    // A prefile after the flight ended shows its own leg again.
    expect(last()).toMatchObject({ scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' } });
  });

  it.each([
    ['wx', { target: { kind: 'leg', id: 123 }, icao: 'LFPG' }],
    ['loadsheet', { plannedLegId: 123 }],
    ['send-canned', { target: { kind: 'leg', id: 123 }, cannedId: 'gate-request' }],
  ] as const)('C6(ii) %s answering 404 for the prefiled leg', async (op, params) => {
    const { client, service, net, epoch } = await shownPrefile();
    net.down = true;
    expect(await service.handle(req(op, params as never))).toMatchObject({ ok: false, error: { code: 'leg-not-found' } });
    await flush();
    await expectNoPrefileLeft(service, epoch);
    await failNextCycle(client, service, net);
    await expectNoPrefileLeft(service, epoch);
    await recovers(client, service, net, epoch);
  });

  it('a clear that lands while a cycle is resolving the prefiled leg: that cycle publishes no scope for it', async () => {
    const { client, service, net, epoch } = await shownPrefile();
    let releaseThread: (() => void) | null = null;
    const respond = client.respond;
    client.respond = async (route) => {
      if (route.key === 'leg-thread') {
        await new Promise<void>((resolve) => { releaseThread = resolve; });
      }
      return respond(route);
    };
    await service.handle(req('refresh', {}));
    await flush();
    expect(releaseThread).not.toBeNull();
    net.down = true;
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: true } });
    client.respond = respond;
    releaseThread!();
    await flush();
    await expectNoPrefileLeft(service, epoch);
    expect(last()).toMatchObject({ state: 'dl.unreachable', scope: null });
    await recovers(client, service, net, epoch);
  });
});

describe('the prefile is never retried and never doubled', () => {
  beforeEach(() => {
    config = { token: SIMBRIEF_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  it.each([
    ['504', fromSimbrief('post-504-timeout'), 'simbrief-timeout'],
    ['502', fromSimbrief('post-502-network'), 'simbrief-network'],
    ['500', fromSimbrief('post-500-db-error'), 'simbrief-db-error'],
    ['500 no code', fromSimbrief('post-500-internal-no-code'), 'http-error'],
    ['reset', RESET, 'unreachable'],
    ['client timeout', TIMED_OUT, 'timeout'],
  ])('%s: one POST, and three poll intervals later still one', async (_name, outcome, code) => {
    const client = new ScriptedClient(groundServer({ prefile: () => outcome }));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(await service.handle(req('simbrief-prefile', {}))).toMatchObject({ ok: false, error: { code } });
    await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS + 5000);
    expect(client.count('simbrief-prefile')).toBe(1);
    expect(client.count('status')).toBeGreaterThanOrEqual(4);
  });

  it('a second prefile while the first is in flight is prefile-in-progress and sends nothing', async () => {
    let release: ((outcome: HttpOutcome) => void) | null = null;
    const client = new ScriptedClient(groundServer({
      prefile: () => new Promise<HttpOutcome>((resolve) => { release = resolve; }),
    }));
    const service = makePrefileService(client);
    const first = service.handle(req('simbrief-prefile', {}));
    await flush();
    expect(client.count('simbrief-prefile')).toBe(1);
    const inProgress = { ok: false, error: { code: 'prefile-in-progress', httpStatus: null, serverCode: null } };
    expect(await service.handle(req('simbrief-prefile', {}))).toEqual(inProgress);
    // Checked before the config, so it answers the same with no config.
    hasConfig = false;
    expect(await service.handle(req('simbrief-prefile', {}))).toEqual(inProgress);
    hasConfig = true;
    expect(await service.handle(req('prefile-clear', {}))).toEqual({ ok: true, result: { cleared: false } });
    expect(client.count('simbrief-prefile')).toBe(1);
    release!(fromSimbrief('post-504-timeout'));
    expect(await first).toMatchObject({ ok: false, error: { code: 'simbrief-timeout' } });
    await vi.advanceTimersByTimeAsync(100000);
    expect(client.count('simbrief-prefile')).toBe(1);
  });
});

describe('the prefile against a scratch server through the real client', () => {
  beforeEach(() => {
    vi.useRealTimers();
    config = { token: SIMBRIEF_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  it.each([
    ['504', () => simbriefReply('post-504-timeout')],
    ['502', () => simbriefReply('post-502-bad-status')],
    ['500', () => simbriefReply('post-500-db-error')],
    ['reset', () => () => ({ destroy: true as const })],
    ['client timeout', () => () => 'hang' as const],
  ])('%s: the server records exactly one POST, while a second press is refused and through three poll intervals', async (_name, handler) => {
    const server = await startScratchServer({ 'POST /api/planned-legs/simbrief': handler() as never });
    const uplink = new Uplink(scratchConfig(server.baseUrl, { ingestToken: SIMBRIEF_SENTINEL_TOKEN }));
    const real = new DatalinkClient(() => uplink, { prefileTimeoutMs: 300 });
    // The SimBrief routes go to the scratch server; the poll GETs are scripted
    // so fake time can drive the schedule without real sockets under it.
    const polls = new ScriptedClient(groundServer());
    const service = makePrefileService({
      request: (route, abort) => (route.key.startsWith('simbrief-') ? real.request(route, abort) : polls.request(route)),
    });
    try {
      // The second press lands while the first is still waiting on the server.
      const first = service.handle(req('simbrief-prefile', {}));
      expect(await service.handle(req('simbrief-prefile', {}))).toMatchObject({ ok: false, error: { code: 'prefile-in-progress' } });
      expect(await first).toMatchObject({ ok: false });
      expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/planned-legs/simbrief']);
      expect(server.requests[0].body).toBe('');

      vi.useFakeTimers();
      await service.handle(req('watch', { on: true }));
      await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS + 5000);
      expect(polls.count('status')).toBeGreaterThanOrEqual(4);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      service.shutdown();
      await uplink.close();
      await server.close();
    }
  });
});

// ── clearance ─────────────────────────────────────────────────────────────────

function fromClearance(name: string, legId?: number): HttpOutcome {
  const { response } = clearanceFixture(name);
  let body = response.body;
  // Only a sample aimed at leg 12 is re-aimed, so a mismatch sample stays a mismatch.
  if (legId !== undefined && typeof body === 'object' && body !== null && (body as { planned_leg_id?: unknown }).planned_leg_id === 12) {
    body = { ...(body as Record<string, unknown>), planned_leg_id: legId };
  }
  const scope = Object.entries(response.headers).find(([k]) => k.toLowerCase() === 'x-ingest-token-scope');
  return {
    kind: 'response',
    status: response.status,
    scopeHeader: scope ? scope[1] : null,
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
    bodyTooLarge: false,
  };
}

/** `base`, with the clearance POST answered by `clearance` and a leg WX answered as available. */
function withClearance(
  base: Responder,
  clearance: (id: number) => HttpOutcome | Promise<HttpOutcome>,
): Responder {
  return (route) => {
    if (route.key === 'leg-clearance') return clearance(route.id);
    if (route.key === 'leg-wx') return fromFixture('08-post-leg-wx');
    return base(route);
  };
}

const CLEARANCE_PATH = (id: number) => `POST /api/planned-legs/${id}/acars-messages/clearance`;
const CLEARANCE_LOG = /^(info|warn) (Datalink dl\.\S+ \(HTTP [^)]*\)( on .*)?|Clearance [a-z-]+ \(HTTP (\d{3}|---)\)|SimBrief (prefile|settings) [a-z-]+ \(HTTP (\d{3}|---)\))$/;

function expectedClearance(name: string, legId = 12) {
  return { ...clearanceFixture(name).expect.result, plannedLegId: legId };
}

describe('clearance: one POST, then only the GETs of the refresh that follows', () => {
  beforeEach(() => {
    config = { token: CLEARANCE_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  it.each([
    ['post-201-created', 'created', 201],
    ['post-200-not-created', 'on-file', 200],
  ])('%s on the ground leg: POST, status, leg thread; then nothing until the poll, which only GETs', async (sample, described, httpStatus) => {
    const client = new ScriptedClient(withClearance(
      groundServer({ status: () => fromFixture('01b-get-status-ground-leg') }),
      () => fromClearance(sample),
    ));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(paths(client)).toEqual(['GET /api/status', 'GET /api/planned-legs/12/acars-messages']);
    const made = client.routes.length;
    const emitted = states.length;

    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toEqual({
      ok: true, result: expectedClearance(sample),
    });
    await flush();
    expect(paths(client, made)).toEqual([
      CLEARANCE_PATH(12),
      'GET /api/status',
      'GET /api/planned-legs/12/acars-messages',
    ]);
    // The only emit is the refresh cycle's own.
    expect(states.length).toBe(emitted + 1);
    expect(logs).toContain(`info Clearance ${described} (HTTP ${httpStatus})`);

    await vi.advanceTimersByTimeAsync(DATALINK_POLL_INTERVAL_MS - 1);
    expect(paths(client, made)).toHaveLength(3);
    await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS + 5000);
    expect(client.count('status')).toBeGreaterThanOrEqual(5);
    expect(client.count('leg-clearance')).toBe(1);
    expect(paths(client, made).slice(1).every((line) => line.startsWith('GET '))).toBe(true);
    for (const line of logs) expect(line).toMatch(CLEARANCE_LOG);
  });

  it('flying: the refresh reads the flight thread, which carries the linked leg', async () => {
    const client = new ScriptedClient(withClearance(
      groundServer({ status: () => fromFixture('01a-get-status-flying') }),
      () => fromClearance('post-201-created'),
    ));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    const made = client.routes.length;
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ ok: true });
    await flush();
    expect(paths(client, made)).toEqual([CLEARANCE_PATH(12), 'GET /api/status', 'GET /api/flights/92/acars-messages']);
  });

  it('a held prefiled leg: POST and thread on that leg, and no ground-session GET', async () => {
    const client = new ScriptedClient(withClearance(groundServer(), (id) => fromClearance('post-200-not-created', id)));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    expect(last()).toMatchObject({ scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' } });
    const made = client.routes.length;
    expect(await service.handle(req('clearance', { plannedLegId: 123 }))).toEqual({
      ok: true, result: expectedClearance('post-200-not-created', 123),
    });
    await flush();
    expect(paths(client, made)).toEqual([CLEARANCE_PATH(123), 'GET /api/status', 'GET /api/planned-legs/123/acars-messages']);
    expect(last()).toMatchObject({ prefiledLeg: { plannedLegId: 123 } });
  });

  it('a success while a cycle is in flight gives exactly one rerun after it, and no second POST', async () => {
    let releaseThread: (() => void) | null = null;
    const base = withClearance(
      groundServer({ status: () => fromFixture('01b-get-status-ground-leg') }),
      () => fromClearance('post-201-created'),
    );
    let holdThread = false;
    const client = new ScriptedClient(async (route) => {
      if (holdThread && route.key === 'leg-thread') {
        holdThread = false;
        await new Promise<void>((resolve) => { releaseThread = resolve; });
      }
      return base(route);
    });
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    const made = client.routes.length;
    holdThread = true;
    await service.handle(req('refresh', {}));
    await flush();
    expect(releaseThread).not.toBeNull();
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ ok: true });
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status', 'GET /api/planned-legs/12/acars-messages', CLEARANCE_PATH(12)]);
    releaseThread!();
    await flush();
    expect(paths(client, made)).toEqual([
      'GET /api/status',
      'GET /api/planned-legs/12/acars-messages',
      CLEARANCE_PATH(12),
      'GET /api/status',
      'GET /api/planned-legs/12/acars-messages',
    ]);
    await vi.advanceTimersByTimeAsync(DATALINK_POLL_INTERVAL_MS - 1);
    expect(paths(client, made)).toHaveLength(5);
    expect(client.count('leg-clearance')).toBe(1);
  });

  it('not watching: the POST is the only request, now and later', async () => {
    const client = new ScriptedClient(withClearance(groundServer(), () => fromClearance('post-201-created')));
    const service = makePrefileService(client);
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(5 * DATALINK_POLL_INTERVAL_MS);
    expect(paths(client)).toEqual([CLEARANCE_PATH(12)]);
    expect(states).toEqual([]);
  });

  const POST_ONLY = clearanceFixtureNames().filter((name) => {
    const e = clearanceFixture(name).expect;
    return !e.ok && e.cycleSoon === false && e.latch === false;
  });

  it('the rows that start no refresh are 409, 401 token-missing, both header-less 401s, 403 and the http-errors', () => {
    expect(POST_ONLY.map((name) => clearanceFixture(name).expect.code).sort()).toEqual([
      'clearance-no-flight-plan', 'clearance-unavailable', 'clearance-unavailable', 'http-error', 'http-error',
      'http-error', 'http-error', 'rejected', 'token-missing',
    ]);
  });

  it.each(POST_ONLY)('%s: the POST only, and still one POST after three poll intervals', async (name) => {
    const sample = clearanceFixture(name);
    config.token = sample.configToken ?? CLEARANCE_SENTINEL_TOKEN;
    const client = new ScriptedClient(withClearance(
      groundServer({ status: () => fromFixture('01b-get-status-ground-leg') }),
      () => fromClearance(name),
    ));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    const made = client.routes.length;
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toEqual({
      ok: false,
      error: { code: sample.expect.code, httpStatus: sample.expect.httpStatus, serverCode: sample.expect.serverCode },
    });
    await flush();
    expect(paths(client, made)).toEqual([CLEARANCE_PATH(12)]);
    await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS + 5000);
    expect(client.count('leg-clearance')).toBe(1);
    expect(client.count('status')).toBeGreaterThanOrEqual(4);
  });
});

describe('clearance: never automatic, never retried, never doubled', () => {
  beforeEach(() => {
    config = { token: CLEARANCE_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  it('page open, three poll cycles, a manual refresh, a thread op and other writes make no clearance request', async () => {
    const client = new ScriptedClient(withClearance(
      groundServer({ status: () => fromFixture('01b-get-status-ground-leg') }),
      () => fromClearance('post-201-created'),
    ));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS + 5000);
    await service.handle(req('refresh', {}));
    await flush();
    expect(await service.handle(req('thread', { epoch: last().thread!.epoch, endSeq: 1 }))).toMatchObject({ ok: true });
    await service.handle(req('wx', { target: { kind: 'leg', id: 12 }, icao: 'LFPG' }));
    await service.handle(req('simbrief-settings', {}));
    await service.handle(req('prefile-clear', {}));
    await watchFor(service, 2 * DATALINK_POLL_INTERVAL_MS);
    expect(client.count('status')).toBeGreaterThanOrEqual(6);
    expect(paths(client).filter((line) => line.includes('/acars-messages/clearance'))).toEqual([]);
    expect(client.count('leg-clearance')).toBe(0);
  });

  it.each([
    ['500', fromClearance('post-500-internal-no-code'), 'http-error'],
    ['502', ok({ error: 'Bad gateway' }, 502), 'http-error'],
    ['504', ok({ error: 'Gateway timeout' }, 504), 'http-error'],
    ['reset', RESET, 'unreachable'],
    ['client timeout', TIMED_OUT, 'timeout'],
  ])('%s: one POST, and three poll intervals later still one', async (_name, outcome, code) => {
    const client = new ScriptedClient(withClearance(groundServer(), () => outcome));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ ok: false, error: { code } });
    await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS + 5000);
    expect(client.count('leg-clearance')).toBe(1);
    expect(client.count('status')).toBeGreaterThanOrEqual(4);
  });

  it('a second clearance while the first is in flight is clearance-in-progress and sends nothing; after it settles one is accepted', async () => {
    let release: ((outcome: HttpOutcome) => void) | null = null;
    const client = new ScriptedClient(withClearance(groundServer(), () =>
      new Promise<HttpOutcome>((resolve) => { release = resolve; })));
    const service = makePrefileService(client);
    const first = service.handle(req('clearance', { plannedLegId: 12 }));
    await flush();
    expect(client.count('leg-clearance')).toBe(1);
    const inProgress = { ok: false, error: { code: 'clearance-in-progress', httpStatus: null, serverCode: null } };
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toEqual(inProgress);
    expect(await service.handle(req('clearance', { plannedLegId: 13 }))).toEqual(inProgress);
    // Checked before the config, so it answers the same with no config.
    hasConfig = false;
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toEqual(inProgress);
    hasConfig = true;
    // A prefile uses another route and another guard.
    expect(await service.handle(req('simbrief-prefile', {}))).toMatchObject({ ok: true });
    expect(client.count('leg-clearance')).toBe(1);
    expect(logs.filter((line) => line.includes('Clearance'))).toEqual([]);
    release!(fromClearance('post-500-internal-no-code'));
    expect(await first).toMatchObject({ ok: false, error: { code: 'http-error' } });
    await vi.advanceTimersByTimeAsync(100000);
    expect(client.count('leg-clearance')).toBe(1);

    const again = service.handle(req('clearance', { plannedLegId: 12 }));
    await flush();
    expect(client.count('leg-clearance')).toBe(2);
    release!(fromClearance('post-201-created'));
    expect(await again).toMatchObject({ ok: true, result: { plannedLegId: 12 } });
  });

  it('no config: refused locally with no request, and the in-flight flag is released', async () => {
    const client = new ScriptedClient(withClearance(groundServer(), () => fromClearance('post-201-created')));
    const service = makePrefileService(client);
    hasConfig = false;
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toEqual({
      ok: false, error: { code: 'no-config', httpStatus: null, serverCode: null },
    });
    expect(client.routes).toEqual([]);
    expect(logs).toEqual([]);
    hasConfig = true;
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ ok: true });
  });

  it('shutdown while the POST is in flight answers sidecar-unavailable and emits nothing', async () => {
    let release: ((outcome: HttpOutcome) => void) | null = null;
    const client = new ScriptedClient(withClearance(groundServer(), () =>
      new Promise<HttpOutcome>((resolve) => { release = resolve; })));
    const service = makePrefileService(client);
    const pending = service.handle(req('clearance', { plannedLegId: 12 }));
    await flush();
    service.shutdown();
    release!(fromClearance('post-401-invalid-token'));
    expect(await pending).toEqual({ ok: false, error: { code: 'sidecar-unavailable', httpStatus: null, serverCode: null } });
    expect(states).toEqual([]);
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ error: { code: 'sidecar-unavailable' } });
    expect(client.count('leg-clearance')).toBe(1);
  });
});

describe('clearance failures and the datalink state', () => {
  beforeEach(() => {
    config = { token: CLEARANCE_SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  /** Watching, prefiled leg 123 shown with its thread, the clearance answering with `clearance`. */
  async function shownPrefile(clearance: (id: number) => HttpOutcome) {
    const client = new ScriptedClient(withClearance(groundServer(), clearance));
    const service = makePrefileService(client);
    await service.handle(req('watch', { on: true }));
    await flush();
    await service.handle(req('simbrief-prefile', {}));
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(last()).toMatchObject({
      state: 'dl.ok', scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' }, prefiledLeg: { plannedLegId: 123 },
    });
    return { client, service };
  }

  const UNCHANGED = clearanceFixtureNames().filter((name) => {
    const e = clearanceFixture(name).expect;
    return !e.ok && e.cycleSoon === false && e.latch === false;
  });

  it.each(UNCHANGED)('%s leaves availability, schedule, scope, thread cache and the held leg identical, with no emit', async (name) => {
    const sample = clearanceFixture(name);
    config.token = sample.configToken ?? CLEARANCE_SENTINEL_TOKEN;
    const { client, service } = await shownPrefile(() => fromClearance(name));
    const before = withoutAt(service.buildState());
    const epoch = before.thread!.epoch;
    const emitted = states.length;
    const made = client.routes.length;

    expect(await service.handle(req('clearance', { plannedLegId: 123 }))).toMatchObject({
      ok: false, error: { code: sample.expect.code },
    });
    await flush();
    expect(withoutAt(service.buildState())).toEqual(before);
    expect(states.length).toBe(emitted);
    expect(paths(client, made)).toEqual([CLEARANCE_PATH(123)]);
    expect(logs[logs.length - 1]).toBe(`warn Clearance ${sample.expect.code} (HTTP ${sample.response.status})`);
    for (const line of logs) {
      expect(line).toMatch(CLEARANCE_LOG);
      expect(line).not.toContain(CLEARANCE_SERVER_TEXT);
    }

    // The rest of the datalink carries on as before.
    expect(await service.handle(req('thread', { epoch, endSeq: 1 }))).toMatchObject({ ok: true });
    expect(await service.handle(req('wx', { target: { kind: 'leg', id: 123 }, icao: 'LFPG' }))).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(DATALINK_POLL_INTERVAL_MS);
    expect(last()).toMatchObject({ state: 'dl.ok', prefiledLeg: { plannedLegId: 123 } });
  });

  const REFRESHED: [string, () => HttpOutcome][] = [
    ...clearanceFixtureNames()
      .filter((name) => {
        const e = clearanceFixture(name).expect;
        return !e.ok && e.cycleSoon === true && e.code === 'bad-response';
      })
      .map((name): [string, () => HttpOutcome] => [name, () => fromClearance(name, 123)]),
    ['body-too-large', () => ({ kind: 'response', status: 201, scopeHeader: 'accepted', bodyText: null, bodyTooLarge: true })],
    ['transport-unreachable', () => UNREACHABLE],
    ['transport-reset', () => RESET],
    ['transport-client-timeout', () => TIMED_OUT],
    ['transport-tls', () => ({ kind: 'transport', errorName: 'TypeError', errorCode: 'SELF_SIGNED_CERT_IN_CHAIN' })],
  ];

  it.each(REFRESHED)('%s: availability untouched (never dl.bad-response), and one refresh cycle follows', async (_name, outcome) => {
    const { client, service } = await shownPrefile(outcome);
    const before = withoutAt(service.buildState());
    const made = client.routes.length;
    expect(await service.handle(req('clearance', { plannedLegId: 123 }))).toMatchObject({ ok: false });
    await flush();
    expect(paths(client, made)).toEqual([CLEARANCE_PATH(123), 'GET /api/status', 'GET /api/planned-legs/123/acars-messages']);
    const after = withoutAt(service.buildState());
    expect(after.state).toBe('dl.ok');
    expect(after.scope).toEqual(before.scope);
    expect(after.prefiledLeg).toEqual(before.prefiledLeg);
    expect(after.thread!.epoch).toBe(before.thread!.epoch);
    expect(states.map((state) => state.state)).not.toContain('dl.bad-response');
    await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS);
    expect(client.count('leg-clearance')).toBe(1);
  });

  it.each(['post-401-invalid-token', 'post-401-invalid-token-no-header'])('%s latches: held leg dropped, no request of any kind until a valid reload', async (name) => {
    let refuse = true;
    const { client, service } = await shownPrefile(() => (refuse ? fromClearance(name) : fromClearance('post-201-created')));
    expect(await service.handle(req('clearance', { plannedLegId: 123 }))).toEqual({
      ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' },
    });
    expect(last()).toMatchObject({ state: 'dl.token-invalid', httpStatus: 401, nextPollAt: null, scope: null, thread: null });
    expect(last()).not.toHaveProperty('prefiledLeg');
    expect(last().lastErrorAt).toBe(Date.now());
    expect(logs).toContain('warn Clearance token-invalid (HTTP 401)');
    const made = client.routes.length;
    const refused = { ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' } };
    await watchFor(service, 300000);
    expect(await service.handle(req('clearance', { plannedLegId: 123 }))).toEqual(refused);
    expect(await service.handle(req('refresh', {}))).toEqual(refused);
    service.onConfigApplied(false);
    await watchFor(service, 60000);
    expect(client.routes.length).toBe(made);
    refuse = false;
    service.onConfigApplied(true);
    await flush();
    expect(paths(client, made)).toEqual(['GET /api/status', 'GET /api/ground-sessions/current']);
  });

  it('404 on the held prefiled leg drops it, and the next cycle resolves a scope without it', async () => {
    const { client, service } = await shownPrefile(() => fromClearance('post-404-leg-not-found'));
    const made = client.routes.length;
    expect(await service.handle(req('clearance', { plannedLegId: 123 }))).toEqual({
      ok: false, error: { code: 'leg-not-found', httpStatus: 404, serverCode: 'PLANNED_LEG_NOT_FOUND' },
    });
    await flush();
    expect(paths(client, made)).toEqual([CLEARANCE_PATH(123), 'GET /api/status', 'GET /api/ground-sessions/current']);
    expect(last()).toMatchObject({ state: 'dl.ok', scope: { kind: 'none' }, thread: null });
    expect(last()).not.toHaveProperty('prefiledLeg');
    expect(states.some((state) => state.scope === null && !('prefiledLeg' in state))).toBe(true);
    expect(logs).toContain('warn Clearance leg-not-found (HTTP 404)');
    for (const line of logs) expect(line).not.toContain(CLEARANCE_SERVER_TEXT);
  });

  it('404 on another leg keeps the held leg, and the next cycle still uses it', async () => {
    const { client, service } = await shownPrefile(() => fromClearance('post-404-leg-not-found'));
    const emitted = states.length;
    const made = client.routes.length;
    expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ ok: false, error: { code: 'leg-not-found' } });
    await flush();
    expect(paths(client, made)).toEqual([CLEARANCE_PATH(12), 'GET /api/status', 'GET /api/planned-legs/123/acars-messages']);
    // Only the cycle emitted.
    expect(states.length).toBe(emitted + 1);
    expect(last()).toMatchObject({
      state: 'dl.ok', scope: { kind: 'leg', plannedLegId: 123, source: 'prefile' }, prefiledLeg: { plannedLegId: 123 },
    });
  });
});

describe('clearance against a scratch server through the real client', () => {
  beforeEach(() => {
    vi.useRealTimers();
    config = { token: SENTINEL_TOKEN, serverUrl: 'http://scratch.invalid' };
  });

  it.each([
    ['500', () => clearanceReply('post-500-internal-no-code')],
    ['502', () => () => ({ status: 502, body: { error: 'Bad gateway' } })],
    ['504', () => () => ({ status: 504, body: { error: 'Gateway timeout' } })],
    ['reset', () => () => ({ destroy: true as const })],
    ['client timeout', () => () => 'hang' as const],
  ])('%s: the server records exactly one POST, while a second press is refused and through three poll intervals', async (_name, handler) => {
    const server = await startScratchServer({ 'POST /api/planned-legs/12/acars-messages/clearance': handler() as never });
    const uplink = new Uplink(scratchConfig(server.baseUrl));
    const real = new DatalinkClient(() => uplink, { timeoutMs: 300 });
    // The clearance goes to the scratch server; the poll GETs are scripted so
    // fake time can drive the schedule without real sockets under it.
    const polls = new ScriptedClient(groundServer());
    const service = makePrefileService({
      request: (route, abort) => (route.key === 'leg-clearance' ? real.request(route, abort) : polls.request(route)),
    });
    try {
      const first = service.handle(req('clearance', { plannedLegId: 12 }));
      expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({
        ok: false, error: { code: 'clearance-in-progress' },
      });
      expect(await first).toMatchObject({ ok: false });
      expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([CLEARANCE_PATH(12)]);
      expect(server.requests[0].body).toBe('');
      expect(server.requests[0].headers['x-ingest-token']).toBe(SENTINEL_TOKEN);

      vi.useFakeTimers();
      await service.handle(req('watch', { on: true }));
      await watchFor(service, 3 * DATALINK_POLL_INTERVAL_MS + 5000);
      expect(polls.count('status')).toBeGreaterThanOrEqual(4);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(server.requests).toHaveLength(1);

      // Settled: a new press is accepted and makes its own single POST.
      expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({ ok: false });
      expect(server.requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      service.shutdown();
      await uplink.close();
      await server.close();
    }
  });

  it.each(['post-401-no-scope-header', 'post-401-token-missing'])('%s: nothing moves, and a thread GET and a WX op still succeed on the same server', async (name) => {
    const server = await startScratchServer({
      'GET /api/status': reply('01b-get-status-ground-leg'),
      'GET /api/planned-legs/12/acars-messages': reply('06-get-leg-thread'),
      'POST /api/planned-legs/12/acars-messages/wx': reply('08-post-leg-wx'),
      'POST /api/planned-legs/12/acars-messages/clearance': clearanceReply(name),
    });
    const uplink = new Uplink(scratchConfig(server.baseUrl));
    const service = makePrefileService(new DatalinkClient(() => uplink));
    const settle = async (predicate: () => boolean) => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(predicate()).toBe(true);
    };
    try {
      await service.handle(req('watch', { on: true }));
      await settle(() => states.length > 0 && last().state === 'dl.ok');
      const before = withoutAt(service.buildState());
      const emitted = states.length;
      expect(await service.handle(req('clearance', { plannedLegId: 12 }))).toMatchObject({
        ok: false, error: { code: clearanceFixture(name).expect.code, httpStatus: 401 },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(withoutAt(service.buildState())).toEqual(before);
      expect(states.length).toBe(emitted);

      expect(await service.handle(req('thread', { epoch: before.thread!.epoch, endSeq: 1 }))).toMatchObject({ ok: true });
      expect(await service.handle(req('wx', { target: { kind: 'leg', id: 12 }, icao: 'LFPG' }))).toMatchObject({
        ok: true, result: { icao: 'LFPG' },
      });
      // The WX write refreshes: the thread GET succeeds on the same server.
      await settle(() => server.requests.filter((r) => r.path === '/api/planned-legs/12/acars-messages').length === 2);
      await settle(() => states.length > emitted && last().state === 'dl.ok');
      expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /api/status',
        'GET /api/planned-legs/12/acars-messages',
        CLEARANCE_PATH(12),
        'POST /api/planned-legs/12/acars-messages/wx',
        'GET /api/status',
        'GET /api/planned-legs/12/acars-messages',
      ]);
    } finally {
      service.shutdown();
      await uplink.close();
      await server.close();
    }
  });
});
