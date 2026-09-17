// tests/clearance-model.test.ts — tests src/clearance-model.ts.
//
// Every clearance server sample is served by a scratch server on an ephemeral
// port and goes through the real client, the clearance classifier and the
// projection, and must come out exactly as the sample's `expect` says. The
// transport rows (refused, reset, client timeout, TLS), the body cap, the
// projection's field rules and the response line bound are covered beside them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyClearanceOutcome,
  CLEARANCE_ALTITUDE_MAX_FT,
  CLEARANCE_ICAO_MAX_UNITS,
  CLEARANCE_ROUTE_MAX_UNITS,
  projectClearance,
} from '../src/clearance-model';
import type { HttpOutcome } from '../src/datalink-classify';
import { DatalinkClient, type DatalinkRoute } from '../src/datalink-client';
import { fillWindow, projectThread } from '../src/datalink-model';
import { encodeDatalinkResponse, MAX_LINE_BYTES } from '../src/protocol';
import { Uplink } from '../src/uplink';
import {
  CLEARANCE_CODE_TOKEN,
  CLEARANCE_SENTINEL_TOKEN,
  CLEARANCE_SERVER_TEXT,
  clearanceFixture,
  clearanceFixtureNames,
  clearanceLocalOutcomes,
  closedPort,
  scratchConfig,
  startScratchServer,
  type ScratchServer,
} from './helpers/datalink-scratch-server';

const ROUTE: DatalinkRoute = { key: 'leg-clearance', id: 12 };
const LOCAL = clearanceLocalOutcomes();

/** Classifier, then projection: the value the service answers with. */
function answer(outcome: HttpOutcome, token: string | null, legId = 12) {
  const classified = classifyClearanceOutcome(outcome, token);
  if (!classified.ok) {
    return {
      ok: false,
      code: classified.code,
      httpStatus: classified.httpStatus,
      serverCode: classified.serverCode,
      latch: classified.retry === 'latch',
      availability: classified.availability,
    };
  }
  const projected = projectClearance(classified.json, classified.httpStatus, legId, token);
  if (!projected.ok) {
    return { ok: false, code: 'bad-response', httpStatus: classified.httpStatus, serverCode: null, latch: false, availability: null };
  }
  return { ok: true, result: projected.result };
}

/** The sidecar-produced members of a local row; the CDU text is the webview's to check. */
function localExpect(name: string) {
  const e = LOCAL[name].expect;
  return { ok: e.ok, code: e.code, httpStatus: e.httpStatus, serverCode: e.serverCode, latch: e.latch === true };
}

