// ── Datalink service ──────────────────────────────────────────────────────────
//
// Owns everything the datalink does over time: the watch lease, the poll
// cycle, backoff, the invalid-token latch, the cached thread and its epochs,
// and the answers to the shell's datalink requests.
//
// The rules that shape it:
//
// - The server is contacted only while a lease is held (a DATALINK page is
//   showing and renewing it) or when the user asks for something. There is no
//   background polling.
// - A wrong token stops every request until the config is reloaded. Retrying
//   it would only hammer the server with a credential it has already refused.
//   Every other failure, including a server that predates the datalink
//   routes, backs off and recovers by itself.
// - The datalink never touches the uplink: not the backend status axis, not
//   START/STOP, not the reachability probe. It needs only a valid config.
// - The thread is unbounded on the server, so it is cached here and handed to
//   the shell in windows. The pushed state carries only a summary, and an epoch
//   that changes whenever cached seq numbers stop meaning the same rows.
// - A SimBrief prefile creates a real planned leg, so it is made at most once
//   per request: never retried, never repeated by a poll, and refused while
//   another is in flight. The leg it returns is held in memory as a scope of
//   its own until a flight starts, the user clears it, the server or token
//   changes, the token is refused, or the leg turns out to be gone.
// - A clearance request writes logbook rows the first time, so it follows the
//   same discipline: one request per op, never retried, never made by a poll,
//   and refused while another is in flight.
//
// Timers go through setTimeout so a fake clock drives the whole schedule.

import { classifyClearanceOutcome, projectClearance } from './clearance-model';
import {
  classifyOutcome,
  emittedServerCode,
  INVALID_INGEST_TOKEN,
  type Classified,
  type DatalinkStateId,
  type HttpOutcome,
} from './datalink-classify';
import { routeTemplate, type DatalinkRoute } from './datalink-client';
import {
  fillWindow,
  projectCanned,
  projectLoadsheet,
  projectThread,
  projectWx,
  THREAD_CACHE_MAX_MESSAGES,
} from './datalink-model';
import { selectScope, selectScopeWithPrefile, type ScopeSelection } from './datalink-scope';
import type {
  DatalinkError,
  DatalinkMessage,
  DatalinkOutcome,
  DatalinkParams,
  DatalinkRequestMessage,
  DatalinkScope,
  DatalinkStateMessage,
  DatalinkThreadSummary,
  WriteTarget,
} from './protocol';
import { classifySimbriefOutcome, projectSimbriefPrefile, projectSimbriefSettings } from './simbrief-model';
import type { LogSink } from './uplink';

export const DATALINK_POLL_INTERVAL_MS = 20000;
export const DATALINK_BACKOFF_MAX_MS = 120000;
export const DATALINK_LEASE_MS = 65000;

/** 20 s while healthy; doubling per consecutive failed cycle, capped at 120 s. */
export function nextPollDelayMs(consecutiveFailures: number): number {
  const f = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0 ? Math.floor(consecutiveFailures) : 0;
  if (f === 0) return DATALINK_POLL_INTERVAL_MS;
  return Math.min(DATALINK_POLL_INTERVAL_MS * 2 ** Math.min(f, 16), DATALINK_BACKOFF_MAX_MS);
}

export interface DatalinkRequester {
  request(route: DatalinkRoute, abort?: AbortSignal): Promise<HttpOutcome>;
}

export interface DatalinkServiceDeps {
  client: DatalinkRequester;
  /** False while the sidecar has no valid config. */
  hasConfig(): boolean;
  /** The token in use, only so it can be scrubbed out of forwarded text. */
  token(): string | null;
  /** The server in use, only so a prefiled leg is dropped when it changes. */
  serverUrl(): string | null;
  emitState(message: DatalinkStateMessage): void;
  log: LogSink;
}

interface ThreadCache {
  key: string;
  epoch: number;
  total: number;
  firstSeq: number;
  messages: DatalinkMessage[];
  droppedRows: number;
}

type Failure = Extract<Classified, { ok: false }>;

/** A failed cycle; `counts: false` leaves the backoff where it was. */
interface CycleFailure {
  failure: Failure;
  route: string;
  counts?: boolean;
}

/**
 * The server and token are the ones in effect when the prefile started. They
 * are compared on a config reload and used for nothing else: never emitted,
 * logged or passed on.
 */
