// tests/datalink-scope.test.ts — tests src/datalink-scope.ts.
//
// The server froze the scope rule; these rows walk it step by step with the
// server's own sample bodies where one exists.

import { describe, expect, it } from 'vitest';
import { selectScope } from '../src/datalink-scope';
import { selectScopeWithPrefile } from '../src/datalink-scope';
import { fixture } from './helpers/datalink-scratch-server';

const flying = fixture('01a-get-status-flying').response.body as Record<string, unknown>;
const groundLeg = fixture('01b-get-status-ground-leg').response.body as Record<string, unknown>;
const groundNoLeg = fixture('01c-get-status-ground-no-leg').response.body as Record<string, unknown>;
const sessionOpen = fixture('10a-get-ground-session-open').response.body;
const sessionNone = fixture('10b-get-ground-session-none').response.body;

describe('selectScope', () => {
  it('step 1: a body without a usable currentFlightId is bad-response', () => {
    for (const body of [null, [], 'x', {}, { currentFlightId: 0 }, { currentFlightId: '92' }, { currentFlightId: 1.5 }]) {
      expect(selectScope(body).kind).toBe('bad-response');
    }
  });

  it('step 2: currentFlightId non-null -> flight scope, with the linked leg from plannedLeg', () => {
    expect(selectScope(flying)).toEqual({ kind: 'flight', flightId: 92, plannedLegId: 12 });
    expect(selectScope({ currentFlightId: 7 })).toEqual({ kind: 'flight', flightId: 7, plannedLegId: null });
    expect(selectScope({ currentFlightId: 7, plannedLeg: { plannedLegId: 'x' } })).toEqual({
      kind: 'flight', flightId: 7, plannedLegId: null,
    });
  });

  it('step 2: flight scope wins even when groundSession.plannedLegId is also set', () => {
    const both = { ...flying, groundSession: { groundSessionId: 4, plannedLegId: 55 } };
    expect(selectScope(both)).toEqual({ kind: 'flight', flightId: 92, plannedLegId: 12 });
    expect(selectScope(both, sessionOpen)).toEqual({ kind: 'flight', flightId: 92, plannedLegId: 12 });
  });

  it('step 3: currentFlightId null with groundSession.plannedLegId -> leg scope from status, no fallback needed', () => {
    expect(selectScope(groundLeg)).toEqual({ kind: 'leg', plannedLegId: 12, source: 'status' });
    // A supplied ground-session body is ignored once status resolved the scope.
    expect(selectScope(groundLeg, sessionNone)).toEqual({ kind: 'leg', plannedLegId: 12, source: 'status' });
  });

  it('step 3: a malformed groundSession is treated as absent', () => {
    expect(selectScope({ currentFlightId: null, groundSession: { plannedLegId: -1 } })).toEqual({
      kind: 'need-ground-session',
    });
    expect(selectScope({ currentFlightId: null, groundSession: 'x' })).toEqual({ kind: 'need-ground-session' });
  });

  it('step 4: neither -> asks for GET /api/ground-sessions/current', () => {
    expect(selectScope(groundNoLeg)).toEqual({ kind: 'need-ground-session' });
  });

  it('step 5: a ground-session body without session is bad-response', () => {
    expect(selectScope(groundNoLeg, {}).kind).toBe('bad-response');
    expect(selectScope(groundNoLeg, []).kind).toBe('bad-response');
  });

  it('step 6: { session: null } -> none (NO FLIGHT PLAN)', () => {
    expect(selectScope(groundNoLeg, sessionNone)).toEqual({ kind: 'none' });
  });

  it('step 7: a non-object session is bad-response', () => {
    expect(selectScope(groundNoLeg, { session: 4 }).kind).toBe('bad-response');
  });

  it('step 8: session.planned_leg_id -> leg scope from the ground session', () => {
    expect(selectScope(groundNoLeg, sessionOpen)).toEqual({ kind: 'leg', plannedLegId: 12, source: 'ground-session' });
  });

  it('step 9: a camelCase plannedLegId in the raw row is ignored; null or missing leg -> none', () => {
    expect(selectScope(groundNoLeg, { session: { id: 4, plannedLegId: 12 } })).toEqual({ kind: 'none' });
    expect(selectScope(groundNoLeg, { session: { id: 4, planned_leg_id: null } })).toEqual({ kind: 'none' });
    expect(selectScope(groundNoLeg, { session: { id: 4, planned_leg_id: '12' } })).toEqual({ kind: 'none' });
  });
});

