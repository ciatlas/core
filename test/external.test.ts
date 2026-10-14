import { remoteKey } from '@ciatlas/core';
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
