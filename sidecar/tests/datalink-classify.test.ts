// tests/datalink-classify.test.ts — tests src/datalink-classify.ts.
//
// One row per decision the classifier makes. The 401 rows matter most: a wrong
// token must latch, a server that predates the datalink must not, and the
// difference is a body code and a header.

import { describe, expect, it } from 'vitest';
import { classifyOutcome, type Classified, type HttpOutcome } from '../src/datalink-classify';
import { fixture, SENTINEL_TOKEN } from './helpers/datalink-scratch-server';

function response(status: number, body: unknown, headers: Record<string, string> = {}): HttpOutcome {
  const scope = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-ingest-token-scope');
  return {
    kind: 'response',
    status,
    scopeHeader: scope ? scope[1] : null,
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
    bodyTooLarge: false,
  };
}

function fromFixture(name: string): HttpOutcome {
  const { response: r } = fixture(name);
  return response(r.status, r.body, r.headers);
}

function fault(
  code: string,
  availability: string | null,
  httpStatus: number | null,
  serverCode: string | null,
  retry: 'backoff' | 'latch' | 'none',
): Classified {
  return { ok: false, code, availability, httpStatus, serverCode, retry } as Classified;
}

interface Row {
  row: string;
  name: string;
  outcome: HttpOutcome;
  poll: Classified;
  op: Classified;
}

const transport = (errorName: string | null, errorCode: string | null): HttpOutcome => ({
  kind: 'transport',
  errorName,
  errorCode,
});

const same = (c: Classified) => ({ poll: c, op: c });

