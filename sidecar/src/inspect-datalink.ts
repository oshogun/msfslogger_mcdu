#!/usr/bin/env ts-node
// ── Datalink inspector ────────────────────────────────────────────────────────
//
// Makes the datalink's read requests against the server named in a config
// file and prints how each one classifies: HTTP status, the datalink error
// code, and the availability state the CDU would show. Then it resolves the
// scope the way a poll cycle does and, when there is one, fetches the thread
// and prints its size.
//
// It exists so the datalink is falsifiable without the app or a simulator:
// run it against a server before and after an upgrade and the "route not in
// token scope" answer turns into real threads, or it does not.
//
//   node dist/inspect-datalink.js --config <path>
//
// Read-only by construction. It issues GETs only; there is no POST path and no
// flag that enables one, because every datalink POST writes a real ACARS row.
// No body, header or token is printed.

import { loadConfig, parseConfigArg, resolveConfigPath } from './config';
import { classifyOutcome, type Classified, type ClassifyContext } from './datalink-classify';
import { buildRequest, DatalinkClient, type DatalinkRoute } from './datalink-client';
import { projectThread } from './datalink-model';
import { selectScope, type ScopeSelection } from './datalink-scope';
import { Uplink } from './uplink';

function describeScope(selection: ScopeSelection): string {
  switch (selection.kind) {
    case 'flight':
      return `FLIGHT ${selection.flightId}${selection.plannedLegId === null ? '' : ` LEG ${selection.plannedLegId}`}`;
    case 'leg':
      return `LEG ${selection.plannedLegId} (from ${selection.source})`;
    case 'none':
      return 'NO FLIGHT PLAN';
    case 'need-ground-session':
      return 'UNRESOLVED (ground session not fetched)';
    case 'bad-response':
      return 'BAD DATA';
  }
}

async function getAndReport(
  client: DatalinkClient,
  route: DatalinkRoute,
  context: ClassifyContext,
  token: string,
): Promise<Classified> {
  const path = buildRequest(route)?.path ?? '(invalid route)';
  const classified = classifyOutcome(await client.request(route), context, token);
  const status = classified.httpStatus === null ? '---' : String(classified.httpStatus);
  const cls = classified.ok ? 'ok' : classified.code;
  const state = classified.ok ? '-' : classified.availability ?? '-';
  const code = !classified.ok && classified.serverCode !== null ? ` code=${classified.serverCode}` : '';
  console.log(`GET ${path} http=${status} class=${cls} state=${state}${code}`);
  return classified;
}

/** Runs the inspection and resolves with the exit code. Exported so tests can drive it. */
export async function runInspector(argv: string[]): Promise<number> {
  const configPath = resolveConfigPath(parseConfigArg(argv) ?? argv.find((a) => !a.startsWith('-')));
  console.log(`config path : ${configPath}`);

  const loaded = loadConfig(configPath);
  if (!loaded.ok) {
    console.error(loaded.reason === 'missing' ? 'config      : MISSING' : 'config      : INVALID');
    for (const problem of loaded.problems) console.error(`  ${String(problem.field)}: ${problem.message}`);
    return 1;
  }

  // Uplink log lines are about certificate loading only; they carry no token.
  const uplink = new Uplink(loaded.config, (level, message) => console.log(`[${level}] ${message}`));
  const client = new DatalinkClient(() => uplink);
  const token = loaded.config.ingestToken;
  console.log(`server url  : ${loaded.config.serverUrl}`);
  console.log(`token       : <set, redacted>`);
  console.log(`custom CA   : ${uplink.hasCustomCa() ? loaded.config.certPath : 'none — system trust'}`);

  let allOk = true;
  const status = await getAndReport(client, { key: 'status' }, 'poll', token);
  const ground = await getAndReport(client, { key: 'ground-session-current' }, 'poll', token);
  const canned = await getAndReport(client, { key: 'canned-list' }, 'op', token);
  allOk = status.ok && ground.ok && canned.ok;

  if (!status.ok) {
    console.log('scope       : UNRESOLVED (status request failed)');
  } else {
    let selection = selectScope(status.json);
    if (selection.kind === 'need-ground-session' && ground.ok) selection = selectScope(status.json, ground.json);
    console.log(`scope       : ${describeScope(selection)}`);
    if (selection.kind === 'bad-response' || selection.kind === 'need-ground-session') allOk = false;

    if (selection.kind === 'flight' || selection.kind === 'leg') {
      const route: DatalinkRoute =
        selection.kind === 'flight'
          ? { key: 'flight-thread', id: selection.flightId }
          : { key: 'leg-thread', id: selection.plannedLegId };
      const thread = await getAndReport(client, route, 'poll', token);
      if (!thread.ok) {
        allOk = false;
      } else {
        const projection = projectThread(thread.json, selection.kind, token);
        if (!projection.ok) {
          console.log('thread      : BAD DATA');
          allOk = false;
        } else {
          const newest = projection.messages[projection.messages.length - 1];
          console.log(
            `thread      : total=${projection.messages.length} dropped=${projection.droppedRows} newestId=${newest ? newest.id : '---'}`,
          );
        }
      }
    }
  }

  await uplink.close();
  return allOk ? 0 : 1;
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runInspector(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // The message is not printed: a failure deep in fetch could quote a URL.
      console.error('inspector failed');
      process.exitCode = 1;
    },
  );
}
