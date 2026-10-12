import {
  BUILTIN_SECRETS,
  chainTo,
  isCallOnly,
  readsContextDynamically,
  refsOf,
  secretsNeededBy,
  type WorkflowDecl,
} from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { load, WF, yaml } from './helpers';

/** The one workflow of a repository. */
const workflow = (text: string): WorkflowDecl =>
  load({ [`${WF}/w.yml`]: text }).project.workflows.get(`${WF}/w.yml`)!;

/** A workflow whose only step echoes `expr`. */
const reading = (expr: string) =>
  workflow(yaml`
    on: push
    jobs:
      j:
        runs-on: x
        steps:
          - run: echo \${{ ${expr} }}
  `);

describe('refsOf', () => {
  it('yields every reference of every site, with its site', () => {
    const wf = workflow(yaml`
      on: push
      jobs:
        j:
          if: inputs.a
          runs-on: x
          steps:
            - run: echo \${{ inputs.b }} \${{ format('{0}', env.C, matrix.d) }}
    `);
    expect(
      [...refsOf(wf)].map(({ site, ref }) => `${site.field} ${ref.context}.${ref.path.join('.')}`),
    ).toEqual(['job.if inputs.a', 'step.run inputs.b', 'step.run env.C', 'step.run matrix.d']);
  });

  it('yields nothing for a unit without expressions', () => {
    expect([...refsOf(reading("'x'"))]).toEqual([]);
  });
});

describe('readsContextDynamically', () => {
  it.each([
    ['toJSON(inputs)', 'inputs', true],
    ['inputs[matrix.k]', 'inputs', true],
    ['inputs.name', 'inputs', false],
    ['toJSON(inputs)', 'secrets', false],
    // `github.event` holds the dispatch inputs of the triggering workflow.
    ['toJSON(github.event)', 'inputs', true],
    ['toJSON(github.event.inputs)', 'inputs', true],
    ['github.event.inputs[matrix.k]', 'inputs', true],
    ['github.event.inputs.name', 'inputs', false],
    ['github.event.pull_request.title', 'inputs', false],
    ['toJSON(github.event)', 'secrets', false],
    ['secrets[matrix.k]', 'secrets', true],
    ['toJSON(secrets)', 'secrets', true],
    // A computed read of outputs that names its job or step reads each output of that job or step.
    ['needs.build.outputs[matrix.k]', 'needs', false],
    ['steps.s.outputs[matrix.k]', 'steps', false],
    ['jobs.build.outputs[matrix.k]', 'jobs', false],
    ['needs[matrix.j].outputs.v', 'needs', true],
    ['needs.*.outputs[matrix.k]', 'needs', true],
    ['toJSON(needs)', 'needs', true],
    ['toJSON(steps)', 'steps', true],
  ])('%s reads %s dynamically: %s', (expr, context, expected) => {
    expect(readsContextDynamically(reading(expr), context)).toBe(expected);
  });

  it('assumes any read when an expression or the file does not parse', () => {
    expect(readsContextDynamically(reading('inputs.a =='), 'inputs')).toBe(true);
    const broken = workflow(
      'on: push\non: pull_request\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo\n',
    );
    expect(broken.parseErrors).not.toEqual([]);
    expect(readsContextDynamically(broken, 'secrets')).toBe(true);
  });
});

describe('isCallOnly', () => {
  it.each([
    ['on: workflow_call', true],
    ['on:\n  workflow_call:\n    inputs:\n      a: { type: string }', true],
    ['on: [workflow_call, push]', false],
    ['on: push', false],
  ])('%s: %s', (on, expected) => {
    expect(isCallOnly(workflow(`${on}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo\n`))).toBe(
      expected,
    );
  });
});

/** A job that calls `file` (a workflow of this repository) and passes `extra` lines. */
const call = (job: string, file: string, ...extra: string[]) =>
  [`  ${job}:`, `    uses: ./.github/workflows/${file}`, ...extra.map((l) => `    ${l}`)].join('\n');
