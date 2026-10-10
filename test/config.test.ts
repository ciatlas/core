import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  configJsonSchema,
  defaultConfig,
  loadConfig,
  matchesPattern,
  parseConfig,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';

describe('config', () => {
  it('fills defaults', () => {
    expect(defaultConfig()).toEqual({
      version: 1,
      rules: {},
      limits: { nestingDepth: 10, maxInputs: 30 },
      ignore: [],
      overrides: [],
      matrixShapes: {},
      generated: { include: [], exclude: [] },
      plugins: [],
      impact: {
        labels: { major: 'semver:major', minor: 'semver:minor', patch: 'semver:patch', none: 'semver:none' },
        types: { feat: 'minor', fix: 'patch', perf: 'patch' },
        uncertain: 'warn',
      },
    });
  });

  it('rejects unknown keys and bad values with paths', () => {
    expect(() => parseConfig({ rulez: {} })).toThrow(ConfigError);
    try {
      parseConfig({ rules: { FP101: 'fatal' }, limits: { nestingDepth: 0 } });
    } catch (err) {
      expect((err as ConfigError).issues.map((i) => i.split(':')[0])).toEqual([
        'rules.FP101',
        'limits.nestingDepth',
      ]);
    }
  });

  it('loads from the default location, or an explicit path', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-'));
    expect(loadConfig(root).file).toBeUndefined();
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/flowpact/flowpact.config.yml'),
      'rules:\n  FP104: off\nlimits:\n  maxInputs: 5\n',
    );
    const loaded = loadConfig(root);
    expect(loaded.file).toBe('.github/flowpact/flowpact.config.yml');
    expect(loaded.config.rules).toEqual({ FP104: 'off' });
    expect(loaded.config.limits).toEqual({ nestingDepth: 10, maxInputs: 5 });
    expect(() => loadConfig(root, join(root, 'missing.yml'))).toThrow(/not found/);
    writeFileSync(join(root, 'bad.yml'), 'rules: [\n');
    expect(() => loadConfig(root, join(root, 'bad.yml'))).toThrow(/not valid YAML/);
  });

  it('exports a JSON schema', () => {
    const s = configJsonSchema();
    expect(s.$id).toBe('https://rumankazi.github.io/flowpact/schemas/config/v1.json');
    expect(JSON.stringify(s)).toContain('nestingDepth');
  });

  it.each([
    ['.github/workflows/a.yml', '.github/workflows', true],
    ['.github/workflows/a.yml', '.github/work', false],
    ['.github/workflows/a.yml', '.github/workflows/*.yml', true],
    ['.github/workflows/sub/a.yml', '.github/workflows/*.yml', false],
    ['.github/workflows/sub/a.yml', '.github/**/a.yml', true],
    ['.github/workflows/a.yml', '.github/workflows/a.yml', true],
  ])('matchesPattern(%s, %s) = %s', (path, pattern, expected) => {
    expect(matchesPattern(path, pattern)).toBe(expected);
  });
});

