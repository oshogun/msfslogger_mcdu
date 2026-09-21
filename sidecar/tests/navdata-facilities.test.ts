// tests/navdata-facilities.test.ts — tests src/navdata-facilities.ts against a
// fake SimConnect handle. No simulator is involved and none is needed: what is
// being pinned down here is the request discipline, not the data.
//
// Four things matter enough to test one by one.
//
// 1. Member names are probed, not assumed. A build that refuses a spelling must
//    leave a definition whose accepted member list is what the decoder will be
//    handed, and an entry point that would not open must take its children with
//    it rather than leaving them hanging on nothing.
// 2. The five terminal outcomes, especially the minimal list. An ambiguous
//    ident answers with one and then goes silent for ever, so treating it as
//    anything other than a completed request hangs the queue behind it.
// 3. One listener set per connection, whatever the number of requests, and
//    nothing left attached after a close.
// 4. Nothing outlives the connection. A drop settles every request as aborted —
//    not absent, not failed — because a disconnect is evidence about the link
//    and says nothing at all about the simulator's data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FacilitySession,
  NAV_DEFINITION_ID_BASE,
  NAV_REQUEST_ID_BASE,
  type FacilityDefinitionSpec,
  type FacilityNodeSpec,
} from '../src/navdata-facilities';
import { FakeFacilityConnection, airportRow } from './helpers/fake-facility-connection';

const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0).then(() => undefined);
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(1_400).then(() => undefined);

let handle: FakeFacilityConnection;
let session: FacilitySession;
const logged: string[] = [];
const log = (level: string, message: string): void => {
  logged.push(`${level} ${message}`);
};

beforeEach(() => {
  vi.useFakeTimers();
  logged.length = 0;
  handle = new FakeFacilityConnection();
  session = new FacilitySession(handle, { settleMs: 700, log: log as never });
});

afterEach(() => {
  session.close('test over');
  vi.useRealTimers();
});

const AIRPORT_SPEC: FacilityDefinitionSpec = {
  name: 'airport',
  root: {
    entry: 'AIRPORT',
    aliases: [['LATITUDE', 'Latitude'], ['LONGITUDE'], ['MAGVAR']],
    children: [
      { entry: 'RUNWAY', aliases: [['PRIMARY_NUMBER'], ['HEADING']] },
      { entry: 'FREQUENCY', aliases: [['NAME']] },
    ],
  },
};

