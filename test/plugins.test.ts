import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyze,
  ConfigError,
  createRegistry,
  loadPlugins,
  memoryFileSystem,
  parseConfig,
  RuleRegistryError,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { byCode, WF } from './helpers';

const files = {
  [`${WF}/a.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: echo hi }]\n',
  [`${WF}/b.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: echo hi }]\n',
};

/** Source of a plugin rule that reports once per workflow. */
const rule = (code: string, name: string, extra = '') => `{
  code: '${code}',
  name: '${name}',
  category: 'structure',
  defaultSeverity: 'warning',
  docsUrl: 'https://example.com/rules/${code.toLowerCase()}',
  docs: { summary: 'Every workflow is reported.', why: 'Because.', fix: 'Do nothing.' },
  ${extra}
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      ctx.report({
        message: '${code} saw ' + wf.path,
        loc: { file: wf.file, line: 1, column: 1, endLine: 1, endColumn: 1 },
        symbol: wf.path,
      });
    }
  },
}`;

/** Writes plugin modules into a fresh directory and returns it. */
const pluginDir = (modules: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'flowpact-plugins-'));
  for (const [file, src] of Object.entries(modules)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), src);
  }
  return root;
};

const load = async (root: string, plugins: string[], extra: Record<string, unknown> = {}) => {
  const config = parseConfig({ plugins, ...extra });
  const registry = createRegistry();
  const loaded = await loadPlugins(root, config, registry);
  return { loaded, registry, config };
};

const run = async (root: string, plugins: string[], extra: Record<string, unknown> = {}) => {
  const { registry, config, loaded } = await load(root, plugins, extra);
  const result = analyze({
    root,
    fs: memoryFileSystem(files),
    config,
    registry,
    validateSchema: false,
    repository: 'acme/repo',
  });
  return { result, loaded };
};

describe('loadPlugins', () => {
  it('registers a default-exported rule and reports its findings with its docs URL', async () => {
    const root = pluginDir({
      'flowpact/one.mjs': `export default ${rule('ACME601', 'acme-every-workflow')};\n`,
    });
    const { result, loaded } = await run(root, ['flowpact/one.mjs']);
    expect(loaded.map((r) => r.code)).toEqual(['ACME601']);
    const found = byCode(result, 'ACME601');
    expect(found.map((f) => [f.message, f.severity, f.docsUrl, f.category])).toEqual([
      [`ACME601 saw ${WF}/a.yml`, 'warning', 'https://example.com/rules/acme601', 'structure'],
      [`ACME601 saw ${WF}/b.yml`, 'warning', 'https://example.com/rules/acme601', 'structure'],
    ]);
    expect(result.rules.find((r) => r.code === 'ACME601')).toEqual({
      code: 'ACME601',
      name: 'acme-every-workflow',
      severity: 'warning',
    });
  });

  it('accepts an array, `{ rules }` as default, and a named `rules` export', async () => {
    const root = pluginDir({
      'array.mjs': `export default [${rule('ARR601', 'arr-one')}, ${rule('ARR602', 'arr-two')}];\n`,
      'object.mjs': `export default { rules: [${rule('OBJ601', 'obj-one')}] };\n`,
      'named.mjs': `export const rules = [${rule('NAM601', 'nam-one')}];\n`,
    });
    const { loaded, registry } = await load(root, ['array.mjs', 'object.mjs', join(root, 'named.mjs')]);
    expect(loaded.map((r) => r.code)).toEqual(['ARR601', 'ARR602', 'OBJ601', 'NAM601']);
    expect(registry.get('obj-one')?.code).toBe('OBJ601');
  });

  it('lets config severities and overrides apply to plugin rules', async () => {
    const root = pluginDir({ 'p.mjs': `export default ${rule('ACME601', 'acme-every-workflow')};\n` });
    const { result } = await run(root, ['p.mjs'], {
      rules: { 'acme-every-workflow': 'error' },
      overrides: [{ rule: 'ACME601', target: `${WF}/b.yml`, reason: 'b is generated elsewhere' }],
    });
    expect(byCode(result, 'ACME601').map((f) => [f.loc.file, f.severity])).toEqual([
      [`${WF}/a.yml`, 'error'],
    ]);
    expect(result.suppressed.map((f) => f.code)).toEqual(['ACME601']);
  });

  it('fails with a ConfigError when the module does not exist', async () => {
    const root = pluginDir({});
    await expect(load(root, ['missing.mjs'])).rejects.toThrow(ConfigError);
    await expect(load(root, ['missing.mjs'])).rejects.toThrow('Plugin not found: missing.mjs');
  });

  it('fails with a ConfigError when the module exports no rules', async () => {
    const root = pluginDir({
      'empty.mjs': 'export default { hello: 1 };\n',
      'none.mjs': 'export const x = 1;\n',
    });
    await expect(load(root, ['empty.mjs'])).rejects.toThrow('Plugin empty.mjs exports no rules');
    await expect(load(root, ['none.mjs'])).rejects.toThrow(ConfigError);
  });

  it('fails with a ConfigError when the module cannot be loaded', async () => {
    const root = pluginDir({ 'broken.mjs': 'export default {\n' });
    const err = await load(root, ['broken.mjs']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/^Plugin broken\.mjs failed to load: /);
  });

  it('rejects the reserved FP prefix, invalid codes and missing docsUrl', async () => {
    const root = pluginDir({
      'flowpact.mjs': `export default ${rule('FP699', 'not-mine')};\n`,
      'docs.mjs': `export default ${rule('ACME601', 'acme-x').replace(/docsUrl: .*\n/, '')};\n`,
      'dup.mjs': `export default ${rule('ACME601', 'unused-input')};\n`,
      'cat.mjs': `export default ${rule('ACME101', 'acme-cat')};\n`,
    });
    await expect(load(root, ['flowpact.mjs'])).rejects.toThrow(RuleRegistryError);
    await expect(load(root, ['flowpact.mjs'])).rejects.toThrow(
      'the FP prefix is reserved for built-in rules',
    );
    await expect(load(root, ['docs.mjs'])).rejects.toThrow('plugin rules must set docsUrl');
    await expect(load(root, ['dup.mjs'])).rejects.toThrow('Duplicate rule name unused-input');
    await expect(load(root, ['cat.mjs'])).rejects.toThrow('category digit 1 means "inputs"');
  });

  it('does nothing without plugins', async () => {
    const { loaded, registry } = await load(pluginDir({}), []);
    expect(loaded).toEqual([]);
    expect(registry.all().every((r) => r.code.startsWith('FP'))).toBe(true);
  });
});
