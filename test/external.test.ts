import { type JobDecl, remoteKey, type WorkflowDecl } from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { load, WF, yaml } from './helpers';

// Remote interfaces (ciatlas/flowpact#152): a remote reusable workflow or action, made from its interface alone.
describe('external units', () => {
  const DEPLOY = 'Octo/Ship/.github/workflows/deploy.yml@v1';
  const SETUP = 'octo/setup@v2';
  const { project, index } = load(
    {
      [`${WF}/ci.yml`]: yaml`
        on: push
        jobs:
          deploy:
            uses: octo/ship/.github/workflows/deploy.yml@v1
            with: { env: prod }
          other:
            uses: octo/ship/.github/workflows/other.yml@v1
          build:
            runs-on: x
            steps:
              - uses: octo/setup@v2
                with: { version: 20 }
              - uses: octo/unknown@v1
      `,
    },
    {
      remotes: [
        {
          ref: DEPLOY,
          kind: 'workflow',
          text: 'on:\n  workflow_call:\n    inputs:\n      env: { type: string, required: true }\n    outputs:\n      url: { value: x }\n',
        },
        {
          ref: SETUP,
          kind: 'action',
          text: 'name: setup\ninputs:\n  version: { required: true }\noutputs:\n  path: { description: p }\nruns:\n  using: node24\n  main: i.js\n',
        },
      ],
    },
  );
  const wf = project.workflows.get(`${WF}/ci.yml`)!;

  it('resolves a remote reference to its interface, matching the owner and repository in any case', () => {
    const callee = index.interfaceOf(wf.jobs.deploy!);
    expect(callee).toMatchObject({ external: true, path: DEPLOY, kind: 'workflow' });
    expect(Object.keys(callee!.call!.inputs)).toEqual(['env']);
    expect(Object.keys(callee!.call!.outputs)).toEqual(['url']);
    const action = index.actionInterfaceOf(wf.jobs.build!.steps[0]!);
    expect(action).toMatchObject({ external: true, path: SETUP, kind: 'action' });
    expect(Object.keys(action!.inputs)).toEqual(['version']);
    expect(remoteKey(' Octo/Ship/.github/workflows/deploy.yml@v1')).toBe(
      'octo/ship/.github/workflows/deploy.yml@v1',
    );
  });

  it('gives no interface for a reference it has none for', () => {
    expect(index.interfaceOf(wf.jobs.other!)).toBeUndefined();
    expect(index.actionInterfaceOf(wf.jobs.build!.steps[1]!)).toBeUndefined();
  });

  it('keeps external units out of everything that follows a call', () => {
    expect(index.calleeOf(wf.jobs.deploy!)).toBeUndefined();
    expect(index.actionOf(wf.jobs.build!.steps[0]!)).toBeUndefined();
    expect(index.units().map((u) => u.path)).toEqual([`${WF}/ci.yml`]);
    expect(index.callSites).toEqual([]);
    expect(index.actionUses).toEqual([]);
    expect([...project.workflows.keys(), ...project.actions.keys()]).toEqual([`${WF}/ci.yml`]);
  });

  it('leaves a project without remotes as it was', () => {
    expect(load({ [`${WF}/ci.yml`]: 'on: push\njobs: {}\n' }).project.external).toBeUndefined();
  });
});

