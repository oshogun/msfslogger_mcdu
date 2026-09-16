// tests/datalink-model.test.ts — tests src/datalink-model.ts and the
// datalink-response size guard in src/protocol.ts.
//
// Projection fails closed per row and per field, scrubs the token and caps
// every string. The size tests build the worst cases the caps allow and check
// that the lines they produce still fit the protocol's line limit.

import { describe, expect, it } from 'vitest';
import {
  CANNED_MAX_ENTRIES,
  fillWindow,
  projectCanned,
  projectLoadsheet,
  projectThread,
  projectWx,
  REDACTED,
  THREAD_WINDOW_BUDGET_BYTES,
  THREAD_WINDOW_MAX_MESSAGES,
} from '../src/datalink-model';
import {
  encodeDatalinkResponse,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  type DatalinkMessage,
  type DatalinkOp,
  type DatalinkResults,
} from '../src/protocol';
import { fixture, SENTINEL_TOKEN } from './helpers/datalink-scratch-server';

const flightThread = fixture('03-get-flight-thread').response.body as { messages: Record<string, unknown>[] };
const legThread = fixture('06-get-leg-thread').response.body;

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, flight_id: 92, planned_leg_id: null, direction: 'uplink', category: 'dispatch', label: 'L',
    body: 'B', payload_json: '{"a":1}', correlation_id: null, dedup_key: null,
    sent_at: '2026-09-16T12:00:00.000Z', read_at: null, ...overrides,
  };
}

function responseLine(id: string, result: DatalinkResults[DatalinkOp]): string {
  return encodeDatalinkResponse({ v: PROTOCOL_VERSION as 1, type: 'datalink-response', at: 1789569127113, id, ok: true, result });
}

describe('projectThread', () => {
  it('projects the server sample, oldest first, without payload_json or other unforwarded members', () => {
    const result = projectThread(flightThread, 'flight', SENTINEL_TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.threadPlannedLegId).toBe(12);
    expect(result.droppedRows).toBe(0);
    expect(result.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(result.messages.map((m) => m.id)).toEqual([11, 12, 13, 17, 18]);
    expect(Object.keys(result.messages[2]).sort()).toEqual(
      ['body', 'category', 'correlationId', 'direction', 'id', 'label', 'sentAt', 'seq'].sort(),
    );
    expect(result.messages[4]).toMatchObject({ category: 'wx', correlationId: 17, sentAt: '2026-09-16T14:32:08.001Z' });
    expect(JSON.stringify(result)).not.toContain('payload_json');
    expect(JSON.stringify(result)).not.toContain('dedup');
  });

  it('reads threadPlannedLegId only from a flight thread', () => {
    const result = projectThread(legThread, 'leg', null);
    expect(result.ok && result.threadPlannedLegId).toBe(null);
  });

  it('drops invalid rows, counts them, and assigns seq after dropping', () => {
    const body = {
      messages: [
        row({ id: 1 }),
        'not an object',
        row({ id: 0 }),
        row({ id: 2, direction: 'sideways' }),
        row({ id: 3, body: null }),
        row({ id: 4, sent_at: 5 }),
        row({ id: 5, category: 7 }),
        row({ id: 6, label: 42, correlation_id: -3 }),
      ],
    };
    const result = projectThread(body, 'leg', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedRows).toBe(6);
    expect(result.messages.map((m) => [m.seq, m.id])).toEqual([[0, 1], [1, 6]]);
    expect(result.messages[1]).toMatchObject({ label: null, correlationId: null });
  });

  it('keeps an unknown category as it is: the set is open', () => {
    const result = projectThread({ messages: [row({ category: 'brand-new-kind' })] }, 'leg', null);
    expect(result.ok && result.messages[0].category).toBe('brand-new-kind');
  });

  it('fails the whole projection only when the body has no messages array', () => {
    expect(projectThread({ messages: {} }, 'leg', null).ok).toBe(false);
    expect(projectThread(null, 'flight', null).ok).toBe(false);
  });

  it('caps each field', () => {
    const result = projectThread(
      { messages: [row({ body: 'b'.repeat(5000), label: 'l'.repeat(100), category: 'c'.repeat(50), sent_at: 's'.repeat(60) })] },
      'leg',
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [m] = result.messages;
    expect([m.body.length, m.label?.length, m.category.length, m.sentAt.length]).toEqual([4096, 64, 32, 40]);
  });

  it('scrubs the token out of every forwarded string before capping', () => {
    const body = {
      messages: [
        row({
          body: `TOKEN IS ${SENTINEL_TOKEN} OK`,
          label: SENTINEL_TOKEN,
          category: `x${SENTINEL_TOKEN}`,
          sent_at: SENTINEL_TOKEN,
        }),
        row({ id: 2, body: `${'a'.repeat(4090)}${SENTINEL_TOKEN}` }),
      ],
    };
    const result = projectThread(body, 'leg', SENTINEL_TOKEN);
    const text = JSON.stringify(result);
    expect(text).not.toContain(SENTINEL_TOKEN);
    expect(text).not.toContain('SENTINEL-DATA');
    expect(result.ok && result.messages[0].body).toBe(`TOKEN IS ${REDACTED} OK`);
  });
});

describe('projectCanned', () => {
  it('keeps downlinks with a valid id and label, trimmed and capped, in server order', () => {
    const result = projectCanned(fixture('02-get-canned-messages').response.body, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.truncated).toBe(false);
    expect(result.result.messages).toHaveLength(3);
    expect(result.result.messages.every((m) => Object.keys(m).join() === 'id,label')).toBe(true);

    const mixed = projectCanned(
      {
        messages: [
          { id: 'ok-1', label: '  FIRST  ', direction: 'downlink' },
          { id: 'up-1', label: 'UP', direction: 'uplink' },
          { id: 'bad id', label: 'SPACE', direction: 'downlink' },
          { id: 'ok-2', label: '   ', direction: 'downlink' },
          { id: 'ok-3', label: 'L'.repeat(60), direction: 'downlink' },
          { id: `x${SENTINEL_TOKEN}`, label: 'TOKEN ID', direction: 'downlink' },
        ],
      },
      SENTINEL_TOKEN,
    );
    expect(mixed.ok && mixed.result.messages).toEqual([
      { id: 'ok-1', label: 'FIRST' },
      { id: 'ok-3', label: 'L'.repeat(48) },
    ]);
  });

  it('keeps at most 30 and flags truncation', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ id: `c${i}`, label: `C${i}`, direction: 'downlink' }));
    const result = projectCanned({ messages: many }, null);
    expect(result.ok && result.result.messages.length).toBe(CANNED_MAX_ENTRIES);
    expect(result.ok && result.result.truncated).toBe(true);
    expect(projectCanned({ messages: many.slice(0, 30) }, null)).toMatchObject({ ok: true, result: { truncated: false } });
    expect(projectCanned({}, null).ok).toBe(false);
  });
});