const ROWS: Row[] = [
  {
    row: 'T1', name: 'thrown fetch (ECONNREFUSED) -> unreachable',
    outcome: transport('TypeError', 'ECONNREFUSED'),
    ...same(fault('unreachable', 'dl.unreachable', null, null, 'backoff')),
  },
  {
    row: 'T1', name: 'thrown fetch with no code -> unreachable',
    outcome: transport('TypeError', null),
    ...same(fault('unreachable', 'dl.unreachable', null, null, 'backoff')),
  },
  {
    row: 'T2', name: 'TimeoutError with a numeric code -> timeout',
    outcome: transport('TimeoutError', null),
    ...same(fault('timeout', 'dl.timeout', null, null, 'backoff')),
  },
  {
    row: 'T3', name: 'TLS code -> tls-error',
    outcome: transport('TypeError', 'DEPTH_ZERO_SELF_SIGNED_CERT'),
    ...same(fault('tls-error', 'dl.tls-error', null, null, 'backoff')),
  },
  {
    row: 'D2', name: '401 INVALID_INGEST_TOKEN without the scope header -> token-invalid, latch',
    outcome: fromFixture('err-401-invalid-token'),
    ...same(fault('token-invalid', 'dl.token-invalid', 401, 'INVALID_INGEST_TOKEN', 'latch')),
  },
  {
    row: 'D2', name: '401 INVALID_INGEST_TOKEN with scope header accepted -> token-invalid (code wins)',
    outcome: response(401, { error: 'x', code: 'INVALID_INGEST_TOKEN' }, { 'X-Ingest-Token-Scope': 'accepted' }),
    ...same(fault('token-invalid', 'dl.token-invalid', 401, 'INVALID_INGEST_TOKEN', 'latch')),
  },
  {
    row: 'D3', name: '401 + X-Ingest-Token-Scope: accepted, no code -> token-missing',
    outcome: fromFixture('err-401-scope-accepted-no-token'),
    ...same(fault('token-missing', 'dl.token-missing', 401, null, 'backoff')),
  },
  {
    row: 'D3', name: 'scope header value is compared trimmed and case-insensitively',
    outcome: response(401, { error: 'x' }, { 'x-ingest-token-scope': '  ACCEPTED ' }),
    ...same(fault('token-missing', 'dl.token-missing', 401, null, 'backoff')),
  },
  {
    row: 'D4', name: '401 with no X-Ingest-Token-Scope header -> unavailable',
    outcome: fromFixture('err-401-pre-upgrade-no-scope-header'),
    ...same(fault('unavailable', 'dl.unavailable', 401, null, 'backoff')),
  },
  {
    row: 'D4', name: '401 with an unknown scope header value -> unavailable',
    outcome: response(401, { error: 'x' }, { 'x-ingest-token-scope': 'denied' }),
    ...same(fault('unavailable', 'dl.unavailable', 401, null, 'backoff')),
  },
  {
    row: 'D5', name: '403 cross-origin -> rejected',
    outcome: fromFixture('err-403-cross-origin'),
    ...same(fault('rejected', 'dl.rejected', 403, null, 'backoff')),
  },
  {
    row: 'S1', name: '400 NOT_A_CANNED_MESSAGE',
    outcome: fromFixture('err-400-not-a-canned-message'),
    op: fault('not-a-canned-message', null, 400, 'NOT_A_CANNED_MESSAGE', 'none'),
    poll: fault('not-a-canned-message', 'dl.http-error', 400, 'NOT_A_CANNED_MESSAGE', 'backoff'),
  },
  {
    row: 'S2', name: '400 UNKNOWN_CANNED_MESSAGE',
    outcome: fromFixture('err-400-unknown-canned-message'),
    op: fault('unknown-canned-message', null, 400, 'UNKNOWN_CANNED_MESSAGE', 'none'),
    poll: fault('unknown-canned-message', 'dl.http-error', 400, 'UNKNOWN_CANNED_MESSAGE', 'backoff'),
  },
  {
    row: 'S3', name: '409 NO_DISPATCH_DATA',
    outcome: fromFixture('err-409-no-dispatch-data'),
    op: fault('no-dispatch-data', null, 409, 'NO_DISPATCH_DATA', 'none'),
    poll: fault('no-dispatch-data', 'dl.http-error', 409, 'NO_DISPATCH_DATA', 'backoff'),
  },
  {
    row: 'S4', name: '400 INVALID_ID',
    outcome: fromFixture('err-400-invalid-id'),
    op: fault('invalid-id', null, 400, 'INVALID_ID', 'none'),
    poll: fault('invalid-id', 'dl.http-error', 400, 'INVALID_ID', 'backoff'),
  },
  {
    row: 'S5', name: '404 FLIGHT_NOT_FOUND',
    outcome: fromFixture('err-404-flight-not-found'),
    op: fault('flight-not-found', null, 404, 'FLIGHT_NOT_FOUND', 'none'),
    poll: fault('flight-not-found', 'dl.http-error', 404, 'FLIGHT_NOT_FOUND', 'backoff'),
  },
  {
    row: 'S6', name: '404 PLANNED_LEG_NOT_FOUND',
    outcome: fromFixture('err-404-leg-not-found'),
    op: fault('leg-not-found', null, 404, 'PLANNED_LEG_NOT_FOUND', 'none'),
    poll: fault('leg-not-found', 'dl.http-error', 404, 'PLANNED_LEG_NOT_FOUND', 'backoff'),
  },
  {
    row: 'H1', name: '500 -> http-error',
    outcome: response(500, { error: 'boom' }),
    ...same(fault('http-error', 'dl.http-error', 500, null, 'backoff')),
  },
  {
    row: 'H1', name: '302 (redirects are not followed) -> http-error',
    outcome: response(302, ''),
    ...same(fault('http-error', 'dl.http-error', 302, null, 'backoff')),
  },
  {
    row: 'H1', name: 'a semantic code on the wrong status is not semantic',
    outcome: response(500, { error: 'x', code: 'NO_DISPATCH_DATA' }),
    ...same(fault('http-error', 'dl.http-error', 500, 'NO_DISPATCH_DATA', 'backoff')),
  },
  {
    row: 'H1', name: 'a malformed body code is ignored',
    outcome: response(418, { error: 'x', code: 'lower-case' }),
    ...same(fault('http-error', 'dl.http-error', 418, null, 'backoff')),
  },
  {
    row: 'B1', name: '2xx body that is not JSON -> bad-response',
    outcome: response(200, '<html>not json</html>'),
    ...same(fault('bad-response', 'dl.bad-response', 200, null, 'backoff')),
  },
  {
    row: 'B2', name: 'body over the cap -> bad-response',
    outcome: { kind: 'response', status: 200, scopeHeader: null, bodyText: null, bodyTooLarge: true },
    ...same(fault('bad-response', 'dl.bad-response', 200, null, 'backoff')),
  },
];

