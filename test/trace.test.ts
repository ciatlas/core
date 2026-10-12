import { resolveSymbols, sym, trace } from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { load, WF, yaml } from './helpers';

const files = {
  [`${WF}/root.yml`]: yaml`
    on:
      workflow_dispatch:
        inputs:
          config: { type: string, required: true }
    jobs:
      mid:
        uses: ./.github/workflows/mid.yml
        with:
          cfg: \${{ inputs.config }}
        secrets: inherit
      after:
        needs: mid
        runs-on: x
        steps:
          - run: echo \${{ needs.mid.outputs.result }}
  `,
  [`${WF}/mid.yml`]: yaml`
    on:
      workflow_call:
        inputs:
          cfg: { type: string, required: true }
        outputs:
          result:
            value: \${{ jobs.leaf.outputs.r }}
    jobs:
      leaf:
        uses: ./.github/workflows/leaf.yml
        with:
          path: config/\${{ inputs.cfg }}
        secrets: inherit
  `,
  [`${WF}/leaf.yml`]: yaml`
    on:
      workflow_call:
        inputs:
          path: { type: string, required: true }
        outputs:
          r:
            value: \${{ jobs.j.outputs.r }}
    jobs:
      j:
        runs-on: x
        outputs:
          r: \${{ steps.s.outputs.r }}
        steps:
          - id: s
            if: inputs.path != ''
            run: echo "r=\${{ inputs.path }}" >> $GITHUB_OUTPUT && echo \${{ secrets.TOKEN }}
  `,
};

describe('trace', () => {
  const { index } = load(files);

  it('follows a value down through every level', () => {
    const t = trace(index, sym.input(`${WF}/root.yml`, 'config'));
    const mid = t.children[0]!;
    expect(mid.symbol).toBe(sym.input(`${WF}/mid.yml`, 'cfg'));
    const leaf = mid.children[0]!;
    expect(leaf.symbol).toBe(sym.input(`${WF}/leaf.yml`, 'path'));
    expect(leaf.via?.text).toBe('config/${{ inputs.cfg }}');
    expect(leaf.leaves.map((l) => l.role).sort()).toEqual(['condition', 'run script']);
  });

  it('follows outputs back up to the consuming job', () => {
    const t = trace(index, sym.jobOutput(`${WF}/leaf.yml`, 'j', 'r'));
    const flat = JSON.stringify(t);
    expect(flat).toContain(sym.output(`${WF}/mid.yml`, 'result'));
    expect(flat).toContain(sym.jobOutput(`${WF}/root.yml`, 'mid', 'result'));
  });

  it('follows secrets through inherit', () => {
    const { index: i2 } = load({
      ...files,
      [`${WF}/root.yml`]: files[`${WF}/root.yml`]!.replace(
        'workflow_dispatch:',
        'workflow_call:\n    secrets:\n      TOKEN: {}\n  workflow_dispatch:',
      ),
    });
    const t = trace(i2, sym.secret(`${WF}/root.yml`, 'TOKEN'));
    const mid = t.children[0]!;
    expect(mid.via?.text).toBe('secrets: inherit');
    expect(mid.children[0]?.symbol).toBe(sym.secret(`${WF}/leaf.yml`, 'TOKEN'));
    expect(mid.children[0]?.leaves[0]?.role).toBe('run script');
  });

  it('traces upstream with literal values and omissions', () => {
    const { index: i2 } = load({
      ...files,
      [`${WF}/other.yml`]:
        'on: push\njobs:\n  a:\n    uses: ./.github/workflows/leaf.yml\n    with:\n      path: literal\n  b:\n    uses: ./.github/workflows/leaf.yml\n',
    });
    const t = trace(i2, sym.input(`${WF}/leaf.yml`, 'path'), { direction: 'up' });
    expect(t.children[0]?.symbol).toBe(sym.input(`${WF}/mid.yml`, 'cfg'));
    expect(t.leaves.map((l) => `${l.role}:${l.text}`)).toEqual(['literal:"literal"', 'omitted:(not passed)']);
  });

  it('shows a whole-object read of outputs as a read of each output', () => {
    const { index: i2 } = load({
      ...files,
      [`${WF}/root.yml`]: files[`${WF}/root.yml`]!.replace(
        'echo ${{ needs.mid.outputs.result }}',
        'echo ${{ toJSON(needs.mid.outputs) }}',
      ),
      [`${WF}/mid.yml`]: files[`${WF}/mid.yml`]!.replace(
        'value: ${{ jobs.leaf.outputs.r }}',
        'value: ${{ toJSON(jobs.leaf.outputs) }}',
      ),
    });
    const t = trace(i2, sym.jobOutput(`${WF}/root.yml`, 'mid', 'result'));
    expect(t.leaves.map((l) => `${l.role}:${l.text}`)).toEqual([
      'run script:echo ${{ toJSON(needs.mid.outputs) }}',
    ]);
    const up = trace(i2, sym.output(`${WF}/mid.yml`, 'result'), { direction: 'up' });
    expect(up.children.map((c) => c.symbol)).toEqual([sym.jobOutput(`${WF}/mid.yml`, 'leaf', 'r')]);
    // `needs.<job>.result` and similar reads name the job but no output.
    const result = load({
      ...files,
      [`${WF}/root.yml`]: files[`${WF}/root.yml`]!.replace('needs.mid.outputs.result', 'needs.mid.result'),
    });
    expect(result.index.usagesOf(sym.jobOutput(`${WF}/root.yml`, 'mid', 'result'))).toEqual([]);
  });

  it('stops at cycles and depth limits', () => {
    const t = trace(index, sym.input(`${WF}/root.yml`, 'config'), { maxDepth: 1 });
    expect(t.children[0]?.stop).toBe('depth');
  });
});

