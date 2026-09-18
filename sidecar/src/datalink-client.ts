// ── Datalink HTTP client ──────────────────────────────────────────────────────
//
// The only datalink code that talks to the network. It can build exactly
// twenty requests, one per server route in the table below, and nothing
// else: paths are assembled from validated integer ids, so no user text, query
// string or trailing slash can reach a URL. The two SimBrief routes take no
// parameter at all: the prefile POST has no body, so it can never ask the
// server to import a duplicate plan. The clearance POST has no body either;
// the leg id in its path is the whole request.
//
// The one query string in the table is part of a literal template
// (`si-link-now`), not composed from a value: "link from now" and "link from
// the session start" are two route keys, so nothing builds a query string.
//
// What the server's token check expects shapes the rest:
//
// - The token travels in `x-ingest-token` and nowhere else. No Origin, no
//   Cookie, no credentials: the server rejects a cross-origin-looking request
//   with 403, and Node's fetch adds neither header on its own.
// - Redirects are not followed. A 3xx is a fault, so the token is never
//   replayed to wherever a redirect points.
// - One timeout covers connecting and reading the body, and every body is read
//   through a byte cap, because the thread routes have no pagination.
// - Certificate trust is the uplink's: the same CA dispatcher, borrowed per
//   request, with verification never disabled.
//
// Like the uplink, this never throws at its caller. Every attempt resolves to
// an HttpOutcome for the classifier.

import type { EffectiveConfig } from './config';
import type { HttpOutcome } from './datalink-classify';
import { isValidId } from './datalink-scope';
import { CANNED_ID_PATTERN, ICAO_PATTERN } from './protocol';

export const DATALINK_HTTP_TIMEOUT_MS = 8000;
// The server gives SimBrief 20 s before answering 504 itself. The extra
// seconds cover the port forward and queueing, so a slow SimBrief comes back
// as the server's own answer rather than as an unknown outcome here.
export const SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS = 25000;
// Three of the SayIntentions routes reach SayIntentions itself through the
// server, which answers 504 UPSTREAM_TIMEOUT when that takes too long. With the
// default 8 s our own timer would fire first and turn the server's knowable
// answer into an unknown outcome, which for a write is the worst answer there
// is. 20 s is the estimated upstream budget; the extra seconds are the port
// forward and queueing.
export const SAYINTENTIONS_HTTP_TIMEOUT_MS = 20000;
export const DATALINK_THREAD_BODY_MAX_BYTES = 16 * 1024 * 1024;
export const DATALINK_OTHER_BODY_MAX_BYTES = 1024 * 1024;
/** A successful prefile answers with the whole planned-leg row. */
export const SIMBRIEF_PREFILE_BODY_MAX_BYTES = 16 * 1024 * 1024;

export type DatalinkRoute =
  | { key: 'status' }
  | { key: 'canned-list' }
  | { key: 'ground-session-current' }
  | { key: 'flight-thread'; id: number }
  | { key: 'leg-thread'; id: number }
  | { key: 'flight-send'; id: number; cannedId: string }
  | { key: 'leg-send'; id: number; cannedId: string }
  | { key: 'flight-wx'; id: number; icao: string }
  | { key: 'leg-wx'; id: number; icao: string }
  | { key: 'leg-loadsheet'; id: number }
  | { key: 'leg-clearance'; id: number }
  | { key: 'simbrief-settings' }
  | { key: 'simbrief-prefile' }
  | { key: 'si-settings' }
  | { key: 'si-link-status'; id: number }
  | { key: 'si-link'; id: number }
  | { key: 'si-link-now'; id: number }
  | { key: 'si-unlink'; id: number }
  | { key: 'si-import'; id: number }
  | { key: 'si-pdc'; id: number };

export type DatalinkRouteKey = DatalinkRoute['key'];

export type DatalinkMethod = 'GET' | 'POST' | 'DELETE';

export interface BuiltRequest {
  method: DatalinkMethod;
  path: string;
  /** The path with `:id` in place of the number: the only form that is logged. */
  template: string;
  body: string | null;
  maxBodyBytes: number;
}