interface PrefiledState {
  plannedLegId: number;
  label: string;
  serverUrl: string | null;
  token: string | null;
}

const NON_FAULT_STATES: readonly DatalinkStateId[] = ['dl.idle', 'dl.pending', 'dl.ok'];

function error(
  code: DatalinkError['code'],
  httpStatus: number | null = null,
  serverCode: string | null = null,
): DatalinkOutcome<never> {
  return { ok: false, error: { code, httpStatus, serverCode } };
}

function failureOutcome(failure: Failure): DatalinkOutcome<never> {
  return error(failure.code, failure.httpStatus, failure.serverCode);
}

function badResponse(httpStatus: number): Failure {
  return {
    ok: false,
    code: 'bad-response',
    availability: 'dl.bad-response',
    httpStatus,
    serverCode: null,
    retry: 'backoff',
  };
}

function scopeKey(selection: { kind: 'flight'; flightId: number } | { kind: 'leg'; plannedLegId: number }): string {
  return selection.kind === 'flight' ? `flight:${selection.flightId}` : `leg:${selection.plannedLegId}`;
}

export class DatalinkService {
  private readonly deps: DatalinkServiceDeps;

  private state: DatalinkStateId = 'dl.idle';
  private watching = false;
  private httpStatus: number | null = null;
  private serverCode: string | null = null;
  private lastOkAt: number | null = null;
  private lastErrorAt: number | null = null;
  private nextPollAt: number | null = null;
  private scope: DatalinkScope | null = null;

  private leaseUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private cycleInFlight = false;
  private rerunAfterCycle = false;
  private latched = false;
  private consecutiveFailures = 0;
  private shuttingDown = false;
  private readonly abort = new AbortController();

  private cache: ThreadCache | null = null;
  private epochCounter = 0;

  private prefiled: PrefiledState | null = null;
  private prefileInFlight = false;
  private clearanceInFlight = false;

  constructor(deps: DatalinkServiceDeps) {
    this.deps = deps;
  }

  // ── state ─────────────────────────────────────────────────────────────────

  buildState(): DatalinkStateMessage {
    return {
      v: 1,
      type: 'datalink-state',
      at: Date.now(),
      state: this.state,
      watching: this.watching,
      httpStatus: this.httpStatus,
      serverCode: this.serverCode,
      lastOkAt: this.lastOkAt,
      lastErrorAt: this.lastErrorAt,
      nextPollAt: this.nextPollAt,
      scope: this.scope ? { ...this.scope } : null,
      thread: this.threadSummary(),
      // Omitted rather than null when none is held, so the state is unchanged
      // for anyone who never prefiles.
      ...(this.prefiled
        ? { prefiledLeg: { plannedLegId: this.prefiled.plannedLegId, label: this.prefiled.label } }
        : {}),
    };
  }

  private threadSummary(): DatalinkThreadSummary | null {
    const cache = this.cache;
    if (!cache) return null;
    const newest = cache.messages[cache.messages.length - 1];
    return {
      epoch: cache.epoch,
      total: cache.total,
      firstSeq: cache.firstSeq,
      newestId: newest ? newest.id : null,
      droppedRows: cache.droppedRows,
    };
  }

  private emit(): void {
    if (this.shuttingDown) return;
    this.deps.emitState(this.buildState());
  }

  /**
   * One log line per change of state. Only the method and the route template
   * are named: no host, no ids, no bodies, no headers, no error text.
   */
  private setState(next: DatalinkStateId, route: string | null): void {
    if (next === this.state) return;
    this.state = next;
    const status = this.httpStatus === null ? '---' : String(this.httpStatus);
    const code = this.serverCode === null ? '' : `, code ${this.serverCode}`;
    const where = route === null ? '' : ` on ${route}`;
    const level = NON_FAULT_STATES.includes(next) ? 'info' : 'warn';
    this.deps.log(level, `Datalink ${next} (HTTP ${status}${code})${where}`);
  }

  private applyFailure(failure: Failure, route: string): void {
    if (failure.availability !== null) {
      this.httpStatus = failure.httpStatus;
      this.serverCode = failure.serverCode;
      this.lastErrorAt = Date.now();
      this.setState(failure.availability, route);
    }
    if (failure.retry === 'latch') this.setLatch();
  }

