// tests/datalink-sentinel.test.ts — the token boundary, end to end inside the
// sidecar: service, real client, scratch server, sentinel token.
//
// The token has exactly one legitimate place, the x-ingest-token request
// header. Every other surface the datalink produces is collected here and
// searched for it: state and response lines as they would be written to
// stdout, log messages, classifier results, and every request URL and body the
// server saw. Server bodies deliberately echo the token back.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyOutcome, type HttpOutcome } from '../src/datalink-classify';
import { DatalinkClient, type DatalinkRoute } from '../src/datalink-client';
import { DatalinkService } from '../src/datalink-service';
import {
  encodeDatalinkResponse,
  encodeSidecarMessage,
  type DatalinkRequestMessage,
} from '../src/protocol';
import { Uplink } from '../src/uplink';
import {
  closedPort,
  reply,
  scratchConfig,
  SENTINEL_TOKEN,
  startScratchServer,
  type ScratchHandler,
  type ScratchServer,
} from './helpers/datalink-scratch-server';

const echo = (status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): ScratchHandler =>
  () => ({ status, headers, body: { error: `token was ${SENTINEL_TOKEN}`, ...extra } });

const THREAD_WITH_TOKEN = {
  flight_id: 92,
  planned_leg_id: 12,
  messages: [
    {
      id: 1, flight_id: 92, planned_leg_id: null, direction: 'uplink', category: 'dispatch',
      label: `LABEL ${SENTINEL_TOKEN}`, body: `BODY ${SENTINEL_TOKEN} END`, payload_json: SENTINEL_TOKEN,
      correlation_id: null, dedup_key: SENTINEL_TOKEN, sent_at: '2026-09-16T12:00:00.000Z', read_at: null,
    },
  ],
};

const surfaces: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  surfaces.length = 0;
});

async function harness(serverUrl: string, server: ScratchServer | null, token = SENTINEL_TOKEN) {
  const uplink = new Uplink(
    scratchConfig(serverUrl, { ingestToken: token }),
    (level, message) => surfaces.push(`uplink-log ${level} ${message}`),
  );
  const real = new DatalinkClient(() => uplink, { timeoutMs: 2000 });
  const client = {
    async request(route: DatalinkRoute, abort?: AbortSignal): Promise<HttpOutcome> {
      const outcome = await real.request(route, abort);
      // A successful classification carries the raw server JSON on to
      // projection and is never output; every error value is.
      for (const context of ['poll', 'op'] as const) {
        const classified = classifyOutcome(outcome, context, uplink.getConfig().ingestToken);
        if (!classified.ok) surfaces.push(`classified-${context} ${JSON.stringify(classified)}`);
      }
      return outcome;
    },
  };
  const service = new DatalinkService({
    client,
    hasConfig: () => true,
    token: () => uplink.getConfig().ingestToken,
    emitState: (message) => surfaces.push(encodeSidecarMessage(message)),
    log: (level, message) =>
      surfaces.push(encodeSidecarMessage({ v: 1, type: 'log', at: Date.now(), level, message })),
  });
  let n = 1;
  const send = async (op: DatalinkRequestMessage['op'], params: unknown) => {
    const id = `dl-${n++}`;
    const outcome = await service.handle({ v: 1, type: 'datalink-request', id, op, params } as DatalinkRequestMessage);
    const line = outcome.ok
      ? encodeDatalinkResponse({ v: 1, type: 'datalink-response', at: Date.now(), id, ok: true, result: outcome.result })
      : encodeDatalinkResponse({ v: 1, type: 'datalink-response', at: Date.now(), id, ok: false, error: outcome.error });
    surfaces.push(line);
    return JSON.parse(line) as { ok: boolean; result?: unknown; error?: { code: string } };
  };
  cleanups.push(async () => {
    service.shutdown();
    await uplink.close();
    if (server) await server.close();
  });
  return { service, send };
}

function assertSentinelAbsent(server: ScratchServer | null, token = SENTINEL_TOKEN): void {
  expect(surfaces.length).toBeGreaterThan(0);
  for (const line of surfaces) {
    expect(line).not.toContain(token);
    expect(line).not.toContain(token.slice(0, 16));
  }
  if (server) {
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) {
      expect(request.path).not.toContain(token);
      expect(request.body).not.toContain(token);
      expect(request.headers['x-ingest-token']).toBe(token);
    }
  }
}

