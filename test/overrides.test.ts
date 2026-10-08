import {
  analyze,
  ConfigError,
  matchesTarget,
  memoryFileSystem,
  parseConfig,
  parseConfigText,
  reportSchema,
  toJsonReport,
} from '@wfc/core';
import { describe, expect, it } from 'vitest';
import { byCode, codes, WF, yaml } from './helpers';

const CONFIG = '.github/workflow-contracts/wfc.config.yml';

const files = {
  [`${WF}/a.yml`]: yaml`
    on:
      workflow_dispatch:
        inputs:
          dead: {}
          legacy: {}
    jobs:
      j:
        runs-on: x
        steps:
          - run: echo hi
  `,
  [`${WF}/b.yml`]: yaml`
    on:
      workflow_dispatch:
        inputs:
          old: {}
    jobs:
      j:
        runs-on: x
        steps:
          - run: echo hi
  `,
};

const symbols = (r: { findings: { code: string; symbol?: string }[] }) =>
  r.findings.filter((f) => f.code === 'WFC104').map((f) => f.symbol);

/** Analyzes `files` with a config given as YAML text, so overrides have real locations. */
const run = (configText: string, today = '2026-06-01') => {
  const { config, overrideLocs } = parseConfigText(configText, CONFIG);
  return {
    overrideLocs,
    ...analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem(files),
      config,
      overrideLocs,
      configFile: CONFIG,
      configText,
      now: new Date(`${today}T15:30:00Z`),
      validateSchema: false,
      repository: 'acme/repo',
    }),
  };
};

const override = (fields: string) =>
  `overrides:\n  - reason: accepted until the migration (JIRA-1)\n${fields}`;

describe('baseline', () => {
  it('reports one unused-input finding per input', () => {
    const r = run('rules: {}\n');
    expect(symbols(r)).toEqual([
      `${WF}/a.yml#inputs.dead`,
      `${WF}/a.yml#inputs.legacy`,
      `${WF}/b.yml#inputs.old`,
    ]);
    expect(r.suppressed).toEqual([]);
    expect(r.summary.suppressed).toBe(0);
  });
});

describe('matching', () => {
  it('suppresses by exact target and records the override that accepted the finding', () => {
    const r = run(
      override(
        `    rule: WFC104\n    target: ${WF}/a.yml#inputs.dead\n    expires: 2026-12-31\n    owner: '@platform'\n`,
      ),
    );
    expect(symbols(r)).toEqual([`${WF}/a.yml#inputs.legacy`, `${WF}/b.yml#inputs.old`]);
    expect(r.suppressed).toHaveLength(1);
    expect(r.suppressed[0]).toMatchObject({
      code: 'WFC104',
      symbol: `${WF}/a.yml#inputs.dead`,
      override: {
        index: 0,
        reason: 'accepted until the migration (JIRA-1)',
        expires: '2026-12-31',
        owner: '@platform',
      },
    });
    expect(r.summary).toMatchObject({ suppressed: 1, warnings: 2, total: 2 });
    expect(codes(r).filter((c) => c.startsWith('WFC9'))).toEqual([]);
  });

  it.each([
    [`${WF}/a.yml#inputs.*`, [`${WF}/b.yml#inputs.old`]],
    [`**/a.yml#inputs.*`, [`${WF}/b.yml#inputs.old`]],
    [`**#inputs.old`, [`${WF}/a.yml#inputs.dead`, `${WF}/a.yml#inputs.legacy`]],
    [`${WF}/*#inputs.dead`, [`${WF}/a.yml#inputs.legacy`, `${WF}/b.yml#inputs.old`]],
  ])('suppresses by target glob %s', (target, left) => {
    const r = run(override(`    rule: unused-input\n    target: '${target}'\n`));
    expect(symbols(r)).toEqual(left);
    expect(r.summary.suppressed).toBe(3 - left.length);
  });

  it('does not let `*` cross a path separator', () => {
    const r = run(override(`    rule: WFC104\n    target: '.github/*#inputs.dead'\n`));
    expect(r.summary.suppressed).toBe(0);
    expect(codes(r)).toContain('WFC902');
  });

  it.each([
    [WF, 3],
    [`${WF}/`, 3],
    [`${WF}/b.yml`, 1],
    ['.github/workflows/a.*', 2],
    ['**/b.yml', 1],
    ['.github/work', 0],
  ])('suppresses by file prefix or glob %s', (file, n) => {
    const r = run(override(`    rule: WFC104\n    file: '${file}'\n`));
    expect(r.summary.suppressed).toBe(n);
  });

  it('requires both target and file to match when both are set', () => {
    expect(
      run(override(`    rule: WFC104\n    target: '**#inputs.dead'\n    file: ${WF}/a.yml\n`)).summary
        .suppressed,
    ).toBe(1);
    const r = run(override(`    rule: WFC104\n    target: '**#inputs.dead'\n    file: ${WF}/b.yml\n`));
    expect(r.summary.suppressed).toBe(0);
    expect(codes(r)).toContain('WFC902');
  });

  it('only matches the named rule (by code, case-insensitively, or by name)', () => {
    expect(run(override(`    rule: wfc104\n    file: ${WF}\n`)).summary.suppressed).toBe(3);
    expect(run(override(`    rule: unused-input\n    file: ${WF}\n`)).summary.suppressed).toBe(3);
    expect(run(override(`    rule: unused-secret\n    file: ${WF}\n`)).summary.suppressed).toBe(0);
  });

  it('matchesTarget: exact match without wildcards, `*` within a segment, `**` across segments', () => {
    expect(matchesTarget('a/b.yml#inputs.x', 'a/b.yml#inputs.x')).toBe(true);
    expect(matchesTarget('a/b.yml#inputs.x', 'a/b.yml')).toBe(false);
    expect(matchesTarget('a/b.yml#inputs.x', 'a/*.yml#inputs.*')).toBe(true);
    expect(matchesTarget('a/c/b.yml#inputs.x', 'a/*.yml#inputs.*')).toBe(false);
    expect(matchesTarget('a/c/b.yml#inputs.x', 'a/**.yml#inputs.*')).toBe(true);
    expect(matchesTarget('a+b(c).yml', 'a+b(c).*')).toBe(true);
    expect(matchesTarget('axb', 'a.b')).toBe(false);
  });
});

