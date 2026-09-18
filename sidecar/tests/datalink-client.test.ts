// tests/datalink-client.test.ts — tests src/datalink-client.ts against a
// scratch HTTP server on an ephemeral port with a sentinel token.
//
// The server records every request, so the properties asserted are the ones
// the server's token check depends on: exactly thirteen (method, path) pairs,
// the token in x-ingest-token and nowhere else, no Origin or Cookie, and bodies
// limited to a canned id or an ICAO.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRequest,
  DATALINK_HTTP_TIMEOUT_MS,
  DatalinkClient,
  httpTimeoutMs,
  routeTemplate,
  SAYINTENTIONS_HTTP_TIMEOUT_MS,
  SIMBRIEF_PREFILE_BODY_MAX_BYTES,
  SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS,
  type DatalinkRoute,
  type DatalinkRouteKey,
} from '../src/datalink-client';
import { classifyOutcome } from '../src/datalink-classify';
import { Uplink } from '../src/uplink';
import {
  clearanceFixture,
  clearanceReply,
  closedPort,
  fixture,
  reply,
  scratchConfig,
  SENTINEL_TOKEN,
  simbriefFixture,
  simbriefReply,
  startScratchServer,
  type ScratchServer,
} from './helpers/datalink-scratch-server';

const FROZEN_ROUTES = new Set([
  'GET /api/status',
  'GET /api/acars/canned-messages',
  'GET /api/flights/92/acars-messages',
  'POST /api/flights/92/acars-messages',
  'POST /api/flights/92/acars-messages/wx',
  'GET /api/planned-legs/12/acars-messages',
  'POST /api/planned-legs/12/acars-messages',
  'POST /api/planned-legs/12/acars-messages/wx',
  'POST /api/planned-legs/12/acars-messages/loadsheet',
  'GET /api/ground-sessions/current',
  'GET /api/settings/simbrief',
  'POST /api/planned-legs/simbrief',
  'POST /api/planned-legs/12/acars-messages/clearance',
]);

const ALL_ROUTES: DatalinkRoute[] = [
  { key: 'status' },
  { key: 'canned-list' },
  { key: 'flight-thread', id: 92 },
  { key: 'flight-send', id: 92, cannedId: 'canned-one' },
  { key: 'flight-wx', id: 92, icao: 'EGLL' },
  { key: 'leg-thread', id: 12 },
  { key: 'leg-send', id: 12, cannedId: 'canned-two' },
  { key: 'leg-wx', id: 12, icao: 'LFPG' },
  { key: 'leg-loadsheet', id: 12 },
  { key: 'ground-session-current' },
  { key: 'simbrief-settings' },
  { key: 'simbrief-prefile' },
];

// Not in ALL_ROUTES, because the prefile timeout test pins that list at twelve
// keys. The route-list test and the every-key timeout test add it.
const CLEARANCE_ROUTE: DatalinkRoute = { key: 'leg-clearance', id: 12 };

