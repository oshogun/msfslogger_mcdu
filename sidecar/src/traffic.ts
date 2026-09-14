// ── AI traffic — pure, dependency-free logic ──────────────────────────────────
//
// A port of the CLI agent's traffic module, with one change: the radius and
// the enabled flag are no longer read from the environment here. They arrive
// as parameters from the config file, so this file reads no process state at
// all and can be exercised anywhere.
//
// All SimConnect wiring — the data definition, the request, decoding the
// buffer — lives in simconnect.ts. This file only decides what survives a
// sweep.

/** One record as decoded from a simObjectDataByType buffer. */
export interface TrafficRecord {
  id: number;
  lat: number;
  lon: number;
  altitudeFt: number;
  headingDeg: number;
  groundSpeedKnots: number;
  onGround: boolean;
}

/** What the server is told about: no ground speed, no rounding (its job). */
export interface TrafficObject {
  id: number;
  lat: number;
  lon: number;
  altitudeFt: number;
  headingDeg: number;
  onGround: boolean;
}

/** The server enforces this too; truncating here never trips its 400. */
export const MAX_BATCH_OBJECTS = 200;

const USER_POSITION_GUARD_DEG = 0.0001;
const PARKED_SPEED_KNOTS = 1;

export function buildTrafficBatch(
  sweep: readonly TrafficRecord[],
  userObjectId: number | null,
  userLat: number | null,
  userLon: number | null,
): TrafficObject[] {
  const survivors: TrafficRecord[] = [];

  for (const o of sweep) {
    // 1. Drop the user's own aircraft by object id.
    if (o.id === userObjectId) continue;

    // 2. Drop the user's own aircraft by position. A null user position
    // arithmetically behaves as 0 here, exactly as it did in the CLI agent:
    // before the first frame arrives there is nothing better to compare to,
    // and the id guard above is the one that does the real work.
    if (
      Math.abs(o.lat - (userLat as number)) <= USER_POSITION_GUARD_DEG &&
      Math.abs(o.lon - (userLon as number)) <= USER_POSITION_GUARD_DEG
    ) {
      continue;
    }

    // 3. Drop malformed records.
    if (!Number.isInteger(o.id) || o.id < 0) continue;
    if (
      !Number.isFinite(o.lat) ||
      !Number.isFinite(o.lon) ||
      !Number.isFinite(o.altitudeFt) ||
      !Number.isFinite(o.headingDeg)
    ) {
      continue;
    }

    // 4. Drop parked/gate-held aircraft.
    if (o.onGround === true && o.groundSpeedKnots < PARKED_SPEED_KNOTS) continue;

    survivors.push(o);
  }

  // 5. De-duplicate by id: first occurrence's position, last occurrence's
  // value — exactly what Map + repeated .set() does.
  const byId = new Map<number, TrafficRecord>();
  for (const o of survivors) {
    byId.set(o.id, o);
  }

  // 6. Truncate to MAX_BATCH_OBJECTS in that (first-occurrence) order.
  const deduped = Array.from(byId.values()).slice(0, MAX_BATCH_OBJECTS);

  // 7. Emit as TrafficObject — groundSpeedKnots dropped, onGround carried.
  return deduped.map((o) => ({
    id: o.id,
    lat: o.lat,
    lon: o.lon,
    altitudeFt: o.altitudeFt,
    headingDeg: o.headingDeg,
    onGround: o.onGround === true,
  }));
}