  /** A refused token also ends any prefiled leg; the caller emits. */
  private setLatch(): void {
    this.latched = true;
    this.cancelTimer();
    this.nextPollAt = null;
    this.dropPrefiled();
  }

  /**
   * Forgets the prefiled leg, and the scope and thread shown for it. Without
   * this, a cycle that fails before resolving a new scope would leave the CDU
   * showing, and writes aimed at, a leg nobody holds any more. The caller emits.
   */
  private dropPrefiled(): void {
    this.prefiled = null;
    if (this.scope?.kind === 'leg' && this.scope.source === 'prefile') {
      this.scope = null;
      this.cache = null;
    }
  }

  /** A cycle resolved a prefile scope, but the leg was dropped while it ran. */
  private isStalePrefile(selection: ScopeSelection): boolean {
    return (
      selection.kind === 'leg' &&
      selection.source === 'prefile' &&
      this.prefiled?.plannedLegId !== selection.plannedLegId
    );
  }

  // ── lease and schedule ────────────────────────────────────────────────────

  /** Returns true when this call started watching. */
  private renewLease(): boolean {
    this.leaseUntil = Date.now() + DATALINK_LEASE_MS;
    if (this.watching) return false;
    this.watching = true;
    if (this.state === 'dl.idle') {
      this.httpStatus = null;
      this.serverCode = null;
      this.setState('dl.pending', null);
    }
    return true;
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.cancelTimer();
    if (!this.watching || this.latched || this.shuttingDown) {
      this.nextPollAt = null;
      return;
    }
    const delay = nextPollDelayMs(this.consecutiveFailures);
    this.nextPollAt = Date.now() + delay;
    this.timer = setTimeout(() => this.onTimer(), delay);
    this.timer.unref?.();
  }

  private onTimer(): void {
    this.timer = null;
    if (this.shuttingDown) return;
    if (Date.now() >= this.leaseUntil) {
      this.watching = false;
      this.nextPollAt = null;
      this.emit();
      return;
    }
    this.startCycle();
  }

  /**
   * Starts a cycle now when the preconditions hold. Without a config it
   * reports that instead and schedules nothing; a config reload resumes.
   */
  private startCycle(): void {
    if (this.cycleInFlight || this.shuttingDown || this.latched || !this.watching) return;
    if (Date.now() >= this.leaseUntil) {
      this.cancelTimer();
      this.watching = false;
      this.nextPollAt = null;
      this.emit();
      return;
    }
    if (!this.deps.hasConfig()) {
      this.cancelTimer();
      this.nextPollAt = null;
      this.httpStatus = null;
      this.serverCode = null;
      this.setState('dl.no-config', null);
      this.emit();
      return;
    }
    this.cancelTimer();
    this.nextPollAt = null;
    void this.runCycle();
  }

  /** A cycle as soon as possible: now, or right after the one in flight. */
  private cycleSoon(): void {
    if (!this.watching || this.latched || this.shuttingDown) return;
    if (this.cycleInFlight) {
      this.rerunAfterCycle = true;
      return;
    }
    this.startCycle();
  }

  // ── poll cycle ────────────────────────────────────────────────────────────

  private async get(route: DatalinkRoute): Promise<{ outcome: HttpOutcome; template: string }> {
    const outcome = await this.deps.client.request(route, this.abort.signal);
    return { outcome, template: routeTemplate(route.key) };
  }

