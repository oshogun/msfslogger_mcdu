// tests/navdata-index-wiring.test.ts — the sidecar really does hand navdata an
// uplink, really does tell it what version it is, and really does pass on what
// the simulator answered with.
//
// All three are a line or two in one object literal, and all three fail
// silently: with no transport the sync posts nothing at all and looks merely
// idle; with no version the snapshot header announces `sidecarVersion:
// "unknown"` — the first thing anyone reads in a server log and the first thing
// to mislead them; and with the simulator's build left out the header names a
// simulator with no build, which reads like a simulator that did not say. So
// this drives the real entry point, with the real uplink and the real store,
// and watches what arrives.
//
// THE SERVER HERE IS A THROWAWAY LISTENER ON 127.0.0.1 ON AN EPHEMERAL PORT,
// started and stopped by the test. SimConnect is mocked: no simulator is
// touched, no real server is contacted, and the config lives in a temp
// directory so the store is created beside it and nowhere near the real one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SimConnectConnection } from 'node-simconnect';

import type { SimConnectCallbacks, SimLinkSnapshot } from '../src/simconnect';
import { openNavdataReader, type SnapshotHeaderLine } from '../src/navdata-export';
import { navdataDatabasePath } from '../src/navdata-store';
import { NAVDATA_SNAPSHOT_PATH, NAVDATA_STATE_PATH, type NavdataStateReport } from '../src/navdata-sync';
import {
  multipart,
  SENTINEL_TOKEN,
  snapshotLines,
  startNavdataServer,
  type NavdataScratchServer,
} from './helpers/navdata-scratch-server';
import { openFixtureStore, populate } from './helpers/navdata-fixture-store';
import { FakeFacilityConnection } from './helpers/fake-facility-connection';

const mocks = vi.hoisted(() => ({ callbacks: null as SimConnectCallbacks | null }));

vi.mock('../src/simconnect', () => ({
  SimConnectLink: class {
    constructor(_config: unknown, callbacks: SimConnectCallbacks) {
      mocks.callbacks = callbacks;
    }
    start = (): void => undefined;
    stop = (): void => undefined;
    setConfig = (): void => undefined;
  },
}));

let server: NavdataScratchServer;
let configDir: string;
let previousConfigEnv: string | undefined;
let stdin: EventEmitter;
let exitCode: typeof process.exitCode;
const states: NavdataStateReport[] = [];
const snapshots: SnapshotHeaderLine[] = [];

beforeEach(async () => {
  states.length = 0;
  snapshots.length = 0;
  server = await startNavdataServer({
    [`POST ${NAVDATA_STATE_PATH}`]: (request) => {
      states.push(JSON.parse(request.body.toString('utf8')) as NavdataStateReport);
      return { status: 204 };
    },
    [`POST ${NAVDATA_SNAPSHOT_PATH}`]: (request) => {
      const part = multipart(request)[0];
      const lines = snapshotLines(part);
      snapshots.push(lines[0] as SnapshotHeaderLine);
      const header = lines[0] as SnapshotHeaderLine;
      return {
        status: 200,
        body: { ok: true, snapshotId: header.snapshotId, rev: header.rev, counts: {}, appliedAt: 1 },
      };
    },
    'GET /api/status': () => ({ status: 401, body: { error: 'unauthenticated' } }),
  });

  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navdata-wiring-'));
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ serverUrl: server.baseUrl, ingestToken: SENTINEL_TOKEN, sim: '2020' }, null, 2),
  );
  previousConfigEnv = process.env.MSFSLOGGER_CONFIG;
  process.env.MSFSLOGGER_CONFIG = path.join(configDir, 'config.json');

  // A store with something in it, where the sidecar will look for one: an
  // empty store is deliberately never uploaded, so there would be no snapshot
  // to inspect.
  const seed = openFixtureStore(configDir);
  populate(seed);
  seed.close();

  vi.resetModules();
  exitCode = process.exitCode;
  stdin = new EventEmitter();
  mocks.callbacks = null;
  vi.spyOn(process.stdin, 'setEncoding').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'on').mockImplementation((event, listener) => {
    stdin.on(event, listener);
    return process.stdin;
  });
  vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await import('../src/index');
});

