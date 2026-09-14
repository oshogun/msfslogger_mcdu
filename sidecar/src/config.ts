// ── Config file: loading, validation, redaction ───────────────────────────────
//
// One JSON file replaces every environment variable and CLI flag the old
// `agent/` needed (SERVER_URL, INGEST_TOKEN, NODE_EXTRA_CA_CERTS,
// TRAFFIC_ENABLED, TRAFFIC_RADIUS_M, --sim). The validation rules below are a
// transcription of what the agent did with those variables, with one
// deliberate behavioural change: nothing here prints and nothing here exits.
// A problem is returned, because the sidecar runs under a GUI supervisor that
// would otherwise respawn a process that dies on every start.
//
// This module imports no SimConnect and opens no socket. The single piece of
// I/O is `readFileSync` in `loadConfig`, plus the optional readability probe
// for `certPath` that `loadConfig` hands to `validateConfig`; `validateConfig`
// called with a parsed object and no probe touches nothing at all.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Accepted `sim` values, case-insensitive after trim. */
export type SimId = '2020' | '2024' | 'fsx';

/**
 * The on-disk file, exactly as JSON.parse returns it. Every field is optional:
 * a missing file is "no config", not a crash. Unknown keys are ignored here
 * and preserved by the writer.
 */
export interface RawConfig {
  version?: number;
  serverUrl?: string;
  ingestToken?: string;
  certPath?: string | null;
  trafficEnabled?: boolean | string | number;
  trafficRadiusM?: number | string;
  sim?: string;
  autoUplink?: boolean;
  nodePath?: string | null;
}

/** The validated, fully-defaulted config the sidecar runs on. */
export interface EffectiveConfig {
  version: 1;
  serverUrl: string;
  ingestToken: string;
  certPath: string | null;
  trafficEnabled: boolean;
  trafficRadiusM: number;
  sim: SimId;
  autoUplink: boolean;
  nodePath: string | null;
}

/**
 * The same object with the credential removed. This — never EffectiveConfig —
 * is what may cross IPC, reach the webview, or be printed.
 */
export type RedactedConfig = Omit<EffectiveConfig, 'ingestToken'> & {
  /** true when ingestToken is a non-empty string. The value never travels. */
  tokenSet: boolean;
};

export interface ConfigProblem {
  /** Config key at fault, or "*" for a whole-file problem. */
  field: keyof RawConfig | '*';
  /** One line, no stack trace, safe to show in the FMC scratchpad. */
  message: string;
}

export type ConfigLoadResult =
  | { ok: true; config: EffectiveConfig; warnings: ConfigProblem[] }
  | { ok: false; reason: 'missing'; path: string; problems: ConfigProblem[] }
  | { ok: false; reason: 'invalid'; path: string; problems: ConfigProblem[] };

export const DEFAULTS = {
  version: 1,
  certPath: null,
  trafficEnabled: true,
  trafficRadiusM: 40000,
  trafficRadiusMinM: 1000,
  trafficRadiusMaxM: 200000,
  sim: '2020',
  autoUplink: false,
  nodePath: null,
} as const;

/** Values (trimmed, lowercased) that turn traffic off. Ported verbatim. */
export const TRAFFIC_DISABLE_VALUES = ['0', 'false', 'off', 'no'] as const;

/** sim -> the SimConnect protocol revision to open with. */
export const SIM_PROTOCOL_NAME: Readonly<Record<SimId, 'KittyHawk' | 'SunRise' | 'FSX_SP2'>> = {
  '2020': 'KittyHawk',
  '2024': 'SunRise',
  fsx: 'FSX_SP2',
};

const SIM_IDS: readonly SimId[] = ['2020', '2024', 'fsx'];

/** The directory name used under %APPDATA% / $XDG_CONFIG_HOME. */
const CONFIG_DIR_NAME = 'msfslogger';
const CONFIG_FILE_NAME = 'config.json';

export interface ValidateOptions {
  /**
   * Probe used for the `certPath` readability check. Omitted, the check is
   * skipped and `validateConfig` stays pure; `loadConfig` supplies the real
   * filesystem probe.
   */
  isReadableFile?: (filePath: string) => boolean;
}

/** Reads `--config <path>` / `--config=<path>`, the form the old --sim accepted. */
export function parseConfigArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') return argv[i + 1];
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return undefined;
}