describe('the ingest token never leaves the request header', () => {
  it('success: a thread body echoing the token is projected with [REDACTED]', async () => {
    const server = await startScratchServer({
      'GET /api/status': () => ({ status: 200, body: { currentFlightId: 92, note: SENTINEL_TOKEN } }),
      'GET /api/flights/92/acars-messages': () => ({ status: 200, body: THREAD_WITH_TOKEN }),
      'GET /api/acars/canned-messages': () => ({
        status: 200,
        body: { messages: [{ id: 'c1', label: `SEND ${SENTINEL_TOKEN}`, direction: 'downlink' }] },
      }),
    });
    const { send } = await harness(server.baseUrl, server);
    await send('watch', { on: true });
    await vi.waitFor(() => expect(surfaces.join('')).toContain('"state":"dl.ok"'));
    const thread = await send('thread', { epoch: 1, endSeq: 1 });
    expect(JSON.stringify(thread)).toContain('BODY [REDACTED] END');
    const canned = await send('canned-list', {});
    expect(JSON.stringify(canned)).toContain('SEND [REDACTED]');
    assertSentinelAbsent(server);
  });

  it.each([
    ['401 INVALID_INGEST_TOKEN', echo(401, { code: 'INVALID_INGEST_TOKEN' }), 'dl.token-invalid'],
    ['401 scope accepted', echo(401, {}, { 'X-Ingest-Token-Scope': 'accepted' }), 'dl.token-missing'],
    ['401 no scope header', echo(401), 'dl.unavailable'],
    ['403 cross-origin', echo(403), 'dl.rejected'],
  ])('%s', async (_name, handler, state) => {
    const server = await startScratchServer({
      'GET /api/status': handler,
      'GET /api/acars/canned-messages': handler,
      'POST /api/flights/92/acars-messages/wx': handler,
    });
    const { send } = await harness(server.baseUrl, server);
    await send('watch', { on: true });
    await vi.waitFor(() => expect(surfaces.join('')).toContain(`"state":"${state}"`));
    await send('canned-list', {});
    await send('wx', { target: { kind: 'flight', id: 92 }, icao: 'EGLL' });
    expect(surfaces.some((line) => line.includes(`Datalink ${state} (HTTP `))).toBe(true);
    assertSentinelAbsent(server);
  });

  it('409 NO_DISPATCH_DATA', async () => {
    const server = await startScratchServer({
      'POST /api/planned-legs/12/acars-messages/loadsheet': echo(409, { code: 'NO_DISPATCH_DATA' }),
    });
    const { send } = await harness(server.baseUrl, server);
    expect(await send('loadsheet', { plannedLegId: 12 })).toMatchObject({ ok: false, error: { code: 'no-dispatch-data' } });
    assertSentinelAbsent(server);
  });

  it('unreachable', async () => {
    const port = await closedPort();
    const { send } = await harness(`http://127.0.0.1:${port}`, null);
    await send('watch', { on: true });
    await vi.waitFor(() => expect(surfaces.join('')).toContain('"state":"dl.unreachable"'));
    expect(await send('canned-list', {})).toMatchObject({ ok: false, error: { code: 'unreachable' } });
    assertSentinelAbsent(null);
  });
});

