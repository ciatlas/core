import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  analyze,
  buildContract,
  byCodePoint,
  type Contract,
  type ContractChange,
  type ContractInput,
  contractFileFor,
  contractPatch,
  contractSchema,
  diffContracts,
  memoryFileSystem,
  nodeFileSystem,
  planContracts,
  serializeContract,
  writeContracts,
} from '@wfc/core';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { byCode, codes, WF, yaml } from './helpers';

const CD = '.github/workflow-contracts';
const CONTRACT_CODES = ['WFC801', 'WFC802', 'WFC803', 'WFC804', 'WFC805'];

const caller = yaml`
  name: Caller
  on:
    push:
    workflow_dispatch:
      inputs:
        env:
          type: choice
          options: [a, b]
          default: a
  jobs:
    setup:
      runs-on: x
      steps:
        - id: s
          uses: ./.github/actions/setup
          with:
            version: '20'
        - run: echo \${{ steps.s.outputs.path }}
    build:
      needs: setup
      strategy:
        matrix:
          os: [linux, windows]
      uses: ./.github/workflows/reusable.yml
      with:
        mode: \${{ matrix.os }}
        count: 3
      secrets: inherit
    other:
      uses: ./.github/workflows/reusable.yml
      with:
        mode: fast
      secrets:
        token: \${{ secrets.T }}
    after:
      needs: build
      runs-on: x
      steps:
        - run: echo \${{ needs.build.outputs.url }}
`;

const reusable = yaml`
  name: Reusable
  on:
    workflow_call:
      inputs:
        mode:
          type: string
          required: true
          description: The mode
        count:
          type: number
          default: 1
      secrets:
        token:
          required: false
      outputs:
        url:
          description: The URL
          value: \${{ jobs.j.outputs.url }}
  jobs:
    j:
      runs-on: x
      outputs:
        url: \${{ steps.a.outputs.u }}
      steps:
        - id: a
          run: echo "u=1" >> $GITHUB_OUTPUT
`;

const action = yaml`
  name: Setup
  inputs:
    version:
      required: true
  outputs:
    path:
      description: p
      value: \${{ steps.x.outputs.p }}
  runs:
    using: composite
    steps:
      - id: x
        run: echo p=1 >> $GITHUB_OUTPUT
        shell: bash
`;

const base: Record<string, string> = {
  [`${WF}/caller.yml`]: caller,
  [`${WF}/reusable.yml`]: reusable,
  '.github/actions/setup/action.yml': action,
};

const index = (files: Record<string, string>) =>
  analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    validateSchema: false,
    repository: 'acme/repo',
    only: [],
  }).index;

const contractOf = (files: Record<string, string>, path: string): Contract => {
  const idx = index(files);
  return buildContract(idx, idx.unit(path)!);
};

/** The contract files `wfc generate` would write for these sources. */
const generated = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    planContracts(index(files), memoryFileSystem(files)).entries.map((e) => [e.file, e.after ?? '']),
  );

const check = (files: Record<string, string>, only: string[] | null = CONTRACT_CODES) =>
  analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    validateSchema: false,
    repository: 'acme/repo',
    checkContracts: true,
    ...(only ? { only } : {}),
  });

