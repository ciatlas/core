import {
  classifyUses,
  createParseContext,
  evaluateTemplate,
  expandMatrix,
  generatedMarker,
  hasKey,
  type Loc,
  lookup,
  matrixResolver,
  parseActionFile,
  parseWorkflowFile,
  scanRunWrites,
  siteAt,
} from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { WF, yaml } from './helpers';

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
      'on: push\njobs:\n  j:\n    if: false\n    runs-on: x\n    steps:\n      - if: success()\n        run: x\n      - if: false\n        run: y\n',
    );
    expect(wf.jobs.j!.ifSite).toBeUndefined();
    expect(wf.jobs.j!.ifValue).toBe(false);
    expect(wf.jobs.j!.steps[0]!.ifSite!.segments[0]!.expr.source).toBe('success()');
    expect(wf.jobs.j!.steps[0]!.ifValue).toBeUndefined();
    expect(wf.jobs.j!.steps[1]!.ifSite).toBeUndefined();
    expect(wf.jobs.j!.steps[1]!.ifValue).toBe(false);
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

  it('reads $/ as this repository, never the workspace, and keeps a (rejected) @ref apart', () => {
    expect(classifyUses('$/.github/workflows/a.yml', 'job', loc0, ctx)).toMatchObject({
      kind: 'local-workflow',
      target: '.github/workflows/a.yml',
      self: true,
    });
    const step = classifyUses('$/.github/actions/setup/', 'step', loc0, ctx);
    expect(step).toMatchObject({ kind: 'local-action', target: '.github/actions/setup', self: true });
    expect(step.workspacePath).toBeUndefined();
    expect(classifyUses('$/', 'step', loc0, ctx).target).toBe('.');
    expect(classifyUses('$/.github/actions/x@v1', 'step', loc0, ctx)).toMatchObject({
      target: '.github/actions/x',
      selfRef: 'v1',
    });
  });

  it('keeps the workspace path of a step’s ./ reference (a job’s ./ is the repository)', () => {
    expect(classifyUses('./src/app//.github/actions/x', 'step', loc0, ctx).workspacePath).toBe(
      'src/app/.github/actions/x',
    );
    expect(classifyUses('./.github/workflows/a.yml', 'job', loc0, ctx).workspacePath).toBeUndefined();
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
    ['core.setOutput(\'f\', 1); core.setOutput("g", 2); core.setOutput(`h`, 3)', ['f', 'g', 'h'], false],
    ['echo "a=1" >> $GITHUB_OUTPUT; echo "b=2" >> $GITHUB_OUTPUT', ['a', 'b'], false],
    // Writes through an alias of the file, and outputs named by a computed value, are not followed.
    ['OUT=$GITHUB_OUTPUT\necho "a=1" >> "$OUT"', [], true],
    ['export OUT="${GITHUB_OUTPUT}"', [], true],
    ['core.setOutput(name, 1)', [], true],
    ['core.setOutput(`out-${kind}`, 1)', [], true],
    ["core.setOutput('a' + suffix, 1)", [], true],
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

describe('permissions', () => {
  it('reads a shorthand or a scope map, and skips what GitHub does not accept', () => {
    const wf = parse(yaml`
      on: push
      permissions: read-all
      jobs:
        map:
          runs-on: x
          permissions:
            contents: read
            issues: write
            pages: none
            packages: admin
          steps: []
        none:
          runs-on: x
          permissions: {}
          steps: []
        all:
          runs-on: x
          permissions: write-all
          steps: []
        level:
          runs-on: x
          permissions: read
          steps: []
        list:
          runs-on: x
          permissions: [contents]
          steps: []
        unset:
          runs-on: x
          steps: []
    `);
    expect(wf.permissions).toBe('read-all');
    expect(wf.jobs.map!.permissions).toEqual({ contents: 'read', issues: 'write', pages: 'none' });
    expect(wf.jobs.none!.permissions).toEqual({});
    expect(wf.jobs.all!.permissions).toBe('write-all');
    expect(wf.jobs.level!.permissions).toBeUndefined();
    expect(wf.jobs.list!.permissions).toBeUndefined();
    expect(wf.jobs.unset!.permissions).toBeUndefined();
  });
});

describe('YAML anchors and aliases', () => {
  const wf = parse(yaml`
    on: push
    env:
      DEF: &def ci-default.json
      EXPR: &e \${{ inputs.x }}
      AGAIN: *e
    jobs:
      a:
        runs-on: x
        strategy: &strat
          matrix:
            os: [&u ubuntu-latest, windows-latest]
            include:
              - &linux { os: *u, config: *def }
        steps: [{ run: echo }]
      b:
        runs-on: x
        strategy: *strat
        steps: [{ run: echo }]
      c:
        runs-on: x
        strategy:
          matrix:
            include: [*linux, { os: windows-latest, config: ci-windows.json }]
        steps: [{ run: echo }]
  `);

  it('resolves them the way GitHub does, so an aliased strategy, entry or value keeps its keys', () => {
    expect(wf.jobs.b!.matrix!.dims.map((d) => [d.name, d.values])).toEqual([
      ['os', ['ubuntu-latest', 'windows-latest']],
    ]);
    expect(wf.jobs.a!.matrix!.include.map((e) => e.values)).toEqual([
      { os: 'ubuntu-latest', config: 'ci-default.json' },
    ]);
    expect(wf.jobs.c!.matrix!.include.map((e) => e.values)).toEqual([
      { os: 'ubuntu-latest', config: 'ci-default.json' },
      { os: 'windows-latest', config: 'ci-windows.json' },
    ]);
  });

  it('locates aliased content at its anchor, and finds an aliased expression at each use', () => {
    expect(lineCol(wf.jobs.b!.matrix!.loc)).toBe(lineCol(wf.jobs.a!.matrix!.loc));
    expect(wf.env.AGAIN).toMatchObject({
      value: '${{ inputs.x }}',
      site: { field: 'workflow.env', key: 'AGAIN' },
    });
    expect(lineCol(wf.env.AGAIN!.site!.loc)).toBe('4:12-4:27');
    expect(wf.sites.map((s) => s.yamlPath.join('.'))).toEqual(['env.EXPR', 'env.AGAIN']);
  });

  it('leaves aliases unresolved in a file with YAML errors', () => {
    const bad = parse('on: push\nenv:\n  A: &a x\n  B: *a\n  C: [\n');
    expect(bad.parseErrors).toHaveLength(1);
    // What the parser recovers for the unclosed `C: [` is its own business; only the alias matters here.
    expect(bad.env.A!.value).toBe('x');
    expect(bad.env.B!.value).toBeNull();
  });
});

describe('expression sites of an action', () => {
  it('classifies each field, with its key, step and whether it is a condition', () => {
    const action = parseActionFile(
      '.github/actions/x',
      '.github/actions/x/action.yml',
      yaml`
        name: \${{ inputs.n }}
        inputs:
          dir:
            default: \${{ github.workspace }}
        outputs:
          o:
            value: \${{ steps.s.outputs.o }}
        runs:
          using: composite
          pre-if: runner.os == 'Linux'
          post-if: \${{ always() }}
          steps:
            - id: s
              if: inputs.dir != ''
              working-directory: \${{ inputs.dir }}
              run: echo \${{ inputs.dir }}
              shell: bash
              env:
                D: \${{ inputs.dir }}
            - uses: some/action@v1
              with:
                w: \${{ inputs.dir }}
      `,
      createParseContext(),
    );
    expect(
      action.sites.map(
        (s) =>
          `${s.yamlPath.join('.')}: ${s.field}${s.key ? ` [${s.key}]` : ''}${s.step !== undefined ? ` #${s.step}` : ''}${s.isCondition ? ' (condition)' : ''}`,
      ),
    ).toEqual([
      'name: other',
      'inputs.dir.default: input.default [dir]',
      'outputs.o.value: action.output [o]',
      'runs.pre-if: action.runs-if (condition)',
      'runs.post-if: action.runs-if (condition)',
      'runs.steps.0.if: step.if #0 (condition)',
      'runs.steps.0.working-directory: step.other #0',
      'runs.steps.0.run: step.run #0',
      'runs.steps.0.env.D: step.env [D] #0',
      'runs.steps.1.with.w: step.with [w] #1',
    ]);
    expect(action.steps[0]!.ifSite!.segments[0]!.expr.source).toBe("inputs.dir != ''");
  });
});

describe('reference locations', () => {
  it('falls back to the expression’s own offsets when the source spells a reference with escapes', () => {
    // `\u0062` is `b`: the reference reads `inputs.ab`, which the source does not contain as written.
    const wf = parse(
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: "echo ${{ inputs.a\\u0062 }} ${{ inputs.c }}"\n',
    );
    const [site] = wf.sites;
    expect(site!.text).toBe('echo ${{ inputs.ab }} ${{ inputs.c }}');
    expect(site!.segments.map((s) => s.refs.map((r) => `${r.path[0]} ${lineCol(r.loc)}`))).toEqual([
      ['ab 6:24-6:33'],
      ['c 6:46-6:54'],
    ]);
  });
});

describe('scripts of actions/github-script', () => {
  /** The step `s` of a job, which runs `script` with `uses`. */
  const step = (script: string, uses = 'actions/github-script@v8') =>
    parse(
      `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: s\n        uses: ${uses}\n        with:\n          script: |\n${script
        .split('\n')
        .map((l) => `            ${l}`)
        .join('\n')}\n`,
    ).jobs.j!.steps[0]!;

  it('names the outputs a script sets, and the `result` github-script always sets', () => {
    expect(step("core.setOutput('other', 1);").writesOutputs).toEqual({
      names: ['other', 'result'],
      dynamic: false,
      mentions: true,
    });
    expect(step('return 1;').writesOutputs).toEqual({ names: ['result'], dynamic: false, mentions: true });
    // `core` in strings and comments is not handed to anything.
    expect(
      step(
        "core.setOutput('other', 1); // core is not passed on\ncore.info('pass core along');\ncore?.notice(\"core\");",
      ).writesOutputs,
    ).toEqual({ names: ['other', 'result'], dynamic: false, mentions: true });
  });

  it('reads the variables a script exports', () => {
    expect(step("core.exportVariable('TOKEN', t);\ncore.setOutput('o', 1);").writesEnv).toEqual({
      names: ['TOKEN'],
      dynamic: false,
    });
  });

  it.each([
    // grafana detect-breaking-changes-levitate.yml
    "const script = require('./.github/workflows/scripts/levitate/json-file-to-job-output.js');\nawait script({ core, filePath: 'result.json' });",
    // getsentry sentry-pull-request-bot.yml
    'const { waitForMergeCommit } = await import(`${process.env.GITHUB_WORKSPACE}/scripts/wait.js`);\nawait waitForMergeCommit({ github, context, core });',
    // gh-aw lock files
    "const { setupGlobals } = require(path.join(dir, 'setup_globals.cjs'));\nsetupGlobals(core, github, context);",
    "core.setOutput('other', 1);\nawait helper(core);",
    "core.setOutput('other', 1);\nconst c = core;\nc['setOutput']('wanted', 2);",
    "core.setOutput('other', 1);\nconst { setOutput } = core;",
    'for (const [k, v] of Object.entries(values)) core.setOutput(k, v);',
    "core.setOutput('other', 1);\neval(code);",
    "core.setOutput('other', 1);\nconst f = new Function('core', body);",
    // A static import cannot run inside github-script's function wrapper (it is a SyntaxError there), so the script
    // is taken as one flowpact cannot follow, even for a built-in it would otherwise allow.
    "import fs from 'fs';\ncore.setOutput('other', 1);",
    "const t = `${ `b` } don't`;\nconst r = require('./x.js');\ncore.setOutput('other', 1);",
    "const { execSync } = require('child_process');\ncore.setOutput('other', execSync('./out.sh'));",
    // fs is not delegation, but a computed write to the file is.
    "const fs = require('fs');\nfs.appendFileSync(process.env.GITHUB_OUTPUT, line);\ncore.setOutput('other', 1);",
    // The program inherits GITHUB_OUTPUT and may write to it.
    "await exec.exec('./set-outputs.sh');\ncore.setOutput('other', 1);",
    "core.setOutput('other', 1);\nconst msg = `${await helper(core)}`;",
    // Code substituted into the script by an expression may set any output.
    "core.setOutput('other', 1);\n${{ inputs.code }}",
  ])('marks a script whose writes it cannot see as dynamic: %s', (script) => {
    expect(step(script).writesOutputs.dynamic).toBe(true);
  });

  it.each([
    // Prose in a template literal is not code (`core`, `import` and `require` are words there).
    "const body = `The core team will review`;\ncore.setOutput('other', body);",
    "const body = `Note:\nimport the new config`;\ncore.setOutput('other', body);",
    "const url = `https://github.com/home-assistant/core/issues/new?title=${encodeURIComponent(t)}`;\ncore.setOutput('other', url);",
    "const t = `a ${ `b ${ 'require(x)' }` } c don't`;\ncore.setOutput('other', t);",
    "/* require('x') and core */ const s = 'it\\'s core';\ncore.setOutput('other', s);",
    "const s = `a \\` require('x') core`;\ncore.setOutput('other', s);",
    "core.setOutput('other', 1);\nconst s = `an unclosed template with core in it",
    // Built-ins that cannot run other code.
    "const fs = require('fs');\nconst path = require(\"node:path\");\ncore.setOutput('other', fs.readFileSync(path.join('a', 'b'), 'utf8'));",
    "const { readFile } = await import('fs/promises');\ncore.setOutput('other', await readFile('x', 'utf8'));",
    "const opts = { arguments: [] };\ncore.setOutput('other', opts);",
    // An expression inside a literal is text.
    "const who = '${{ inputs.core }}';\nconst hi = `Hello ${{ github.actor }}`;\ncore.setOutput('other', who + hi);",
  ])('reads only the code of a script: %s', (script) => {
    expect(step(script).writesOutputs).toEqual({
      names: ['other', 'result'],
      dynamic: false,
      mentions: true,
    });
  });

  it('marks a whole script from an expression as dynamic', () => {
    const wf = parse(yaml`
      on: workflow_dispatch
      jobs:
        j:
          runs-on: x
          steps:
            - id: s
              uses: actions/github-script@v8
              with:
                script: \${{ inputs.code }}
    `);
    expect(wf.jobs.j!.steps[0]!.writesOutputs).toEqual({ names: ['result'], dynamic: true, mentions: true });
  });

  it('lets other actions that take a script set outputs of their own', () => {
    expect(step("core.setOutput('other', 1);", 'acme/run-js@v1').writesOutputs).toEqual({
      names: ['other'],
      dynamic: true,
      mentions: true,
    });
    expect(step("core.exportVariable('A', 1);", 'acme/run-js@v1').writesEnv).toEqual({
      names: ['A'],
      dynamic: false,
    });
  });

  it('finds no writes in a step without a script', () => {
    const wf = parse(
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n',
    );
    expect(wf.jobs.j!.steps[0]).toMatchObject({
      writesOutputs: { names: [], dynamic: false, mentions: false },
      writesEnv: { names: [], dynamic: false },
    });
  });
});

describe('generatedMarker', () => {
  it.each([
    [
      '# This file was automatically generated by gh-aw (v0.87.10). DO NOT EDIT.\nname: x\n',
      'This file was automatically generated',
    ],
    ['# AUTOGENERATED FILE - DO NOT EDIT MANUALLY\nname: x\n', 'AUTOGENERATED FILE'],
    ['# Owner(s): ["oncall: releng"]\n# @generated DO NOT EDIT MANUALLY\n\nname: x\n', '@generated'],
    ['# generated by praktika\n\nname: x\n', 'generated by praktika'],
    ['# Generated from xtask::workflows::danger\nname: x\n', 'Generated from xtask::workflows::danger'],
    ['# This workflow was generated from ci.yml.j2\nname: x\n', 'This workflow was generated'],
    ['---\n# Code generated by gen-ci. DO NOT EDIT.\nname: x\n', 'Code generated by gen-ci.'],
    ['# This is an auto-generated file.\nname: x\n', 'This is an auto-generated file'],
    ['# Please do not edit this file by hand.\nname: x\n', 'do not edit this file'],
    ['# DO NOT EDIT\nname: x\n', 'DO NOT EDIT'],
    ['# DO NOT MODIFY. Rendered from templates/ci.yml\nname: x\n', 'DO NOT MODIFY'],
    ['%YAML 1.2\n---\n# DO NOT EDIT - rendered by make workflows\nname: x\n', 'DO NOT EDIT'],
    // gh-aw puts long metadata lines first.
    [
      '# gh-aw-metadata: {"a":1}\n# gh-aw-manifest: {"b":2}\n# This file was automatically generated by gh-aw. DO NOT EDIT.\non: push\n',
      'This file was automatically generated',
    ],
    ['\uFEFF# auto-generated from ci.yml.j2\r\non: push\r\n', 'auto-generated from ci.yml.j2'],
  ])('finds the marker in %j', (text, marker) => {
    expect(generatedMarker(`${WF}/w.yml`, text)).toBe(marker);
  });

  it.each([
    ['name: x\n# DO NOT EDIT the job names, they are required checks\non: push\n'],
    ['# Owner(s): x\nname: linux-binary-test\n\n# /run.sh is generated by binary_linux_test.sh\non: push\n'],
    [
      '# The real workflow is generated by praktika from ci/workflows/x.py, which replaces this file.\nname: x\n',
    ],
    [`${'# license\n'.repeat(10)}# DO NOT EDIT\nname: x\n`],
    ['on: push\n'],
    ['name: x # DO NOT EDIT\non: push\n'],
    // Hand-written headers that talk about generated things, or ask not to edit something specific.
    ['# Generated docs are published to GitHub Pages by this workflow.\non: push\n'],
    ['# Please do not edit the deploy keys without asking #infra.\non: push\n'],
    ['# Builds the autogenerated API client\non: push\n'],
    ['# Generated-by: none; this is hand written\non: push\n'],
    ['# Generated files are uploaded to the release by this workflow\non: push\n'],
    ['# DO NOT EDIT the job names, they are required checks\non: push\n'],
    ['# DO NOT MODIFY the cron schedule without asking #infra\non: push\n'],
    ['# Deploys the site generated by Hugo\non: push\n'],
  ])('ignores %j', (text) => {
    expect(generatedMarker(`${WF}/w.yml`, text)).toBeUndefined();
  });

  it('recognizes GitHub Agentic Workflows lock files by name, and generated actions', () => {
    expect(generatedMarker(`${WF}/triage.lock.yml`, 'on: push\n')).toBe('.lock.yml');
    expect(generatedMarker('.github/actions/x/action.yml', '# DO NOT EDIT\nruns: {}\n')).toBe('DO NOT EDIT');
  });

  it('records the marker on the parsed workflow or action', () => {
    expect(parse('# DO NOT EDIT\non: push\njobs: {}\n').generated).toBe('DO NOT EDIT');
    expect(parse('on: push\njobs: {}\n').generated).toBeUndefined();
    const action = parseActionFile(
      '.github/actions/x',
      '.github/actions/x/action.yml',
      '# @generated\nruns: { using: composite, steps: [] }\n',
      createParseContext(),
    );
    expect(action.generated).toBe('@generated');
  });
});

describe('IR lookups', () => {
  it('looks keys up case-insensitively, as GitHub resolves context properties, exact spelling first', () => {
    const rec: Record<string, number> = { Build: 1, build: 2, zero: 0 };
    expect(lookup(rec, 'build')).toBe(2);
    expect(lookup(rec, 'BUILD')).toBe(1);
    expect(lookup(rec, 'test')).toBeUndefined();
    expect(hasKey(rec, 'ZERO')).toBe(true);
    expect(hasKey(rec, 'test')).toBe(false);
  });

  // Object.prototype members are not keys: `matrix.constructor` in a combination without that key is missing, and a
  // nested lookup never returns a function as a JSON value.
  it('finds only the record’s own keys', () => {
    const rec: Record<string, number> = { a: 1 };
    expect(lookup(rec, 'toString')).toBeUndefined();
    expect(hasKey(rec, 'constructor')).toBe(false);
    expect(hasKey(rec, '__proto__')).toBe(false);
    const [combo] = expandMatrix(
      parse(
        'on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n      matrix:\n        os: [linux]\n    steps: []\n',
      ).jobs.j!.matrix,
    ).combos;
    expect(evaluateTemplate('${{ matrix.constructor }}', matrixResolver(combo!))).toEqual({
      known: true,
      value: null,
      taint: [{ kind: 'missing-matrix-key', key: 'constructor' }],
    });
  });

  it('finds the site a parser diagnostic points at, by the start of its scalar', () => {
    const wf = parse(
      'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: "echo ${{ inputs.a }}"\n      - run: echo ${{ inputs.b }}\n',
    );
    // The first scalar starts at its quote (6:14); the parser may count from the quote or the text after it.
    expect(siteAt(wf.sites, { line: 6, column: 14 })?.text).toBe('echo ${{ inputs.a }}');
    expect(siteAt(wf.sites, { line: 6, column: 15 })?.text).toBe('echo ${{ inputs.a }}');
    expect(siteAt(wf.sites, { line: 6, column: 16 })).toBeUndefined();
    expect(siteAt(wf.sites, { line: 7, column: 14 })?.text).toBe('echo ${{ inputs.b }}');
    expect(siteAt(wf.sites, { line: 5, column: 14 })).toBeUndefined();
  });
});