describe('resolveSymbols', () => {
  const { index } = load(files);
  it.each([
    [`${WF}/mid.yml#inputs.cfg`, [`${WF}/mid.yml#inputs.cfg`]],
    ['mid.yml#inputs.cfg', [`${WF}/mid.yml#inputs.cfg`]],
    ['mid.yml:cfg', [`${WF}/mid.yml#inputs.cfg`]],
    ['mid:result', [`${WF}/mid.yml#outputs.result`]],
    ['mid.yml', [`${WF}/mid.yml#inputs.cfg`, `${WF}/mid.yml#outputs.result`]],
    ['nope.yml', []],
  ])('%s', (q, expected) => {
    expect(resolveSymbols(index, q).map((m) => m.id)).toEqual(expected);
  });
});

describe('trace: uses', () => {
  const W = `${WF}/uses.yml`;
  const A = '.github/actions/echo';
  const { index } = load({
    [W]: yaml`
      run-name: Release \${{ inputs.v }}
      on:
        workflow_dispatch:
          inputs:
            v: { type: string }
      jobs:
        j:
          name: Build \${{ inputs.v }}
          if: inputs.v != ''
          runs-on: \${{ inputs.v }}
          strategy:
            matrix:
              x: ['\${{ inputs.v }}']
          steps:
            - if: \${{ inputs.v }}
              run: |
                echo \${{ inputs.v }}
                echo and a second line that is long enough to make the script longer than eighty characters
            - uses: actions/setup-node@v4
              with:
                node-version: \${{ inputs.v }}
              env:
                V: \${{ inputs.v }}
              timeout-minutes: \${{ inputs.v }}
        deploy:
          uses: acme/infra/.github/workflows/deploy.yml@v1
          with:
            name: \${{ inputs.v }}
          secrets:
            token: \${{ inputs.v }}
    `,
    [`${A}/action.yml`]: yaml`
      inputs:
        v: {}
      runs:
        using: composite
        steps:
          - run: echo \${{ inputs.v }}
            shell: bash
    `,
  });

  it('names what each use is for and where it is, on one line of at most 80 characters', () => {
    const t = trace(index, sym.input(W, 'v'));
    expect(t.children).toEqual([]);
    expect(t.leaves.map((l) => `${l.role} | ${l.where} | ${l.text}`)).toEqual([
      'workflow setting | run-name | Release ${{ inputs.v }}',
      'job name | jobs.j › name | Build ${{ inputs.v }}',
      "condition | jobs.j › if | inputs.v != ''",
      'job setting | jobs.j › runs-on | ${{ inputs.v }}',
      'matrix | jobs.j › strategy.matrix.x.0 | ${{ inputs.v }}',
      'condition | jobs.j › steps[0] › if | ${{ inputs.v }}',
      'run script | jobs.j › steps[0] › run | echo ${{ inputs.v }} echo and a second line that is long enough to make the s...',
      'action input | jobs.j › steps[1] › with.node-version | ${{ inputs.v }}',
      'step env | jobs.j › steps[1] › env.V | ${{ inputs.v }}',
      'step setting | jobs.j › steps[1] › timeout-minutes | ${{ inputs.v }}',
      'workflow input | jobs.deploy › with.name | ${{ inputs.v }}',
      // Fields without a role of their own are named by their kind.
      'job.secrets | jobs.deploy › secrets.token | ${{ inputs.v }}',
    ]);
    expect(t.leaves[6]?.text).toHaveLength(80);
    expect(t.leaves[2]?.loc).toMatchObject({ file: W, line: 9 });
  });

  it('places a use in an action by its step', () => {
    expect(trace(index, sym.input(A, 'v')).leaves).toMatchObject([
      { role: 'run script', where: 'steps[0]', text: 'echo ${{ inputs.v }}' },
    ]);
  });

  it('returns an unknown symbol as an unresolved leaf node', () => {
    for (const direction of ['down', 'up'] as const) {
      expect(trace(index, 'nope', { direction })).toEqual({
        symbol: 'nope',
        label: 'nope',
        kind: 'unresolved',
        children: [],
        leaves: [],
      });
    }
  });
});

