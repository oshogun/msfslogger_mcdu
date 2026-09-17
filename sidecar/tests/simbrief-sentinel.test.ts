// tests/simbrief-sentinel.test.ts — the token boundary for the SimBrief ops,
// end to end inside the sidecar: service, real client, scratch server,
// sentinel token.
//
// Every SimBrief server sample is served on both SimBrief routes with the
// token echoed into its body wherever the sample leaves room, and the local
// transport rows are driven beside them. Every surface the ops produce is
// collected and searched: response and state lines as written to stdout, log
// lines, classifier results, and every request URL and body the server saw.
// The inspector's settings line is checked the same way.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpOutcome } from '../src/datalink-classify';
import { DatalinkClient, type DatalinkRoute } from '../src/datalink-client';
import { DatalinkService } from '../src/datalink-service';
import { encodeDatalinkResponse, encodeSidecarMessage, type DatalinkRequestMessage } from '../src/protocol';
import { classifySimbriefOutcome } from '../src/simbrief-model';
import { Uplink } from '../src/uplink';
import {
  closedPort,
  scratchConfig,
  SIMBRIEF_CODE_TOKEN,
  SIMBRIEF_SENTINEL_TOKEN,
  simbriefFixture,
  simbriefFixtureNames,
  startScratchServer,
  type ScratchHandler,
  type ScratchServer,
} from './helpers/datalink-scratch-server';

const surfaces: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  surfaces.length = 0;
});

/** The sample's answer, with the token added wherever it would not change the classification. */
function echoing(name: string, token: string): ScratchHandler {
  const { response } = simbriefFixture(name);
  let body: unknown = response.body;
  if (typeof body === 'string') {
    body = `${body} ${token}`;
  } else if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const echoed: Record<string, unknown> = { ...(body as Record<string, unknown>), error: `token was ${token}` };
    const result = echoed.result;
    if (typeof result === 'object' && result !== null) {
      echoed.result = { ...(result as Record<string, unknown>), error: token, warnings: [token] };
    }
    body = echoed;
  }
  return () => ({ status: response.status, headers: { ...response.headers, 'x-echo': token }, body });
}

async function harness(serverUrl: string, server: ScratchServer | null, token: string) {
  const uplink = new Uplink(
    scratchConfig(serverUrl, { ingestToken: token }),
    (level, message) => surfaces.push(`uplink-log ${level} ${message}`),
  );
  const real = new DatalinkClient(() => uplink, { timeoutMs: 2000, prefileTimeoutMs: 300 });
  const client = {
    async request(route: DatalinkRoute, abort?: AbortSignal): Promise<HttpOutcome> {
      const outcome = await real.request(route, abort);
      if (route.key === 'simbrief-settings' || route.key === 'simbrief-prefile') {
        const classified = classifySimbriefOutcome(outcome, token);
        if (!classified.ok) surfaces.push(`classified ${JSON.stringify(classified)}`);
      }
      return outcome;
    },
  };
  const service = new DatalinkService({
    client,
    hasConfig: () => true,
    token: () => uplink.getConfig().ingestToken,
    serverUrl: () => uplink.getConfig().serverUrl,
    emitState: (message) => surfaces.push(encodeSidecarMessage(message)),
    log: (level, message) => surfaces.push(encodeSidecarMessage({ v: 1, type: 'log', at: Date.now(), level, message })),
  });
  let n = 1;
  const send = async (op: DatalinkRequestMessage['op']) => {
    const id = `dl-${n++}`;
    const outcome = await service.handle({ v: 1, type: 'datalink-request', id, op, params: {} } as DatalinkRequestMessage);
    const line = outcome.ok
      ? encodeDatalinkResponse({ v: 1, type: 'datalink-response', at: Date.now(), id, ok: true, result: outcome.result })
      : encodeDatalinkResponse({ v: 1, type: 'datalink-response', at: Date.now(), id, ok: false, error: outcome.error });
    surfaces.push(line);
    return JSON.parse(line) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
  };
  cleanups.push(async () => {
    service.shutdown();
    await uplink.close();
    if (server) await server.close();
  });
  return { service, send };
}

function assertTokenAbsent(server: ScratchServer | null, token: string): void {
  expect(surfaces.length).toBeGreaterThan(0);
  for (const line of surfaces) {
    expect(line).not.toContain(token);
    expect(line).not.toContain(token.slice(0, 16));
  }
  if (server) {
    for (const request of server.requests) {
      expect(request.path).not.toContain(token);
      expect(request.body).toBe('');
      expect(request.headers['x-ingest-token']).toBe(token);
    }
  }
}