describe('projectWx', () => {
  it('projects available weather', () => {
    const result = projectWx(fixture('05a-post-flight-wx-available').response.body, 'EGLL', null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.icao).toBe('EGLL');
    expect(result.result.available).toBe(true);
    expect(typeof result.result.metar).toBe('string');
  });

  it('available:false with weather:null gives nulls without throwing', () => {
    expect(projectWx(fixture('05b-post-flight-wx-unavailable').response.body, 'ZZZZ', null)).toEqual({
      ok: true,
      result: { icao: 'ZZZZ', available: false, metar: null, taf: null, fetchedAt: null },
    });
  });

  it('rejects a body without the available flag or with a non-object weather', () => {
    expect(projectWx({ icao: 'EGLL' }, 'EGLL', null).ok).toBe(false);
    expect(projectWx({ available: true, weather: 'x' }, 'EGLL', null).ok).toBe(false);
    expect(projectWx({ available: true, icao: 'TOO-LONG-ICAO', weather: null }, 'EGLL', null)).toMatchObject({
      ok: true, result: { icao: 'EGLL' },
    });
  });
});

describe('projectLoadsheet', () => {
  it('maps the sheet by name and derives created from the body', () => {
    const created = projectLoadsheet(fixture('09a-post-leg-loadsheet-created').response.body, 201, 12, null);
    const existing = projectLoadsheet(fixture('09b-post-leg-loadsheet-existing').response.body, 200, 12, null);
    expect(created).toMatchObject({ ok: true, result: { plannedLegId: 12, created: true, httpStatus: 201 } });
    expect(existing).toMatchObject({ ok: true, result: { plannedLegId: 12, created: false, httpStatus: 200 } });
    if (created.ok && existing.ok) expect(existing.result.sheet).toEqual(created.result.sheet);
    expect(created.ok && created.result.sheet).toEqual({
      units: 'kg', blockFuel: 6200, taxiFuel: 200, takeoffFuel: 6000, tripFuel: 3100, payload: 13850,
      payloadSource: 'simbrief', zeroFuelWeight: 56350, zfwSource: 'simbrief', maxZeroFuelWeight: 62500,
      dryOperatingWeight: 42500, takeoffWeight: null,
    });
  });

  it('turns a wrong member type into null without rejecting the sheet', () => {
    const result = projectLoadsheet(
      { sheet: { units: 7, block_fuel: '6200', trip_fuel: Infinity, payload_source: '  a-very-long-source-name ' } },
      201,
      44,
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        plannedLegId: 44,
        created: true,
        sheet: { units: null, blockFuel: null, tripFuel: null, payloadSource: 'a-very-long-sour' },
      },
    });
    expect(projectLoadsheet({ sheet: null }, 200, 1, null).ok).toBe(false);
  });
});

