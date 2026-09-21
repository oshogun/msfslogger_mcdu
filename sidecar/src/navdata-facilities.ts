// ── Navdata facility session: definitions, dispatch, timeouts, concurrency ────
//
// Everything navdata asks the simulator for goes through one session, created
// when a SimConnect connection opens and destroyed when it drops. The session
// owns four things that are easy to get wrong separately and impossible to get
// right separately:
//
//   * DEFINITIONS ARE PER CONNECTION. Facility definition ids mean nothing
//     across a reconnect, so they are rebuilt from scratch every time and no id
//     is cached. Member names are PROBED, never assumed: every member is
//     UPPER_SNAKE_CASE on the builds measured so far, the mixed-case spellings
//     the SDK table prints are rejected with DATA_ERROR, and a build that
//     rejects a member must still leave a definition that decodes — which it
//     only does if the member list the decoder reads is the one the simulator
//     actually accepted. So: send every candidate, wait for the complaints,
//     rebuild from the survivors, and report what was lost.
//
//   * ONE LISTENER SET, NOT ONE PER REQUEST. A single airport produces
//     thousands of facilityData messages, and a per-request listener array
//     would be scanned for every one of them. Worse, a forgotten off() on an
//     error path is a leak that only shows on a long flight, and raising the
//     listener cap to silence the warning disables a real leak detector in a
//     process that runs for hours. Each reply carries its own request id, so
//     one listener per message type and a Map dispatch is both faster and
//     harder to get wrong.
//
//   * EVERY REQUEST HAS ITS OWN TIMER AND FIVE TERMINAL OUTCOMES. The one that
//     matters: an ambiguous ident answers with a minimal list and then sends
//     NOTHING further — no data, no end marker, ever. A minimal list therefore
//     COMPLETES a request. Waiting for an end marker after one waits for ever.
//
//   * CONCURRENCY IS CAPPED AND GLOBAL. All modes share one connection, so the
//     cap belongs to the connection, not to a mode. Pipelining pays for itself —
//     measured, roughly five times the throughput of sequential requests — but
//     only up to a point, and an uncapped queue would starve the 1 Hz frame
//     loop that shares this link.
//
// Rows are decoded inside the message listener and buffered by the caller, not
// held as message objects: the reader handed to a listener belongs to the
// packet being parsed and is not valid once the listener returns.

import type { SimConnectConnection } from 'node-simconnect';

import type { LogSink } from './uplink';

/** Navdata definition ids start here; 0 and 1 belong to frames and traffic. */
export const NAV_DEFINITION_ID_BASE = 100;
/** Navdata request ids start here; 0 and 1 belong to frames and traffic. */
export const NAV_REQUEST_ID_BASE = 1000;

/** How long the simulator gets to complain about a member name or a send. */
export const SETTLE_MS = 700;
/** Navaid and fix detail: measured max latency 66 ms at full concurrency. */
export const FACILITY_REQUEST_TIMEOUT_MS = 8_000;
/** Airport detail: measured max 108 ms, including a taxi network we skip. */
export const AIRPORT_REQUEST_TIMEOUT_MS = 20_000;
/** A list is finished when it has been quiet this long after the last chunk. */
export const LIST_IDLE_MS = 5_000;
/** The ceiling on a list however its chunks arrive; the world took 133 ms. */
export const LIST_HARD_TIMEOUT_MS = 60_000;
/** In-flight facility requests, across every mode, because they share a link. */
export const FACILITY_CONCURRENCY = 8;

/**
 * Mirrors the SDK's FacilityListType. Spelled out rather than imported so this
 * module pulls nothing from node-simconnect at run time and stays testable
 * against a fake on a machine with no simulator.
 */
export const FACILITY_LIST_AIRPORT = 0;

// ── The messages this module reads, structurally ──────────────────────────────

/** The RawBuffer methods a facility decoder uses. */
export interface FacilityReader {
  remaining(): number;
  readInt32(): number;
  readInt64(): number;
  readFloat32(): number;
  readFloat64(): number;
  readString(length: number): string;
  readStringV(): string;
}

export interface FacilityExceptionMessage {
  readonly exception: number;
  readonly sendId: number;
  readonly index: number;
  readonly exceptionName: string;
}

