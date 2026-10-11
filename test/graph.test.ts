import { type SiteField, sym } from '@flowpact/core';
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

describe('ProjectIndex', () => {
  const { index } = load(files);

  it('indexes call sites and data-flow edges', () => {
    expect(index.callSites.map((c) => `${c.caller.path}→${c.callee.path}`).sort()).toEqual([
      `${WF}/mid.yml→${WF}/leaf.yml`,
      `${WF}/root.yml→${WF}/mid.yml`,
    ]);
    const flows = index.edges.filter((e) => e.kind === 'flows').map((e) => `${e.from} → ${e.to}`);
    expect(flows).toContain(
      `${sym.input(`${WF}/root.yml`, 'config')} → ${sym.input(`${WF}/mid.yml`, 'cfg')}`,
    );
    expect(flows).toContain(
      `${sym.output(`${WF}/mid.yml`, 'result')} → ${sym.jobOutput(`${WF}/root.yml`, 'mid', 'result')}`,
    );
    expect(index.edges.filter((e) => e.kind === 'inherits')).toHaveLength(2);
  });

  it('records usages with their sink', () => {
    const [u] = index.usagesOf(sym.input(`${WF}/mid.yml`, 'cfg'));
    expect(u?.sink).toBe(sym.input(`${WF}/leaf.yml`, 'path'));
  });

  it('serializes deterministically', () => {
    const a = JSON.stringify(index.toJSON());
    const b = JSON.stringify(load(files).index.toJSON());
    expect(a).toBe(b);
    expect(index.toJSON()).toMatchSnapshot();
  });
});

const CALLER = `${WF}/caller.yml`;
const LIB = `${WF}/lib.yml`;
const PLAIN = `${WF}/plain.yml`;
const BUILD = '.github/actions/build';
const WRAP = '.github/actions/wrap';
const DEPLOY = 'acme/shared/.github/workflows/deploy.yml@v1';

/** A repository with reusable, plain, pinned and remote calls, and composite actions that use each other. */
const repo: Record<string, string> = {
  [CALLER]: yaml`
    name: Caller
    on:
      workflow_dispatch:
        inputs:
          level: { type: string }
    env:
      REGION: eu
    jobs:
      lib:
        uses: ./.github/workflows/lib.yml
        with:
          Name: \${{ inputs.level }}
          extra: \${{ inputs.level }}
        secrets: inherit
      plain:
        uses: ./.github/workflows/plain.yml
      pinned:
        uses: $/.github/workflows/lib.yml@v1
      remote:
        uses: ${DEPLOY}
        with:
          name: \${{ inputs.level }}
      build:
        needs: [lib]
        runs-on: x
        env:
          MODE: fast
        strategy:
          matrix:
            os: [linux]
            include:
              - os: mac
                arch: arm
        outputs:
          digest: \${{ steps.pack.outputs.artifact }}
        steps:
          - uses: actions/checkout@v4
          - id: pack
            uses: ./.github/actions/build
            with:
              target: \${{ matrix.os }}
          - uses: ./.github/actions/build
            with:
              target: x
          - uses: $/.github/actions/build@v1
          - run: echo \${{ vars.REGION }} \${{ needs.lib.outputs.out }}
  `,
  [LIB]: yaml`
    on:
      workflow_call:
        inputs:
          name: { type: string }
        secrets:
          TOKEN: {}
        outputs:
          out:
            value: \${{ jobs.j.outputs.o }}
    jobs:
      j:
        runs-on: x
        outputs:
          o: \${{ steps.s.outputs.o }}
        steps:
          - id: s
            run: echo "o=\${{ inputs.name }}" >> "$GITHUB_OUTPUT"
  `,
  [PLAIN]: yaml`
    on: push
    jobs:
      j:
        runs-on: x
        steps:
          - run: echo
  `,
  [`${BUILD}/action.yml`]: yaml`
    name: Build
    inputs:
      target: { required: true }
    outputs:
      artifact:
        value: \${{ steps.inner.outputs.path }}
    runs:
      using: composite
      steps:
        - id: inner
          uses: ./.github/actions/wrap
          with:
            dir: \${{ inputs.target }}
  `,
  [`${WRAP}/action.yml`]: yaml`
    inputs:
      dir: {}
    outputs:
      path:
        value: \${{ steps.w.outputs.p }}
    runs:
      using: composite
      steps:
        - id: w
          shell: bash
          run: echo "p=\${{ inputs.dir }}" >> "$GITHUB_OUTPUT"
  `,
};