  private async runCycle(): Promise<void> {
    this.cycleInFlight = true;
    let failure: CycleFailure | null = null;
    let lastRoute = routeTemplate('status');
    // A prefiled leg set or cleared meanwhile is picked up by the next cycle;
    // this one finishes with what it resolved.
    const cyclePrefiled = this.prefiled?.plannedLegId ?? null;

    try {
      const status = await this.get({ key: 'status' });
      if (this.shuttingDown) return;
      const statusResult = classifyOutcome(status.outcome, 'poll', this.deps.token());
      if (!statusResult.ok) {
        failure = { failure: statusResult, route: status.template };
        return;
      }

      const resolved = selectScopeWithPrefile(statusResult.json, cyclePrefiled);
      let selection: ScopeSelection = resolved.selection;
      // A flight has started: the prefile has done its job and ends here.
      if (resolved.prefile === 'clear' && this.prefiled?.plannedLegId === cyclePrefiled) this.dropPrefiled();
      // Only asked for when this cycle has no prefiled leg.
      if (selection.kind === 'need-ground-session') {
        const ground = await this.get({ key: 'ground-session-current' });
        if (this.shuttingDown) return;
        lastRoute = ground.template;
        const groundResult = classifyOutcome(ground.outcome, 'poll', this.deps.token());
        if (!groundResult.ok) {
          failure = { failure: groundResult, route: ground.template };
          return;
        }
        selection = selectScope(statusResult.json, groundResult.json);
        if (selection.kind === 'bad-response') {
          failure = { failure: badResponse(groundResult.httpStatus), route: ground.template };
          return;
        }
      }
      if (selection.kind === 'bad-response' || selection.kind === 'need-ground-session') {
        failure = { failure: badResponse(statusResult.httpStatus), route: status.template };
        return;
      }

      if (selection.kind === 'none') {
        this.scope = { kind: 'none' };
        this.cache = null;
        return;
      }

      const key = scopeKey(selection);
      // A thread from the old scope is never shown under a new scope line.
      if (this.cache && this.cache.key !== key) this.cache = null;

      const threadRoute: DatalinkRoute =
        selection.kind === 'flight'
          ? { key: 'flight-thread', id: selection.flightId }
          : { key: 'leg-thread', id: selection.plannedLegId };
      const thread = await this.get(threadRoute);
      if (this.shuttingDown) return;
      lastRoute = thread.template;

      const threadResult = classifyOutcome(thread.outcome, 'poll', this.deps.token());
      const projection = threadResult.ok
        ? projectThread(threadResult.json, selection.kind, this.deps.token())
        : null;

      if (
        !threadResult.ok &&
        threadResult.code === 'leg-not-found' &&
        selection.kind === 'leg' &&
        selection.source === 'prefile' &&
        this.prefiled?.plannedLegId === selection.plannedLegId
      ) {
        // The prefiled leg was deleted on the server. That is not the server
        // failing, so it does not back off: the scope is re-resolved at once
        // without it.
        this.prefiled = null;
        this.scope = null;
        this.cache = null;
        this.rerunAfterCycle = true;
        failure = { failure: threadResult, route: thread.template, counts: false };
        return;
      }

      if (this.isStalePrefile(selection)) {
        // Cleared while this cycle ran: publish no scope rather than the old
        // leg; the rerun the clear asked for resolves the real one.
        this.scope = null;
        this.cache = null;
        if (!threadResult.ok || !projection || !projection.ok) {
          failure = {
            failure: threadResult.ok ? badResponse(threadResult.httpStatus) : threadResult,
            route: thread.template,
          };
        }
        return;
      }

      if (!threadResult.ok || !projection || !projection.ok) {
        this.scope =
          selection.kind === 'flight'
            ? { kind: 'flight', flightId: selection.flightId, plannedLegId: selection.plannedLegId }
            : { kind: 'leg', plannedLegId: selection.plannedLegId, source: selection.source };
        failure = {
          failure: threadResult.ok ? badResponse(threadResult.httpStatus) : threadResult,
          route: thread.template,
        };
        return;
      }

      this.storeThread(key, projection.messages, projection.droppedRows);
      this.scope =
        selection.kind === 'flight'
          ? {
              kind: 'flight',
              flightId: selection.flightId,
              plannedLegId: selection.plannedLegId ?? projection.threadPlannedLegId,
            }
          : { kind: 'leg', plannedLegId: selection.plannedLegId, source: selection.source };
    } finally {
      this.cycleInFlight = false;
      if (!this.shuttingDown) this.finishCycle(failure, lastRoute);
    }
  }

  private finishCycle(failure: CycleFailure | null, lastRoute: string): void {
    if (failure) {
      // A token refused by an op while this cycle was in flight outranks
      // whatever else the cycle ran into: polling stays stopped until a config
      // reload, and the state must keep saying why.
      if (!this.latched || failure.failure.retry === 'latch') {
        this.applyFailure(failure.failure, failure.route);
      }
      if (failure.failure.retry !== 'latch' && failure.counts !== false) this.consecutiveFailures++;
    } else if (!this.latched) {
      this.httpStatus = null;
      this.serverCode = null;
      this.lastOkAt = Date.now();
      this.consecutiveFailures = 0;
      this.setState('dl.ok', lastRoute);
    }
    this.schedule();
    this.emit();

    if (this.rerunAfterCycle) {
      this.rerunAfterCycle = false;
      this.startCycle();
    }
  }