describe('every clearance server sample through the client, classifier and projection', () => {
  const names = clearanceFixtureNames();

  it('has all 38 samples', () => {
    expect(names).toHaveLength(38);
  });

  it.each(names)('%s', async (name) => {
    const sample = clearanceFixture(name);
    const token = sample.configToken ?? CLEARANCE_SENTINEL_TOKEN;
    const server = await startScratchServer({
      [`${sample.request.method} ${sample.request.path}`]: () => ({
        status: sample.response.status,
        headers: sample.response.headers,
        body: sample.response.body,
      }),
    });
    const uplink = new Uplink(scratchConfig(server.baseUrl, { ingestToken: token }));
    try {
      const outcome = await new DatalinkClient(() => uplink).request(ROUTE);
      const got = answer(outcome, token);

      if (sample.expect.ok) {
        expect(got).toEqual({ ok: true, result: sample.expect.result });
      } else {
        expect(got).toMatchObject({
          ok: false,
          code: sample.expect.code,
          httpStatus: sample.expect.httpStatus,
          serverCode: sample.expect.serverCode,
          latch: sample.expect.latch,
        });
        // Only a refused token moves the datalink availability axis.
        expect(got.availability).toBe(sample.expect.code === 'token-invalid' ? 'dl.token-invalid' : null);
      }

      expect(server.requests).toHaveLength(1);
      const [request] = server.requests;
      expect(`${request.method} ${request.path}`).toBe(`${sample.request.method} ${sample.request.path}`);
      expect(request.headers['x-ingest-token']).toBe(token);
      expect(request.headers['content-length']).toBe('0');
      expect(request.headers['content-type']).toBeUndefined();
      expect(request.body).toBe('');
      const text = JSON.stringify(got);
      expect(text).not.toContain(token);
      expect(text).not.toContain(CLEARANCE_SERVER_TEXT);
      // The messages themselves never cross: no body, label or payload text.
      expect(text).not.toContain('SIMULATED CLEARANCE');
      expect(text).not.toContain('REQUEST CLEARANCE');
      expect(text).not.toContain('payload');
    } finally {
      await uplink.close();
      await server.close();
    }
  });

  it('a 401 with no scope header is clearance-unavailable, never token-invalid, and never latches', () => {
    for (const name of ['post-401-no-scope-header', 'post-401-code-shaped-token']) {
      const sample = clearanceFixture(name);
      const outcome: HttpOutcome = {
        kind: 'response',
        status: 401,
        scopeHeader: null,
        bodyText: JSON.stringify(sample.response.body),
        bodyTooLarge: false,
      };
      const classified = classifyClearanceOutcome(outcome, sample.configToken ?? CLEARANCE_SENTINEL_TOKEN);
      expect(classified).toEqual({
        ok: false, code: 'clearance-unavailable', availability: null, httpStatus: 401, serverCode: null, retry: 'none',
      });
    }
  });

  it('INVALID_INGEST_TOKEN is token-invalid with or without the scope header, and is checked before it', () => {
    const body = JSON.stringify({ error: 'x', code: 'INVALID_INGEST_TOKEN' });
    for (const scopeHeader of [null, 'accepted', ' Accepted ']) {
      expect(
        classifyClearanceOutcome({ kind: 'response', status: 401, scopeHeader, bodyText: body, bodyTooLarge: false }, CLEARANCE_SENTINEL_TOKEN),
      ).toEqual({
        ok: false, code: 'token-invalid', availability: 'dl.token-invalid', httpStatus: 401,
        serverCode: 'INVALID_INGEST_TOKEN', retry: 'latch',
      });
    }
    expect(
      classifyClearanceOutcome({ kind: 'response', status: 401, scopeHeader: ' ACCEPTED ', bodyText: '{}', bodyTooLarge: false }, null),
    ).toMatchObject({ code: 'token-missing', availability: null, retry: 'none' });
  });

  it('a code-shaped token as the code is classified raw and emitted as null, on any status', () => {
    const body = JSON.stringify({ error: CLEARANCE_SERVER_TEXT, code: CLEARANCE_CODE_TOKEN });
    for (const status of [401, 403, 404, 409, 500]) {
      const classified = classifyClearanceOutcome(
        { kind: 'response', status, scopeHeader: null, bodyText: body, bodyTooLarge: false },
        CLEARANCE_CODE_TOKEN,
      );
      expect(classified).toMatchObject({ ok: false, serverCode: null, availability: null, retry: 'none' });
      expect(JSON.stringify(classified)).not.toContain(CLEARANCE_CODE_TOKEN);
    }
  });

  it('known codes count only on their documented status; other statuses and 3xx are http-error', () => {
    const at = (status: number, code?: string) =>
      classifyClearanceOutcome(
        { kind: 'response', status, scopeHeader: 'accepted', bodyText: JSON.stringify({ code }), bodyTooLarge: false },
        null,
      );
    expect(at(404, 'PLANNED_LEG_NOT_FOUND')).toMatchObject({ code: 'leg-not-found', httpStatus: 404 });
    expect(at(409, 'NO_FLIGHT_PLAN')).toMatchObject({ code: 'clearance-no-flight-plan', httpStatus: 409 });
    expect(at(404, 'NO_FLIGHT_PLAN')).toMatchObject({ code: 'http-error', serverCode: 'NO_FLIGHT_PLAN' });
    expect(at(409, 'PLANNED_LEG_NOT_FOUND')).toMatchObject({ code: 'http-error' });
    expect(at(409, 'NO_DISPATCH_DATA')).toMatchObject({ code: 'http-error' });
    expect(at(404)).toMatchObject({ code: 'http-error', serverCode: null });
    expect(at(502)).toMatchObject({ code: 'http-error' });
    expect(at(504)).toMatchObject({ code: 'http-error' });
    expect(at(301)).toMatchObject({ code: 'http-error' });
  });
});

