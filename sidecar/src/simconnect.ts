// ── SimConnect link ───────────────────────────────────────────────────────────
//
// The SimConnect half of the old CLI agent, unchanged in behaviour: the same
// ten flight-data variables in the same registration order, the same 1 Hz
// request, the same system events, the same 2 s traffic sweep throttle and the
// same capped-exponential reconnect ladder with its single-pending-reconnect
// guard. What changed is where the results go: instead of printing and posting
// directly, this class reports through callbacks, so the entrypoint owns the
// status snapshot and the uplink.
//
// This is the only file that imports node-simconnect. On a machine with no
// simulator, open() rejects with ECONNREFUSED 127.0.0.1:2048 and everything
// below the connect — the backoff, the retry, the status reporting — still
// runs for real.

import {
  open,
  Protocol,
  SimConnectDataType,
  SimConnectPeriod,
  SimObjectType,
  type SimConnectConnection,
} from 'node-simconnect';
import { SIM_PROTOCOL_NAME, type EffectiveConfig } from './config';
import {
  describePause,
  nextReconnectDelayMs,
  pauseStateFromFlags,
  type PauseStateId,
  type SimStateId,
} from './status';
import { buildTrafficBatch, type TrafficObject, type TrafficRecord } from './traffic';

const DEF_FLIGHT_DATA = 0;
const REQ_FLIGHT_DATA = 0;

// AI traffic — distinct data definition and request ids.
const DEF_TRAFFIC = 1;
const REQ_TRAFFIC = 1;
const TRAFFIC_SWEEP_MS = 2000;

const EVT_PAUSED = 1;
const EVT_UNPAUSED = 2;
const EVT_CRASHED = 3;
const EVT_FLIGHT_LOADED = 4;
const EVT_PAUSE_EX1 = 5;

const OBJECT_USER = 0;

const APP_NAME = 'msfslogger-sidecar';

export interface FlightFrame {
  lat: number;
  lon: number;
  altitudeFt: number;
  airspeedKnots: number;
  groundSpeedKnots: number;
  headingDeg: number;
  verticalSpeedFpm: number;
  onGround: boolean;
  simRunning: number;
  aircraft: string;
}

export interface SimLinkSnapshot {
  state: SimStateId;
  attempt: number;
  nextRetryAt: number | null;
  retryDelayMs: number | null;
  protocol: string;
  appName: string | null;
  appVersion: string | null;
  lastError: string | null;
}

export interface SimConnectCallbacks {
  onLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  onSimState: (snapshot: SimLinkSnapshot) => void;
  onFrame: (frame: FlightFrame) => void;
  /** Ingest events: connected, disconnected, crashed, paused, unpaused, pause. */
  onIngestEvent: (body: { type: string; flags?: number }) => void;
  onPause: (state: PauseStateId, flags: number, label: string, usingPauseEx1: boolean) => void;
  onTraffic: (objects: TrafficObject[]) => void;
}

export class SimConnectLink {
  private config: EffectiveConfig;
  private readonly cb: SimConnectCallbacks;

  private running = false;
  private handle: SimConnectConnection | null = null;

  // Consecutive failures since the last successful open; reset on recvOpen.
  private reconnectAttempt = 0;
  // Guards against scheduling more than one pending reconnect when SimConnect
  // fires several disconnect-ish events (quit/close/error) for one drop.
  private reconnectScheduled = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private state: SimStateId = 'sim.idle';
  private nextRetryAt: number | null = null;
  private retryDelayMs: number | null = null;
  private appName: string | null = null;
  private appVersion: string | null = null;
  private lastError: string | null = null;

  // Traffic sweep state, shared across reconnects.
  private userObjectId: number | null = null;
  private userLat: number | null = null;
  private userLon: number | null = null;
  private lastSweepAt = 0;
  private sweepBuffer: TrafficRecord[] = [];

  // Once Pause_EX1 is seen to work the legacy events are redundant and would
  // fight it: they report a bare on/off that misses Active Pause.
  private usingPauseEx1 = false;

  constructor(config: EffectiveConfig, callbacks: SimConnectCallbacks) {
    this.config = config;
    this.cb = callbacks;
  }

  snapshot(): SimLinkSnapshot {
    return {
      state: this.state,
      attempt: this.reconnectAttempt,
      nextRetryAt: this.nextRetryAt,
      retryDelayMs: this.retryDelayMs,
      protocol: SIM_PROTOCOL_NAME[this.config.sim],
      appName: this.appName,
      appVersion: this.appVersion,
      lastError: this.lastError,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempt = 0;
    void this.tryConnect();
  }

  /**
   * Closes the link and cancels every timer. The process stays alive: stopping
   * the uplink is not a process operation.
   */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectScheduled = false;
    this.closeHandle();
    this.reconnectAttempt = 0;
    this.nextRetryAt = null;
    this.retryDelayMs = null;
    this.appName = null;
    this.appVersion = null;
    this.setState('sim.idle');
    this.resetPause();
  }