describe('buildContract', () => {
  it('describes a workflow: interface, triggers, calls, local action uses and consumers', () => {
    const c = contractOf(base, `${WF}/caller.yml`);
    expect(contractSchema.safeParse(c).success).toBe(true);
    expect(c).toMatchObject({
      version: 1,
      kind: 'workflow',
      path: `${WF}/caller.yml`,
      name: 'Caller',
      triggers: ['push', 'workflow_dispatch'],
      interface: {
        inputs: {},
        dispatchInputs: { env: { type: 'choice', required: false, default: 'a', options: ['a', 'b'] } },
        outputs: {},
      },
      consumers: [],
    });
    expect(c.interface.secrets).toBeUndefined();
    expect(c.calls).toEqual([
      {
        job: 'build',
        uses: `${WF}/reusable.yml`,
        with: { count: '3', mode: '${{ matrix.os }}' },
        secrets: 'inherit',
        needs: ['setup'],
        matrix: { combinations: 2, keys: ['os'], exact: true },
      },
      {
        job: 'other',
        uses: `${WF}/reusable.yml`,
        with: { mode: 'fast' },
        secrets: { token: '${{ secrets.T }}' },
      },
    ]);
    expect(c.uses).toEqual([
      { job: 'setup', step: 's', uses: '.github/actions/setup', with: { version: '20' } },
    ]);
  });

  it('describes a reusable workflow with call inputs, secrets, outputs and what each consumer passes/reads', () => {
    const c = contractOf(base, `${WF}/reusable.yml`);
    expect(c.triggers).toEqual(['workflow_call']);
    expect(c.interface).toEqual({
      inputs: {
        count: { type: 'number', required: false, default: 1 },
        mode: { type: 'string', required: true, description: 'The mode' },
      },
      secrets: { token: { required: false } },
      outputs: { url: { description: 'The URL', value: '${{ jobs.j.outputs.url }}' } },
    });
    expect(Object.keys(c.interface.inputs)).toEqual(['count', 'mode']);
    expect(c.calls).toBeUndefined();
    expect(c.consumers).toEqual([
      { from: `${WF}/caller.yml`, job: 'build', passes: ['count', 'mode'], reads: ['url'] },
      { from: `${WF}/caller.yml`, job: 'other', passes: ['mode'], reads: [] },
    ]);
  });

  it('describes a local action and the steps that use it', () => {
    const c = contractOf(base, '.github/actions/setup');
    expect(c).toEqual({
      $schema: 'https://rumankazi.github.io/wfc/schemas/contract/v1.json',
      version: 1,
      kind: 'action',
      path: '.github/actions/setup',
      name: 'Setup',
      interface: {
        inputs: { version: { required: true } },
        outputs: { path: { description: 'p', value: '${{ steps.x.outputs.p }}' } },
      },
      consumers: [
        { from: `${WF}/caller.yml`, job: 'setup', step: 's', passes: ['version'], reads: ['path'] },
      ],
    });
  });

  it('records a runtime-computed matrix without guessing its shape', () => {
    const files = {
      [`${WF}/reusable.yml`]: reusable,
      [`${WF}/dyn.yml`]: yaml`
        on: push
        jobs:
          gen:
            runs-on: x
            outputs:
              m: \${{ steps.g.outputs.m }}
            steps:
              - id: g
                run: echo "m=[]" >> $GITHUB_OUTPUT
          call:
            needs: gen
            strategy:
              matrix: \${{ fromJSON(needs.gen.outputs.m) }}
            uses: ./.github/workflows/reusable.yml
            with:
              mode: \${{ matrix.mode }}
      `,
    };
    expect(contractOf(files, `${WF}/dyn.yml`).calls?.[0]?.matrix).toEqual({
      combinations: 0,
      keys: [],
      exact: false,
    });
  });
});

describe('serializeContract', () => {
  const text = (files: Record<string, string>, path: string) => serializeContract(contractOf(files, path));

  it('is deterministic and starts with the generated-file header', () => {
    const a = text(base, `${WF}/caller.yml`);
    expect(text(base, `${WF}/caller.yml`)).toBe(a);
    expect(a.startsWith('# Generated by wfc — do not edit by hand.')).toBe(true);
    expect(a.endsWith('\n')).toBe(true);
    expect(contractSchema.safeParse(parseYaml(a)).success).toBe(true);
  });

  it('ignores key order and comments in the source workflow', () => {
    const reordered = yaml`
      # The reusable workflow, reordered.
      jobs:
        j:
          outputs:
            url: \${{ steps.a.outputs.u }}
          runs-on: x
          steps:
            - run: echo "u=1" >> $GITHUB_OUTPUT  # write output
              id: a
      on:
        workflow_call:
          outputs:
            url:
              value: \${{ jobs.j.outputs.url }}
              description: The URL
          secrets:
            token:
              required: false
          inputs:
            count:
              default: 1
              type: number
            mode:
              description: The mode
              required: true   # callers must choose
              type: string
      name: Reusable
    `;
    const files = { ...base, [`${WF}/reusable.yml`]: reordered };
    expect(text(files, `${WF}/reusable.yml`)).toBe(text(base, `${WF}/reusable.yml`));
    const commented = {
      ...base,
      [`${WF}/caller.yml`]: `# top comment\n${caller.replace('count: 3', 'count: 3 # n')}`,
    };
    expect(text(commented, `${WF}/caller.yml`)).toBe(text(base, `${WF}/caller.yml`));
  });
});