export interface FacilityDataMessage {
  readonly userRequestId: number;
  /**
   * This record's own id, and its parent's. They are the ONLY way to rebuild
   * the tree a facility definition describes: the definition's member map is
   * keyed by entry name, so an entry opened under several parents — APPROACH_LEG
   * hangs off five — collapses to one key and cannot say which list a record
   * belongs to. Without these, a procedure's legs attach to no parent and the
   * result is a map that looks plausible with its procedures quietly missing.
   */
  readonly uniqueRequestId: number;
  readonly parentUniqueRequestId: number;
  readonly type: number;
  readonly isListItem: boolean;
  readonly itemIndex: number;
  readonly listSize: number;
  /** Valid only for the duration of the listener call. Decode, do not keep. */
  readonly data: FacilityReader;
}

export interface FacilityDataEndMessage {
  readonly userRequestId: number;
}

export interface FacilityMinimalEntry {
  readonly icao: {
    readonly type: string;
    readonly ident: string;
    readonly region: string;
    readonly airport: string;
  };
  readonly latLonAlt: {
    readonly latitude: number;
    readonly longitude: number;
    readonly altitude: number;
  };
}

export interface FacilityMinimalListMessage {
  readonly requestID: number;
  readonly data: readonly FacilityMinimalEntry[];
}

export interface AirportListEntry {
  readonly icao: string;
  readonly region: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number;
}

export interface AirportListMessage {
  readonly requestID: number;
  readonly entryNumber: number;
  readonly outOf: number;
  readonly airports: readonly AirportListEntry[];
}