  /**
   * Replaces the cache for `key`. The epoch stays the same only when the new
   * thread is the old one plus rows appended at the end, so every seq the
   * webview already holds still names the same message.
   */
  private storeThread(key: string, all: DatalinkMessage[], droppedRows: number): void {
    const total = all.length;
    const kept = all.length > THREAD_CACHE_MAX_MESSAGES ? all.slice(all.length - THREAD_CACHE_MAX_MESSAGES) : all;
    const firstSeq = total - kept.length;
    const old = this.cache;

    let sameEpoch = false;
    if (old && old.key === key && total >= old.total) {
      sameEpoch = true;
      for (let seq = Math.max(old.firstSeq, firstSeq); seq < old.total; seq++) {
        if (old.messages[seq - old.firstSeq].id !== kept[seq - firstSeq].id) {
          sameEpoch = false;
          break;
        }
      }
    }
    const epoch = sameEpoch && old ? old.epoch : ++this.epochCounter;
    this.cache = { key, epoch, total, firstSeq, messages: kept, droppedRows };
  }

  // ── requests from the shell ───────────────────────────────────────────────

  async handle(request: DatalinkRequestMessage): Promise<DatalinkOutcome> {
    if (this.shuttingDown) return error('sidecar-unavailable');
    switch (request.op) {
      case 'watch':
        return this.watch(request.params);
      case 'refresh':
        return this.refresh();
      case 'thread':
        return this.thread(request.params);
      case 'canned-list':
        return this.cannedList();
      case 'send-canned':
        return this.sendCanned(request.params);
      case 'wx':
        return this.wx(request.params);
      case 'loadsheet':
        return this.loadsheet(request.params);
      case 'simbrief-settings':
        return this.simbriefSettings();
      case 'simbrief-prefile':
        return this.simbriefPrefile();
      case 'prefile-clear':
        return this.prefileClear();
      case 'clearance':
        return this.clearance(request.params);
    }
  }

  private watch(params: DatalinkParams['watch']): DatalinkOutcome<'watch'> {
    if (params.on) {
      if (this.renewLease()) {
        this.startCycle();
        this.emit();
      }
      return { ok: true, result: { watching: true, leaseMs: DATALINK_LEASE_MS } };
    }
    this.leaseUntil = 0;
    this.cancelTimer();
    this.watching = false;
    this.nextPollAt = null;
    this.emit();
    return { ok: true, result: { watching: false, leaseMs: DATALINK_LEASE_MS } };
  }

  private refresh(): DatalinkOutcome<'refresh'> {
    const started = this.renewLease();
    if (!this.deps.hasConfig() || this.latched) {
      if (started) {
        this.startCycle();
        this.emit();
      }
      return this.localRefusal();
    }
    if (this.cycleInFlight) {
      if (started) this.emit();
      return { ok: true, result: { accepted: true, coalesced: true } };
    }
    this.startCycle();
    if (started) this.emit();
    return { ok: true, result: { accepted: true, coalesced: false } };
  }

  /** The answer to a server-bound op that must not make a request. */
  private localRefusal(): DatalinkOutcome<never> {
    if (!this.deps.hasConfig()) return error('no-config');
    return error('token-invalid', 401, emittedServerCode(INVALID_INGEST_TOKEN, this.deps.token()));
  }

  private thread(params: DatalinkParams['thread']): DatalinkOutcome<'thread'> {
    const cache = this.cache;
    if (!cache) return error('no-thread');
    if (params.epoch !== cache.epoch) return error('stale-epoch');
    const { endSeq } = params;
    if (endSeq > cache.total) return error('bad-request');
    const base = { epoch: cache.epoch, total: cache.total, firstSeq: cache.firstSeq };
    if (endSeq <= cache.firstSeq) {
      return { ok: true, result: { ...base, startSeq: endSeq, endSeq, messages: [] } };
    }
    const messages = fillWindow(cache.messages, cache.firstSeq, endSeq);
    const startSeq = messages.length > 0 ? messages[0].seq : endSeq;
    return { ok: true, result: { ...base, startSeq, endSeq, messages } };
  }

