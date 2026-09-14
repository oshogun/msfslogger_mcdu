// tests/uplink.test.ts — tests src/uplink.ts.
//
// Everything here runs against throwaway servers bound to 127.0.0.1 on an
// ephemeral port (always above 3100, never the port the user's own server
// uses) and a self-signed certificate generated into a temp directory. Nothing
// touches the repo's certs/, the live server or any database.
//
// The two properties under test are the ones that decide what the panel says:
// a request result maps to exactly one backend-axis state, and no failure —
// 500, 401, refused connection, untrusted certificate — ever throws at the
// caller, because the caller is a SimConnect event handler that must not care.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';
import { Uplink } from '../src/uplink';
import type { EffectiveConfig } from '../src/config';

const TOKEN = 'PLACEHOLDER-TOKEN';

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function config(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    version: 1,
    serverUrl: 'http://127.0.0.1:3199',
    ingestToken: TOKEN,
    certPath: null,
    trafficEnabled: true,
    trafficRadiusM: 40000,
    sim: '2020',
    autoUplink: false,
    nodePath: null,
    ...overrides,
  };
}

function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function collect(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

describe('Uplink against a scratch HTTP server', () => {
  const captured: Captured[] = [];
  let server: http.Server;
  let port = 0;
  let status = 204;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: await collect(req),
      });
      res.statusCode = status;
      res.end();
    });
    port = await listen(server);
    expect(port).toBeGreaterThan(3100);
  });

  afterAll(() => {
    server.close();
  });

  function uplink(): Uplink {
    return new Uplink(config({ serverUrl: `http://127.0.0.1:${port}` }));
  }

  it('posts a frame with the ingest token and JSON content type', async () => {
    status = 204;
    captured.length = 0;
    const frame = {
      lat: 37.6,
      lon: -122.4,
      altitudeFt: 13.4,
      airspeedKnots: 0,
      groundSpeedKnots: 0,
      headingDeg: 271.3,
      verticalSpeedFpm: 0,
      onGround: true,
      simRunning: 2,
      aircraft: 'Cessna 172',
    };
    const result = await uplink().postFrame(frame);

    expect(result).toMatchObject({ ok: true, httpStatus: 204, state: 'net.ok' });
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('/api/ingest/frame');
    expect(captured[0].headers['x-ingest-token']).toBe(TOKEN);
    expect(captured[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(captured[0].body)).toEqual(frame);
  });

  it('posts an event to the event path', async () => {
    status = 204;
    captured.length = 0;
    const result = await uplink().postEvent({ type: 'connected' });
    expect(result.ok).toBe(true);
    expect(captured[0].url).toBe('/api/ingest/event');
    expect(JSON.parse(captured[0].body)).toEqual({ type: 'connected' });
  });

  it('wraps a traffic batch in an objects envelope', async () => {
    status = 204;
    captured.length = 0;
    const objects = [{ id: 7, lat: 1, lon: 2, altitudeFt: 3, headingDeg: 4, onGround: false }];
    await uplink().postTraffic(objects);
    expect(captured[0].url).toBe('/api/ingest/traffic');
    expect(JSON.parse(captured[0].body)).toEqual({ objects });
  });

  it('maps a 500 to net.http-error without throwing', async () => {
    status = 500;
    const result = await uplink().postFrame({});
    expect(result).toMatchObject({ ok: false, httpStatus: 500, state: 'net.http-error' });
  });

  it('maps a 401 to net.unauthorized', async () => {
    status = 401;
    const result = await uplink().postEvent({ type: 'connected' });
    expect(result).toMatchObject({ ok: false, httpStatus: 401, state: 'net.unauthorized' });
  });

  it('never quotes the token in a failure message', async () => {
    status = 500;
    const logged: string[] = [];
    const link = new Uplink(config({ serverUrl: `http://127.0.0.1:${port}` }), (_l, m) => logged.push(m));
    const result = await link.postFrame({});
    expect(result.ok).toBe(false);
    expect(`${logged.join(' ')} ${result.ok ? '' : result.message}`).not.toContain(TOKEN);
  });

  it('treats any probe response, including 401, as reachable', async () => {
    status = 401;
    captured.length = 0;
    const result = await uplink().probe();
    expect(result).toMatchObject({ ok: true, httpStatus: 401, state: 'net.standby' });
    expect(captured[0].method).toBe('GET');
    expect(captured[0].url).toBe('/api/status');
  });

  it('applies a changed serverUrl to the next request', async () => {
    status = 204;
    captured.length = 0;
    const link = new Uplink(config({ serverUrl: 'http://127.0.0.1:1' }));
    link.setConfig(config({ serverUrl: `http://127.0.0.1:${port}` }));
    const result = await link.postFrame({});
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
  });
});

describe('Uplink against a closed port', () => {
  let closedUrl = '';

  beforeAll(async () => {
    // Bind, learn the port, release it: nothing listens there afterwards, and
    // the port is an ephemeral one well above 3100.
    const probe = http.createServer();
    const port = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    closedUrl = `http://127.0.0.1:${port}`;
  });

  it('maps a refused connection to net.unreachable without throwing', async () => {
    const link = new Uplink(config({ serverUrl: closedUrl }));
    const result = await link.postFrame({});
    expect(result).toMatchObject({ ok: false, httpStatus: null, state: 'net.unreachable' });
    if (!result.ok) expect(result.code).toBe('ECONNREFUSED');
  });

  it('maps a refused probe the same way', async () => {
    const result = await new Uplink(config({ serverUrl: closedUrl })).probe();
    expect(result).toMatchObject({ ok: false, state: 'net.unreachable' });
    if (!result.ok) expect(result.code).toBe('ECONNREFUSED');
  });
});

describe('Uplink against a self-signed HTTPS server', () => {
  let dir = '';
  let certPath = '';
  let server: https.Server;
  let port = 0;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msfslogger-uplink-'));
    const keyPath = path.join(dir, 'key.pem');
    certPath = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });

    server = https.createServer(
      { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
      (_req, res) => {
        res.statusCode = 204;
        res.end();
      },
    );
    port = await listen(server);
  }, 20000);

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails as a certificate fault when the CA is not configured', async () => {
    const link = new Uplink(config({ serverUrl: `https://127.0.0.1:${port}`, certPath: null }));
    expect(link.hasCustomCa()).toBe(false);
    const result = await link.postFrame({});
    expect(result).toMatchObject({ ok: false, state: 'net.tls-error' });
    if (!result.ok) expect(result.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('succeeds when certPath names the PEM', async () => {
    const link = new Uplink(config({ serverUrl: `https://127.0.0.1:${port}`, certPath }));
    expect(link.hasCustomCa()).toBe(true);
    const result = await link.postFrame({});
    expect(result).toMatchObject({ ok: true, httpStatus: 204, state: 'net.ok' });
    await link.close();
  });

  it('picks up a certPath added by a config reload', async () => {
    const link = new Uplink(config({ serverUrl: `https://127.0.0.1:${port}`, certPath: null }));
    expect((await link.postFrame({})).ok).toBe(false);
    link.setConfig(config({ serverUrl: `https://127.0.0.1:${port}`, certPath }));
    expect((await link.postFrame({})).ok).toBe(true);
    await link.close();
  });

  it('still validates the hostname, so this is real TLS', async () => {
    // Same certificate, reached by a name its SAN does not cover.
    const link = new Uplink(config({ serverUrl: `https://localhost:${port}`, certPath }));
    const result = await link.postFrame({});
    expect(result).toMatchObject({ ok: false, state: 'net.tls-error' });
    await link.close();
  });
});
