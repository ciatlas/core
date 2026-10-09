/** Regression tests for the gaps found when re-verifying the round 2 fixes of the adversarial review. */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyze,
  ConfigError,
  loadConfig,
  memoryFileSystem,
  neutralizeWorkflowCommands,
  nodeFileSystem,
  parseConfig,
  parseConfigText,
  planContracts,
  UnsafePathError,
  writeContracts,
} from '@flowpact/core';
import { buildCallGraph, renderMarkdown } from '@flowpact/reporters';
import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF, yaml } from './helpers';

/** r1 → … → r8 → <a> → b_y → z1 → z2 → z3, with a back edge b_y → <a>. */
function chainWithCycle(a: string): Record<string, string> {
  const call = (to: string) => `  c-${to}:\n    uses: ./.github/workflows/${to}.yml\n`;
  const order = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', a, 'b_y', 'z1', 'z2', 'z3'];
  const files: Record<string, string> = {};
  order.forEach((name, i) => {
    const next = order[i + 1];
    const calls = [next ? call(next) : '  leaf:\n    runs-on: x\n    steps:\n      - run: echo\n'];
    if (name === 'b_y') calls.push(call(a));
    files[`${WF}/${name}.yml`] =
      `on: ${i === 0 ? 'workflow_dispatch' : 'workflow_call'}\njobs:\n${calls.join('')}`;
  });
  return files;
}

describe('FP602 with call cycles (#21)', () => {
  it.each(['a_x', 's_x'])('finds the over-limit chain whatever the cycle entry is called (%s)', (a) => {
    const r = lint(chainWithCycle(a));
    expect(byCode(r, 'FP601')).toHaveLength(1);
    const deep = byCode(r, 'FP602');
    expect(deep.length).toBeGreaterThan(0);
    expect(deep[0]!.message).toContain('Call chain is 11 workflows deep (limit 10)');
    expect(deep[0]!.message).toContain(`r1.yml → `);
  });

  it('gives the same findings for both names', () => {
    const shape = (a: string) =>
      byCode(lint(chainWithCycle(a)), 'FP602').map((f) => f.message.replaceAll(a, 'A'));
    expect(shape('a_x')).toEqual(shape('s_x'));
  });
});

describe('untrusted names in output (#9)', () => {
  const inheritCall = (name: string) => ({
    [`${WF}/c.yml`]: 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/r.yml\n    secrets: inherit\n',
    [`${WF}/r.yml`]: `on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: |\n          echo "\${{ secrets['${name.replaceAll('\n', '\n          ')}'] }}"\n`,
  });

  it('escapes secret names inside the FP204 snippet', () => {
    const r = lint(
      inheritCall('A\n```\n</details><img src=https://e.vil/p.png> @octocat\n::error title=x::pwned\n'),
    );
    const fix = byCode(r, 'FP204')[0]!.fix;
    expect(fix.split('\n')).toHaveLength(3);
    expect(fix).toContain('\\n```\\n');
    const md = renderMarkdown(r);
    expect(md).not.toMatch(/^<\/details><img/m);
    expect(md).not.toMatch(/^\s*::error/m);
  });

  it('fences a snippet with a longer fence than any backtick run in it', () => {
    const r = lint(inheritCall('A````B'));
    const md = renderMarkdown(r);
    expect(md).toContain('`````yaml');
  });

  it('neutralizes lines that GitHub would run as workflow commands', () => {
    expect(neutralizeWorkflowCommands('ok\n  ::error title=x::pwned\n::warning::y')).toBe(
      'ok\n  :\u200b:error title=x::pwned\n:\u200b:warning::y',
    );
    expect(neutralizeWorkflowCommands('\u001b[2m::set-output name=a::b')).toBe(
      '\u001b[2m:\u200b:set-output name=a::b',
    );
    expect(neutralizeWorkflowCommands('a :: b')).toBe('a :: b');
  });
});