describe('definition building', () => {
  it('probes every candidate spelling and rebuilds from the survivors', async () => {
    handle.rejectedMembers.add('Latitude');
    const building = session.prepare([AIRPORT_SPEC]);
    await settle();
    const [definition] = await building;

    // The probe pass offered both spellings; the build pass offered only the
    // one the simulator accepted.
    const probeId = NAV_DEFINITION_ID_BASE;
    const buildId = NAV_DEFINITION_ID_BASE + 1;
    const sentTo = (id: number): string[] =>
      handle.definitionSends.filter((s) => s.definitionId === id).map((s) => s.fieldName);
    expect(sentTo(probeId)).toContain('Latitude');
    expect(sentTo(buildId)).not.toContain('Latitude');
    expect(sentTo(buildId)).toEqual([
      'OPEN AIRPORT',
      'LATITUDE',
      'LONGITUDE',
      'MAGVAR',
      'OPEN RUNWAY',
      'PRIMARY_NUMBER',
      'HEADING',
      'CLOSE RUNWAY',
      'OPEN FREQUENCY',
      'NAME',
      'CLOSE FREQUENCY',
      'CLOSE AIRPORT',
    ]);

    expect(definition.definitionId).toBe(buildId);
    expect(definition.members.get('AIRPORT')).toEqual(['LATITUDE', 'LONGITUDE', 'MAGVAR']);
    expect(definition.members.get('RUNWAY')).toEqual(['PRIMARY_NUMBER', 'HEADING']);
    // A spelling refused while another spelling of the same member was
    // accepted is the alias mechanism working, not a loss, and is not reported.
    expect(definition.rejectedMembers).toEqual([]);
    expect(definition.rejectedEntries).toEqual([]);
  });

  it('reports a member it lost, rather than reporting the rebuild it pruned', async () => {
    handle.rejectedMembers.add('MAGVAR');
    const building = session.prepare([AIRPORT_SPEC]);
    await settle();
    const [definition] = await building;

    expect(definition.members.get('AIRPORT')).toEqual(['LATITUDE', 'LONGITUDE']);
    // The rebuild never offers a member the probe lost, so it can never reject
    // one: taking the answer from the rebuild alone would report nothing at all
    // and a reduced tree would store NULLs in silence.
    expect(definition.rejectedMembers).toEqual(['AIRPORT.MAGVAR']);
    expect(logged.some((line) => line.includes('AIRPORT.MAGVAR'))).toBe(true);
  });

  it('reports a member whose every spelling was refused', async () => {
    handle.rejectedMembers.add('LATITUDE');
    handle.rejectedMembers.add('Latitude');
    const building = session.prepare([AIRPORT_SPEC]);
    await settle();
    const [definition] = await building;

    expect(definition.members.get('AIRPORT')).toEqual(['LONGITUDE', 'MAGVAR']);
    expect(definition.rejectedMembers).toEqual(['AIRPORT.LATITUDE']);
  });

  it('reports a member the build pass refuses after the probe accepted it', async () => {
    const building = session.prepare([AIRPORT_SPEC]);
    // The probe pass accepts everything, so the rebuild carries HEADING; the
    // simulator refuses it only the second time. Leaving it in the accepted
    // list would have the decoder reading one member too many for every runway.
    await vi.advanceTimersByTimeAsync(700);
    const rebuilt = handle.definitionSends.filter((send) => send.definitionId === 101);
    const heading = rebuilt.find((send) => send.fieldName === 'HEADING');
    handle.emitException(heading?.sendId as number);
    await vi.advanceTimersByTimeAsync(700);
    const [definition] = await building;

    expect(definition.members.get('RUNWAY')).toEqual(['PRIMARY_NUMBER']);
    expect(definition.rejectedMembers).toEqual(['RUNWAY.HEADING']);
  });

  it('drops an entry point that would not open, and its children with it', async () => {
    handle.rejectedEntries.add('RUNWAY');
    const building = session.prepare([AIRPORT_SPEC]);
    await settle();
    const [definition] = await building;

    expect(definition.rejectedEntries).toEqual(['RUNWAY']);
    expect(definition.members.has('RUNWAY')).toBe(false);
    expect(definition.members.get('FREQUENCY')).toEqual(['NAME']);
    const buildSends = handle.definitionSends
      .filter((s) => s.definitionId === definition.definitionId)
      .map((s) => s.fieldName);
    expect(buildSends).not.toContain('OPEN RUNWAY');
    expect(buildSends).not.toContain('PRIMARY_NUMBER');
  });

  it('starts definition ids at 100 and request ids at 1000', async () => {
    const building = session.prepare([AIRPORT_SPEC]);
    await settle();
    await building;
    expect(handle.definitionSends[0].definitionId).toBe(100);

    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ' });
    await flush();
    expect(handle.dataRequests[0].requestId).toBe(NAV_REQUEST_ID_BASE);
    handle.emitDataEnd(NAV_REQUEST_ID_BASE);
    await fetching;
  });

  it('issues no request until the definition pass has settled', async () => {
    const building = session.prepare([AIRPORT_SPEC]);
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ' });
    await flush();
    expect(handle.dataRequests).toHaveLength(0);

    await settle();
    await building;
    await flush();
    expect(handle.dataRequests).toHaveLength(1);

    handle.emitDataEnd(handle.lastDataRequestId() as number);
    expect((await fetching).outcome).toBe('ok');
  });
});

