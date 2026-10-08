/** Regression tests for round 2 of the adversarial review (scale, feature interactions, real-world workflows). */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyze,
  buildContract,
  memoryFileSystem,
  nodeFileSystem,
  parseConfig,
  planContracts,
  serializeContract,
  sym,
  trace,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF, yaml } from './helpers';

const job = (body: string) => yaml`
  on: push
  jobs:
    t:
      runs-on: \${{ matrix.os }}
      strategy:
        matrix:
          os: [ubuntu, windows]
          include:
            - os: ubuntu
              flavor: slim
      steps:
${body}
`;

/** Layered DAG: `width` workflows per level, each calling every workflow of the next level. */
function dag(levels: number, width: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let l = 0; l < levels; l++) {
    for (let w = 0; w < width; w++) {
      const calls =
        l === levels - 1
          ? '  leaf:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n'
          : Array.from(
              { length: width },
              (_, n) => `  c${n}:\n    uses: ./.github/workflows/l${l + 1}w${n}.yml\n    secrets: inherit\n`,
            ).join('');
      const on =
        l === 0 ? 'on:\n  push:\n  workflow_call:\n    secrets:\n      TOKEN: {}\n' : 'on: workflow_call\n';
      files[`${WF}/l${l}w${w}.yml`] = `${on}jobs:\n${calls}`;
    }
  }
  return files;
}

describe('matrix guards with runtime-only parts (#1)', () => {
  it.each([
    'always() && matrix.flavor',
    "success() && matrix.flavor == 'slim'",
    "github.event_name == 'push' && matrix.flavor",
    '!cancelled() && matrix.flavor',
    "github.ref == 'refs/heads/main' && matrix.flavor != ''",
  ])('%s skips the combination without the key', (guard) => {
    const r = lint({
      [`${WF}/m.yml`]: job(`        - if: ${guard}
          uses: ./.github/actions/act
          with:
            flag: \${{ matrix.flavor }}
        - if: ${guard}
          run: echo "\${{ matrix.flavor }}"`),
      '.github/actions/act/action.yml':
        'inputs:\n  flag: {}\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.flag }}\n      shell: bash\n',
    });
    expect(codes(r).filter((c) => c.startsWith('FP40'))).toEqual([]);
  });

  it('still reports when the guard does not decide (always() || matrix.flavor)', () => {
    const r = lint({
      [`${WF}/m.yml`]: job(
        '        - if: always() || matrix.flavor\n          run: echo "${{ matrix.flavor }}"',
      ),
    });
    expect(codes(r)).toContain('FP402');
  });
});

describe('scale (#2, #5, #21)', () => {
  it('FP601/FP602 stay fast on deep diamond-shaped call graphs', () => {
    const started = performance.now();
    const r = lint(dag(26, 2), { only: ['FP601', 'FP602'] });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(byCode(r, 'FP602').length).toBeGreaterThan(0);
  });

  it('reports each call cycle once, wherever it is entered', () => {
    const r = lint({
      [`${WF}/a.yml`]:
        'on: push\njobs:\n  x:\n    uses: ./.github/workflows/b.yml\n  y:\n    uses: ./.github/workflows/c.yml\n',
      [`${WF}/b.yml`]: 'on: workflow_call\njobs:\n  x:\n    uses: ./.github/workflows/c.yml\n',
      [`${WF}/c.yml`]: 'on: workflow_call\njobs:\n  x:\n    uses: ./.github/workflows/b.yml\n',
    });
    expect(byCode(r, 'FP601')).toHaveLength(1);
  });

  it('trace shows shared subtrees once', () => {
    const r = lint(dag(14, 2), { only: [] });
    const started = performance.now();
    const t = trace(r.index, sym.secret(`${WF}/l0w0.yml`, 'TOKEN'), { maxDepth: 40 });
    const json = JSON.stringify(t);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(json.length).toBeLessThan(200_000);
    expect(json).toContain('"stop":"seen"');
  });
});

describe('YAML alias bombs (#3)', () => {
  it('stops with FP504 instead of expanding', () => {
    const lines = ['on: push', 'env:', '  L0: &l0 ["${{ github.sha }}", "x"]'];
    for (let i = 1; i <= 24; i++) lines.push(`  L${i}: &l${i} [*l${i - 1}, *l${i - 1}]`);
    lines.push('jobs:', '  j:', '    runs-on: x', '    steps: [{ run: x }]');
    const started = performance.now();
    const r = lint({ [`${WF}/a.yml`]: `${lines.join('\n')}\n` });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(byCode(r, 'FP504')[0]?.message).toContain('possible alias bomb');
  });
});