describe('expiry and hygiene (WFC901–903)', () => {
  const text = (expires: string) =>
    yaml`
      rules:
        unused-input: warning
      overrides:
        - rule: WFC104
          target: ${WF}/a.yml#inputs.dead
          reason: read by the release dispatcher until JIRA-123
          expires: ${expires}
          owner: '@release'
    `;

  it('reports the finding again after expiry, plus WFC901 at the override in the config file', () => {
    const r = run(text('2026-05-31'));
    expect(symbols(r)).toContain(`${WF}/a.yml#inputs.dead`);
    expect(r.suppressed).toEqual([]);
    const [f, ...rest] = byCode(r, 'WFC901');
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      severity: 'error',
      message: `Override for WFC104 on ${WF}/a.yml#inputs.dead expired on 2026-05-31 (owner @release); 1 finding is reported again`,
      loc: { file: CONFIG, line: 4, column: 5 },
    });
    expect(f!.loc).toEqual(r.overrideLocs[0]);
    expect(f!.fix).toContain('read by the release dispatcher until JIRA-123');
    expect(r.configSource?.path).toBe(CONFIG);
    expect(codes(r)).not.toContain('WFC902');
  });

  it('keeps an override active on its expiry date', () => {
    const r = run(text('2026-06-01'));
    expect(r.summary.suppressed).toBe(1);
    expect(byCode(r, 'WFC903').map((f) => f.message)).toEqual([
      `Override for WFC104 on ${WF}/a.yml#inputs.dead expires in 0 days (2026-06-01) — owner @release`,
    ]);
  });

  it.each([
    ['2026-06-02', 'expires in 1 day (2026-06-02)'],
    ['2026-06-15', 'expires in 14 days (2026-06-15)'],
  ])('WFC903: reminds when an override expires within 14 days (%s)', (expires, msg) => {
    const r = run(text(expires));
    expect(r.summary.suppressed).toBe(1);
    const f = byCode(r, 'WFC903');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('info');
    expect(f[0]!.message).toContain(msg);
    expect(f[0]!.loc).toEqual(r.overrideLocs[0]);
  });

  it('does not remind 15 or more days ahead', () => {
    expect(codes(run(text('2026-06-16'))).filter((c) => c.startsWith('WFC9'))).toEqual([]);
    expect(codes(run(text('2027-01-01'))).filter((c) => c.startsWith('WFC9'))).toEqual([]);
  });

  it('WFC902: an override that matches nothing, at its own location', () => {
    const configText = yaml`
      overrides:
        - rule: WFC104
          target: ${WF}/a.yml#inputs.dead
          reason: accepted until the migration
        - rule: WFC104
          target: ${WF}/a.yml#inputs.typo
          reason: accepted until the migration
    `;
    const r = run(configText);
    const unused = byCode(r, 'WFC902');
    expect(unused.map((f) => [f.message, f.severity, f.loc.line])).toEqual([
      [`Override for WFC104 on ${WF}/a.yml#inputs.typo matches no finding`, 'warning', 5],
    ]);
    expect(r.overrideLocs.map((l) => l.line)).toEqual([2, 5]);
  });

  it('overrides cannot suppress WFC9xx findings', () => {
    const configText = yaml`
      overrides:
        - rule: WFC104
          target: ${WF}/a.yml#inputs.typo
          reason: accepted until the migration
        - rule: override-unused
          file: ${CONFIG}
          reason: we do not want to hear about stale overrides
    `;
    const r = run(configText);
    expect(byCode(r, 'WFC902').map((f) => f.loc.line)).toEqual([2, 5]);
    expect(r.summary.suppressed).toBe(0);
  });

  it('rejects overrides for unknown rules', () => {
    try {
      run(override('    rule: WFC999\n    file: x\n'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues).toHaveLength(1);
      expect((err as ConfigError).issues[0]).toMatch(/^overrides\.0\.rule: unknown rule/);
    }
  });

  it('includes suppressed findings in a schema-valid JSON report', () => {
    const r = run(override(`    rule: WFC104\n    file: ${WF}/a.yml\n    expires: 2026-06-10\n`));
    const json = JSON.parse(JSON.stringify(toJsonReport(r)));
    expect(reportSchema.safeParse(json).success).toBe(true);
    expect(json.summary.suppressed).toBe(2);
    expect(
      json.suppressed.map((f: { symbol: string; override: { index: number } }) => [
        f.symbol,
        f.override.index,
      ]),
    ).toEqual([
      [`${WF}/a.yml#inputs.dead`, 0],
      [`${WF}/a.yml#inputs.legacy`, 0],
    ]);
    expect(json.findings.map((f: { code: string }) => f.code).sort()).toEqual(['WFC104', 'WFC903']);
  });
});