describe('contractFileFor', () => {
  it('maps workflows and actions to stable file names', () => {
    expect(contractFileFor({ kind: 'workflow', path: `${WF}/ci.yml` })).toBe(
      `${CD}/workflows/ci.contract.yml`,
    );
    expect(contractFileFor({ kind: 'workflow', path: `${WF}/ci.yaml` })).toBe(
      `${CD}/workflows/ci.contract.yml`,
    );
    expect(contractFileFor({ kind: 'action', path: '.github/actions/setup' })).toBe(
      `${CD}/actions/setup.contract.yml`,
    );
    expect(contractFileFor({ kind: 'action', path: '.github/actions/node/setup' })).toBe(
      `${CD}/actions/node__setup.contract.yml`,
    );
    expect(contractFileFor({ kind: 'action', path: 'tools/build' })).toBe(
      `${CD}/actions/tools__build.contract.yml`,
    );
    expect(contractFileFor({ kind: 'action', path: '.' })).toBe(`${CD}/actions/root.contract.yml`);
  });

  it('keeps the extension when a .yml and .yaml stem collide, and numbers other collisions', () => {
    const taken = new Set([`${CD}/workflows/ci.contract.yml`, `${CD}/actions/tools__build.contract.yml`]);
    expect(contractFileFor({ kind: 'workflow', path: `${WF}/ci.yml` }, taken)).toBe(
      `${CD}/workflows/ci.yml.contract.yml`,
    );
    expect(contractFileFor({ kind: 'action', path: 'tools/build' }, taken)).toBe(
      `${CD}/actions/tools__build-2.contract.yml`,
    );
  });

  it('gives every unit its own file in a plan, even when names collide', () => {
    const files = {
      [`${WF}/ci.yml`]: 'on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: a }]\n',
      [`${WF}/ci.yaml`]:
        'on: pull_request\njobs:\n  b:\n    runs-on: x\n    steps: [{ uses: ./tools/build }]\n',
      '.github/actions/tools/build/action.yml': 'name: A\nruns:\n  using: composite\n  steps: []\n',
      'tools/build/action.yml': 'name: B\nruns:\n  using: composite\n  steps: []\n',
    };
    const plan = planContracts(index(files), memoryFileSystem(files));
    expect(plan.entries.map((e) => [e.file, e.unit])).toEqual([
      [`${CD}/actions/tools__build-2.contract.yml`, 'tools/build'],
      [`${CD}/actions/tools__build.contract.yml`, '.github/actions/tools/build'],
      [`${CD}/workflows/ci.contract.yml`, `${WF}/ci.yaml`],
      [`${CD}/workflows/ci.yml.contract.yml`, `${WF}/ci.yml`],
    ]);
  });

  it('keeps an existing contract file for its workflow when a colliding workflow is added', () => {
    const one = { [`${WF}/ci.yml`]: 'on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: a }]\n' };
    const two = {
      ...one,
      ...generated(one),
      [`${WF}/ci.yaml`]: 'on: pull_request\njobs:\n  b:\n    runs-on: x\n    steps: [{ run: b }]\n',
    };
    const plan = planContracts(index(two), memoryFileSystem(two));
    expect(plan.entries.map((e) => [e.file, e.status, e.unit])).toEqual([
      [`${CD}/workflows/ci.contract.yml`, 'unchanged', `${WF}/ci.yml`],
      [`${CD}/workflows/ci.yaml.contract.yml`, 'create', `${WF}/ci.yaml`],
    ]);
  });
});