describe('a token shaped like a server code never comes back as serverCode', () => {
  // Upper-case letters, digits and underscores only: this token matches the
  // server-code pattern, which a hyphenated sentinel never can.
  const CODE_TOKEN = 'SENTINELDATALINKTOKEN0000';
  const codeEcho = (status: number, headers: Record<string, string> = {}): ScratchHandler =>
    () => ({ status, headers, body: { error: `token was ${CODE_TOKEN}`, code: CODE_TOKEN } });

  it.each([
    ['401 with the scope header', 401, { 'X-Ingest-Token-Scope': 'accepted' }, 'dl.token-missing'],
    ['401 without the scope header', 401, {}, 'dl.unavailable'],
    ['403', 403, {}, 'dl.rejected'],
    ['500', 500, {}, 'dl.http-error'],
  ])('%s: state, response, log and classification carry no token', async (_name, status, headers, state) => {
    const handler = codeEcho(status, headers);
    const server = await startScratchServer({
      'GET /api/status': handler,
      'GET /api/acars/canned-messages': handler,
      'POST /api/flights/92/acars-messages/wx': handler,
    });
    const { send } = await harness(server.baseUrl, server, CODE_TOKEN);
    await send('watch', { on: true });
    await vi.waitFor(() => expect(surfaces.join('')).toContain(`"state":"${state}"`));
    expect(await send('canned-list', {})).toMatchObject({ ok: false, error: { serverCode: null } });
    await send('wx', { target: { kind: 'flight', id: 92 }, icao: 'EGLL' });
    expect(surfaces.some((line) => line.includes(`Datalink ${state} (HTTP ${status})`))).toBe(true);
    expect(surfaces.some((line) => line.includes('"serverCode":null'))).toBe(true);
    assertSentinelAbsent(server, CODE_TOKEN);
  });

  it('409 on the load sheet: the response carries no token', async () => {
    const server = await startScratchServer({
      'POST /api/planned-legs/12/acars-messages/loadsheet': codeEcho(409),
    });
    const { send } = await harness(server.baseUrl, server, CODE_TOKEN);
    expect(await send('loadsheet', { plannedLegId: 12 })).toEqual({
      v: 1, type: 'datalink-response', at: expect.any(Number), id: 'dl-1', ok: false,
      error: { code: 'http-error', httpStatus: 409, serverCode: null },
    });
    assertSentinelAbsent(server, CODE_TOKEN);
  });

  it('inspector output carries no token', async () => {
    const handler = codeEcho(401);
    const server = await startScratchServer({
      'GET /api/status': codeEcho(403),
      'GET /api/ground-sessions/current': handler,
      'GET /api/acars/canned-messages': codeEcho(409),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-inspector-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(scratchConfig(server.baseUrl, { ingestToken: CODE_TOKEN })));
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const log = vi.spyOn(console, 'log').mockImplementation(capture);
    const err = vi.spyOn(console, 'error').mockImplementation(capture);
    try {
      const { runInspector } = await import('../src/inspect-datalink');
      expect(await runInspector(['--config', configPath])).toBe(1);
    } finally {
      log.mockRestore();
      err.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
      await server.close();
    }
    expect(lines).toContain('token       : <set, redacted>');
    expect(lines.filter((line) => line.startsWith('GET '))).toEqual([
      'GET /api/status http=403 class=rejected state=dl.rejected',
      'GET /api/ground-sessions/current http=401 class=unavailable state=dl.unavailable',
      'GET /api/acars/canned-messages http=409 class=http-error state=dl.http-error',
    ]);
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
    for (const line of lines) expect(line).not.toContain(CODE_TOKEN);
  });
});

describe('a token that is a substring of a real server code, end to end', () => {
  it('INGEST_TOKEN: 401 INVALID_INGEST_TOKEN latches polling and every surface has serverCode null', async () => {
    const server = await startScratchServer({
      'GET /api/status': reply('err-401-invalid-token'),
      'GET /api/acars/canned-messages': reply('err-401-invalid-token'),
    });
    const { service, send } = await harness(server.baseUrl, server, 'INGEST_TOKEN');
    await send('watch', { on: true });
    await vi.waitFor(() => expect(surfaces.join('')).toContain('"state":"dl.token-invalid"'));
    const state = JSON.parse(surfaces.filter((line) => line.includes('"type":"datalink-state"')).pop()!);
    expect(state).toMatchObject({ state: 'dl.token-invalid', serverCode: null, nextPollAt: null });
    expect(await send('refresh', {})).toMatchObject({ ok: false, error: { code: 'token-invalid', serverCode: null } });
    expect(await send('canned-list', {})).toMatchObject({ ok: false, error: { code: 'token-invalid', serverCode: null } });
    expect(server.requests).toHaveLength(1);
    assertSentinelAbsent(server, 'INGEST_TOKEN');

    service.onConfigApplied(true);
    await vi.waitFor(() => expect(server.requests).toHaveLength(2));
  });

  it('DISPATCH_DATA: 409 NO_DISPATCH_DATA on the load sheet is no-dispatch-data with serverCode null', async () => {
    const server = await startScratchServer({
      'POST /api/planned-legs/12/acars-messages/loadsheet': reply('err-409-no-dispatch-data'),
    });
    const { send } = await harness(server.baseUrl, server, 'DISPATCH_DATA');
    expect(await send('loadsheet', { plannedLegId: 12 })).toMatchObject({
      ok: false, error: { code: 'no-dispatch-data', httpStatus: 409, serverCode: null },
    });
    assertSentinelAbsent(server, 'DISPATCH_DATA');
  });
});