describe('terminal outcomes', () => {
  it('ends on the end marker, counting the rows it saw', async () => {
    const rows: number[] = [];
    const fetching = session.fetch({
      definitionId: 101,
      ident: 'ZZZZ',
      onMessage: (recv) => rows.push(recv.itemIndex),
    });
    await flush();
    const requestId = handle.lastDataRequestId() as number;
    handle.emitData(requestId, 3);
    handle.emitDataEnd(requestId);

    const result = await fetching;
    expect(result.outcome).toBe('ok');
    expect(result.messages).toBe(3);
    expect(rows).toEqual([0, 1, 2]);
  });

  it('treats a minimal list as terminal and does not wait for an end marker', async () => {
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZV' });
    await flush();
    const requestId = handle.lastDataRequestId() as number;
    handle.emitMinimalList(requestId, [
      {
        icao: { type: 'V', ident: 'ZZV', region: 'ZQ', airport: '' },
        latLonAlt: { latitude: 10.25, longitude: 20.75, altitude: 0 },
      },
    ]);

    const result = await fetching;
    expect(result.outcome).toBe('resolved-ambiguous');
    expect(result.minimal).toHaveLength(1);
    expect(result.minimal?.[0].icao.region).toBe('ZQ');
    // Had it kept waiting, this is where it would have hung for ever.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('fails on an exception carrying the send id of this request', async () => {
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ' });
    await flush();
    handle.emitException(handle.dataRequests[0].sendId, 'DATA_ERROR', 20, 3);

    const result = await fetching;
    expect(result.outcome).toBe('failed');
    expect(result.exception).toBe('DATA_ERROR(20) index=3');
    // The number, beside the sentence. A caller that branches on WHICH
    // exception this was reads the code; the string is for reading in a log,
    // and rewording it must never change what any caller decides.
    expect(result.exceptionCode).toBe(20);
  });

  it('reports no exception code when nothing the simulator said settled it', async () => {
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ', timeoutMs: 8_000 });
    await flush();
    await vi.advanceTimersByTimeAsync(8_000);

    const result = await fetching;
    expect(result.outcome).toBe('absent');
    // Silence is not exception zero. A caller comparing the code against a
    // real exception number must not match a request the simulator ignored.
    expect(result.exceptionCode).toBeNull();
  });

  it('ignores an exception belonging to some other send', async () => {
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ' });
    await flush();
    handle.emitException(handle.dataRequests[0].sendId + 500);
    await vi.advanceTimersByTimeAsync(7_999);
    handle.emitDataEnd(handle.lastDataRequestId() as number);
    expect((await fetching).outcome).toBe('ok');
  });

  it('is absent when the timer fires with no message at all', async () => {
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ', timeoutMs: 8_000 });
    await flush();
    await vi.advanceTimersByTimeAsync(8_000);

    const result = await fetching;
    expect(result.outcome).toBe('absent');
    expect(result.messages).toBe(0);
  });

  it('retries a partial once and fails on the second, telling the caller to discard', async () => {
    let attempts = 0;
    const fetching = session.fetch({
      definitionId: 101,
      ident: 'ZZZZ',
      timeoutMs: 8_000,
      onAttempt: () => attempts++,
    });
    await flush();
    handle.emitData(handle.lastDataRequestId() as number, 2);
    await vi.advanceTimersByTimeAsync(8_000);
    await flush();

    expect(attempts).toBe(2);
    expect(handle.dataRequests).toHaveLength(2);
    // Each attempt gets its own request id, so the first one's stragglers
    // cannot be counted against the second.
    expect(handle.dataRequests[1].requestId).toBe(handle.dataRequests[0].requestId + 1);

    handle.emitData(handle.lastDataRequestId() as number, 1);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await fetching;
    expect(result.outcome).toBe('failed');
  });

  it('settles a partial retry that succeeds', async () => {
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ', timeoutMs: 8_000 });
    await flush();
    handle.emitData(handle.lastDataRequestId() as number, 2);
    await vi.advanceTimersByTimeAsync(8_000);
    await flush();
    handle.emitDataEnd(handle.lastDataRequestId() as number);
    expect((await fetching).outcome).toBe('ok');
  });

  it('aborts, rather than recording an absence, when the link drops mid-fetch', async () => {
    const fetching = session.fetch({ definitionId: 101, ident: 'ZZZZ' });
    await flush();
    handle.emitData(handle.lastDataRequestId() as number, 5);
    session.close('SimConnect disconnected');

    const result = await fetching;
    expect(result.outcome).toBe('aborted');
    expect(session.isOpen()).toBe(false);
  });

  it('answers a request made after the link dropped without touching the handle', async () => {
    session.close('SimConnect disconnected');
    const result = await session.fetch({ definitionId: 101, ident: 'ZZZZ' });
    expect(result.outcome).toBe('aborted');
    expect(handle.dataRequests).toHaveLength(0);
  });
});