describe('thread windows and the response size guard', () => {
  function cacheOf(count: number, body: (i: number) => string): DatalinkMessage[] {
    return Array.from({ length: count }, (_, i) => ({
      seq: i,
      id: 1_000_000_000 + i,
      direction: 'uplink' as const,
      category: 'c'.repeat(32),
      label: 'l'.repeat(64),
      body: body(i),
      sentAt: 's'.repeat(40),
      correlationId: 9_007_199_254_740_991,
    }));
  }

  it('fills newest first within the byte budget and count, returned oldest first', () => {
    const small = cacheOf(100, (i) => `message ${i}`);
    const window = fillWindow(small, 0, 100);
    expect(window).toHaveLength(THREAD_WINDOW_MAX_MESSAGES);
    expect(window[0].seq).toBe(60);
    expect(window[window.length - 1].seq).toBe(99);

    const offset = fillWindow(small.slice(50), 50, 70);
    expect(offset.map((m) => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 50 + i));
  });

  it('always includes the first message, even one alone over the budget share', () => {
    const control = cacheOf(3, () => ''.repeat(4096));
    const window = fillWindow(control, 0, 3);
    expect(window.length).toBeGreaterThanOrEqual(1);
    expect(window[window.length - 1].seq).toBe(2);
  });

  it('the largest thread response at the caps fits one line (ASCII bodies)', () => {
    const cache = cacheOf(2000, () => 'A'.repeat(4096));
    const messages = fillWindow(cache, 0, 2000);
    const used = messages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)) + 1, 0);
    expect(used).toBeLessThanOrEqual(THREAD_WINDOW_BUDGET_BYTES);
    const line = responseLine('dl-99999999999999999999', {
      epoch: 9_007_199_254_740_991, total: 2000, firstSeq: 0, startSeq: messages[0].seq, endSeq: 2000, messages,
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(JSON.parse(line).ok).toBe(true);
  });

  it('the largest thread response at the caps fits one line (4096 control-character bodies)', () => {
    const cache = cacheOf(2000, () => ''.repeat(4096));
    const messages = fillWindow(cache, 0, 2000);
    const line = responseLine('dl-1', {
      epoch: 1, total: 2000, firstSeq: 0, startSeq: messages[0].seq, endSeq: 2000, messages,
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(JSON.parse(line).ok).toBe(true);
  });

  it('the largest wx and canned responses fit one line', () => {
    const wx = projectWx(
      { icao: 'EGLL', available: true, weather: { metar: ''.repeat(9000), taf: ''.repeat(9000), fetched_at: 'f'.repeat(80) } },
      'EGLL',
      null,
    );
    expect(wx.ok).toBe(true);
    if (wx.ok) expect(Buffer.byteLength(responseLine('dl-2', wx.result))).toBeLessThanOrEqual(MAX_LINE_BYTES);

    const canned = projectCanned(
      { messages: Array.from({ length: 40 }, (_, i) => ({ id: `${i}`.padEnd(64, 'x'), label: ''.repeat(100), direction: 'downlink' })) },
      null,
    );
    expect(canned.ok).toBe(true);
    if (canned.ok) {
      const line = responseLine('dl-3', canned.result);
      expect(JSON.parse(line).ok).toBe(true);
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    }
  });

  it('turns an oversize response into too-large for the same id', () => {
    const line = responseLine('dl-7', {
      epoch: 1, total: 20, firstSeq: 0, startSeq: 0, endSeq: 20, messages: cacheOf(20, () => 'A'.repeat(4096)),
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(JSON.parse(line)).toEqual({
      v: 1, type: 'datalink-response', at: 1789569127113, id: 'dl-7', ok: false,
      error: { code: 'too-large', httpStatus: null, serverCode: null },
    });
  });
});
