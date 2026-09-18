// ── Datalink response classifier ──────────────────────────────────────────────
//
// Maps one HTTP attempt against the server's ACARS routes onto a datalink
// error code, an availability state and a retry rule. The datalink has its own
// availability axis: nothing here reads or writes the ingest/backend axis,
// because "the ACARS routes are unavailable" and "ingest is failing" are
// different problems with different fixes.
//
// The order of the checks is the contract. Three 401s mean three different
// things, and only one of them is the user's token being wrong:
//
//   - body code INVALID_INGEST_TOKEN: the token is wrong. Stop retrying until
//     the config is reloaded. The code is checked before the scope header.
//   - X-Ingest-Token-Scope: accepted, no code: the route takes the token but
//     none arrived, so something in between stripped the header.
//   - no scope header: the route is not in the token's scope. In practice that
//     is a server that predates the datalink routes; it recovers by itself
//     once the server is upgraded, so it must never latch like a bad token.
//
// Pure: no I/O, no timers. The only imports are constants.

import { SCRUB_MIN_TOKEN_LENGTH } from './datalink-model';
import { TLS_ERROR_CODES } from './status';

export type DatalinkStateId =
  | 'dl.idle'
  | 'dl.pending'
  | 'dl.ok'
  | 'dl.unreachable'
  | 'dl.tls-error'
  | 'dl.timeout'
  | 'dl.token-invalid'
  | 'dl.token-missing'
  | 'dl.unavailable'
  | 'dl.rejected'
  | 'dl.http-error'
  | 'dl.bad-response'
  | 'dl.no-config'
  // The last two are only ever synthesised by the shell.
  | 'dl.sidecar-outdated'
  | 'dl.sidecar-unavailable';

export type DatalinkErrorCode =
  // availability class: same meaning as the dl.* state with the same suffix
  | 'unreachable'
  | 'tls-error'
  | 'timeout'
  | 'token-invalid'
  | 'token-missing'
  | 'unavailable'
  | 'rejected'
  | 'http-error'
  | 'bad-response'
  | 'no-config'
  // semantic server answers
  | 'not-a-canned-message'
  | 'unknown-canned-message'
  | 'no-dispatch-data'
  | 'invalid-id'
  | 'flight-not-found'
  | 'leg-not-found'
  // SimBrief routes: the server's own SimBrief answers
  | 'simbrief-no-user-id'
  | 'simbrief-unknown-user'
  | 'simbrief-no-plan'
  | 'simbrief-timeout'
  | 'simbrief-network'
  | 'simbrief-bad-status'
  | 'simbrief-bad-body'
  | 'simbrief-db-error'
  // a 401 with no token scope on a SimBrief route: the server predates them
  | 'simbrief-unavailable'
  // sidecar or shell: a prefile is already in flight, nothing was sent
  | 'prefile-in-progress'
  // clearance route: 409 NO_FLIGHT_PLAN, the leg has no dispatch release
  | 'clearance-no-flight-plan'
  // a 401 with no token scope on the clearance route: the server predates it
  | 'clearance-unavailable'
  // sidecar or shell: a clearance is already in flight, nothing was sent
  | 'clearance-in-progress'
  // SayIntentions routes: the server's own answers about the pilot's key,
  // the flight-to-session link and the SayIntentions service behind it
  | 'si-no-api-key'
  | 'si-bad-api-key'
  | 'si-not-linked'
  | 'si-session-changed'
  | 'si-no-comms'
  | 'si-no-session'
  | 'si-no-clearance'
  | 'si-upstream-unreachable'
  | 'si-upstream-timeout'
  | 'si-upstream-error'
  | 'si-upstream-bad-body'
  // a 401 with no token scope on a SayIntentions route: the server predates them
  | 'sayintentions-unavailable'
  // sidecar or shell: one SayIntentions action is already in flight, nothing was sent
  | 'sayintentions-in-progress'
  // sidecar-local
  | 'bad-request'
  | 'stale-epoch'
  | 'no-thread'
  | 'too-large'
  // shell-local
  | 'shell-timeout'
  | 'busy'
  | 'sidecar-exited'
  | 'sidecar-outdated'
  | 'sidecar-unavailable'
  // webview-local
  | 'host-unsupported'
  | 'host-error';

/** What one request produced, before anything is interpreted. */
export type HttpOutcome =
  | {
      kind: 'response';
      status: number;
      scopeHeader: string | null;
      bodyText: string | null;
      bodyTooLarge: boolean;
    }
  | { kind: 'transport'; errorName: string | null; errorCode: string | null };

export type Classified =
  | { ok: true; httpStatus: number; json: unknown }
  | {
      ok: false;
      code: DatalinkErrorCode;
      /** null: the result leaves the availability axis as it is. */
      availability: DatalinkStateId | null;
      httpStatus: number | null;
      serverCode: string | null;
      retry: 'backoff' | 'latch' | 'none';
    };

/** 'poll' for the GETs a poll cycle makes; 'op' for a user-initiated request. */
export type ClassifyContext = 'poll' | 'op';