const callerOf = (on: string, ...jobs: string[]) => `on: ${on}\njobs:\n${jobs.join('\n')}\n`;
const site = (c: { caller: { path: string }; job: { id: string } }) => `${c.caller.path}#${c.job.id}`;

describe('chainTo', () => {
  const { index } = load({
    [`${WF}/a.yml`]: callerOf('push', call('to-b', 'b.yml')),
    [`${WF}/b.yml`]: callerOf('workflow_call', call('to-c', 'c.yml')),
    [`${WF}/c.yml`]: callerOf('workflow_call', '  j:\n    runs-on: x\n    steps:\n      - run: echo'),
    [`${WF}/d.yml`]: callerOf('push', call('to-c', 'c.yml')),
    [`${WF}/x.yml`]: callerOf('workflow_call', call('to-y', 'y.yml')),
    [`${WF}/y.yml`]: callerOf('workflow_call', call('to-x', 'x.yml')),
  });

  it('is empty for a workflow nothing calls', () => {
    expect(chainTo(index, `${WF}/a.yml`)).toEqual([]);
    expect(chainTo(index, `${WF}/missing.yml`)).toEqual([]);
  });

  it('lists the calls from a top-level workflow down, outermost first', () => {
    expect(chainTo(index, `${WF}/b.yml`).map(site)).toEqual([`${WF}/a.yml#to-b`]);
  });

  it('picks the shortest chain', () => {
    expect(chainTo(index, `${WF}/c.yml`).map(site)).toEqual([`${WF}/d.yml#to-c`]);
  });

  it('falls back to the longest chain seen when every caller is in a cycle', () => {
    expect(chainTo(index, `${WF}/x.yml`).map(site)).toEqual([`${WF}/y.yml#to-x`]);
  });
});

describe('secretsNeededBy', () => {
  const reads = (...names: string[]) =>
    ['  read:', '    runs-on: x', '    steps:', ...names.map((n) => `      - run: echo \${{ ${n} }}`)].join(
      '\n',
    );
  const { project, index } = load({
    [`${WF}/top.yml`]: callerOf(
      'push',
      reads(
        'secrets.DEPLOY',
        'secrets.GITHUB_TOKEN',
        'secrets.github_token',
        'secrets[matrix.k]',
        'secrets.*',
        'toJSON(secrets)',
      ),
      call('lib', 'lib.yml', 'secrets: inherit'),
      call('explicit', 'other.yml', 'secrets:', '  X: ${{ secrets.X }}'),
      '  remote:\n    uses: acme/infra/.github/workflows/deploy.yml@v1\n    secrets: inherit',
    ),
    [`${WF}/lib.yml`]: callerOf(
      'workflow_call',
      reads('secrets.Lib_Token'),
      call('loop', 'loop.yml', 'secrets: inherit'),
    ),
    [`${WF}/loop.yml`]: callerOf(
      'workflow_call',
      reads('secrets.LOOP'),
      call('back', 'lib.yml', 'secrets: inherit'),
    ),
    [`${WF}/other.yml`]: callerOf('workflow_call', reads('secrets.NOT_INHERITED')),
  });
  const needed = (file: string) =>
    [...secretsNeededBy(index, project.workflows.get(`${WF}/${file}`)!)].sort();

  it('lists the secrets a workflow reads by name, as written, without the automatic token', () => {
    expect(needed('other.yml')).toEqual(['NOT_INHERITED']);
    expect([...BUILTIN_SECRETS]).toEqual(['github_token']);
  });

  it('adds what callees read when they get every secret, through cycles', () => {
    // `X` is read by top.yml's own `secrets:` mapping; other.yml's secret is not handed over by inherit.
    expect(needed('top.yml')).toEqual(['DEPLOY', 'LOOP', 'Lib_Token', 'X']);
    expect(needed('loop.yml')).toEqual(['LOOP', 'Lib_Token']);
  });
});