describe('classifyOutcome decision table', () => {
  it.each(ROWS)('$row: $name', ({ outcome, poll, op }) => {
    expect(classifyOutcome(outcome, 'poll', SENTINEL_TOKEN)).toEqual(poll);
    expect(classifyOutcome(outcome, 'op', SENTINEL_TOKEN)).toEqual(op);
  });

  it('a 2xx JSON body is ok and carries the parsed JSON', () => {
    const outcome = fromFixture('01a-get-status-flying');
    const result = classifyOutcome(outcome, 'poll', SENTINEL_TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.httpStatus).toBe(200);
      expect((result.json as { currentFlightId: number }).currentFlightId).toBe(92);
    }
  });

  it('a 401 without the scope header is never the token error', () => {
    for (const body of [{ error: 'Authentication required' }, '', 'not json', { code: 'SOMETHING_ELSE' }]) {
      for (const context of ['poll', 'op'] as const) {
        const result = classifyOutcome(response(401, body), context, SENTINEL_TOKEN);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe('unavailable');
          expect(result.code).not.toBe('token-invalid');
          expect(result.availability).not.toBe('dl.token-invalid');
          expect(result.retry).not.toBe('latch');
        }
      }
    }
  });

  it('never carries server error text or the token in a result', () => {
    const noisy = response(401, { error: `bad token ${SENTINEL_TOKEN}`, code: 'INVALID_INGEST_TOKEN' });
    const outcomes = [noisy, response(500, { error: SENTINEL_TOKEN }), response(403, { error: SENTINEL_TOKEN })];
    for (const outcome of outcomes) {
      const text = JSON.stringify(classifyOutcome(outcome, 'op', SENTINEL_TOKEN));
      expect(text).not.toContain(SENTINEL_TOKEN);
      expect(text).not.toContain('bad token');
    }
  });
});

describe('server code and the ingest token', () => {
  const CODE_SHAPED_TOKEN = 'SENTINELDATALINKTOKEN0000';

  it('drops a server code that contains a code-shaped token, on every status', () => {
    for (const status of [400, 401, 403, 404, 409, 500]) {
      for (const code of [CODE_SHAPED_TOKEN, `X_${CODE_SHAPED_TOKEN}_Y`]) {
        for (const context of ['poll', 'op'] as const) {
          const result = classifyOutcome(response(status, { error: 'x', code }), context, CODE_SHAPED_TOKEN);
          expect(result).toMatchObject({ ok: false, serverCode: null });
          expect(JSON.stringify(result)).not.toContain(CODE_SHAPED_TOKEN);
        }
      }
    }
  });

  it('keeps ordinary codes, and does not scrub a token shorter than 8 characters', () => {
    expect(classifyOutcome(fromFixture('err-409-no-dispatch-data'), 'op', CODE_SHAPED_TOKEN)).toMatchObject({
      code: 'no-dispatch-data', serverCode: 'NO_DISPATCH_DATA',
    });
    expect(classifyOutcome(response(500, { code: 'ABC_DEF' }), 'op', 'ABC')).toMatchObject({ serverCode: 'ABC_DEF' });
    expect(classifyOutcome(response(500, { code: 'ABC_DEF' }), 'op', null)).toMatchObject({ serverCode: 'ABC_DEF' });
  });
});

describe('classification uses the raw code; only the emitted code is checked against the token', () => {
  it('INGEST_TOKEN: 401 INVALID_INGEST_TOKEN is token-invalid and latches, with serverCode null', () => {
    for (const context of ['poll', 'op'] as const) {
      expect(classifyOutcome(fromFixture('err-401-invalid-token'), context, 'INGEST_TOKEN')).toEqual(
        fault('token-invalid', 'dl.token-invalid', 401, null, 'latch'),
      );
    }
  });

  it('DISPATCH_DATA: 409 NO_DISPATCH_DATA is no-dispatch-data, with serverCode null', () => {
    const outcome = fromFixture('err-409-no-dispatch-data');
    expect(classifyOutcome(outcome, 'op', 'DISPATCH_DATA')).toEqual(fault('no-dispatch-data', null, 409, null, 'none'));
    expect(classifyOutcome(outcome, 'poll', 'DISPATCH_DATA')).toEqual(
      fault('no-dispatch-data', 'dl.http-error', 409, null, 'backoff'),
    );
  });

  it.each([
    ['err-400-not-a-canned-message', 'A_CANNED_MESSAGE', 'not-a-canned-message'],
    ['err-400-unknown-canned-message', 'CANNED_MESSAGE', 'unknown-canned-message'],
    ['err-400-invalid-id', 'INVALID_ID', 'invalid-id'],
    ['err-404-flight-not-found', 'FLIGHT_NOT', 'flight-not-found'],
    ['err-404-leg-not-found', 'LEG_NOT_FOUND', 'leg-not-found'],
  ])('%s with token %s is still %s, with serverCode null', (name, token, code) => {
    expect(classifyOutcome(fromFixture(name), 'op', token)).toMatchObject({ ok: false, code, serverCode: null, retry: 'none' });
  });
});