/**
 * `path.resolve` on win32 treats a POSIX-style rooted path with no drive
 * letter (e.g. `/tmp/x.json`) as relative to the current drive, silently
 * rewriting it to `D:\tmp\x.json`. An already-absolute path — which
 * `path.isAbsolute` recognizes correctly on every platform, drive letter or
 * not — is returned as-is; only a genuinely relative path gets resolved
 * against cwd.
 */
function resolveMaybeAbsolute(candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
}

/**
 * Resolution order: explicit override, then MSFSLOGGER_CONFIG, then the
 * platform default. Returns a path even when nothing exists there — a missing
 * config has to be reported with the place it was looked for.
 */
export function resolveConfigPath(override?: string): string {
  if (override && override.trim() !== '') return resolveMaybeAbsolute(override.trim());

  const fromEnv = process.env.MSFSLOGGER_CONFIG;
  if (fromEnv && fromEnv.trim() !== '') return resolveMaybeAbsolute(fromEnv.trim());

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function isReadableFileSync(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Notepad writes a BOM and the audience for this file uses Notepad. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Reads and validates the file at `configPath`. Never throws and never exits:
 * an unreadable file, unparseable JSON and a failed rule all come back as a
 * result the caller reports.
 */
export function loadConfig(configPath: string): ConfigLoadResult {
  let text: string;
  try {
    text = stripBom(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: 'missing',
        path: configPath,
        problems: [{ field: '*', message: `No config file at ${configPath}` }],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'invalid',
      path: configPath,
      problems: [{ field: '*', message: `Config file is not readable: ${message}` }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'invalid',
      path: configPath,
      problems: [{ field: '*', message: `Config file is not valid JSON: ${message}` }],
    };
  }

  const result = validateConfig(parsed, { isReadableFile: isReadableFileSync });
  return result.ok ? result : { ...result, path: configPath };
}

/**
 * Pure given no `isReadableFile` probe. One problem per offending field, each
 * a single human-readable line naming the field and never quoting the token.
 */
export function validateConfig(raw: unknown, options: ValidateOptions = {}): ConfigLoadResult {
  const problems: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      reason: 'invalid',
      path: '',
      problems: [{ field: '*', message: 'Config must be a JSON object' }],
    };
  }

  const cfg = raw as RawConfig & Record<string, unknown>;

  // version — absent reads as 1; anything else would mean a format this build
  // cannot honestly claim to understand.
  const version: 1 = 1;
  if (cfg.version !== undefined && cfg.version !== null && cfg.version !== 1) {
    problems.push({
      field: 'version',
      message: `version must be 1 (got ${JSON.stringify(cfg.version)})`,
    });
  }

  // serverUrl — required, http: or https: only, trailing slash stripped.
  let serverUrl = '';
  if (cfg.serverUrl === undefined || cfg.serverUrl === null || cfg.serverUrl === '') {
    problems.push({ field: 'serverUrl', message: 'serverUrl is required' });
  } else if (typeof cfg.serverUrl !== 'string') {
    problems.push({ field: 'serverUrl', message: 'serverUrl must be a string' });
  } else if (cfg.serverUrl.trim() === '') {
    problems.push({ field: 'serverUrl', message: 'serverUrl is required' });
  } else {
    const trimmed = cfg.serverUrl.trim();
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      parsedUrl = null;
    }
    if (!parsedUrl) {
      problems.push({ field: 'serverUrl', message: `serverUrl is not a valid URL (got "${trimmed}")` });
    } else if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      problems.push({
        field: 'serverUrl',
        message: `serverUrl must use http:// or https:// (got "${parsedUrl.protocol}//")`,
      });
    } else {
      serverUrl = trimmed.replace(/\/+$/, '');
    }
  }

  // ingestToken — required. The server 401s every ingest request without a
  // matching one, so absent is a broken config, not a degraded mode. The value
  // is never echoed back in a message.
  let ingestToken = '';
  if (cfg.ingestToken === undefined || cfg.ingestToken === null) {
    problems.push({ field: 'ingestToken', message: 'ingestToken is required' });
  } else if (typeof cfg.ingestToken !== 'string') {
    problems.push({ field: 'ingestToken', message: 'ingestToken must be a string' });
  } else if (cfg.ingestToken.trim() === '') {
    problems.push({ field: 'ingestToken', message: 'ingestToken is required' });
  } else {
    ingestToken = cfg.ingestToken;
  }

  // certPath — optional PEM for the server's self-signed certificate.
  let certPath: string | null = DEFAULTS.certPath;
  if (cfg.certPath !== undefined && cfg.certPath !== null && cfg.certPath !== '') {
    if (typeof cfg.certPath !== 'string') {
      problems.push({ field: 'certPath', message: 'certPath must be a string or null' });
    } else if (cfg.certPath.trim() === '') {
      certPath = null;
    } else {
      const candidate = cfg.certPath.trim();
      if (options.isReadableFile && !options.isReadableFile(candidate)) {
        problems.push({ field: 'certPath', message: `certPath is not readable: ${candidate}` });
      } else {
        certPath = candidate;
      }
    }
  }

  // trafficEnabled — false only for the four values the agent treated as off.
  // Anything else, including absent and '', is true.
  const trafficEnabled =
    cfg.trafficEnabled === undefined || cfg.trafficEnabled === null
      ? DEFAULTS.trafficEnabled
      : !(TRAFFIC_DISABLE_VALUES as readonly string[]).includes(
          String(cfg.trafficEnabled).trim().toLowerCase(),
        );

  // trafficRadiusM — out of range is a clamp, not a rejection: the file
  // replaces an environment variable and must not be stricter than it was.
  let trafficRadiusM: number = DEFAULTS.trafficRadiusM;
  if (cfg.trafficRadiusM !== undefined && cfg.trafficRadiusM !== null) {
    const n = Number(cfg.trafficRadiusM);
    if (!Number.isFinite(n)) {
      warnings.push({
        field: 'trafficRadiusM',
        message: `Invalid trafficRadiusM (${String(cfg.trafficRadiusM)}) — using default ${DEFAULTS.trafficRadiusM}`,
      });
    } else {
      trafficRadiusM = Math.min(
        DEFAULTS.trafficRadiusMaxM,
        Math.max(DEFAULTS.trafficRadiusMinM, Math.round(n)),
      );
    }
  }

  // sim — a JSON number here means a hand-edit went wrong: the CLI flag this
  // replaces could only ever produce a string.
  let sim: SimId = DEFAULTS.sim;
  if (cfg.sim !== undefined && cfg.sim !== null) {
    if (typeof cfg.sim !== 'string') {
      problems.push({ field: 'sim', message: 'sim must be a string' });
    } else {
      const candidate = cfg.sim.trim().toLowerCase();
      if ((SIM_IDS as readonly string[]).includes(candidate)) {
        sim = candidate as SimId;
      } else {
        problems.push({
          field: 'sim',
          message: `sim must be one of 2020, 2024, fsx (got "${cfg.sim}")`,
        });
      }
    }
  }

  let autoUplink: boolean = DEFAULTS.autoUplink;
  if (cfg.autoUplink !== undefined && cfg.autoUplink !== null) {
    if (typeof cfg.autoUplink !== 'boolean') {
      problems.push({ field: 'autoUplink', message: 'autoUplink must be a boolean' });
    } else {
      autoUplink = cfg.autoUplink;
    }
  }

  let nodePath: string | null = DEFAULTS.nodePath;
  if (cfg.nodePath !== undefined && cfg.nodePath !== null && cfg.nodePath !== '') {
    if (typeof cfg.nodePath !== 'string') {
      problems.push({ field: 'nodePath', message: 'nodePath must be a string or null' });
    } else {
      nodePath = cfg.nodePath;
    }
  }

  if (problems.length > 0) {
    return { ok: false, reason: 'invalid', path: '', problems };
  }

  return {
    ok: true,
    config: {
      version,
      serverUrl,
      ingestToken,
      certPath,
      trafficEnabled,
      trafficRadiusM,
      sim,
      autoUplink,
      nodePath,
    },
    warnings,
  };
}

/** The only supported way to produce something printable. */
export function redact(config: EffectiveConfig): RedactedConfig {
  const { ingestToken, ...rest } = config;
  return { ...rest, tokenSet: typeof ingestToken === 'string' && ingestToken.trim() !== '' };
}