describe('symlinks and .git (#10)', () => {
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'flowpact-r3-'));
    const outside = mkdtempSync(join(tmpdir(), 'flowpact-r3-out-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, '.github/flowpact/contracts/workflows'), { recursive: true });
    return { root, outside };
  };

  it('does not read a config that links outside the repository', () => {
    const { root, outside } = repo();
    writeFileSync(join(outside, 'r.yml'), 'rules: {gho_SECRETVALUE: error}\n');
    symlinkSync(join(outside, 'r.yml'), join(root, '.github/flowpact/flowpact.config.yml'));
    expect(() => loadConfig(root)).toThrow(/links outside the repository/);
    try {
      loadConfig(root);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String((err as Error).message)).not.toContain('gho_');
    }
  });

  it('does not write contracts through a symlink', () => {
    const { root, outside } = repo();
    writeFileSync(join(outside, 'victim.txt'), 'keep me\n');
    writeFileSync(
      join(root, '.github/workflows/ci.yml'),
      'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    );
    symlinkSync(
      join(outside, 'victim.txt'),
      join(root, '.github/flowpact/contracts/workflows/ci.contract.yml'),
    );
    const r = analyze({ root, validateSchema: false, only: [], repository: 'a/b' });
    const plan = planContracts(r.index, nodeFileSystem(root));
    expect(() => writeContracts(root, plan)).toThrow(UnsafePathError);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('keep me\n');
    // Nothing else was written either.
    expect(planContracts(r.index, nodeFileSystem(root)).entries.every((e) => e.status !== 'unchanged')).toBe(
      true,
    );
  });

  it('never reads files inside .git through a symlink', () => {
    const { root } = repo();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git/config'), '[http]\n  extraheader = AUTHORIZATION: basic c2VjcmV0\n');
    symlinkSync('../../.git/config', join(root, '.github/workflows/leak.yml'));
    const r = analyze({ root, repository: 'a/b' });
    expect(JSON.stringify(r.findings)).not.toContain('c2VjcmV0');
    expect(nodeFileSystem(root).read('.github/workflows/leak.yml')).toBeUndefined();
  });

  it('reads paths only in their exact case', () => {
    const { root } = repo();
    writeFileSync(join(root, '.github/workflows/r.yml'), 'on: push\n');
    const fs = nodeFileSystem(root);
    expect(fs.read('.github/workflows/r.yml')).toBe('on: push\n');
    expect(fs.read('.github/workflows/R.yml')).toBeUndefined();
    expect(fs.read('.GitHub/workflows/r.yml')).toBeUndefined();
  });
});

