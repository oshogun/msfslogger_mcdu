#!/usr/bin/env ts-node
// ── Uplink inspector ──────────────────────────────────────────────────────────
//
// Posts one synthetic frame, one synthetic event and one synthetic traffic
// batch to the server named in a config file, then runs the reachability
// probe, and prints what each attempt produced: HTTP status, the backend-axis
// state it maps to, and that state's label as the panel would show it.
//
// It exists so the uplink is falsifiable without a simulator. Point it at a
// scratch server on a spare port and the frame body, the x-ingest-token header
// and the certificate handling are all observable in one run; point it at a
// closed port or one that answers 500 and the failure mapping is observable
// the same way.
//
//   node dist/inspect-uplink.js --config <path>
//
// The synthetic frame carries the same ten fields the SimConnect handler
// builds, so a server-side schema change shows up here first.

import {
  loadConfig,
  parseConfigArg,
  resolveConfigPath,
} from './config';
import { describeState, formatStateLabel } from './status';
import { Uplink, UPLINK_PATHS, type UplinkResult } from './uplink';

const SYNTHETIC_FRAME = {
  lat: 37.618023,
  lon: -122.375519,
  altitudeFt: 13.4,
  airspeedKnots: 0,
  groundSpeedKnots: 0,
  headingDeg: 271.3,
  verticalSpeedFpm: 0,
  onGround: true,
  simRunning: 2,
  aircraft: 'msfslogger inspector',
};

const SYNTHETIC_TRAFFIC = [
  { id: 11, lat: 37.7, lon: -122.4, altitudeFt: 3500, headingDeg: 90, onGround: false },
  { id: 12, lat: 37.8, lon: -122.2, altitudeFt: 7200, headingDeg: 180, onGround: false },
];

function report(label: string, result: UplinkResult): void {
  const state = describeState(result.state);
  const status = result.httpStatus === null ? '---' : String(result.httpStatus);
  const rendered = formatStateLabel(result.state, { httpStatus: result.httpStatus ?? undefined });
  console.log(
    `${label.padEnd(22)} http=${status.padEnd(4)} state=${state.id.padEnd(17)} label="${rendered}"` +
      (result.ok ? '' : `  reason=${result.message}`),
  );
}

async function main(argv: string[]): Promise<number> {
  const configPath = resolveConfigPath(parseConfigArg(argv) ?? argv.find((a) => !a.startsWith('-')));
  console.log(`config path : ${configPath}`);

  const loaded = loadConfig(configPath);
  if (!loaded.ok) {
    console.error(loaded.reason === 'missing' ? 'config     : MISSING' : 'config     : INVALID');
    for (const problem of loaded.problems) console.error(`  ${String(problem.field)}: ${problem.message}`);
    return 1;
  }

  const uplink = new Uplink(loaded.config, (level, message) => console.log(`[${level}] ${message}`));
  console.log(`server url  : ${loaded.config.serverUrl}`);
  console.log(`token       : <set, redacted>`);
  console.log(`custom CA   : ${uplink.hasCustomCa() ? loaded.config.certPath : 'none — system trust'}`);

  const results: UplinkResult[] = [];

  const frame = await uplink.postFrame(SYNTHETIC_FRAME);
  report(`POST ${UPLINK_PATHS.frame}`, frame);
  results.push(frame);

  const event = await uplink.postEvent({ type: 'connected' });
  report(`POST ${UPLINK_PATHS.event}`, event);
  results.push(event);

  // Traffic is advisory: it is reported but never decides the exit code, the
  // same way a traffic failure never touches the backend axis at runtime.
  const traffic = await uplink.postTraffic(SYNTHETIC_TRAFFIC);
  report(`POST ${UPLINK_PATHS.traffic}`, traffic);

  const probe = await uplink.probe();
  report(`GET  ${UPLINK_PATHS.probe}`, probe);

  await uplink.close();
  return results.every((r) => r.ok) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`inspector failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