describe('local outcomes', () => {
  it('pure: TimeoutError is timeout, a TLS code is tls-error, anything else is unreachable', () => {
    const none = { availability: null, httpStatus: null, serverCode: null, retry: 'none' };
    expect(classifyClearanceOutcome({ kind: 'transport', errorName: 'TimeoutError', errorCode: '23' }, null)).toEqual({
      ok: false, code: 'timeout', ...none,
    });
    expect(
      answer({ kind: 'transport', errorName: 'TypeError', errorCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, null),
    ).toMatchObject(localExpect('transport-tls'));
    expect(classifyClearanceOutcome({ kind: 'transport', errorName: 'TypeError', errorCode: 'ECONNRESET' }, null)).toEqual({
      ok: false, code: 'unreachable', ...none,
    });
  });

  it('body-too-large: a body over the cap is bad-response with its status', () => {
    const outcome: HttpOutcome = { kind: 'response', status: 201, scopeHeader: null, bodyText: null, bodyTooLarge: true };
    expect(answer(outcome, null)).toMatchObject(localExpect('body-too-large'));
  });

  describe('against real sockets', () => {
    let server: ScratchServer;
    let uplink: Uplink;

    beforeAll(async () => {
      server = await startScratchServer({
        'POST /api/planned-legs/12/acars-messages/clearance': () => ({ destroy: true }),
        'POST /api/planned-legs/13/acars-messages/clearance': () => 'hang',
        'POST /api/planned-legs/14/acars-messages/clearance': () => ({
          status: 201,
          body: { planned_leg_id: 14, pad: 'x'.repeat(4096) },
        }),
      });
      uplink = new Uplink(scratchConfig(server.baseUrl, { ingestToken: CLEARANCE_SENTINEL_TOKEN }));
    });

    afterAll(async () => {
      await uplink.close();
      await server.close();
    });

    it('transport-unreachable: a refused connection', async () => {
      const port = await closedPort();
      const offline = new Uplink(scratchConfig(`http://127.0.0.1:${port}`, { ingestToken: CLEARANCE_SENTINEL_TOKEN }));
      try {
        const refused = await new DatalinkClient(() => offline).request(ROUTE);
        expect(answer(refused, CLEARANCE_SENTINEL_TOKEN)).toMatchObject(localExpect('transport-unreachable'));
      } finally {
        await offline.close();
      }
    });

    it('transport-reset: the server drops the connection after reading the request', async () => {
      const reset = await new DatalinkClient(() => uplink).request(ROUTE);
      expect(reset.kind).toBe('transport');
      expect(answer(reset, CLEARANCE_SENTINEL_TOKEN)).toMatchObject(localExpect('transport-reset'));
    });

    it('transport-client-timeout: no answer within the client timeout', async () => {
      const outcome = await new DatalinkClient(() => uplink, { timeoutMs: 150 }).request({ key: 'leg-clearance', id: 13 });
      expect(answer(outcome, CLEARANCE_SENTINEL_TOKEN, 13)).toMatchObject(localExpect('transport-client-timeout'));
    });

    it('body-too-large: the real client stops reading at the cap', async () => {
      const outcome = await new DatalinkClient(() => uplink, { maxBodyBytes: 1024 }).request({ key: 'leg-clearance', id: 14 });
      expect(outcome).toMatchObject({ kind: 'response', status: 201, bodyTooLarge: true, bodyText: null });
      expect(answer(outcome, CLEARANCE_SENTINEL_TOKEN, 14)).toMatchObject(localExpect('body-too-large'));
    });
  });
});

describe('projection', () => {
  const good = () => JSON.parse(JSON.stringify(clearanceFixture('post-201-created').response.body)) as Record<string, any>;
  const project = (body: unknown, token: string | null = null, legId = 12) => projectClearance(body, 201, legId, token);

  it('follows every field rule, in order', () => {
    expect(project(good())).toMatchObject({ ok: true, result: { plannedLegId: 12, squawk: '4521' } });
    const failing: [string, (b: Record<string, any>) => unknown][] = [
      ['not an object', () => []],
      ['null', () => null],
      ['leg id mismatch', (b) => { b.planned_leg_id = 13; return b; }],
      ['leg id a string', (b) => { b.planned_leg_id = '12'; return b; }],
      ['created a string', (b) => { b.created = 'true'; return b; }],
      ['created 1', (b) => { b.created = 1; return b; }],
      ['created missing', (b) => { delete b.created; return b; }],
      ['request missing', (b) => { delete b.request; return b; }],
      ['request id not an integer', (b) => { b.request.id = 501.5; return b; }],
      ['reply missing', (b) => { delete b.reply; return b; }],
      ['correlation mismatch', (b) => { b.reply.correlation_id = 500; return b; }],
      ['clearance missing', (b) => { delete b.clearance; return b; }],
      ['clearance v 2', (b) => { b.clearance.v = 2; return b; }],
      ['squawk 7800', (b) => { b.clearance.squawk = '7800'; return b; }],
      ['squawk a number', (b) => { b.clearance.squawk = 4521; return b; }],
      ['squawk five digits', (b) => { b.clearance.squawk = '04521'; return b; }],
      ['altitude 4500.5', (b) => { b.clearance.initial_altitude_ft = 4500.5; return b; }],
      ['altitude -100', (b) => { b.clearance.initial_altitude_ft = -100; return b; }],
      ['altitude a string', (b) => { b.clearance.initial_altitude_ft = '5000'; return b; }],
      ['altitude 100000', (b) => { b.clearance.initial_altitude_ft = CLEARANCE_ALTITUDE_MAX_FT + 1; return b; }],
      ['departure a number', (b) => { b.clearance.departure_icao = 1234; return b; }],
      ['destination nine units', (b) => { b.clearance.destination_icao = 'A'.repeat(CLEARANCE_ICAO_MAX_UNITS + 1); return b; }],
      ['departure with punctuation', (b) => { b.clearance.departure_icao = 'KJ-K'; return b; }],
      ['route an array', (b) => { b.clearance.route = ['GREKI']; return b; }],
      ['route over the cap', (b) => { b.clearance.route = 'A'.repeat(CLEARANCE_ROUTE_MAX_UNITS + 1); return b; }],
    ];
    for (const [name, mutate] of failing) {
      expect(project(mutate(good())).ok, name).toBe(false);
    }
  });

  it('trims and upper-cases airports, reads blank as null, and leaves the route as sent', () => {
    const body = good();
    body.clearance.departure_icao = ' kjfk';
    body.clearance.destination_icao = '  ';
    body.clearance.route = '  GREKI  DCT  ';
    body.clearance.initial_altitude_ft = 0;
    expect(project(body)).toEqual({
      ok: true,
      result: {
        plannedLegId: 12, created: true, departure: 'KJFK', destination: null, route: '  GREKI  DCT  ',
        initialAltitudeFt: 0, squawk: '4521', httpStatus: 201,
      },
    });
    body.clearance.initial_altitude_ft = CLEARANCE_ALTITUDE_MAX_FT;
    body.clearance.route = 'A'.repeat(CLEARANCE_ROUTE_MAX_UNITS);
    const atCap = project(body);
    expect(atCap.ok && atCap.result.route).toHaveLength(CLEARANCE_ROUTE_MAX_UNITS);
  });

  it('scrubs the token before checking lengths, and an airport that was the token fails', () => {
    const body = good();
    // Over the cap as sent, under it once the token is replaced.
    body.clearance.route = `${'A'.repeat(CLEARANCE_ROUTE_MAX_UNITS - 10)}${CLEARANCE_SENTINEL_TOKEN}`;
    const scrubbed = project(body, CLEARANCE_SENTINEL_TOKEN);
    expect(scrubbed.ok && scrubbed.result.route).toBe(`${'A'.repeat(CLEARANCE_ROUTE_MAX_UNITS - 10)}[REDACTED]`);
    body.clearance.route = CLEARANCE_SENTINEL_TOKEN;
    body.clearance.departure_icao = CLEARANCE_CODE_TOKEN.slice(0, 8);
    expect(project(body, CLEARANCE_CODE_TOKEN.slice(0, 8)).ok).toBe(false);
    body.clearance.departure_icao = 'KJFK';
    const routeOnly = project(body, CLEARANCE_SENTINEL_TOKEN);
    expect(routeOnly.ok && routeOnly.result.route).toBe('[REDACTED]');
  });

  it('any 2xx pairs with either value of created', () => {
    const body = good();
    body.created = false;
    expect(projectClearance(body, 201, 12, null)).toMatchObject({ ok: true, result: { created: false, httpStatus: 201 } });
    body.created = true;
    expect(projectClearance(body, 200, 12, null)).toMatchObject({ ok: true, result: { created: true, httpStatus: 200 } });
  });
});

describe('response line size', () => {
  const WORST_ID = `dl-${'9'.repeat(20)}`;
  const WORST_AT = 8_640_000_000_000_000;

  function line(result: unknown): string {
    return encodeDatalinkResponse({
      v: 1, type: 'datalink-response', at: WORST_AT, id: WORST_ID, ok: true, result: result as never,
    });
  }

  it('the long-route sample with a 4096-unit reply body projects to one line within the limit, without the reply', () => {
    const body = JSON.parse(JSON.stringify(clearanceFixture('post-201-long-route').response.body)) as Record<string, any>;
    const replyBody = ''.repeat(4096);
    body.reply.body = replyBody;
    body.reply.payload_json = replyBody;
    const projected = projectClearance(body, 201, 12, CLEARANCE_SENTINEL_TOKEN);
    expect(projected.ok).toBe(true);
    const encoded = line(projected.ok ? projected.result : null);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(JSON.parse(encoded)).toMatchObject({ ok: true, result: { route: body.clearance.route } });
    expect(body.clearance.route).toHaveLength(CLEARANCE_ROUTE_MAX_UNITS);
    expect(encoded).not.toContain('\\u0001');
  });

  it('the worst case (widest id, 8-unit airports, a 4096-unit route that escapes to 6 bytes a unit) stays about 25 KB, well within the limit', () => {
    const body = JSON.parse(JSON.stringify(clearanceFixture('post-201-created').response.body)) as Record<string, any>;
    const legId = Number.MAX_SAFE_INTEGER;
    body.planned_leg_id = legId;
    body.clearance.departure_icao = 'ABCDEFGH';
    body.clearance.destination_icao = 'IJKLMNOP';
    body.clearance.route = ''.repeat(CLEARANCE_ROUTE_MAX_UNITS);
    body.clearance.initial_altitude_ft = CLEARANCE_ALTITUDE_MAX_FT;
    const projected = projectClearance(body, 201, legId, null);
    expect(projected.ok).toBe(true);
    const encoded = line(projected.ok ? projected.result : null);
    expect(JSON.parse(encoded).ok).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeGreaterThan(24_000);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });

  it('a thread window carrying one PDC reply with a 4096-unit body stays within the limit', () => {
    const escaped = ''.repeat(8192);
    const thread = projectThread(
      {
        planned_leg_id: 12,
        messages: [{
          id: Number.MAX_SAFE_INTEGER, direction: 'uplink', category: escaped, label: escaped, body: escaped,
          sent_at: escaped, correlation_id: Number.MAX_SAFE_INTEGER,
        }],
      },
      'leg',
      null,
    );
    expect(thread.ok).toBe(true);
    const messages = thread.ok ? fillWindow(thread.messages, 0, 1) : [];
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toHaveLength(4096);
    const encoded = line({ epoch: Number.MAX_SAFE_INTEGER, total: 1, firstSeq: 0, startSeq: 0, endSeq: 1, messages });
    expect(JSON.parse(encoded).ok).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });
});
