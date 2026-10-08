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
      plugins: [],
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