/** 1-based line of the first line of `file` that contains `needle`. */
const lineOf = (file: string, needle: string) => {
  const lines = repo[file]!.split('\n');
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} not found in ${file}`);
  return i + 1;
};

describe('ProjectIndex: units, call sites and lookups', () => {
  const { index } = load(repo);
  const callerJob = (id: string) => index.project.workflows.get(CALLER)!.jobs[id]!;
  const callerStep = (i: number) => callerJob('build').steps[i]!;

  it('lists workflows before actions and finds a unit by path', () => {
    const units = index.units();
    expect(units.map((u) => u.kind)).toEqual(['workflow', 'workflow', 'workflow', 'action', 'action']);
    expect(units.map((u) => u.path).sort()).toEqual([BUILD, WRAP, CALLER, LIB, PLAIN].sort());
    expect(index.unit(LIB)?.kind).toBe('workflow');
    expect(index.unit(BUILD)?.kind).toBe('action');
    expect(index.unit(`${BUILD}/action.yml`)).toBeUndefined();
    expect(index.unit(`${WF}/missing.yml`)).toBeUndefined();
  });

  it('finds every expression site by id', () => {
    for (const unit of index.units()) for (const site of unit.sites) expect(index.site(site.id)).toBe(site);
    expect(index.site(-1)).toBeUndefined();
  });

  it('resolves only reusable workflows as callees, and any local workflow file as a target', () => {
    expect(index.calleeOf(callerJob('lib'))?.path).toBe(LIB);
    expect(index.targetOf(callerJob('lib'))?.path).toBe(LIB);
    // plain.yml has no `on.workflow_call`: the job points at it, but cannot call it.
    expect(index.targetOf(callerJob('plain'))?.path).toBe(PLAIN);
    expect(index.calleeOf(callerJob('plain'))).toBeUndefined();
    // `$/…@ref` is rejected by GitHub; remote workflows are not in the repository.
    expect(index.targetOf(callerJob('pinned'))).toBeUndefined();
    expect(index.targetOf(callerJob('remote'))).toBeUndefined();
    expect(index.targetOf(callerJob('build'))).toBeUndefined();
  });

  it('lists the call sites of a workflow and the steps that use an action', () => {
    expect(index.callersOf(LIB).map((c) => `${c.caller.path}#${c.job.id}`)).toEqual([`${CALLER}#lib`]);
    expect(index.callersOf(PLAIN)).toEqual([]);
    expect(index.usersOf(BUILD).map((u) => `${u.unit.path}#${u.job?.id}.${u.step.index}`)).toEqual([
      `${CALLER}#build.1`,
      `${CALLER}#build.2`,
    ]);
    const [wrap] = index.usersOf(WRAP);
    expect(wrap).toMatchObject({ unit: { path: BUILD }, step: { id: 'inner' }, action: { path: WRAP } });
    expect(wrap && 'job' in wrap).toBe(false);
  });

  it('resolves only local, unpinned actions', () => {
    expect(index.actionOf(callerStep(1))?.path).toBe(BUILD);
    expect(index.actionOf(callerStep(0))).toBeUndefined(); // actions/checkout
    expect(index.actionOf(callerStep(3))).toBeUndefined(); // $/…@v1
    expect(index.actionOf(callerStep(4))).toBeUndefined(); // run:
  });

  it('filters edges by direction and kind', () => {
    const lib = sym.job(CALLER, 'lib');
    expect(index.outgoing(lib).map((e) => `${e.kind} ${e.to}`)).toEqual([`calls ${LIB}`, `inherits ${LIB}`]);
    expect(index.outgoing(lib, 'inherits')).toMatchObject([
      {
        from: lib,
        to: LIB,
        kind: 'inherits',
        loc: { file: CALLER, line: lineOf(CALLER, 'secrets: inherit') },
      },
    ]);
    expect(index.incoming(LIB).map((e) => `${e.kind} ${e.from}`)).toEqual([
      `calls ${lib}`,
      `inherits ${lib}`,
    ]);
    expect(index.incoming(LIB, 'uses')).toEqual([]);
    expect(index.outgoing(sym.job(CALLER, 'plain'))).toEqual([]);
    expect(index.outgoing(sym.job(CALLER, 'pinned'))).toEqual([]);
  });
});

