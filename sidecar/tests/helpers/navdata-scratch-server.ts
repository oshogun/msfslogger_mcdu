// tests/helpers/navdata-scratch-server.ts — a throwaway HTTP server for the
// navdata sync tests.
//
// Listens on 127.0.0.1 on an ephemeral port, never a port a real server uses,
// and NEVER reaches the user's own server: every test that touches the network
// in this suite talks to one of these and to nothing else.
//
// Unlike the datalink's scratch server it keeps the raw body as a Buffer,
// because a snapshot upload is gzip inside multipart and would not survive
// being decoded as text. `multipart()` pulls the parts back out so a test can
// assert the field name the server distinguishes uploads by.

import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';

import type { EffectiveConfig } from '../../src/config';
import type { NavdataTransport } from '../../src/navdata-sync';

export const SENTINEL_TOKEN = 'SENTINEL-NAVDATA-SYNC-TOKEN-0000';

export interface RecordedNavdataRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface NavdataReply {
  status: number;
  headers?: Record<string, string>;
  /** A string is sent as-is; anything else is JSON-encoded. */
  body?: unknown;
}

export type NavdataHandler = (req: RecordedNavdataRequest) => NavdataReply;

export interface NavdataScratchServer {
  baseUrl: string;
  requests: RecordedNavdataRequest[];
  routes: Record<string, NavdataHandler>;
  close(): Promise<void>;
}

export async function startNavdataServer(
  routes: Record<string, NavdataHandler>,
): Promise<NavdataScratchServer> {
  const requests: RecordedNavdataRequest[] = [];
  const state = { routes };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedNavdataRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      const handler = state.routes[`${recorded.method} ${recorded.path}`];
      const reply = handler ? handler(recorded) : { status: 599, body: { error: 'scratch: unlisted' } };
      res.statusCode = reply.status;
      for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
      if (reply.body === undefined) {
        res.end();
        return;
      }
      if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
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
    set routes(next: Record<string, NavdataHandler>) {
      state.routes = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface MultipartPart {
  name: string | null;
  fileName: string | null;
  contentType: string | null;
  content: Buffer;
}

/** The parts of a multipart body, as the server's upload middleware would see them. */
export function multipart(request: RecordedNavdataRequest): MultipartPart[] {
  const contentType = String(request.headers['content-type'] ?? '');
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return [];
  const boundary = `--${(match[1] ?? match[2]).trim()}`;
  const parts: MultipartPart[] = [];

  let index = request.body.indexOf(boundary);
  while (index !== -1) {
    const start = index + boundary.length;
    if (request.body.slice(start, start + 2).toString('latin1') === '--') break;
    const next = request.body.indexOf(boundary, start);
    if (next === -1) break;
    // Between the boundary's CRLF and the closing CRLF before the next one.
    const section = request.body.slice(start + 2, next - 2);
    const split = section.indexOf('\r\n\r\n');
    const head = section.slice(0, split).toString('utf8');
    const content = section.slice(split + 4);
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1] ?? null,
      fileName: /filename="([^"]*)"/.exec(head)?.[1] ?? null,
      contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null,
      content,
    });
    index = next;
  }
  return parts;
}

/** The NDJSON lines a snapshot part carries, ungzipped. */
export function snapshotLines(part: MultipartPart): unknown[] {
  const text = zlib.gunzipSync(part.content).toString('utf8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

export function testConfig(serverUrl: string, token = SENTINEL_TOKEN): EffectiveConfig {
  return {
    version: 1,
    serverUrl,
    ingestToken: token,
    certPath: null,
    trafficEnabled: false,
    trafficRadiusM: 50000,
    sim: '2020',
    autoUplink: false,
    nodePath: null,
  };
}

/** The uplink's half of the contract, with no uplink and no CA. */
export function testTransport(config: EffectiveConfig): NavdataTransport {
  return {
    getConfig: () => config,
    dispatchInit: (init) => init as RequestInit,
  };
}
