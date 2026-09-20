// tests/helpers/fake-facility-connection.ts — a SimConnect handle that never
// touches a simulator.
//
// It implements only what the facility session uses, records every send, and
// lets a test decide what the simulator says back and when. Two behaviours are
// modelled from measurements rather than invented:
//
//   * a refused member name answers with an asynchronous exception carrying the
//     sendId of the call that caused it, on a later microtask, which is why
//     member names have to be probed rather than assumed;
//   * a list arrives in chunks carrying entryNumber/outOf, and the last chunk is
//     the one where entryNumber reaches outOf - 1.
//
// Nothing here opens a socket, a file or a database.

import { EventEmitter } from 'events';

import type {
  AirportListEntry,
  FacilityMinimalEntry,
  FacilityReader,
} from '../../src/navdata-facilities';

export interface RecordedDefinitionSend {
  readonly definitionId: number;
  readonly fieldName: string;
  readonly sendId: number;
}

export interface RecordedDataRequest {
  readonly definitionId: number;
  readonly requestId: number;
  readonly ident: string;
  readonly region?: string;
  readonly icaoType?: 'V' | 'N' | 'W';
  readonly sendId: number;
}

export interface RecordedListRequest {
  readonly type: number;
  readonly requestId: number;
  readonly sendId: number;
}

/** A reader that yields nothing: these tests never decode a facility row. */
export const emptyReader: FacilityReader = {
  remaining: () => 0,
  readInt32: () => 0,
  readInt64: () => 0,
  readFloat32: () => 0,
  readFloat64: () => 0,
  readString: () => '',
  readStringV: () => '',
};

export class FakeFacilityConnection {
  private readonly emitter = new EventEmitter();
  private nextSendId = 1;

  readonly definitionSends: RecordedDefinitionSend[] = [];
  readonly dataRequests: RecordedDataRequest[] = [];
  readonly listRequests: RecordedListRequest[] = [];

  /** Member spellings this build refuses, the way it refuses mixed case. */
  readonly rejectedMembers = new Set<string>();
  /** Entry points whose OPEN is refused; their children go with them. */
  readonly rejectedEntries = new Set<string>();
  /** When set, requestFacilitiesList throws instead of sending. */
  listSendError: Error | null = null;

  on(event: string, listener: (...args: never[]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  listenerCount(event: string): number {
    return this.emitter.listenerCount(event);
  }

  addToFacilityDefinition(definitionId: number, fieldName: string): number {
    const sendId = this.nextSendId++;
    this.definitionSends.push({ definitionId, fieldName, sendId });
    const opened = fieldName.startsWith('OPEN ') ? fieldName.slice(5) : null;
    const refused =
      opened !== null ? this.rejectedEntries.has(opened) : this.rejectedMembers.has(fieldName);
    if (refused) queueMicrotask(() => this.emitException(sendId));
    return sendId;
  }

  requestFacilityData(
    definitionId: number,
    requestId: number,
    ident: string,
    region?: string,
    icaoType?: 'V' | 'N' | 'W',
  ): number {
    const sendId = this.nextSendId++;
    this.dataRequests.push({ definitionId, requestId, ident, region, icaoType, sendId });
    return sendId;
  }

  requestFacilitiesList(type: number, requestId: number): number {
    if (this.listSendError) throw this.listSendError;
    const sendId = this.nextSendId++;
    this.listRequests.push({ type, requestId, sendId });
    return sendId;
  }

  // ── what the simulator says back ────────────────────────────────────────────

  emitException(sendId: number, exceptionName = 'DATA_ERROR', exception = 20, index = 0): void {
    this.emitter.emit('exception', { exception, sendId, index, exceptionName });
  }

  emitData(requestId: number, rows = 1, type = 0): void {
    for (let i = 0; i < rows; i++) {
      this.emitter.emit('facilityData', {
        userRequestId: requestId,
        type,
        isListItem: false,
        itemIndex: i,
        listSize: rows,
        data: emptyReader,
      });
    }
  }

  emitDataEnd(requestId: number): void {
    this.emitter.emit('facilityDataEnd', { userRequestId: requestId });
  }

  emitMinimalList(requestId: number, entries: readonly FacilityMinimalEntry[]): void {
    this.emitter.emit('facilityMinimalList', { requestID: requestId, data: entries });
  }

  emitAirportChunk(
    requestId: number,
    airports: readonly AirportListEntry[],
    entryNumber: number,
    outOf: number,
  ): void {
    this.emitter.emit('airportList', { requestID: requestId, entryNumber, outOf, airports });
  }

  /** The last request id the session used for a list, or null. */
  lastListRequestId(): number | null {
    return this.listRequests.at(-1)?.requestId ?? null;
  }

  /** The last request id the session used for facility data, or null. */
  lastDataRequestId(): number | null {
    return this.dataRequests.at(-1)?.requestId ?? null;
  }
}

/** Builds a synthetic airport list row. Synthetic idents only, never real ones. */
export function airportRow(
  icao: string,
  latitude: number,
  longitude: number,
  altitude = 0,
  region = '',
): AirportListEntry {
  return { icao, region, latitude, longitude, altitude };
}