describe('ProjectIndex: symbols and edges', () => {
  const { index } = load(repo);
  const node = (id: string) => index.nodes.get(id);

  it('labels units by name, or by path', () => {
    expect(node(CALLER)).toMatchObject({ kind: 'workflow', label: 'Caller', unit: CALLER });
    expect(node(LIB)).toMatchObject({ kind: 'workflow', label: LIB });
    expect(node(BUILD)).toMatchObject({ kind: 'action', label: 'Build', unit: BUILD });
    expect(node(WRAP)).toMatchObject({ kind: 'action', label: WRAP });
  });

  it('declares inputs, secrets, outputs and env at their keys', () => {
    expect(node(sym.input(CALLER, 'level'))).toMatchObject({
      kind: 'input',
      label: 'inputs.level',
      loc: { file: CALLER, line: lineOf(CALLER, 'level:') },
    });
    expect(node(sym.secret(LIB, 'TOKEN'))).toMatchObject({ kind: 'secret', label: 'secrets.TOKEN' });
    expect(node(sym.output(LIB, 'out'))).toMatchObject({ kind: 'output', label: 'outputs.out' });
    expect(node(sym.env(CALLER, undefined, 'REGION'))).toMatchObject({
      kind: 'env',
      label: 'env.REGION',
      loc: { line: lineOf(CALLER, 'REGION: eu') },
    });
    expect(node(sym.env(CALLER, 'build', 'MODE'))).toMatchObject({
      kind: 'env',
      label: 'env.MODE',
      loc: { line: lineOf(CALLER, 'MODE: fast') },
    });
    expect(node(sym.input(BUILD, 'target'))).toMatchObject({ kind: 'input', unit: BUILD });
    expect(node(sym.output(WRAP, 'path'))).toMatchObject({
      kind: 'output',
      label: 'outputs.path',
      unit: WRAP,
    });
  });

  it('declares matrix keys at their first dimension or include entry', () => {
    expect(node(sym.matrix(CALLER, 'build', 'os'))).toMatchObject({
      kind: 'matrix',
      label: 'matrix.os',
      loc: { line: lineOf(CALLER, 'os: [linux]') },
    });
    expect(node(sym.matrix(CALLER, 'build', 'arch'))).toMatchObject({
      kind: 'matrix',
      loc: { line: lineOf(CALLER, 'arch: arm') },
    });
  });

  it('links jobs to the jobs they need', () => {
    expect(index.outgoing(sym.job(CALLER, 'build'), 'needs')).toMatchObject([
      { to: sym.job(CALLER, 'lib'), loc: { line: lineOf(CALLER, 'needs: [lib]'), column: 13 } },
    ]);
  });

  it('gives a reusable job the callee’s outputs, declared at the job', () => {
    const out = sym.jobOutput(CALLER, 'lib', 'out');
    expect(node(out)).toMatchObject({
      kind: 'job-output',
      label: 'jobs.lib.outputs.out',
      loc: { file: CALLER, line: lineOf(CALLER, '  lib:') },
    });
    expect(index.incoming(out)).toMatchObject([
      { from: sym.output(LIB, 'out'), kind: 'flows', loc: { file: LIB, line: lineOf(LIB, 'out:') } },
    ]);
    expect(index.jobOutputNames(index.project.workflows.get(CALLER)!.jobs.lib!)).toEqual(['out']);
    expect(index.jobOutputNames(index.project.workflows.get(CALLER)!.jobs.build!)).toEqual(['digest']);
  });

  it('records a remote workflow call as a call of a remote node', () => {
    expect(index.outgoing(sym.job(CALLER, 'remote'))).toMatchObject([
      { to: sym.remote(DEPLOY), kind: 'calls', loc: { line: lineOf(CALLER, DEPLOY) } },
    ]);
    expect(node(sym.remote(DEPLOY))).toEqual({ id: sym.remote(DEPLOY), kind: 'remote', label: DEPLOY });
    // Remote actions are not part of the graph.
    expect(node(sym.remote('actions/checkout@v4'))).toBeUndefined();
  });

  it('links steps to the actions they use, from the job or from the calling action', () => {
    expect(index.outgoing(sym.job(CALLER, 'build'), 'uses').map((e) => `${e.to} ${e.loc?.line}`)).toEqual([
      `${BUILD} ${lineOf(CALLER, 'uses: ./.github/actions/build')}`,
      `${BUILD} ${lineOf(CALLER, 'uses: ./.github/actions/build') + 3}`,
    ]);
    expect(index.outgoing(BUILD, 'uses')).toMatchObject([{ from: BUILD, to: WRAP }]);
  });

  it('gives a step with an id the outputs of its action', () => {
    const pack = sym.stepOutput(CALLER, 'build', 'pack', 'artifact');
    expect(node(pack)).toMatchObject({
      kind: 'step-output',
      label: 'steps.pack.outputs.artifact',
      unit: CALLER,
      // At the step's `id` key.
      loc: { line: lineOf(CALLER, 'id: pack'), column: 9 },
    });
    expect(index.incoming(pack, 'flows')).toMatchObject([{ from: sym.output(BUILD, 'artifact') }]);
    const inner = sym.stepOutput(BUILD, undefined, 'inner', 'path');
    expect(inner).toBe(`${BUILD}#steps.inner.outputs.path`);
    expect(node(inner)).toMatchObject({ kind: 'step-output', unit: BUILD });
    expect(index.incoming(inner, 'flows')).toMatchObject([{ from: sym.output(WRAP, 'path') }]);
    // The second use of the action has no id, so nothing can read its outputs.
    expect([...index.nodes.keys()].filter((k) => k.startsWith(`${CALLER}#jobs.build.steps.`))).toEqual([
      pack,
    ]);
  });

  it('adds a node for every symbol read but not declared', () => {
    expect(node(sym.var('REGION'))).toEqual({
      id: sym.var('REGION'),
      kind: 'var',
      label: 'vars.REGION',
      unit: CALLER,
    });
    expect(node(sym.stepOutput(LIB, 'j', 's', 'o'))).toEqual({
      id: sym.stepOutput(LIB, 'j', 's', 'o'),
      kind: 'unresolved',
      label: 'steps.s.outputs.o',
      unit: LIB,
    });
  });

  it('records each read with the symbol its value flows into', () => {
    const level = sym.input(CALLER, 'level');
    expect(index.usagesOf(level).map((u) => `${u.site.field}:${u.site.key} → ${u.sink ?? '-'}`)).toEqual([
      `job.with:Name → ${sym.input(LIB, 'name')}`,
      `job.with:extra → ${sym.input(LIB, 'extra')}`,
      'job.with:name → -',
    ]);
    const flows = index.outgoing(level, 'flows');
    expect(flows.map((e) => e.to)).toEqual([sym.input(LIB, 'name'), sym.input(LIB, 'extra')]);
    for (const e of flows) expect(index.site(e.siteId!)?.file).toBe(CALLER);
    expect(index.usagesOf(sym.output(LIB, 'out'))).toEqual([]);
    expect(index.usagesOf('nothing')).toEqual([]);
  });
});

