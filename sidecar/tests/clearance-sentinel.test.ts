// tests/clearance-sentinel.test.ts — the token boundary for the clearance op,
// end to end inside the sidecar: service, real client, scratch server,
// sentinel token.
//
// Every clearance server sample is served with the token echoed into its body
// wherever the sample leaves room, and the local rows (refused, reset, client
// timeout, body over the cap, no config, latched, in progress) are driven
// beside them. Every surface the op produces is collected and searched:
// response and state lines as written to stdout, log lines, classifier results,
// error values, and every request URL and body the server saw. The server's
// own error text is searched for the same way.

import { afterEach, describe, expect, it } from 'vitest';
import { classifyClearanceOutcome } from '../src/clearance-model';
import type { HttpOutcome } from '../src/datalink-classify';
import { DatalinkClient, type DatalinkClientOptions, type DatalinkRoute } from '../src/datalink-client';
import { DatalinkService } from '../src/datalink-service';
import { encodeDatalinkResponse, encodeSidecarMessage, type DatalinkRequestMessage } from '../src/protocol';
import { Uplink } from '../src/uplink';
import {
  CLEARANCE_CODE_TOKEN,
  CLEARANCE_SENTINEL_TOKEN,
  CLEARANCE_SERVER_TEXT,
  clearanceFixture,
  clearanceFixtureNames,
  closedPort,
  scratchConfig,
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
  const { response } = clearanceFixture(name);
  let body: unknown = response.body;
  if (typeof body === 'string') {
    body = `${body} ${token}`;
  } else if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const echoed: Record<string, unknown> = { ...(body as Record<string, unknown>), error: `${CLEARANCE_SERVER_TEXT} ${token}` };
    for (const member of ['request', 'reply']) {
      const message = echoed[member];
      if (typeof message === 'object' && message !== null) {
        echoed[member] = { ...(message as Record<string, unknown>), body: `PDC ${token}`, payload_json: token, label: token };
      }
    }
    body = echoed;
  }
  return () => ({ status: response.status, headers: { ...response.headers, 'x-echo': token }, body });
}

async function harness(
  serverUrl: string,
  server: ScratchServer | null,
  token: string,
  options: { hasConfig?: () => boolean; client?: DatalinkClientOptions } = {},
) {
  const uplink = new Uplink(
    scratchConfig(serverUrl, { ingestToken: token }),
    (level, message) => surfaces.push(`uplink-log ${level} ${message}`),
  );
  const real = new DatalinkClient(() => uplink, { timeoutMs: 300, ...options.client });
  const client = {
    async request(route: DatalinkRoute, abort?: AbortSignal): Promise<HttpOutcome> {
      surfaces.push(`url ${serverUrl}${route.key === 'leg-clearance' ? `/api/planned-legs/${route.id}` : ''}`);
      const outcome = await real.request(route, abort);
      if (route.key === 'leg-clearance') {
        // A 2xx carries the parsed body, which is internal; a failure is what could be forwarded.
        const classified = classifyClearanceOutcome(outcome, token);
        if (!classified.ok) surfaces.push(`classified ${JSON.stringify(classified)}`);
      }
      return outcome;
    },
  };
  const service = new DatalinkService({
    client,
    hasConfig: options.hasConfig ?? (() => true),
    token: () => uplink.getConfig().ingestToken,
    serverUrl: () => uplink.getConfig().serverUrl,
    emitState: (message) => surfaces.push(encodeSidecarMessage(message)),
    log: (level, message) => surfaces.push(encodeSidecarMessage({ v: 1, type: 'log', at: Date.now(), level, message })),
  });
  let n = 1;
  const send = async (op: DatalinkRequestMessage['op'], params: Record<string, unknown>) => {
    const id = `dl-${n++}`;
    const outcome = await service.handle({ v: 1, type: 'datalink-request', id, op, params } as DatalinkRequestMessage);
    surfaces.push(`value ${JSON.stringify(outcome)}`);
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
    expect(line).not.toContain(CLEARANCE_SERVER_TEXT);
  }
  if (server) {
    for (const request of server.requests) {
      expect(request.path).not.toContain(token);
      expect(request.body).toBe('');
      expect(request.headers['x-ingest-token']).toBe(token);
    }
  }
}