/** The part of a SimConnect connection navdata uses, and nothing more. */
export interface FacilityConnection {
  on(event: 'exception', listener: (recv: FacilityExceptionMessage) => void): unknown;
  on(event: 'facilityData', listener: (recv: FacilityDataMessage) => void): unknown;
  on(event: 'facilityDataEnd', listener: (recv: FacilityDataEndMessage) => void): unknown;
  on(event: 'facilityMinimalList', listener: (recv: FacilityMinimalListMessage) => void): unknown;
  on(event: 'airportList', listener: (recv: AirportListMessage) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  addToFacilityDefinition(definitionId: number, fieldName: string): number;
  requestFacilityData(
    definitionId: number,
    requestId: number,
    icao: string,
    region?: string,
    type?: 'V' | 'N' | 'W',
  ): number;
  requestFacilitiesList(type: number, requestId: number): number;
}

/**
 * A live SimConnect handle, narrowed. Written as a function rather than a cast
 * so the compatibility is checked when this file is typechecked: a
 * node-simconnect upgrade that changes one of these signatures fails here
 * rather than at some call site.
 */
export function asFacilityConnection(handle: SimConnectConnection): FacilityConnection {
  return handle;
}

// ── Definitions ───────────────────────────────────────────────────────────────

export interface FacilityNodeSpec {
  /** The entry point, e.g. 'AIRPORT' or 'RUNWAY'. */
  readonly entry: string;
  /** Candidate spellings per member, best first; the first accepted one wins. */
  readonly aliases: readonly (readonly string[])[];
  readonly children?: readonly FacilityNodeSpec[];
}

export interface FacilityDefinitionSpec {
  readonly name: string;
  readonly root: FacilityNodeSpec;
}

export interface FacilityDefinition {
  readonly name: string;
  readonly definitionId: number;
  /** Entry point -> the members the simulator accepted, in wire order. */
  readonly members: ReadonlyMap<string, readonly string[]>;
  /** Entry points rejected at OPEN; their children went with them. */
  readonly rejectedEntries: readonly string[];
  /** `ENTRY.MEMBER` spellings the simulator refused. */
  readonly rejectedMembers: readonly string[];
}

// ── Results ───────────────────────────────────────────────────────────────────

/**
 * The five terminal outcomes of a facility request, plus `aborted`.
 *
 * `aborted` is neither `absent` nor `failed`: the link went away mid-fetch, the
 * simulator said nothing about this ident, and recording an absence for it
 * would teach the store a lie that outlives the disconnect.
 */
export type FacilityFetchOutcome =
  | 'ok'
  | 'resolved-ambiguous'
  | 'failed'
  | 'absent'
  | 'partial'
  | 'aborted';

export interface FacilityFetchResult {
  readonly outcome: FacilityFetchOutcome;
  /** Messages delivered for the attempt that settled the request. */
  readonly messages: number;
  readonly minimal: readonly FacilityMinimalEntry[] | null;
  /**
   * The simulator's own exception number, or null when nothing the simulator
   * said settled the request — a timeout, an abort, or a send that threw here.
   *
   * It is beside `exception` rather than parsed out of it because callers
   * BRANCH on which exception this was, and the string is a human-readable
   * rendering that exists to be read in a log. Control flow that pattern-matched
   * the rendering would keep working until someone improved the wording, and
   * then fail silently: the branch would simply stop being taken, and no test
   * that builds the string itself could notice. The number is what the wire
   * carried. The string is for reading.
   */
  readonly exceptionCode: number | null;
  readonly exception: string | null;
  readonly ms: number;
}

export interface FacilityFetchRequest {
  readonly definitionId: number;
  readonly ident: string;
  readonly region?: string;
  readonly icaoType?: 'V' | 'N' | 'W';
  readonly timeoutMs?: number;
  /** Higher runs first when the concurrency cap makes requests queue. */
  readonly priority?: number;
  /** Called for every row, from inside the listener. Decode here; do not write. */
  readonly onMessage?: (recv: FacilityDataMessage) => void;
  /** Called before each attempt: the caller drops anything it has buffered. */
  readonly onAttempt?: () => void;
}

export type FacilityListOutcome = 'ok' | 'timeout' | 'failed' | 'aborted';

export interface FacilityListResult {
  readonly outcome: FacilityListOutcome;
  readonly rows: number;
  readonly outOf: number | null;
  readonly exception: string | null;
  readonly ms: number;
}

export interface AirportListRequest {
  /** Called for every chunk, from inside the listener. Buffer; do not write. */
  readonly onChunk: (
    airports: readonly AirportListEntry[],
    entryNumber: number,
    outOf: number,
  ) => void;
  readonly idleMs?: number;
  readonly hardTimeoutMs?: number;
}

export interface FacilitySessionOptions {
  readonly log?: LogSink;
  readonly now?: () => number;
  readonly settleMs?: number;
  readonly concurrency?: number;
}

// ── The semaphore ─────────────────────────────────────────────────────────────

interface Waiter {
  readonly priority: number;
  readonly seq: number;
  readonly resolve: () => void;
}

/**
 * A counting semaphore that releases to the highest priority waiter, oldest
 * first within a priority. Ordering matters because the modes compete: a user
 * asking for one airport must not wait behind a queue of opportunistic work.
 */
class Semaphore {
  private inFlight = 0;
  private seq = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(priority = 0): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push({ priority, seq: this.seq++, resolve });
    });
  }

  release(): void {
    if (this.waiting.length === 0) {
      this.inFlight = Math.max(0, this.inFlight - 1);
      return;
    }
    let best = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      const candidate = this.waiting[i];
      const leader = this.waiting[best];
      if (
        candidate.priority > leader.priority ||
        (candidate.priority === leader.priority && candidate.seq < leader.seq)
      ) {
        best = i;
      }
    }
    const [winner] = this.waiting.splice(best, 1);
    winner.resolve();
  }

  /** Releases every waiter without a slot; they find the session closed. */
  drain(): void {
    while (this.waiting.length > 0) {
      this.waiting.pop()?.resolve();
    }
    this.inFlight = 0;
  }
}

// ── Pending work ──────────────────────────────────────────────────────────────

interface PendingFetch {
  readonly requestId: number;
  sendId: number | null;
  messages: number;
  minimal: readonly FacilityMinimalEntry[] | null;
  exceptionCode: number | null;
  exception: string | null;
  timer: NodeJS.Timeout | null;
  readonly onMessage?: (recv: FacilityDataMessage) => void;
  settle: (outcome: FacilityFetchOutcome) => void;
}

interface PendingList {
  readonly requestId: number;
  sendId: number | null;
  rows: number;
  outOf: number | null;
  exception: string | null;
  idleTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  readonly idleMs: number;
  readonly onChunk: AirportListRequest['onChunk'];
  settle: (outcome: FacilityListOutcome) => void;
}

