// tests/helpers/facility-record.ts — facility-data records on the wire.
//
// An INDEPENDENT statement of the record layout, kept deliberately separate
// from the decoder's own table. The widths below were read off real records
// returned by a running simulator for definitions whose member list was known:
// latitude, longitude and altitude are 64-bit, every other real is 32-bit,
// counts and enumerations and booleans are 32-bit integers, an ident or a
// region is eight bytes of text, and a one-character code is four.
//
// NAME is the awkward one and the reason this table needs the entry point as
// well as the member: an airport's is 32 bytes, a frequency's is 64, and a
// procedure's or a transition's is 8. A decoder that assumed one width would
// misread every field after it and produce plausible numbers in the wrong
// columns, which is precisely what these tests exist to catch.

import type { FacilityReader } from '../../src/navdata-facilities';

type Kind = 'f64' | 'f32' | 'i32' | 's4' | 's8' | 's32' | 's64';

const BYTES: Readonly<Record<Kind, number>> = {
  f64: 8,
  f32: 4,
  i32: 4,
  s4: 4,
  s8: 8,
  s32: 32,
  s64: 64,
};

/** Members whose kind is the same wherever they appear. */
const KIND: Readonly<Record<string, Kind>> = {
  LATITUDE: 'f64',
  LONGITUDE: 'f64',
  ALTITUDE: 'f64',
  FIX_LATITUDE: 'f64',
  FIX_LONGITUDE: 'f64',
  FIX_ALTITUDE: 'f64',
  ORIGIN_LATITUDE: 'f64',
  ORIGIN_LONGITUDE: 'f64',
  ORIGIN_ALTITUDE: 'f64',
  ARC_CENTER_FIX_LATITUDE: 'f64',
  ARC_CENTER_FIX_LONGITUDE: 'f64',
  ARC_CENTER_FIX_ALTITUDE: 'f64',

  MAGVAR: 'f32',
  HEADING: 'f32',
  LENGTH: 'f32',
  WIDTH: 'f32',
  PATTERN_ALTITUDE: 'f32',
  SLOPE: 'f32',
  TRUE_SLOPE: 'f32',
  FAF_ALTITUDE: 'f32',
  FAF_HEADING: 'f32',
  MISSED_ALTITUDE: 'f32',
  IAF_ALTITUDE: 'f32',
  DME_ARC_RADIAL: 'f32',
  DME_ARC_DISTANCE: 'f32',
  COURSE: 'f32',
  THETA: 'f32',
  RHO: 'f32',
  DISTANCE_MINUTE: 'f32',
  ROUTE_DISTANCE: 'f32',
  ALTITUDE1: 'f32',
  ALTITUDE2: 'f32',
  SPEED_LIMIT: 'f32',
  VERTICAL_ANGLE: 'f32',

  SUFFIX: 's4',
  FIX_TYPE: 's4',
  ORIGIN_TYPE: 's4',
  ARC_CENTER_FIX_TYPE: 's4',

  REGION: 's8',
  FIX_ICAO: 's8',
  FIX_REGION: 's8',
  ORIGIN_ICAO: 's8',
  ORIGIN_REGION: 's8',
  ARC_CENTER_FIX_ICAO: 's8',
  ARC_CENTER_FIX_REGION: 's8',
  FAF_ICAO: 's8',
  FAF_REGION: 's8',
  IAF_ICAO: 's8',
  IAF_REGION: 's8',
  DME_ARC_ICAO: 's8',
  DME_ARC_REGION: 's8',
  PRIMARY_ILS_ICAO: 's8',
  PRIMARY_ILS_REGION: 's8',
  SECONDARY_ILS_ICAO: 's8',
  SECONDARY_ILS_REGION: 's8',
  NAME: 's8',
};

/** Where an entry point disagrees with the table above. */
const ENTRY_KIND: Readonly<Record<string, Readonly<Record<string, Kind>>>> = {
  AIRPORT: { NAME: 's32' },
  FREQUENCY: { NAME: 's64' },
};

function kindOf(entry: string, member: string): Kind {
  return ENTRY_KIND[entry]?.[member] ?? KIND[member] ?? 'i32';
}

/** The bytes one record would carry for `members`, in that order. */
export function encodeRecord(
  entry: string,
  members: readonly string[],
  values: Readonly<Record<string, number | string>>,
): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    const kind = kindOf(entry, member);
    const value = values[member];
    const buffer = Buffer.alloc(BYTES[kind]);
    switch (kind) {
      case 'f64':
        buffer.writeDoubleLE(typeof value === 'number' ? value : 0);
        break;
      case 'f32':
        buffer.writeFloatLE(typeof value === 'number' ? value : 0);
        break;
      case 'i32':
        buffer.writeInt32LE(typeof value === 'number' ? value : 0);
        break;
      default:
        buffer.write(typeof value === 'string' ? value : '', 'latin1');
    }
    parts.push(buffer);
  }
  return Buffer.concat(parts);
}

/**
 * A reader over one record's bytes. Truncating a fixed-width string at its
 * first NUL is the simulator's own behaviour, and it matters: the bytes after
 * the terminator are whatever was in the buffer, and have been observed to be
 * uninitialised memory rather than padding.
 */
export function readerOver(bytes: Buffer): FacilityReader {
  let offset = 0;
  const take = (n: number): number => {
    const at = offset;
    offset += n;
    return at;
  };
  return {
    remaining: () => bytes.length - offset,
    readInt32: () => bytes.readInt32LE(take(4)),
    readInt64: () => Number(bytes.readBigInt64LE(take(8))),
    readFloat32: () => bytes.readFloatLE(take(4)),
    readFloat64: () => bytes.readDoubleLE(take(8)),
    readString: (length: number) => {
      const at = take(length);
      const slice = bytes.subarray(at, at + length);
      const end = slice.indexOf(0);
      return (end === -1 ? slice : slice.subarray(0, end)).toString('latin1');
    },
    readStringV: () => '',
  };
}

/** A reader that throws the moment it is touched: a decoder fault, modelled. */
export function throwingReader(): FacilityReader {
  const boom = (): never => {
    throw new Error('record read failed');
  };
  return {
    remaining: boom,
    readInt32: boom,
    readInt64: boom,
    readFloat32: boom,
    readFloat64: boom,
    readString: boom,
    readStringV: boom,
  };
}
