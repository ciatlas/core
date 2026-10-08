import {
  analyze,
  ConfigError,
  createRegistry,
  defineRule,
  exitCodeFor,
  fingerprint,
  memoryFileSystem,
  parseConfig,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { codes, lint, WF } from './helpers';

const files = {
  [`${WF}/a.yml`]:
    'on:\n  workflow_dispatch:\n    inputs:\n      dead: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ env.NOPE }}\n',
  [`${WF}/b.yml`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
};

describe('analyze', () => {
  it('applies severity overrides by code or name and can turn rules off', () => {
    const r = lint(files, { config: { rules: { FP104: 'error', 'undefined-env-ref': 'off' } } });
    expect(r.findings.map((f) => `${f.code}:${f.severity}`)).toEqual(['FP104:error', 'FP607:info']);
    expect(r.rules.find((x) => x.code === 'FP501')?.severity).toBe('off');
  });

  it('rejects unknown rules in config with a suggestion', () => {
    try {
      lint(files, { config: { rules: { 'unused-inptu': 'off' } } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues[0]).toBe(
        'rules.unused-inptu: unknown rule (did you mean unused-input?)',
      );
    }
  });

  it('runs only selected rules', () => {
    expect(codes(lint(files, { only: ['FP104'] }))).toEqual(['FP104']);
    expect(codes(lint(files, { only: ['unreferenced-reusable-workflow'] }))).toEqual(['FP607']);
  });

  it('reports only on target paths but still analyzes everything', () => {
    const r = lint(files, { paths: [`${WF}/b.yml`] });
    expect(codes(r)).toEqual(['FP607']);
    expect(r.summary.workflows).toBe(2);
  });

  it('honours ignore patterns', () => {
    expect(codes(lint(files, { config: { ignore: ['.github/workflows/a.*'] } }))).toEqual(['FP607']);
    expect(codes(lint(files, { config: { ignore: ['.github/workflows'] } }))).toEqual([]);
  });

  it('summarizes findings and the graph', () => {
    const r = lint(files);
    expect(r.summary).toMatchObject({
      errors: 0,
      warnings: 2,
      infos: 1,
      total: 3,
      workflows: 2,
      actions: 0,
      jobs: 2,
    });
    expect(r.summary.byCode).toEqual({ FP104: 1, FP501: 1, FP607: 1 });
    expect(r.meta).toMatchObject({ tool: 'flowpact', schemas: { config: 1, contract: 1, report: 1 } });
  });

  it('sorts findings by location then severity', () => {
    const r = lint(files);
    expect(r.findings.map((f) => `${f.loc.file}:${f.loc.line}`)).toEqual([
      `${WF}/a.yml:4`,
      `${WF}/a.yml:9`,
      `${WF}/b.yml:1`,
    ]);
  });

  it('logs every pipeline stage', () => {
    const msgs = lint(files).logs.map((l) => `${l.scope}|${l.message}`);
    for (const expected of [
      'flowpact|config resolved',
      'flowpact:load|discovered 2 workflow(s) and 0 local action(s)',
      'flowpact:load|parsed workflow .github/workflows/a.yml',
      'flowpact|graph built: ',
      'flowpact:rules|FP101 missing-required-input',
      'flowpact|analysis finished: ',
    ]) {
      expect(msgs.some((m) => m.startsWith(expected))).toBe(true);
    }
  });

  it('logs matrix expansion', () => {
    const r = lint({
      [`${WF}/m.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n        a: [1, 2]\n    steps: [{ run: x }]\n',
    });
    expect(r.logs.find((l) => l.message.startsWith('matrix expanded'))?.data).toMatchObject({
      combinations: 2,
      keys: ['a'],
    });
    expect(r.summary.matrixCombinations).toBe(2);
  });

  it('lets a finding report below its rule’s severity, never above the configured one', () => {
    const registry = createRegistry().register(
      defineRule({
        code: 'ACME101',
        name: 'acme-levels',
        category: 'inputs',
        defaultSeverity: 'warning',
        docs: { summary: 's', why: 'w', fix: 'f' },
        docsUrl: 'https://example.com/acme101',
        check(ctx) {
          const wf = [...ctx.index.project.workflows.values()][0]!;
          for (const severity of [undefined, 'info', 'error'] as const)
            ctx.report({
              message: `asked ${severity ?? 'nothing'}`,
              loc: wf.source.loc(0),
              ...(severity ? { severity } : {}),
            });
        },
      }),
    );
    const levels = (rules: Record<string, string> = {}) =>
      analyze({
        root: '/virtual/repo',
        fs: memoryFileSystem(files),
        config: parseConfig({ rules }),
        registry,
        only: ['ACME101'],
      })
        .findings.map((f) => `${f.message}: ${f.severity}`)
        .sort();
    expect(levels()).toEqual(['asked error: warning', 'asked info: info', 'asked nothing: warning']);
    expect(levels({ ACME101: 'error' })).toEqual([
      'asked error: error',
      'asked info: info',
      'asked nothing: error',
    ]);
    expect(levels({ ACME101: 'info' })).toEqual([
      'asked error: info',
      'asked info: info',
      'asked nothing: info',
    ]);
  });
});

describe('fingerprints', () => {
  it('are stable across unrelated edits and number changes', () => {
    const a = lint(files).findings.map((f) => f.fingerprint);
    const shifted = lint({
      ...files,
      [`${WF}/a.yml`]: `# comment\n# another\n${files[`${WF}/a.yml`]}`,
    }).findings.map((f) => f.fingerprint);
    expect(shifted).toEqual(a);
    expect(fingerprint('FP1', 's', 'f', 'in 2 of 3')).toBe(fingerprint('FP1', 's', 'f', 'in 5 of 9'));
    expect(fingerprint('FP1', 's', 'f', 'x')).not.toBe(fingerprint('FP2', 's', 'f', 'x'));
  });
});

describe('exitCodeFor', () => {
  it.each([
    [{ errors: 0, warnings: 0 }, 'error', 0],
    [{ errors: 1, warnings: 0 }, 'error', 1],
    [{ errors: 0, warnings: 2 }, 'error', 0],
    [{ errors: 0, warnings: 2 }, 'warning', 1],
    [{ errors: 5, warnings: 2 }, 'never', 0],
  ] as const)('%j fail-on %s → %d', (s, failOn, code) => expect(exitCodeFor(s, failOn)).toBe(code));
});