  /**
   * A changed sim protocol or traffic flag only takes effect at connect time —
   * the data definitions are registered there — so the link is cycled rather
   * than leaving the change silently deferred.
   */
  setConfig(config: EffectiveConfig): void {
    const previous = this.config;
    this.config = config;
    if (!this.running) return;

    if (previous.sim !== config.sim) {
      this.cb.onLog('info', `sim changed to ${config.sim} — reconnecting SimConnect`);
      this.reconnectAttempt = 0;
      this.cycle();
    } else if (previous.trafficEnabled !== config.trafficEnabled) {
      this.cb.onLog(
        'info',
        `trafficEnabled changed to ${config.trafficEnabled} — reconnecting SimConnect so the data definition is re-registered`,
      );
      this.cycle();
    }
  }

  private cycle(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectScheduled = false;
    this.closeHandle();
    void this.tryConnect();
  }

  private closeHandle(): void {
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    try {
      for (const event of ['simObjectData', 'simObjectDataByType', 'event', 'quit', 'close', 'error'] as const) {
        handle.removeAllListeners(event);
      }
      handle.close();
    } catch {
      // A handle that is already gone is not an error worth reporting.
    }
  }

  private setState(state: SimStateId): void {
    this.state = state;
    this.cb.onSimState(this.snapshot());
  }

  private resetPause(): void {
    // A stale ACTIVE PAUSE on a dead link is a lie.
    this.usingPauseEx1 = false;
    this.cb.onPause('pause.off', 0, describePause(0), false);
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running) return;
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;