/** What the client needs from the uplink: its current config and its CA dispatcher. */
export interface DatalinkTransport {
  getConfig(): EffectiveConfig;
  dispatchInit(init: Record<string, unknown>): RequestInit;
}

export interface DatalinkClientOptions {
  /** Every route except the SimBrief prefile and the three upstream SayIntentions ones. */
  timeoutMs?: number;
  /** The SimBrief prefile only. */
  prefileTimeoutMs?: number;
  /** The SayIntentions routes that reach SayIntentions through the server. */
  sayintentionsTimeoutMs?: number;
  /** Overrides every body cap; tests use it to exercise the cap cheaply. */
  maxBodyBytes?: number;
}

/**
 * The routes whose answer waits on SayIntentions. The link status GET, the
 * settings GET and the unlink DELETE are the server's own database and keep the
 * default.
 */
const SAYINTENTIONS_UPSTREAM_KEYS: readonly DatalinkRouteKey[] = ['si-link', 'si-link-now', 'si-import', 'si-pdc'];

/** The timeout one attempt on `key` uses. Nothing else picks a timeout. */
export function httpTimeoutMs(
  key: DatalinkRouteKey,
  options: Pick<DatalinkClientOptions, 'timeoutMs' | 'prefileTimeoutMs' | 'sayintentionsTimeoutMs'>,
): number {
  if (key === 'simbrief-prefile') return options.prefileTimeoutMs ?? SIMBRIEF_PREFILE_HTTP_TIMEOUT_MS;
  if (SAYINTENTIONS_UPSTREAM_KEYS.includes(key)) {
    return options.sayintentionsTimeoutMs ?? SAYINTENTIONS_HTTP_TIMEOUT_MS;
  }
  return options.timeoutMs ?? DATALINK_HTTP_TIMEOUT_MS;
}

const ROUTE_TABLE: Readonly<Record<DatalinkRouteKey, { method: DatalinkMethod; template: string }>> = {
  status: { method: 'GET', template: '/api/status' },
  'canned-list': { method: 'GET', template: '/api/acars/canned-messages' },
  'flight-thread': { method: 'GET', template: '/api/flights/:id/acars-messages' },
  'flight-send': { method: 'POST', template: '/api/flights/:id/acars-messages' },
  'flight-wx': { method: 'POST', template: '/api/flights/:id/acars-messages/wx' },
  'leg-thread': { method: 'GET', template: '/api/planned-legs/:id/acars-messages' },
  'leg-send': { method: 'POST', template: '/api/planned-legs/:id/acars-messages' },
  'leg-wx': { method: 'POST', template: '/api/planned-legs/:id/acars-messages/wx' },
  'leg-loadsheet': { method: 'POST', template: '/api/planned-legs/:id/acars-messages/loadsheet' },
  'leg-clearance': { method: 'POST', template: '/api/planned-legs/:id/acars-messages/clearance' },
  'ground-session-current': { method: 'GET', template: '/api/ground-sessions/current' },
  'simbrief-settings': { method: 'GET', template: '/api/settings/simbrief' },
  'simbrief-prefile': { method: 'POST', template: '/api/planned-legs/simbrief' },
  'si-settings': { method: 'GET', template: '/api/settings/sayintentions' },
  'si-link-status': { method: 'GET', template: '/api/flights/:id/sayintentions/link' },
  'si-link': { method: 'POST', template: '/api/flights/:id/sayintentions/link' },
  'si-link-now': { method: 'POST', template: '/api/flights/:id/sayintentions/link?from=now' },
  'si-unlink': { method: 'DELETE', template: '/api/flights/:id/sayintentions/link' },
  'si-import': { method: 'POST', template: '/api/flights/:id/sayintentions/import' },
  'si-pdc': { method: 'POST', template: '/api/planned-legs/:id/sayintentions/clearance' },
};

export function routeTemplate(key: DatalinkRouteKey): string {
  const entry = ROUTE_TABLE[key];
  return `${entry.method} ${entry.template}`;
}

/**
 * The request for a route, or null when a parameter is out of contract. The
 * only bodies that can exist are `{"canned_id"}` and `{"icao"}`.
 */