describe('DatalinkClient against a scratch server', () => {
  let server: ScratchServer;
  let uplink: Uplink;
  let client: DatalinkClient;

  beforeAll(async () => {
    server = await startScratchServer({
      'GET /api/status': reply('01a-get-status-flying'),
      'GET /api/acars/canned-messages': reply('02-get-canned-messages'),
      'GET /api/flights/92/acars-messages': reply('03-get-flight-thread'),
      'POST /api/flights/92/acars-messages': reply('04-post-flight-canned'),
      'POST /api/flights/92/acars-messages/wx': reply('05a-post-flight-wx-available'),
      'GET /api/planned-legs/12/acars-messages': reply('06-get-leg-thread'),
      'POST /api/planned-legs/12/acars-messages': reply('07-post-leg-canned'),
      'POST /api/planned-legs/12/acars-messages/wx': reply('08-post-leg-wx'),
      'POST /api/planned-legs/12/acars-messages/loadsheet': reply('09a-post-leg-loadsheet-created'),
      'GET /api/ground-sessions/current': reply('10a-get-ground-session-open'),
      'GET /api/settings/simbrief': simbriefReply('get-settings-configured'),
      'POST /api/planned-legs/simbrief': simbriefReply('post-201-imported'),
      'POST /api/planned-legs/12/acars-messages/clearance': clearanceReply('post-201-created'),
      'GET /redirected': () => ({ status: 200, body: { followed: true } }),
    });
    uplink = new Uplink(scratchConfig(server.baseUrl));
    client = new DatalinkClient(() => uplink);
  });

  afterAll(async () => {
    await uplink.close();
    await server.close();
  });

  it('exercises all thirteen routes; each request is one of the frozen thirteen, tokened, with no Origin or Cookie', async () => {
    const before = server.requests.length;
    for (const route of [...ALL_ROUTES, CLEARANCE_ROUTE]) {
      const outcome = await client.request(route);
      expect(outcome.kind).toBe('response');
      if (outcome.kind === 'response') expect(outcome.status).toBeLessThan(300);
    }
    const made = server.requests.slice(before);
    expect(made).toHaveLength(13);
    expect(new Set(made.map((r) => `${r.method} ${r.path}`))).toEqual(FROZEN_ROUTES);

    for (const request of made) {
      expect(FROZEN_ROUTES.has(`${request.method} ${request.path}`)).toBe(true);
      expect(['GET', 'POST']).toContain(request.method);
      expect(request.path.endsWith('/')).toBe(false);
      expect(request.path).not.toContain('?');
      expect(request.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
      expect(request.headers.origin).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.accept).toBe('application/json');
      expect(request.path).not.toContain(SENTINEL_TOKEN);
      expect(request.body).not.toContain(SENTINEL_TOKEN);
    }
  });

  it('sends only {"canned_id"}, {"icao"} or no body at all', async () => {
    const before = server.requests.length;
    for (const route of ALL_ROUTES) await client.request(route);
    const byRoute = new Map(server.requests.slice(before).map((r) => [`${r.method} ${r.path}`, r]));

    expect(byRoute.get('POST /api/flights/92/acars-messages')!.body).toBe('{"canned_id":"canned-one"}');
    expect(byRoute.get('POST /api/planned-legs/12/acars-messages')!.body).toBe('{"canned_id":"canned-two"}');
    expect(byRoute.get('POST /api/flights/92/acars-messages/wx')!.body).toBe('{"icao":"EGLL"}');
    expect(byRoute.get('POST /api/planned-legs/12/acars-messages/wx')!.body).toBe('{"icao":"LFPG"}');
    for (const key of ['POST /api/flights/92/acars-messages', 'POST /api/planned-legs/12/acars-messages/wx']) {
      expect(byRoute.get(key)!.headers['content-type']).toBe('application/json');
    }

    const loadsheet = byRoute.get('POST /api/planned-legs/12/acars-messages/loadsheet')!;
    expect(loadsheet.body).toBe('');
    expect(loadsheet.headers['content-type']).toBeUndefined();
    expect(loadsheet.headers['content-length']).toBe('0');

    for (const [key, request] of byRoute) {
      if (key.startsWith('GET ')) {
        expect(request.body).toBe('');
        expect(request.headers['content-type']).toBeUndefined();
      }
    }
  });

  it('cannot build a path from an out-of-contract parameter, and sends nothing for one', async () => {
    const bad: DatalinkRoute[] = [
      { key: 'flight-thread', id: 0 },
      { key: 'leg-thread', id: 1.5 },
      { key: 'flight-send', id: 92, cannedId: 'free text here' },
      { key: 'leg-send', id: 12, cannedId: '../status' },
      { key: 'flight-wx', id: 92, icao: 'egll' },
      { key: 'leg-loadsheet', id: Number.MAX_SAFE_INTEGER + 1 },
    ];
    const before = server.requests.length;
    for (const route of bad) {
      expect(buildRequest(route)).toBeNull();
      expect(await client.request(route)).toMatchObject({ kind: 'transport' });
    }
    expect(server.requests.length).toBe(before);
  });

  it('does not follow a redirect: a 302 comes back as a 302 and the target is never contacted', async () => {
    server.routes['GET /api/status'] = () => ({ status: 302, headers: { location: '/redirected' } });
    try {
      const before = server.requests.length;
      const outcome = await client.request({ key: 'status' });
      expect(outcome).toMatchObject({ kind: 'response', status: 302 });
      expect(classifyOutcome(outcome, 'poll', SENTINEL_TOKEN)).toMatchObject({ ok: false, code: 'http-error', httpStatus: 302 });
      expect(server.requests.slice(before).map((r) => r.path)).toEqual(['/api/status']);
    } finally {
      server.routes['GET /api/status'] = reply('01a-get-status-flying');
    }
  });

  it('reads the scope header case-insensitively', async () => {
    server.routes['GET /api/acars/canned-messages'] = reply('err-401-scope-accepted-no-token');
    try {
      const outcome = await client.request({ key: 'canned-list' });
      expect(outcome).toMatchObject({ kind: 'response', status: 401, scopeHeader: 'accepted' });
    } finally {
      server.routes['GET /api/acars/canned-messages'] = reply('02-get-canned-messages');
    }
  });

  it('times out a request that never answers, as a timeout rather than unreachable', async () => {
    server.routes['GET /api/ground-sessions/current'] = () => 'hang';
    try {
      const quick = new DatalinkClient(() => uplink, { timeoutMs: 150 });
      const outcome = await quick.request({ key: 'ground-session-current' });
      expect(outcome).toMatchObject({ kind: 'transport', errorName: 'TimeoutError' });
      expect(classifyOutcome(outcome, 'poll', SENTINEL_TOKEN)).toMatchObject({ ok: false, code: 'timeout' });
    } finally {
      server.routes['GET /api/ground-sessions/current'] = reply('10a-get-ground-session-open');
    }
  });

  it('defaults to an 8 s timeout', async () => {
    const { DATALINK_HTTP_TIMEOUT_MS } = await import('../src/datalink-client');
    expect(DATALINK_HTTP_TIMEOUT_MS).toBe(8000);
  });

  it('stops reading a body past the cap and reports it as too large', async () => {
    const big = JSON.stringify({ messages: [], pad: 'x'.repeat(1024 * 1024 + 16) });
    server.routes['GET /api/acars/canned-messages'] = () => ({ status: 200, body: big });
    try {
      const outcome = await client.request({ key: 'canned-list' });
      expect(outcome).toMatchObject({ kind: 'response', status: 200, bodyTooLarge: true, bodyText: null });
      expect(classifyOutcome(outcome, 'op', SENTINEL_TOKEN)).toMatchObject({ ok: false, code: 'bad-response' });
      // The thread routes have a larger cap, so the same body is fine there.
      server.routes['GET /api/planned-legs/12/acars-messages'] = () => ({ status: 200, body: big });
      const thread = await client.request({ key: 'leg-thread', id: 12 });
      expect(thread).toMatchObject({ kind: 'response', bodyTooLarge: false });
    } finally {
      server.routes['GET /api/acars/canned-messages'] = reply('02-get-canned-messages');
      server.routes['GET /api/planned-legs/12/acars-messages'] = reply('06-get-leg-thread');
    }
  });

  it('reports a refused connection as unreachable and never throws', async () => {
    const port = await closedPort();
    const offline = new Uplink(scratchConfig(`http://127.0.0.1:${port}`));
    const offlineClient = new DatalinkClient(() => offline);
    const outcome = await offlineClient.request({ key: 'status' });
    expect(outcome).toMatchObject({ kind: 'transport', errorCode: 'ECONNREFUSED' });
    expect(classifyOutcome(outcome, 'poll', SENTINEL_TOKEN)).toMatchObject({ ok: false, code: 'unreachable' });
    expect(JSON.stringify(outcome)).not.toContain(SENTINEL_TOKEN);
    await offline.close();
  });

  it('sends the SimBrief settings GET and the prefile POST exactly, the POST with no body at all', async () => {
    const before = server.requests.length;
    await client.request({ key: 'simbrief-settings' });
    await client.request({ key: 'simbrief-prefile' });
    const made = server.requests.slice(before);
    expect(made.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/settings/simbrief',
      'POST /api/planned-legs/simbrief',
    ]);
    for (const request of made) {
      expect(request.body).toBe('');
      expect(request.headers['content-type']).toBeUndefined();
      expect(request.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
      expect(request.headers.origin).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.accept).toBe('application/json');
    }
    expect(made[1].headers['content-length']).toBe('0');
    expect(buildRequest({ key: 'simbrief-prefile' })).toEqual({
      method: 'POST',
      path: '/api/planned-legs/simbrief',
      template: '/api/planned-legs/simbrief',
      body: null,
      maxBodyBytes: SIMBRIEF_PREFILE_BODY_MAX_BYTES,
    });
    expect(buildRequest({ key: 'simbrief-settings' })).toMatchObject({ body: null, maxBodyBytes: 1024 * 1024 });
    for (const request of made) expect(JSON.stringify(request.headers)).not.toContain('allow');
  });

  it('uses the prefile timeout for the prefile POST only, and 8 s for every other route', () => {
    expect(DATALINK_HTTP_TIMEOUT_MS).toBe(8000);
    expect(SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS).toBe(25000);
    expect(SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS).toBeGreaterThan(20000);
    const keys = ALL_ROUTES.map((route) => route.key);
    expect(new Set(keys).size).toBe(12);
    for (const key of keys) {
      const expected = key === 'simbrief-prefile' ? 25000 : 8000;
      expect(httpTimeoutMs(key, {}), key).toBe(expected);
    }
    for (const key of keys) {
      const scaled = httpTimeoutMs(key as DatalinkRouteKey, { timeoutMs: 100, prefileTimeoutMs: 400 });
      expect(scaled, key).toBe(key === 'simbrief-prefile' ? 400 : 100);
    }
    expect(httpTimeoutMs('simbrief-prefile', { timeoutMs: 100 })).toBe(25000);
    expect(httpTimeoutMs('simbrief-settings', { prefileTimeoutMs: 400 })).toBe(8000);
  });

  it('a prefile answering after the default timeout still succeeds; a thread GET with the same delay times out', async () => {
    const late = (response: { status: number; headers: Record<string, string>; body: unknown }) => () => ({
      ...response,
      delayMs: 200,
    });
    server.routes['POST /api/planned-legs/simbrief'] = late(simbriefFixture('post-201-imported').response);
    server.routes['GET /api/planned-legs/12/acars-messages'] = late(fixture('06-get-leg-thread').response);
    try {
      const scaled = new DatalinkClient(() => uplink, { timeoutMs: 100, prefileTimeoutMs: 400 });
      const [prefile, thread] = await Promise.all([
        scaled.request({ key: 'simbrief-prefile' }),
        scaled.request({ key: 'leg-thread', id: 12 }),
      ]);
      expect(prefile).toMatchObject({ kind: 'response', status: 201, bodyTooLarge: false });
      expect(thread).toMatchObject({ kind: 'transport', errorName: 'TimeoutError' });
      expect(classifyOutcome(thread, 'poll', SENTINEL_TOKEN)).toMatchObject({ ok: false, code: 'timeout' });
    } finally {
      server.routes['POST /api/planned-legs/simbrief'] = simbriefReply('post-201-imported');
      server.routes['GET /api/planned-legs/12/acars-messages'] = reply('06-get-leg-thread');
    }
  });

  it('one clearance op sends exactly one POST with no body, the sentinel token, and no Origin or Cookie', async () => {
    const before = server.requests.length;
    const outcome = await client.request(CLEARANCE_ROUTE);
    expect(outcome).toMatchObject({ kind: 'response', status: 201, bodyTooLarge: false });
    const made = server.requests.slice(before);
    expect(made.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/planned-legs/12/acars-messages/clearance']);
    const [request] = made;
    expect(request.body).toBe('');
    expect(request.headers['content-length']).toBe('0');
    expect(request.headers['content-type']).toBeUndefined();
    expect(request.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
    expect(request.headers.origin).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.accept).toBe('application/json');
    expect(request.path).not.toContain(SENTINEL_TOKEN);
    expect(buildRequest(CLEARANCE_ROUTE)).toEqual({
      method: 'POST',
      path: '/api/planned-legs/12/acars-messages/clearance',
      template: '/api/planned-legs/:id/acars-messages/clearance',
      body: null,
      maxBodyBytes: 1024 * 1024,
    });
  });

  it('builds no clearance request, and sends nothing, for an id outside the param rule', async () => {
    const before = server.requests.length;
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '12' as unknown as number]) {
      const route: DatalinkRoute = { key: 'leg-clearance', id };
      expect(buildRequest(route)).toBeNull();
      expect(await client.request(route)).toEqual({ kind: 'transport', errorName: 'InvalidRoute', errorCode: null });
    }
    expect(server.requests.length).toBe(before);
    expect(buildRequest({ key: 'leg-clearance', id: Number.MAX_SAFE_INTEGER })?.path).toBe(
      `/api/planned-legs/${Number.MAX_SAFE_INTEGER}/acars-messages/clearance`,
    );
  });

  it('every route key has its effective timeout: the prefile 25 s, the clearance and every other route 8 s', () => {
    const keys = [...ALL_ROUTES, CLEARANCE_ROUTE].map((route) => route.key);
    expect(new Set(keys).size).toBe(13);
    for (const key of keys) {
      const expected = key === 'simbrief-prefile' ? SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS : DATALINK_HTTP_TIMEOUT_MS;
      expect(httpTimeoutMs(key, {}), key).toBe(expected);
      expect(httpTimeoutMs(key, { timeoutMs: 100, prefileTimeoutMs: 400 }), key).toBe(key === 'simbrief-prefile' ? 400 : 100);
    }
    expect(httpTimeoutMs('leg-clearance', {})).toBe(8000);
    expect(httpTimeoutMs('leg-clearance', { prefileTimeoutMs: 400 })).toBe(8000);
  });

  it('a clearance answering after the scaled default timeout times out; the prefile with the same delay does not', async () => {
    server.routes['POST /api/planned-legs/12/acars-messages/clearance'] = () => ({
      ...clearanceFixture('post-201-created').response,
      delayMs: 200,
    });
    server.routes['POST /api/planned-legs/simbrief'] = () => ({ ...simbriefFixture('post-201-imported').response, delayMs: 200 });
    try {
      const before = server.requests.length;
      const scaled = new DatalinkClient(() => uplink, { timeoutMs: 100, prefileTimeoutMs: 400 });
      const [clearance, prefile] = await Promise.all([
        scaled.request(CLEARANCE_ROUTE),
        scaled.request({ key: 'simbrief-prefile' }),
      ]);
      expect(clearance).toEqual({ kind: 'transport', errorName: 'TimeoutError', errorCode: null });
      expect(prefile).toMatchObject({ kind: 'response', status: 201 });
      expect(server.requests.slice(before).filter((r) => r.path.endsWith('/clearance'))).toHaveLength(1);
    } finally {
      server.routes['POST /api/planned-legs/12/acars-messages/clearance'] = clearanceReply('post-201-created');
      server.routes['POST /api/planned-legs/simbrief'] = simbriefReply('post-201-imported');
    }
  });

  // ── SayIntentions ───────────────────────────────────────────────────────────

  const SAYINTENTIONS_ROUTES: DatalinkRoute[] = [
    { key: 'si-settings' },
    { key: 'si-link-status', id: 42 },
    { key: 'si-link', id: 42 },
    { key: 'si-link-now', id: 42 },
    { key: 'si-unlink', id: 42 },
    { key: 'si-import', id: 42 },
    { key: 'si-pdc', id: 29 },
  ];

  const SAYINTENTIONS_FROZEN: [DatalinkRouteKey, string][] = [
    ['si-settings', 'GET /api/settings/sayintentions'],
    ['si-link-status', 'GET /api/flights/42/sayintentions/link'],
    ['si-link', 'POST /api/flights/42/sayintentions/link'],
    ['si-link-now', 'POST /api/flights/42/sayintentions/link?from=now'],
    ['si-unlink', 'DELETE /api/flights/42/sayintentions/link'],
    ['si-import', 'POST /api/flights/42/sayintentions/import'],
    ['si-pdc', 'POST /api/planned-legs/29/sayintentions/clearance'],
  ];

  function serveSayIntentions(): void {
    for (const [, line] of SAYINTENTIONS_FROZEN) {
      server.routes[line] = () => ({ status: 200, body: { ok: true } });
    }
  }

  it('sends the seven SayIntentions routes exactly, all with no body, the token and no Origin or Cookie', async () => {
    serveSayIntentions();
    const before = server.requests.length;
    for (const route of SAYINTENTIONS_ROUTES) {
      const outcome = await client.request(route);
      expect(outcome, route.key).toMatchObject({ kind: 'response', status: 200 });
    }
    const made = server.requests.slice(before);
    expect(made.map((r) => `${r.method} ${r.path}`)).toEqual(SAYINTENTIONS_FROZEN.map(([, line]) => line));
    for (const request of made) {
      expect(['GET', 'POST', 'DELETE']).toContain(request.method);
      // No body on any of the seven, so no content-type is sent either.
      expect(request.body).toBe('');
      expect(request.headers['content-type']).toBeUndefined();
      expect(request.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
      expect(request.headers.origin).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.accept).toBe('application/json');
      expect(request.path).not.toContain(SENTINEL_TOKEN);
      expect(request.path.endsWith('/')).toBe(false);
    }
    // The one query string in the table belongs to a literal template.
    expect(made.filter((r) => r.path.includes('?')).map((r) => r.path)).toEqual([
      '/api/flights/42/sayintentions/link?from=now',
    ]);
    expect(buildRequest({ key: 'si-link-now', id: 42 })).toEqual({
      method: 'POST',
      path: '/api/flights/42/sayintentions/link?from=now',
      template: '/api/flights/:id/sayintentions/link?from=now',
      body: null,
      maxBodyBytes: 1024 * 1024,
    });
    expect(buildRequest({ key: 'si-unlink', id: 42 })).toMatchObject({ method: 'DELETE', body: null });
    for (const route of SAYINTENTIONS_ROUTES) {
      expect(buildRequest(route)!.body, route.key).toBeNull();
      expect(buildRequest(route)!.maxBodyBytes, route.key).toBe(1024 * 1024);
    }
  });

  it('the route table is closed at twenty keys, and every key has its template', () => {
    // A missing key here is a compile error, so the count is checked by the type too.
    const templates: Record<DatalinkRouteKey, string> = {
      status: 'GET /api/status',
      'canned-list': 'GET /api/acars/canned-messages',
      'ground-session-current': 'GET /api/ground-sessions/current',
      'flight-thread': 'GET /api/flights/:id/acars-messages',
      'leg-thread': 'GET /api/planned-legs/:id/acars-messages',
      'flight-send': 'POST /api/flights/:id/acars-messages',
      'leg-send': 'POST /api/planned-legs/:id/acars-messages',
      'flight-wx': 'POST /api/flights/:id/acars-messages/wx',
      'leg-wx': 'POST /api/planned-legs/:id/acars-messages/wx',
      'leg-loadsheet': 'POST /api/planned-legs/:id/acars-messages/loadsheet',
      'leg-clearance': 'POST /api/planned-legs/:id/acars-messages/clearance',
      'simbrief-settings': 'GET /api/settings/simbrief',
      'simbrief-prefile': 'POST /api/planned-legs/simbrief',
      'si-settings': 'GET /api/settings/sayintentions',
      'si-link-status': 'GET /api/flights/:id/sayintentions/link',
      'si-link': 'POST /api/flights/:id/sayintentions/link',
      'si-link-now': 'POST /api/flights/:id/sayintentions/link?from=now',
      'si-unlink': 'DELETE /api/flights/:id/sayintentions/link',
      'si-import': 'POST /api/flights/:id/sayintentions/import',
      'si-pdc': 'POST /api/planned-legs/:id/sayintentions/clearance',
    };
    expect(Object.keys(templates)).toHaveLength(20);
    for (const [key, line] of Object.entries(templates)) {
      expect(routeTemplate(key as DatalinkRouteKey), key).toBe(line);
    }
  });

  it('builds no SayIntentions request, and sends nothing, for an id outside the param rule', async () => {
    const before = server.requests.length;
    const keys: DatalinkRouteKey[] = ['si-link-status', 'si-link', 'si-link-now', 'si-unlink', 'si-import', 'si-pdc'];
    for (const key of keys) {
      for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '42' as unknown as number]) {
        const route = { key, id } as DatalinkRoute;
        expect(buildRequest(route), `${key} ${id}`).toBeNull();
        expect(await client.request(route)).toEqual({ kind: 'transport', errorName: 'InvalidRoute', errorCode: null });
      }
    }
    expect(server.requests.length).toBe(before);
  });

  it('uses the 20 s SayIntentions timeout for the three upstream routes and the unlink default for the rest', () => {
    expect(SAYINTENTIONS_HTTP_TIMEOUT_MS).toBe(20000);
    expect(SAYINTENTIONS_HTTP_TIMEOUT_MS).toBeGreaterThan(DATALINK_HTTP_TIMEOUT_MS);
    const upstream = new Set<DatalinkRouteKey>(['si-link', 'si-link-now', 'si-import', 'si-pdc']);
    for (const [key] of SAYINTENTIONS_FROZEN) {
      const expected = upstream.has(key) ? SAYINTENTIONS_HTTP_TIMEOUT_MS : DATALINK_HTTP_TIMEOUT_MS;
      expect(httpTimeoutMs(key, {}), key).toBe(expected);
      expect(httpTimeoutMs(key, { timeoutMs: 100, prefileTimeoutMs: 400, sayintentionsTimeoutMs: 700 }), key).toBe(
        upstream.has(key) ? 700 : 100,
      );
      // Neither of the other two overrides reaches these routes.
      expect(httpTimeoutMs(key, { prefileTimeoutMs: 400 }), key).toBe(expected);
    }
    // And the SayIntentions override reaches nothing else.
    for (const key of ['status', 'leg-clearance', 'simbrief-prefile'] as DatalinkRouteKey[]) {
      expect(httpTimeoutMs(key, { sayintentionsTimeoutMs: 700 }), key).toBe(
        key === 'simbrief-prefile' ? SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS : DATALINK_HTTP_TIMEOUT_MS,
      );
    }
  });

  it('an import answering after the scaled default still succeeds; the unlink with the same delay times out', async () => {
    serveSayIntentions();
    server.routes['POST /api/flights/42/sayintentions/import'] = () => ({ status: 201, body: { ok: true }, delayMs: 200 });
    server.routes['DELETE /api/flights/42/sayintentions/link'] = () => ({ status: 200, body: { ok: true }, delayMs: 200 });
    const scaled = new DatalinkClient(() => uplink, { timeoutMs: 100, sayintentionsTimeoutMs: 400 });
    const [imported, unlinked] = await Promise.all([
      scaled.request({ key: 'si-import', id: 42 }),
      scaled.request({ key: 'si-unlink', id: 42 }),
    ]);
    expect(imported).toMatchObject({ kind: 'response', status: 201, bodyTooLarge: false });
    expect(unlinked).toEqual({ kind: 'transport', errorName: 'TimeoutError', errorCode: null });
  });

  it('stops reading a SayIntentions body past the 1 MiB cap', async () => {
    serveSayIntentions();
    const big = JSON.stringify({ flight_id: 42, imported: 1, pad: 'x'.repeat(1024 * 1024 + 16) });
    server.routes['POST /api/flights/42/sayintentions/import'] = () => ({ status: 201, body: big });
    const outcome = await client.request({ key: 'si-import', id: 42 });
    expect(outcome).toMatchObject({ kind: 'response', status: 201, bodyTooLarge: true, bodyText: null });
  });

  it('reports an abort by its owner as a timeout', async () => {
    server.routes['GET /api/status'] = () => 'hang';
    try {
      const controller = new AbortController();
      const pending = client.request({ key: 'status' }, controller.signal);
      setTimeout(() => controller.abort(), 50);
      expect(await pending).toEqual({ kind: 'transport', errorName: 'TimeoutError', errorCode: null });
    } finally {
      server.routes['GET /api/status'] = reply('01a-get-status-flying');
    }
  });
});