function describeException(recv: FacilityExceptionMessage): string {
  return `${recv.exceptionName}(${recv.exception}) index=${recv.index}`;
}

// ── The session ───────────────────────────────────────────────────────────────

export class FacilitySession {
  private readonly handle: FacilityConnection;
  private readonly log: LogSink;
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly slots: Semaphore;

  private nextDefinitionId = NAV_DEFINITION_ID_BASE;
  private nextRequestId = NAV_REQUEST_ID_BASE;

  private readonly fetches = new Map<number, PendingFetch>();
  private readonly lists = new Map<number, PendingList>();
  /** Request ids by the send that started them, so exceptions can be routed. */
  private readonly sends = new Map<number, number>();
  /** Non-null only while a definition pass is collecting its own rejections. */
  private definitionExceptions: Map<number, FacilityExceptionMessage> | null = null;

  private closed = false;
  private definitionsReady: Promise<void> = Promise.resolve();
  private listChain: Promise<unknown> = Promise.resolve();

  private readonly onException = (recv: FacilityExceptionMessage): void => {
    this.definitionExceptions?.set(recv.sendId, recv);
    const requestId = this.sends.get(recv.sendId);
    if (requestId === undefined) return;
    const fetch = this.fetches.get(requestId);
    if (fetch) {
      fetch.exceptionCode = recv.exception;
      fetch.exception = describeException(recv);
      fetch.settle('failed');
      return;
    }
    const list = this.lists.get(requestId);
    if (list) {
      list.exception = describeException(recv);
      list.settle('failed');
    }
  };

  private readonly onFacilityData = (recv: FacilityDataMessage): void => {
    const pending = this.fetches.get(recv.userRequestId);
    if (!pending) return;
    pending.messages++;
    if (pending.onMessage === undefined) return;
    // A decoder that throws is this sidecar's bug, not an answer about the
    // simulator's data, so the request settles as ABORTED: aborted writes
    // nothing and re-queues, where `failed` would record the facility as one
    // this install does not have and make a decoder fault look like missing
    // scenery for as long as the absence stands.
    if (!this.safely(`decoding ${recv.userRequestId}`, () => pending.onMessage?.(recv))) {
      pending.settle('aborted');
    }
  };

  private readonly onFacilityDataEnd = (recv: FacilityDataEndMessage): void => {
    this.fetches.get(recv.userRequestId)?.settle('ok');
  };

  private readonly onFacilityMinimalList = (recv: FacilityMinimalListMessage): void => {
    const pending = this.fetches.get(recv.requestID);
    if (!pending) return;
    // Terminal. An ambiguous ident answers with this list and then sends
    // nothing else at all, so waiting for an end marker after one waits for
    // ever. The candidates it carries are the answer, not a consolation prize.
    pending.minimal = recv.data.slice();
    pending.settle('resolved-ambiguous');
  };

  private readonly onAirportList = (recv: AirportListMessage): void => {
    const pending = this.lists.get(recv.requestID);
    if (!pending) return;
    pending.outOf = recv.outOf;
    pending.rows += recv.airports.length;
    // A list has no absence to record, so a collector that throws is reported
    // as a failed list rather than an aborted one: the reason then says what
    // actually happened instead of blaming the link.
    if (!this.safely(`collecting list ${recv.requestID}`, () => pending.onChunk(recv.airports, recv.entryNumber, recv.outOf), pending)) {
      pending.settle('failed');
      return;
    }
    if (recv.entryNumber >= recv.outOf - 1) {
      pending.settle('ok');
      return;
    }
    this.bumpListIdle(pending);
  };

  constructor(handle: FacilityConnection, options: FacilitySessionOptions = {}) {
    this.handle = handle;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? SETTLE_MS;
    this.slots = new Semaphore(options.concurrency ?? FACILITY_CONCURRENCY);

    handle.on('exception', this.onException);
    handle.on('facilityData', this.onFacilityData);
    handle.on('facilityDataEnd', this.onFacilityDataEnd);
    handle.on('facilityMinimalList', this.onFacilityMinimalList);
    handle.on('airportList', this.onAirportList);
  }

  isOpen(): boolean {
    return !this.closed;
  }

