import { resolveSymbols, sym, type TraceNode, trace } from '@ciatlas/core';
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

describe('trace upstream to runtime contexts', () => {
  const callee = yaml`
    on:
      workflow_call:
        inputs:
          title: { type: string }
    jobs:
      j:
        runs-on: x
        steps:
          - run: echo
  `;
  const leavesOf = (t: ReturnType<typeof trace>) => t.leaves.map((l) => `${l.role} ${l.where}: ${l.text}`);

  it('lists the contexts a caller passes, once per expression, next to the symbols', () => {
    const { index } = load({
      [`${WF}/callee.yml`]: callee,
      [`${WF}/caller.yml`]: yaml`
        on:
          pull_request:
          workflow_dispatch:
            inputs:
              x: { type: string }
        jobs:
          a:
            uses: ./.github/workflows/callee.yml
            with:
              title: \${{ github.event.pull_request.title }}
          b:
            uses: ./.github/workflows/callee.yml
            with:
              title: \${{ inputs.x || github.event.commits[0].message }} \${{ github.event.commits[0].message }}
          c:
            needs: a
            uses: ./.github/workflows/callee.yml
            with:
              title: \${{ format('{0}-{1}', toJSON(github), needs.a.result) }}
          d:
            uses: ./.github/workflows/callee.yml
            with:
              title: \${{ format('v{0}', 1) }}
          e:
            uses: ./.github/workflows/callee.yml
            with:
              title: \${{ github.event.inputs.x }}
          f:
            uses: ./.github/workflows/callee.yml
            with:
              title: plain
      `,
    });
    const t = trace(index, sym.input(`${WF}/callee.yml`, 'title'), { direction: 'up' });
    // `github.event.inputs.x` is the dispatch input itself: a symbol, not a context.
    expect(t.children.map((c) => c.symbol)).toEqual([
      sym.input(`${WF}/caller.yml`, 'x'),
      sym.input(`${WF}/caller.yml`, 'x'),
    ]);
    const at = `${WF}/caller.yml › jobs`;
    expect(leavesOf(t)).toEqual([
      `literal ${at}.f: "plain"`,
      `context ${at}.a: github.event.pull_request.title`,
      `context ${at}.b: github.event.commits[0].message`,
      `context ${at}.c: github`,
      `context ${at}.c: needs.a.result`,
      `expression ${at}.d: \${{ format('v{0}', 1) }}`,
    ]);
    const title = t.leaves.find((l) => l.text === 'github.event.pull_request.title')!;
    expect([title.loc.file, title.loc.line, title.loc.column]).toEqual([`${WF}/caller.yml`, 10, 18]);
  });

  it("lists the contexts of a step's with: for an action's input", () => {
    const { index } = load({
      '.github/actions/greet/action.yml': yaml`
        name: greet
        description: x
        inputs:
          title: { description: x }
        runs:
          using: composite
          steps:
            - shell: bash
              run: echo "\${{ inputs.title }}"
      `,
      [`${WF}/ci.yml`]: yaml`
        on: pull_request
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v4
              - uses: ./.github/actions/greet
                with:
                  title: \${{ github.event.pull_request.title }}
      `,
    });
    const t = trace(index, sym.input('.github/actions/greet', 'title'), { direction: 'up' });
    expect(leavesOf(t)).toEqual([
      `context ${WF}/ci.yml › jobs.j › steps[1]: github.event.pull_request.title`,
    ]);
  });

  it('lists the contexts of outputs and env values, and nothing for a definition made of symbols only', () => {
    const { index } = load({
      [`${WF}/ci.yml`]: yaml`
        on: push
        env:
          SHA: \${{ github.sha }}
        jobs:
          j:
            runs-on: x
            outputs:
              os: \${{ runner.os }}
              id: \${{ steps.s.outputs.id }}
              late: \${{ env.SET_AT_RUNTIME }}
            steps:
              - id: s
                run: echo "id=1" >> "$GITHUB_OUTPUT"
      `,
    });
    const up = (s: string) => leavesOf(trace(index, s, { direction: 'up' }));
    expect(up(sym.env(`${WF}/ci.yml`, undefined, 'SHA'))).toEqual([`context ${WF}/ci.yml: github.sha`]);
    expect(up(sym.jobOutput(`${WF}/ci.yml`, 'j', 'os'))).toEqual([
      `context ${WF}/ci.yml › jobs.j: runner.os`,
    ]);
    // An env value no `env:` declares is set at runtime (e.g. through $GITHUB_ENV).
    expect(up(sym.jobOutput(`${WF}/ci.yml`, 'j', 'late'))).toEqual([
      `context ${WF}/ci.yml › jobs.j: env.SET_AT_RUNTIME`,
    ]);
    const id = trace(index, sym.jobOutput(`${WF}/ci.yml`, 'j', 'id'), { direction: 'up' });
    expect(id.children.map((c) => c.symbol)).toEqual([sym.stepOutput(`${WF}/ci.yml`, 'j', 's', 'id')]);
    expect(id.leaves).toEqual([]);
    // Downstream traces are unchanged: contexts are where a value comes from, not where it goes.
    expect(trace(index, sym.jobOutput(`${WF}/ci.yml`, 'j', 'os')).leaves).toEqual([]);
  });
});

