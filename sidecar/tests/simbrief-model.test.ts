// tests/simbrief-model.test.ts — tests src/simbrief-model.ts.
//
// Every SimBrief server sample is served by a scratch server on an ephemeral
// port and goes through the real client, the SimBrief classifier and the
// projection, and must come out exactly as the sample's `expect` says. The
// transport rows (refused, reset, client timeout, TLS) and the body cap are
// covered beside them.

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpOutcome } from '../src/datalink-classify';
import { DatalinkClient, type DatalinkRoute } from '../src/datalink-client';
import {
  classifySimbriefOutcome,
  PREFILE_LABEL_MAX_UNITS,
  PREFILE_WARNING_COUNT_MAX,
  projectSimbriefPrefile,
  projectSimbriefSettings,
} from '../src/simbrief-model';
import { Uplink } from '../src/uplink';
import {
  closedPort,
  scratchConfig,
  SIMBRIEF_SENTINEL_TOKEN,
  simbriefFixture,
  simbriefFixtureNames,
  startScratchServer,
  type ScratchServer,
} from './helpers/datalink-scratch-server';

type LocalExpect = { ok: false; code: string; httpStatus: null; serverCode: null; latch: false };
const LOCAL_FILE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'simbrief', 'local-outcomes.json'), 'utf8'),
) as Record<string, { expect: LocalExpect }>;
// Only the members the sidecar produces; the CDU text is the webview's to check.
const LOCAL = Object.fromEntries(
  Object.entries(LOCAL_FILE).map(([name, { expect: e }]) => [
    name,
    { expect: { ok: e.ok, code: e.code, httpStatus: e.httpStatus, serverCode: e.serverCode, latch: e.latch } },
  ]),
);

function routeFor(requestPath: string): DatalinkRoute {
  return requestPath === '/api/settings/simbrief' ? { key: 'simbrief-settings' } : { key: 'simbrief-prefile' };
}

/** Classifier, then projection: the value the service answers with. */
function answer(route: DatalinkRoute, outcome: HttpOutcome, token: string) {
  const classified = classifySimbriefOutcome(outcome, token);
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
  const projected =
    route.key === 'simbrief-settings'
      ? projectSimbriefSettings(classified.json)
      : projectSimbriefPrefile(classified.json, classified.httpStatus, token);
  if (!projected.ok) {
    return { ok: false, code: 'bad-response', httpStatus: classified.httpStatus, serverCode: null, latch: false, availability: null };
  }
  return { ok: true, result: projected.result };
}

