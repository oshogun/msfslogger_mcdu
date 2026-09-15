// tests/simconnect.test.ts — tests src/simconnect.ts's readGroundVars, the
// pure length-guarded derivation of the ground-detection SimVars. It is
// isolated from SimConnect itself: the fake reader below only implements the
// two RawBuffer methods the function actually calls.

import { describe, expect, it } from 'vitest';
import { readGroundVars, type GroundVarsReader } from '../src/simconnect';

/** A stub RawBuffer: `remaining()` reports what is left after the ints are consumed. */
function reader(ints: number[]): GroundVarsReader {
  let offset = 0;
  return {
    remaining: () => (ints.length - offset) * 4,
    readInt32: () => ints[offset++],
  };
}

describe('short block', () => {
  it('returns null when fewer than 24 bytes remain, without reading', () => {
    const data = reader([1, 2, 3, 4, 5]); // 20 bytes
    expect(readGroundVars(data)).toBeNull();
  });

  it('accepts exactly 24 bytes remaining', () => {
    const data = reader([1, 2, 0, 0, 0, 0]); // 24 bytes
    expect(readGroundVars(data)).toEqual({
      parkingBrake: true,
      engineCount: 2,
      enginesRunning: 0,
    });
  });
});

describe('parking brake', () => {
  it('is false for a raw value of 0', () => {
    const data = reader([0, 0, 0, 0, 0, 0]);
    expect(readGroundVars(data)?.parkingBrake).toBe(false);
  });

  it('is true for any non-zero raw value', () => {
    const data = reader([1, 0, 0, 0, 0, 0]);
    expect(readGroundVars(data)?.parkingBrake).toBe(true);
  });
});

describe('engine count clamp', () => {
  it('clamps a negative raw count to 0', () => {
    const data = reader([0, -1, 0, 0, 0, 0]);
    expect(readGroundVars(data)?.engineCount).toBe(0);
  });

  it('clamps a raw count above 4 to 4', () => {
    const data = reader([0, 7, 1, 1, 1, 1]);
    expect(readGroundVars(data)?.engineCount).toBe(4);
  });

  it('gives enginesRunning 0 when engineCount is 0, even with combustion flags set', () => {
    const data = reader([0, 0, 1, 1, 1, 1]);
    const result = readGroundVars(data);
    expect(result?.engineCount).toBe(0);
    expect(result?.enginesRunning).toBe(0);
  });
});

describe('engines running', () => {
  it('counts only combustion flags within engineCount, ignoring the rest', () => {
    // engineCount 2, but engine 3 and 4 report combustion — must be ignored.
    const data = reader([0, 2, 0, 0, 1, 1]);
    const result = readGroundVars(data);
    expect(result?.engineCount).toBe(2);
    expect(result?.enginesRunning).toBe(0);
  });

  it('counts non-zero combustion flags within engineCount', () => {
    const data = reader([0, 4, 1, 0, 1, 1]);
    const result = readGroundVars(data);
    expect(result?.engineCount).toBe(4);
    expect(result?.enginesRunning).toBe(3);
  });
});