describe('config edge cases (#3, #11, #14)', () => {
  const files = {
    [`${WF}/ci.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
  };
  const run = (config: Record<string, unknown>, pluginsSkipped = false) =>
    analyze({
      root: '/v',
      fs: memoryFileSystem(files),
      validateSchema: false,
      config: parseConfig(config),
      pluginsSkipped,
      now: new Date('2026-10-08T12:00:00Z'),
      repository: 'a/b',
    });

  it('reports an alias bomb in the config as a config error', () => {
    const lines = ['a0: &a0 [x, x]'];
    for (let i = 1; i <= 30; i++) lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
    expect(() => parseConfigText(`${lines.join('\n')}\n`)).toThrow(ConfigError);
  });

  it('keeps typos of built-in rules fatal when plugins are skipped', () => {
    const base = { plugins: ['./p.mjs'] };
    const issues = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as ConfigError).issues;
      }
      return [];
    };
    expect(issues(() => run({ ...base, rules: { 'unused-inptu': 'off' } }, true))).toEqual([
      'rules.unused-inptu: unknown rule (did you mean unused-input?)',
    ]);
    expect(() =>
      run({ ...base, overrides: [{ rule: 'FP10l', file: WF, reason: 'typo of a built-in rule' }] }, true),
    ).toThrow(ConfigError);
    const r = run(
      {
        ...base,
        rules: { 'acme-no-echo': 'error' },
        overrides: [{ rule: 'ACME601', file: WF, reason: 'accepted for the migration' }],
      },
      true,
    );
    expect(r.unloadedRules).toEqual([
      'rules.acme-no-echo: unknown rule "acme-no-echo"',
      'overrides.0.rule: unknown rule "ACME601"',
    ]);
  });

  it('says when an expired override matches nothing', () => {
    const r = run({
      overrides: [
        {
          rule: 'missing-required-input',
          file: `${WF}/ci.yml`,
          reason: 'active rule, matches nothing',
          expires: '2026-09-30',
        },
      ],
    });
    const f = byCode(r, 'FP901')[0]!;
    expect(f.message).toContain('it matches no finding now');
    expect(f.message).not.toContain('reported again');
    expect(f.fix).toBe('Delete the override.');
  });
});

describe('contract drift caused by a caller (#15)', () => {
  it('reports the callee contract when only the caller is in paths', () => {
    const deploy =
      'on:\n  workflow_call:\n    outputs:\n      url:\n        value: ${{ jobs.d.outputs.url }}\njobs:\n  d:\n    runs-on: x\n    outputs:\n      url: ${{ steps.s.outputs.url }}\n    steps:\n      - id: s\n        run: echo "url=x" >> "$GITHUB_OUTPUT"\n';
    const ci = (read: string) =>
      `on: push\njobs:\n  call:\n    uses: ./.github/workflows/deploy.yml\n  use:\n    needs: call\n    runs-on: x\n    steps:\n      - run: echo ${read}\n`;
    const before = { [`${WF}/deploy.yml`]: deploy, [`${WF}/ci.yml`]: ci('${{ needs.call.outputs.url }}') };
    const idx = analyze({
      root: '/v',
      fs: memoryFileSystem(before),
      validateSchema: false,
      only: [],
      repository: 'a/b',
    }).index;
    const locked = Object.fromEntries(
      planContracts(idx, memoryFileSystem(before)).entries.map((e) => [e.file, e.after ?? '']),
    );
    const after = { ...locked, [`${WF}/deploy.yml`]: deploy, [`${WF}/ci.yml`]: ci('nothing') };
    const r = analyze({
      root: '/v',
      fs: memoryFileSystem(after),
      validateSchema: false,
      checkContracts: true,
      paths: [`${WF}/ci.yml`],
      repository: 'a/b',
    });
    expect(r.contracts?.drift).toBe(true);
    expect(r.contracts?.entries.map((e) => e.unit)).toContain(`${WF}/deploy.yml`);
    expect(codes(r)).toContain('FP802');
  });
});

describe('FP505 in bare conditions of jobs and actions (#17)', () => {
  it('checks functions in job conditions', () => {
    const r = lint({
      [`${WF}/v.yml`]: yaml`
        on: push
        jobs:
          d:
            if: hashFiles('x') != ''
            runs-on: x
            steps: [{ run: x }]
          ok:
            if: always() && contains(github.ref, 'hashFiles(') && success()
            runs-on: x
            steps:
              - if: hashFiles('x') != ''
                run: x
      `,
    });
    const found = byCode(r, 'FP505');
    expect(found.map((f) => [f.loc.line, f.loc.column])).toEqual([[4, 9]]);
    expect(found[0]!.message).toContain('`hashFiles()` is not available in a job');
  });

  it('uses the action tables for composite steps and pre-if/post-if', () => {
    const r = lint({
      '.github/actions/c/action.yml': yaml`
        name: c
        description: d
        runs:
          using: composite
          steps:
            - if: vars.X != ''
              run: x
              shell: bash
            - if: needs.a.result == 'success'
              run: x
              shell: bash
            - if: env.A == 'x' && inputs.b && hashFiles('x') != ''
              run: x
              shell: bash
      `,
      '.github/actions/n/action.yml': yaml`
        name: n
        description: d
        runs:
          using: node24
          main: index.js
          post: post.js
          post-if: secrets.X != ''
      `,
    });
    const found = byCode(r, 'FP505').map((f) => `${f.loc.file}:${f.loc.line} ${f.message.split(' — ')[0]}`);
    expect(found).toEqual([
      ".github/actions/c/action.yml:6 `vars` is not available in a composite action step's `if:`",
      ".github/actions/c/action.yml:9 `needs` is not available in a composite action step's `if:`",
      ".github/actions/n/action.yml:7 `secrets` is not available in an action's `pre-if:`/`post-if:`",
    ]);
    expect(byCode(r, 'FP505')[0]!.message).toContain('GitHub fails the step using the action');
  });

  it('words parser findings in actions for actions', () => {
    const r = lint(
      {
        '.github/actions/c/action.yml':
          "name: c\ndescription: d\nruns:\n  using: composite\n  steps:\n    - if: ${{ secrets.T != '' }}\n      shell: bash\n      run: echo\n",
      },
      { schema: true },
    );
    const found = byCode(r, 'FP505');
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f.message).toContain('GitHub fails the step using the action');
  });
});

describe('calls by path (#18, #23)', () => {
  it('treats the workflows directory as case-sensitive', () => {
    const r = lint({
      [`${WF}/c.yml`]: 'on: push\njobs:\n  x:\n    uses: ./.GitHub/workflows/r.yml\n',
      '.GitHub/workflows/r.yml': 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    });
    expect(codes(r)).toContain('FP606');
  });

  it('draws calls to files outside .github/workflows in the graph', () => {
    const r = lint({
      [`${WF}/c.yml`]: 'on: push\njobs:\n  x:\n    uses: ./ci/r.yml\n',
      'ci/r.yml': 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    });
    expect(codes(r)).toContain('FP606');
    const g = buildCallGraph(r.index);
    expect(g.nodes.find((n) => n.id === 'ci/r.yml')?.kind).toBe('invalid');
    expect(g.edges).toContainEqual(
      expect.objectContaining({ from: `${WF}/c.yml`, to: 'ci/r.yml', via: 'jobs.x' }),
    );
  });
});

describe('large matrices (#4, #8)', () => {
  const values = (p: string, n: number) => `[${Array.from({ length: n }, (_, i) => `${p}${i}`).join(', ')}]`;

  it('skips per-combination checks on matrices GitHub rejects', () => {
    const r = lint({
      [`${WF}/m.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n        a: ${values('a', 17)}\n        b: ${values('b', 17)}\n        include:\n          - a: a0\n            extra: x\n    steps:\n      - run: echo \${{ matrix.extra }}\n`,
    });
    expect(codes(r)).toEqual(['FP406']);
  });

  it('counts exclude when the product is too large to list', () => {
    const dims = ['a', 'b', 'c', 'd', 'e'].map((k) => `        ${k}: ${values('', 10)}`).join('\n');
    const excludes = ['a', 'b', 'c']
      .flatMap((k) => Array.from({ length: 9 }, (_, i) => `          - ${k}: ${i + 1}`))
      .join('\n');
    const m = (exclude: string) =>
      `on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n${dims}\n${exclude}    steps: [{ run: x }]\n`;
    expect(codes(lint({ [`${WF}/m.yml`]: m(`        exclude:\n${excludes}\n`) }))).not.toContain('FP406');
    expect(byCode(lint({ [`${WF}/m.yml`]: m('') }), 'FP406')[0]!.message).toContain(
      'expands to at least 100000 matrix jobs',
    );
  });

  it('lists a large product when exclude brings it down', () => {
    const dims = ['a', 'b', 'c', 'd', 'e'].map((k) => `        ${k}: ${values('', 10)}`).join('\n');
    const excludes = [
      ...['a', 'b', 'c'].flatMap((k) => Array.from({ length: 9 }, (_, i) => `${k}: ${i + 1}`)),
      ...Array.from({ length: 7 }, (_, i) => `d: ${i + 2}`),
    ]
      .map((e) => `          - ${e}`)
      .join('\n');
    const r = lint({
      [`${WF}/m.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n${dims}\n        exclude:\n${excludes}\n        include:\n          - d: 1\n            extra: x\n    steps:\n      - run: echo \${{ matrix.extra }}\n`,
    });
    expect(r.summary.matrixCombinations).toBe(30);
    expect(byCode(r, 'FP402')[0]?.message).toContain('matrix.extra is undefined in 20 of 30 combinations');
  });

  it('gives true per-key counts for FP401 and FP402', () => {
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
                  - a: a1
                    extra: x
                  - a: a2
                    other: y
            steps:
              - uses: ./.github/actions/act
                with:
                  flag: \${{ matrix.extra }}\${{ matrix.other }}
      `,
      '.github/actions/act/action.yml':
        'name: a\ndescription: b\ninputs:\n  flag: { required: true }\nruns:\n  using: composite\n  steps: []\n',
    });
    expect(byCode(r, 'FP401')[0]!.message).toContain(
      'empty in 2 of 4 matrix combinations — not defined there: matrix.extra (2), matrix.other (2)',
    );
    expect(byCode(r, 'FP402').map((f) => f.message)).toEqual([
      'matrix.extra is undefined in 3 of 4 combinations of jobs.small; in 2 of them the whole input is empty (FP401)',
      'matrix.other is undefined in 3 of 4 combinations of jobs.small; in 2 of them the whole input is empty (FP401)',
    ]);
  });
});