describe('the ingest token never leaves the request header on the SimBrief routes', () => {
  it.each(simbriefFixtureNames())('%s, on both routes', async (name) => {
    const sample = simbriefFixture(name);
    const token = sample.configToken ?? SIMBRIEF_SENTINEL_TOKEN;
    const handler = echoing(name, token);
    const server = await startScratchServer({
      'GET /api/settings/simbrief': handler,
      'POST /api/planned-legs/simbrief': handler,
    });
    const { service, send } = await harness(server.baseUrl, server, token);
    // The sample's own route first, so its answer is the one a latch follows.
    const ownIsSettings = sample.request.path === '/api/settings/simbrief';
    const own = await send(ownIsSettings ? 'simbrief-settings' : 'simbrief-prefile');
    await send(ownIsSettings ? 'simbrief-prefile' : 'simbrief-settings');
    expect(own.ok).toBe(sample.expect.ok);
    if (!own.ok) expect(own.error?.code).toBe(sample.expect.code);
    surfaces.push(encodeSidecarMessage(service.buildState()));
    await send('prefile-clear');
    for (const request of server.requests) {
      expect(['GET /api/settings/simbrief', 'POST /api/planned-legs/simbrief']).toContain(`${request.method} ${request.path}`);
    }
    expect(server.requests.length).toBeGreaterThanOrEqual(1);
    expect(surfaces.some((line) => line.includes('"message":"SimBrief '))).toBe(true);
    assertTokenAbsent(server, token);
  });

  it('a code-shaped token echoed as the code is emitted as serverCode null', async () => {
    const server = await startScratchServer({
      'GET /api/settings/simbrief': echoing('post-401-code-shaped-token', SIMBRIEF_CODE_TOKEN),
      'POST /api/planned-legs/simbrief': () => ({ status: 504, body: { error: SIMBRIEF_CODE_TOKEN, code: SIMBRIEF_CODE_TOKEN } }),
    });
    const { send } = await harness(server.baseUrl, server, SIMBRIEF_CODE_TOKEN);
    expect(await send('simbrief-settings')).toMatchObject({
      ok: false, error: { code: 'simbrief-unavailable', httpStatus: 401, serverCode: null },
    });
    expect(await send('simbrief-prefile')).toMatchObject({
      ok: false, error: { code: 'http-error', httpStatus: 504, serverCode: null },
    });
    assertTokenAbsent(server, SIMBRIEF_CODE_TOKEN);
  });

  it('local rows: refused, reset and client timeout', async () => {
    const port = await closedPort();
    const offline = await harness(`http://127.0.0.1:${port}`, null, SIMBRIEF_SENTINEL_TOKEN);
    expect(await offline.send('simbrief-settings')).toMatchObject({ ok: false, error: { code: 'unreachable' } });
    expect(await offline.send('simbrief-prefile')).toMatchObject({ ok: false, error: { code: 'unreachable' } });

    const server = await startScratchServer({
      'GET /api/settings/simbrief': () => ({ destroy: true }),
      'POST /api/planned-legs/simbrief': () => 'hang',
    });
    const { send } = await harness(server.baseUrl, server, SIMBRIEF_SENTINEL_TOKEN);
    expect(await send('simbrief-settings')).toMatchObject({ ok: false, error: { code: 'unreachable' } });
    expect(await send('simbrief-prefile')).toMatchObject({ ok: false, error: { code: 'timeout' } });
    assertTokenAbsent(server, SIMBRIEF_SENTINEL_TOKEN);
  });

  it('inspector: prints the settings line without the token or the Pilot ID, and makes no POST', async () => {
    const server = await startScratchServer({
      'GET /api/status': () => ({ status: 200, body: { currentFlightId: null, note: SIMBRIEF_SENTINEL_TOKEN } }),
      'GET /api/ground-sessions/current': () => ({ status: 200, body: { session: null } }),
      'GET /api/acars/canned-messages': () => ({ status: 200, body: { messages: [] } }),
      'GET /api/settings/simbrief': () => ({
        status: 200,
        headers: { 'x-ingest-token-scope': 'accepted' },
        body: { simbrief_user_id: '1234567', note: SIMBRIEF_SENTINEL_TOKEN },
      }),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simbrief-inspector-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(scratchConfig(server.baseUrl, { ingestToken: SIMBRIEF_SENTINEL_TOKEN })));
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const log = vi.spyOn(console, 'log').mockImplementation(capture);
    const err = vi.spyOn(console, 'error').mockImplementation(capture);
    let code: number;
    try {
      const { runInspector } = await import('../src/inspect-datalink');
      code = await runInspector(['--config', configPath]);
    } finally {
      log.mockRestore();
      err.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
      await server.close();
    }
    expect(code).toBe(0);
    expect(lines).toContain('GET /api/settings/simbrief http=200 class=ok configured=yes');
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(SIMBRIEF_SENTINEL_TOKEN);
      expect(line).not.toContain('1234567');
    }
  });
});