describe('base config', () => {
  /** A repository with `repoConfig` at the default location and a base config outside it. */
  const setup = (repoConfig: string | undefined, baseConfig: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'flowpact-base-'));
    const root = join(dir, 'repo');
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    if (repoConfig !== undefined)
      writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), repoConfig);
    const base = join(dir, 'base.yml');
    writeFileSync(base, baseConfig);
    return { root, base };
  };
  const issues = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return { file: (err as ConfigError).file, issues: (err as ConfigError).issues };
    }
    return expect.unreachable();
  };

  it('puts the repository config on top: maps merge key by key, lists add up', () => {
    const { root, base } = setup(
      [
        'rules:',
        '  FP105: warning',
        '  unused-output: info',
        'limits:',
        '  maxInputs: 40',
        'ignore: [legacy/**]',
        'overrides:',
        '  - rule: FP104',
        '    file: .github/workflows/a.yml',
        '    reason: kept for an external caller',
        'impact:',
        '  types: { refactor: patch }',
      ].join('\n'),
      [
        'rules:',
        '  FP105: error',
        '  FP303: off',
        'limits:',
        '  nestingDepth: 6',
        'ignore: [vendor/**]',
        'generated: { include: [.github/workflows/gen-*.yml] }',
        'impact:',
        '  declaredBy: labels',
        '  types: { feat: minor, fix: patch }',
      ].join('\n'),
    );
    const loaded = loadConfig(root, undefined, { base });
    expect(loaded.base?.file).toBe(base);
    expect(loaded.file).toBe('.github/flowpact/flowpact.config.yml');
    const c = loaded.config;
    expect(c.rules).toEqual({ FP105: 'warning', FP303: 'off', 'unused-output': 'info' });
    expect(c.limits).toEqual({ nestingDepth: 6, maxInputs: 40 });
    expect(c.ignore).toEqual(['vendor/**', 'legacy/**']);
    expect(c.generated.include).toEqual(['.github/workflows/gen-*.yml']);
    expect(c.impact.declaredBy).toBe('labels');
    expect(c.impact.types).toEqual({ feat: 'minor', fix: 'patch', refactor: 'patch' });
    // Overrides come only from the repository, so their locations stay those of its config file.
    expect(c.overrides).toHaveLength(1);
    expect(loaded.overrideLocs?.[0]).toMatchObject({ file: '.github/flowpact/flowpact.config.yml', line: 8 });
  });

  it('applies alone when the repository has no config', () => {
    const { root, base } = setup(undefined, 'rules:\n  FP105: error\n');
    const loaded = loadConfig(root, undefined, { base });
    expect(loaded.file).toBeUndefined();
    expect(loaded.config.rules).toEqual({ FP105: 'error' });
    expect(loaded.config.limits).toEqual(defaultConfig().limits);
  });

  it('refuses what belongs to one repository, and plugins', () => {
    const { root, base } = setup(
      undefined,
      [
        'repository: acme/app',
        'plugins: [./rules.mjs]',
        'overrides: []',
        'matrixShapes: {}',
        'impact: { publish: [action.yml] }',
      ].join('\n'),
    );
    expect(issues(() => loadConfig(root, undefined, { base }))).toEqual({
      file: base,
      issues: [
        "repository: belongs in the repository's config, not in a base config",
        "overrides: belongs in the repository's config, not in a base config",
        "matrixShapes: belongs in the repository's config, not in a base config",
        'plugins: not in a base config; load organization rules with --plugin',
        "impact.publish: belongs in the repository's config, not in a base config",
      ],
    });
  });

  it('rejects a __proto__ key with a base config as without one', () => {
    const { root, base } = setup('__proto__:\n  ignore: [.github/]\n', 'rules:\n  FP105: error\n');
    const without = issues(() => loadConfig(root));
    const withBase = issues(() => loadConfig(root, undefined, { base }));
    expect(withBase).toEqual(without);
    expect(withBase.issues.join()).toContain('__proto__');
  });

  it('names the file a problem is in', () => {
    const invalidBase = setup('rules: {}\n', 'rules:\n  FP105: loud\n');
    expect(issues(() => loadConfig(invalidBase.root, undefined, { base: invalidBase.base })).file).toBe(
      invalidBase.base,
    );
    const invalidRepo = setup('limits:\n  maxInputs: -1\n', 'rules:\n  FP105: error\n');
    expect(issues(() => loadConfig(invalidRepo.root, undefined, { base: invalidRepo.base }))).toMatchObject({
      file: '.github/flowpact/flowpact.config.yml',
      issues: [expect.stringMatching(/^limits\.maxInputs: /)],
    });
    expect(issues(() => loadConfig(invalidRepo.root, undefined, { base: 'missing.yml' }))).toMatchObject({
      file: 'missing.yml',
    });
  });
});