describe('diffContracts', () => {
  const wf = (): Contract => ({
    $schema: 'x',
    version: 1,
    kind: 'workflow',
    path: `${WF}/r.yml`,
    triggers: ['workflow_call'],
    interface: {
      inputs: {
        a: { type: 'string', required: false, default: 'x' },
        b: { type: 'string', required: true },
        c: { type: 'choice', required: false, options: ['one', 'two'] },
      },
      secrets: { s: { required: true }, o: { required: false } },
      outputs: { url: { value: '${{ jobs.j.outputs.url }}' } },
    },
    calls: [
      {
        job: 'call',
        uses: `${WF}/x.yml`,
        with: { p: 'v' },
        secrets: { t: '${{ secrets.T }}' },
        needs: ['n'],
      },
    ],
    consumers: [{ from: `${WF}/c.yml`, job: 'j', passes: ['b'], reads: ['url'] }],
  });

  const cases: [string, (c: Contract) => void, Partial<ContractChange>[]][] = [
    ['input removed', (c) => delete c.interface.inputs.a, [{ breaking: true, path: 'inputs.a' }]],
    [
      'input added as required without default',
      (c) => (c.interface.inputs.d = { required: true }),
      [{ breaking: true, path: 'inputs.d' }],
    ],
    [
      // GitHub requires `required` workflow_call inputs from every caller, default or not.
      'input added as required with a default',
      (c) => (c.interface.inputs.d = { required: true, default: 'z' }),
      [{ breaking: true, path: 'inputs.d' }],
    ],
    ['input added as optional', (c) => (c.interface.inputs.d = { required: false }), [{ breaking: false }]],
    [
      'optional → required without default',
      (c) => (c.interface.inputs.c = { type: 'choice', required: true, options: ['one', 'two'] }),
      [{ breaking: true, path: 'inputs.c', message: 'input "c" must now be passed by every caller' }],
    ],
    [
      'required → optional',
      (c) => (c.interface.inputs.b = { type: 'string', required: false }),
      [{ breaking: false, path: 'inputs.b', message: 'input "b" is now optional' }],
    ],
    [
      'optional with default → required without default',
      (c) => (c.interface.inputs.a = { type: 'string', required: true }),
      [
        { breaking: true, message: 'input "a" must now be passed by every caller' },
        { breaking: false, message: 'input "a" default changed from "x" to null' },
      ],
    ],
    [
      'type change',
      (c) => (c.interface.inputs.b = { type: 'number', required: true }),
      [{ breaking: true, message: 'input "b" changed type from string to number' }],
    ],
    [
      'default change',
      (c) => (c.interface.inputs.a = { type: 'string', required: false, default: 'y' }),
      [{ breaking: false, message: 'input "a" default changed from "x" to "y"' }],
    ],
    [
      'option removed',
      (c) => (c.interface.inputs.c = { type: 'choice', required: false, options: ['one'] }),
      [{ breaking: true, message: 'input "c" options changed (removed: two)' }],
    ],
    [
      'option added',
      (c) => (c.interface.inputs.c = { type: 'choice', required: false, options: ['one', 'two', 'three'] }),
      [{ breaking: false, message: 'input "c" options changed' }],
    ],
    [
      'description change',
      (c) => (c.interface.inputs.b = { type: 'string', required: true, description: 'new' }),
      [{ breaking: false, message: 'input "b" description changed' }],
    ],
    ['secret removed', (c) => delete c.interface.secrets!.s, [{ breaking: true, path: 'secrets.s' }]],
    [
      'secret added as required',
      (c) => (c.interface.secrets!.n = { required: true }),
      [{ breaking: true, message: 'secret "n" was added as required' }],
    ],
    [
      'secret added as optional',
      (c) => (c.interface.secrets!.n = { required: false }),
      [{ breaking: false, message: 'secret "n" was added' }],
    ],
    [
      'secret optional → required',
      (c) => (c.interface.secrets!.o = { required: true }),
      [{ breaking: true, message: 'secret "o" is now required' }],
    ],
    [
      'secret required → optional',
      (c) => (c.interface.secrets!.s = { required: false }),
      [{ breaking: false, message: 'secret "s" is now optional' }],
    ],
    ['output removed', (c) => delete c.interface.outputs.url, [{ breaking: true, path: 'outputs.url' }]],
    [
      'output added',
      (c) => (c.interface.outputs.sha = {}),
      [{ breaking: false, message: 'output "sha" was added' }],
    ],
    [
      'output changed',
      (c) => (c.interface.outputs.url = { value: '${{ jobs.k.outputs.url }}' }),
      [{ breaking: false, message: 'output "url" changed' }],
    ],
    [
      'workflow_call trigger lost',
      (c) => (c.triggers = ['push']),
      [{ breaking: true, path: 'triggers', message: 'triggers changed from [workflow_call] to [push]' }],
    ],
    [
      'trigger added',
      (c) => (c.triggers = ['push', 'workflow_call']),
      [{ breaking: false, path: 'triggers' }],
    ],
    [
      'name changed',
      (c) => (c.name = 'New'),
      [{ breaking: false, message: 'name changed from "" to "New"' }],
    ],
    [
      'call: with added, removed and changed',
      (c) => (c.calls![0]!.with = { p: 'w', q: 'v' }),
      [{ breaking: false, path: 'calls.call', message: 'jobs.call: changed p, passes q' }],
    ],
    [
      'call: with removed',
      (c) => delete c.calls![0]!.with,
      [{ breaking: false, message: 'jobs.call: stopped passing p' }],
    ],
    [
      'call: secrets, matrix and needs',
      (c) =>
        Object.assign(c.calls![0]!, {
          secrets: 'inherit',
          needs: ['m'],
          matrix: { combinations: 2, keys: ['os'], exact: true },
        }),
      [{ breaking: false, message: 'jobs.call: secrets changed, matrix changed, needs changed' }],
    ],
    [
      'call: target changed',
      (c) => (c.calls![0]!.uses = `${WF}/y.yml`),
      [{ breaking: false, message: `jobs.call: now calls ${WF}/y.yml` }],
    ],
    [
      'call removed and added',
      (c) => (c.calls = [{ job: 'other', uses: `${WF}/x.yml` }]),
      [
        { breaking: false, message: `jobs.call no longer calls ${WF}/x.yml` },
        { breaking: false, message: `jobs.other now calls ${WF}/x.yml` },
      ],
    ],
    [
      'local action usage changed',
      (c) => (c.uses = [{ step: 's', uses: '.github/actions/a' }]),
      [{ breaking: false, path: 'uses' }],
    ],
    [
      'consumer added',
      (c) => c.consumers.push({ from: `${WF}/d.yml`, job: 'k', passes: [], reads: [] }),
      [{ breaking: false, path: 'consumers', message: 'consumers changed (+1 / -0)' }],
    ],
    [
      'consumer reads changed',
      (c) => (c.consumers[0]!.reads = []),
      [{ breaking: false, message: 'what consumers pass or read changed' }],
    ],
  ];

  it.each(cases)('%s', (_name, mutate, expected) => {
    const after = wf();
    mutate(after);
    const changes = diffContracts(wf(), after);
    expect(changes).toHaveLength(expected.length);
    for (const [i, e] of expected.entries()) expect(changes[i]).toMatchObject(e);
  });

  it('for workflow_call, a default never relaxes `required`; for actions, removing it breaks callers', () => {
    const withDefault = wf();
    withDefault.interface.inputs.b = { type: 'string', required: true, default: 'x' };
    expect(diffContracts(withDefault, wf())).toEqual([
      { breaking: false, path: 'inputs.b', message: 'input "b" default changed from "x" to null' },
    ]);
    const action = (input: ContractInput): Contract => ({
      ...wf(),
      kind: 'action',
      triggers: undefined,
      interface: { inputs: { b: input }, outputs: {} },
    });
    expect(diffContracts(action({ required: true, default: 'x' }), action({ required: true }))).toEqual([
      { breaking: true, path: 'inputs.b', message: 'input "b" must now be passed by every caller' },
      { breaking: false, path: 'inputs.b', message: 'input "b" default changed from "x" to null' },
    ]);
  });

  it('separates dispatch inputs, detects renames and treats a newly reusable workflow as non-breaking', () => {
    const moved = wf();
    moved.interface.dispatchInputs = { a: moved.interface.inputs.a! };
    delete moved.interface.inputs.a;
    expect(diffContracts(wf(), moved).map((c) => [c.breaking, c.message])).toEqual([
      [true, 'input "a" was removed — callers that pass it will fail'],
      [false, 'dispatch input "a" was added'],
    ]);
    const renamed = { ...wf(), path: '.github/workflows/build.yaml' };
    expect(diffContracts(wf(), renamed)).toEqual([
      {
        breaking: true,
        path: 'path',
        message: `path changed from ${wf().path} to .github/workflows/build.yaml — callers referencing the old path will fail`,
      },
    ]);
    const notCallable = { ...wf(), triggers: ['push'], interface: { inputs: {}, outputs: {} } };
    const nowCallable = {
      ...wf(),
      triggers: ['push', 'workflow_call'],
      interface: {
        inputs: { t: { type: 'string', required: true } },
        secrets: { k: { required: true } },
        outputs: {},
      },
    };
    expect(diffContracts(notCallable, nowCallable).filter((c) => c.breaking)).toEqual([]);
  });

  it('reports nothing for identical contracts', () => {
    expect(diffContracts(wf(), wf())).toEqual([]);
  });
});

