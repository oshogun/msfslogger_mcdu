// tests/sayintentions-model.test.ts — tests src/sayintentions-model.ts.
//
// Every server sample under tests/fixtures/sayintentions/ is driven through the
// classifier and, when it is a 2xx, through the projection its op uses: one
// case per row of the error table and one per projection rule, positive and
// negative. The fixtures carry what each answer must become, so the table and
// the code are compared row for row rather than in prose.
//
// Two properties are asserted over the whole set: only a refused ingest token
// touches the datalink availability axis, and a known code on a status it is
// not documented with is not honoured.

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { DatalinkErrorCode, HttpOutcome } from '../src/datalink-classify';
import {
  classifySayIntentionsOutcome,
  projectSayIntentionsImport,
  projectSayIntentionsLink,
  projectSayIntentionsPdc,
  projectSayIntentionsStatus,
  projectSayIntentionsUnlink,
  SAYINTENTIONS_COUNT_MAX,
  SAYINTENTIONS_SENT_TEXT_MAX_UNITS,
  SAYINTENTIONS_UPSTREAM_ID_MAX_UNITS,
} from '../src/sayintentions-model';
import type { Projection } from '../src/datalink-model';
import { SENTINEL_TOKEN } from './helpers/datalink-scratch-server';

type Op = 'si-status' | 'si-link' | 'si-unlink' | 'si-import' | 'si-pdc';

interface Sample {
  _sample: string;
  _why: string;
  _op: Op;
  _route: string;
  _requested?: number | null;
  _from?: 'now' | 'session-start';
  _bodyTooLarge?: boolean;
  /** Replaces the sentinel token as the configured token, for this sample only. */
  configToken?: string;
  request: { method: string; path: string; headers: Record<string, string>; body: null };
  response: { status: number; headers: Record<string, string>; body: unknown };
  expect: {
    ok: boolean;
    code?: DatalinkErrorCode;
    httpStatus?: number | null;
    serverCode?: string | null;
    latch?: boolean;
    result?: Record<string, unknown>;
  };
}

const DIR = path.join(__dirname, 'fixtures', 'sayintentions');

function read<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as T;
}

