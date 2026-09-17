// ── SimBrief routes: classifier and projections ───────────────────────────────
//
// GET /api/settings/simbrief and POST /api/planned-legs/simbrief authenticate
// like the datalink routes, but their answers mean different things, so they
// get their own classifier. Three differences shape it:
//
// - A SimBrief failure is about SimBrief or about this one request, never
//   about whether the ACARS routes work. Only a refused token touches the
//   shared datalink state; every other failure leaves it alone.
// - A 401 with no token scope is a server that predates these two routes.
//   Its datalink routes may be fine, so it must not read as "datalink
//   unavailable", and it must never latch like a bad token.
// - The server's SimBrief codes only count on the status they are documented
//   with. A known code on another status is a fault whose outcome is unknown.
//
// The projections forward as little as the CDU needs: whether a Pilot ID is
// saved (never the id), and the new leg's id, label and warning count (never
// the row, the warning texts or any error text).
//
// Pure: no I/O, no timers.

import {
  emittedServerCode,
  INVALID_INGEST_TOKEN,
  SERVER_CODE_PATTERN,
  type Classified,
  type DatalinkErrorCode,
  type HttpOutcome,
} from './datalink-classify';
import { scrubToken, type Projection } from './datalink-model';
import { isValidId } from './datalink-scope';
import type { DatalinkResults } from './protocol';
import { TLS_ERROR_CODES } from './status';

export const PREFILE_LABEL_MAX_UNITS = 96;
export const PREFILE_WARNING_COUNT_MAX = 999;

type Failure = Extract<Classified, { ok: false }>;

const SIMBRIEF_CODES: Readonly<Record<string, { status: number; code: DatalinkErrorCode }>> = {
  NO_USER_ID: { status: 400, code: 'simbrief-no-user-id' },
  UNKNOWN_USER: { status: 400, code: 'simbrief-unknown-user' },
  NO_PLAN: { status: 404, code: 'simbrief-no-plan' },
  TIMEOUT: { status: 504, code: 'simbrief-timeout' },
  NETWORK: { status: 502, code: 'simbrief-network' },
  BAD_STATUS: { status: 502, code: 'simbrief-bad-status' },
  BAD_BODY: { status: 502, code: 'simbrief-bad-body' },
  DB_ERROR: { status: 500, code: 'simbrief-db-error' },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The body's well-formed `code`, compared raw; the `error` text is never read. */
function rawServerCodeOf(bodyText: string | null): string | null {
  const parsed = parseJson(bodyText);
  if (!parsed.ok || !isPlainObject(parsed.value)) return null;
  const code = parsed.value.code;
  return typeof code === 'string' && SERVER_CODE_PATTERN.test(code) ? code : null;
}

/** Leaves the datalink availability axis as it is, and is never retried. */
function failure(code: DatalinkErrorCode, httpStatus: number | null, serverCode: string | null): Failure {
  return { ok: false, code, availability: null, httpStatus, serverCode, retry: 'none' };
}

/** `token` is the ingest token in use, only so it can be kept out of the emitted `serverCode`. */
export function classifySimbriefOutcome(outcome: HttpOutcome, token: string | null): Classified {
  if (outcome.kind === 'transport') {
    // A timeout carries a numeric code, so the name is checked first.
    if (outcome.errorName === 'TimeoutError') return failure('timeout', null, null);
    if (outcome.errorCode && (TLS_ERROR_CODES as readonly string[]).includes(outcome.errorCode)) {
      return failure('tls-error', null, null);
    }
    return failure('unreachable', null, null);
  }

  const status = outcome.status;
  if (outcome.bodyTooLarge) return failure('bad-response', status, null);

  if (status >= 200 && status <= 299) {
    const parsed = parseJson(outcome.bodyText);
    if (!parsed.ok) return failure('bad-response', status, null);
    return { ok: true, httpStatus: status, json: parsed.value };
  }

  const rawCode = rawServerCodeOf(outcome.bodyText);
  const emittedCode = emittedServerCode(rawCode, token);

  if (status === 401) {
    // The same token authenticates the datalink routes, so a refusal here
    // stops them too, exactly as it would from a datalink request.
    if (rawCode === INVALID_INGEST_TOKEN) {
      return {
        ok: false,
        code: 'token-invalid',
        availability: 'dl.token-invalid',
        httpStatus: status,
        serverCode: emittedCode,
        retry: 'latch',
      };
    }
    const scope = outcome.scopeHeader === null ? null : outcome.scopeHeader.trim().toLowerCase();
    if (scope === 'accepted') return failure('token-missing', status, emittedCode);
    return failure('simbrief-unavailable', status, emittedCode);
  }
  if (status === 403) return failure('rejected', status, emittedCode);

  if (rawCode !== null && Object.prototype.hasOwnProperty.call(SIMBRIEF_CODES, rawCode)) {
    const known = SIMBRIEF_CODES[rawCode];
    if (known.status === status) return failure(known.code, status, emittedCode);
  }

  return failure('http-error', status, emittedCode);
}

/** A saved Pilot ID reduces to one boolean here; the id itself goes no further. */
export function projectSimbriefSettings(body: unknown): Projection<DatalinkResults['simbrief-settings']> {
  if (!isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, 'simbrief_user_id')) {
    return { ok: false, detail: 'settings body has no simbrief_user_id' };
  }
  const value = body.simbrief_user_id;
  if (value === null) return { ok: true, result: { configured: false } };
  if (typeof value !== 'string') return { ok: false, detail: 'simbrief_user_id is neither null nor a string' };
  return { ok: true, result: { configured: value.trim().length > 0 } };
}

/**
 * Any 2xx whose body projects is a success; the status does not have to pair
 * with `result.status`, because the leg exists either way.
 */
export function projectSimbriefPrefile(
  body: unknown,
  httpStatus: number,
  token: string | null,
): Projection<DatalinkResults['simbrief-prefile']> {
  if (!isPlainObject(body) || !isPlainObject(body.result)) {
    return { ok: false, detail: 'prefile body has no result object' };
  }
  const result = body.result;
  if (result.status !== 'imported' && result.status !== 'duplicate') {
    return { ok: false, detail: 'prefile result status is neither imported nor duplicate' };
  }
  if (!isValidId(result.planned_leg_id)) return { ok: false, detail: 'prefile result has no planned leg id' };
  if (typeof result.label !== 'string') return { ok: false, detail: 'prefile result label is not a string' };
  return {
    ok: true,
    result: {
      status: result.status,
      plannedLegId: result.planned_leg_id,
      // Scrub first, then cap, so a token straddling the cap cannot leave a prefix behind.
      label: scrubToken(result.label, token).slice(0, PREFILE_LABEL_MAX_UNITS),
      warningCount: Array.isArray(result.warnings)
        ? Math.min(result.warnings.length, PREFILE_WARNING_COUNT_MAX)
        : 0,
      httpStatus,
    },
  };
}