// A full body: a remote parsed as its own repository's (ciatlas/simulci M4).
describe('external units with a full body', () => {
  const SHA = 'a'.repeat(40);
  const DEPLOY = 'Octo/Ship/.github/workflows/deploy.yml@v1';
  const BUILD = 'octo/build@v2';
  const local = {
    [`${WF}/ci.yml`]: yaml`
      on: push
      jobs:
        deploy:
          uses: octo/ship/.github/workflows/deploy.yml@v1
        inner:
          uses: ./.github/workflows/inner.yml
        build:
          runs-on: x
          steps:
            - uses: octo/build@v2
            - uses: ./.github/actions/x
    `,
    // The caller's own files at the paths the remotes use: nothing in a remote may bind to them.
    [`${WF}/inner.yml`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    '.github/actions/x/action.yml':
      'name: x\nruns:\n  using: composite\n  steps: [{ run: x, shell: bash }]\n',
  };
  const remotes = [
    {
      ref: DEPLOY,
      kind: 'workflow' as const,
      sha: SHA,
      text: yaml`
        on:
          workflow_call:
            outputs:
              url: { value: "\${{ jobs.ship.outputs.url }}" }
        jobs:
          relative:
            uses: ./.github/workflows/inner.yml
          same:
            uses: OCTO/ship/.github/workflows/inner.yml@main
          caller:
            uses: acme/repo/.github/workflows/inner.yml@v1
          ship:
            runs-on: x
            outputs:
              url: \${{ steps.go.outputs.url }}
            steps:
              - uses: octo/ship/.github/actions/x@v1
              - uses: ./.github/actions/x
              - id: go
                run: echo "url=\${{ github.sha }}" >> "$GITHUB_OUTPUT"
      `,
    },
    {
      ref: BUILD,
      kind: 'action' as const,
      text: yaml`
        name: build
        runs:
          using: composite
          steps:
            - uses: octo/build/sub@v2
            - uses: acme/repo/.github/actions/x@v1
            - run: echo "\${{ github.ref }}"
              shell: bash
      `,
    },
  ];
  const { project, index } = load(local, { remotes });
  const deploy = project.external!.get(remoteKey(DEPLOY)) as WorkflowDecl;
  const build = project.external!.get(remoteKey(BUILD))!;
  const jobs = deploy.jobs as Record<string, JobDecl>;

  it('keeps the jobs and steps of a full body, and where it comes from', () => {
    expect(Object.keys(jobs)).toEqual(['relative', 'same', 'caller', 'ship']);
    expect(jobs.ship!.steps).toHaveLength(3);
    expect(build.kind === 'action' && build.steps).toHaveLength(3);
    expect(deploy.origin).toEqual({
      owner: 'Octo',
      repo: 'Ship',
      path: '.github/workflows/deploy.yml',
      ref: 'v1',
      sha: SHA,
    });
    expect(build.origin).toEqual({ owner: 'octo', repo: 'build', path: '', ref: 'v2' });
  });

  it("resolves a remote's same-repository references against its own repository, not the caller's", () => {
    expect(jobs.relative!.uses).toMatchObject({ kind: 'local-workflow', target: `${WF}/inner.yml` });
    expect(jobs.same!.uses).toMatchObject({
      kind: 'local-workflow',
      target: `${WF}/inner.yml`,
      sameRepoRef: 'main',
    });
    expect(jobs.caller!.uses).toMatchObject({ kind: 'remote-workflow' });
    expect(jobs.ship!.steps[0]!.uses).toMatchObject({
      kind: 'local-action',
      target: '.github/actions/x',
      sameRepoRef: 'v1',
    });
    expect(jobs.ship!.steps[1]!.uses).toMatchObject({ kind: 'local-action', target: '.github/actions/x' });
    const steps = build.kind === 'action' ? build.steps : [];
    expect(steps[0]!.uses).toMatchObject({ kind: 'local-action', target: 'sub', sameRepoRef: 'v2' });
    expect(steps[1]!.uses).toMatchObject({ kind: 'remote-action' });
  });

  it("never binds a remote's references to the caller's files", () => {
    for (const job of Object.values(jobs)) {
      expect(index.targetOf(job)).toBeUndefined();
      expect(index.calleeOf(job)).toBeUndefined();
      expect(index.interfaceOf(job)).toBeUndefined();
      for (const step of job.steps) expect(index.actionOf(step)).toBeUndefined();
    }
    for (const step of build.kind === 'action' ? build.steps : []) {
      expect(index.actionOf(step)).toBeUndefined();
      expect(index.actionInterfaceOf(step)).toBeUndefined();
    }
    // The caller's own references to the same paths still resolve.
    const ci = project.workflows.get(`${WF}/ci.yml`)!;
    expect(index.calleeOf(ci.jobs.inner!)?.path).toBe(`${WF}/inner.yml`);
    expect(index.actionOf(ci.jobs.build!.steps[1]!)?.path).toBe('.github/actions/x');
    expect(index.interfaceOf(ci.jobs.deploy!)).toBe(deploy);
    expect(index.actionInterfaceOf(ci.jobs.build!.steps[0]!)).toBe(build);
    expect(index.callSites.map((c) => c.callee.path)).toEqual([`${WF}/inner.yml`]);
    expect(index.units().map((u) => u.path)).toEqual([
      `${WF}/ci.yml`,
      `${WF}/inner.yml`,
      '.github/actions/x',
    ]);
  });

  it('keeps site ids unique across the project and its external units', () => {
    const ids = [...index.units(), deploy, build].flatMap((u) => u.sites.map((s) => s.id));
    expect(deploy.sites.length).toBeGreaterThan(0);
    expect(build.sites.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives a remote that names no repository and ref no origin and no repository of its own', () => {
    const { project } = load(
      { [`${WF}/ci.yml`]: 'on: push\njobs: {}\n' },
      {
        remotes: [
          {
            ref: 'octo/ship',
            kind: 'workflow',
            text: 'on: workflow_call\njobs:\n  j:\n    uses: acme/repo/.github/workflows/x.yml@v1\n',
          },
        ],
      },
    );
    const unit = project.external!.get('octo/ship') as WorkflowDecl;
    expect(unit.origin).toBeUndefined();
    expect(unit.jobs.j!.uses).toMatchObject({ kind: 'remote-workflow' });
  });

  it('stops at an alias bomb in a remote body with a parse error', () => {
    const lines = ['on: workflow_call', 'env:', '  L0: &l0 ["${{ github.sha }}", "x"]'];
    for (let i = 1; i <= 24; i++) lines.push(`  L${i}: &l${i} [*l${i - 1}, *l${i - 1}]`);
    lines.push('jobs:', '  j:', '    runs-on: x', '    steps: [{ run: x }]');
    const started = performance.now();
    const { project } = load(
      { [`${WF}/ci.yml`]: 'on: push\njobs: {}\n' },
      { remotes: [{ ref: DEPLOY, kind: 'workflow', text: `${lines.join('\n')}\n` }] },
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    const unit = project.external!.get(remoteKey(DEPLOY))!;
    expect(unit.parseErrors.map((d) => `${d.loc.line}:${d.loc.column} ${d.message}`)).toEqual([
      '18:14 YAML aliases expand to more than 50000 nodes; the file is not analyzed (possible alias bomb)',
    ]);
  });
});