describe('the ingest token never leaves the request header on the clearance route', () => {
  it.each(clearanceFixtureNames())('%s', async (name) => {
    const sample = clearanceFixture(name);
    const token = sample.configToken ?? CLEARANCE_SENTINEL_TOKEN;
    const server = await startScratchServer({ [`${sample.request.method} ${sample.request.path}`]: echoing(name, token) });
    const { service, send } = await harness(server.baseUrl, server, token);
    const answer = await send('clearance', { plannedLegId: 12 });
    expect(answer.ok).toBe(sample.expect.ok);
    if (!answer.ok) expect(answer.error?.code).toBe(sample.expect.code);
    if (name === 'post-201-route-contains-token') expect(answer.result?.route).toBe('GREKI [REDACTED] DCT');
    // A second press after a latch is refused locally; otherwise it is one more POST.
    await send('clearance', { plannedLegId: 12 });
    surfaces.push(encodeSidecarMessage(service.buildState()));
    for (const request of server.requests) {
      expect(`${request.method} ${request.path}`).toBe('POST /api/planned-legs/12/acars-messages/clearance');
    }
    expect(server.requests.length).toBe(sample.expect.latch ? 1 : 2);
    expect(surfaces.some((line) => line.includes('"message":"Clearance '))).toBe(true);
    assertTokenAbsent(server, token);
  });

  it('a code-shaped token echoed as the code is emitted as serverCode null on every status', async () => {
    const server = await startScratchServer({
      'POST /api/planned-legs/12/acars-messages/clearance': echoing('post-401-code-shaped-token', CLEARANCE_CODE_TOKEN),
      'POST /api/planned-legs/13/acars-messages/clearance': () => ({
        status: 404, body: { error: CLEARANCE_CODE_TOKEN, code: CLEARANCE_CODE_TOKEN },
      }),
      'POST /api/planned-legs/14/acars-messages/clearance': () => ({
        status: 409, headers: { 'x-ingest-token-scope': 'accepted' }, body: { code: CLEARANCE_CODE_TOKEN },
      }),
    });
    const { send } = await harness(server.baseUrl, server, CLEARANCE_CODE_TOKEN);
    expect(await send('clearance', { plannedLegId: 12 })).toMatchObject({
      ok: false, error: { code: 'clearance-unavailable', httpStatus: 401, serverCode: null },
    });
    expect(await send('clearance', { plannedLegId: 13 })).toMatchObject({
      ok: false, error: { code: 'http-error', httpStatus: 404, serverCode: null },
    });
    expect(await send('clearance', { plannedLegId: 14 })).toMatchObject({
      ok: false, error: { code: 'http-error', httpStatus: 409, serverCode: null },
    });
    assertTokenAbsent(server, CLEARANCE_CODE_TOKEN);
  });

  it('local rows: refused, reset, client timeout, body over the cap, no config, latched, in progress', async () => {
    const port = await closedPort();
    const offline = await harness(`http://127.0.0.1:${port}`, null, CLEARANCE_SENTINEL_TOKEN);
    expect(await offline.send('clearance', { plannedLegId: 12 })).toMatchObject({ ok: false, error: { code: 'unreachable' } });

    let configured = true;
    const server = await startScratchServer({
      'POST /api/planned-legs/12/acars-messages/clearance': () => ({ destroy: true }),
      'POST /api/planned-legs/13/acars-messages/clearance': () => 'hang',
      'POST /api/planned-legs/14/acars-messages/clearance': () => ({
        status: 201, body: { planned_leg_id: 14, note: `${CLEARANCE_SENTINEL_TOKEN}${'x'.repeat(4096)}` },
      }),
      'POST /api/planned-legs/15/acars-messages/clearance': echoing('post-401-invalid-token', CLEARANCE_SENTINEL_TOKEN),
    });
    const { send } = await harness(server.baseUrl, server, CLEARANCE_SENTINEL_TOKEN, {
      hasConfig: () => configured,
      client: { maxBodyBytes: 1024 },
    });
    expect(await send('clearance', { plannedLegId: 12 })).toMatchObject({ ok: false, error: { code: 'unreachable' } });
    const hung = send('clearance', { plannedLegId: 13 });
    expect(await send('clearance', { plannedLegId: 13 })).toMatchObject({ ok: false, error: { code: 'clearance-in-progress' } });
    expect(await hung).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(await send('clearance', { plannedLegId: 14 })).toMatchObject({
      ok: false, error: { code: 'bad-response', httpStatus: 201 },
    });
    configured = false;
    expect(await send('clearance', { plannedLegId: 15 })).toMatchObject({ ok: false, error: { code: 'no-config' } });
    configured = true;
    expect(await send('clearance', { plannedLegId: 15 })).toMatchObject({ ok: false, error: { code: 'token-invalid' } });
    expect(await send('clearance', { plannedLegId: 15 })).toMatchObject({
      ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' },
    });
    expect(server.requests.map((r) => r.path)).toEqual([
      '/api/planned-legs/12/acars-messages/clearance',
      '/api/planned-legs/13/acars-messages/clearance',
      '/api/planned-legs/14/acars-messages/clearance',
      '/api/planned-legs/15/acars-messages/clearance',
    ]);
    assertTokenAbsent(server, CLEARANCE_SENTINEL_TOKEN);
  });
});
