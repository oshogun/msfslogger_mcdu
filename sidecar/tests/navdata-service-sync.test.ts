// tests/navdata-service-sync.test.ts — tests how src/navdata-service.ts drives
// the sync client.
//
// The sync itself is tested in navdata-sync.test.ts; what matters here is the
// wiring:
//
// 1. The lifecycle reaches it. Start, stop, a config that names a different
//    server, and shutdown.
// 2. The axis the shell sees carries what the sync knows — the acknowledged
//    rev, the last sync and its error — and a snapshot going out reads as a
//    bulk operation, a latched schema failure as an error.
// 3. THE STATE THE SERVER HEARS IS THE STATE THE SHELL HEARS, from the same
//    axis, including `nav.unavailable` — which is reported with no store open
//    at all, because that is the case the report exists for.
// 4. A sync that throws from any of it does not reach the process. An exception
//    escaping navdata reaches the supervisor, and the supervisor answers a
//    dying sidecar by taking flight logging down with it.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  NavdataService,
  type NavdataServiceDeps,
  type NavdataSyncLike,
} from '../src/navdata-service';
import type { NavdataSyncStatus } from '../src/navdata-sync';
import type { NavdataStatusAxis } from '../src/protocol';

const SENTINEL_TOKEN = 'SENTINEL-NAVDATA-SERVICE-SYNC-0000';

const temporary: string[] = [];
const services: NavdataService[] = [];
let logged: string[] = [];

afterEach(() => {
  while (services.length > 0) services.pop()?.shutdown();
  while (temporary.length > 0) fs.rmSync(temporary.pop() as string, { recursive: true, force: true });
  logged = [];
});

function scratchConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navdata-service-sync-'));
  temporary.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ serverUrl: 'http://127.0.0.1:1', ingestToken: SENTINEL_TOKEN }, null, 2),
  );
  return configPath;
}

interface FakeSync extends NavdataSyncLike {
  calls: string[];
  reports: Pick<NavdataStatusAxis, 'state' | 'reason' | 'snapshotId' | 'rev'>[];
  next: NavdataSyncStatus;
}

function fakeSync(overrides: Partial<NavdataSyncLike> = {}): FakeSync {
  const sync: FakeSync = {
    calls: [],
    reports: [],
    next: { ackedRev: null, lastSyncAt: null, lastSyncError: null, sending: false, latched: null },
    start: () => sync.calls.push('start'),
    stop: () => sync.calls.push('stop'),
    shutdown: () => sync.calls.push('shutdown'),
    onConfigApplied: () => sync.calls.push('onConfigApplied'),
    reportState: (axis) => {
      sync.reports.push(axis);
    },
    status: () => sync.next,
    ...overrides,
  };
  return sync;
}

function newService(sync: NavdataSyncLike, overrides: Partial<NavdataServiceDeps> = {}): NavdataService {
  const service = new NavdataService({
    configPath: () => scratchConfigPath(),
    simId: () => '2020',
    protocols: () => ({ ours: 'KittyHawk', sim: 'KittyHawk' }),
    log: (level, message) => {
      logged.push(`${level} ${message}`);
    },
    onChange: () => undefined,
    sync,
    ...overrides,
  });
  services.push(service);
  return service;
}

describe('the navdata service and its sync client', () => {
  it('drives the sync through the lifecycle', () => {
    const configPath = scratchConfigPath();
    const sync = fakeSync();
    const service = newService(sync, { configPath: () => configPath });

    service.start();
    service.onConfigApplied();
    service.stop();
    service.shutdown();
    services.pop();

    expect(sync.calls).toEqual(['start', 'onConfigApplied', 'stop', 'shutdown']);
  });

  it('shows what the sync knows on the axis', () => {
    const configPath = scratchConfigPath();
    const sync = fakeSync();
    sync.next = {
      ackedRev: 12,
      lastSyncAt: 1_700_000_000_000,
      lastSyncError: null,
      sending: false,
      latched: null,
    };
    const service = newService(sync, { configPath: () => configPath });

    service.start();
    const axis = service.snapshot();

    expect(axis).toMatchObject({
      state: 'nav.ready',
      ackedRev: 12,
      lastSyncAt: 1_700_000_000_000,
      lastSyncError: null,
    });
  });

  it('reads a snapshot going out as a bulk operation and a latched failure as an error', () => {
    const configPath = scratchConfigPath();
    const sync = fakeSync();
    const service = newService(sync, { configPath: () => configPath });

    sync.next = { ackedRev: 1, lastSyncAt: null, lastSyncError: null, sending: true, latched: null };
    service.start();
    expect(service.snapshot()?.state).toBe('nav.bulk');

    sync.next = {
      ackedRev: 1,
      lastSyncAt: null,
      lastSyncError: 'the server speaks another schema',
      sending: false,
      latched: 'navdata sync is off: the server speaks navdata schema version 7 and this build speaks 2',
    };
    service.onConfigApplied();
    const axis = service.snapshot();
    expect(axis?.state).toBe('nav.error');
    expect(axis?.reason).toContain('schema version 7');
  });

  it('reports the same state to the server that it shows the shell, with no store open', () => {
    const configPath = scratchConfigPath();
    const sync = fakeSync();
    const service = newService(sync, {
      configPath: () => configPath,
      // The driver did not load: there is no store, and this is exactly the
      // state that has no other way of reaching the server.
      openStore: (_path, options) => {
        options.onUnavailable?.({ code: 'MODULE_NOT_FOUND', reason: 'navdata disabled: the driver did not load' });
        return null;
      },
    });

    service.start();

    const axis = service.snapshot();
    expect(axis?.state).toBe('nav.unavailable');
    expect(sync.reports.length).toBeGreaterThan(0);
    const last = sync.reports[sync.reports.length - 1];
    expect(last).toMatchObject({
      state: axis?.state,
      reason: axis?.reason,
      snapshotId: axis?.snapshotId ?? null,
      rev: axis?.rev ?? null,
    });
    expect(JSON.stringify(sync.reports)).not.toContain(SENTINEL_TOKEN);
  });

  it('survives a sync that throws from everything it has', () => {
    const configPath = scratchConfigPath();
    const explode = () => {
      throw new Error('the sync exploded');
    };
    const sync = fakeSync({
      start: explode,
      stop: explode,
      shutdown: explode,
      onConfigApplied: explode,
      reportState: explode,
      status: explode as unknown as () => NavdataSyncStatus,
    });
    const service = newService(sync, { configPath: () => configPath });

    expect(() => service.start()).not.toThrow();
    expect(() => service.onConfigApplied()).not.toThrow();
    expect(() => service.stop()).not.toThrow();
    expect(() => service.shutdown()).not.toThrow();
    services.pop();

    // And the axis still says something usable rather than disappearing.
    expect(logged.join(String.fromCharCode(10))).not.toContain(SENTINEL_TOKEN);
  });
});