describe('a callback that throws', () => {
  it('does not escape the facility data listener, and settles as aborted', async () => {
    const fetching = session.fetch({
      definitionId: 101,
      ident: 'ZZZZ',
      onMessage: () => {
        throw new Error('decoder blew up');
      },
    });
    await flush();
    const requestId = handle.lastDataRequestId() as number;
    // If the throw escaped, this emit would throw out of the test.
    expect(() => handle.emitData(requestId, 1)).not.toThrow();

    const result = await fetching;
    // Aborted, not failed: a decoder fault is this sidecar's bug and must not
    // be recorded as the simulator not having the facility.
    expect(result.outcome).toBe('aborted');
    expect(logged.some((line) => line.includes('decoder blew up'))).toBe(true);
  });

  it('does not escape the list listener, and fails the list', async () => {
    const listing = session.requestAirportList({
      onChunk: () => {
        throw new Error('collector blew up');
      },
    });
    await flush();
    const requestId = handle.lastListRequestId() as number;
    expect(() => handle.emitAirportChunk(requestId, [airportRow('AAAA', 1, 2)], 0, 1)).not.toThrow();

    const result = await listing;
    expect(result.outcome).toBe('failed');
    expect(result.exception).toBe('collector blew up');
  });

  it('resolves rather than rejects when onAttempt throws, and sends nothing', async () => {
    const result = await session.fetch({
      definitionId: 101,
      ident: 'ZZZZ',
      onAttempt: () => {
        throw new Error('buffer reset blew up');
      },
    });

    expect(result.outcome).toBe('aborted');
    expect(handle.dataRequests).toHaveLength(0);
    expect(logged.some((line) => line.includes('buffer reset blew up'))).toBe(true);
  });
});

describe('one listener set per connection', () => {
  it('attaches exactly one listener per message type, however many requests run', async () => {
    const pending = [
      session.fetch({ definitionId: 101, ident: 'AAAA' }),
      session.fetch({ definitionId: 101, ident: 'BBBB' }),
      session.fetch({ definitionId: 101, ident: 'CCCC' }),
    ];
    await flush();
    for (const event of ['exception', 'facilityData', 'facilityDataEnd', 'facilityMinimalList', 'airportList']) {
      expect(handle.listenerCount(event)).toBe(1);
    }

    session.close('test');
    await Promise.all(pending);
    for (const event of ['exception', 'facilityData', 'facilityDataEnd', 'facilityMinimalList', 'airportList']) {
      expect(handle.listenerCount(event)).toBe(0);
    }
  });

  it('routes each reply to its own request', async () => {
    const seen = new Map<string, number>();
    const first = session.fetch({
      definitionId: 101,
      ident: 'AAAA',
      onMessage: () => seen.set('AAAA', (seen.get('AAAA') ?? 0) + 1),
    });
    const second = session.fetch({
      definitionId: 101,
      ident: 'BBBB',
      onMessage: () => seen.set('BBBB', (seen.get('BBBB') ?? 0) + 1),
    });
    await flush();
    const [a, b] = handle.dataRequests;
    handle.emitData(a.requestId, 4);
    handle.emitData(b.requestId, 1);
    handle.emitDataEnd(b.requestId);
    handle.emitDataEnd(a.requestId);

    expect((await first).messages).toBe(4);
    expect((await second).messages).toBe(1);
    expect(seen.get('AAAA')).toBe(4);
    expect(seen.get('BBBB')).toBe(1);
  });
});