const SINKS = `${WF}/sinks.yml`;

describe('ProjectIndex.sinkOf and stepOf', () => {
  const { index } = load({
    ...repo,
    [SINKS]: yaml`
      on: push
      env:
        TOP: \${{ vars.A }}
      jobs:
        call:
          uses: ./.github/workflows/lib.yml
          with:
            NAME: \${{ vars.A }}
            undeclared: \${{ vars.A }}
          secrets:
            token: \${{ secrets.MINE }}
            other: \${{ secrets.MINE }}
        plain:
          uses: ./.github/workflows/plain.yml
          with:
            x: \${{ vars.A }}
        remote:
          uses: ${DEPLOY}
          with:
            x: \${{ vars.A }}
          secrets:
            y: \${{ secrets.MINE }}
        steps:
          runs-on: x
          env:
            JOB: \${{ vars.A }}
          outputs:
            out: \${{ vars.A }}
          steps:
            - uses: actions/checkout@v4
            - uses: ./.github/actions/build
              with:
                Target: \${{ vars.A }}
                extra: \${{ vars.A }}
              env:
                STEP: \${{ vars.A }}
            - uses: actions/setup-node@v4
              with:
                node-version: \${{ vars.A }}
            - run: echo \${{ vars.A }}
    `,
  });
  const siteOf = (file: string, field: SiteField, key?: string, job?: string) => {
    const unit = index.unit(file)!;
    const site = unit.sites.find(
      (s) => s.field === field && s.key === key && (job === undefined || s.job === job),
    );
    if (!site) throw new Error(`no ${field} ${key} site in ${file}`);
    return { unit, site };
  };
  const sink = (file: string, field: SiteField, key?: string, job?: string) => {
    const { unit, site } = siteOf(file, field, key, job);
    return index.sinkOf(unit, site);
  };

  it.each([
    ['a reusable call’s input, by its declared case', 'job.with', 'NAME', 'call', sym.input(LIB, 'name')],
    ['an undeclared input, as written', 'job.with', 'undeclared', 'call', sym.input(LIB, 'undeclared')],
    [
      'a reusable call’s secret, by its declared case',
      'job.secrets',
      'token',
      'call',
      sym.secret(LIB, 'TOKEN'),
    ],
    ['an undeclared secret, as written', 'job.secrets', 'other', 'call', sym.secret(LIB, 'other')],
    [
      'a local action’s input, by its declared case',
      'step.with',
      'Target',
      'steps',
      sym.input(BUILD, 'target'),
    ],
    ['an undeclared action input, as written', 'step.with', 'extra', 'steps', sym.input(BUILD, 'extra')],
    ['a job output', 'job.output', 'out', 'steps', sym.jobOutput(SINKS, 'steps', 'out')],
    ['a workflow env variable', 'workflow.env', 'TOP', undefined, sym.env(SINKS, undefined, 'TOP')],
    ['a job env variable', 'job.env', 'JOB', 'steps', sym.env(SINKS, 'steps', 'JOB')],
  ] as const)('a value defines %s', (_, field, key, job, expected) => {
    expect(sink(SINKS, field, key, job)).toBe(expected);
  });

  it('defines workflow and action outputs', () => {
    expect(sink(LIB, 'workflow.output', 'out')).toBe(sym.output(LIB, 'out'));
    expect(sink(BUILD, 'action.output', 'artifact')).toBe(sym.output(BUILD, 'artifact'));
  });

  it.each([
    ['inputs of a workflow that is not reusable', 'job.with', 'x', 'plain'],
    ['inputs of a remote workflow', 'job.with', 'x', 'remote'],
    ['secrets of a remote workflow', 'job.secrets', 'y', 'remote'],
    ['inputs of a remote action', 'step.with', 'node-version', 'steps'],
    ['step env, which nothing reads by name', 'step.env', 'STEP', 'steps'],
    ['a script, which has no key', 'step.run', undefined, 'steps'],
  ] as const)('a value defines nothing for %s', (_, field, key, job) => {
    expect(sink(SINKS, field, key, job)).toBeUndefined();
  });

  it('finds the step a site is in, in a job or in an action', () => {
    const { unit, site } = siteOf(SINKS, 'step.with', 'Target');
    expect(index.stepOf(unit, site)).toBe(index.project.workflows.get(SINKS)!.jobs.steps!.steps[1]);
    const action = siteOf(BUILD, 'step.with', 'dir');
    expect(index.stepOf(action.unit, action.site)?.id).toBe('inner');
    const job = siteOf(SINKS, 'job.env', 'JOB');
    expect(index.stepOf(job.unit, job.site)).toBeUndefined();
  });

  it('adds a flows edge from what a value reads to what it defines', () => {
    expect(index.outgoing(sym.secret(SINKS, 'MINE'), 'flows').map((e) => e.to)).toEqual([
      sym.secret(LIB, 'TOKEN'),
      sym.secret(LIB, 'other'),
    ]);
  });
});

