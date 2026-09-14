// ── Sidecar entrypoint ────────────────────────────────────────────────────────
//
// Reads the config file, talks to SimConnect, posts to the msfslogger server,
// and reports everything it is doing as one JSON object per line on stdout.
// Control messages arrive the same way on stdin.
//
// The rule that shapes this file: it never exits on a bad config. The CLI
// agent printed an error and exited, which under a GUI supervisor produces a
// window that flickers while the shell respawns a child that dies instantly
// and explains nothing. Here a missing or invalid config is a state — the
// process stays alive, says what is wrong, and waits to be told the config
// changed. The only deliberate exit is a clean shutdown, code 0.
//
// stdout carries protocol lines and nothing else: one stray print would
// corrupt the stream. Human-readable text goes to stderr.

import {
  loadConfig,
  parseConfigArg,
  redact,
  resolveConfigPath,
  SIM_PROTOCOL_NAME,
  type ConfigProblem,
  type EffectiveConfig,
} from './config';
import {
  decodeControlMessage,
  describeDecodeError,
  encodeSidecarMessage,
  isBlankLine,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  type LogLevel,
  type SidecarMessage,
  type StatusMessage,
} from './protocol';
import {
  describePause,
  type AppStateId,
  type BackendStateId,
  type PauseStateId,
} from './status';
import { SimConnectLink, type SimLinkSnapshot } from './simconnect';
import { Uplink } from './uplink';

const SIDECAR_VERSION = '1.0.0';

/** Status is a full snapshot, so coalescing bursts costs nothing. */
const STATUS_COALESCE_MS = 250;
const STATUS_HEARTBEAT_MS = 5000;
/** Below this, ingest traffic is evidence enough that the server is there. */
const PROBE_INTERVAL_MS = 15000;
const SHUTDOWN_GRACE_MS = 2000;

interface BackendAxis {
  state: BackendStateId;
  httpStatus: number | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  message: string | null;
}

interface PauseAxis {
  state: PauseStateId;
  flags: number;
  label: string;
  usingPauseEx1: boolean;
}

interface TrafficAxis {
  enabled: boolean;
  radiusM: number;
  lastSweepAt: number | null;
  lastBatchSize: number | null;
  lastError: string | null;
}

const IDLE_SIM: SimLinkSnapshot = {
  state: 'sim.idle',
  attempt: 0,
  nextRetryAt: null,
  retryDelayMs: null,
  protocol: SIM_PROTOCOL_NAME['2020'],
  appName: null,
  appVersion: null,
  lastError: null,
};

class Sidecar {
  private configPath: string;
  private config: EffectiveConfig | null = null;
  private problems: ConfigProblem[] = [];

  private appState: AppStateId = 'app.starting';
  private running = false;
  private runGeneration = 0;
  private sim: SimLinkSnapshot = { ...IDLE_SIM };
  private backend: BackendAxis = {
    state: 'net.idle',
    httpStatus: null,
    lastOkAt: null,
    lastErrorAt: null,
    message: null,
  };
  private pause: PauseAxis = {
    state: 'pause.off',
    flags: 0,
    label: describePause(0),
    usingPauseEx1: false,
  };
  private traffic: TrafficAxis = {
    enabled: true,
    radiusM: 40000,
    lastSweepAt: null,
    lastBatchSize: null,
    lastError: null,
  };

  private uplink: Uplink | null = null;
  private link: SimConnectLink | null = null;

  private statusTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private lastIngestAt = 0;
  private stdinBuffer = '';
  private shuttingDown = false;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  // ── output ────────────────────────────────────────────────────────────────

  private send(message: SidecarMessage): void {
    process.stdout.write(encodeSidecarMessage(message));
  }

  private log(level: LogLevel, message: string): void {
    this.send({ v: PROTOCOL_VERSION as 1, type: 'log', at: Date.now(), level, message });
  }

  private buildStatus(): StatusMessage {
    return {
      v: PROTOCOL_VERSION as 1,
      type: 'status',
      at: Date.now(),
      app:
        this.problems.length > 0
          ? { state: this.appState, problems: this.problems.map((p) => ({ field: String(p.field), message: p.message })) }
          : { state: this.appState },
      sim: { ...this.sim },
      backend: { ...this.backend },
      pause: { ...this.pause },
      traffic: { ...this.traffic },
      config: this.config ? redact(this.config) : null,
    };
  }

  private emitStatusNow(): void {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.send(this.buildStatus());
  }

