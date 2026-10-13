import {
  BUILTIN_SECRETS,
  chainTo,
  isCallOnly,
  needsSecret,
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
    // GitHub looks properties up ignoring case.
    ['toJSON(github.Event)', 'inputs', true],
    ['github.EVENT.Inputs[matrix.k]', 'inputs', true],
    ['github.Event.Inputs.name', 'inputs', false],
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
    [...secretsNeededBy(index, project.workflows.get(`${WF}/${file}`)!).names].sort();

  it('lists the secrets a workflow reads by name, as written, without the automatic token', () => {
    expect(needed('other.yml')).toEqual(['NOT_INHERITED']);
    expect([...BUILTIN_SECRETS]).toEqual(['github_token']);
  });

  it('adds what callees read when they get every secret, through cycles', () => {
    // `X` is read by top.yml's own `secrets:` mapping; other.yml's secret is not handed over by inherit.
    expect(needed('top.yml')).toEqual(['DEPLOY', 'LOOP', 'Lib_Token', 'X']);
    expect(needed('loop.yml')).toEqual(['LOOP', 'Lib_Token']);
  });

  it('says when a workflow reads every secret: its own whole or computed read, and none by name', () => {
    expect(secretsNeededBy(index, project.workflows.get(`${WF}/top.yml`)!).all).toBe(true);
    for (const file of ['lib.yml', 'loop.yml', 'other.yml'])
      expect(secretsNeededBy(index, project.workflows.get(`${WF}/${file}`)!).all).toBe(false);
  });
});