  /**
   * One request for a user op. Any availability change or latch the result
   * carries is applied and emitted here, so each op only shapes its answer.
   * With `anySuccess`, a 2xx is success whatever its body.
   */
  private async op(
    route: DatalinkRoute,
    options: { anySuccess?: boolean } = {},
  ): Promise<{ outcome: HttpOutcome; classified: Classified } | null> {
    const outcome = await this.deps.client.request(route, this.abort.signal);
    if (this.shuttingDown) return null;
    if (options.anySuccess && outcome.kind === 'response' && outcome.status >= 200 && outcome.status <= 299) {
      return { outcome, classified: { ok: true, httpStatus: outcome.status, json: null } };
    }
    const classified = classifyOutcome(outcome, 'op', this.deps.token());
    if (!classified.ok) {
      const changesAxis = classified.availability !== null || classified.retry === 'latch';
      this.applyFailure(classified, routeTemplate(route.key));
      if (changesAxis) this.emit();
      if (classified.code === 'flight-not-found' || classified.code === 'leg-not-found') {
        if (classified.code === 'leg-not-found' && this.isPrefiledLegRoute(route)) {
          this.dropPrefiled();
          this.emit();
        }
        // The flight or leg this op was aimed at has gone; re-resolve the scope now.
        this.cycleSoon();
      }
    }
    return { outcome, classified };
  }

  private opBadResponse(route: DatalinkRoute, httpStatus: number): DatalinkOutcome<never> {
    const failure = badResponse(httpStatus);
    this.applyFailure(failure, routeTemplate(route.key));
    this.emit();
    return failureOutcome(failure);
  }

  private async cannedList(): Promise<DatalinkOutcome<'canned-list'>> {
    if (!this.deps.hasConfig() || this.latched) return this.localRefusal();
    const route: DatalinkRoute = { key: 'canned-list' };
    const done = await this.op(route);
    if (!done) return error('sidecar-unavailable');
    if (!done.classified.ok) return failureOutcome(done.classified);
    const projected = projectCanned(done.classified.json, this.deps.token());
    if (!projected.ok) return this.opBadResponse(route, done.classified.httpStatus);
    return { ok: true, result: projected.result };
  }

  private writeRoute(target: WriteTarget, kind: 'send' | 'wx', value: string): DatalinkRoute {
    if (kind === 'send') {
      return target.kind === 'flight'
        ? { key: 'flight-send', id: target.id, cannedId: value }
        : { key: 'leg-send', id: target.id, cannedId: value };
    }
    return target.kind === 'flight'
      ? { key: 'flight-wx', id: target.id, icao: value }
      : { key: 'leg-wx', id: target.id, icao: value };
  }

  /**
   * A write that answered 2xx, or whose fate is unknown because no answer came
   * back, is followed by a cycle: the thread then shows the downlink and any
   * reply, or proves it did not land, before the user can send it again.
   */
  private afterWrite(outcome: HttpOutcome): void {
    const landedOrUnknown = outcome.kind === 'transport' || (outcome.status >= 200 && outcome.status <= 299);
    if (landedOrUnknown) this.cycleSoon();
  }

  private async sendCanned(params: DatalinkParams['send-canned']): Promise<DatalinkOutcome<'send-canned'>> {
    if (!this.deps.hasConfig() || this.latched) return this.localRefusal();
    const route = this.writeRoute(params.target, 'send', params.cannedId);
    // Any 2xx means the downlink was accepted; the success body is not read.
    const done = await this.op(route, { anySuccess: true });
    if (!done) return error('sidecar-unavailable');
    this.afterWrite(done.outcome);
    if (!done.classified.ok) return failureOutcome(done.classified);
    return { ok: true, result: { sent: true, httpStatus: done.classified.httpStatus } };
  }

  private async wx(params: DatalinkParams['wx']): Promise<DatalinkOutcome<'wx'>> {
    if (!this.deps.hasConfig() || this.latched) return this.localRefusal();
    const route = this.writeRoute(params.target, 'wx', params.icao);
    const done = await this.op(route);
    if (!done) return error('sidecar-unavailable');
    this.afterWrite(done.outcome);
    if (!done.classified.ok) return failureOutcome(done.classified);
    const projected = projectWx(done.classified.json, params.icao, this.deps.token());
    if (!projected.ok) return this.opBadResponse(route, done.classified.httpStatus);
    return { ok: true, result: projected.result };
  }

