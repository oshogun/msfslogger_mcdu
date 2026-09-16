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
// Pure: no I/O. The caller makes the fallback GET only when this asks for it.

export type ScopeSelection =
  | { kind: 'flight'; flightId: number; plannedLegId: number | null }
  | { kind: 'leg'; plannedLegId: number; source: 'status' | 'ground-session' }
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