describe('secretsNeededBy: a read of every secret (#20)', () => {
  const reads = (expr: string) => `  read:\n    runs-on: x\n    steps:\n      - run: echo \${{ ${expr} }}`;
  const { project, index } = load({
    // Behind `secrets: inherit`, a whole or computed read gets every secret the caller has.
    [`${WF}/whole.yml`]: callerOf('workflow_call', reads('toJSON(secrets)')),
    [`${WF}/star.yml`]: callerOf('workflow_call', reads('secrets.*')),
    [`${WF}/computed.yml`]: callerOf('workflow_call', reads('secrets[inputs.name]')),
    [`${WF}/named.yml`]: callerOf('workflow_call', reads('secrets.ONE')),
    [`${WF}/via-whole.yml`]: callerOf('workflow_call', call('c', 'whole.yml', 'secrets: inherit')),
    [`${WF}/via-star.yml`]: callerOf('workflow_call', call('c', 'star.yml', 'secrets: inherit')),
    [`${WF}/via-computed.yml`]: callerOf('workflow_call', call('c', 'computed.yml', 'secrets: inherit')),
    // Two levels down, next to a callee that reads one secret by name.
    [`${WF}/deep.yml`]: callerOf(
      'push',
      call('a', 'named.yml', 'secrets: inherit'),
      call('b', 'via-whole.yml', 'secrets: inherit'),
    ),
    // A callee called with `secrets:` gets the named ones only: the caller reads them by name.
    [`${WF}/declares.yml`]: callerOf(
      '\n  workflow_call:\n    secrets:\n      ONE: {}',
      reads('toJSON(secrets)'),
    ),
    [`${WF}/explicit.yml`]: callerOf(
      'push',
      call('c', 'declares.yml', 'secrets:', '  ONE: ${{ secrets.ONE }}'),
    ),
  });
  const of = (file: string) => {
    const n = secretsNeededBy(index, project.workflows.get(`${WF}/${file}`)!);
    return { names: [...n.names].sort(), all: n.all };
  };

  it.each(['whole', 'star', 'computed'])(
    'counts the callee’s %s read of secrets as a read of every secret',
    (kind) => {
      expect(of(`${kind}.yml`)).toEqual({ names: [], all: true });
      expect(of(`via-${kind}.yml`)).toEqual({ names: [], all: true });
    },
  );

  it('keeps the names next to it, through every level of secrets: inherit', () => {
    expect(of('deep.yml')).toEqual({ names: ['ONE'], all: true });
  });

  it('does not follow a callee called with secrets:', () => {
    expect(of('explicit.yml')).toEqual({ names: ['ONE'], all: false });
  });

  it('needs every secret but the automatic token when it reads every secret, else the names, ignoring case', () => {
    const all = secretsNeededBy(index, project.workflows.get(`${WF}/deep.yml`)!);
    expect(['one', 'TWO', 'GITHUB_TOKEN', 'github_token'].map((n) => needsSecret(all, n))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const named = secretsNeededBy(index, project.workflows.get(`${WF}/explicit.yml`)!);
    expect(['one', 'ONE', 'TWO'].map((n) => needsSecret(named, n))).toEqual([true, true, false]);
  });
});

describe('secretsNeededBy: a callee whose reads are unknown', () => {
  const reads = (expr: string) => `  read:\n    runs-on: x\n    steps:\n      - run: echo "\${{ ${expr} }}"`;
  const remote = (pass: string) => `  r:\n    uses: acme/infra/.github/workflows/deploy.yml@v1\n    ${pass}`;
  const { project, index } = load({
    // A remote workflow, or a local one that is not there: what it reads is unknown.
    [`${WF}/remote.yml`]: callerOf('workflow_call', remote('secrets: inherit')),
    [`${WF}/missing.yml`]: callerOf('workflow_call', call('c', 'nowhere.yml', 'secrets: inherit')),
    // An expression, or the file, that does not parse may read any secret.
    [`${WF}/broken.yml`]: callerOf('workflow_call', reads('fromJSON(secrets[')),
    [`${WF}/broken-yaml.yml`]: callerOf(
      'workflow_call',
      '  read:\n    runs-on: x\n    runs-on: y\n    steps:\n      - run: echo',
    ),
    [`${WF}/via-remote.yml`]: callerOf('push', call('c', 'remote.yml', 'secrets: inherit')),
    [`${WF}/via-broken.yml`]: callerOf('workflow_call', call('c', 'broken.yml', 'secrets: inherit')),
    [`${WF}/via-broken-yaml.yml`]: callerOf(
      'workflow_call',
      call('c', 'broken-yaml.yml', 'secrets: inherit'),
    ),
    // Through `secrets:`, the callee gets the named secrets only; a job without `uses:` calls nothing.
    [`${WF}/explicit.yml`]: callerOf(
      'push',
      remote('secrets:\n      X: ${{ secrets.X }}'),
      call('c', 'broken.yml', 'secrets:', '  Y: ${{ secrets.Y }}'),
      '  plain:\n    runs-on: x\n    secrets: inherit\n    steps:\n      - run: echo',
    ),
  });
  const of = (file: string) => {
    const n = secretsNeededBy(index, project.workflows.get(`${WF}/${file}`)!);
    return { names: [...n.names].sort(), all: n.all };
  };

  it('needs every secret when it hands them to a callee it cannot read', () => {
    expect(project.workflows.has(`${WF}/nowhere.yml`)).toBe(false);
    for (const file of ['remote.yml', 'missing.yml', 'via-remote.yml'])
      expect(of(file), file).toEqual({ names: [], all: true });
  });

  it('needs every secret when it, or a callee it hands them to, does not parse', () => {
    expect(project.workflows.get(`${WF}/broken-yaml.yml`)!.parseErrors).not.toEqual([]);
    for (const file of ['broken.yml', 'broken-yaml.yml', 'via-broken.yml', 'via-broken-yaml.yml'])
      expect(of(file), file).toEqual({ names: [], all: true });
  });

  it('needs the named ones only through secrets:, and nothing from a job that calls nothing', () => {
    expect(of('explicit.yml')).toEqual({ names: ['X', 'Y'], all: false });
  });

  it('then needs any secret but the automatic token', () => {
    const needed = secretsNeededBy(index, project.workflows.get(`${WF}/remote.yml`)!);
    expect(['deploy', 'GITHUB_TOKEN'].map((n) => needsSecret(needed, n))).toEqual([true, false]);
  });
});