  private async loadsheet(params: DatalinkParams['loadsheet']): Promise<DatalinkOutcome<'loadsheet'>> {
    if (!this.deps.hasConfig() || this.latched) return this.localRefusal();
    const route: DatalinkRoute = { key: 'leg-loadsheet', id: params.plannedLegId };
    const done = await this.op(route);
    if (!done) return error('sidecar-unavailable');
    this.afterWrite(done.outcome);
    if (!done.classified.ok) return failureOutcome(done.classified);
    const projected = projectLoadsheet(
      done.classified.json,
      done.classified.httpStatus,
      params.plannedLegId,
      this.deps.token(),
    );
    if (!projected.ok) return this.opBadResponse(route, done.classified.httpStatus);
    return { ok: true, result: projected.result };
  }

  // ── SimBrief ──────────────────────────────────────────────────────────────

  private isPrefiledLegRoute(route: DatalinkRoute): boolean {
    const legRoute = route.key === 'leg-send' || route.key === 'leg-wx' || route.key === 'leg-loadsheet';
    return legRoute && this.prefiled !== null && this.prefiled.plannedLegId === route.id;
  }

  /**
   * One SimBrief request. It is never retried and never followed by a cycle.
   * The only thing it can change on the datalink is a refused token, which is
   * applied and emitted here. Logs one line naming the op, the result status
   * or error code, and the HTTP status: nothing the server wrote.
   */
  private async simbrief<T>(
    key: 'simbrief-settings' | 'simbrief-prefile',
    project: (json: unknown, httpStatus: number) => { ok: true; result: T } | { ok: false; detail: string },
    describe: (result: T) => string,
  ): Promise<{ ok: true; result: T } | { ok: false; error: DatalinkError } | null> {
    const outcome = await this.deps.client.request({ key }, this.abort.signal);
    if (this.shuttingDown) return null;
    const classified = classifySimbriefOutcome(outcome, this.deps.token());
    const op = key === 'simbrief-settings' ? 'settings' : 'prefile';

    if (!classified.ok) {
      if (classified.availability !== null || classified.retry === 'latch') {
        this.applyFailure(classified, routeTemplate(key));
        this.emit();
      }
      const status = classified.httpStatus === null ? '---' : String(classified.httpStatus);
      this.deps.log('warn', `SimBrief ${op} ${classified.code} (HTTP ${status})`);
      return failureOutcome(classified);
    }

    const projected = project(classified.json, classified.httpStatus);
    if (!projected.ok) {
      this.deps.log('warn', `SimBrief ${op} bad-response (HTTP ${classified.httpStatus})`);
      return error('bad-response', classified.httpStatus);
    }
    this.deps.log('info', `SimBrief ${op} ${describe(projected.result)} (HTTP ${classified.httpStatus})`);
    return { ok: true, result: projected.result };
  }

  private async simbriefSettings(): Promise<DatalinkOutcome<'simbrief-settings'>> {
    if (!this.deps.hasConfig() || this.latched) return this.localRefusal();
    const outcome = await this.simbrief('simbrief-settings', (json) => projectSimbriefSettings(json), () => 'ok');
    return outcome ?? error('sidecar-unavailable');
  }

  private async simbriefPrefile(): Promise<DatalinkOutcome<'simbrief-prefile'>> {
    // Checked before anything else, so a second press can never reach the
    // server while the first one's fate is still open.
    if (this.prefileInFlight) return error('prefile-in-progress');
    this.prefileInFlight = true;
    try {
      if (!this.deps.hasConfig() || this.latched) return this.localRefusal();
      const serverUrl = this.deps.serverUrl();
      const token = this.deps.token();
      const outcome = await this.simbrief(
        'simbrief-prefile',
        (json, httpStatus) => projectSimbriefPrefile(json, httpStatus, this.deps.token()),
        (result) => result.status,
      );
      if (!outcome) return error('sidecar-unavailable');
      if (outcome.ok) {
        // A duplicate is the same leg, already filed: it is held exactly like
        // a fresh import, and replaces any leg held before.
        this.prefiled = { plannedLegId: outcome.result.plannedLegId, label: outcome.result.label, serverUrl, token };
        this.emit();
        this.cycleSoon();
      }
      return outcome;
    } finally {
      this.prefileInFlight = false;
    }
  }

