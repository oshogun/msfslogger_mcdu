// tests/simconnect-ordering.test.ts — pins the one ordering the frame loop's
// safety now rests on.
//
// navdata decides whether it may ask this connection for a facility list by
// comparing the protocol the client opened with against the name the simulator
// answered with. Asking with those two out of step does not fail politely: the
// list parser sizes each row by the protocol, runs off the end of its own
// buffer inside the library, and takes the connection's whole dispatch loop
// with it — measured, zero frames for as long as the connection lasts.
//
// So the name has to be there BEFORE the handle is handed out. It is: the
// connect path records it, publishes the state, and only then announces the
// handle. Nothing in the source pins that order, and the file it lives in is
// one that must not change for this, so the property is pinned from outside:
// what this asserts is the consequence — at the instant `onConnected` fires,
// the simulator's own name has already reached the published state, and the
// navdata gate would therefore see it.
//
// It fails safe if it is ever broken (an absent name blocks every list rather
// than letting a wrong one through), which is why this is a test rather than a
// guard, but silently losing the name would switch navdata off for everyone.
//
// No simulator, no socket: `open` is replaced by one that answers immediately.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectiveConfig } from '../src/config';
import { SIM_PROTOCOL_NAME } from '../src/config';
import { listParseIsSafe } from '../src/navdata-service';
import type { SimLinkSnapshot } from '../src/simconnect';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  applicationName: 'KittyHawk',
}));

vi.mock('node-simconnect', () => ({
  open: mocks.open,
  Protocol: { FSX_SP2: 4, KittyHawk: 5, SunRise: 6 },
  SimConnectDataType: { INT32: 1, FLOAT64: 4, STRING256: 8 },
  SimConnectPeriod: { SECOND: 3 },
  SimObjectType: { AIRCRAFT: 1 },
}));

const config: EffectiveConfig = {
  version: 1,
  serverUrl: 'http://127.0.0.1:3199',
  ingestToken: 'SENTINEL-ORDERING-TOKEN-0003',
  certPath: null,
  trafficEnabled: true,
  trafficRadiusM: 40000,
  sim: '2020',
  autoUplink: false,
  nodePath: null,
};

/** A handle that accepts everything the connect path does to it and does nothing. */
function fakeHandle(): Record<string, unknown> {
  return {
    addToDataDefinition: () => undefined,
    requestDataOnSimObject: () => undefined,
    requestDataOnSimObjectType: () => undefined,
    subscribeToSystemEvent: () => undefined,
    on: () => undefined,
    off: () => undefined,
    close: () => undefined,
  };
}

let link: { start(): void; stop(): void } | null = null;

beforeEach(() => {
  vi.resetModules();
  mocks.open.mockReset();
  mocks.applicationName = 'KittyHawk';
  mocks.open.mockImplementation(async () => ({
    recvOpen: {
      applicationName: mocks.applicationName,
      applicationVersionMajor: 11,
      applicationVersionMinor: 0,
    },
    handle: fakeHandle(),
  }));
});

afterEach(() => {
  link?.stop();
  link = null;
  vi.restoreAllMocks();
});

/** Connects once and reports what the published state said as the handle arrived. */
async function connectOnce(): Promise<{
  atConnected: SimLinkSnapshot | null;
  connectedFired: boolean;
}> {
  const { SimConnectLink } = await import('../src/simconnect');
  let published: SimLinkSnapshot | null = null;
  let atConnected: SimLinkSnapshot | null = null;
  let connectedFired = false;

  const instance = new SimConnectLink(config, {
    onLog: () => undefined,
    onSimState: (snapshot) => {
      published = snapshot;
    },
    onFrame: () => undefined,
    onIngestEvent: () => undefined,
    onPause: () => undefined,
    onTraffic: () => undefined,
    onConnected: () => {
      // The FIRST time the handle is handed out is the one that matters: that
      // is when navdata builds its session and decides what it may ask for.
      if (connectedFired) return;
      connectedFired = true;
      atConnected = published;
    },
    onDisconnected: () => undefined,
  });
  link = instance;
  instance.start();
  // The open resolves on a microtask; nothing here waits on a real socket.
  for (let i = 0; i < 20 && !connectedFired; i++) await Promise.resolve();
  return { atConnected, connectedFired };
}

describe('the name the simulator answered with', () => {
  it('has already reached the published state when the handle is handed out', async () => {
    const { atConnected, connectedFired } = await connectOnce();

    expect(connectedFired).toBe(true);
    expect(atConnected).not.toBeNull();
    expect(atConnected?.appName).toBe('KittyHawk');
    expect(atConnected?.state).toBe('sim.connected');
  });

  it('is the one a facility list is allowed to be parsed against', async () => {
    const { atConnected } = await connectOnce();

    // The consequence, stated the way navdata states it: with the name present
    // and the configured simulator matching, a list may be asked for.
    expect(listParseIsSafe(SIM_PROTOCOL_NAME[config.sim], atConnected?.appName ?? null)).toBe(true);

    // And if the name were ever to arrive after the handle instead of before
    // it, the gate would see null and refuse — navdata off, frames intact.
    expect(listParseIsSafe(SIM_PROTOCOL_NAME[config.sim], null)).toBe(false);
  });

  it('is whatever the simulator said, not what the client was configured for', async () => {
    mocks.applicationName = 'SunRise';
    const { atConnected } = await connectOnce();

    expect(atConnected?.appName).toBe('SunRise');
    // Configured for 2020, answered by a 2024 simulator: no list is parseable
    // on this connection, which is exactly what must be detectable here.
    expect(listParseIsSafe(SIM_PROTOCOL_NAME[config.sim], atConnected?.appName ?? null)).toBe(false);
  });
});
