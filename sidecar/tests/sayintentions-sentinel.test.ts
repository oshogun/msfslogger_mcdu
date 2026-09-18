// tests/sayintentions-sentinel.test.ts — the token boundary for the five
// SayIntentions ops, end to end inside the sidecar: service, real client,
// scratch server on an ephemeral port, sentinel token.
//
// Every server sample is served with the token echoed into its body and its
// headers wherever the sample leaves room, and the locally refused rows (the
// in-flight guard, a latched token, no config) are driven beside them. Every
// surface an op produces is collected and searched: the response and state
// lines as they would be written to stdout, the log lines, the error values,
// anything the process wrote to stdout or stderr while the op ran, and every
// request path and body the server saw. The masked API key and the server's own
// error prose are searched for the same way.
//
// The scratch server lists exactly the route each case expects and answers 599
// to anything else, so "no unexpected request was made" is asserted rather than
// assumed — including for the ops that must send nothing at all.

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatalinkClient, type DatalinkClientOptions, type DatalinkRoute } from '../src/datalink-client';
import type { HttpOutcome } from '../src/datalink-classify';
import { DatalinkService } from '../src/datalink-service';
import { encodeDatalinkResponse, encodeSidecarMessage, type DatalinkRequestMessage } from '../src/protocol';
import { classifySayIntentionsOutcome } from '../src/sayintentions-model';
import { Uplink } from '../src/uplink';
import {
  scratchConfig,
  SENTINEL_TOKEN,
  startScratchServer,
  type ScratchHandler,
  type ScratchServer,
} from './helpers/datalink-scratch-server';

/** Upper-case letters and digits only, so it is itself a well-formed server code. */
const CODE_TOKEN = 'SENTINELDATALINKTOKEN0000';
/** The `error` prose the samples carry; it must never be forwarded or logged. */
const SERVER_TEXT = 'SENTINEL-SI-ERROR-TEXT-DO-NOT-SHOW';

type Op = 'si-status' | 'si-link' | 'si-unlink' | 'si-import' | 'si-pdc';

interface Sample {
  _sample: string;
  _op: Op;
  _requested?: number | null;
  _from?: 'now' | 'session-start';
  _bodyTooLarge?: boolean;
  configToken?: string;
  request: { method: string; path: string };
  response: { status: number; headers: Record<string, string>; body: unknown };
  expect: { ok: boolean; code?: string; httpStatus?: number | null; serverCode?: string | null; latch?: boolean };
}

const DIR = path.join(__dirname, 'fixtures', 'sayintentions');

function sample(name: string): Sample {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as Sample;
}

function sampleNames(): string[] {
  return fs
    .readdirSync(DIR)
    .filter((file) => file.endsWith('.json') && file !== 'local-outcomes.json')
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

function paramsOf(s: Sample): Record<string, unknown> {
  switch (s._op) {
    case 'si-status':
      return { flightId: s._requested ?? null };
    case 'si-link':
      return { flightId: s._requested, from: s._from ?? 'session-start' };
    case 'si-pdc':
      return { plannedLegId: s._requested };
    default:
      return { flightId: s._requested };
  }
}

const surfaces: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  surfaces.length = 0;
});

