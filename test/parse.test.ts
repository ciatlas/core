import {
  classifyUses,
  createParseContext,
  type Loc,
  parseActionFile,
  parseWorkflowFile,
  scanRunWrites,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { yaml } from './helpers';

const parse = (text: string, repo?: string) =>
  parseWorkflowFile('.github/workflows/w.yml', text, createParseContext(repo));
const lineCol = (l: Loc) => `${l.line}:${l.column}-${l.endLine}:${l.endColumn}`;
const loc0: Loc = { file: 'f', line: 1, column: 1, endLine: 1, endColumn: 1 };

describe('parseWorkflowFile — triggers and interface', () => {
  it.each([
    ['on: push', ['push']],
    ['on: [push, workflow_call]', ['push', 'workflow_call']],
    ['on:\n  push:\n  workflow_dispatch:', ['push', 'workflow_dispatch']],
  ])('reads triggers from %j', (on, expected) => {
    expect(parse(`${on}\njobs: {}\n`).triggers).toEqual(expected);
  });

  it('reads workflow_call inputs, secrets and outputs', () => {
    const wf = parse(yaml`
      on:
        workflow_call:
          inputs:
            a: { type: string, required: true, description: The A }
            b: { type: boolean, default: false }
            c: { type: string, default: '' }
            d: { type: number }
          secrets:
            token: { required: true }
            opt: {}
          outputs:
            url:
              description: The URL
              value: \${{ jobs.j.outputs.url }}
      jobs: {}
    `);
    expect(wf.call?.inputs.a).toMatchObject({
      type: 'string',
      required: true,
      hasDefault: false,
      description: 'The A',
    });
    expect(wf.call?.inputs.b).toMatchObject({ required: false, hasDefault: true, default: false });
    expect(wf.call?.inputs.c).toMatchObject({ hasDefault: true, default: '' });
    expect(wf.call?.inputs.d).toMatchObject({ type: 'number', hasDefault: false });
    expect(wf.call?.secrets.token?.required).toBe(true);
    expect(wf.call?.secrets.opt?.required).toBe(false);
    expect(wf.call?.outputs.url).toMatchObject({
      description: 'The URL',
      value: '${{ jobs.j.outputs.url }}',
    });
    expect(wf.call?.outputs.url?.site?.field).toBe('workflow.output');
    expect(lineCol(wf.call!.inputs.a!.loc)).toBe('4:7-4:8');
  });

  it('reads workflow_dispatch inputs including choice options', () => {
    const wf = parse(yaml`
      on:
        workflow_dispatch:
          inputs:
            env: { type: choice, options: [dev, prod], default: dev }
      jobs: {}
    `);
    expect(wf.dispatch?.inputs.env).toMatchObject({
      type: 'choice',
      options: ['dev', 'prod'],
      hasDefault: true,
    });
  });
});

describe('parseWorkflowFile — jobs', () => {
  const wf = parse(yaml`
    on: push
    env:
      GLOBAL: x
    jobs:
      build:
        runs-on: ubuntu-latest
        env:
          JOB: \${{ github.sha }}
        outputs:
          version: \${{ steps.meta.outputs.version }}
        steps:
          - id: meta
            name: Compute
            run: echo "version=1" >> "$GITHUB_OUTPUT"
          - uses: ./.github/actions/setup
            with:
              v: \${{ steps.meta.outputs.version }}
            env:
              STEP: y
      call:
        needs: build
        if: needs.build.result == 'success'
        uses: ./.github/workflows/other.yml
        with:
          version: \${{ needs.build.outputs.version }}
          flag: true
        secrets: inherit
      list:
        needs: [build, call]
        uses: octo/repo/.github/workflows/x.yml@v1
        secrets:
          token: \${{ secrets.TOKEN }}
  `);

  it('reads needs in scalar and list form', () => {
    expect(wf.jobs.call!.needs.map((n) => n.id)).toEqual(['build']);
    expect(wf.jobs.list!.needs.map((n) => n.id)).toEqual(['build', 'call']);
  });

  it('reads env, outputs, steps and bindings', () => {
    expect(Object.keys(wf.env)).toEqual(['GLOBAL']);
    expect(wf.jobs.build!.env.JOB!.site?.field).toBe('job.env');
    expect(wf.jobs.build!.outputs.version!.site!.segments[0]!.refs[0]!.path).toEqual([
      'meta',
      'outputs',
      'version',
    ]);
    const [s0, s1] = wf.jobs.build!.steps;
    expect(s0).toMatchObject({
      id: 'meta',
      name: 'Compute',
      writesOutputs: { names: ['version'], dynamic: false, mentions: true },
    });
    expect(s1!.uses).toMatchObject({ kind: 'local-action', target: '.github/actions/setup' });
    expect(s1!.with.v!.site?.field).toBe('step.with');
    expect(s1!.env.STEP!.value).toBe('y');
  });

  it('reads reusable calls, literal bindings and secrets: inherit', () => {
    const call = wf.jobs.call!;
    expect(call.uses).toMatchObject({ kind: 'local-workflow', target: '.github/workflows/other.yml' });
    expect(call.with.flag!.value).toBe(true);
    expect(call.with.flag!.site).toBeUndefined();
    expect(call.secretsInherit).toBe(true);
    expect(call.ifSite?.isCondition).toBe(true);
    expect(wf.jobs.list!.uses?.kind).toBe('remote-workflow');
    expect(wf.jobs.list!.secrets.token!.site?.field).toBe('job.secrets');
  });
});

describe('expression locations', () => {
  it('points at the reference inside plain, quoted and block scalars', () => {
    const text = yaml`
      on: push
      jobs:
        j:
          runs-on: x
          if: inputs.a == 'b'
          steps:
            - run: echo \${{ inputs.plain }}
            - run: "echo \${{ inputs.quoted }}"
            - run: |
                echo one
                echo \${{ inputs.block }} \${{ inputs.second }}
            - if: \${{ inputs.wrapped }}
              run: x
    `;
    const wf = parse(text);
    const lines = text.split('\n');
    const all = wf.sites.flatMap((s) => s.segments.flatMap((seg) => seg.refs));
    for (const r of all) {
      const line = lines[r.loc.line - 1]!;
      expect(line.slice(r.loc.column - 1, r.loc.endColumn - 1)).toBe(`inputs.${r.path[0]}`);
    }
    expect(all.map((r) => r.path[0])).toEqual(['a', 'plain', 'quoted', 'block', 'second', 'wrapped']);
  });

  it('classifies bare if: as a condition and boolean if: as a literal', () => {
    const wf = parse(
      'on: push\njobs:\n  j:\n    if: false\n    runs-on: x\n    steps:\n      - if: success()\n        run: x\n',
    );
    expect(wf.jobs.j!.ifSite).toBeUndefined();
    expect(wf.jobs.j!.steps[0]!.ifSite!.segments[0]!.expr.source).toBe('success()');
  });
});

describe('matrix parsing', () => {
  it('records dims, include/exclude entries, dynamic keys and locations', () => {
    const wf = parse(yaml`
      on: push
      jobs:
        j:
          runs-on: x
          strategy:
            matrix:
              os: [a, b]
              node: \${{ fromJSON(inputs.nodes) }}
              include:
                - os: a
                  extra: \${{ inputs.x }}
              exclude:
                - os: b
          steps: []
    `);
    const m = wf.jobs.j!.matrix!;
    expect(m.dims.map((d) => [d.name, d.values])).toEqual([
      ['os', ['a', 'b']],
      ['node', null],
    ]);
    expect(m.include[0]).toMatchObject({ values: { os: 'a' }, dynamicKeys: ['extra'] });
    expect(m.exclude[0]!.values).toEqual({ os: 'b' });
    expect(lineCol(m.loc)).toBe('6:7-6:13');
  });
});

describe('parse errors', () => {
  it('collects YAML errors with locations instead of throwing', () => {
    const wf = parse('on: push\njobs:\n  j:\n    steps: [a\n');
    expect(wf.parseErrors.length).toBeGreaterThan(0);
    expect(wf.parseErrors[0]!.loc.file).toBe('.github/workflows/w.yml');
  });

  it('handles an empty document', () => {
    const wf = parse('');
    expect(wf.jobs).toEqual({});
    expect(wf.triggers).toEqual([]);
  });
});

describe('parseActionFile', () => {
  it('reads inputs, outputs and composite steps', () => {
    const a = parseActionFile(
      '.github/actions/x',
      '.github/actions/x/action.yml',
      yaml`
        name: X
        inputs:
          a: { description: A, required: true }
          b: { description: B, default: 'x' }
        outputs:
          o:
            description: O
            value: \${{ steps.s.outputs.o }}
        runs:
          using: composite
          steps:
            - id: s
              shell: bash
              run: echo "o=\${{ inputs.a }}" >> $GITHUB_OUTPUT
      `,
      createParseContext(),
    );
    expect(a).toMatchObject({ kind: 'action', path: '.github/actions/x', name: 'X', using: 'composite' });
    expect(a.inputs.a?.required).toBe(true);
    expect(a.inputs.b?.hasDefault).toBe(true);
    expect(a.outputs.o?.site?.field).toBe('action.output');
    expect(a.steps[0]!.writesOutputs.names).toEqual(['o']);
    expect(a.sites.find((s) => s.field === 'step.run')?.ownerPath).toBe('.github/actions/x');
  });
});

describe('classifyUses', () => {
  const ctx = createParseContext('Acme/Repo');
  it.each([
    ['./.github/workflows/a.yml', 'job', 'local-workflow', '.github/workflows/a.yml'],
    ['./.github/actions/setup/', 'step', 'local-action', '.github/actions/setup'],
    ['actions/checkout@v4', 'step', 'remote-action', undefined],
    ['other/repo/.github/workflows/a.yml@v1', 'job', 'remote-workflow', undefined],
    ['acme/repo/.github/workflows/a.yml@main', 'job', 'local-workflow', '.github/workflows/a.yml'],
    ['acme/repo/path/to/action@v2', 'step', 'local-action', 'path/to/action'],
    ['docker://alpine:3', 'step', 'docker', undefined],
  ] as const)('%s', (raw, at, kind, target) => {
    const u = classifyUses(raw, at, loc0, ctx);
    expect(u.kind).toBe(kind);
    expect(u.target).toBe(target);
  });

  it('records the ref for same-repo references', () => {
    expect(classifyUses('acme/repo/.github/workflows/a.yml@main', 'job', loc0, ctx).sameRepoRef).toBe('main');
  });
});

describe('scanRunWrites', () => {
  it.each([
    ['echo "a=1" >> "$GITHUB_OUTPUT"', ['a'], false],
    ["echo 'b=2' >> $GITHUB_OUTPUT", ['b'], false],
    ['echo "c<<EOF" >> $GITHUB_OUTPUT', ['c'], false],
    ['echo "x=$(date)" | tee -a $GITHUB_OUTPUT', ['x'], false],
    ['printf "d=%s\\n" "$v" >> "$GITHUB_OUTPUT"', ['d'], false],
    ['"e=1" >> $env:GITHUB_OUTPUT', ['e'], false],
    ['cat out.txt >> $GITHUB_OUTPUT', [], true],
    ['echo "$name=1" >> $GITHUB_OUTPUT', [], true],
    ['{\n  echo a=1\n} >> "$GITHUB_OUTPUT"', [], true],
    ["core.setOutput('f', 1)", ['f'], false],
  ])('%s', (script, names, dynamic) => {
    const r = scanRunWrites(script, 'GITHUB_OUTPUT');
    expect(r.names).toEqual(names);
    expect(r.dynamic).toBe(dynamic);
    expect(r.mentions).toBe(true);
  });

  it('reports scripts that never mention the file', () => {
    expect(scanRunWrites('make build', 'GITHUB_OUTPUT')).toEqual({
      names: [],
      dynamic: false,
      mentions: false,
    });
  });

  it('scans $GITHUB_ENV writes', () => {
    expect(scanRunWrites('echo "TOKEN=abc" >> $GITHUB_ENV', 'GITHUB_ENV').names).toEqual(['TOKEN']);
  });
});
