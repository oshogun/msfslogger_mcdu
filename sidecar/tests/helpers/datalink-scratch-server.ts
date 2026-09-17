// tests/helpers/datalink-scratch-server.ts — a throwaway HTTP server for the
// datalink tests.
//
// Listens on 127.0.0.1 on an ephemeral port, never a port a real server uses,
// and records every request it receives: method, path, lower-cased headers
// and body. Routes are keyed "<METHOD> <path>". Anything unlisted answers 599,
// so a test can assert that no unexpected request was made at all. A handler
// may return 'hang' to never answer, for timeout tests, { destroy: true } to
// reset the connection without answering, or a reply with `delayMs` to answer
// late.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type { EffectiveConfig } from '../../src/config';

export const SENTINEL_TOKEN = 'SENTINEL-DATALINK-TOKEN-0000';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface ScratchReply {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent as-is; anything else is JSON-encoded. */
  body?: unknown;
  /** Answer this many milliseconds after the request arrived. */
  delayMs?: number;
}

export type ScratchHandler = (req: RecordedRequest) => ScratchReply | 'hang' | { destroy: true };

export interface ScratchServer {
  baseUrl: string;
  requests: RecordedRequest[];
  routes: Record<string, ScratchHandler>;
  close(): Promise<void>;
}

export async function startScratchServer(routes: Record<string, ScratchHandler>): Promise<ScratchServer> {
  const requests: RecordedRequest[] = [];
  const hanging: http.ServerResponse[] = [];
  const state = { routes };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const handler = state.routes[`${recorded.method} ${recorded.path}`];
      const reply = handler ? handler(recorded) : { status: 599, body: { error: 'scratch: unlisted' } };
      if (reply === 'hang') {
        hanging.push(res);
        return;
      }
      if ('destroy' in reply) {
        req.socket.destroy();
        return;
      }
      const answer = () => {
        if (res.destroyed) return;
        res.statusCode = reply.status;
        for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
        if (reply.body === undefined) {
          res.end();
        } else {
          if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        }
      };
      if (reply.delayMs !== undefined) {
        hanging.push(res);
        setTimeout(answer, reply.delayMs);
      } else {
        answer();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    get routes() {
      return state.routes;
    },
    set routes(next: Record<string, ScratchHandler>) {
      state.routes = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of hanging) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A port that was just listening and is now closed: connecting to it is refused. */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface Fixture {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

export function fixture(name: string): Fixture {
  const file = path.join(__dirname, '..', 'fixtures', 'datalink', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
}

export const SIMBRIEF_SENTINEL_TOKEN = 'SENTINEL-SIMBRIEF-TOKEN-0000';
/** Upper-case letters and digits only, so it is itself a well-formed server code. */
export const SIMBRIEF_CODE_TOKEN = 'SENTINELSIMBRIEFTOKEN0000';

/** A SimBrief server sample: what was sent, what came back, and what it must classify as. */
export interface SimbriefFixture extends Fixture {
  _sample: string;
  /** Replaces the sentinel token as the configured token, for this sample only. */
  configToken?: string;
  expect: {
    ok: boolean;
    code?: string;
    httpStatus?: number;
    serverCode?: string | null;
    latch?: boolean;
    override?: string;
    result?: Record<string, unknown>;
  };
}

const SIMBRIEF_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'simbrief');

export function simbriefFixture(name: string): SimbriefFixture {
  return JSON.parse(fs.readFileSync(path.join(SIMBRIEF_FIXTURE_DIR, `${name}.json`), 'utf8')) as SimbriefFixture;
}

/** Every SimBrief server sample, by name; the local transport outcomes are not among them. */
export function simbriefFixtureNames(): string[] {
  return fs
    .readdirSync(SIMBRIEF_FIXTURE_DIR)
    .filter((file) => file.endsWith('.json') && file !== 'local-outcomes.json')
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

export function simbriefReply(name: string): ScratchHandler {
  const { response } = simbriefFixture(name);
  return () => ({ status: response.status, headers: response.headers, body: response.body });
}

/** The fixture's response, served as recorded. */
export function reply(name: string): ScratchHandler {
  const { response } = fixture(name);
  return () => ({ status: response.status, headers: response.headers, body: response.body });
}

export function scratchConfig(serverUrl: string, overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    version: 1,
    serverUrl,
    ingestToken: SENTINEL_TOKEN,
    certPath: null,
    trafficEnabled: true,
    trafficRadiusM: 40000,
    sim: '2020',
    autoUplink: false,
    nodePath: null,
    ...overrides,
  };
}