describe('concurrency', () => {
  it('keeps at most the cap in flight and starts the next as one settles', async () => {
    const capped = new FacilitySession(handle, { settleMs: 700, concurrency: 2 });
    const pending = ['AAAA', 'BBBB', 'CCCC'].map((ident) =>
      capped.fetch({ definitionId: 101, ident }),
    );
    await flush();
    expect(handle.dataRequests).toHaveLength(2);

    handle.emitDataEnd(handle.dataRequests[0].requestId);
    await flush();
    expect(handle.dataRequests).toHaveLength(3);
    expect(handle.dataRequests[2].ident).toBe('CCCC');

    capped.close('test');
    await Promise.all(pending);
  });

  it('holds a queued request back for a definition pass that started while it waited', async () => {
    const capped = new FacilitySession(handle, { settleMs: 700, concurrency: 1, log: log as never });
    const first = capped.fetch({ definitionId: 101, ident: 'AAAA' });
    const second = capped.fetch({ definitionId: 101, ident: 'BBBB' });
    await flush();
    expect(handle.dataRequests).toHaveLength(1);

    // The definition pass starts while BBBB is queued for a slot.
    const building = capped.prepare([AIRPORT_SPEC]);
    handle.emitDataEnd(handle.dataRequests[0].requestId);
    await first;
    await flush();
    // BBBB now holds the slot, but the connection is busy being defined.
    expect(handle.dataRequests).toHaveLength(1);

    await settle();
    await building;
    await flush();
    expect(handle.dataRequests).toHaveLength(2);
    expect(handle.dataRequests[1].ident).toBe('BBBB');

    capped.close('test');
    await second;
  });

  it('lets a higher priority request past a queue of ordinary ones', async () => {
    const capped = new FacilitySession(handle, { settleMs: 700, concurrency: 1 });
    const pending = [
      capped.fetch({ definitionId: 101, ident: 'AAAA' }),
      capped.fetch({ definitionId: 101, ident: 'BBBB' }),
      capped.fetch({ definitionId: 101, ident: 'CCCC' }),
      capped.fetch({ definitionId: 101, ident: 'DDDD', priority: 10 }),
    ];
    await flush();
    expect(handle.dataRequests.map((r) => r.ident)).toEqual(['AAAA']);

    handle.emitDataEnd(handle.dataRequests[0].requestId);
    await flush();
    expect(handle.dataRequests.map((r) => r.ident)).toEqual(['AAAA', 'DDDD']);

    handle.emitDataEnd(handle.dataRequests[1].requestId);
    await flush();
    expect(handle.dataRequests.map((r) => r.ident)).toEqual(['AAAA', 'DDDD', 'BBBB']);

    capped.close('test');
    await Promise.all(pending);
  });
});