/** The sample's answer, with the token added wherever it would not change the classification. */
function echoing(name: string, token: string): ScratchHandler {
  const { response } = sample(name);
  let body: unknown = response.body;
  if (typeof body === 'string') {
    body = `${body} ${token}`;
  } else if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    body = {
      ...(body as Record<string, unknown>),
      error: `${SERVER_TEXT} ${token}`,
      note: token,
      sayintentions_api_key_masked: `si_1…${token}`,
    };
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
  const real = new DatalinkClient(() => uplink, { timeoutMs: 300, sayintentionsTimeoutMs: 400, ...options.client });
  const client = {
    async request(route: DatalinkRoute, abort?: AbortSignal): Promise<HttpOutcome> {
      surfaces.push(`route ${route.key} ${'id' in route ? route.id : ''}`);
      const outcome = await real.request(route, abort);
      // A 2xx carries the parsed body, which is internal; a failure is what could be forwarded.
      const classified = classifySayIntentionsOutcome(outcome, token);
      if (!classified.ok) surfaces.push(`classified ${JSON.stringify(classified)}`);
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
  const send = async (op: Op, params: Record<string, unknown>) => {
    const id = `dl-${n++}`;
    // Anything the op writes to the real streams is a surface too.
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (out as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(String(chunk));
      return (err as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    let outcome;
    try {
      outcome = await service.handle({ v: 1, type: 'datalink-request', id, op, params } as DatalinkRequestMessage);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    for (const chunk of written) surfaces.push(`stream ${chunk}`);
    surfaces.push(`value ${JSON.stringify(outcome)}`);
    const line = outcome.ok
      ? encodeDatalinkResponse({ v: 1, type: 'datalink-response', at: Date.now(), id, ok: true, result: outcome.result })
      : encodeDatalinkResponse({ v: 1, type: 'datalink-response', at: Date.now(), id, ok: false, error: outcome.error });
    surfaces.push(line);
    return JSON.parse(line) as {
      ok: boolean;
      result?: Record<string, unknown>;
      error?: { code: string; httpStatus: number | null; serverCode: string | null };
    };
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
    expect(line).not.toContain(SERVER_TEXT);
    expect(line).not.toContain('si_1');
  }
  if (server) {
    for (const request of server.requests) {
      expect(request.path).not.toContain(token);
      expect(request.body).toBe('');
      expect(request.headers['x-ingest-token']).toBe(token);
    }
  }
}

describe('the ingest token never leaves the request header on the SayIntentions routes', () => {
  it.each(sampleNames())('%s', async (name) => {
    const s = sample(name);
    const token = s.configToken ?? SENTINEL_TOKEN;
    const listed = `${s.request.method} ${s.request.path}`;
    const server = await startScratchServer({ [listed]: echoing(name, token) });
    const { service, send } = await harness(server.baseUrl, server, token, {
      // Only the sample that must trip the cap gets a cap it can trip.
      client: s._bodyTooLarge ? { maxBodyBytes: 1024 } : {},
    });
    const answer = await send(s._op, paramsOf(s));
    expect(answer.ok).toBe(s.expect.ok);
    if (!answer.ok) {
      expect(answer.error?.code).toBe(s.expect.code);
      expect(answer.error?.serverCode).toBe(s.expect.serverCode ?? null);
    }
    if (name === 'status-200-link-upstream-id-contains-token') {
      expect((answer.result?.link as { upstreamFlightId: string }).upstreamFlightId).toBe('8841207-[REDACTED]');
    }
    if (name === 'pdc-201-sent-text-contains-token') {
      expect(answer.result?.sentText).toBe('PDC [REDACTED] KSFO KLAX');
    }
    if (name === 'settings-200-key-set-masked-token' || name === 'settings-200-key-set') {
      expect(answer.result).toEqual({
        answered: 'settings', flightId: null, apiKeySet: true, linked: null, link: null, httpStatus: 200,
      });
    }
    // A second press: one more request, unless the token latched and it is refused locally.
    await send(s._op, paramsOf(s));
    surfaces.push(encodeSidecarMessage(service.buildState()));
    for (const request of server.requests) {
      expect(`${request.method} ${request.path}`).toBe(listed);
    }
    expect(server.requests.length).toBe(s.expect.latch ? 1 : 2);
    expect(surfaces.some((line) => line.includes('"message":"SayIntentions '))).toBe(true);
    assertTokenAbsent(server, token);
  });

  it('a route the test did not list answers 599, so no unexpected request can pass unnoticed', async () => {
    const server = await startScratchServer({
      'GET /api/settings/sayintentions': echoing('settings-200-key-set', SENTINEL_TOKEN),
    });
    const { send } = await harness(server.baseUrl, server, SENTINEL_TOKEN);
    expect(await send('si-status', { flightId: null })).toMatchObject({ ok: true });
    // Every other op's route is unlisted: the scratch server answers 599 to it.
    for (const [op, params] of [
      ['si-status', { flightId: 42 }],
      ['si-link', { flightId: 42, from: 'now' }],
      ['si-link', { flightId: 42, from: 'session-start' }],
      ['si-unlink', { flightId: 42 }],
      ['si-import', { flightId: 42 }],
      ['si-pdc', { plannedLegId: 29 }],
    ] as [Op, Record<string, unknown>][]) {
      expect(await send(op, params)).toMatchObject({
        ok: false, error: { code: 'http-error', httpStatus: 599, serverCode: null },
      });
    }
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/settings/sayintentions',
      'GET /api/flights/42/sayintentions/link',
      'POST /api/flights/42/sayintentions/link?from=now',
      'POST /api/flights/42/sayintentions/link',
      'DELETE /api/flights/42/sayintentions/link',
      'POST /api/flights/42/sayintentions/import',
      'POST /api/planned-legs/29/sayintentions/clearance',
    ]);
    assertTokenAbsent(server, SENTINEL_TOKEN);
  });

  it('a code-shaped token echoed as the code is emitted as serverCode null on every status', async () => {
    const server = await startScratchServer({
      'GET /api/flights/42/sayintentions/link': echoing('401-code-shaped-token', CODE_TOKEN),
      'POST /api/flights/43/sayintentions/import': () => ({
        status: 404, body: { error: CODE_TOKEN, code: CODE_TOKEN },
      }),
      'POST /api/planned-legs/29/sayintentions/clearance': () => ({
        status: 409, headers: { 'x-ingest-token-scope': 'accepted' }, body: { code: CODE_TOKEN },
      }),
    });
    const { send } = await harness(server.baseUrl, server, CODE_TOKEN);
    expect(await send('si-status', { flightId: 42 })).toMatchObject({
      ok: false, error: { code: 'sayintentions-unavailable', httpStatus: 401, serverCode: null },
    });
    expect(await send('si-import', { flightId: 43 })).toMatchObject({
      ok: false, error: { code: 'http-error', httpStatus: 404, serverCode: null },
    });
    expect(await send('si-pdc', { plannedLegId: 29 })).toMatchObject({
      ok: false, error: { code: 'http-error', httpStatus: 409, serverCode: null },
    });
    assertTokenAbsent(server, CODE_TOKEN);
  });

  it('the locally refused rows send nothing: the guard, no config, and a latched token', async () => {
    let configured = true;
    const server = await startScratchServer({
      'POST /api/flights/42/sayintentions/import': () => 'hang',
      'GET /api/settings/sayintentions': echoing('settings-200-key-unset', SENTINEL_TOKEN),
      'POST /api/flights/42/sayintentions/link': echoing('401-invalid-token', SENTINEL_TOKEN),
    });
    const { send } = await harness(server.baseUrl, server, SENTINEL_TOKEN, { hasConfig: () => configured });

    // One import out: every other action is refused with nothing sent, and the read still gets through.
    const hung = send('si-import', { flightId: 42 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const inProgress = { ok: false, error: { code: 'sayintentions-in-progress', httpStatus: null, serverCode: null } };
    expect(await send('si-link', { flightId: 42, from: 'now' })).toMatchObject(inProgress);
    expect(await send('si-unlink', { flightId: 42 })).toMatchObject(inProgress);
    expect(await send('si-pdc', { plannedLegId: 29 })).toMatchObject(inProgress);
    expect(await send('si-import', { flightId: 42 })).toMatchObject(inProgress);
    // Checked before the config, so it answers the same with no config.
    configured = false;
    expect(await send('si-import', { flightId: 42 })).toMatchObject(inProgress);
    configured = true;
    expect(await send('si-status', { flightId: null })).toMatchObject({ ok: true });
    expect(await hung).toMatchObject({ ok: false, error: { code: 'timeout', httpStatus: null } });

    configured = false;
    for (const [op, params] of [
      ['si-status', { flightId: null }],
      ['si-link', { flightId: 42, from: 'session-start' }],
      ['si-unlink', { flightId: 42 }],
      ['si-import', { flightId: 42 }],
      ['si-pdc', { plannedLegId: 29 }],
    ] as [Op, Record<string, unknown>][]) {
      expect(await send(op, params)).toMatchObject({
        ok: false, error: { code: 'no-config', httpStatus: null, serverCode: null } });
    }
    configured = true;

    // A refused token latches, and then nothing is sent by any op either.
    const latched = { ok: false, error: { code: 'token-invalid', httpStatus: 401, serverCode: 'INVALID_INGEST_TOKEN' } };
    expect(await send('si-link', { flightId: 42, from: 'session-start' })).toMatchObject(latched);
    const made = server.requests.length;
    for (const [op, params] of [
      ['si-status', { flightId: null }],
      ['si-link', { flightId: 42, from: 'session-start' }],
      ['si-unlink', { flightId: 42 }],
      ['si-import', { flightId: 42 }],
      ['si-pdc', { plannedLegId: 29 }],
    ] as [Op, Record<string, unknown>][]) {
      expect(await send(op, params)).toMatchObject(latched);
    }
    expect(server.requests.length).toBe(made);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      '/api/flights/42/sayintentions/import',
      '/api/settings/sayintentions',
      '/api/flights/42/sayintentions/link',
    ].map((p, i) => `${['POST', 'GET', 'POST'][i]} ${p}`));
    assertTokenAbsent(server, SENTINEL_TOKEN);
  });
});
