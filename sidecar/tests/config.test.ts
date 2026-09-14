// tests/config.test.ts — tests src/config.ts.
//
// The tables below are the validation rules stated as data: one row per input,
// one expectation per row. They exist because these rules are a transcription
// of what the old environment-variable agent did, and a silent drift in any of
// them changes the behaviour of a config file a user already wrote.
//
// Nothing here imports node-simconnect, undici, http or https. validateConfig
// is called without a readability probe, so it touches no disk; the few cases
// that need a real file use loadConfig against the committed fixtures in
// samples/config/, read-only.

import { describe, expect, it } from 'vitest';
import * as path from 'path';
import {
  DEFAULTS,
  loadConfig,
  parseConfigArg,
  redact,
  resolveConfigPath,
  validateConfig,
  type ConfigLoadResult,
  type EffectiveConfig,
} from '../src/config';

const SAMPLES = path.join(__dirname, '..', 'samples', 'config');

/** A minimal config that passes, so each table row varies exactly one field. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverUrl: 'http://192.168.0.30:3000',
    ingestToken: 'PLACEHOLDER-TOKEN',
    ...overrides,
  };
}

function expectOk(result: ConfigLoadResult): EffectiveConfig {
  if (!result.ok) {
    throw new Error(`expected ok, got problems: ${result.problems.map((p) => p.message).join('; ')}`);
  }
  return result.config;
}

function problemFields(result: ConfigLoadResult): string[] {
  return result.ok ? [] : result.problems.map((p) => p.field);
}

describe('validateConfig — sim', () => {
  const accepted: [unknown, string][] = [
    ['2020', '2020'],
    ['2024', '2024'],
    ['fsx', 'fsx'],
    ['FSX', 'fsx'],
    [' 2024 ', '2024'],
    [undefined, DEFAULTS.sim],
  ];

  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input)} as ${expected}`, () => {
      const result = validateConfig(base(input === undefined ? {} : { sim: input }));
      expect(expectOk(result).sim).toBe(expected);
    });
  }

  const rejected: unknown[] = ['2019', 'msfs', ''];

  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)} on value`, () => {
      const result = validateConfig(base({ sim: input }));
      expect(result.ok).toBe(false);
      expect(problemFields(result)).toContain('sim');
      if (!result.ok) {
        expect(result.problems[0].message).toBe(
          `sim must be one of 2020, 2024, fsx (got "${String(input)}")`,
        );
      }
    });
  }

  it('rejects a number on type, before the value is compared', () => {
    const result = validateConfig(base({ sim: 2024 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toBe('sim must be a string');
  });
});

describe('validateConfig — trafficRadiusM', () => {
  const rows: [unknown, number][] = [
    [999, 1000],
    [1000, 1000],
    [40000, 40000],
    [200001, 200000],
    [1500.6, 1501],
    ['2500', 2500],
  ];

  for (const [input, expected] of rows) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      const result = validateConfig(base({ trafficRadiusM: input }));
      expect(expectOk(result).trafficRadiusM).toBe(expected);
    });
  }

  it("'abc' falls back to 40000 with a warning naming the field", () => {
    const result = validateConfig(base({ trafficRadiusM: 'abc' }));
    const config = expectOk(result);
    expect(config.trafficRadiusM).toBe(40000);
    if (result.ok) {
      expect(result.warnings).toEqual([
        {
          field: 'trafficRadiusM',
          message: 'Invalid trafficRadiusM (abc) — using default 40000',
        },
      ]);
    }
  });

  it('is absent-safe and warning-free by default', () => {
    const result = validateConfig(base());
    expect(expectOk(result).trafficRadiusM).toBe(40000);
    if (result.ok) expect(result.warnings).toEqual([]);
  });

  it('clamping is not a rejection', () => {
    expect(validateConfig(base({ trafficRadiusM: 1 })).ok).toBe(true);
  });
});

describe('validateConfig — trafficEnabled', () => {
  const falsy: unknown[] = [0, '0', false, 'false', 'OFF', 'no'];
  for (const input of falsy) {
    it(`${JSON.stringify(input)} disables traffic`, () => {
      expect(expectOk(validateConfig(base({ trafficEnabled: input }))).trafficEnabled).toBe(false);
    });
  }

  const truthy: [string, unknown][] = [
    ['unset', undefined],
    ['empty string', ''],
    ["'yes'", 'yes'],
    ['1', 1],
    ['true', true],
  ];
  for (const [label, input] of truthy) {
    it(`${label} leaves traffic enabled`, () => {
      const raw = input === undefined ? base() : base({ trafficEnabled: input });
      expect(expectOk(validateConfig(raw)).trafficEnabled).toBe(true);
    });
  }
});

describe('validateConfig — serverUrl and ingestToken', () => {
  it('rejects a missing serverUrl', () => {
    const result = validateConfig({ ingestToken: 'PLACEHOLDER-TOKEN' });
    expect(problemFields(result)).toContain('serverUrl');
    if (!result.ok) expect(result.problems[0].message).toBe('serverUrl is required');
  });

  it('rejects an empty serverUrl', () => {
    expect(problemFields(validateConfig(base({ serverUrl: '   ' })))).toContain('serverUrl');
  });

  it('rejects a non-http(s) scheme', () => {
    const result = validateConfig(base({ serverUrl: 'ftp://192.168.0.30:3000' }));
    expect(problemFields(result)).toContain('serverUrl');
    if (!result.ok) expect(result.problems[0].message).toContain('http:// or https://');
  });

  it('rejects an unparseable URL', () => {
    expect(problemFields(validateConfig(base({ serverUrl: 'not a url' })))).toContain('serverUrl');
  });

  it('strips trailing slashes', () => {
    expect(expectOk(validateConfig(base({ serverUrl: 'https://host:3000///' }))).serverUrl).toBe(
      'https://host:3000',
    );
  });

  it('rejects a missing ingestToken', () => {
    const result = validateConfig({ serverUrl: 'http://host:3000' });
    expect(problemFields(result)).toContain('ingestToken');
    if (!result.ok) expect(result.problems[0].message).toBe('ingestToken is required');
  });

  it('rejects a blank ingestToken and never quotes its value', () => {
    const result = validateConfig(base({ ingestToken: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toBe('ingestToken is required');
  });
});

describe('validateConfig — remaining fields', () => {
  it('defaults everything optional', () => {
    const config = expectOk(validateConfig(base()));
    expect(config).toEqual({
      version: 1,
      serverUrl: 'http://192.168.0.30:3000',
      ingestToken: 'PLACEHOLDER-TOKEN',
      certPath: null,
      trafficEnabled: true,
      trafficRadiusM: 40000,
      sim: '2020',
      autoUplink: false,
      nodePath: null,
    });
  });

  it('rejects a non-boolean autoUplink', () => {
    expect(problemFields(validateConfig(base({ autoUplink: 'yes' })))).toContain('autoUplink');
  });

  it('rejects a version other than 1', () => {
    expect(problemFields(validateConfig(base({ version: 2 })))).toContain('version');
  });

  it('ignores unknown keys rather than failing on them', () => {
    expect(validateConfig(base({ somethingNewer: 42 })).ok).toBe(true);
  });

  it('rejects a non-object document', () => {
    for (const raw of [null, 42, 'text', [1, 2]]) {
      const result = validateConfig(raw);
      expect(result.ok).toBe(false);
      expect(problemFields(result)).toEqual(['*']);
    }
  });

  it('reports one problem per offending field', () => {
    const result = validateConfig({ sim: 'nope', autoUplink: 3 });
    expect(problemFields(result).sort()).toEqual(['autoUplink', 'ingestToken', 'serverUrl', 'sim']);
  });

  it('skips the certPath readability probe when none is supplied', () => {
    expect(expectOk(validateConfig(base({ certPath: 'C:\\nope.pem' }))).certPath).toBe('C:\\nope.pem');
  });

  it('rejects an unreadable certPath when probed', () => {
    const result = validateConfig(base({ certPath: '/no/such/cert.pem' }), {
      isReadableFile: () => false,
    });
    expect(problemFields(result)).toContain('certPath');
    if (!result.ok) expect(result.problems[0].message).toBe('certPath is not readable: /no/such/cert.pem');
  });
});

describe('redact', () => {
  it('drops the token and reports only whether one is set', () => {
    const config = expectOk(validateConfig(base()));
    const redacted = redact(config);
    expect(redacted.tokenSet).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('PLACEHOLDER-TOKEN');
    expect('ingestToken' in redacted).toBe(false);
  });
});

describe('resolveConfigPath and parseConfigArg', () => {
  it('reads both --config forms', () => {
    expect(parseConfigArg(['--config', '/tmp/a.json'])).toBe('/tmp/a.json');
    expect(parseConfigArg(['--config=/tmp/b.json'])).toBe('/tmp/b.json');
    expect(parseConfigArg(['--other'])).toBeUndefined();
  });

  it('prefers the explicit override', () => {
    // `path.resolve` on win32 would rewrite a drive-less rooted path like
    // this to the current drive (e.g. `D:\tmp\explicit.json`); an absolute
    // path must come back byte-for-byte instead.
    expect(resolveConfigPath('/tmp/explicit.json')).toBe('/tmp/explicit.json');
  });

  it('still resolves a genuinely relative override against cwd', () => {
    expect(resolveConfigPath('relative.json')).toBe(path.resolve('relative.json'));
  });

  it('falls back to a platform path that ends in msfslogger/config.json', () => {
    expect(resolveConfigPath()).toMatch(/msfslogger[\\/]config\.json$/);
  });

  it('prefers MSFSLOGGER_CONFIG over the platform default, absolute path untouched', () => {
    const prior = process.env.MSFSLOGGER_CONFIG;
    process.env.MSFSLOGGER_CONFIG = '/tmp/from-env.json';
    try {
      expect(resolveConfigPath()).toBe('/tmp/from-env.json');
    } finally {
      if (prior === undefined) delete process.env.MSFSLOGGER_CONFIG;
      else process.env.MSFSLOGGER_CONFIG = prior;
    }
  });

  it('resolves a relative MSFSLOGGER_CONFIG against cwd', () => {
    const prior = process.env.MSFSLOGGER_CONFIG;
    process.env.MSFSLOGGER_CONFIG = 'from-env-relative.json';
    try {
      expect(resolveConfigPath()).toBe(path.resolve('from-env-relative.json'));
    } finally {
      if (prior === undefined) delete process.env.MSFSLOGGER_CONFIG;
      else process.env.MSFSLOGGER_CONFIG = prior;
    }
  });
});

describe('loadConfig against the committed fixtures', () => {
  it('accepts good.json', () => {
    const result = loadConfig(path.join(SAMPLES, 'good.json'));
    expect(expectOk(result).sim).toBe('2024');
  });

  it('reports a missing file as missing, with the path', () => {
    const missing = path.join(SAMPLES, 'no-such-config.json');
    const result = loadConfig(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('missing');
      expect(result.path).toBe(missing);
    }
  });

  const badFixtures = [
    'bad-missing-serverurl.json',
    'bad-scheme.json',
    'bad-missing-token.json',
    'bad-sim-value.json',
    'bad-sim-type.json',
    'bad-malformed-json.json',
    'bad-wrong-type.json',
    'bad-cert-unreadable.json',
    'bad-version.json',
  ];

  for (const name of badFixtures) {
    it(`rejects ${name} with at least one one-line problem`, () => {
      const result = loadConfig(path.join(SAMPLES, name));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('invalid');
        expect(result.problems.length).toBeGreaterThan(0);
        for (const problem of result.problems) {
          expect(problem.message).not.toContain('\n');
        }
      }
    });
  }
});
