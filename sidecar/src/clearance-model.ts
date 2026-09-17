// ── Clearance route: classifier and projection ────────────────────────────────
//
// POST /api/planned-legs/:id/acars-messages/clearance authenticates like the
// other planned-leg ACARS routes, but a clearance writes logbook rows the first
// time it is asked for, so its answers are read more strictly than a poll's:
//
// - Only a refused token touches the shared datalink state. Every other
//   failure is about this one request and leaves availability, the schedule,
//   the scope and the thread cache alone.
// - A 401 with no token scope is a server that predates the route. The rest
//   of the datalink may be fine, so it must not read as "datalink unavailable"
//   and must never latch like a bad token.
// - A 2xx is a success only when every field the CDU shows checks out. A body
//   that does not is reported as bad data, because the rows may exist and the
//   CDU must not print a squawk or an altitude it cannot vouch for.
//
// The projection forwards the structured clearance and nothing else: never the
// request or reply messages, their text, ids or payload, and never an error
// string.
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

export const CLEARANCE_ROUTE_MAX_UNITS = 4096;
export const CLEARANCE_ICAO_MAX_UNITS = 8;
export const CLEARANCE_ALTITUDE_MAX_FT = 99999;

const SQUAWK_PATTERN = /^[0-7]{4}$/;
const ICAO_PATTERN = new RegExp(`^[A-Z0-9]{1,${CLEARANCE_ICAO_MAX_UNITS}}$`);

type Failure = Extract<Classified, { ok: false }>;

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
export function classifyClearanceOutcome(outcome: HttpOutcome, token: string | null): Classified {
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
    // The same token authenticates every datalink route, so a refusal here
    // stops them all, exactly as it would from a datalink request.
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
    return failure('clearance-unavailable', status, emittedCode);
  }
  if (status === 403) return failure('rejected', status, emittedCode);

  // A known code only counts on the status it is documented with.
  if (status === 404 && rawCode === 'PLANNED_LEG_NOT_FOUND') return failure('leg-not-found', status, emittedCode);
  if (status === 409 && rawCode === 'NO_FLIGHT_PLAN') return failure('clearance-no-flight-plan', status, emittedCode);

  return failure('http-error', status, emittedCode);
}

/** null and blank read as null; anything else must be a short upper-case code once trimmed. */
function icaoOf(value: unknown, token: string | null): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const trimmed = scrubToken(value, token).trim();
  if (trimmed === '') return { ok: true, value: null };
  const upper = trimmed.toUpperCase();
  return ICAO_PATTERN.test(upper) ? { ok: true, value: upper } : { ok: false };
}

/**
 * Any 2xx whose body projects is a success; the status does not have to pair
 * with `created`, because the rows exist either way. The route is scrubbed
 * before its length is checked, and an over-long route fails rather than
 * being cut, so the CDU never shows a clearance with part of its route missing.
 */
export function projectClearance(
  body: unknown,
  httpStatus: number,
  requestedLegId: number,
  token: string | null,
): Projection<DatalinkResults['clearance']> {
  if (!isPlainObject(body)) return { ok: false, detail: 'clearance body is not an object' };
  if (!isValidId(body.planned_leg_id) || body.planned_leg_id !== requestedLegId) {
    return { ok: false, detail: 'clearance body names another planned leg' };
  }
  if (typeof body.created !== 'boolean') return { ok: false, detail: 'clearance created is not a boolean' };
  const request = body.request;
  if (!isPlainObject(request) || !isValidId(request.id)) {
    return { ok: false, detail: 'clearance request message has no id' };
  }
  const reply = body.reply;
  if (!isPlainObject(reply) || reply.correlation_id !== request.id) {
    return { ok: false, detail: 'clearance reply does not answer the request' };
  }
  const clearance = body.clearance;
  if (!isPlainObject(clearance) || clearance.v !== 1) {
    return { ok: false, detail: 'clearance details are missing or of another version' };
  }
  const squawk = clearance.squawk;
  if (typeof squawk !== 'string' || !SQUAWK_PATTERN.test(squawk)) {
    return { ok: false, detail: 'clearance squawk is not four octal digits' };
  }
  const altitude = clearance.initial_altitude_ft;
  if (
    typeof altitude !== 'number' ||
    !Number.isSafeInteger(altitude) ||
    altitude < 0 ||
    altitude > CLEARANCE_ALTITUDE_MAX_FT
  ) {
    return { ok: false, detail: 'clearance initial altitude is out of range' };
  }
  const departure = icaoOf(clearance.departure_icao, token);
  const destination = icaoOf(clearance.destination_icao, token);
  if (!departure.ok || !destination.ok) return { ok: false, detail: 'clearance airport is not an ICAO code' };

  let route: string | null = null;
  if (clearance.route !== null) {
    if (typeof clearance.route !== 'string') return { ok: false, detail: 'clearance route is not a string' };
    const scrubbed = scrubToken(clearance.route, token);
    if (scrubbed.trim() !== '') {
      if (scrubbed.length > CLEARANCE_ROUTE_MAX_UNITS) return { ok: false, detail: 'clearance route is too long' };
      route = scrubbed;
    }
  }

  return {
    ok: true,
    result: {
      plannedLegId: requestedLegId,
      created: body.created,
      departure: departure.value,
      destination: destination.value,
      route,
      initialAltitudeFt: altitude,
      squawk,
      httpStatus,
    },
  };
}