describe('large matrices (#4)', () => {
  const values = (p: string, n: number) => `[${Array.from({ length: n }, (_, i) => `${p}${i}`).join(', ')}]`;
  it('applies exclude/include to the full product', () => {
    const r = lint({
      [`${WF}/m.yml`]: yaml`
        on: push
        jobs:
          big:
            runs-on: x
            strategy:
              matrix:
                a: ${values('a', 5)}
                b: ${values('b', 5)}
                c: ${values('c', 5)}
                d: ${values('d', 5)}
                e: ${values('e', 5)}
                exclude: [{ a: a0 }, { a: a1 }, { a: a2 }, { b: b0 }, { b: b1 }, { b: b2 }]
                include: [{ a: a4, extra: x }]
            steps:
              - run: echo \${{ matrix.e }}
      `,
    });
    expect(codes(r).filter((c) => c.startsWith('FP40'))).toEqual(['FP406']);
    expect(byCode(r, 'FP406')[0]!.message).toContain('expands to 500 matrix jobs');
  });

  it('accepts matrices up to 256 jobs and flags larger ones', () => {
    const m = (n: number) =>
      `on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n        a: ${values('a', n)}\n        b: ${values('b', n)}\n    steps: [{ run: x }]\n`;
    expect(codes(lint({ [`${WF}/m.yml`]: m(16) }))).not.toContain('FP406');
    expect(codes(lint({ [`${WF}/m.yml`]: m(17) }))).toContain('FP406');
    expect(byCode(lint({ [`${WF}/m.yml`]: m(150) }), 'FP406')[0]!.message).toContain(
      'expands to at least 22500 matrix jobs',
    );
  });
});

describe('FP505 in bare if: conditions (#6, #17, #22)', () => {
  it('checks contexts that GitHub does not allow in job and step conditions', () => {
    const r = lint({
      [`${WF}/c.yml`]: yaml`
        on: push
        env:
          FOO: x
        jobs:
          a:
            if: env.FOO == 'x'
            runs-on: x
            steps:
              - if: secrets.X != ''
                run: echo
              - if: env.FOO == 'x' && steps.s.outcome == 'success'
                run: echo
          b:
            if: github.event_name == 'push' && needs.a.result == 'success'
            needs: a
            runs-on: x
            steps: [{ run: x }]
      `,
    });
    expect(byCode(r, 'FP505').map((f) => `${f.loc.line}:${f.loc.column}`)).toEqual(['6:9', '9:13']);
  });

  it('points at the reference inside a multi-line quoted scalar', () => {
    const text =
      'on: push\nenv:\n  T: x\njobs:\n  k:\n    uses: ./.github/workflows/r.yml\n    with:\n      t: "prefix\n        ${{ env.T }}"\n';
    const r = lint(
      {
        [`${WF}/c.yml`]: text,
        [`${WF}/r.yml`]:
          'on:\n  workflow_call:\n    inputs:\n      t: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ inputs.t }}\n',
      },
      { schema: true },
    );
    const [f] = byCode(r, 'FP505');
    expect(f?.loc).toMatchObject({ line: 9, column: 13 });
  });
});

describe('FP402 per key (#8)', () => {
  it('reports each missing key with its own count', () => {
    const r = lint({
      [`${WF}/m.yml`]: yaml`
        on: push
        jobs:
          small:
            runs-on: x
            strategy:
              matrix:
                a: [a0, a1, a2, a3]
                include:
                  - { a: a1, extra: x }
                  - { a: a2, other: y }
            steps:
              - run: echo "\${{ matrix.extra }} \${{ matrix.other }}"
      `,
    });
    expect(byCode(r, 'FP402').map((f) => f.message)).toEqual([
      'matrix.extra is undefined in 3 of 4 combinations of jobs.small',
      'matrix.other is undefined in 3 of 4 combinations of jobs.small',
    ]);
  });
});