export function buildRequest(route: DatalinkRoute): BuiltRequest | null {
  const { method, template } = ROUTE_TABLE[route.key];
  let path = template;
  let body: string | null = null;

  if ('id' in route) {
    if (!isValidId(route.id)) return null;
    path = template.replace(':id', String(route.id));
  }
  if (route.key === 'flight-send' || route.key === 'leg-send') {
    if (typeof route.cannedId !== 'string' || !CANNED_ID_PATTERN.test(route.cannedId)) return null;
    body = JSON.stringify({ canned_id: route.cannedId });
  }
  if (route.key === 'flight-wx' || route.key === 'leg-wx') {
    if (typeof route.icao !== 'string' || !ICAO_PATTERN.test(route.icao)) return null;
    body = JSON.stringify({ icao: route.icao });
  }

  const threadRoute = route.key === 'flight-thread' || route.key === 'leg-thread';
  let maxBodyBytes = threadRoute ? DATALINK_THREAD_BODY_MAX_BYTES : DATALINK_OTHER_BODY_MAX_BYTES;
  if (route.key === 'simbrief-prefile') maxBodyBytes = SIMBRIEF_PREFILE_BODY_MAX_BYTES;
  return { method, path, template, body, maxBodyBytes };
}

/** Node nests the useful code a few `cause` levels down; a timeout's code is numeric and skipped. */
function stringCodeOf(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function errorNameOf(err: unknown): string | null {
  const causeName = (err as { cause?: { name?: unknown } } | null)?.cause?.name;
  if (causeName === 'TimeoutError') return causeName;
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : null;
}

async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bodyText: string | null; bodyTooLarge: boolean }> {
  if (!res.body) return { bodyText: '', bodyTooLarge: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { bodyText: null, bodyTooLarge: true };
    }
    chunks.push(value);
  }
  return { bodyText: Buffer.concat(chunks).toString('utf8'), bodyTooLarge: false };
}

export class DatalinkClient {
  private readonly transport: () => DatalinkTransport | null;
  private readonly options: DatalinkClientOptions;
  private readonly maxBodyBytes: number | null;

  constructor(transport: () => DatalinkTransport | null, options: DatalinkClientOptions = {}) {
    this.transport = transport;
    this.options = { ...options };
    this.maxBodyBytes = options.maxBodyBytes ?? null;
  }

  /**
   * One attempt. `abort` lets the owner cancel in-flight requests at shutdown;
   * that cancellation is reported as a timeout, and the owner never emits it.
   */
  async request(route: DatalinkRoute, abort?: AbortSignal): Promise<HttpOutcome> {
    const built = buildRequest(route);
    const transport = this.transport();
    // Neither can happen through the protocol decoder, which validates params
    // and is only reached with a config. Nothing is sent either way.
    if (!built) return { kind: 'transport', errorName: 'InvalidRoute', errorCode: null };
    if (!transport) return { kind: 'transport', errorName: 'NoConfig', errorCode: null };

    const config = transport.getConfig();
    const headers: Record<string, string> = {
      'x-ingest-token': config.ingestToken,
      accept: 'application/json',
    };
    if (built.body !== null) headers['content-type'] = 'application/json';

    const timeout = AbortSignal.timeout(httpTimeoutMs(route.key, this.options));
    const signal = abort ? AbortSignal.any([timeout, abort]) : timeout;
    const init: Record<string, unknown> = {
      method: built.method,
      headers,
      redirect: 'manual',
      signal,
    };
    if (built.body !== null) init.body = built.body;

    try {
      const res = await fetch(`${config.serverUrl}${built.path}`, transport.dispatchInit(init));
      const { bodyText, bodyTooLarge } = await readCapped(res, this.maxBodyBytes ?? built.maxBodyBytes);
      return {
        kind: 'response',
        status: res.status,
        scopeHeader: res.headers.get('x-ingest-token-scope'),
        bodyText,
        bodyTooLarge,
      };
    } catch (err) {
      if (abort?.aborted) return { kind: 'transport', errorName: 'TimeoutError', errorCode: null };
      return { kind: 'transport', errorName: errorNameOf(err), errorCode: stringCodeOf(err) };
    }
  }
}