    const delayMs = nextReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.retryDelayMs = delayMs;
    this.nextRetryAt = Date.now() + delayMs;
    this.cb.onLog(
      'warn',
      `${reason} — retrying in ${delayMs / 1000}s (attempt ${this.reconnectAttempt})`,
    );
    this.setState('sim.retry');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.tryConnect();
    }, delayMs);
  }

  private async tryConnect(): Promise<void> {
    this.reconnectScheduled = false;
    if (!this.running) return;

    const protocolName = SIM_PROTOCOL_NAME[this.config.sim];
    this.nextRetryAt = null;
    this.retryDelayMs = null;
    this.setState('sim.connecting');
    this.cb.onLog('info', `Connecting to SimConnect (Protocol.${protocolName})...`);

    try {
      // No `options` passed to open() — this connects locally, the same way
      // any other SimConnect client on this machine does. No SimConnect.xml
      // and no firewall configuration needed.
      const { recvOpen, handle } = await open(APP_NAME, Protocol[protocolName]);
      if (!this.running) {
        try {
          handle.close();
        } catch {
          // Stopped while connecting; nothing to report.
        }
        return;
      }

      this.handle = handle;
      this.appName = recvOpen.applicationName;
      this.appVersion = `${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}`;
      this.lastError = null;
      // A successful open means this disconnect episode is over: the next one
      // starts its backoff from the base delay again.
      this.reconnectAttempt = 0;
      this.setState('sim.connected');
      this.cb.onLog('info', `Connected to SimConnect — ${this.appName} ${this.appVersion}`);
      this.cb.onIngestEvent({ type: 'connected' });

      this.registerDefinitions(handle);
      this.subscribe(handle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.scheduleReconnect(`Could not connect to SimConnect (${message})`);
    }
  }

  private registerDefinitions(handle: SimConnectConnection): void {
    // Read order in the handlers below must match registration order exactly.
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'PLANE LATITUDE', 'degrees', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'PLANE LONGITUDE', 'degrees', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'PLANE ALTITUDE', 'feet', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'AIRSPEED INDICATED', 'knots', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'GROUND VELOCITY', 'knots', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'PLANE HEADING DEGREES TRUE', 'degrees', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'VERTICAL SPEED', 'feet per minute', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'SIM ON GROUND', 'bool', SimConnectDataType.INT32);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'IS SLEW ACTIVE', 'bool', SimConnectDataType.INT32);
    handle.addToDataDefinition(DEF_FLIGHT_DATA, 'TITLE', null, SimConnectDataType.STRING256);

    // AI traffic — distinct id, registered only when enabled, same read-order
    // rule as the flight-data definition above.
    if (this.config.trafficEnabled) {
      handle.addToDataDefinition(DEF_TRAFFIC, 'PLANE LATITUDE', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_TRAFFIC, 'PLANE LONGITUDE', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_TRAFFIC, 'PLANE ALTITUDE', 'feet', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_TRAFFIC, 'PLANE HEADING DEGREES TRUE', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_TRAFFIC, 'GROUND VELOCITY', 'knots', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_TRAFFIC, 'SIM ON GROUND', 'bool', SimConnectDataType.INT32);
    }

    handle.requestDataOnSimObject(REQ_FLIGHT_DATA, DEF_FLIGHT_DATA, OBJECT_USER, SimConnectPeriod.SECOND);

    handle.subscribeToSystemEvent(EVT_PAUSED, 'Paused');
    handle.subscribeToSystemEvent(EVT_UNPAUSED, 'Unpaused');
    handle.subscribeToSystemEvent(EVT_CRASHED, 'Crashed');
    handle.subscribeToSystemEvent(EVT_FLIGHT_LOADED, 'FlightLoaded');
    // Pause_EX1 reports Active Pause, which Paused/Unpaused do not.
    handle.subscribeToSystemEvent(EVT_PAUSE_EX1, 'Pause_EX1');
  }

  private subscribe(handle: SimConnectConnection): void {
    handle.on('simObjectData', ({ requestID, objectID, data }) => {
      if (requestID !== REQ_FLIGHT_DATA) return;

      const lat = data.readFloat64();
      const lon = data.readFloat64();
      const altitudeFt = data.readFloat64();
      const airspeedKnots = data.readFloat64();
      const groundSpeedKnots = data.readFloat64();
      const headingDeg = data.readFloat64();
      const verticalSpeedFpm = data.readFloat64();
      const onGround = data.readInt32() !== 0;
      const isSlew = data.readInt32() !== 0;
      const aircraft = data.readString256() ?? 'Unknown';

      this.cb.onFrame({
        lat,
        lon,
        altitudeFt,
        airspeedKnots,
        groundSpeedKnots,
        headingDeg,
        verticalSpeedFpm,
        onGround,
        simRunning: isSlew ? 3 : 2,
        aircraft,
      });

      // The user's own object id/position, and the throttled re-issue of the
      // traffic sweep, both ride this same 1 Hz tick rather than a timer.
      this.userObjectId = objectID;
      this.userLat = lat;
      this.userLon = lon;
      if (this.config.trafficEnabled && Date.now() - this.lastSweepAt >= TRAFFIC_SWEEP_MS) {
        this.lastSweepAt = Date.now();
        this.sweepBuffer = [];
        handle.requestDataOnSimObjectType(
          REQ_TRAFFIC,
          DEF_TRAFFIC,
          this.config.trafficRadiusM,
          SimObjectType.AIRCRAFT,
        );
      }
    });

    if (this.config.trafficEnabled) {
      handle.on('simObjectDataByType', ({ requestID, objectID, entryNumber, outOf, data }) => {
        if (requestID !== REQ_TRAFFIC) return;
        if (outOf === 0) {
          this.cb.onTraffic([]); // sweep found nothing
          return;
        }
        if (entryNumber <= 1) this.sweepBuffer = []; // authoritative reset
        this.sweepBuffer.push({
          id: objectID,
          lat: data.readFloat64(),
          lon: data.readFloat64(),
          altitudeFt: data.readFloat64(),
          headingDeg: data.readFloat64(),
          groundSpeedKnots: data.readFloat64(),
          onGround: data.readInt32() !== 0,
        });
        if (entryNumber >= outOf) {
          this.cb.onTraffic(
            buildTrafficBatch(this.sweepBuffer, this.userObjectId, this.userLat, this.userLon),
          );
          this.sweepBuffer = [];
        }
      });
    }

    handle.on('event', ({ clientEventId, data }) => {
      switch (clientEventId) {
        case EVT_PAUSE_EX1: {
          this.usingPauseEx1 = true;
          const flags = data | 0;
          const label = describePause(flags);
          this.cb.onLog('info', `Pause state: ${label}`);
          this.cb.onPause(pauseStateFromFlags(flags), flags, label, true);
          this.cb.onIngestEvent({ type: 'pause', flags });
          break;
        }
        case EVT_PAUSED:
          // Fallback only — Pause_EX1 is authoritative when available.
          if (!this.usingPauseEx1) {
            this.cb.onPause('pause.full', 1, describePause(1), false);
            this.cb.onIngestEvent({ type: 'paused' });
          }
          break;
        case EVT_UNPAUSED:
          if (!this.usingPauseEx1) {
            this.cb.onPause('pause.off', 0, describePause(0), false);
            this.cb.onIngestEvent({ type: 'unpaused' });
          }
          break;
        case EVT_CRASHED:
          this.cb.onLog('warn', 'Crash detected');
          this.cb.onIngestEvent({ type: 'crashed' });
          break;
        case EVT_FLIGHT_LOADED:
          this.cb.onLog('info', 'Flight loaded');
          break;
      }
    });

    const handleDisconnect = (reason: string) => {
      if (this.handle !== handle) return;
      this.handle = null;
      this.appName = null;
      this.appVersion = null;
      this.resetPause();
      this.cb.onIngestEvent({ type: 'disconnected' });
      this.scheduleReconnect(reason);
    };

    handle.on('quit', () => handleDisconnect('SimConnect disconnected'));
    handle.on('close', () => handleDisconnect('SimConnect disconnected'));
    handle.on('error', (err: Error) => {
      // SimConnect commonly fires 'error' alongside 'quit'/'close' for the
      // same underlying drop — scheduleReconnect's guard keeps the ladder from
      // doubling twice for one event.
      this.lastError = err.message;
      this.cb.onLog('error', `SimConnect error: ${err.message}`);
      handleDisconnect('SimConnect error');
    });
  }
}