  /**
   * Settles everything in flight as `aborted` and lets go of the handle. A
   * request that was half-read is not half-written: its caller discards what it
   * buffered and re-queues the work, because a disconnect is evidence about the
   * link and about nothing else.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;

    this.handle.off('exception', this.onException as (...args: never[]) => void);
    this.handle.off('facilityData', this.onFacilityData as (...args: never[]) => void);
    this.handle.off('facilityDataEnd', this.onFacilityDataEnd as (...args: never[]) => void);
    this.handle.off('facilityMinimalList', this.onFacilityMinimalList as (...args: never[]) => void);
    this.handle.off('airportList', this.onAirportList as (...args: never[]) => void);

    const fetches = [...this.fetches.values()];
    const lists = [...this.lists.values()];
    if (fetches.length > 0 || lists.length > 0) {
      this.log(
        'debug',
        `navdata: ${reason} — abandoning ${fetches.length} facility request(s) and ${lists.length} list(s)`,
      );
    }
    for (const pending of fetches) pending.settle('aborted');
    for (const pending of lists) pending.settle('aborted');
    this.definitionExceptions = null;
    this.sends.clear();
    this.slots.drain();
  }

  // ── Definitions ─────────────────────────────────────────────────────────────

  /**
   * Builds every definition in one pass and gates all requests behind it.
   *
   * Two passes over the wire, not one. The first sends every candidate spelling
   * and the second rebuilds from the survivors, because a definition containing
   * a rejected member is not the definition the decoder thinks it is — the
   * accepted members are the wire order, and the caller is handed exactly the
   * list the simulator agreed to.
   *
   * It holds the connection exclusively while it runs: rejections arrive
   * asynchronously keyed by the send that caused them, so two overlapping
   * builds could attribute one packet's rejection to the other's member and
   * silently drop something that was fine.
   */
  async prepare(specs: readonly FacilityDefinitionSpec[]): Promise<FacilityDefinition[]> {
    const previous = this.definitionsReady;
    let release = (): void => {};
    this.definitionsReady = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await previous;
    try {
      if (this.closed) return [];
      const probed = await this.emitPass(specs);
      const pruned: FacilityDefinitionSpec[] = [];
      const losses = new Map<string, DefinitionLosses>();
      for (const spec of specs) {
        const result = probed.get(spec.name);
        if (result === undefined) continue;
        const { kept, lost } = pruneSpec(spec.root, result);
        losses.set(spec.name, lost);
        if (kept !== null) pruned.push({ name: spec.name, root: kept });
      }
      const built = await this.emitPass(pruned);

      const definitions: FacilityDefinition[] = [];
      for (const spec of specs) {
        // WHAT WAS LOST IS WHAT THE PROBE PASS FOUND, not what the rebuild
        // found. The rebuild only ever offers survivors, so by construction it
        // can reject almost nothing — reporting it alone would leave both lists
        // empty in exactly the case they exist for, and a build that refused,
        // say, a displaced-threshold member would fetch a reduced tree, store
        // NULLs and say nothing anywhere. An alias the probe rejected while
        // another spelling of the same member was accepted is not a loss and is
        // not reported: only a member with no surviving spelling, and an entry
        // point that could not be kept, are.
        const lost = losses.get(spec.name) ?? { entries: [], members: [] };
        const result = built.get(spec.name);
        if (!result) {
          this.log(
            'warn',
            `navdata: the ${spec.name} facility definition was refused outright — ` +
              `entries [${lost.entries.join(' ')}] members [${lost.members.join(' ')}]`,
          );
          continue;
        }
        const rejectedEntries = union(lost.entries, result.rejectedEntries);
        const rejectedMembers = union(lost.members, result.rejectedMembers);
        if (rejectedEntries.length > 0 || rejectedMembers.length > 0) {
          this.log(
            'info',
            `navdata: the simulator refused part of the ${spec.name} definition — ` +
              `entries [${rejectedEntries.join(' ')}] members [${rejectedMembers.join(' ')}]`,
          );
        }
        definitions.push({
          name: spec.name,
          definitionId: result.definitionId,
          members: result.accepted,
          rejectedEntries,
          rejectedMembers,
        });
      }
      return definitions;
    } finally {
      release();
    }
  }