export const SERVER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const INVALID_INGEST_TOKEN = 'INVALID_INGEST_TOKEN';

function parseJson(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * The body's `code`, when it is a well-formed code. The `error` text is never
 * read. This raw value is what classification compares against; it is never
 * emitted as it is.
 */
function rawServerCodeOf(bodyText: string | null): string | null {
  const parsed = parseJson(bodyText);
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === 'string' && SERVER_CODE_PATTERN.test(code) ? code : null;
}

/**
 * The only way a server code becomes the `serverCode` that leaves this module
 * for states, responses, log lines and the inspector. A token made of
 * upper-case letters, digits and underscores is itself a well-formed code, so
 * an emitted code that contains the token is replaced by null.
 *
 * The check applies to the emitted value only. Classification uses the raw
 * code: a placeholder token such as INGEST_TOKEN is a substring of
 * INVALID_INGEST_TOKEN, and dropping the code before classifying would turn
 * "wrong token, stop retrying" into "datalink unavailable, keep retrying".
 */
export function emittedServerCode(rawCode: string | null, token: string | null): string | null {
  if (rawCode === null) return null;
  if (token && token.length >= SCRUB_MIN_TOKEN_LENGTH && rawCode.includes(token)) return null;
  return rawCode;
}

function fault(
  code: DatalinkErrorCode,
  availability: DatalinkStateId,
  httpStatus: number | null,
  emittedCode: string | null,
  retry: 'backoff' | 'latch' = 'backoff',
): Classified {
  return { ok: false, code, availability, httpStatus, serverCode: emittedCode, retry };
}

/**
 * A server answer about the request itself (a refused canned id, no dispatch
 * data, a missing flight). For a user action it says nothing about
 * availability. For a poll GET it means the scope went stale or the server
 * misbehaved, so the poll backs off and the next cycle re-resolves the scope.
 */
function semantic(
  code: DatalinkErrorCode,
  httpStatus: number,
  emittedCode: string | null,
  context: ClassifyContext,
): Classified {
  if (context === 'poll') return fault(code, 'dl.http-error', httpStatus, emittedCode);
  return { ok: false, code, availability: null, httpStatus, serverCode: emittedCode, retry: 'none' };
}

const SEMANTIC_CODES: Readonly<Record<string, { status: number; code: DatalinkErrorCode }>> = {
  NOT_A_CANNED_MESSAGE: { status: 400, code: 'not-a-canned-message' },
  UNKNOWN_CANNED_MESSAGE: { status: 400, code: 'unknown-canned-message' },
  INVALID_ID: { status: 400, code: 'invalid-id' },
  NO_DISPATCH_DATA: { status: 409, code: 'no-dispatch-data' },
  FLIGHT_NOT_FOUND: { status: 404, code: 'flight-not-found' },
  PLANNED_LEG_NOT_FOUND: { status: 404, code: 'leg-not-found' },
};

/** `token` is the ingest token in use, only so it can be kept out of the emitted `serverCode`. */
export function classifyOutcome(
  outcome: HttpOutcome,
  context: ClassifyContext,
  token: string | null,
): Classified {
  if (outcome.kind === 'transport') {
    // A timeout carries a numeric code, so the name has to be checked first or
    // it would read as "unreachable".
    if (outcome.errorName === 'TimeoutError') return fault('timeout', 'dl.timeout', null, null);
    if (outcome.errorCode && (TLS_ERROR_CODES as readonly string[]).includes(outcome.errorCode)) {
      return fault('tls-error', 'dl.tls-error', null, null);
    }
    return fault('unreachable', 'dl.unreachable', null, null);
  }

  const status = outcome.status;
  if (outcome.bodyTooLarge) return fault('bad-response', 'dl.bad-response', status, null);

  if (status >= 200 && status <= 299) {
    const parsed = parseJson(outcome.bodyText);
    if (!parsed.ok) return fault('bad-response', 'dl.bad-response', status, null);
    return { ok: true, httpStatus: status, json: parsed.value };
  }

  // Decide on the raw code; emit only the checked one.
  const rawCode = rawServerCodeOf(outcome.bodyText);
  const emittedCode = emittedServerCode(rawCode, token);

  if (status === 401) {
    if (rawCode === INVALID_INGEST_TOKEN) {
      return fault('token-invalid', 'dl.token-invalid', status, emittedCode, 'latch');
    }
    const scope = outcome.scopeHeader === null ? null : outcome.scopeHeader.trim().toLowerCase();
    if (scope === 'accepted') return fault('token-missing', 'dl.token-missing', status, emittedCode);
    return fault('unavailable', 'dl.unavailable', status, emittedCode);
  }
  if (status === 403) return fault('rejected', 'dl.rejected', status, emittedCode);

  if (rawCode !== null && Object.prototype.hasOwnProperty.call(SEMANTIC_CODES, rawCode)) {
    const known = SEMANTIC_CODES[rawCode];
    if (known.status === status) return semantic(known.code, status, emittedCode, context);
  }

  return fault('http-error', 'dl.http-error', status, emittedCode);
}