describe('trace: shared subtrees and cycles', () => {
  const ROOT = `${WF}/root.yml`;
  const MID = `${WF}/mid.yml`;
  const { index } = load({
    [ROOT]: yaml`
      on:
        workflow_dispatch:
          inputs:
            config: { type: string }
      jobs:
        a:
          uses: ./.github/workflows/mid.yml
          with:
            cfg: \${{ inputs.config }}-\${{ inputs.config }}
        b:
          uses: ./.github/workflows/mid.yml
          with:
            cfg: \${{ inputs.config }}
    `,
    [MID]: yaml`
      on:
        workflow_call:
          inputs:
            cfg: { type: string }
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo \${{ inputs.cfg }}
    `,
    [`${WF}/x.yml`]: yaml`
      on:
        workflow_call:
          inputs:
            a: { type: string }
      jobs:
        c:
          uses: ./.github/workflows/y.yml
          with:
            b: \${{ inputs.a }}
    `,
    [`${WF}/y.yml`]: yaml`
      on:
        workflow_call:
          inputs:
            b: { type: string }
      jobs:
        c:
          uses: ./.github/workflows/x.yml
          with:
            a: \${{ inputs.b }}
    `,
  });

  it('follows each expression once, and expands a symbol reached twice only the first time', () => {
    const down = trace(index, sym.input(ROOT, 'config'));
    expect(down.children.map((c) => [c.symbol, c.via?.text, c.stop, c.leaves.length])).toEqual([
      [sym.input(MID, 'cfg'), '${{ inputs.config }}-${{ inputs.config }}', undefined, 1],
      [sym.input(MID, 'cfg'), '${{ inputs.config }}', 'seen', 0],
    ]);
    const up = trace(index, sym.input(MID, 'cfg'), { direction: 'up' });
    expect(up.children.map((c) => [c.symbol, c.via?.text, c.stop])).toEqual([
      [sym.input(ROOT, 'config'), '${{ inputs.config }}-${{ inputs.config }}', undefined],
      [sym.input(ROOT, 'config'), '${{ inputs.config }}', 'seen'],
    ]);
  });

  it('stops where a value flows back into itself', () => {
    const a = sym.input(`${WF}/x.yml`, 'a');
    const b = sym.input(`${WF}/y.yml`, 'b');
    for (const direction of ['down', 'up'] as const) {
      const t = trace(index, a, { direction });
      expect(t.children.map((c) => c.symbol)).toEqual([b]);
      expect(t.children[0]?.children.map((c) => [c.symbol, c.stop])).toEqual([[a, 'cycle']]);
    }
  });

  it('stops at the depth limit upstream', () => {
    const t = trace(index, sym.input(MID, 'cfg'), { direction: 'up', maxDepth: 1 });
    expect(t.children.map((c) => c.stop)).toEqual(['depth', 'depth']);
  });
});