describe('every SimBrief server sample through the client, classifier and projection', () => {
  const names = simbriefFixtureNames();

  it('has all 27 samples', () => {
    expect(names).toHaveLength(27);
  });

  it.each(names)('%s', async (name) => {
    const sample = simbriefFixture(name);
    const token = sample.configToken ?? SIMBRIEF_SENTINEL_TOKEN;
    const route = routeFor(sample.request.path);
    const server = await startScratchServer({
      [`${sample.request.method} ${sample.request.path}`]: () => ({
        status: sample.response.status,
        headers: sample.response.headers,
        body: sample.response.body,
      }),
    });
    const uplink = new Uplink(scratchConfig(server.baseUrl, { ingestToken: token }));
    try {
      const outcome = await new DatalinkClient(() => uplink).request(route);
      const got = answer(route, outcome, token);

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
      expect(`${server.requests[0].method} ${server.requests[0].path}`).toBe(
        `${sample.request.method} ${sample.request.path}`,
      );
      expect(server.requests[0].headers['x-ingest-token']).toBe(token);
      expect(JSON.stringify(got)).not.toContain(token);
      expect(JSON.stringify(got)).not.toContain('1234567');
    } finally {
      await uplink.close();
      await server.close();
    }
  });

  it('a 401 with no scope header is simbrief-unavailable on both routes, never token-invalid, and never latches', () => {
    for (const name of ['get-settings-401-no-scope-header', 'post-401-no-scope-header', 'post-401-code-shaped-token']) {
      const sample = simbriefFixture(name);
      const outcome: HttpOutcome = {
        kind: 'response',
        status: 401,
        scopeHeader: null,
        bodyText: JSON.stringify(sample.response.body),
        bodyTooLarge: false,
      };
      const classified = classifySimbriefOutcome(outcome, sample.configToken ?? SIMBRIEF_SENTINEL_TOKEN);
      expect(classified).toMatchObject({ ok: false, code: 'simbrief-unavailable', availability: null, retry: 'none' });
      expect(classified).not.toMatchObject({ code: 'token-invalid' });
    }
  });

  it('INVALID_INGEST_TOKEN is token-invalid with or without the scope header, and is checked before it', () => {
    const body = JSON.stringify({ error: 'x', code: 'INVALID_INGEST_TOKEN' });
    for (const scopeHeader of [null, 'accepted', ' Accepted ']) {
      expect(
        classifySimbriefOutcome({ kind: 'response', status: 401, scopeHeader, bodyText: body, bodyTooLarge: false }, SIMBRIEF_SENTINEL_TOKEN),
      ).toEqual({
        ok: false, code: 'token-invalid', availability: 'dl.token-invalid', httpStatus: 401,
        serverCode: 'INVALID_INGEST_TOKEN', retry: 'latch',
      });
    }
    expect(
      classifySimbriefOutcome({ kind: 'response', status: 401, scopeHeader: ' ACCEPTED ', bodyText: '{}', bodyTooLarge: false }, null),
    ).toMatchObject({ code: 'token-missing', availability: null });
  });
});