describe('the airport list', () => {
  it('collects chunks and ends on the last chunk the simulator sends', async () => {
    const collected: string[] = [];
    const listing = session.requestAirportList({
      onChunk: (airports) => collected.push(...airports.map((a) => a.icao)),
    });
    await flush();
    const requestId = handle.lastListRequestId() as number;
    handle.emitAirportChunk(requestId, [airportRow('AAAA', 1, 2)], 0, 3);
    handle.emitAirportChunk(requestId, [airportRow('BBBB', 3, 4)], 1, 3);
    handle.emitAirportChunk(requestId, [airportRow('CCCC', 5, 6)], 2, 3);

    const result = await listing;
    expect(result.outcome).toBe('ok');
    expect(result.rows).toBe(3);
    expect(result.outOf).toBe(3);
    expect(collected).toEqual(['AAAA', 'BBBB', 'CCCC']);
  });

  it('ignores chunks addressed to another request', async () => {
    const listing = session.requestAirportList({ onChunk: () => {} });
    await flush();
    const requestId = handle.lastListRequestId() as number;
    handle.emitAirportChunk(requestId + 7, [airportRow('XXXX', 1, 2)], 0, 1);
    handle.emitAirportChunk(requestId, [airportRow('AAAA', 1, 2)], 0, 1);

    const result = await listing;
    expect(result.rows).toBe(1);
  });

  it('times out when the chunks stop before the last one', async () => {
    const listing = session.requestAirportList({ onChunk: () => {}, idleMs: 5_000 });
    await flush();
    const requestId = handle.lastListRequestId() as number;
    handle.emitAirportChunk(requestId, [airportRow('AAAA', 1, 2)], 0, 99);
    await vi.advanceTimersByTimeAsync(4_999);
    handle.emitAirportChunk(requestId, [airportRow('BBBB', 1, 2)], 1, 99);
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await listing;
    expect(result.outcome).toBe('timeout');
    expect(result.rows).toBe(2);
  });

  it('gives up at the hard ceiling even while chunks keep arriving', async () => {
    const listing = session.requestAirportList({
      onChunk: () => {},
      idleMs: 5_000,
      hardTimeoutMs: 12_000,
    });
    await flush();
    const requestId = handle.lastListRequestId() as number;
    for (let i = 0; i < 5; i++) {
      handle.emitAirportChunk(requestId, [airportRow(`A${i}AA`, 1, 2)], i, 99);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect((await listing).outcome).toBe('timeout');
  });

  it('fails on an exception for the list send', async () => {
    const listing = session.requestAirportList({ onChunk: () => {} });
    await flush();
    handle.emitException(handle.listRequests[0].sendId, 'UNRECOGNIZED_ID', 1, 0);

    const result = await listing;
    expect(result.outcome).toBe('failed');
    expect(result.exception).toBe('UNRECOGNIZED_ID(1) index=0');
  });

  it('fails without throwing when the send itself throws', async () => {
    handle.listSendError = new Error('Unsupported protocol version');
    const result = await session.requestAirportList({ onChunk: () => {} });
    expect(result.outcome).toBe('failed');
    expect(result.exception).toBe('Unsupported protocol version');
  });

  it('aborts an in-flight list when the link drops', async () => {
    const listing = session.requestAirportList({ onChunk: () => {} });
    await flush();
    handle.emitAirportChunk(handle.lastListRequestId() as number, [airportRow('AAAA', 1, 2)], 0, 99);
    session.close('SimConnect disconnected');

    const result = await listing;
    expect(result.outcome).toBe('aborted');
    expect(result.rows).toBe(1);
  });

  it('serialises lists against each other', async () => {
    const first = session.requestAirportList({ onChunk: () => {} });
    const second = session.requestAirportList({ onChunk: () => {} });
    await flush();
    expect(handle.listRequests).toHaveLength(1);

    handle.emitAirportChunk(handle.lastListRequestId() as number, [airportRow('AAAA', 1, 2)], 0, 1);
    await first;
    await flush();
    expect(handle.listRequests).toHaveLength(2);

    handle.emitAirportChunk(handle.lastListRequestId() as number, [airportRow('BBBB', 1, 2)], 0, 1);
    expect((await second).outcome).toBe('ok');
  });
});

// ── The pruning contract, over generated specs ────────────────────────────────
//
// Pruning a spec and reporting what pruning cost are ONE traversal in the
// source, so there is no second copy of the rules for a future edit to drift
// from. What is left to go wrong is the contract itself, and these specs check
// it end to end rather than checking one function against another: whatever the
// shape of the tree and whatever the simulator refuses, nothing that was
// dropped may go unreported, and nothing reported may turn up in the definition
// the decoder is handed.
//
// Rejection is decided BY NAME, so the fake gives the same verdict in the probe
// pass and the rebuild. A fake that rejected at random would report mismatches
// that are artifacts of the fake, not defects.

/** Deterministic PRNG, so a failure here is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GeneratedSpec {
  readonly root: FacilityNodeSpec;
  readonly nodes: { node: FacilityNodeSpec; ancestors: string[] }[];
  readonly memberNames: string[];
  readonly entryNames: string[];
}

function generateSpec(random: () => number): GeneratedSpec {
  let entries = 0;
  let members = 0;
  const nodes: GeneratedSpec['nodes'] = [];
  const memberNames: string[] = [];
  const entryNames: string[] = [];

  const build = (depth: number, ancestors: string[]): FacilityNodeSpec => {
    const entry = `E${entries++}`;
    entryNames.push(entry);
    const aliases: string[][] = [];
    const groups = Math.floor(random() * 4);
    for (let g = 0; g < groups; g++) {
      const spellings = 1 + Math.floor(random() * 3);
      const group: string[] = [];
      const id = members++;
      for (let c = 0; c < spellings; c++) {
        const name = `M${id}_${c}`;
        group.push(name);
        memberNames.push(name);
      }
      aliases.push(group);
    }
    const children: FacilityNodeSpec[] = [];
    const childCount = depth >= 3 ? 0 : Math.floor(random() * 3);
    const node: FacilityNodeSpec = { entry, aliases, children };
    for (let c = 0; c < childCount; c++) children.push(build(depth + 1, [...ancestors, entry]));
    nodes.push({ node, ancestors });
    return node;
  };

  const root = build(0, []);
  return { root, nodes, memberNames, entryNames };
}

describe('pruning and reporting are one traversal', () => {
  it('never drops something it does not report, over generated specs', async () => {
    const random = mulberry32(20260920);
    let lostSomething = 0;
    let entryLosses = 0;
    let memberLosses = 0;
    const iterations = 120;

    for (let i = 0; i < iterations; i++) {
      const generated = generateSpec(random);
      const local = new FakeFacilityConnection();
      for (const name of generated.memberNames) {
        if (random() < 0.25) local.rejectedMembers.add(name);
      }
      for (const name of generated.entryNames) {
        if (random() < 0.12) local.rejectedEntries.add(name);
      }
      const built = new FacilitySession(local, { settleMs: 1, log: log as never });
      const building = built.prepare([{ name: 'generated', root: generated.root }]);
      await vi.advanceTimersByTimeAsync(10);
      const [definition] = await building;
      built.close('iteration over');

      if (definition === undefined) {
        // The whole tree went. That is a loss, and it is reported in the line
        // the caller gets instead of a definition.
        lostSomething++;
        expect(logged.some((line) => line.includes('refused outright'))).toBe(true);
        continue;
      }

      const reportedEntries = new Set(definition.rejectedEntries);
      const reportedMembers = new Set(definition.rejectedMembers);
      if (reportedEntries.size > 0) entryLosses++;
      if (reportedMembers.size > 0) memberLosses++;
      if (reportedEntries.size > 0 || reportedMembers.size > 0) lostSomething++;

      for (const { node, ancestors } of generated.nodes) {
        const kept = definition.members.get(node.entry);
        if (kept === undefined) {
          // Dropped. Either it was reported by name, or an ancestor was — an
          // entry point that would not open takes its children with it and is
          // reported once.
          const covered =
            reportedEntries.has(node.entry) ||
            ancestors.some((ancestor) => reportedEntries.has(ancestor));
          expect(
            covered,
            `${node.entry} was dropped from spec ${i} and nothing reported it`,
          ).toBe(true);
          continue;
        }

        let expectedKept = 0;
        for (const group of node.aliases) {
          const survivors = group.filter((member) => !local.rejectedMembers.has(member));
          if (survivors.length > 0) {
            expect(kept, `${node.entry} in spec ${i}`).toContain(survivors[0]);
            expectedKept++;
          } else {
            expect(
              reportedMembers.has(`${node.entry}.${group[0]}`),
              `${node.entry}.${group[0]} in spec ${i} lost every spelling unreported`,
            ).toBe(true);
          }
        }
        // Exactly one surviving spelling per member, and nothing else.
        expect(kept).toHaveLength(expectedKept);
      }

      // Nothing reported as lost may be in the definition the decoder reads.
      for (const reported of reportedMembers) {
        const [entry, member] = [
          reported.slice(0, reported.indexOf('.')),
          reported.slice(reported.indexOf('.') + 1),
        ];
        expect(definition.members.get(entry) ?? []).not.toContain(member);
      }
      for (const entry of reportedEntries) {
        expect(definition.members.has(entry)).toBe(false);
      }
    }

    // Non-vacuous: most of these specs must actually lose something, and both
    // kinds of loss must occur, or the assertions above never ran.
    expect(lostSomething).toBeGreaterThan(iterations / 4);
    expect(entryLosses).toBeGreaterThan(0);
    expect(memberLosses).toBeGreaterThan(0);
  });
});
