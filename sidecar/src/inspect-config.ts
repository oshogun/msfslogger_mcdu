#!/usr/bin/env ts-node
// ── Config inspector ──────────────────────────────────────────────────────────
//
// A read-only CLI over src/config.ts: resolve a config path the same way the
// sidecar does, load it, and print the effective config the sidecar would run
// on — with the ingest token removed, because this output ends up pasted into
// reports and issues.
//
//   node dist/inspect-config.js                    # the resolved default path
//   node dist/inspect-config.js path/to/config.json
//   node dist/inspect-config.js --config=path/to/config.json
//
// Exit code is the point of the tool: 0 for a config the sidecar would accept,
// 1 for one it would reject, with a single human line per offending field and
// no stack trace. That makes `for f in samples/config/bad-*.json; do ...; done`
// a complete check of the validation rules.
//
// The sidecar itself never exits on a bad config — it stays alive and reports
// the problem — but this is a one-shot tool run by a human at a shell, where
// an exit code is the answer.

import {
  loadConfig,
  parseConfigArg,
  redact,
  resolveConfigPath,
  SIM_PROTOCOL_NAME,
} from './config';

function main(argv: string[]): number {
  const flagPath = parseConfigArg(argv);
  const positional = argv.find((arg) => !arg.startsWith('-'));
  const configPath = resolveConfigPath(flagPath ?? positional);

  console.log(`config path : ${configPath}`);

  const result = loadConfig(configPath);

  if (!result.ok) {
    console.error(
      result.reason === 'missing'
        ? 'config     : MISSING'
        : 'config     : INVALID',
    );
    for (const problem of result.problems) {
      console.error(`  ${problem.field}: ${problem.message}`);
    }
    return 1;
  }

  for (const warning of result.warnings) {
    console.log(`warning    : ${warning.field}: ${warning.message}`);
  }

  const effective = redact(result.config);
  console.log('config     : OK');
  console.log(`  version        : ${effective.version}`);
  console.log(`  serverUrl      : ${effective.serverUrl}`);
  console.log(`  ingestToken    : ${effective.tokenSet ? '<set, redacted>' : '<not set>'}`);
  console.log(`  certPath       : ${effective.certPath ?? '<none — system trust>'}`);
  console.log(`  trafficEnabled : ${effective.trafficEnabled}`);
  console.log(`  trafficRadiusM : ${effective.trafficRadiusM}`);
  console.log(`  sim            : ${effective.sim} (Protocol.${SIM_PROTOCOL_NAME[effective.sim]})`);
  console.log(`  autoUplink     : ${effective.autoUplink}`);
  console.log(`  nodePath       : ${effective.nodePath ?? '<node from PATH>'}`);
  console.log(`redacted json: ${JSON.stringify(effective)}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