  /** Coalesces a burst of changes into at most one line per 250 ms. */
  private touch(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.send(this.buildStatus());
    }, STATUS_COALESCE_MS);
    this.statusTimer.unref();
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    this.send({
      v: PROTOCOL_VERSION as 1,
      type: 'hello',
      at: Date.now(),
      pid: process.pid,
      sidecarVersion: SIDECAR_VERSION,
      nodeVersion: process.version,
      configPath: this.configPath,
    });

    this.heartbeatTimer = setInterval(() => this.emitStatusNow(), STATUS_HEARTBEAT_MS);

    this.readStdin();
    this.applyConfig(this.configPath, { initial: true });
    this.emitStatusNow();
  }

  private applyConfig(configPath: string, opts: { initial?: boolean } = {}): void {
    const result = loadConfig(configPath);
    this.configPath = configPath;

    if (!result.ok) {
      this.problems = result.problems;
      this.appState = result.reason === 'missing' ? 'app.no-config' : 'app.error-config';
      for (const problem of result.problems) {
        this.log('error', `${String(problem.field)}: ${problem.message}`);
      }
      if (this.running) {
        // A typo in the UI must not stop a flight being logged mid-air: the
        // previous good config keeps running until a valid one replaces it.
        this.log('warn', 'Keeping the previous config — the uplink is still running');
      } else {
        this.config = null;
      }
      this.touch();
      return;
    }

    for (const warning of result.warnings) {
      this.log('warn', warning.message);
    }

    this.problems = [];
    this.config = result.config;
    this.traffic.enabled = result.config.trafficEnabled;
    this.traffic.radiusM = result.config.trafficRadiusM;

    if (this.uplink) this.uplink.setConfig(result.config);
    else this.uplink = new Uplink(result.config, (level, message) => this.log(level, message));

    if (this.link) {
      this.link.setConfig(result.config);
    } else {
      this.sim = { ...IDLE_SIM, protocol: SIM_PROTOCOL_NAME[result.config.sim] };
    }

    const wasRunning = this.running || (opts.initial && result.config.autoUplink);
    this.appState = wasRunning ? 'app.running' : 'app.stopped';
    if (wasRunning) this.startUplink();
    this.touch();
  }

  private startUplink(): void {
    const config = this.config;
    const uplink = this.uplink;
    if (!config || !uplink) {
      this.log('warn', 'START ignored — there is no valid config to run on');
      this.emitStatusNow();
      return;
    }

    this.running = true;
    if (this.problems.length === 0) this.appState = 'app.running';
    if (!this.link) {
      this.link = new SimConnectLink(config, {
        onLog: (level, message) => this.log(level, message),
        onSimState: (snapshot) => {
          this.sim = snapshot;
          this.touch();
        },
        onFrame: (frame) => void this.postIngest(uplink.postFrame(frame)),
        onIngestEvent: (body) => void this.postIngest(uplink.postEvent(body)),
        onPause: (state, flags, label, usingPauseEx1) => {
          this.pause = { state, flags, label, usingPauseEx1 };
          this.touch();
        },
        onTraffic: (objects) => void this.postTraffic(objects),
      });
    }

    if (this.backend.state === 'net.idle') this.backend.state = 'net.pending';
    this.link.start();
    this.startProbe();
    this.touch();
  }

  private stopUplink(): Promise<import('./uplink').UplinkResult> | undefined {
    const wasRunning = this.running;
    this.running = false;
    this.runGeneration++;
    if (this.link) this.link.stop();
    this.stopProbe();
    // Best effort: the server should hear about this before we go quiet.
    const disconnected = wasRunning && this.uplink
      ? this.uplink.postEvent({ type: 'disconnected' })
      : undefined;
    this.sim = { ...IDLE_SIM, protocol: SIM_PROTOCOL_NAME[this.config?.sim ?? '2020'] };
    this.backend = {
      state: 'net.idle',
      httpStatus: null,
      lastOkAt: this.backend.lastOkAt,
      lastErrorAt: this.backend.lastErrorAt,
      message: null,
    };
    this.pause = { state: 'pause.off', flags: 0, label: describePause(0), usingPauseEx1: false };
    if (this.config && this.problems.length === 0) this.appState = 'app.stopped';
    this.touch();
    return disconnected;
  }

  // ── the server ────────────────────────────────────────────────────────────

  /** Only frame and event posts may claim the backend axis. */
  private async postIngest(pending: Promise<import('./uplink').UplinkResult>): Promise<void> {
    const generation = this.runGeneration;
    const result = await pending;
    if (!this.running || generation !== this.runGeneration) return;
    this.lastIngestAt = Date.now();
    this.backend.state = result.state;
    this.backend.httpStatus = result.httpStatus;
    this.backend.message = result.message;
    if (result.ok) this.backend.lastOkAt = Date.now();
    else this.backend.lastErrorAt = Date.now();
    this.touch();
  }

  /**
   * Traffic is advisory. A traffic-only failure updates its own counters and
   * never lights a fault the user cannot act on.
   */
  private async postTraffic(objects: unknown[]): Promise<void> {
    const uplink = this.uplink;
    if (!uplink) return;
    const result = await uplink.postTraffic(objects);
    this.traffic.lastSweepAt = Date.now();
    this.traffic.lastBatchSize = objects.length;
    this.traffic.lastError = result.ok ? null : result.message;
    this.touch();
  }

  private startProbe(): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => void this.probeOnce(), PROBE_INTERVAL_MS);
    this.probeTimer.unref();
    void this.probeOnce();
  }

  private stopProbe(): void {
    if (!this.probeTimer) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /**
   * When the sim link is down there are no frames, so without this the backend
   * axis would freeze on a stale value and say nothing about the server.
   */
  private async probeOnce(): Promise<void> {
    const uplink = this.uplink;
    if (!uplink || !this.running) return;
    if (Date.now() - this.lastIngestAt < PROBE_INTERVAL_MS) return;

    const generation = this.runGeneration;
    const result = await uplink.probe();
    if (!this.running || generation !== this.runGeneration) return;
    this.backend.state = result.state;
    this.backend.httpStatus = null;
    this.backend.message = result.ok ? null : result.message;
    if (!result.ok) this.backend.lastErrorAt = Date.now();
    this.touch();
  }

  // ── control ───────────────────────────────────────────────────────────────

  private readStdin(): void {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => this.onStdinChunk(chunk));
    // stdin EOF is a shutdown: it is the orphan guard. A shell that dies
    // without sending anything still takes this process with it.
    process.stdin.on('end', () => void this.shutdown('stdin closed'));
    process.stdin.on('error', () => void this.shutdown('stdin error'));
  }

  private onStdinChunk(chunk: string): void {
    this.stdinBuffer += chunk;
    if (Buffer.byteLength(this.stdinBuffer, 'utf8') > MAX_LINE_BYTES * 2) {
      // Never buffer an unbounded line.
      this.stdinBuffer = '';
      this.log('warn', 'Dropped oversized input: no newline within the line limit');
      return;
    }
    let index = this.stdinBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdinBuffer.slice(0, index);
      this.stdinBuffer = this.stdinBuffer.slice(index + 1);
      this.handleLine(line);
      index = this.stdinBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    if (this.shuttingDown || isBlankLine(line)) return;
    const decoded = decodeControlMessage(line.replace(/\r$/, ''));
    if (!decoded.ok) {
      if (decoded.error !== 'unknown-type') this.log('warn', describeDecodeError(decoded));
      return;
    }

    switch (decoded.message.type) {
      case 'start':
        if (this.running) return;
        if (!this.config) {
          this.log('warn', 'START ignored — the config is missing or invalid');
          this.emitStatusNow();
          return;
        }
        this.startUplink();
        this.emitStatusNow();
        return;
      case 'stop':
        void this.stopUplink();
        this.emitStatusNow();
        return;
      case 'config': {
        const path = decoded.message.path ?? this.configPath;
        this.applyConfig(path);
        this.emitStatusNow();
        return;
      }
      case 'shutdown':
        void this.shutdown('shutdown requested');
        return;
      case 'ping':
        this.send({ v: PROTOCOL_VERSION as 1, type: 'pong', at: Date.now(), id: decoded.message.id });
        return;
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log('info', `Shutting down (${reason})`);

    const disconnected = this.stopUplink();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.statusTimer = null;
    this.heartbeatTimer = null;

    if (disconnected) {
      await Promise.race([
        disconnected,
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS / 2)),
      ]);
    }
    if (this.uplink) await this.uplink.close();

    // A shutdown does not make a bad config good: that state survives to the
    // last line the process writes.
    if (this.config && this.problems.length === 0) this.appState = 'app.stopped';
    this.emitStatusNow();
    process.exitCode = 0;
    // stdin would otherwise hold the loop open long after everything is done.
    process.stdin.pause();
  }
}

const argv = process.argv.slice(2);
const sidecar = new Sidecar(resolveConfigPath(parseConfigArg(argv)));

// An unexpected throw is reported and survived. The supervisor's restart
// budget is the backstop; a process that dies on every tick is not.
process.on('uncaughtException', (err) => {
  process.stderr.write(`uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`unhandled rejection: ${String(reason)}\n`);
});
process.on('SIGINT', () => void sidecar.shutdown('SIGINT'));
process.on('SIGTERM', () => void sidecar.shutdown('SIGTERM'));

sidecar.start();