const MAIN = `${WF}/main.yml`;
const CALLED = `${WF}/called.yml`;

/** One workflow reading every context, a reusable workflow, and composite actions that read their steps. */
const flowFiles = {
  [MAIN]: yaml`
    on:
      workflow_dispatch:
        inputs:
          Config: { type: string }
          LEVEL: { type: string }
      workflow_call:
        inputs:
          level: { type: string }
        secrets:
          TOKEN: {}
        outputs:
          first:
            value: \${{ jobs.BUILD.outputs.DIGEST }}
          whole:
            value: \${{ toJSON(jobs.build.outputs) }}
          every:
            value: \${{ toJSON(jobs) }}
          unknown:
            value: \${{ jobs.nope.outputs.x }}
    env:
      SHARED: workflow
      TOP: workflow
    jobs:
      build:
        runs-on: x
        env:
          SHARED: job
        strategy:
          matrix:
            os: [linux]
        outputs:
          digest: \${{ steps.META.outputs.Artifact }}
          tag: \${{ steps.sh.outputs.v }}
          all: \${{ toJSON(steps) }}
        steps:
          - uses: actions/checkout@v4
          - id: sh
            run: echo "v=1" >> "$GITHUB_OUTPUT"
          - id: meta
            uses: ./.github/actions/build
            with:
              target: \${{ inputs.CONFIG }} \${{ inputs.Level }} \${{ github.event.inputs.config }} \${{ matrix.os }}
          - run: echo '\${{ toJSON(steps) }}' '\${{ steps.meta.outputs }}' '\${{ steps.sh.outputs }}' \${{ steps.meta.conclusion }} \${{ steps.nope.outputs.x }} '\${{ toJSON(steps.*.outputs.Artifact) }}' \${{ env.STEP }}
            env:
              STEP: x
          - run: echo \${{ env.SHARED }} \${{ env.TOP }} \${{ secrets.token }} \${{ secrets.GITHUB_TOKEN }} \${{ vars.REGION }} \${{ runner.os }} \${{ github.sha }}
          - id: late
            uses: ./.github/actions/build
      call:
        uses: ./.github/workflows/called.yml
      use:
        needs: [build, call]
        if: \${{ jobs.build.outputs.digest != '' }}
        runs-on: x
        steps:
          - run: echo \${{ needs.build.outputs.Digest }} \${{ needs.CALL.outputs.RESULT }} \${{ needs.nope.outputs.x }} \${{ needs.build.result }} \${{ env.SHARED }}
          - run: echo '\${{ toJSON(needs.build.outputs) }}' '\${{ needs.build }}' '\${{ needs.call.outputs }}' '\${{ toJSON(needs) }}' \${{ needs.build.outputs[matrix.k] }} '\${{ toJSON(needs.*.outputs.DIGEST) }}'
  `,
  [CALLED]: yaml`
    on:
      workflow_call:
        outputs:
          Result:
            value: \${{ jobs.j.outputs.r }}
    jobs:
      j:
        runs-on: x
        outputs:
          r: x
        steps:
          - run: echo \${{ github.event.inputs.config }} \${{ inputs[matrix.os] }} \${{ toJSON(inputs) }} \${{ vars[matrix.os] }} \${{ secrets.ANY }}
  `,
  [`${BUILD}/action.yml`]: yaml`
    name: Build
    inputs:
      target: {}
    outputs:
      artifact:
        value: \${{ steps.pack.outputs.path }}
      all:
        value: \${{ toJSON(steps) }}
    runs:
      using: composite
      steps:
        - id: pack
          shell: bash
          run: echo "path=\${{ inputs.TARGET }}" >> "$GITHUB_OUTPUT"
        - id: inner
          uses: ./.github/actions/wrap
        - shell: bash
          run: echo '\${{ steps.inner.outputs }}' \${{ steps.inner.outputs.P }} \${{ secrets.X }} \${{ env.TOP }} \${{ matrix.os }} \${{ needs.build.outputs.x }} \${{ toJSON(needs) }}
  `,
  [`${WRAP}/action.yml`]: yaml`
    outputs:
      p:
        value: x
    runs:
      using: composite
      steps:
        - shell: bash
          run: echo
  `,
};