describe('trace upstream: what the review found', () => {
  const leavesOf = (t: ReturnType<typeof trace>) => t.leaves.map((l) => `${l.role} ${l.where}: ${l.text}`);
  const action = (inputs: string) => yaml`
    name: a
    description: x
    inputs:
      ${inputs}
    runs:
      using: composite
      steps:
        - shell: bash
          run: echo
  `;

  it("follows a step's own env: to its literal, its contexts and the symbols it reads", () => {
    const { index } = load({
      '.github/actions/a/action.yml': action('v: { description: x }'),
      [`${WF}/w.yml`]: yaml`
        on:
          pull_request:
          workflow_dispatch:
            inputs:
              label: { type: string }
        env:
          OUT: wf
        jobs:
          j:
            runs-on: x
            steps:
              - uses: ./.github/actions/a
                env:
                  LIT: literal
                with:
                  v: \${{ env.LIT }}
              - uses: ./.github/actions/a
                env:
                  CTX: \${{ github.event.pull_request.title }}
                with:
                  v: \${{ env.CTX }}
              - uses: ./.github/actions/a
                env:
                  MIX: \${{ env.OUT }}-\${{ inputs.label }}-\${{ github.event.pull_request.title }}
                with:
                  v: \${{ env.MIX }}
              - uses: ./.github/actions/a
                with:
                  v: \${{ env.SET_AT_RUNTIME }}
      `,
    });
    const t = trace(index, sym.input('.github/actions/a', 'v'), { direction: 'up' });
    expect(t.children.map((c) => c.symbol)).toEqual([
      sym.env(`${WF}/w.yml`, undefined, 'OUT'),
      sym.input(`${WF}/w.yml`, 'label'),
    ]);
    const at = `${WF}/w.yml › jobs.j › steps`;
    expect(leavesOf(t)).toEqual([
      `literal ${at}[0]: "literal"`,
      `context ${at}[1]: github.event.pull_request.title`,
      `context ${at}[2]: github.event.pull_request.title`,
      `context ${at}[3]: env.SET_AT_RUNTIME`,
    ]);
    // The context is located in the step's env:, where it is written.
    const ctx = t.leaves[1]!;
    expect([ctx.loc.line, ctx.loc.column]).toEqual([19, 20]);
  });

  it('writes each reference as written, on one line, once whatever its case', () => {
    const { index } = load({
      [`${WF}/callee.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              a: { type: string }
              b: { type: string }
              c: { type: string }
              d: { type: string }
        jobs:
          j:
            runs-on: x
            steps:
              - run: echo
      `,
      [`${WF}/caller.yml`]: yaml`
        on: pull_request
        jobs:
          j:
            uses: ./.github/workflows/callee.yml
            with:
              a: \${{ fromJSON(github.event.client_payload)[github.event.action] }}
              b: \${{ github.event[github.event.action] }}
              c: |
                \${{ github.event.pull_request
                  .title }}
              d: \${{ github.event.pull_request.title }} \${{ GitHub.Event.Pull_Request.Title }}
      `,
    });
    const texts = (name: string) =>
      trace(index, sym.input(`${WF}/callee.yml`, name), { direction: 'up' }).leaves.map((l) => l.text);
    expect(texts('a')).toEqual(['github.event.client_payload', 'github.event.action']);
    expect(texts('b')).toEqual(['github.event[…]', 'github.event.action']);
    expect(texts('c')).toEqual(['github.event.pull_request.title']);
    expect(texts('d')).toEqual(['github.event.pull_request.title']);
  });

  it('names a step in an action by the action, and an expression that does not parse as invalid', () => {
    const { index } = load({
      '.github/actions/a/action.yml': action('v: { description: x }'),
      '.github/actions/wrap/action.yml': yaml`
        name: wrap
        description: x
        runs:
          using: composite
          steps:
            - uses: ./.github/actions/a
              with:
                v: \${{ github.action_path }}
            - uses: ./.github/actions/a
              with:
                v: \${{ github.event.pull_request.title ==== }}
      `,
    });
    expect(leavesOf(trace(index, sym.input('.github/actions/a', 'v'), { direction: 'up' }))).toEqual([
      'context .github/actions/wrap › steps[0]: github.action_path',
      'invalid .github/actions/wrap › steps[1]: github.event.pull_request.title ====',
    ]);
  });

  it('lists plain values of env variables and outputs as literals', () => {
    const { index } = load({
      '.github/actions/a/action.yml': yaml`
        name: a
        description: x
        outputs:
          fixed: { description: x, value: constant }
        runs:
          using: composite
          steps: []
      `,
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_call:
            outputs:
              fixed: { value: constant }
        env:
          MODE: fast
        jobs:
          j:
            runs-on: x
            env:
              LEVEL: 3
            outputs:
              o: fixed-value
            steps:
              - run: echo
      `,
    });
    const up = (s: string) => leavesOf(trace(index, s, { direction: 'up' }));
    const w = `${WF}/w.yml`;
    expect(up(sym.env(w, undefined, 'MODE'))).toEqual([`literal ${w}: "fast"`]);
    expect(up(sym.env(w, 'j', 'LEVEL'))).toEqual([`literal ${w} › jobs.j: 3`]);
    expect(up(sym.jobOutput(w, 'j', 'o'))).toEqual([`literal ${w} › jobs.j: "fixed-value"`]);
    expect(up(sym.output(w, 'fixed'))).toEqual([`literal ${w}: "constant"`]);
    expect(up(sym.output('.github/actions/a', 'fixed'))).toEqual(['literal .github/actions/a: "constant"']);
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
    // `github.sha` is set at runtime: not a symbol in the graph, so the trace ends at it, as a context.
    expect(t.children).toEqual([]);
    expect(t.leaves.map((l) => `${l.role} ${l.where} ${l.text}`)).toEqual([
      `omitted ${W} › jobs.build › steps[2] (not passed)`,
      `literal ${WRAP} › steps[0] "literal"`,
      `context ${W} › jobs.build › steps[1] github.sha`,
    ]);
  });
});

describe('trace upstream: input defaults', () => {
  const A = '.github/actions/a';
  const CALLEE = `${WF}/callee.yml`;
  const CALLER = `${WF}/caller.yml`;
  const leavesOf = (t: ReturnType<typeof trace>) =>
    t.leaves.map((l) => `${l.role} ${l.where} ${l.text} @${l.loc.line}:${l.loc.column}`);
  const action = (inputs: string) => yaml`
    name: a
    description: x
    inputs:
      ${inputs}
    runs:
      using: composite
      steps:
        - run: echo
          shell: bash
  `;
  const steps = (...withs: string[]) =>
    `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n${withs.map((w) => `      - uses: ./.github/actions/a${w}\n`).join('')}`;

  it("ends at the contexts an action input's default reads when a step omits the input (#13)", () => {
    const { index } = load({
      [`${A}/action.yml`]: action('token: { description: x, default: "${{ github.token }}" }'),
      [`${WF}/ci.yml`]: steps(''),
    });
    expect(leavesOf(trace(index, sym.input(A, 'token'), { direction: 'up' }))).toEqual([
      `omitted ${WF}/ci.yml › jobs.j › steps[0] (not passed) @6:15`,
      `context ${A} › inputs.token.default github.token @4:42`,
    ]);
  });

  it('ends at a plain default as a literal, after the calls and before the contexts they pass', () => {
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_call:
            inputs:
              env: { type: string, default: staging }
        jobs:
          j: { runs-on: x, steps: [{ run: echo }] }
      `,
      [CALLER]: yaml`
        on: push
        jobs:
          a: { uses: ./.github/workflows/callee.yml, with: { env: prod } }
          b: { uses: ./.github/workflows/callee.yml }
          c: { uses: ./.github/workflows/callee.yml, with: { env: "\${{ github.ref_name }}" } }
      `,
    });
    expect(leavesOf(trace(index, sym.input(CALLEE, 'env'), { direction: 'up' }))).toEqual([
      `literal ${CALLER} › jobs.a "prod" @3:59`,
      `omitted ${CALLER} › jobs.b (not passed) @4:14`,
      `literal ${CALLEE} › on.workflow_call.inputs.env.default "staging" @4:37`,
      `context ${CALLER} › jobs.c github.ref_name @5:64`,
    ]);
  });

  it('shows no default when every call passes the input, or when there is none', () => {
    const { index } = load({
      [`${A}/action.yml`]: action(
        'token: { description: x, default: "${{ github.token }}" }\n      flag: { description: x, default: "false" }\n      bare: { description: x }',
      ),
      [`${WF}/ci.yml`]: steps('\n        with: { token: x }', '\n        with: { token: y, flag: true }'),
    });
    const roles = (name: string) =>
      trace(index, sym.input(A, name), { direction: 'up' }).leaves.map((l) => l.role);
    expect(roles('token')).toEqual(['literal', 'literal']);
    expect(roles('flag')).toEqual(['omitted', 'literal', 'literal']);
    expect(trace(index, sym.input(A, 'flag'), { direction: 'up' }).leaves[2]!.text).toBe('"false"');
    expect(roles('bare')).toEqual(['omitted', 'omitted']);
  });

  it('follows the inputs and vars a workflow_call default reads, and ends at its contexts', () => {
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_call:
            inputs:
              base: { type: string, default: main }
              ref: { type: string, default: "\${{ inputs.base }}-\${{ vars.SUFFIX }}-\${{ github.ref_name }}" }
        jobs:
          j: { runs-on: x, steps: [{ run: echo }] }
      `,
      [CALLER]: yaml`
        on: push
        jobs:
          a: { uses: ./.github/workflows/callee.yml, with: { base: dev } }
      `,
    });
    const t = trace(index, sym.input(CALLEE, 'ref'), { direction: 'up' });
    expect(t.children.map((c) => [c.symbol, c.via?.loc.column, c.via?.note])).toEqual([
      [sym.input(CALLEE, 'base'), 42, 'the default of inputs.ref'],
      [sym.var('SUFFIX'), 61, 'the default of inputs.ref'],
    ]);
    expect(t.children[0]!.via?.text).toBe('${{ inputs.base }}-${{ vars.SUFFIX }}-${{ github.ref_name }}');
    // `base` is passed by its one caller, so its own default is no source of it.
    expect(leavesOf(t.children[0]!)).toEqual([`literal ${CALLER} › jobs.a "dev" @3:60`]);
    expect(leavesOf(t)).toEqual([
      `omitted ${CALLER} › jobs.a (not passed) @3:14`,
      `context ${CALLEE} › on.workflow_call.inputs.ref.default github.ref_name @5:80`,
    ]);
  });

  it('ends at a default that reads nothing, or does not parse, as an expression or invalid', () => {
    const { index } = load({
      [`${A}/action.yml`]: action(
        'key: { description: x, default: "${{ hashFiles(\'**/lock\') }}" }\n      bad: { description: x, default: "${{ github. }}" }\n      os: { description: x, default: "${{ runner.os }}-${{ matrix.os }}" }',
      ),
      [`${WF}/ci.yml`]: steps(''),
    });
    const leaves = (name: string) =>
      trace(index, sym.input(A, name), { direction: 'up' }).leaves.map((l) => `${l.role} ${l.text}`);
    expect(leaves('key')).toEqual(['omitted (not passed)', "expression ${{ hashFiles('**/lock') }}"]);
    expect(leaves('bad')).toEqual(['omitted (not passed)', 'invalid github.']);
    // An action's default reads the calling job's matrix, which the trace does not follow into each caller.
    expect(leaves('os')).toEqual(['omitted (not passed)', 'context runner.os', 'context matrix.os']);
  });

  it("uses a called workflow's workflow_call default, never its workflow_dispatch one", () => {
    const callee = (callDefault: string) => yaml`
      on:
        workflow_call:
          inputs:
            x: { type: string${callDefault} }
        workflow_dispatch:
          inputs:
            x: { type: string, default: manual }
      jobs:
        j: { runs-on: x, steps: [{ run: echo }] }
    `;
    const caller = 'on: push\njobs:\n  a: { uses: ./.github/workflows/callee.yml }\n';
    const texts = (callDefault: string) =>
      trace(load({ [CALLEE]: callee(callDefault), [CALLER]: caller }).index, sym.input(CALLEE, 'x'), {
        direction: 'up',
      }).leaves.map((l) => l.text);
    expect(texts('')).toEqual(['(not passed)']);
    expect(texts(', default: called')).toEqual(['(not passed)', '"called"']);
  });

  it('stops at a default that reads its own input, and leaves the downstream trace as it was', () => {
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_call:
            inputs:
              x: { type: string, default: "\${{ inputs.x }}" }
        jobs:
          j: { runs-on: x, steps: [{ run: echo }] }
      `,
      [CALLER]: 'on: push\njobs:\n  a: { uses: ./.github/workflows/callee.yml }\n',
    });
    const t = trace(index, sym.input(CALLEE, 'x'), { direction: 'up' });
    expect(t.children.map((c) => [c.symbol, c.stop])).toEqual([[sym.input(CALLEE, 'x'), 'cycle']]);
    const down = trace(index, sym.input(CALLEE, 'x'));
    expect(down.children).toEqual([]);
    expect(down.leaves.map((l) => `${l.role} ${l.where}`)).toEqual([
      'input.default on.workflow_call.inputs.x.default',
    ]);
  });

  const caller = 'on: push\njobs:\n  a: { uses: ./.github/workflows/callee.yml }\n';

  it("ends at github.event.inputs in a workflow_call default as a context: the caller's event, not this input", () => {
    // The default applies only when the workflow is called, and then `github` is the caller's.
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_dispatch:
            inputs:
              x: { type: string, default: d }
          workflow_call:
            inputs:
              x: { type: string, default: "\${{ github.event.inputs.x }}" }
              y: { type: string, default: "\${{ github.event.inputs.x }}" }
        jobs:
          j: { runs-on: x, steps: [{ run: echo }] }
      `,
      [CALLER]: caller,
    });
    for (const [name, line] of [
      ['x', 7],
      ['y', 8],
    ] as const) {
      const t = trace(index, sym.input(CALLEE, name), { direction: 'up' });
      expect(t.children).toEqual([]);
      expect(leavesOf(t)).toEqual([
        `omitted ${CALLER} › jobs.a (not passed) @3:14`,
        `context ${CALLEE} › on.workflow_call.inputs.${name}.default github.event.inputs.x @${line}:40`,
      ]);
    }
  });

  it("shows no default for a required workflow_call input, which GitHub never uses, but does for an action's", () => {
    // GitHub fails the run when a caller omits a required workflow_call input; an action's `required` is not enforced.
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_call:
            inputs:
              req: { type: string, required: true, default: never-used }
        jobs:
          j: { runs-on: x, steps: [{ uses: ./.github/actions/a }] }
      `,
      [CALLER]: caller,
      [`${A}/action.yml`]: action('req: { description: x, required: true, default: used }'),
    });
    expect(leavesOf(trace(index, sym.input(CALLEE, 'req'), { direction: 'up' }))).toEqual([
      `omitted ${CALLER} › jobs.a (not passed) @3:14`,
    ]);
    expect(leavesOf(trace(index, sym.input(A, 'req'), { direction: 'up' }))).toEqual([
      `omitted ${CALLEE} › jobs.j › steps[0] (not passed) @6:36`,
      `literal ${A} › inputs.req.default "used" @4:51`,
    ]);
  });

  it('ends at a context GitHub does not allow in a default as invalid, and follows none of them', () => {
    // An action input's default may read github, strategy, matrix, job and runner; a workflow_call input's github,
    // inputs and vars.
    const { index } = load({
      [`${A}/action.yml`]: action(
        [
          'a: { description: x, default: "${{ inputs.b }} ${{ vars.V }} ${{ steps.s.outputs.v }} ${{ job.status }}" }',
          'b: { description: x, default: "${{ env.E }} ${{ secrets.S }} ${{ needs.n.outputs.o }} ${{ env.E }}" }',
        ].join('\n      '),
      ),
      [CALLEE]: yaml`
        on:
          workflow_call:
            inputs:
              w: { type: string, default: "\${{ secrets.S }} \${{ env.E }} \${{ matrix.os }} \${{ inputs.v }}" }
              v: { type: string }
            secrets:
              S: { required: false }
        env:
          E: e
        jobs:
          j: { runs-on: x, steps: [{ uses: ./.github/actions/a }] }
      `,
      [CALLER]: caller,
    });
    const shown = (symbol: string) => {
      const t = trace(index, symbol, { direction: 'up' });
      return {
        children: t.children.map((c) => c.symbol),
        leaves: t.leaves.map((l) => `${l.role} ${l.text}`),
      };
    };
    expect(shown(sym.input(A, 'a'))).toEqual({
      children: [],
      leaves: [
        'omitted (not passed)',
        'invalid inputs.b',
        'invalid vars.V',
        'invalid steps.s.outputs.v',
        'context job.status',
      ],
    });
    // Each place is a leaf of its own, as for an expression that does not parse.
    expect(shown(sym.input(A, 'b')).leaves).toEqual([
      'omitted (not passed)',
      'invalid env.E',
      'invalid secrets.S',
      'invalid needs.n.outputs.o',
      'invalid env.E',
    ]);
    expect(shown(sym.input(CALLEE, 'w'))).toEqual({
      children: [sym.input(CALLEE, 'v')],
      leaves: ['omitted (not passed)', 'invalid secrets.S', 'invalid env.E', 'invalid matrix.os'],
    });
  });

  it("follows only a workflow's own workflow_call inputs from a workflow_call default", () => {
    // The default applies when the workflow is called, and then `inputs` holds its workflow_call inputs only: one that
    // only workflow_dispatch declares, or that no trigger declares, is empty there.
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_dispatch:
            inputs:
              env-name: { type: environment, default: staging }
              both: { type: string, default: manual }
          workflow_call:
            inputs:
              both: { type: string }
              target: { type: string, default: "\${{ inputs.env-name }}" }
              other: { type: string, default: "\${{ inputs.nope }}" }
              mixed: { type: string, default: "\${{ inputs['Env-Name'] }}-\${{ inputs['BOTH'] }}" }
        jobs:
          j: { runs-on: x, environment: "\${{ inputs.env-name }}", steps: [{ run: echo }] }
      `,
      [CALLER]: caller,
    });
    const shown = (name: string) => {
      const t = trace(index, sym.input(CALLEE, name), { direction: 'up' });
      return { children: t.children.map((c) => c.symbol), leaves: leavesOf(t).slice(1) };
    };
    const at = (name: string) => `${CALLEE} › on.workflow_call.inputs.${name}.default`;
    expect(shown('target')).toEqual({
      children: [],
      leaves: [`context ${at('target')} inputs.env-name @9:45`],
    });
    expect(shown('other')).toEqual({ children: [], leaves: [`context ${at('other')} inputs.nope @10:44`] });
    expect(shown('mixed')).toEqual({
      children: [sym.input(CALLEE, 'both')],
      leaves: [`context ${at('mixed')} inputs['Env-Name'] @11:44`],
    });
  });

  it('ends at a function GitHub does not allow in a default as invalid: hashFiles() in a workflow_call one', () => {
    // A workflow_call input's default may call none of hashFiles() and the status functions; an action input's may
    // call hashFiles() (see above), but no status function. A step's with: may call hashFiles().
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_call:
            inputs:
              key: { type: string, default: "\${{ hashFiles('**/lock') }}" }
              ok: { type: string, default: "\${{ success() && inputs.v }}-\${{ toJSON(vars.V) }}" }
              v: { type: string }
        jobs:
          j:
            runs-on: x
            steps:
              - uses: ./.github/actions/a
              - { uses: ./.github/actions/a, with: { a: "\${{ hashFiles('y') }}" } }
      `,
      [CALLER]: caller,
      [`${A}/action.yml`]: action(
        'a: { description: x, default: "${{ hashFiles(\'**/lock\') }}-${{ CANCELLED() || job.status }}" }',
      ),
    });
    const shown = (symbol: string) => {
      const t = trace(index, symbol, { direction: 'up' });
      return { children: t.children.map((c) => c.symbol), leaves: leavesOf(t).slice(1) };
    };
    const at = (name: string) => `${CALLEE} › on.workflow_call.inputs.${name}.default`;
    expect(shown(sym.input(CALLEE, 'key'))).toEqual({
      children: [],
      leaves: [`invalid ${at('key')} hashFiles() @4:42`],
    });
    expect(shown(sym.input(CALLEE, 'ok'))).toEqual({
      children: [sym.input(CALLEE, 'v'), sym.var('V')],
      leaves: [`invalid ${at('ok')} success() @5:41`],
    });
    expect(shown(sym.input(A, 'a'))).toEqual({
      children: [],
      leaves: [
        `invalid ${A} › inputs.a.default CANCELLED() @4:66`,
        `context ${A} › inputs.a.default job.status @4:81`,
        `expression ${CALLEE} › jobs.j › steps[1] \${{ hashFiles('y') }} @12:49`,
      ],
    });
  });

  it('finds every call GitHub does not allow in a default, once per function in each expression', () => {
    // A call may sit under `!`, either side of a comparison, `&&` or `||`, a function's arguments, `( )`, or either
    // side of an index. Each expression lists each function once, ignoring case, in the order it calls them; the same
    // function in another expression is another leaf, at that expression.
    const { index } = load({
      [CALLEE]: yaml`
        on:
          workflow_call:
            inputs:
              x:
                type: string
                default: >-
                  \${{ !cancelled() || format('{0}', hashFiles('a')) }}
                  \${{ fromJSON('{}')[always()] && (success()) }}
                  \${{ failure() == hashFiles('b')[0] || success() || SUCCESS() }}
        jobs:
          j: { runs-on: x, steps: [{ run: echo }] }
      `,
      [CALLER]: caller,
    });
    const t = trace(index, sym.input(CALLEE, 'x'), { direction: 'up' });
    const at = `invalid ${CALLEE} › on.workflow_call.inputs.x.default`;
    expect(t.children).toEqual([]);
    expect(leavesOf(t).slice(1)).toEqual([
      `${at} cancelled() @7:15`,
      `${at} hashFiles() @7:15`,
      `${at} always() @8:15`,
      `${at} success() @8:15`,
      `${at} failure() @9:15`,
      `${at} hashFiles() @9:15`,
      `${at} success() @9:15`,
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

// GitHub gives a called workflow its caller's `github` context, event payload included, so in a workflow that can be
// called `github.event.inputs` is the caller's own event, never what the caller passes in `with:`.
describe('trace: github.event.inputs in a workflow that can be called', () => {
  const MID = `${WF}/mid.yml`;
  const TOP = `${WF}/top.yml`;
  const UPPER = `${WF}/upper.yml`;
  const CALLEE = `${WF}/callee.yml`;
  const mid = (on: string) => yaml`
    on:
      ${on}
    jobs:
      a:
        uses: ./.github/workflows/callee.yml
        with:
          title: \${{ github.event.inputs.x }}
      b:
        uses: ./.github/workflows/callee.yml
        with:
          title: \${{ inputs.x || github.event.inputs.x }}
      c:
        runs-on: x
        steps:
          - run: echo \${{ github.event.inputs.x }} \${{ inputs.x }}
  `;
  const both = mid(`workflow_call:
        inputs:
          x: { type: string }
      workflow_dispatch:
        inputs:
          x: { type: string }`);
  const files = (midText: string) => ({
    [MID]: midText,
    [CALLEE]: yaml`
      on:
        workflow_call:
          inputs:
            title: { type: string }
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo
    `,
    [TOP]: yaml`
      on: pull_request
      jobs:
        m:
          uses: ./.github/workflows/mid.yml
          with:
            x: \${{ github.event.pull_request.title }}
    `,
    [UPPER]: yaml`
      on:
        workflow_call:
          inputs:
            foo: { type: string }
      jobs:
        m:
          uses: ./.github/workflows/mid.yml
          with:
            x: \${{ inputs.foo }}
    `,
  });
  const { index } = load(files(both));
  const title = sym.input(CALLEE, 'title');
  const x = sym.input(MID, 'x');
  const leavesOf = (t: TraceNode) => t.leaves.map((l) => `${l.role} ${l.where}: ${l.text}`);
  const allLeaves = (t: TraceNode): string[] => [...leavesOf(t), ...t.children.flatMap(allLeaves)];
  const lineOf = (file: string, needle: string) => {
    const text = index.unit(file)?.source.text ?? '';
    return text.slice(0, text.indexOf(needle)).split('\n').length;
  };
  const parentsVia = (t: TraceNode, field: string) =>
    t.children.filter((c) => c.via?.loc.line === lineOf(MID, field));

  it('keeps the read in the graph, for the dispatched case and the rules that count reads', () => {
    expect(index.incoming(title, 'flows').map((e) => e.from)).toEqual([x, x, x]);
    expect(index.usagesOf(x).map((u) => [u.ref.context, ...u.ref.path].join('.'))).toEqual([
      'github.event.inputs.x',
      'inputs.x',
      'github.event.inputs.x',
      'github.event.inputs.x',
      'inputs.x',
    ]);
  });

  it('traces a value read only through github.event.inputs up to the dispatch input and the caller’s event', () => {
    const t = trace(index, title, { direction: 'up' });
    const [onlyEvent] = parentsVia(t, 'title: ${{ github.event.inputs.x }}');
    // When dispatched, the dispatch input: entered by whoever dispatches mid.yml, so nothing above it.
    expect(onlyEvent).toMatchObject({ symbol: x, children: [], leaves: [] });
    expect(onlyEvent!.stop).toBeUndefined();
    expect(onlyEvent!.via?.note).toBe('when dispatched');
    // When called, the caller's event, once per definition, at the reference.
    expect(leavesOf(t)).toEqual([
      `context ${MID} › jobs.a: github.event.inputs.x`,
      `context ${MID} › jobs.b: github.event.inputs.x`,
    ]);
    expect(t.leaves[0]!.loc.line).toBe(lineOf(MID, 'title: ${{ github.event.inputs.x }}'));
    // `inputs.x` in the same expression does hold the callers' values: top.yml's pull request title, upper.yml's foo.
    // The dispatch input alone is not marked as expanded, so this parent still is.
    const [both] = parentsVia(t, 'title: ${{ inputs.x ||');
    expect(both!.symbol).toBe(x);
    expect(both!.via?.note).toBeUndefined();
    expect(both!.children.map((c) => c.symbol)).toEqual([sym.input(UPPER, 'foo')]);
    expect(leavesOf(both!)).toEqual([`context ${TOP} › jobs.m: github.event.pull_request.title`]);
    expect(allLeaves(t).filter((l) => l.includes('pull_request'))).toHaveLength(1);
  });

  it('shows the dispatch input alone even where the trace comes up from a caller', () => {
    // Up from top.yml's job, mid.yml runs as called there; the trace does not keep track of that, so the dispatch input
    // is still listed, as a parent with nothing above it: top.yml's pull request title is never a source.
    const outputs = mid(`workflow_call:
        inputs:
          x: { type: string }
        outputs:
          o:
            value: \${{ jobs.d.outputs.e }}
      workflow_dispatch:
        inputs:
          x: { type: string }`).replace(
      '  c:\n',
      '  d:\n    runs-on: x\n    outputs:\n      e: ${{ github.event.inputs.x }}\n    steps: [{ run: echo }]\n  c:\n',
    );
    const t = trace(load(files(outputs)).index, sym.jobOutput(TOP, 'm', 'o'), { direction: 'up' });
    const e = t.children[0]!.children[0]!;
    expect(e.symbol).toBe(sym.jobOutput(MID, 'd', 'e'));
    expect(e.children).toMatchObject([
      { symbol: x, children: [], leaves: [], via: { note: 'when dispatched' } },
    ]);
    expect(allLeaves(t)).toEqual([`context ${MID} › jobs.d: github.event.inputs.x`]);
  });

  it('does not let a caller’s with: value flow on through github.event.inputs', () => {
    const t = trace(index, sym.input(UPPER, 'foo'));
    const [called] = t.children;
    expect(called!.symbol).toBe(x);
    // Only `inputs.x` carries foo on: to jobs.b's title and to jobs.c's script.
    expect(called!.children.map((c) => `${c.symbol} ${c.via?.text}`)).toEqual([
      `${title} \${{ inputs.x || github.event.inputs.x }}`,
    ]);
    expect(leavesOf(called!)).toEqual([
      `run script jobs.c › steps[0] › run: echo \${{ github.event.inputs.x }} \${{ inputs.x }}`,
    ]);
    // From the input itself (dispatched or called), every read is listed.
    const root = trace(index, x);
    expect(root.children.map((c) => c.via?.text)).toEqual([
      '${{ github.event.inputs.x }}',
      '${{ inputs.x || github.event.inputs.x }}',
    ]);
    expect(root.leaves).toHaveLength(2);
  });

  describe('through the step’s own env', () => {
    const ACTION = '.github/actions/a';
    const WFP = `${WF}/wf.yml`;
    const z = sym.input(WFP, 'z');
    /** wf.yml's step s passes `env.X` to action a, where the step's own `X` is the value given. */
    const repo = (value: string) =>
      load({
        [WFP]: yaml`
          on:
            workflow_dispatch:
              inputs: { z: { type: string } }
            workflow_call:
              inputs: { z: { type: string } }
          jobs:
            j:
              runs-on: x
              outputs:
                o: \${{ steps.s.outputs.out }}
              steps:
                - id: s
                  uses: ./.github/actions/a
                  env:
                    X: ${value}
                  with:
                    v: \${{ env.X }}
        `,
        [TOP]: yaml`
          on: workflow_dispatch
          jobs:
            t:
              uses: ./.github/workflows/wf.yml
              with:
                z: from-top
        `,
        [UPPER]: yaml`
          on:
            workflow_call:
              inputs: { q: { type: string } }
          jobs:
            t:
              uses: ./.github/workflows/wf.yml
              with:
                z: \${{ inputs.q }}
        `,
        [`${ACTION}/action.yml`]: yaml`
          name: a
          description: d
          inputs: { v: { description: v } }
          outputs: { out: { description: o, value: "\${{ inputs.v }}" } }
          runs:
            using: composite
            steps: [{ shell: bash, run: echo }]
        `,
      }).index;
    const eventOnly = repo('${{ github.event.inputs.z }}');
    const v = sym.input(ACTION, 'v');

    it('traces a value read through the step’s own env up to the dispatch input alone, as a direct read', () => {
      const t = trace(eventOnly, sym.jobOutput(WFP, 'j', 'o'), { direction: 'up' });
      const input = t.children[0]!.children[0]!.children[0]!;
      expect(input.symbol).toBe(v);
      expect(input.children).toMatchObject([
        { symbol: z, children: [], leaves: [], via: { text: '${{ env.X }}', note: 'when dispatched' } },
      ]);
      // The caller's event, at the reference in the step's env; top.yml's value is never a source.
      expect(leavesOf(input)).toEqual([`context ${WFP} › jobs.j › steps[0]: github.event.inputs.z`]);
      expect(allLeaves(t)).not.toContainEqual(expect.stringContaining('from-top'));
    });

    it('does not let a caller’s with: value flow on through the step’s own env', () => {
      const t = trace(eventOnly, sym.input(UPPER, 'q'));
      expect(t.children.map((c) => c.symbol)).toEqual([z]);
      expect(t.children[0]!.children).toEqual([]);
      expect(t.children[0]!.leaves).toEqual([]);
      // From the input itself, the step's reads are listed.
      expect(trace(eventOnly, z).children.map((c) => `${c.symbol} ${c.via?.text}`)).toEqual([
        `${v} \${{ env.X }}`,
      ]);
    });

    it('traces the input on up when the step’s own env also reads it through inputs', () => {
      const both = repo('${{ inputs.z || github.event.inputs.z }}');
      const up = trace(both, v, { direction: 'up' });
      expect(up.children.map((c) => `${c.symbol} ${c.via?.note}`)).toEqual([`${z} undefined`]);
      expect(leavesOf(up.children[0]!)).toEqual([`literal ${TOP} › jobs.t: "from-top"`]);
      expect(leavesOf(up)).toEqual([`context ${WFP} › jobs.j › steps[0]: github.event.inputs.z`]);
      expect(trace(both, sym.input(UPPER, 'q')).children[0]!.children.map((c) => c.symbol)).toEqual([v]);
    });
  });

  it('leaves a workflow that is only dispatched as it was', () => {
    const { index: dispatched } = load(
      files(
        mid(`workflow_dispatch:
        inputs:
          x: { type: string }`),
      ),
    );
    const t = trace(dispatched, title, { direction: 'up' });
    expect(t.children.map((c) => `${c.symbol} ${c.via?.note}`)).toEqual([`${x} undefined`, `${x} undefined`]);
    expect(t.children[1]).toMatchObject({ stop: 'seen' });
    expect(t.leaves).toEqual([]);
    expect(trace(dispatched, x).children).toHaveLength(2);
  });

  it('lists no dispatch input for a name that only workflow_call declares, or that none does', () => {
    const triggers = `workflow_call:
        inputs:
          x: { type: string }
      workflow_dispatch:
        inputs:
          d: { type: string }`;
    // x is not a dispatch input: github.event.inputs.x is empty when mid.yml is dispatched and the caller's event when
    // it is called, so job a ends at the context alone. Job b's inputs.x still holds the callers' values.
    const { index: callName } = load(files(mid(triggers)));
    const t = trace(callName, title, { direction: 'up' });
    expect(t.children.map((c) => `${c.symbol} ${c.via?.text} ${c.via?.note}`)).toEqual([
      `${x} \${{ inputs.x || github.event.inputs.x }} undefined`,
    ]);
    expect(leavesOf(t)).toEqual([
      `context ${MID} › jobs.a: github.event.inputs.x`,
      `context ${MID} › jobs.b: github.event.inputs.x`,
    ]);
    // A name no trigger declares: the context alone too.
    const ghostly = mid(triggers).replace(
      'title: ${{ github.event.inputs.x }}',
      'title: ${{ github.event.inputs.ghost }}',
    );
    const { index: ghost } = load(files(ghostly), { validateSchema: false });
    const g = trace(ghost, title, { direction: 'up' });
    expect(g.children.map((c) => c.via?.text)).toEqual(['${{ inputs.x || github.event.inputs.x }}']);
    expect(leavesOf(g)[0]).toBe(`context ${MID} › jobs.a: github.event.inputs.ghost`);
  });

  it('ends at the caller’s event in a workflow that is only called, as it did', () => {
    const { index: called } = load(
      files(
        mid(`workflow_call:
        inputs:
          x: { type: string }`),
      ),
    );
    const t = trace(called, title, { direction: 'up' });
    expect(t.children.map((c) => `${c.symbol} ${c.via?.text}`)).toEqual([
      `${x} \${{ inputs.x || github.event.inputs.x }}`,
    ]);
    expect(leavesOf(t)).toEqual([
      `context ${MID} › jobs.a: github.event.inputs.x`,
      `context ${MID} › jobs.b: github.event.inputs.x`,
    ]);
    const down = trace(called, sym.input(UPPER, 'foo')).children[0]!;
    expect(down.children.map((c) => c.via?.text)).toEqual(['${{ inputs.x || github.event.inputs.x }}']);
  });
});

// Networks of reusable calls, where the trace reaches a symbol along many paths. top.yml calls a workflow that can be
// called and dispatched and reads github.event.inputs.x: the shapes where telling a called workflow from a dispatched
// one could multiply the size of the trace.
describe('trace: size on networks of reusable calls', () => {
  const TOP = `${WF}/top.yml`;
  const MID = `${WF}/mid.yml`;
  const jobIds = (n: number) => Array.from({ length: n }, (_, i) => `j${i + 1}`);
  const outputsOf = (jobs: string[]) => jobs.map((j) => `\${{ needs.${j}.outputs.o }}`).join('');
  const count = (t: TraceNode): number => 1 + t.children.reduce((sum, c) => sum + count(c), 0);
  /** The most times one symbol is expanded (stopped nodes and dispatch inputs alone are not expanded). */
  const mostExpansions = (t: TraceNode) => {
    const times = new Map<string, number>();
    const visit = (n: TraceNode) => {
      if (!n.stop && (n.children.length > 0 || n.leaves.length > 0))
        times.set(n.symbol, (times.get(n.symbol) ?? 0) + 1);
      n.children.forEach(visit);
    };
    visit(t);
    return Math.max(...times.values());
  };
  const callTop = (callee: string) => yaml`
    on: pull_request
    jobs:
      m:
        uses: ./.github/workflows/${callee}.yml
        with:
          x: \${{ github.event.pull_request.title }}
  `;

  /** mid.yml's jobs j1..jN: each calls wK.yml with github.event.inputs.x and the outputs of every earlier job. */
  const chain = (n: number) =>
    jobIds(n).flatMap((id, k) => [
      `  ${id}:`,
      `    uses: ./.github/workflows/w${k + 1}.yml`,
      ...(k > 0 ? [`    needs: [${jobIds(k).join(', ')}]`] : []),
      `    with: { v: "\${{ github.event.inputs.x }}${outputsOf(jobIds(k))}" }`,
    ]);

  /** top.yml, and mid.yml with the jobs given; mid.yml's output is jobs.jN's. */
  const network = (n: number, jobs: string[]) => ({
    [TOP]: callTop('mid'),
    [MID]: `${yaml`
      on:
        workflow_call:
          inputs: { x: { type: string } }
          outputs: { o: { value: "\${{ jobs.j${n}.outputs.o }}" } }
        workflow_dispatch:
          inputs: { x: { type: string } }
      jobs:
    `}${jobs.join('\n')}\n`,
  });

  /** A reusable workflow with input v, whose output o is its job j's, made of the lines given. */
  const reusable = (job: string[]) =>
    yaml`
      on:
        workflow_call:
          inputs: { v: { type: string } }
          outputs: { o: { value: "\${{ jobs.j.outputs.o }}" } }
      jobs:
        j:
    ` + job.map((l) => `    ${l}\n`).join('');
  const echoes = reusable(['runs-on: x', 'outputs: { o: "${{ inputs.v }}" }', 'steps: [{ run: echo }]']);

  /** review2-B's gen-stress.py: each wK.yml echoes its input. */
  const stress = (n: number) => ({
    ...network(n, chain(n)),
    ...Object.fromEntries(jobIds(n).map((_, k) => [`${WF}/w${k + 1}.yml`, echoes])),
  });

  /** review3-B's gen-shared-callee.py: each wK.yml gets its output from lK.yml, which mid.yml also calls directly. */
  const sharedCallee = (n: number) => {
    const all = outputsOf(jobIds(n));
    const direct = jobIds(n).flatMap((_, k) => [
      `  z${k + 1}:`,
      `    uses: ./.github/workflows/l${k + 1}.yml`,
      `    needs: [${jobIds(n).join(', ')}]`,
      `    with: { v: "${all}" }`,
    ]);
    const wrapper = (k: number) =>
      reusable([`uses: ./.github/workflows/l${k}.yml`, 'with: { v: "${{ inputs.v }}" }']);
    return {
      ...network(n, [...chain(n), ...direct]),
      ...Object.fromEntries(
        jobIds(n).flatMap((_, k) => [
          [`${WF}/w${k + 1}.yml`, wrapper(k + 1)],
          [`${WF}/l${k + 1}.yml`, echoes],
        ]),
      ),
    };
  };

  /** review3-B's gen-action-stress.py: each wK.yml runs action aK, and mid.yml's job z runs every aK. */
  const sharedAction = (n: number) => {
    const uses = jobIds(n).flatMap((_, k) => [
      `      - uses: ./.github/actions/a${k + 1}`,
      `        with: { v: "${outputsOf(jobIds(n))}" }`,
    ]);
    const z = ['  z:', '    runs-on: x', `    needs: [${jobIds(n).join(', ')}]`, '    steps:', ...uses];
    const runs = (k: number) =>
      reusable([
        'runs-on: x',
        'outputs: { o: "${{ steps.s.outputs.o }}" }',
        'steps:',
        `  - { id: s, uses: ./.github/actions/a${k}, with: { v: "\${{ inputs.v }}" } }`,
      ]);
    const action = yaml`
      name: a
      description: d
      inputs: { v: { description: v } }
      outputs: { o: { description: o, value: "\${{ inputs.v }}" } }
      runs:
        using: composite
        steps: [{ shell: bash, run: echo }]
    `;
    return {
      ...network(n, [...chain(n), ...z]),
      ...Object.fromEntries(
        jobIds(n).flatMap((_, k) => [
          [`${WF}/w${k + 1}.yml`, runs(k + 1)],
          [`.github/actions/a${k + 1}/action.yml`, action],
        ]),
      ),
    };
  };

  /**
   * review3-B's gen-diamond.py: f-way diamonds k deep. top.yml calls w0.yml; each w<i>.yml calls a<i+1>_1..a<i+1>_f.yml,
   * each of which calls w<i+1>.yml, so f^k chains of calls reach w<k>.yml. Only w0.yml can be dispatched, and it passes
   * github.event.inputs.x on. With `every` (review4's gen-diamond-all.py and gen-diamond-only.py), every workflow can
   * be called and dispatched and passes that value on.
   */
  const diamond = (f: number, k: number, every?: string) => {
    const dispatch = '  workflow_dispatch:\n    inputs: { x: { type: string } }\n';
    const head = (i: number) =>
      `on:\n  workflow_call:\n    inputs: { x: { type: string } }\n    outputs: { o: { value: "\${{ jobs.out.outputs.o }}" } }\n${every || i === 0 ? dispatch : ''}jobs:\n`;
    const out = (o: string, needs: string[]) =>
      `  out:\n    runs-on: x\n${needs.length ? `    needs: [${needs.join(', ')}]\n` : ''}    outputs: { o: "${o}" }\n    steps: [{ run: echo }]\n`;
    const pass = (i: number) => every ?? (i === 0 ? '${{ github.event.inputs.x }}' : '${{ inputs.x }}');
    const calls = Array.from({ length: f }, (_, j) => `c${j + 1}`);
    const repo: Record<string, string> = { [TOP]: callTop('w0') };
    for (let i = 0; i <= k; i++) {
      const fanOut = calls.map(
        (c, j) => `  ${c}: { uses: ./.github/workflows/a${i + 1}_${j + 1}.yml, with: { x: "${pass(i)}" } }\n`,
      );
      repo[`${WF}/w${i}.yml`] =
        head(i) + (i < k ? fanOut.join('') + out(outputsOf(calls), calls) : out(pass(i), []));
      for (let j = 1; i < k && j <= f; j++)
        repo[`${WF}/a${i + 1}_${j}.yml`] =
          `${head(i + 1)}  c: { uses: ./.github/workflows/w${i + 1}.yml, with: { x: "${pass(i + 1)}" } }\n${out('${{ needs.c.outputs.o }}', ['c'])}`;
    }
    return repo;
  };

  // v0.2.0's node counts up from top.yml's job output at depths 12, 24, 36 and 48. Keeping track of the calls the trace
  // came through multiplied them: with the chain of calls in the expansion key, `diamond 2-4, all` gave 303 nodes at
  // depth 48, and larger diamonds grew as f^k.
  const shapes: [string, Record<string, string>, number[]][] = [
    ['stress 6', stress(6), [42, 42, 42, 42]],
    ['shared callee 3', sharedCallee(3), [23, 36, 36, 36]],
    ['shared action 3', sharedAction(3), [23, 36, 36, 36]],
    ['diamond 2-4', diamond(2, 4), [22, 44, 64, 64]],
    ['diamond 2-4, all', diamond(2, 4, '${{ inputs.x || github.event.inputs.x }}'), [22, 44, 64, 64]],
    ['diamond 2-4, only', diamond(2, 4, '${{ github.event.inputs.x }}'), [22, 44, 64, 64]],
  ];

  it.each(shapes)(
    'stays within twice v0.2.0’s size, each symbol expanded once up, at most twice down: %s',
    (_name, files, v020) => {
      const { index } = load(files);
      const sizes = [12, 24, 36, 48].map((maxDepth) => {
        const t = trace(index, sym.jobOutput(TOP, 'm', 'o'), { direction: 'up', maxDepth });
        expect(mostExpansions(t)).toBe(1);
        return count(t);
      });
      for (const [i, n] of sizes.entries()) expect(n).toBeLessThanOrEqual(2 * v020[i]!);
      const first = index.nodes.has(MID) ? MID : `${WF}/w0.yml`;
      expect(mostExpansions(trace(index, sym.input(first, 'x'), { maxDepth: 48 }))).toBeLessThanOrEqual(2);
    },
  );
});

// An input's default (#13) where a value reads the input only through github.event.inputs (#10).
describe('trace: input defaults and github.event.inputs', () => {
  const TOP = `${WF}/top.yml`;
  const C = `${WF}/c.yml`;
  const allLeaves = (t: TraceNode): string[] => [
    ...t.leaves.map((l) => `${l.role} ${l.where}: ${l.text}`),
    ...t.children.flatMap(allLeaves),
  ];

  it('leaves the default of an input a call omits out where it is read only through github.event.inputs', () => {
    const { index } = load({
      [TOP]: yaml`
        on: pull_request
        jobs:
          t:
            uses: ./.github/workflows/c.yml
      `,
      [C]: yaml`
        on:
          workflow_call:
            inputs:
              z: { type: string, default: from-call }
          workflow_dispatch:
            inputs:
              z: { type: string, default: from-dispatch }
        jobs:
          b:
            runs-on: x
            outputs:
              event: \${{ github.event.inputs.z }}
              input: \${{ inputs.z }}
            steps:
              - run: echo
      `,
    });
    const z = sym.input(C, 'z');
    // Through inputs.z: top.yml omits z, so z is its workflow_call default.
    const input = trace(index, sym.jobOutput(C, 'b', 'input'), { direction: 'up' });
    expect(allLeaves(input)).toContain(`literal ${C} › on.workflow_call.inputs.z.default: "from-call"`);
    // Through github.event.inputs.z: when c.yml is called, and its default applies, the read is top.yml's event; when
    // it is dispatched, the value entered. The dispatch input is shown alone, without the default of the call.
    const event = trace(index, sym.jobOutput(C, 'b', 'event'), { direction: 'up' });
    expect(event.children).toMatchObject([
      { symbol: z, via: { note: 'when dispatched' }, children: [], leaves: [] },
    ]);
    expect(allLeaves(event)).toEqual([`context ${C} › jobs.b: github.event.inputs.z`]);
  });
});