describe('trace: secrets: inherit', () => {
  const TOP = `${WF}/top.yml`;
  const LIB = `${WF}/lib.yml`;
  const PUSH = `${WF}/push.yml`;
  const { index } = load({
    [TOP]: yaml`
      on:
        workflow_call:
          secrets:
            TOKEN: {}
      jobs:
        lib:
          uses: ./.github/workflows/lib.yml
          secrets: inherit
        other:
          uses: ./.github/workflows/other.yml
          secrets: inherit
        explicit:
          uses: ./.github/workflows/lib.yml
          secrets:
            token: \${{ secrets.TOKEN }}
        remote:
          uses: acme/infra/.github/workflows/deploy.yml@v1
          secrets: inherit
    `,
    [LIB]: yaml`
      on:
        workflow_call:
          secrets:
            token: {}
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo \${{ secrets.token }}
    `,
    [`${WF}/other.yml`]: yaml`
      on: workflow_call
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo \${{ secrets.OTHER }}
    `,
    [PUSH]: yaml`
      on: push
      jobs:
        lib:
          uses: ./.github/workflows/lib.yml
          secrets: inherit
    `,
  });

  it('hands a secret down only to callees that read it, under their spelling', () => {
    const t = trace(index, sym.secret(TOP, 'TOKEN'));
    expect(t.children.map((c) => [c.symbol, c.via?.text, c.via?.note, c.stop])).toEqual([
      [sym.secret(LIB, 'token'), '${{ secrets.TOKEN }}', undefined, undefined],
      [sym.secret(LIB, 'token'), 'secrets: inherit', 'jobs.lib', 'seen'],
    ]);
  });

  it('finds the callers that inherit a secret, under their spelling', () => {
    const t = trace(index, sym.secret(LIB, 'token'), { direction: 'up' });
    expect(t.children.map((c) => [c.symbol, c.via?.text, c.via?.note, c.stop])).toEqual([
      [sym.secret(TOP, 'TOKEN'), '${{ secrets.TOKEN }}', undefined, undefined],
      // push.yml declares no secrets: the repository's secret of that name.
      [sym.secret(PUSH, 'token'), 'secrets: inherit', 'jobs.lib', undefined],
      [sym.secret(TOP, 'TOKEN'), 'secrets: inherit', 'jobs.lib', 'seen'],
    ]);
  });

  it('splits secret symbols at the last separator that a name follows', () => {
    expect(trace(index, `${TOP}#secrets.`).children).toEqual([]);
    expect(trace(index, `${TOP}#secrets.`, { direction: 'up' }).children).toEqual([]);
    expect(trace(index, `${WF}/missing.yml#secrets.TOKEN`).children).toEqual([]);
  });

  it('splits secret symbols in linear time, in both directions (js/polynomial-redos)', () => {
    const evil = `${'a#secrets.a'.repeat(50_000)}\n`;
    const started = performance.now();
    trace(index, evil);
    trace(index, evil, { direction: 'up' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('trace: sources upstream', () => {
  const W = `${WF}/matrix.yml`;
  const A = '.github/actions/a';
  const WRAP = '.github/actions/wrap';
  const { index } = load({
    [W]: yaml`
      on: push
      jobs:
        build:
          runs-on: x
          strategy:
            matrix:
              os: [linux, mac]
              include:
                - os: linux
                  extra: true
                - os: windows
                  node: \${{ vars.NODE }}
          steps:
            - uses: actions/checkout@v4
            - uses: ./.github/actions/a
              with:
                v: \${{ github.sha }}
            - uses: ./.github/actions/a
        single:
          runs-on: x
          strategy:
            matrix:
              v: [1, 2]
          steps:
            - run: echo \${{ matrix.v }}
    `,
    [`${A}/action.yml`]: yaml`
      inputs:
        v: {}
      runs:
        using: composite
        steps:
          - run: echo \${{ inputs.v }}
            shell: bash
    `,
    [`${WRAP}/action.yml`]: yaml`
      runs:
        using: composite
        steps:
          - uses: ./.github/actions/a
            with:
              v: literal
    `,
  });
  const values = (key: string, job = 'build') =>
    trace(index, sym.matrix(W, job, key), { direction: 'up' }).leaves.map(
      (l) => `${l.role} ${l.where} ${l.text}`,
    );

  it('lists the value of a matrix key in each combination, and where it is missing', () => {
    expect(values('extra')).toEqual([
      'value { os: linux } true',
      "missing { os: mac } (undefined → '')",
      "missing { os: windows, node: <expr> } (undefined → '')",
    ]);
    expect(values('node')).toEqual([
      "missing { os: linux, extra: true } (undefined → '')",
      "missing { os: mac } (undefined → '')",
      'value { os: windows } <expression>',
    ]);
    // A single key labels each combination by itself.
    expect(values('v', 'single')).toEqual(['value { v: 1 } 1', 'value { v: 2 } 2']);
  });

  it('lists the literal values and omissions of the steps that use an action', () => {
    const t = trace(index, sym.input(A, 'v'), { direction: 'up' });
    // `github.sha` is set at runtime: neither a source in the graph nor a literal.
    expect(t.children).toEqual([]);
    expect(t.leaves.map((l) => `${l.role} ${l.where} ${l.text}`)).toEqual([
      `omitted ${W} › jobs.build › steps[2] (not passed)`,
      `literal ${WRAP} › steps[0] "literal"`,
    ]);
  });
});

describe('resolveSymbols: more queries', () => {
  const { index } = load(files);
  const ids = (q: string) => resolveSymbols(index, q).map((m) => m.id);

  it('expands a full workflow id to its interface, and returns any other id as is', () => {
    expect(ids(`${WF}/mid.yml`)).toEqual([`${WF}/mid.yml#inputs.cfg`, `${WF}/mid.yml#outputs.result`]);
    expect(ids(sym.job(`${WF}/mid.yml`, 'leaf'))).toEqual([sym.job(`${WF}/mid.yml`, 'leaf')]);
    expect(resolveSymbols(index, `${WF}/mid.yml#inputs.cfg`)[0]?.node).toMatchObject({ kind: 'input' });
  });

  it('matches any symbol after `#`, ignoring case, and only interface names after `:`', () => {
    expect(ids('mid.yml#jobs.leaf')).toEqual([sym.job(`${WF}/mid.yml`, 'leaf')]);
    expect(ids('mid.yml#cfg')).toEqual([]);
    expect(ids('mid.yml:leaf')).toEqual([]);
    expect(ids('mid.yml:INPUTS.CFG')).toEqual([`${WF}/mid.yml#inputs.cfg`]);
    expect(ids('mid.yml:nope')).toEqual([]);
  });
});