describe('transport outcomes', () => {
  it('local-outcomes lists the three unknown-outcome rows', () => {
    expect(Object.keys(LOCAL).sort()).toEqual(['relay-timeout', 'transport-client-timeout', 'transport-unreachable']);
    expect(LOCAL['relay-timeout'].expect.code).toBe('shell-timeout');
  });

  it('pure: TimeoutError is timeout, a TLS code is tls-error, anything else is unreachable', () => {
    const none = { availability: null, httpStatus: null, serverCode: null, retry: 'none' };
    expect(classifySimbriefOutcome({ kind: 'transport', errorName: 'TimeoutError', errorCode: '23' }, null)).toEqual({
      ok: false, code: 'timeout', ...none,
    });
    expect(
      classifySimbriefOutcome({ kind: 'transport', errorName: 'TypeError', errorCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, null),
    ).toEqual({ ok: false, code: 'tls-error', ...none });
    expect(classifySimbriefOutcome({ kind: 'transport', errorName: 'TypeError', errorCode: 'ECONNRESET' }, null)).toEqual({
      ok: false, code: 'unreachable', ...none,
    });
  });

  it('a body over the cap is bad-response with its status', () => {
    expect(
      classifySimbriefOutcome({ kind: 'response', status: 201, scopeHeader: null, bodyText: null, bodyTooLarge: true }, null),
    ).toEqual({ ok: false, code: 'bad-response', availability: null, httpStatus: 201, serverCode: null, retry: 'none' });
  });

  describe('against real sockets', () => {
    let server: ScratchServer;
    let uplink: Uplink;

    beforeAll(async () => {
      server = await startScratchServer({
        'POST /api/planned-legs/simbrief': () => ({ destroy: true }),
        'GET /api/settings/simbrief': () => 'hang',
      });
      uplink = new Uplink(scratchConfig(server.baseUrl, { ingestToken: SIMBRIEF_SENTINEL_TOKEN }));
    });

    afterAll(async () => {
      await uplink.close();
      await server.close();
    });

    it('transport-unreachable: a refused connection and a reset connection', async () => {
      const port = await closedPort();
      const offline = new Uplink(scratchConfig(`http://127.0.0.1:${port}`, { ingestToken: SIMBRIEF_SENTINEL_TOKEN }));
      try {
        const refused = await new DatalinkClient(() => offline).request({ key: 'simbrief-prefile' });
        expect(answer({ key: 'simbrief-prefile' }, refused, SIMBRIEF_SENTINEL_TOKEN)).toMatchObject(
          LOCAL['transport-unreachable'].expect,
        );
      } finally {
        await offline.close();
      }
      const reset = await new DatalinkClient(() => uplink).request({ key: 'simbrief-prefile' });
      expect(reset.kind).toBe('transport');
      expect(answer({ key: 'simbrief-prefile' }, reset, SIMBRIEF_SENTINEL_TOKEN)).toMatchObject(
        LOCAL['transport-unreachable'].expect,
      );
    });

    it('transport-client-timeout: no answer within the client timeout', async () => {
      const outcome = await new DatalinkClient(() => uplink, { timeoutMs: 150 }).request({ key: 'simbrief-settings' });
      expect(answer({ key: 'simbrief-settings' }, outcome, SIMBRIEF_SENTINEL_TOKEN)).toMatchObject(
        LOCAL['transport-client-timeout'].expect,
      );
    });
  });
});

describe('projections', () => {
  it('settings: only a plain object with an own simbrief_user_id of null or a string projects', () => {
    expect(projectSimbriefSettings({ simbrief_user_id: '42' })).toEqual({ ok: true, result: { configured: true } });
    expect(projectSimbriefSettings({ simbrief_user_id: '' })).toEqual({ ok: true, result: { configured: false } });
    expect(projectSimbriefSettings({ simbrief_user_id: null })).toEqual({ ok: true, result: { configured: false } });
    for (const body of [null, [], 'x', {}, { simbrief_user_id: 42 }, { simbrief_user_id: {} }, Object.create({ simbrief_user_id: '1' })]) {
      expect(projectSimbriefSettings(body).ok).toBe(false);
    }
  });

  it('prefile: rejects a missing result, a bad status, a bad id and a non-string label', () => {
    const good = { result: { status: 'imported', planned_leg_id: 5, label: 'L', warnings: [] } };
    expect(projectSimbriefPrefile(good, 201, null)).toEqual({
      ok: true, result: { status: 'imported', plannedLegId: 5, label: 'L', warningCount: 0, httpStatus: 201 },
    });
    for (const body of [
      null,
      {},
      { result: [] },
      { result: { ...good.result, status: 'queued' } },
      { result: { ...good.result, planned_leg_id: 0 } },
      { result: { ...good.result, planned_leg_id: '5' } },
      { result: { ...good.result, planned_leg_id: Number.MAX_SAFE_INTEGER + 1 } },
      { result: { ...good.result, label: null } },
    ]) {
      expect(projectSimbriefPrefile(body, 201, null).ok).toBe(false);
    }
  });

  it('prefile: any 2xx pairs with either status; warnings count is capped; label is scrubbed then capped', () => {
    const body = {
      result: {
        status: 'duplicate',
        planned_leg_id: 9,
        label: `${'A'.repeat(90)}${SIMBRIEF_SENTINEL_TOKEN}`,
        warnings: new Array(PREFILE_WARNING_COUNT_MAX + 5).fill('w'),
      },
    };
    const projected = projectSimbriefPrefile(body, 201, SIMBRIEF_SENTINEL_TOKEN);
    expect(projected.ok).toBe(true);
    if (projected.ok) {
      expect(projected.result.status).toBe('duplicate');
      expect(projected.result.httpStatus).toBe(201);
      expect(projected.result.warningCount).toBe(999);
      expect(projected.result.label).toHaveLength(PREFILE_LABEL_MAX_UNITS);
      expect(projected.result.label).toBe(`${'A'.repeat(90)}[REDAC`);
      expect(projected.result.label).not.toContain('SENTINEL');
    }
    const noWarnings = projectSimbriefPrefile({ result: { ...body.result, warnings: 'x' } }, 200, null);
    expect(noWarnings.ok && noWarnings.result.warningCount).toBe(0);
  });
});