interface Where {
  field?: SiteField;
  job?: string;
}

describe('ProjectIndex.resolveRef and readsOf', () => {
  const { index } = load(flowFiles);
  /** The reference spelled `text` (its context and path joined by dots, `?` for a computed index) in `file`. */
  const refAt = (file: string, text: string, where: Where = {}) => {
    const unit = index.unit(file)!;
    for (const site of unit.sites) {
      if (where.field && site.field !== where.field) continue;
      if (where.job && site.job !== where.job) continue;
      for (const seg of site.segments)
        for (const ref of seg.refs)
          if ([ref.context, ...ref.path].join('.') === text) return { unit, site, ref };
    }
    throw new Error(`${text} is not read in ${file}`);
  };
  const resolve = (file: string, text: string, where?: Where) => {
    const { unit, site, ref } = refAt(file, text, where);
    return index.resolveRef(unit, site, ref);
  };
  const reads = (file: string, text: string, where?: Where) => {
    const { unit, site, ref } = refAt(file, text, where);
    return index.readsOf(unit, site, ref);
  };
  const build = (name: string) => sym.jobOutput(MAIN, 'build', name);
  const meta = (name: string) => sym.stepOutput(MAIN, 'build', 'meta', name);
  const late = (name: string) => sym.stepOutput(MAIN, 'build', 'late', name);

  it.each([
    ['a dispatch input, by its declared case', MAIN, 'inputs.CONFIG', {}, sym.input(MAIN, 'Config')],
    // `level` (workflow_call) and `LEVEL` (workflow_dispatch) are the same input; the call's spelling names it.
    ['a workflow_call input before a dispatch one', MAIN, 'inputs.Level', {}, sym.input(MAIN, 'level')],
    ['an action input', BUILD, 'inputs.TARGET', {}, sym.input(BUILD, 'target')],
    [
      'github.event.inputs of a dispatched workflow',
      MAIN,
      'github.event.inputs.config',
      {},
      sym.input(MAIN, 'Config'),
    ],
    ['a declared secret, by its declared case', MAIN, 'secrets.token', {}, sym.secret(MAIN, 'TOKEN')],
    ['an undeclared secret, as written', MAIN, 'secrets.GITHUB_TOKEN', {}, sym.secret(MAIN, 'GITHUB_TOKEN')],
    ['a secret of a workflow without secrets', CALLED, 'secrets.ANY', {}, sym.secret(CALLED, 'ANY')],
    ['a variable', MAIN, 'vars.REGION', {}, sym.var('REGION')],
    ['a matrix key of the reading job', MAIN, 'matrix.os', {}, sym.matrix(MAIN, 'build', 'os')],
    ['a matrix key the job does not declare', MAIN, 'matrix.k', {}, sym.matrix(MAIN, 'use', 'k')],
    ['a job output through needs', MAIN, 'needs.build.outputs.Digest', {}, build('digest')],
    [
      'a reusable job output, by the callee output case',
      MAIN,
      'needs.CALL.outputs.RESULT',
      {},
      sym.jobOutput(MAIN, 'call', 'Result'),
    ],
    ['a job output in a workflow output', MAIN, 'jobs.BUILD.outputs.DIGEST', {}, build('digest')],
    [
      'an action step output, by its declared case',
      MAIN,
      'steps.META.outputs.Artifact',
      {},
      meta('artifact'),
    ],
    [
      'a script step output, as written',
      MAIN,
      'steps.sh.outputs.v',
      {},
      sym.stepOutput(MAIN, 'build', 'sh', 'v'),
    ],
    [
      'a step output in an action',
      BUILD,
      'steps.inner.outputs.P',
      {},
      sym.stepOutput(BUILD, undefined, 'inner', 'p'),
    ],
    // Both declare `SHARED` in the same case: on Linux and macOS runners env names are case-sensitive, so a job
    // `shared` would not shadow the workflow's `SHARED` there. That case question is not what this row tests.
    [
      'the job’s env before the workflow’s',
      MAIN,
      'env.SHARED',
      { job: 'build' },
      sym.env(MAIN, 'build', 'SHARED'),
    ],
    ['the workflow’s env', MAIN, 'env.SHARED', { job: 'use' }, sym.env(MAIN, undefined, 'SHARED')],
    ['the workflow’s env from a job with env', MAIN, 'env.TOP', {}, sym.env(MAIN, undefined, 'TOP')],
  ] as const)('resolves %s', (_, file, text, where, expected) => {
    expect(resolve(file, text, where)).toBe(expected);
  });

  it.each([
    ['a computed input', CALLED, 'inputs.?', {}],
    ['the whole inputs object', CALLED, 'inputs', {}],
    ['github.event.inputs without workflow_dispatch', CALLED, 'github.event.inputs.config', {}],
    ['other github properties', MAIN, 'github.sha', {}],
    ['secrets in an action', BUILD, 'secrets.X', {}],
    ['a computed variable', CALLED, 'vars.?', {}],
    ['matrix outside a job', BUILD, 'matrix.os', {}],
    ['needs of an unknown job', MAIN, 'needs.nope.outputs.x', {}],
    ['needs that name no output', MAIN, 'needs.build.result', {}],
    ['a whole outputs object', MAIN, 'needs.build.outputs', {}],
    ['a computed output name', MAIN, 'needs.build.outputs.?', {}],
    ['needs in an action', BUILD, 'needs.build.outputs.x', {}],
    ['jobs outside a workflow output', MAIN, 'jobs.build.outputs.digest', { field: 'job.if' }],
    ['jobs of an unknown job', MAIN, 'jobs.nope.outputs.x', {}],
    ['steps of an unknown step', MAIN, 'steps.nope.outputs.x', {}],
    ['steps that name no output', MAIN, 'steps.meta.conclusion', {}],
    ['a step’s own env, which is not declared in the graph', MAIN, 'env.STEP', {}],
    ['env in an action', BUILD, 'env.TOP', {}],
    ['runtime contexts', MAIN, 'runner.os', {}],
  ] as const)('resolves nothing for %s', (_, file, text, where) => {
    expect(resolve(file, text, where)).toBeUndefined();
  });

  it.each([
    ['a resolved reference reads its one symbol', MAIN, 'needs.build.outputs.Digest', {}, [build('digest')]],
    [
      'toJSON(needs.build.outputs) reads every output',
      MAIN,
      'needs.build.outputs',
      {},
      ['digest', 'tag', 'all'].map(build),
    ],
    ['needs.build reads every output', MAIN, 'needs.build', {}, ['digest', 'tag', 'all'].map(build)],
    [
      'a computed output name reads every output',
      MAIN,
      'needs.build.outputs.?',
      {},
      ['digest', 'tag', 'all'].map(build),
    ],
    ['needs.build.result reads no output', MAIN, 'needs.build.result', {}, []],
    [
      'an output of every needed job reads it where it exists',
      MAIN,
      'needs.*.outputs.DIGEST',
      {},
      [build('digest')],
    ],
    [
      'an output of every earlier step reads it where it exists',
      MAIN,
      'steps.*.outputs.Artifact',
      {},
      [meta('artifact')],
    ],
    ['needs of an unknown job reads nothing', MAIN, 'needs.nope.outputs.x', {}, []],
    [
      'a reusable job’s outputs object reads the callee’s outputs',
      MAIN,
      'needs.call.outputs',
      {},
      [sym.jobOutput(MAIN, 'call', 'Result')],
    ],
    [
      'toJSON(needs) reads the outputs of each job the reader needs',
      MAIN,
      'needs',
      {},
      [...['digest', 'tag', 'all'].map(build), sym.jobOutput(MAIN, 'call', 'Result')],
    ],
    [
      'toJSON(jobs.build.outputs) in a workflow output reads every output',
      MAIN,
      'jobs.build.outputs',
      {},
      ['digest', 'tag', 'all'].map(build),
    ],
    [
      'toJSON(jobs) in a workflow output reads every job’s outputs',
      MAIN,
      'jobs',
      {},
      [...['digest', 'tag', 'all'].map(build), sym.jobOutput(MAIN, 'call', 'Result')],
    ],
    [
      'jobs outside a workflow output reads nothing',
      MAIN,
      'jobs.build.outputs.digest',
      { field: 'job.if' },
      [],
    ],
    ['needs in an action reads nothing', BUILD, 'needs', {}, []],
    [
      'a step’s outputs object reads its action’s outputs',
      MAIN,
      'steps.meta.outputs',
      {},
      [meta('artifact'), meta('all')],
    ],
    ['a script step’s outputs object reads nothing declared', MAIN, 'steps.sh.outputs', {}, []],
    ['steps naming no output read nothing', MAIN, 'steps.meta.conclusion', {}, []],
    [
      'toJSON(steps) in a step reads the steps before it',
      MAIN,
      'steps',
      { field: 'step.run' },
      [meta('artifact'), meta('all')],
    ],
    [
      'toJSON(steps) in a job output reads every step',
      MAIN,
      'steps',
      { field: 'job.output' },
      [meta('artifact'), meta('all'), late('artifact'), late('all')],
    ],
    [
      'an action step’s outputs object, in an action',
      BUILD,
      'steps.inner.outputs',
      {},
      [sym.stepOutput(BUILD, undefined, 'inner', 'p')],
    ],
    [
      'toJSON(steps) in an action output reads every step',
      BUILD,
      'steps',
      {},
      [sym.stepOutput(BUILD, undefined, 'inner', 'p')],
    ],
    ['a runtime context reads nothing', MAIN, 'runner.os', {}, []],
  ] as const)('%s', (_, file, text, where, expected) => {
    expect(reads(file, text, where)).toEqual(expected);
  });

  it('records a usage of each output a whole-object read reads, flowing into the workflow outputs', () => {
    const usages = index.usagesOf(build('digest'));
    expect(
      usages.map((u) => `${u.site.field}:${u.site.key ?? ''} ${[u.ref.context, ...u.ref.path].join('.')}`),
    ).toEqual([
      'workflow.output:first jobs.BUILD.outputs.DIGEST',
      'workflow.output:whole jobs.build.outputs',
      'workflow.output:every jobs',
      'step.run: needs.build.outputs.Digest',
      'step.run: needs.build.outputs',
      'step.run: needs.build',
      'step.run: needs',
      'step.run: needs.build.outputs.?',
      'step.run: needs.*.outputs.DIGEST',
    ]);
    expect(index.outgoing(build('digest'), 'flows').map((e) => e.to)).toEqual([
      sym.output(MAIN, 'first'),
      sym.output(MAIN, 'whole'),
      sym.output(MAIN, 'every'),
    ]);
    // A read of `needs.<job>.result` names the job, not its outputs.
    expect(index.usagesOf(build('tag')).some((u) => u.ref.path.includes('result'))).toBe(false);
  });

  it('lists a reusable job’s outputs from its callee', () => {
    const jobs = index.project.workflows.get(MAIN)!.jobs;
    expect(index.jobOutputNames(jobs.call!)).toEqual(['Result']);
    expect(index.jobOutputNames(jobs.build!)).toEqual(['digest', 'tag', 'all']);
    expect(index.jobOutputNames(jobs.use!)).toEqual([]);
  });

  // Suspected bug in graph.ts: a step's own `env:` shadows the job's (and the workflow's) in that step's `with:` and
  // `run:`, but resolveRef('env') never looks at the step, so the step below is recorded as reading the job's MODE.
  // Skipped until step env is modeled; the step's MODE is not a graph symbol, so the read should resolve to nothing.
  it.skip('does not resolve env a step redefines to the job’s variable', () => {
    const E = `${WF}/shadow.yml`;
    const { index: shadow } = load({
      [E]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            env:
              MODE: job
            steps:
              - run: echo \${{ env.MODE }}
                env:
                  MODE: step
      `,
    });
    expect(shadow.usagesOf(sym.env(E, 'a', 'MODE'))).toEqual([]);
  });
});