describe('planContracts', () => {
  it('creates every contract for a repository without any', () => {
    const plan = planContracts(index(base), memoryFileSystem(base));
    expect(plan.entries.map((e) => [e.file, e.status])).toEqual([
      [`${CD}/actions/setup.contract.yml`, 'create'],
      [`${CD}/workflows/caller.contract.yml`, 'create'],
      [`${CD}/workflows/reusable.contract.yml`, 'create'],
    ]);
    expect(plan).toMatchObject({
      drift: true,
      breaking: 0,
      counts: { create: 3, update: 0, delete: 0, unchanged: 0 },
    });
  });

  it('classifies unchanged, updated (with semantic changes) and orphaned contracts', () => {
    const files = {
      ...base,
      ...generated(base),
      [`${CD}/workflows/gone.contract.yml`]: generated(base)[`${CD}/workflows/caller.contract.yml`]!.replace(
        'path: .github/workflows/caller.yml',
        'path: .github/workflows/gone.yml',
      ),
      [`${WF}/reusable.yml`]: reusable.replace('default: 1', 'required: true'),
    };
    const plan = planContracts(index(files), memoryFileSystem(files));
    expect(plan.entries.map((e) => [e.file, e.status, e.unit])).toEqual([
      [`${CD}/actions/setup.contract.yml`, 'unchanged', '.github/actions/setup'],
      [`${CD}/workflows/caller.contract.yml`, 'unchanged', `${WF}/caller.yml`],
      [`${CD}/workflows/gone.contract.yml`, 'delete', `${WF}/gone.yml`],
      [`${CD}/workflows/reusable.contract.yml`, 'update', `${WF}/reusable.yml`],
    ]);
    const update = plan.entries[3]!;
    expect(update.changes).toEqual([
      { breaking: true, path: 'inputs.count', message: 'input "count" must now be passed by every caller' },
      { breaking: false, path: 'inputs.count', message: 'input "count" default changed from 1 to null' },
    ]);
    expect(update.before).not.toBe(update.after);
    expect(plan).toMatchObject({
      drift: true,
      breaking: 1,
      counts: { create: 0, update: 1, delete: 1, unchanged: 2 },
    });
  });

  it('reports no drift when everything matches', () => {
    const files = { ...base, ...generated(base) };
    const plan = planContracts(index(files), memoryFileSystem(files));
    expect(plan.drift).toBe(false);
    expect(plan.counts.unchanged).toBe(3);
    expect(contractPatch(plan)).toBe('');
  });

  it('marks unreadable contracts as invalid instead of diffing them', () => {
    const files = {
      ...base,
      ...generated(base),
      [`${CD}/workflows/caller.contract.yml`]: 'interface: [unclosed\n',
      [`${CD}/workflows/reusable.contract.yml`]: generated(base)[
        `${CD}/workflows/reusable.contract.yml`
      ]!.replace('version: 1', 'version: 2'),
      [`${CD}/workflows/stray.contract.yml`]: 'just: text\n',
    };
    const plan = planContracts(index(files), memoryFileSystem(files));
    const byFile = Object.fromEntries(plan.entries.map((e) => [e.file.split('/').pop(), e]));
    expect(byFile['caller.contract.yml']).toMatchObject({ status: 'update', changes: [] });
    expect(byFile['caller.contract.yml']!.invalid).toMatch(/^not valid YAML: /);
    expect(byFile['reusable.contract.yml']).toMatchObject({ status: 'update', changes: [] });
    expect(byFile['reusable.contract.yml']!.invalid).toContain('version:');
    expect(byFile['stray.contract.yml']).toMatchObject({ status: 'delete' });
    expect(byFile['stray.contract.yml']!.unit).toBeUndefined();
    expect(byFile['stray.contract.yml']!.invalid).toContain('(root)');
  });

  it('ignores files in the contracts directory that are not contracts', () => {
    const files = {
      ...base,
      ...generated(base),
      [`${CD}/wfc.config.yml`]: 'rules: {}\n',
      [`${CD}/README.md`]: 'x',
    };
    expect(planContracts(index(files), memoryFileSystem(files)).drift).toBe(false);
  });
});