describe('override schema', () => {
  const issues = (o: Record<string, unknown>) => {
    try {
      parseConfig({ overrides: [o] });
    } catch (err) {
      return (err as ConfigError).issues;
    }
    return [];
  };
  const ok = { rule: 'WFC104', target: 'x', reason: 'a good long reason' };

  it('accepts a complete override', () => {
    expect(issues({ ...ok, file: 'y', expires: '2026-01-31', owner: '@me' })).toEqual([]);
  });

  it('requires a reason of at least 10 characters', () => {
    expect(issues({ ...ok, reason: 'because' })[0]).toMatch(/^overrides\.0\.reason: /);
    expect(issues({ rule: 'WFC104', target: 'x' })[0]).toMatch(/^overrides\.0\.reason: /);
  });

  it('requires target or file', () => {
    expect(issues({ rule: 'WFC104', reason: 'a good long reason' })).toEqual([
      'overrides.0: set `target` or `file` so the override cannot silence a rule everywhere (use `rules:` for that)',
    ]);
  });

  it.each(['2026-1-31', '31/01/2026', '2026-02-30', 'tomorrow'])('rejects expires: %s', (expires) => {
    expect(issues({ ...ok, expires })[0]).toMatch(/^overrides\.0\.expires: /);
  });

  it('rejects unknown keys and a YAML date that is not a string', () => {
    expect(issues({ ...ok, until: '2026-01-01' })[0]).toMatch(/^overrides\.0: /);
    expect(() =>
      parseConfigText(
        `overrides:\n  - rule: WFC104\n    target: x\n    reason: a good long reason\n    expires: 2026-01-31\n`,
      ),
    ).not.toThrow();
  });

  it('records each override location', () => {
    const { overrideLocs } = parseConfigText(
      'rules: {}\noverrides:\n  - rule: WFC104\n    target: x\n    reason: a good long reason\n  - { rule: WFC104, file: y, reason: another long reason }\n',
      'cfg.yml',
    );
    expect(overrideLocs.map((l) => [l.file, l.line, l.column])).toEqual([
      ['cfg.yml', 3, 5],
      ['cfg.yml', 6, 5],
    ]);
  });
});

describe('scope and inactive rules', () => {
  const scoped = (configText: string, extra: { paths?: string[]; only?: string[] }) => {
    const { config, overrideLocs } = parseConfigText(configText, CONFIG);
    return analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem(files),
      config,
      overrideLocs,
      configFile: CONFIG,
      configText,
      now: new Date('2026-06-01T00:00:00Z'),
      validateSchema: false,
      repository: 'acme/repo',
      ...extra,
    });
  };
  const cfg = override(`    rule: WFC104\n    target: ${WF}/a.yml#inputs.dead\n`);

  it('does not call an override unused when linting other files', () => {
    const r = scoped(cfg, { paths: [`${WF}/b.yml`] });
    expect(codes(r)).not.toContain('WFC902');
    expect(r.suppressed).toEqual([]); // the suppressed finding is outside the reported scope
  });

  it('does not call an override unused when its rule did not run', () => {
    expect(codes(scoped(cfg, { only: ['WFC108'] }))).not.toContain('WFC902');
    const off = scoped(`rules:\n  WFC104: off\n${cfg}`, {});
    expect(codes(off)).not.toContain('WFC902');
  });

  it('judges an expired override only where its rule runs (no WFC901 when the rule did not run)', () => {
    const expired = override(
      `    rule: WFC104\n    target: ${WF}/a.yml#inputs.dead\n    expires: 2026-01-01\n`,
    );
    expect(codes(scoped(expired, { only: ['WFC108', 'WFC901'] }))).not.toContain('WFC901');
    expect(codes(scoped(expired, {}))).toContain('WFC901');
  });

  it('underlines the whole first line of the override entry', () => {
    const { overrideLocs } = parseConfigText(cfg, CONFIG);
    expect(overrideLocs[0]).toMatchObject({ line: 2, column: 5, endLine: 2, endColumn: 50 });
  });
});