  private async emitPass(
    specs: readonly FacilityDefinitionSpec[],
  ): Promise<Map<string, PassResult>> {
    const results = new Map<string, PassResult>();
    if (specs.length === 0) return results;

    const collected = new Map<number, FacilityExceptionMessage>();
    this.definitionExceptions = collected;
    const sends: { spec: string; send: DefinitionSend }[] = [];
    const definitionIds = new Map<string, number>();
    try {
      for (const spec of specs) {
        const definitionId = this.nextDefinitionId++;
        definitionIds.set(spec.name, definitionId);
        for (const send of emitNode(this.handle, definitionId, spec.root)) {
          sends.push({ spec: spec.name, send });
        }
      }
      await this.sleep(this.settleMs);
    } finally {
      this.definitionExceptions = null;
    }
    if (this.closed) return results;

    for (const spec of specs) {
      const accepted = new Map<string, string[]>();
      const rejectedEntries: string[] = [];
      const rejectedMembers: string[] = [];
      for (const { spec: name, send } of sends) {
        if (name !== spec.name) continue;
        const failed = collected.has(send.sendId);
        if (send.member === null) {
          if (send.verb !== 'OPEN') continue;
          if (failed) rejectedEntries.push(send.entry);
          // An entry that opened is in the definition even if it carries no
          // member of its own — a node that exists only to hold its children
          // still bounds a record on the wire. An empty list and a missing key
          // must therefore mean different things: "in the tree, no fields" and
          // "not in the tree at all".
          else if (!accepted.has(send.entry)) accepted.set(send.entry, []);
          continue;
        }
        if (failed) rejectedMembers.push(`${send.entry}.${send.member}`);
        else accepted.set(send.entry, [...(accepted.get(send.entry) ?? []), send.member]);
      }
      // An entry point that would not open has no members, whatever the
      // simulator said about the fields that followed it.
      for (const entry of rejectedEntries) accepted.delete(entry);
      results.set(spec.name, {
        definitionId: definitionIds.get(spec.name) as number,
        accepted,
        rejectedEntries,
        rejectedMembers,
      });
    }
    return results;
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  /**
   * One facility request, settled by exactly one terminal outcome.
   *
   * A `partial` — messages arrived but the end marker never did — is retried
   * once, because the rows of a truncated tree are worse than useless: an
   * airport missing the tail of its procedures looks complete. A second
   * `partial` is a failure and is reported as one.
   */
  async fetch(request: FacilityFetchRequest): Promise<FacilityFetchResult> {
    await this.definitionsReady;
    if (this.closed) {
      return {
        outcome: 'aborted',
        messages: 0,
        minimal: null,
        exceptionCode: null,
        exception: null,
        ms: 0,
      };
    }
    await this.slots.acquire(request.priority ?? 0);
    try {
      // Re-read the gate after queueing: a definition pass that started while
      // this request waited for a slot holds the connection exclusively, and
      // issuing into it would make a rejection impossible to attribute.
      await this.definitionsReady;
      if (this.closed) {
        return {
          outcome: 'aborted',
          messages: 0,
          minimal: null,
          exceptionCode: null,
          exception: null,
          ms: 0,
        };
      }
      const first = await this.attempt(request);
      if (first.outcome !== 'partial' || this.closed) return first;
      this.log(
        'debug',
        `navdata: ${request.ident} answered ${first.messages} row(s) with no end marker — retrying once`,
      );
      const second = await this.attempt(request);
      if (second.outcome !== 'partial') return second;
      return { ...second, outcome: 'failed' };
    } finally {
      this.slots.release();
    }
  }

  private attempt(request: FacilityFetchRequest): Promise<FacilityFetchResult> {
    const requestId = this.nextRequestId++;
    const timeoutMs = request.timeoutMs ?? FACILITY_REQUEST_TIMEOUT_MS;
    const started = this.now();

    return new Promise<FacilityFetchResult>((resolve) => {
      // Inside the promise, and guarded. onAttempt is how the caller drops what
      // a previous attempt buffered; a throw from it outside here would reject
      // rather than resolve, and an extraction path that rejects is one the
      // supervisor eventually sees. If the caller cannot clear its buffer there
      // is nothing safe to fetch into, so the attempt is abandoned, not sent.
      if (!this.safely(`preparing ${request.ident}`, () => request.onAttempt?.())) {
        resolve({
          outcome: 'aborted',
          messages: 0,
          minimal: null,
          exceptionCode: null,
          exception: null,
          ms: 0,
        });
        return;
      }
      const pending: PendingFetch = {
        requestId,
        sendId: null,
        messages: 0,
        minimal: null,
        exceptionCode: null,
        exception: null,
        timer: null,
        onMessage: request.onMessage,
        settle: (outcome) => {
          if (!this.fetches.delete(requestId)) return;
          if (pending.timer) clearTimeout(pending.timer);
          if (pending.sendId !== null) this.sends.delete(pending.sendId);
          resolve({
            outcome,
            messages: pending.messages,
            minimal: pending.minimal,
            exceptionCode: pending.exceptionCode,
            exception: pending.exception,
            ms: this.now() - started,
          });
        },
      };
      this.fetches.set(requestId, pending);

      let sendId: number;
      try {
        sendId = this.handle.requestFacilityData(
          request.definitionId,
          requestId,
          request.ident,
          request.region,
          request.icaoType,
        );
      } catch (err) {
        pending.exception = err instanceof Error ? err.message : String(err);
        pending.settle('failed');
        return;
      }
      pending.sendId = sendId;
      this.sends.set(sendId, requestId);

      // Silence is the answer for an ident this install does not have, so the
      // timer is the only thing that can end such a request. Rows with no end
      // marker are a different animal and get their own outcome.
      pending.timer = setTimeout(() => {
        pending.settle(pending.messages === 0 ? 'absent' : 'partial');
      }, timeoutMs);
      pending.timer.unref?.();
    });
  }

  /**
   * The world-wide airport index, from the legacy list call. Lists are
   * serialised against each other and do not take a concurrency slot: there is
   * one of them, it is cheap, and two at once would interleave chunks for no
   * gain.
   */
  requestAirportList(request: AirportListRequest): Promise<FacilityListResult> {
    const run = this.listChain.then(() => this.runList(request));
    this.listChain = run.catch(() => undefined);
    return run;
  }

  private runList(request: AirportListRequest): Promise<FacilityListResult> {
    if (this.closed) {
      return Promise.resolve({ outcome: 'aborted', rows: 0, outOf: null, exception: null, ms: 0 });
    }
    const requestId = this.nextRequestId++;
    const started = this.now();

    return new Promise<FacilityListResult>((resolve) => {
      const pending: PendingList = {
        requestId,
        sendId: null,
        rows: 0,
        outOf: null,
        exception: null,
        idleTimer: null,
        hardTimer: null,
        idleMs: request.idleMs ?? LIST_IDLE_MS,
        onChunk: request.onChunk,
        settle: (outcome) => {
          if (!this.lists.delete(requestId)) return;
          if (pending.idleTimer) clearTimeout(pending.idleTimer);
          if (pending.hardTimer) clearTimeout(pending.hardTimer);
          if (pending.sendId !== null) this.sends.delete(pending.sendId);
          resolve({
            outcome,
            rows: pending.rows,
            outOf: pending.outOf,
            exception: pending.exception,
            ms: this.now() - started,
          });
        },
      };
      this.lists.set(requestId, pending);

      let sendId: number;
      try {
        sendId = this.handle.requestFacilitiesList(FACILITY_LIST_AIRPORT, requestId);
      } catch (err) {
        pending.exception = err instanceof Error ? err.message : String(err);
        pending.settle('failed');
        return;
      }
      pending.sendId = sendId;
      this.sends.set(sendId, requestId);

      pending.hardTimer = setTimeout(() => {
        pending.settle('timeout');
      }, request.hardTimeoutMs ?? LIST_HARD_TIMEOUT_MS);
      pending.hardTimer.unref?.();
      this.bumpListIdle(pending);
    });
  }

  private bumpListIdle(pending: PendingList): void {
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => {
      pending.settle('timeout');
    }, pending.idleMs);
    pending.idleTimer.unref?.();
  }