  /** Needs no config and works while latched: it only forgets something. */
  private prefileClear(): DatalinkOutcome<'prefile-clear'> {
    if (!this.prefiled) return { ok: true, result: { cleared: false } };
    this.dropPrefiled();
    this.emit();
    this.cycleSoon();
    return { ok: true, result: { cleared: true } };
  }

  // ── clearance ─────────────────────────────────────────────────────────────

  /**
   * One POST for the leg the CDU confirmed. The sidecar does not re-resolve
   * the leg: the id it is given is the one the user saw. The only follow-up is
   * the cycle a write gets, so the thread shows the request and reply pair or
   * proves the POST did not land. Logs one line naming the outcome and the
   * HTTP status: never the leg, the clearance or anything the server wrote.
   */
  private async clearance(params: DatalinkParams['clearance']): Promise<DatalinkOutcome<'clearance'>> {
    // Checked before anything else, so a second press can never reach the
    // server while the first one's fate is still open.
    if (this.clearanceInFlight) return error('clearance-in-progress');
    this.clearanceInFlight = true;
    try {
      if (!this.deps.hasConfig() || this.latched) return this.localRefusal();
      const route: DatalinkRoute = { key: 'leg-clearance', id: params.plannedLegId };
      const outcome = await this.deps.client.request(route, this.abort.signal);
      if (this.shuttingDown) return error('sidecar-unavailable');
      this.afterWrite(outcome);
      const classified = classifyClearanceOutcome(outcome, this.deps.token());

      if (!classified.ok) {
        if (classified.retry === 'latch') {
          this.applyFailure(classified, routeTemplate(route.key));
          this.emit();
        }
        if (classified.code === 'leg-not-found') {
          // The server says the leg is gone, so a prefiled leg with that id is
          // dropped as it would be for any other write aimed at it.
          if (this.prefiled?.plannedLegId === params.plannedLegId) {
            this.dropPrefiled();
            this.emit();
          }
          this.cycleSoon();
        }
        const status = classified.httpStatus === null ? '---' : String(classified.httpStatus);
        this.deps.log('warn', `Clearance ${classified.code} (HTTP ${status})`);
        return failureOutcome(classified);
      }

      const projected = projectClearance(
        classified.json,
        classified.httpStatus,
        params.plannedLegId,
        this.deps.token(),
      );
      if (!projected.ok) {
        // The rows may exist, so the outcome is unknown; the availability
        // axis is left alone because an op is not a poll.
        this.deps.log('warn', `Clearance bad-response (HTTP ${classified.httpStatus})`);
        return error('bad-response', classified.httpStatus);
      }
      const described = projected.result.created ? 'created' : 'on-file';
      this.deps.log('info', `Clearance ${described} (HTTP ${classified.httpStatus})`);
      return { ok: true, result: projected.result };
    } finally {
      this.clearanceInFlight = false;
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Called after every config reload. Only a reload that produced a valid
   * config clears the invalid-token latch: the user has had the chance to fix
   * the token, so the next attempt is worth making at once.
   */
  onConfigApplied(ok: boolean): void {
    if (this.shuttingDown) return;
    if (ok) {
      // A leg prefiled on another server, or under another token, is not one
      // this configuration can see.
      const prefiled = this.prefiled;
      if (prefiled && (this.deps.serverUrl() !== prefiled.serverUrl || this.deps.token() !== prefiled.token)) {
        this.dropPrefiled();
      }
      this.latched = false;
      this.consecutiveFailures = 0;
      if (this.state === 'dl.token-invalid' || this.state === 'dl.no-config') {
        // Neither claim is true any more; the next cycle says what is.
        this.httpStatus = null;
        this.serverCode = null;
        this.setState(this.watching ? 'dl.pending' : 'dl.idle', null);
      }
      if (this.watching) {
        if (this.cycleInFlight) this.rerunAfterCycle = true;
        else this.startCycle();
      }
    }
    this.emit();
  }

  /** Cancels timers and in-flight requests. Nothing is emitted afterwards. */
  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.cancelTimer();
    this.nextPollAt = null;
    this.abort.abort();
  }

}