/** Every server sample, by name; the local outcomes are not among them. */
function sampleNames(): string[] {
  return fs
    .readdirSync(DIR)
    .filter((file) => file.endsWith('.json') && file !== 'local-outcomes.json')
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

function sample(name: string): Sample {
  return read<Sample>(`${name}.json`);
}

function tokenOf(s: Sample): string {
  return s.configToken ?? SENTINEL_TOKEN;
}

/** The sample's answer as the client would have reported it. */
function outcomeOf(s: Sample): HttpOutcome {
  const scope = Object.entries(s.response.headers).find(([name]) => name.toLowerCase() === 'x-ingest-token-scope');
  const body = s.response.body;
  return {
    kind: 'response',
    status: s.response.status,
    scopeHeader: scope ? scope[1] : null,
    bodyText: s._bodyTooLarge ? null : typeof body === 'string' ? body : JSON.stringify(body),
    bodyTooLarge: s._bodyTooLarge === true,
  };
}

function projectFor(s: Sample, json: unknown, httpStatus: number): Projection<Record<string, unknown>> {
  const token = tokenOf(s);
  const requested = s._requested ?? null;
  switch (s._op) {
    case 'si-status':
      return projectSayIntentionsStatus(json, httpStatus, requested, token) as Projection<Record<string, unknown>>;
    case 'si-link':
      return projectSayIntentionsLink(json, httpStatus, requested as number, token) as Projection<Record<string, unknown>>;
    case 'si-unlink':
      return projectSayIntentionsUnlink(json, httpStatus, requested as number) as Projection<Record<string, unknown>>;
    case 'si-import':
      return projectSayIntentionsImport(json, httpStatus, requested as number) as Projection<Record<string, unknown>>;
    case 'si-pdc':
      return projectSayIntentionsPdc(json, httpStatus, requested as number, token) as Projection<Record<string, unknown>>;
  }
}

describe('every server sample classifies and projects as the table freezes it', () => {
  it('the fixture set is the frozen one: 67 samples plus the local outcomes', () => {
    expect(sampleNames()).toHaveLength(67);
    expect(fs.existsSync(path.join(DIR, 'local-outcomes.json'))).toBe(true);
    for (const name of sampleNames()) expect(sample(name)._sample).toBe(name);
  });

  it.each(sampleNames())('%s', (name) => {
    const s = sample(name);
    const classified = classifySayIntentionsOutcome(outcomeOf(s), tokenOf(s));

    if (!s.expect.ok && s.expect.code !== 'bad-response') {
      expect(classified.ok).toBe(false);
      if (classified.ok) return;
      expect(classified.code).toBe(s.expect.code);
      expect(classified.httpStatus).toBe(s.expect.httpStatus ?? null);
      expect(classified.serverCode).toBe(s.expect.serverCode ?? null);
      // Only a refused token touches the availability axis, and only it latches.
      if (s.expect.latch) {
        expect(classified.availability).toBe('dl.token-invalid');
        expect(classified.retry).toBe('latch');
      } else {
        expect(classified.availability).toBeNull();
        expect(classified.retry).toBe('none');
      }
      return;
    }

    // A 2xx whose body is not JSON never reaches a projection.
    if (!classified.ok) {
      expect(s.expect.ok).toBe(false);
      expect(classified.code).toBe('bad-response');
      expect(classified.httpStatus).toBe(s.response.status);
      expect(classified.availability).toBeNull();
      expect(classified.retry).toBe('none');
      return;
    }

    expect(classified.httpStatus).toBe(s.response.status);
    const projected = projectFor(s, classified.json, classified.httpStatus);
    if (!s.expect.ok) {
      expect(projected.ok).toBe(false);
      if (!projected.ok) {
        expect(projected.detail).not.toContain(tokenOf(s));
        expect(projected.detail.length).toBeGreaterThan(0);
      }
      return;
    }
    expect(projected.ok).toBe(true);
    if (projected.ok) expect(projected.result).toEqual(s.expect.result);
  });
});

describe('the error table: a code counts only on its own status', () => {
  // One row per (status, server code) pair the server documents.
  const SEMANTIC: [string, number, string, DatalinkErrorCode][] = [
    ['409-no-api-key', 409, 'NO_API_KEY', 'si-no-api-key'],
    ['409-bad-api-key', 409, 'BAD_API_KEY', 'si-bad-api-key'],
    ['409-not-linked', 409, 'NOT_LINKED', 'si-not-linked'],
    ['409-session-changed', 409, 'SESSION_CHANGED', 'si-session-changed'],
    ['409-no-comms-to-link', 409, 'NO_COMMS_TO_LINK', 'si-no-comms'],
    ['409-no-active-session', 409, 'NO_ACTIVE_SESSION', 'si-no-session'],
    ['409-no-clearance', 409, 'NO_CLEARANCE', 'si-no-clearance'],
    ['502-upstream-unreachable', 502, 'UPSTREAM_UNREACHABLE', 'si-upstream-unreachable'],
    ['502-upstream-error', 502, 'UPSTREAM_ERROR', 'si-upstream-error'],
    ['502-upstream-bad-body', 502, 'UPSTREAM_BAD_BODY', 'si-upstream-bad-body'],
    ['504-upstream-timeout', 504, 'UPSTREAM_TIMEOUT', 'si-upstream-timeout'],
    ['404-flight-not-found', 404, 'FLIGHT_NOT_FOUND', 'flight-not-found'],
    ['404-planned-leg-not-found', 404, 'PLANNED_LEG_NOT_FOUND', 'leg-not-found'],
    ['400-invalid-id', 400, 'INVALID_ID', 'invalid-id'],
  ];

  it.each(SEMANTIC)('%s is %i %s -> %s, with the raw code emitted', (name, status, serverCode, code) => {
    const s = sample(name);
    expect(s.response.status).toBe(status);
    expect((s.response.body as { code: string }).code).toBe(serverCode);
    expect(classifySayIntentionsOutcome(outcomeOf(s), SENTINEL_TOKEN)).toEqual({
      ok: false, code, availability: null, httpStatus: status, serverCode, retry: 'none',
    });
  });

  it('every documented code is honoured on its own status and nowhere else', () => {
    for (const [name, status, serverCode, code] of SEMANTIC) {
      const s = sample(name);
      for (const wrong of [400, 404, 409, 418, 502, 504]) {
        const moved = classifySayIntentionsOutcome({ ...outcomeOf(s), status: wrong }, SENTINEL_TOKEN);
        expect(moved.ok).toBe(false);
        if (!moved.ok) expect(moved.code).toBe(wrong === status ? code : 'http-error');
      }
      expect(serverCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('an unknown code at a known status, and a known code at the wrong status, are both http-error', () => {
    const unknown = sample('422-unknown-code');
    expect(classifySayIntentionsOutcome(outcomeOf(unknown), SENTINEL_TOKEN)).toEqual({
      ok: false, code: 'http-error', availability: null, httpStatus: 422, serverCode: 'SOME_FUTURE_CODE', retry: 'none',
    });
    const mismatch = sample('409-code-status-mismatch');
    expect((mismatch.response.body as { code: string }).code).toBe('UPSTREAM_TIMEOUT');
    expect(classifySayIntentionsOutcome(outcomeOf(mismatch), SENTINEL_TOKEN)).toEqual({
      ok: false, code: 'http-error', availability: null, httpStatus: 409, serverCode: 'UPSTREAM_TIMEOUT', retry: 'none',
    });
  });

  it('403 is rejected, a 302 is an http-error, and a body over the cap is too-large', () => {
    expect(classifySayIntentionsOutcome(outcomeOf(sample('403-cross-origin')), SENTINEL_TOKEN)).toMatchObject({
      code: 'rejected', httpStatus: 403,
    });
    expect(classifySayIntentionsOutcome(outcomeOf(sample('302-redirect')), SENTINEL_TOKEN)).toMatchObject({
      code: 'http-error', httpStatus: 302,
    });
    // A distinct code from bad-response, so a fixture can prove which cap fired.
    expect(classifySayIntentionsOutcome(outcomeOf(sample('200-body-too-large')), SENTINEL_TOKEN)).toEqual({
      ok: false, code: 'too-large', availability: null, httpStatus: 200, serverCode: null, retry: 'none',
    });
  });

  it('the transport rows: a timeout, a TLS failure and an unreachable server', () => {
    const rows: [HttpOutcome, DatalinkErrorCode][] = [
      [{ kind: 'transport', errorName: 'TimeoutError', errorCode: null }, 'timeout'],
      [{ kind: 'transport', errorName: 'TypeError', errorCode: 'SELF_SIGNED_CERT_IN_CHAIN' }, 'tls-error'],
      [{ kind: 'transport', errorName: 'TypeError', errorCode: 'ECONNREFUSED' }, 'unreachable'],
      // A timeout also carries a numeric code, so the name has to win.
      [{ kind: 'transport', errorName: 'TimeoutError', errorCode: 'UND_ERR_HEADERS_TIMEOUT' }, 'timeout'],
    ];
    for (const [outcome, code] of rows) {
      expect(classifySayIntentionsOutcome(outcome, SENTINEL_TOKEN)).toEqual({
        ok: false, code, availability: null, httpStatus: null, serverCode: null, retry: 'none',
      });
    }
  });
});

describe('the three 401s', () => {
  it('no scope header is sayintentions-unavailable: a server that predates the routes, and it never latches', () => {
    for (const name of ['401-no-scope-header', '401-code-shaped-token']) {
      const s = sample(name);
      expect(Object.keys(s.response.headers).map((h) => h.toLowerCase())).not.toContain('x-ingest-token-scope');
      const classified = classifySayIntentionsOutcome(outcomeOf(s), tokenOf(s));
      expect(classified).toMatchObject({
        ok: false, code: 'sayintentions-unavailable', availability: null, httpStatus: 401, retry: 'none',
      });
    }
  });

  it('scope accepted with no code is token-missing: the header was stripped in transit', () => {
    const s = sample('401-token-missing');
    expect(s.response.headers['x-ingest-token-scope']).toBe('accepted');
    expect(classifySayIntentionsOutcome(outcomeOf(s), SENTINEL_TOKEN)).toEqual({
      ok: false, code: 'token-missing', availability: null, httpStatus: 401, serverCode: null, retry: 'none',
    });
  });

  it.each(['401-invalid-token', '401-invalid-token-no-header'])(
    '%s latches on the datalink axis: the code is checked before the header',
    (name) => {
      const s = sample(name);
      expect(classifySayIntentionsOutcome(outcomeOf(s), SENTINEL_TOKEN)).toEqual({
        ok: false,
        code: 'token-invalid',
        availability: 'dl.token-invalid',
        httpStatus: 401,
        serverCode: 'INVALID_INGEST_TOKEN',
        retry: 'latch',
      });
    },
  );

  it('a token that is a substring of the real code still latches, with serverCode null', () => {
    const s = sample('401-invalid-token');
    expect(classifySayIntentionsOutcome(outcomeOf(s), 'INGEST_TOKEN')).toEqual({
      ok: false,
      code: 'token-invalid',
      availability: 'dl.token-invalid',
      httpStatus: 401,
      serverCode: null,
      retry: 'latch',
    });
  });

  it('a code-shaped token echoed as the code is never emitted', () => {
    const s = sample('401-code-shaped-token');
    const raw = (s.response.body as { code: string }).code;
    expect(raw).toBe(tokenOf(s));
    expect(classifySayIntentionsOutcome(outcomeOf(s), tokenOf(s))).toMatchObject({ serverCode: null });
    // With another token configured it is an ordinary unknown code again.
    expect(classifySayIntentionsOutcome(outcomeOf(s), SENTINEL_TOKEN)).toMatchObject({ serverCode: raw });
  });
});

describe('the projections', () => {
  it('the parameter alone decides which question was answered', () => {
    const settings = sample('settings-200-key-set');
    expect(projectSayIntentionsStatus(settings.response.body, 200, null, SENTINEL_TOKEN)).toMatchObject({
      ok: true, result: { answered: 'settings', flightId: null, linked: null, link: null },
    });
    // The other body is never produced for a null parameter, and would not project as one.
    const linked = sample('status-200-linked');
    expect(projectSayIntentionsStatus(linked.response.body, 200, null, SENTINEL_TOKEN).ok).toBe(false);
    expect(projectSayIntentionsStatus(linked.response.body, 200, 42, SENTINEL_TOKEN)).toMatchObject({
      ok: true, result: { answered: 'link', flightId: 42, linked: true },
    });
    // And the flight body is not accepted for another flight id.
    expect(projectSayIntentionsStatus(linked.response.body, 200, 43, SENTINEL_TOKEN).ok).toBe(false);
  });

  it('the masked key is never projected, logged or inspected', () => {
    const s = sample('settings-200-key-set-masked-token');
    const projected = projectSayIntentionsStatus(s.response.body, 200, null, SENTINEL_TOKEN);
    expect(projected.ok).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('masked');
    expect(JSON.stringify(projected)).not.toContain(SENTINEL_TOKEN);
    expect(JSON.stringify(projected)).not.toContain('si_1');
  });

  it('the imported rows are not read at all', () => {
    const s = sample('import-201-messages-ignored');
    const projected = projectSayIntentionsImport(s.response.body, 201, 42);
    expect(projected).toEqual({ ok: true, result: s.expect.result });
    expect(JSON.stringify(projected)).not.toContain(SENTINEL_TOKEN);
    expect(JSON.stringify(projected)).not.toContain('messages');
    expect(JSON.stringify(projected)).not.toContain('taxi');
  });

  it('the filed message proves a row exists and is then dropped', () => {
    const s = sample('pdc-201-sent');
    const projected = projectSayIntentionsPdc(s.response.body, 201, 29, SENTINEL_TOKEN);
    expect(projected).toEqual({ ok: true, result: s.expect.result });
    expect(JSON.stringify(projected)).not.toContain('905');
    expect(projectSayIntentionsPdc(sample('pdc-201-message-without-id').response.body, 201, 29, null).ok).toBe(false);
  });

  it('the caps are the widths the pages reserve, and an over-long value fails rather than being cut', () => {
    expect(SAYINTENTIONS_SENT_TEXT_MAX_UNITS).toBe(144);
    expect(SAYINTENTIONS_UPSTREAM_ID_MAX_UNITS).toBe(64);
    expect(SAYINTENTIONS_COUNT_MAX).toBe(999999);

    const atCap = { planned_leg_id: 29, sent_text: 'P'.repeat(144), message: { id: 1 } };
    expect(projectSayIntentionsPdc(atCap, 201, 29, null)).toMatchObject({ ok: true, result: { sentText: 'P'.repeat(144) } });
    expect(projectSayIntentionsPdc({ ...atCap, sent_text: 'P'.repeat(145) }, 201, 29, null).ok).toBe(false);

    const link = (over: Record<string, unknown>) => ({
      flight_id: 42, linked: true, api_key_set: true,
      link: { ...(sample('status-200-linked').response.body as { link: Record<string, unknown> }).link, ...over },
    });
    expect(projectSayIntentionsStatus(link({ upstream_flight_id: '8'.repeat(64) }), 200, 42, null).ok).toBe(true);
    expect(projectSayIntentionsStatus(link({ upstream_flight_id: '8'.repeat(65) }), 200, 42, null).ok).toBe(false);
    expect(projectSayIntentionsStatus(link({ imported_count: 999999 }), 200, 42, null).ok).toBe(true);
    expect(projectSayIntentionsStatus(link({ imported_count: 1000000 }), 200, 42, null).ok).toBe(false);
    // A cursor is a row id, not a count, so it has the wider range.
    expect(projectSayIntentionsStatus(link({ since_id: Number.MAX_SAFE_INTEGER }), 200, 42, null).ok).toBe(true);
    expect(projectSayIntentionsStatus(link({ since_id: -1 }), 200, 42, null).ok).toBe(false);
    expect(projectSayIntentionsStatus(link({ since_id: 1.5 }), 200, 42, null).ok).toBe(false);
    // A timestamp over 32 units is not one the CDU was promised.
    expect(projectSayIntentionsStatus(link({ linked_at: `2026-09-17T14:30:00.000Z${' '.repeat(12)}` }), 200, 42, null).ok).toBe(false);
  });

  it('a body of the wrong kind is bad data, never a throw', () => {
    for (const body of [null, 42, 'a string', [], [{ flight_id: 42 }], undefined]) {
      expect(projectSayIntentionsStatus(body, 200, null, null).ok).toBe(false);
      expect(projectSayIntentionsStatus(body, 200, 42, null).ok).toBe(false);
      expect(projectSayIntentionsLink(body, 201, 42, null).ok).toBe(false);
      expect(projectSayIntentionsUnlink(body, 200, 42).ok).toBe(false);
      expect(projectSayIntentionsImport(body, 201, 42).ok).toBe(false);
      expect(projectSayIntentionsPdc(body, 201, 29, null).ok).toBe(false);
    }
  });
});

describe('the outcomes no server answer produces', () => {
  it('local-outcomes.json lists codes the model never returns', () => {
    const local = read<Record<string, { expect: { code: string } }>>('local-outcomes.json');
    const listed = Object.entries(local)
      .filter(([key]) => !key.startsWith('_'))
      .map(([, row]) => row.expect.code);
    expect(listed.length).toBeGreaterThan(0);

    // Everything the classifier can produce, from every sample and every transport row.
    const produced = new Set<string>();
    for (const name of sampleNames()) {
      const s = sample(name);
      const classified = classifySayIntentionsOutcome(outcomeOf(s), tokenOf(s));
      if (!classified.ok) produced.add(classified.code);
    }
    const LOCAL_ONLY = [
      'busy', 'sayintentions-in-progress', 'no-config', 'shell-timeout', 'sidecar-exited', 'sidecar-unavailable',
      'sidecar-outdated', 'bad-request', 'host-unsupported', 'host-error', 'some-future-code',
    ];
    for (const code of LOCAL_ONLY) {
      expect(listed).toContain(code);
      expect(produced.has(code)).toBe(false);
    }
    // The transport rows and the two latch rows are listed with the codes the model does produce.
    for (const code of ['unreachable', 'tls-error', 'timeout', 'too-large', 'token-invalid']) {
      expect(listed).toContain(code);
    }
  });
});