describe('selectScopeWithPrefile', () => {
  const P = 4812;
  const prefile = { kind: 'leg', plannedLegId: P, source: 'prefile' };

  // Every (status, ground) pair the selectScope cases above use.
  const CASES: [unknown, unknown?][] = [
    [null], [[]], ['x'], [{}], [{ currentFlightId: 0 }], [{ currentFlightId: '92' }], [{ currentFlightId: 1.5 }],
    [flying], [{ currentFlightId: 7 }], [{ currentFlightId: 7, plannedLeg: { plannedLegId: 'x' } }],
    [{ ...flying, groundSession: { groundSessionId: 4, plannedLegId: 55 } }],
    [{ ...flying, groundSession: { groundSessionId: 4, plannedLegId: 55 } }, sessionOpen],
    [groundLeg], [groundLeg, sessionNone],
    [{ currentFlightId: null, groundSession: { plannedLegId: -1 } }], [{ currentFlightId: null, groundSession: 'x' }],
    [groundNoLeg], [groundNoLeg, {}], [groundNoLeg, []], [groundNoLeg, sessionNone], [groundNoLeg, { session: 4 }],
    [groundNoLeg, sessionOpen], [groundNoLeg, { session: { id: 4, plannedLegId: 12 } }],
    [groundNoLeg, { session: { id: 4, planned_leg_id: null } }], [groundNoLeg, { session: { id: 4, planned_leg_id: '12' } }],
  ];

  it('(a) with no prefiled leg, every selectScope result is unchanged and the prefile is unused', () => {
    for (const [status, ground] of CASES) {
      const expected = ground === undefined ? selectScope(status) : selectScope(status, ground);
      const got = ground === undefined ? selectScopeWithPrefile(status, null) : selectScopeWithPrefile(status, null, ground);
      expect(got).toEqual({ selection: expected, prefile: 'unused' });
    }
  });

  it('(b) no flight and no leg in status -> the prefiled leg, never the ground-session fallback', () => {
    expect(selectScopeWithPrefile(groundNoLeg, P)).toEqual({ selection: prefile, prefile: 'applied' });
    expect(selectScopeWithPrefile({ currentFlightId: null }, P)).toEqual({ selection: prefile, prefile: 'applied' });
    // A ground-session body handed in anyway changes nothing.
    expect(selectScopeWithPrefile(groundNoLeg, P, sessionNone)).toEqual({ selection: prefile, prefile: 'applied' });
  });

  it('(c) no flight and a different ground-session leg -> the prefiled leg wins', () => {
    expect(selectScopeWithPrefile(groundLeg, P)).toEqual({ selection: prefile, prefile: 'applied' });
    expect(selectScopeWithPrefile(groundNoLeg, P, sessionOpen)).toEqual({ selection: prefile, prefile: 'applied' });
  });

  it('(d) no flight and the same ground-session leg -> still the prefile scope, on the same leg', () => {
    expect(selectScopeWithPrefile(groundLeg, 12)).toEqual({
      selection: { kind: 'leg', plannedLegId: 12, source: 'prefile' },
      prefile: 'applied',
    });
  });

  it('(e) a flight -> flight scope exactly as selectScope gives it, and the prefile is cleared', () => {
    expect(selectScopeWithPrefile(flying, P)).toEqual({ selection: selectScope(flying), prefile: 'clear' });
    const both = { ...flying, groundSession: { groundSessionId: 4, plannedLegId: P } };
    expect(selectScopeWithPrefile(both, P)).toEqual({ selection: selectScope(both), prefile: 'clear' });
  });

  it('a status body selectScope calls bad-response stays bad-response, and the prefile is kept (unused)', () => {
    for (const body of [null, [], {}, { currentFlightId: 0 }, { currentFlightId: '92' }]) {
      expect(selectScopeWithPrefile(body, P)).toEqual({ selection: selectScope(body), prefile: 'unused' });
    }
  });
});
