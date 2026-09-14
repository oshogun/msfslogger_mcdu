// ── Uplink — the HTTP half ────────────────────────────────────────────────────
//
// Everything this process sends to the msfslogger server goes through here:
// the ingest posts the CLI agent used to make, plus a reachability probe that
// exists because when the sim link is down there are no frames, and an axis
// with no evidence would freeze on a stale value.
//
// Two rules shape the code below.
//
// 1. Nothing here throws at its caller. A refused connection, a 500 and an
//    untrusted certificate are all results, because a failed post must never
//    reach the SimConnect event handler that made it.
// 2. The server's certificate is usually self-signed, and the user may change
//    the PEM path from the UI while the process runs. NODE_EXTRA_CA_CERTS is
//    read once at process start and so cannot express that; an undici Agent
//    carrying the CA, passed per request as fetch's dispatcher, can. This is
//    still real TLS — the hostname is still checked, and certificate
//    verification is never switched off, here or anywhere else in this
//    codebase. Trusting one more CA is the whole of the mechanism.

import * as fs from 'fs';
import { Agent } from 'undici';
import type { EffectiveConfig } from './config';
import {
  backendStateFromErrorCode,
  backendStateFromStatus,
  type BackendStateId,
} from './status';

export type UplinkResult =
  | { ok: true; httpStatus: number; state: BackendStateId; message: string | null }
  | {
      ok: false;
      httpStatus: number | null;
      code: string | null;
      state: BackendStateId;
      message: string;
    };

export type LogSink = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

const FRAME_PATH = '/api/ingest/frame';
const EVENT_PATH = '/api/ingest/event';
const TRAFFIC_PATH = '/api/ingest/traffic';
const PROBE_PATH = '/api/status';

/** Node wraps transport and TLS failures a couple of layers deep. */
function errorCodeOf(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function messageOf(err: unknown): string {
  const code = errorCodeOf(err);
  if (code) return code;
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

export class Uplink {
  private config: EffectiveConfig;
  private dispatcher: Agent | null = null;
  private readonly log: LogSink;

  constructor(config: EffectiveConfig, log: LogSink = () => {}) {
    this.config = config;
    this.log = log;
    this.rebuildDispatcher();
  }

  /** Applied to the next request; no reconnect, no restart, no re-exec. */
  setConfig(config: EffectiveConfig): void {
    const certChanged = config.certPath !== this.config.certPath;
    this.config = config;
    if (certChanged) this.rebuildDispatcher();
  }

  getConfig(): EffectiveConfig {
    return this.config;
  }

  /** True when requests carry a custom CA rather than system trust alone. */
  hasCustomCa(): boolean {
    return this.dispatcher !== null;
  }

  async close(): Promise<void> {
    const dispatcher = this.dispatcher;
    this.dispatcher = null;
    if (dispatcher) await dispatcher.close().catch(() => undefined);
  }

  private rebuildDispatcher(): void {
    const previous = this.dispatcher;
    this.dispatcher = null;
    if (previous) void previous.close().catch(() => undefined);

    const certPath = this.config.certPath;
    if (!certPath) return;

    try {
      // Read once per config load, not once per request.
      const pem = fs.readFileSync(certPath, 'utf8');
      this.dispatcher = new Agent({ connect: { ca: pem } });
    } catch (err) {
      // Validation already rejects an unreadable certPath, so getting here
      // means the file disappeared under us. Fall back to system trust: the
      // request then fails as a certificate error, which is the honest answer.
      this.log('warn', `Could not read certPath (${messageOf(err)}) — using system trust only`);
    }
  }

  private requestInit(init: Record<string, unknown>): RequestInit {
    // `dispatcher` is undici's own extension to fetch's init, which the
    // ambient RequestInit type does not name.
    return (this.dispatcher ? { ...init, dispatcher: this.dispatcher } : init) as RequestInit;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-ingest-token': this.config.ingestToken,
    };
  }

  /** POSTs one JSON body. Resolves with a result; never rejects. */
  async postJson(path: string, body: unknown): Promise<UplinkResult> {
    const url = `${this.config.serverUrl}${path}`;
    try {
      const res = await fetch(
        url,
        this.requestInit({
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        }),
      );
      if (!res.ok) {
        this.log('warn', `Server responded ${res.status} for ${path}`);
        return {
          ok: false,
          httpStatus: res.status,
          code: null,
          state: backendStateFromStatus(res.status),
          message: `HTTP ${res.status} from ${path}`,
        };
      }
      return { ok: true, httpStatus: res.status, state: 'net.ok', message: null };
    } catch (err) {
      const code = errorCodeOf(err);
      const state = backendStateFromErrorCode(code ?? undefined);
      const message = `${state === 'net.tls-error' ? 'TLS failure' : 'Failed to reach server'} (${messageOf(err)})`;
      this.log('warn', message);
      return { ok: false, httpStatus: null, code, state, message };
    }
  }

  postFrame(frame: unknown): Promise<UplinkResult> {
    return this.postJson(FRAME_PATH, frame);
  }

  postEvent(body: unknown): Promise<UplinkResult> {
    return this.postJson(EVENT_PATH, body);
  }

  /** Traffic failures are advisory: they never claim the backend axis. */
  postTraffic(objects: unknown[]): Promise<UplinkResult> {
    return this.postJson(TRAFFIC_PATH, { objects });
  }

  /**
   * Reachability only. Any HTTP answer — including the 401 this endpoint gives
   * an unauthenticated caller — means the server is up, so the probe never
   * produces net.ok, net.unauthorized or net.http-error: those are claims
   * about ingest, and only an ingest response may make them.
   */
  async probe(): Promise<UplinkResult> {
    const url = `${this.config.serverUrl}${PROBE_PATH}`;
    try {
      const res = await fetch(url, this.requestInit({ method: 'GET' }));
      return { ok: true, httpStatus: res.status, state: 'net.standby', message: null };
    } catch (err) {
      const code = errorCodeOf(err);
      const state = backendStateFromErrorCode(code ?? undefined);
      return {
        ok: false,
        httpStatus: null,
        code,
        state,
        message: `Reachability probe failed (${messageOf(err)})`,
      };
    }
  }
}

export const UPLINK_PATHS = {
  frame: FRAME_PATH,
  event: EVENT_PATH,
  traffic: TRAFFIC_PATH,
  probe: PROBE_PATH,
} as const;