  /**
   * Runs a caller's callback from inside a SimConnect listener and reports
   * whether it survived. Decoding happens in the listener by necessity — the
   * reader is only valid there — but the callback belongs to another module,
   * and a throw from it must not escape into the event emitter, where it would
   * pass the framed-protocol boundary and reach the supervisor as a dying
   * sidecar. The caller settles the affected request instead.
   */
  private safely(label: string, fn: () => void, sink?: { exception: string | null }): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (sink) sink.exception = message;
      this.log('error', `navdata: ${label} threw — ${message}`);
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

// ── Definition plumbing ───────────────────────────────────────────────────────

interface DefinitionSend {
  readonly entry: string;
  readonly verb: 'OPEN' | 'CLOSE' | 'FIELD';
  readonly member: string | null;
  readonly sendId: number;
}

interface PassResult {
  readonly definitionId: number;
  readonly accepted: Map<string, string[]>;
  readonly rejectedEntries: readonly string[];
  readonly rejectedMembers: readonly string[];
}

function emitNode(
  handle: FacilityConnection,
  definitionId: number,
  node: FacilityNodeSpec,
  sends: DefinitionSend[] = [],
): DefinitionSend[] {
  sends.push({
    entry: node.entry,
    verb: 'OPEN',
    member: null,
    sendId: handle.addToFacilityDefinition(definitionId, `OPEN ${node.entry}`),
  });
  for (const group of node.aliases) {
    for (const member of group) {
      sends.push({
        entry: node.entry,
        verb: 'FIELD',
        member,
        sendId: handle.addToFacilityDefinition(definitionId, member),
      });
    }
  }
  for (const child of node.children ?? []) emitNode(handle, definitionId, child, sends);
  sends.push({
    entry: node.entry,
    verb: 'CLOSE',
    member: null,
    sendId: handle.addToFacilityDefinition(definitionId, `CLOSE ${node.entry}`),
  });
  return sends;
}

/** What pruning a spec cost: entries that could not be kept, members with no
 *  surviving spelling. */
export interface DefinitionLosses {
  readonly entries: string[];
  readonly members: string[];
}

export interface PrunedSpec {
  /** The spec to rebuild from, or null when nothing of it survived. */
  readonly kept: FacilityNodeSpec | null;
  readonly lost: DefinitionLosses;
}

/**
 * Prunes a spec down to what the simulator accepted AND records what that cost,
 * in ONE traversal.
 *
 * The two answers are deliberately not two functions. They are the same walk
 * asked two ways — "what is left" and "what went" — and a second traversal
 * carrying the same rules is the shape of bug this whole codebase keeps paying
 * for: two copies of a rule that agree until someone edits one. Here the
 * symptom of a drift would be a lost member going unreported, which is exactly
 * the silence the reporting exists to break.
 *
 * The rules, once: an entry point the simulator refused to open takes its
 * children with it, because there is nowhere to hang them. A member is kept at
 * its first surviving spelling and is lost only when no spelling survived. A
 * node left holding neither a member nor a child is dropped and reported by
 * name — not as a list of everything that was under it.
 */
function pruneSpec(root: FacilityNodeSpec, result: PassResult): PrunedSpec {
  const rejectedMembers = new Set(result.rejectedMembers);
  const rejectedEntries = new Set(result.rejectedEntries);
  const lost: DefinitionLosses = { entries: [], members: [] };

  const walk = (node: FacilityNodeSpec): FacilityNodeSpec | null => {
    if (rejectedEntries.has(node.entry)) {
      lost.entries.push(node.entry);
      return null;
    }

    const aliases: string[][] = [];
    const missing: string[] = [];
    for (const group of node.aliases) {
      const survivor = group.find((member) => !rejectedMembers.has(`${node.entry}.${member}`));
      if (survivor !== undefined) aliases.push([survivor]);
      else if (group.length > 0) missing.push(`${node.entry}.${group[0]}`);
    }

    const children = (node.children ?? [])
      .map(walk)
      .filter((child): child is FacilityNodeSpec => child !== null);

    if (aliases.length === 0 && children.length === 0) {
      // Nothing left to hang on it. The node goes, and it is reported once by
      // name rather than as every member that was under it.
      lost.entries.push(node.entry);
      return null;
    }

    lost.members.push(...missing);
    return { entry: node.entry, aliases, children };
  };

  return { kept: walk(root), lost };
}

/** Distinct values of two lists, first list first. */
function union(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])];
}