afterEach(async () => {
  stdin.emit('data', `${JSON.stringify({ v: 1, type: 'shutdown' })}\n`);
  // The store is only released when the shutdown reaches it, and an export
  // already in flight holds a reader of its own until it finishes. Waiting for
  // the directory to go is waiting for both, and keeps the sidecar's own
  // output captured until it has stopped writing.
  await waitFor(() => removed(configDir), 8000);
  process.exitCode = exitCode;
  if (previousConfigEnv === undefined) delete process.env.MSFSLOGGER_CONFIG;
  else process.env.MSFSLOGGER_CONFIG = previousConfigEnv;
  await server.close();
  // The probe timer can fire once more on its way out; the stdout capture
  // stays in place until it has, so a finished test prints nothing.
  await waitFor(() => false, 200);
  vi.restoreAllMocks();
  removed(configDir);
  // Longer than the waits inside it. The hook waits on something observable —
  // the store file being released — and vitest's default 5 s budget is below
  // the 8 s that wait is allowed, so a shutdown with a pass and an upload to
  // settle would be killed mid-teardown rather than timing out honestly.
}, 12000);

/** True once the directory is gone; a locked store file answers false. */
function removed(directory: string): boolean {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return !fs.existsSync(directory);
  } catch {
    return false;
  }
}

/** Real timers: the uplink, the store and the export are all real here. */
async function waitFor(done: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done() && Date.now() < until) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe('the sidecar hands navdata an uplink', () => {
  it('posts the navdata state to the configured server once the uplink starts', async () => {
    stdin.emit('data', `${JSON.stringify({ v: 1, type: 'start' })}\n`);
    await waitFor(() => states.length > 0);

    expect(states.length).toBeGreaterThan(0);
    expect(states[0]).toMatchObject({ v: 1 });
    expect(['nav.off', 'nav.ready', 'nav.bulk', 'nav.unavailable']).toContain(states[0].state);
    // The token reached the header and nothing else.
    const request = server.requests.find((entry) => entry.path === NAVDATA_STATE_PATH);
    expect(request?.headers['x-ingest-token']).toBe(SENTINEL_TOKEN);
    expect(request?.body.toString('utf8')).not.toContain(SENTINEL_TOKEN);
  });

  it('sends a snapshot whose header names this build, not "unknown"', async () => {
    stdin.emit('data', `${JSON.stringify({ v: 1, type: 'start' })}\n`);
    await waitFor(() => snapshots.length > 0);

    expect(snapshots.length).toBeGreaterThan(0);
    const header = snapshots[0];
    expect(header.kind).toBe('header');
    expect(header.sidecarVersion).not.toBe('unknown');
    expect(header.sidecarVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(header.schemaVersion).toBe(2);
    expect(header.simId).toBe('2020');
    expect(JSON.stringify(header)).not.toContain(SENTINEL_TOKEN);
  });

  it('passes on the name AND the build the simulator answered with', async () => {
    stdin.emit('data', `${JSON.stringify({ v: 1, type: 'start' })}\n`);
    await waitFor(() => states.length > 0);
    const callbacks = mocks.callbacks as SimConnectCallbacks;
    expect(callbacks).not.toBeNull();

    // The link records what recvOpen answered and only then announces the
    // connection, so by the time navdata is called both are there to be read.
    // A version that arrived after the announcement would be null here, and a
    // header naming a simulator with no build is the failure this pins.
    const connected: SimLinkSnapshot = {
      state: 'sim.connected',
      attempt: 0,
      nextRetryAt: null,
      retryDelayMs: null,
      protocol: 'KittyHawk',
      appName: 'KittyHawk',
      appVersion: '11.0',
      lastError: null,
    };
    callbacks.onSimState(connected);
    callbacks.onConnected?.(new FakeFacilityConnection() as unknown as SimConnectConnection);

    await waitFor(() => meta()?.simAppName !== null);
    expect(meta()).toMatchObject({ simAppName: 'KittyHawk', simAppVersion: '11.0' });

    // The fake handle answers no list, so the pass this connection started is
    // still waiting on one. A disconnect settles it as aborted, the way a real
    // one does, rather than leaving the store held until its idle timeout.
    callbacks.onDisconnected?.();
    // What the simulator said outlives the connection that said it: the export
    // that carries it happens long after.
    expect(meta()).toMatchObject({ simAppName: 'KittyHawk', simAppVersion: '11.0' });
  });

  /** The store as the exporter reads it, through a connection of its own. */
  function meta() {
    const reader = openNavdataReader(navdataDatabasePath(path.join(configDir, 'config.json')));
    try {
      return reader.meta();
    } finally {
      reader.close();
    }
  }
});
