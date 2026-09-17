// ── Datalink scope selector ───────────────────────────────────────────────────
//
// Decides which ACARS thread the CDU is looking at. The server froze the rule:
//
//   if currentFlightId is not null, use flight scope; otherwise use
//   groundSession.plannedLegId for leg scope; otherwise fall back to
//   GET /api/ground-sessions/current; otherwise there is no scope, which the
//   CDU shows as NO FLIGHT PLAN.
//
// Two different types carry a leg id. /api/status is a computed camelCase view
// (`groundSession.plannedLegId`); /api/ground-sessions/current is the raw
// stored row (`session.planned_leg_id`). They are read separately and never
// unified, so a camelCase member in the raw row is ignored.
//
// A leg the user prefiled from SimBrief sits outside that rule: the server
// never attaches a trip-less leg to a ground session or a flight, so the client
// holds its id and slots it in between flight scope and the ground-session leg.
// With no prefiled leg held, selection is exactly the frozen rule.
//
// Pure: no I/O. The caller makes the fallback GET only when this asks for it.

export type ScopeSelection =
  | { kind: 'flight'; flightId: number; plannedLegId: number | null }
  | { kind: 'leg'; plannedLegId: number; source: 'status' | 'ground-session' | 'prefile' }
  | { kind: 'none' }
  | { kind: 'need-ground-session' }
  | { kind: 'bad-response'; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * `statusBody` is the parsed 2xx body of GET /api/status. `groundSessionBody`
 * is the parsed 2xx body of GET /api/ground-sessions/current, or undefined when
 * that request has not been made.
 */
export function selectScope(statusBody: unknown, groundSessionBody?: unknown): ScopeSelection {
  if (!isPlainObject(statusBody) || !Object.prototype.hasOwnProperty.call(statusBody, 'currentFlightId')) {
    return { kind: 'bad-response', detail: 'status has no currentFlightId' };
  }
  const currentFlightId = statusBody.currentFlightId;
  if (currentFlightId !== null && !isValidId(currentFlightId)) {
    return { kind: 'bad-response', detail: 'currentFlightId is neither null nor an id' };
  }

  if (currentFlightId !== null) {
    const plannedLeg = statusBody.plannedLeg;
    const plannedLegId =
      isPlainObject(plannedLeg) && isValidId(plannedLeg.plannedLegId) ? plannedLeg.plannedLegId : null;
    return { kind: 'flight', flightId: currentFlightId, plannedLegId };
  }

  const groundSession = statusBody.groundSession;
  if (isPlainObject(groundSession) && isValidId(groundSession.plannedLegId)) {
    return { kind: 'leg', plannedLegId: groundSession.plannedLegId, source: 'status' };
  }

  if (groundSessionBody === undefined) return { kind: 'need-ground-session' };

  if (!isPlainObject(groundSessionBody) || !Object.prototype.hasOwnProperty.call(groundSessionBody, 'session')) {
    return { kind: 'bad-response', detail: 'ground session body has no session' };
  }
  const session = groundSessionBody.session;
  if (session === null) return { kind: 'none' };
  if (!isPlainObject(session)) return { kind: 'bad-response', detail: 'session is not an object' };
  if (isValidId(session.planned_leg_id)) {
    return { kind: 'leg', plannedLegId: session.planned_leg_id, source: 'ground-session' };
  }
  return { kind: 'none' };
}

/**
 * What a poll cycle does with a prefiled leg: 'unused' when none is held or
 * the status body is unusable, 'applied' when it is the selected scope, and
 * 'clear' when a flight has started, which ends the prefile for good.
 */
export type PrefileUse = 'unused' | 'applied' | 'clear';

/**
 * The frozen rule with a prefiled leg slotted in: flight scope first, then the
 * prefiled leg, then the ground-session leg. The prefiled leg outranks a leg
 * from status or the ground session because it is the one the user explicitly
 * asked for, and it never needs the fallback GET.
 */
export function selectScopeWithPrefile(
  statusBody: unknown,
  prefiledLegId: number | null,
  groundSessionBody?: unknown,
): { selection: ScopeSelection; prefile: PrefileUse } {
  if (prefiledLegId === null) {
    return { selection: selectScope(statusBody, groundSessionBody), prefile: 'unused' };
  }
  const base = selectScope(statusBody);
  if (base.kind === 'bad-response') return { selection: base, prefile: 'unused' };
  if (base.kind === 'flight') return { selection: base, prefile: 'clear' };
  return { selection: { kind: 'leg', plannedLegId: prefiledLegId, source: 'prefile' }, prefile: 'applied' };
}
