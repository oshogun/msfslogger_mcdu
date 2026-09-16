// tests/helpers/datalink-scratch-server.ts — a throwaway HTTP server for the
// datalink tests.
//
// Listens on 127.0.0.1 on an ephemeral port, never a port a real server uses,
// and records every request it receives: method, path, lower-cased headers
// and body. Routes are keyed "<METHOD> <path>". Anything unlisted answers 599,
// so a test can assert that no unexpected request was made at all. A handler
// may return 'hang' to never answer, for timeout tests.

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
}

export type ScratchHandler = (req: RecordedRequest) => ScratchReply | 'hang';

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
      res.statusCode = reply.status;
      for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
      if (reply.body === undefined) {
        res.end();
      } else {
        if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
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