describe('contractPatch and writeContracts', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

  /** A repository on disk with outdated contracts: one to create, one to update, one to delete, one unchanged. */
  const repo = () => {
    const root = mkdtempSync(join(tmpdir(), 'wfc-contracts-'));
    const contracts = generated(base);
    const files: Record<string, string> = {
      ...base,
      [`${CD}/workflows/caller.contract.yml`]: contracts[`${CD}/workflows/caller.contract.yml`]!,
      [`${CD}/workflows/reusable.contract.yml`]: contracts[`${CD}/workflows/reusable.contract.yml`]!,
      [`${CD}/workflows/old.contract.yml`]: contracts[`${CD}/workflows/caller.contract.yml`]!.replace(
        'caller.yml',
        'old.yml',
      ),
      [`${WF}/reusable.yml`]: reusable.replace('default: 1', 'required: true'),
    };
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    git(root, 'init', '-q');
    const plan = () =>
      planContracts(
        analyze({ root, validateSchema: false, repository: 'acme/repo', only: [] }).index,
        nodeFileSystem(root),
      );
    return { root, plan };
  };

  it('produces a patch that `git apply` turns into exactly the planned files', () => {
    const { root, plan } = repo();
    const p = plan();
    expect(p.counts).toEqual({ create: 1, update: 1, delete: 1, unchanged: 1 });
    const patch = contractPatch(p);
    expect(patch).toContain(
      `diff --git a/${CD}/actions/setup.contract.yml b/${CD}/actions/setup.contract.yml\nnew file mode 100644\n--- /dev/null`,
    );
    expect(patch).toContain(
      `deleted file mode 100644\n--- a/${CD}/workflows/old.contract.yml\n+++ /dev/null`,
    );
    expect(patch).toContain(`+++ b/${CD}/workflows/reusable.contract.yml\n@@`);
    expect(patch).not.toContain('caller.contract.yml');
    writeFileSync(join(root, 'contracts.patch'), patch);
    git(root, 'apply', '--check', 'contracts.patch');
    git(root, 'apply', 'contracts.patch');
    for (const e of p.entries) {
      if (e.status === 'delete') expect(existsSync(join(root, e.file))).toBe(false);
      else expect(readFileSync(join(root, e.file), 'utf8')).toBe(e.after);
    }
    expect(plan().drift).toBe(false);
  });

  it('writes the plan into the repository, deleting orphans', () => {
    const { root, plan } = repo();
    const written = writeContracts(root, plan());
    expect(written.sort()).toEqual([
      `${CD}/actions/setup.contract.yml`,
      `${CD}/workflows/old.contract.yml`,
      `${CD}/workflows/reusable.contract.yml`,
    ]);
    expect(existsSync(join(root, CD, 'workflows/old.contract.yml'))).toBe(false);
    expect(plan().drift).toBe(false);
  });

  it('writes every contract to another directory without deleting anything', () => {
    const { root, plan } = repo();
    const out = mkdtempSync(join(tmpdir(), 'wfc-out-'));
    const p = plan();
    const written = writeContracts(root, p, out);
    expect(written.sort()).toEqual([
      `${CD}/actions/setup.contract.yml`,
      `${CD}/workflows/caller.contract.yml`,
      `${CD}/workflows/reusable.contract.yml`,
    ]);
    for (const file of written) {
      expect(readFileSync(join(out, file), 'utf8')).toBe(p.entries.find((e) => e.file === file)!.after);
    }
    expect(existsSync(join(root, CD, 'workflows/old.contract.yml'))).toBe(true);
    expect(existsSync(join(root, CD, 'actions/setup.contract.yml'))).toBe(false);
    expect(plan().drift).toBe(true);
  });
});