describe('untrusted text and files (#9, #10)', () => {
  it('escapes newlines in per-finding fix texts', () => {
    const r = lint({
      [`${WF}/c.yml`]: 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/r.yml\n',
      [`${WF}/r.yml`]:
        'on:\n  workflow_call:\n    inputs:\n      "x\\n```\\n<b>hi</b>": { required: true }\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    });
    const fix = byCode(r, 'FP101')[0]!.fix;
    expect(fix).not.toContain('\n');
    expect(fix).toContain('\\n```');
  });

  it('keeps the multi-line YAML snippet of FP204', () => {
    const r = lint({
      [`${WF}/c.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/r.yml\n    secrets: inherit\n',
      [`${WF}/r.yml`]:
        'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n',
    });
    expect(byCode(r, 'FP204')[0]!.fix).toContain('\nsecrets:\n  TOKEN:');
  });

  it('never reads files that symlink out of the repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-sym-'));
    const outside = mkdtempSync(join(tmpdir(), 'flowpact-outside-'));
    writeFileSync(join(outside, 'secret.yml'), 'TOP SECRET: [\n');
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/actions/x'), { recursive: true });
    symlinkSync(join(outside, 'secret.yml'), join(root, '.github/workflows/leak.yml'));
    symlinkSync(join(outside, 'secret.yml'), join(root, '.github/actions/x/action.yml'));
    writeFileSync(
      join(root, '.github/workflows/ok.yml'),
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n',
    );
    const fs = nodeFileSystem(root);
    expect(fs.read('.github/workflows/leak.yml')).toBeUndefined();
    const r = analyze({ root, validateSchema: false, repository: 'a/b' });
    expect(JSON.stringify(r.findings)).not.toContain('TOP SECRET');
    expect([...r.project.workflows.keys()]).toEqual([`${WF}/ok.yml`]);
  });
});

describe('paths, plugins and contracts (#11, #12, #13, #15, #18)', () => {
  const files = {
    [`${WF}/a.yml`]:
      'on:\n  workflow_dispatch:\n    inputs:\n      dead: {}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
  };

  it('`.` means the whole repository', () => {
    const r = analyze({
      root: '/v',
      fs: memoryFileSystem(files),
      validateSchema: false,
      paths: ['.'],
      repository: 'a/b',
    });
    expect(r.project.wholeRepository).toBe(true);
    expect(codes(r)).toEqual(['FP104']);
  });

  it('tolerates config entries for rules of skipped plugins', () => {
    const config = parseConfig({
      plugins: ['./x.mjs'],
      rules: { 'acme-rule': 'warning' },
      overrides: [{ rule: 'ACME101', file: '.github', reason: 'accepted for the migration (JIRA-1)' }],
    });
    const run = (pluginsSkipped: boolean) =>
      analyze({
        root: '/v',
        fs: memoryFileSystem(files),
        validateSchema: false,
        config,
        pluginsSkipped,
        repository: 'a/b',
      });
    expect(() => run(false)).toThrow(/unknown rules/);
    expect(codes(run(true))).toEqual(['FP104']);
  });

  it('keeps consumer entries of a caller that does not parse', () => {
    const repo = {
      [`${WF}/ci.yml`]:
        'on: push\njobs:\n  d:\n    uses: ./.github/workflows/deploy.yml\n    with:\n      env: prod\n',
      [`${WF}/deploy.yml`]:
        'on:\n  workflow_call:\n    inputs:\n      env: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ inputs.env }}\n',
    };
    const idx = analyze({
      root: '/v',
      fs: memoryFileSystem(repo),
      validateSchema: false,
      only: [],
      repository: 'a/b',
    }).index;
    const locked = serializeContract(buildContract(idx, idx.unit(`${WF}/deploy.yml`)!));
    const broken = {
      ...repo,
      [`${WF}/ci.yml`]: '- [',
      '.github/flowpact/contracts/workflows/deploy.contract.yml': locked,
    };
    const idx2 = analyze({
      root: '/v',
      fs: memoryFileSystem(broken),
      validateSchema: false,
      only: [],
      repository: 'a/b',
    }).index;
    const plan = planContracts(idx2, memoryFileSystem(broken));
    expect(plan.entries.find((e) => e.unit === `${WF}/deploy.yml`)?.status).toBe('unchanged');
  });

  it('scopes contract drift to the requested paths', () => {
    const repo = {
      ...files,
      [`${WF}/b.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    };
    const r = analyze({
      root: '/v',
      fs: memoryFileSystem(repo),
      validateSchema: false,
      checkContracts: true,
      paths: [`${WF}/b.yml`],
      repository: 'a/b',
    });
    expect(r.contracts?.entries.map((e) => e.unit)).toEqual([`${WF}/b.yml`]);
  });

  it('reports job-level uses: outside .github/workflows at the caller and does not parse the target', () => {
    const r = lint(
      {
        [`${WF}/c.yml`]: 'on: push\njobs:\n  x:\n    uses: ./.github/actions/act/action.yml\n',
        '.github/actions/act/action.yml': 'name: a\ndescription: b\nruns:\n  using: composite\n  steps: []\n',
      },
      { schema: true },
    );
    expect(codes(r)).toEqual(['FP606']);
    expect(byCode(r, 'FP606')[0]!.message).toContain('is not a reusable workflow');
  });
});

describe('trace upstream (#19, #20)', () => {
  it('follows secrets: inherit and lists each source once', () => {
    const r = lint({
      [`${WF}/top.yml`]:
        'on:\n  workflow_call:\n    secrets:\n      TOKEN: {}\njobs:\n  m:\n    uses: ./.github/workflows/mid.yml\n    secrets: inherit\n',
      [`${WF}/mid.yml`]:
        'on: workflow_call\njobs:\n  l:\n    uses: ./.github/workflows/leaf.yml\n    secrets: inherit\n',
      [`${WF}/leaf.yml`]:
        'on:\n  workflow_call:\n    inputs:\n      a: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.TOKEN }}\n',
      [`${WF}/c.yml`]:
        "on: push\njobs:\n  x:\n    uses: ./.github/workflows/leaf.yml\n    with:\n      a: ${{ github.sha }}-${{ github.sha == 'x' && 'p' || 'q' }}\n",
    });
    const t = trace(r.index, sym.secret(`${WF}/leaf.yml`, 'TOKEN'), { direction: 'up' });
    expect(t.children[0]?.symbol).toBe(sym.secret(`${WF}/mid.yml`, 'TOKEN'));
    expect(t.children[0]?.children[0]?.symbol).toBe(sym.secret(`${WF}/top.yml`, 'TOKEN'));
  });
});