describe('check mode (WFC8xx)', () => {
  const locked = { ...base, ...generated(base) };

  it('does not compare contracts outside check mode', () => {
    const r = analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem(base),
      validateSchema: false,
      repository: 'acme/repo',
    });
    expect(codes(r).filter((c) => c.startsWith('WFC8'))).toEqual([]);
    expect(r.contracts).toBeUndefined();
  });

  it('is clean when the contracts match', () => {
    const r = check(locked);
    expect(codes(r)).toEqual([]);
    expect(r.contracts?.drift).toBe(false);
  });

  it('WFC801: reports each workflow and action without a contract at the top of its file', () => {
    const r = check(base);
    expect(byCode(r, 'WFC801').map((f) => [f.loc.file, f.loc.line, f.symbol, f.severity])).toEqual([
      ['.github/actions/setup/action.yml', 1, '.github/actions/setup', 'error'],
      [`${WF}/caller.yml`, 1, `${WF}/caller.yml`, 'error'],
      [`${WF}/reusable.yml`, 1, `${WF}/reusable.yml`, 'error'],
    ]);
    expect(byCode(r, 'WFC801')[0]!.message).toBe(
      `.github/actions/setup has no contract (expected ${CD}/actions/setup.contract.yml)`,
    );
  });

  it('WFC802: non-breaking drift points at the changed declaration', () => {
    const files = {
      ...locked,
      [`${WF}/reusable.yml`]: reusable.replace(
        '    secrets:',
        '      extra:\n        type: string\n    secrets:',
      ),
    };
    const r = check(files);
    expect(codes(r)).toEqual(['WFC802']);
    const f = r.findings[0]!;
    expect(f.message).toBe(
      `Contract ${CD}/workflows/reusable.contract.yml is outdated: input "extra" was added`,
    );
    expect(f.loc).toMatchObject({ file: `${WF}/reusable.yml`, line: 12 });
    expect(f.related).toEqual([
      {
        loc: expect.objectContaining({ file: `${CD}/workflows/reusable.contract.yml` }),
        message: 'locked contract',
      },
    ]);
  });

  it('WFC802: a hand-edited contract with no semantic change is still outdated', () => {
    const file = `${CD}/workflows/caller.contract.yml`;
    const r = check({ ...locked, [file]: locked[file]!.replace(/^# .*\n/gm, '') });
    expect(byCode(r, 'WFC802').map((f) => f.message)).toEqual([
      `Contract ${file} is outdated: formatting or ordering changed`,
    ]);
  });

  it('WFC803: breaking changes list the known consumers; mixed changes also give WFC802', () => {
    const files = {
      ...locked,
      [`${WF}/reusable.yml`]: reusable
        .replace('default: 1', 'required: true')
        .replace(
          '        required: false\n    outputs',
          '        required: false\n      sig:\n        required: false\n    outputs',
        ),
    };
    const r = check(files);
    expect(codes(r).sort()).toEqual(['WFC802', 'WFC803']);
    const f = byCode(r, 'WFC803')[0]!;
    expect(f.message).toBe(
      `Breaking change to ${WF}/reusable.yml: input "count" must now be passed by every caller`,
    );
    expect(f.symbol).toBe(`${WF}/reusable.yml#inputs.count`);
    expect(f.loc).toMatchObject({ file: `${WF}/reusable.yml`, line: 9 });
    expect(f.related.map((x) => [x.loc.file, x.message])).toEqual([
      [`${CD}/workflows/reusable.contract.yml`, 'locked contract'],
      [`${WF}/caller.yml`, `consumer: ${WF}/caller.yml › jobs.build`],
      [`${WF}/caller.yml`, `consumer: ${WF}/caller.yml › jobs.other`],
    ]);
    expect(byCode(r, 'WFC802')[0]!.message).toContain('secret "sig" was added');
    expect(r.contracts?.breaking).toBe(1);
  });

  it('WFC803: breaking changes to an action list the steps that use it', () => {
    const files = {
      ...locked,
      '.github/actions/setup/action.yml': action.replace(/outputs:[\s\S]*?runs:/, 'runs:'),
    };
    const r = check(files);
    // The consumer no longer reads the output either, which is a non-breaking change to the contract.
    expect(codes(r).sort()).toEqual(['WFC802', 'WFC803']);
    const f = byCode(r, 'WFC803')[0]!;
    expect(f.message).toBe(
      'Breaking change to .github/actions/setup: output "path" was removed — consumers reading it get an empty value',
    );
    expect(f.related.map((x) => x.message)).toEqual([
      'locked contract',
      `consumer: ${WF}/caller.yml › jobs.setup › steps.s`,
    ]);
  });

  it('WFC804: contracts for workflows that no longer exist', () => {
    const { [`${WF}/caller.yml`]: _removed, ...rest } = locked;
    const r = check(rest);
    expect(byCode(r, 'WFC804').map((f) => [f.message, f.loc.file, f.symbol])).toEqual([
      [
        `Contract ${CD}/workflows/caller.contract.yml describes ${WF}/caller.yml which no longer exists`,
        `${CD}/workflows/caller.contract.yml`,
        `${WF}/caller.yml`,
      ],
    ]);
  });

  it('WFC805: unreadable contracts, reported once', () => {
    const r = check({
      ...locked,
      [`${CD}/workflows/caller.contract.yml`]: 'interface: [unclosed\n',
      [`${CD}/workflows/stray.contract.yml`]: 'kind: workflow\n',
    });
    expect(r.findings.map((f) => [f.code, f.loc.file])).toEqual([
      ['WFC805', `${CD}/workflows/caller.contract.yml`],
      ['WFC805', `${CD}/workflows/stray.contract.yml`],
    ]);
    expect(r.findings[0]!.message).toMatch(/^Contract .* is invalid: not valid YAML: /);
  });

  it('runs alongside the other rules', () => {
    const r = check(base, null);
    expect(codes(r)).toContain('WFC801');
    expect(codes(r)).toContain('WFC104');
  });
});

describe('review fixes', () => {
  it('orders keys independently of the locale', () => {
    const files = {
      [`${WF}/r.yml`]:
        'on:\n  workflow_call:\n    inputs:\n      zone: {}\n      target: {}\n      checkout: {}\n      debug: {}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
    };
    const c = contractOf(files, `${WF}/r.yml`);
    expect(Object.keys(c.interface.inputs)).toEqual(['checkout', 'debug', 'target', 'zone']);
    expect(byCodePoint('Z', 'a')).toBeLessThan(0);
  });

  it('treats CRLF checkouts of a contract as unchanged', () => {
    const crlf = Object.fromEntries(
      Object.entries(generated(base)).map(([f, t]) => [f, t.replace(/\n/g, '\r\n')]),
    );
    const files = { ...base, ...crlf };
    expect(planContracts(index(files), memoryFileSystem(files)).drift).toBe(false);
  });

  it('keeps the locked contract of a workflow that is not valid YAML', () => {
    const files = { ...base, ...generated(base), [`${WF}/reusable.yml`]: '- [' };
    const plan = planContracts(index(files), memoryFileSystem(files));
    expect(plan.skipped).toEqual([`${WF}/reusable.yml`]);
    expect(plan.entries.find((e) => e.unit === `${WF}/reusable.yml`)).toMatchObject({
      status: 'unchanged',
      skipped: 'YAML syntax errors',
    });
    expect(codes(check(files))).toEqual([]);
  });

  it('reports an invalid contract of a targeted workflow', () => {
    const files = { ...base, ...generated(base) };
    files[`${CD}/workflows/reusable.contract.yml`] += '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> x\n';
    const r = analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem(files),
      validateSchema: false,
      repository: 'acme/repo',
      checkContracts: true,
      only: CONTRACT_CODES,
      paths: [`${WF}/reusable.yml`],
    });
    expect(codes(r)).toEqual(['WFC805']);
  });
});
