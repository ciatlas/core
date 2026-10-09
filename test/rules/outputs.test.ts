import { describe, expect, it } from 'vitest';
import { at, byCode, lint, WF, yaml } from '../helpers';

const pipeline = (consumer: string) => yaml`
  on: push
  jobs:
    build:
      runs-on: x
      outputs:
        version: \${{ steps.meta.outputs.version }}
        unused: x
      steps:
        - id: meta
          run: echo "version=1" >> $GITHUB_OUTPUT
    call:
      uses: ./.github/workflows/lib.yml
    consume:
      needs: [build, call]
      runs-on: x
      steps:
        - run: ${consumer}
`;

const lib = yaml`
  on:
    workflow_call:
      outputs:
        url:
          value: \${{ jobs.j.outputs.url }}
        dead:
          value: \${{ jobs.j.outputs.url }}
  jobs:
    j:
      runs-on: x
      outputs:
        url: \${{ steps.s.outputs.url }}
      steps:
        - id: s
          run: echo "url=x" >> $GITHUB_OUTPUT
`;

describe('FP301 undefined-output-ref', () => {
  it('flags unknown job outputs and reusable workflow outputs', () => {
    const r = lint({
      [`${WF}/p.yml`]: pipeline(
        'echo ${{ needs.build.outputs.versoin }} ${{ needs.call.outputs.uri }} ${{ needs.call.outputs.url }}',
      ),
      [`${WF}/lib.yml`]: lib,
    });
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      'jobs.build has no output "versoin" — did you mean "version"?',
      'jobs.call has no output "uri" — did you mean "url"?',
    ]);
  });

  it('flags workflow outputs that point at missing jobs or outputs', () => {
    const broken = lint({
      [`${WF}/lib.yml`]: lib
        .replace(
          'url:\n        value: ${{ jobs.j.outputs.url }}',
          'url:\n        value: ${{ jobs.k.outputs.url }}',
        )
        .replace(
          'dead:\n        value: ${{ jobs.j.outputs.url }}',
          'dead:\n        value: ${{ jobs.j.outputs.nope }}',
        ),
    });
    const r = broken;
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      '.github/workflows/lib.yml has no job "k"',
      'jobs.j has no output "nope"',
    ]);
  });

  it('flags missing step ids and steps that run later', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            outputs:
              a: \${{ steps.nope.outputs.a }}
            steps:
              - run: echo \${{ steps.later.outputs.x }}
              - id: later
                run: echo "x=1" >> $GITHUB_OUTPUT
              - run: echo \${{ steps.later.outputs.x }}
      `,
    });
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      'No step with id "nope" in jobs.j',
      'Step "later" runs after this step, so its outputs are not available yet',
    ]);
  });

  it('checks outputs of local actions', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: a\n        uses: ./.github/actions/a\n      - run: echo ${{ steps.a.outputs.missing }}\n',
      '.github/actions/a/action.yml':
        'outputs:\n  present:\n    value: x\nruns:\n  using: composite\n  steps: []\n',
    });
    expect(byCode(r, 'FP301')[0]?.message).toBe('.github/actions/a has no output "missing"');
  });

  it('does not judge remote reusable workflows', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  r:\n    uses: o/r/.github/workflows/x.yml@v1\n  c:\n    needs: r\n    runs-on: x\n    steps:\n      - run: echo ${{ needs.r.outputs.any }}\n',
    });
    expect(byCode(r, 'FP301')).toEqual([]);
  });
});

describe('FP302 output-ref-without-needs', () => {
  it('flags needs.<job> reads without a needs edge, and unknown jobs', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            outputs: { v: x }
            steps: [{ run: x }]
          b:
            runs-on: x
            steps:
              - run: echo \${{ needs.a.outputs.v }} \${{ needs.ghost.result }}
      `,
    });
    const fs = byCode(r, 'FP302');
    expect(fs.map((f) => f.message)).toEqual([
      'jobs.b reads needs.a but does not list "a" under needs',
      'jobs.b reads needs.ghost, but .github/workflows/w.yml has no job "ghost"',
    ]);
    expect(fs[0]!.fix).toBe('Add "a" to jobs.b.needs.');
  });

  // GitHub, checked with a workflow: a job's own `if:` sees jobs it depends on through its needs; steps, env, with:,
  // name and the matrix do not (the value is empty there).
  it('accepts a job-level if that reads a job it depends on indirectly, and flags the other places', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          setup:
            runs-on: x
            outputs: { v: x }
            steps: [{ run: x }]
          middle:
            needs: setup
            runs-on: x
            steps: [{ run: x }]
          leaf:
            needs: middle
            if: needs.setup.outputs.v == 'hello'
            runs-on: x
            env:
              V: \${{ needs.setup.outputs.v }}
            steps:
              - if: needs.setup.outputs.v == 'hello'
                run: echo \${{ needs.setup.outputs.v }}
          call:
            needs: middle
            uses: ./.github/workflows/lib.yml
            with:
              x: \${{ needs.setup.outputs.v }}
          apart:
            runs-on: x
            if: needs.setup.result == 'success'
            steps: [{ run: x }]
      `,
      [`${WF}/lib.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              x: { type: string, required: false }
        jobs:
          j: { runs-on: x, steps: [{ run: 'echo \${{ inputs.x }}' }] }
      `,
    });
    const at = (f: { loc: { line: number } }) => f.loc.line;
    const fs = byCode(r, 'FP302');
    // leaf's job-level if (line 13) is fine; its env (16), step if (18) and run (19), and call's with: (24) are not.
    expect(fs.filter((f) => f.message.includes('only the job')).map(at)).toEqual([16, 18, 19, 24]);
    expect(fs.find((f) => at(f) === 16)!.message).toBe(
      'jobs.leaf reads needs.setup, which is empty here: "setup" is not under needs, and only the job\'s `if:` sees jobs it depends on indirectly',
    );
    // A job that does not depend on setup at all is flagged even in its own if.
    expect(fs.filter((f) => at(f) === 27).map((f) => f.message)).toEqual([
      'jobs.apart reads needs.setup but does not list "setup" under needs',
    ]);
  });
});

describe('FP303 unused-output', () => {
  // `_`-prefixed reusable workflows are internal by convention; lib.yml is published.
  const internal = (consumer: string) => ({
    [`${WF}/p.yml`]: pipeline(consumer).replace('workflows/lib.yml', 'workflows/_lib.yml'),
    [`${WF}/_lib.yml`]: lib,
  });

  it('flags unread job outputs and outputs of an internal workflow no caller reads', () => {
    const r = lint(internal('echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }}'));
    expect(byCode(r, 'FP303').map((f) => f.message)).toEqual([
      'Workflow output "dead" of .github/workflows/_lib.yml is not read by any of its 1 caller',
      'Output "unused" of jobs.build is never read',
    ]);
  });

  it('does not judge outputs of a published reusable workflow, whose callers live elsewhere (#40)', () => {
    const r = lint({
      [`${WF}/p.yml`]: pipeline('echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }}'),
      [`${WF}/lib.yml`]: lib,
    });
    expect(byCode(r, 'FP303').map((f) => f.message)).toEqual(['Output "unused" of jobs.build is never read']);
  });

  it('follows impact.publish when it lists the published units', () => {
    const files = {
      [`${WF}/p.yml`]: pipeline('echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }}'),
      [`${WF}/lib.yml`]: lib,
    };
    const listed = lint(files, { config: { impact: { publish: ['.github/workflows/lib.yml'] } } });
    expect(byCode(listed, 'FP303').map((f) => f.symbol)).toEqual([`${WF}/p.yml#jobs.build.outputs.unused`]);
    const other = lint(files, { config: { impact: { publish: ['action.yml'] } } });
    expect(byCode(other, 'FP303').map((f) => f.symbol)).toEqual([
      `${WF}/lib.yml#outputs.dead`,
      `${WF}/p.yml#jobs.build.outputs.unused`,
    ]);
    expect(byCode(other, 'FP303')[0]?.fix).toBe(
      'Remove the output, or make a caller read it. If other repositories use this workflow, add ".github/workflows/lib.yml" to `impact.publish`.',
    );
    expect(byCode(other, 'FP303')[1]?.fix).toBe('Remove the output, or make the intended consumer read it.');
  });

  it('does not judge workflow outputs without local callers', () => {
    const r = lint({ [`${WF}/_lib.yml`]: lib });
    expect(byCode(r, 'FP303')).toEqual([]);
  });

  const actionUser = (read: string) =>
    `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: a\n        uses: ./.github/actions/a\n      - run: echo ${read}\n`;
  const action =
    'outputs:\n  used:\n    value: x\n  dead:\n    value: y\nruns:\n  using: composite\n  steps: []\n';

  it('flags outputs of an internal action that no user reads', () => {
    const r = lint({
      [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}'),
      '.github/actions/a/action.yml': action,
    });
    expect(byCode(r, 'FP303').map((f) => f.symbol)).toEqual(['.github/actions/a#outputs.dead']);
  });

  it('does not judge outputs of a published action', () => {
    const root = lint({
      [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}').replace('./.github/actions/a', './'),
      'action.yml': action,
    });
    expect(byCode(root, 'FP303')).toEqual([]);
    const unlisted = lint(
      {
        [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}').replace('./.github/actions/a', './'),
        'action.yml': action,
      },
      { config: { impact: { publish: ['.github/workflows/*.yml'] } } },
    );
    expect(byCode(unlisted, 'FP303').map((f) => f.symbol)).toEqual(['.#outputs.dead']);
    const listed = lint(
      { [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}'), '.github/actions/a/action.yml': action },
      { config: { impact: { publish: ['.github/actions/a'] } } },
    );
    expect(byCode(listed, 'FP303')).toEqual([]);
  });

  it('counts a whole outputs object as reading every output', () => {
    for (const consumer of [
      'echo ${{ toJSON(needs.build.outputs) }} ${{ toJSON(needs.call.outputs) }}',
      "echo ${{ format('{0}', needs.build.outputs) }} ${{ fromJSON(toJSON(needs.call)).outputs.url }}",
      'echo ${{ needs.build.outputs[matrix.key] }} ${{ needs.call.outputs[inputs.which] }}',
      'echo ${{ needs.build.outputs.* }} ${{ toJSON(needs.*.outputs) }}',
    ]) {
      expect({ consumer, findings: byCode(lint(internal(consumer)), 'FP303') }).toEqual({
        consumer,
        findings: [],
      });
    }
  });

  it('still judges the other jobs when one job is read through a computed key', () => {
    const r = lint(internal('echo ${{ needs.call.outputs[matrix.key] }}'));
    expect(byCode(r, 'FP303').map((f) => f.message)).toEqual([
      'Output "version" of jobs.build is never read',
      'Output "unused" of jobs.build is never read',
    ]);
  });

  it('does not count needs.<job>.result as reading outputs', () => {
    const r = lint(internal('echo ${{ needs.build.result }} ${{ needs.call.outputs.url }}'));
    expect(byCode(r, 'FP303').map((f) => f.symbol)).toEqual([
      `${WF}/_lib.yml#outputs.dead`,
      `${WF}/p.yml#jobs.build.outputs.version`,
      `${WF}/p.yml#jobs.build.outputs.unused`,
    ]);
  });

  it('counts toJSON(needs.<job>.outputs) in a run: step as reading every output', () => {
    const r = lint({
      [`${WF}/main.yml`]: yaml`
        on: push
        jobs:
          dlart:
            runs-on: ubuntu-latest
            outputs:
              one: \${{ steps.s.outputs.one }}
            steps:
              - id: s
                run: echo "one=1" >> "$GITHUB_OUTPUT"
          use:
            needs: dlart
            runs-on: ubuntu-latest
            steps:
              - run: echo '\${{ toJSON(needs.dlart.outputs) }}'
      `,
    });
    expect(byCode(r, 'FP303')).toEqual([]);
  });

  it('counts whole step and workflow-output objects', () => {
    const steps = lint({
      [`${WF}/w.yml`]: actionUser('${{ toJSON(steps.a.outputs) }}'),
      '.github/actions/a/action.yml': action,
    });
    expect(byCode(steps, 'FP303')).toEqual([]);
    for (const value of ['${{ toJSON(jobs.j.outputs) }}', '${{ jobs.j.outputs[inputs.which] }}']) {
      const wf = lint({
        ...internal(
          'echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }} ${{ needs.call.outputs.dead }}',
        ),
        [`${WF}/_lib.yml`]: lib
          .replace('url:\n        value: ${{ jobs.j.outputs.url }}', `url:\n        value: ${value}`)
          .replace('url: ${{ steps.s.outputs.url }}', 'url: ${{ steps.s.outputs.url }}\n      extra: x'),
      });
      expect({ value, symbols: byCode(wf, 'FP303').map((f) => f.symbol) }).toEqual({
        value,
        symbols: [`${WF}/p.yml#jobs.build.outputs.unused`],
      });
    }
  });
});

describe('FP303 unused-output: whole steps and published actions', () => {
  const setup =
    'name: setup\noutputs:\n  a: { value: x, description: a }\n  b: { value: y, description: b }\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n';
  const job = (steps: string) => ({
    [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n${steps}`,
    '.github/actions/setup/action.yml': setup,
  });

  it('counts toJSON(steps) as reading only the steps that ran before', () => {
    const before = lint(
      job(
        "    steps:\n      - run: echo '${{ toJSON(steps) }}'\n      - id: s\n        uses: ./.github/actions/setup\n",
      ),
    );
    expect(byCode(before, 'FP303').map((f) => f.symbol)).toEqual([
      '.github/actions/setup#outputs.a',
      '.github/actions/setup#outputs.b',
    ]);
    const after = lint(
      job(
        "    steps:\n      - id: s\n        uses: ./.github/actions/setup\n      - run: echo '${{ toJSON(steps) }}'\n",
      ),
    );
    expect(byCode(after, 'FP303')).toEqual([]);
    // A job output is evaluated after every step.
    const output = lint(
      job(
        '    outputs:\n      all: ${{ toJSON(steps) }}\n    steps:\n      - id: s\n        uses: ./.github/actions/setup\n',
      ),
    );
    expect(byCode(output, 'FP303').map((f) => f.symbol)).toEqual([`${WF}/w.yml#jobs.j.outputs.all`]);
  });

  it('points at impact.publish for an action in a subdirectory that other repositories may use', () => {
    const files = {
      'action.yml':
        'name: cache\noutputs:\n  cache-hit: { value: x, description: d }\nruns: { using: node20, main: dist/index.js }\n',
      'restore/action.yml':
        'name: restore\noutputs:\n  cache-hit: { value: x, description: d }\n  cache-key: { value: x, description: d }\nruns: { using: node20, main: dist/restore.js }\n',
      [`${WF}/test.yml`]:
        'on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - uses: ./\n      - id: r\n        uses: ./restore\n      - run: echo ${{ steps.r.outputs.cache-hit }}\n',
    };
    const [f, ...rest] = byCode(lint(files), 'FP303');
    expect(rest).toEqual([]);
    expect(f?.message).toBe('Output "cache-key" of restore is not read by any of its 1 user');
    expect(f?.fix).toBe(
      'Remove the output, or make a user read it. If other repositories use this action, set `impact.publish` to the units they use, "restore/action.yml" included; it replaces the default (reusable workflows and the root action.yml).',
    );
    const listed = lint(files, { config: { impact: { publish: ['action.yml', 'restore/action.yml'] } } });
    expect(byCode(listed, 'FP303')).toEqual([]);
    const other = lint(files, { config: { impact: { publish: ['action.yml'] } } });
    expect(byCode(other, 'FP303')[0]?.fix).toBe(
      'Remove the output, or make a user read it. If other repositories use this action, add "restore/action.yml" to `impact.publish`.',
    );
  });
});

describe('FP304 step-output-never-written', () => {
  it('flags outputs the inline script never writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: pipeline('x').replace('steps.meta.outputs.version', 'steps.meta.outputs.ver'),
    });
    const [f] = byCode(r, 'FP304');
    expect(f?.message).toBe(
      'Step "meta" never writes output "ver" (it writes version) — did you mean "version"?',
    );
    expect(at(f!)).toBe(`${WF}/w.yml:6:20`);
  });

  it('stays quiet for dynamic writes and scripts that do not mention GITHUB_OUTPUT', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            outputs:
              a: \${{ steps.dyn.outputs.a }}
              b: \${{ steps.ext.outputs.b }}
            steps:
              - id: dyn
                run: cat out.env >> "$GITHUB_OUTPUT"
              - id: ext
                run: ./script.sh
      `,
    });
    expect(byCode(r, 'FP304')).toEqual([]);
  });

  /** A job whose github-script step `s` runs `script`, and a later step that reads `steps.s.outputs.wanted`. */
  const scripted = (script: string, uses = 'actions/github-script@v8') => ({
    [`${WF}/w.yml`]: `on: push
jobs:
  j:
    runs-on: x
    steps:
      - id: s
        uses: ${uses}
        with:
          script: |
${script
  .split('\n')
  .map((l) => `            ${l}`)
  .join('\n')}
      - run: echo \${{ steps.s.outputs.wanted }}
`,
  });

  it('flags github-script steps whose script sets other outputs by name', () => {
    for (const script of [
      "core.setOutput('other', 1);",
      // `core` in strings and comments is not handed to anything.
      "core.setOutput('other', 1); // core is not passed on\ncore.info('pass core along');\ncore?.notice(\"core\");",
    ]) {
      const [f] = byCode(lint(scripted(script)), 'FP304');
      expect(f?.message).toBe('Step "s" never writes output "wanted" (it writes other, result)');
    }
    expect(byCode(lint(scripted('return 1;')), 'FP304')[0]?.message).toBe(
      'Step "s" never writes output "wanted" (it writes result)',
    );
  });

  it('does not judge github-script steps whose writes it cannot see', () => {
    for (const script of [
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
      'core.setOutput(`out-${kind}`, 1);',
      "core.setOutput('other', 1);\neval(code);",
    ]) {
      expect({ script, findings: byCode(lint(scripted(script)), 'FP304') }).toEqual({ script, findings: [] });
    }
  });

  it('reads only the code of template literals and ignores Node built-ins', () => {
    for (const script of [
      // Prose in a template literal is not code (`core`, `import` and `require` are words there).
      "const body = `The core team will review`;\ncore.setOutput('other', body);",
      "const body = `Note:\nimport the new config`;\ncore.setOutput('other', body);",
      "const url = `https://github.com/home-assistant/core/issues/new?title=${encodeURIComponent(t)}`;\ncore.setOutput('other', url);",
      "const t = `a ${ `b ${ 'require(x)' }` } c don't`;\ncore.setOutput('other', t);",
      // Built-ins that cannot run other code.
      "const fs = require('fs');\nconst path = require(\"node:path\");\ncore.setOutput('other', fs.readFileSync(path.join('a', 'b'), 'utf8'));",
      "const { readFile } = await import('fs/promises');\ncore.setOutput('other', await readFile('x', 'utf8'));",
      "const opts = { arguments: [] };\ncore.setOutput('other', opts);",
      // An expression inside a literal is text.
      "const who = '${{ inputs.core }}';\nconst hi = `Hello ${{ github.actor }}`;\ncore.setOutput('other', who + hi);",
    ]) {
      expect({ script, messages: byCode(lint(scripted(script)), 'FP304').map((f) => f.message) }).toEqual({
        script,
        messages: ['Step "s" never writes output "wanted" (it writes other, result)'],
      });
    }
  });

  it('does not judge github-script steps whose code comes from elsewhere', () => {
    for (const script of [
      "const t = `${ `b` } don't`;\nconst r = require('./x.js');\ncore.setOutput('other', 1);",
      "const { execSync } = require('child_process');\ncore.setOutput('other', execSync('./out.sh'));",
      // fs is not delegation, but a computed write to the file is.
      "const fs = require('fs');\nfs.appendFileSync(process.env.GITHUB_OUTPUT, line);\ncore.setOutput('other', 1);",
      // The program inherits GITHUB_OUTPUT and may write to it.
      "await exec.exec('./set-outputs.sh');\ncore.setOutput('other', 1);",
      "core.setOutput('other', 1);\nconst msg = `${await helper(core)}`;",
      // Code substituted into the script by an expression may set any output.
      "core.setOutput('other', 1);\n${{ inputs.code }}",
    ]) {
      expect({ script, findings: byCode(lint(scripted(script)), 'FP304') }).toEqual({ script, findings: [] });
    }
    const whole = lint({
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_dispatch:
            inputs:
              code: { type: string }
        jobs:
          j:
            runs-on: x
            steps:
              - id: s
                uses: actions/github-script@v8
                with:
                  script: \${{ inputs.code }}
              - run: echo \${{ steps.s.outputs.wanted }}
      `,
    });
    expect(byCode(whole, 'FP304')).toEqual([]);
  });

  it('does not judge other actions that take a script, since they may set outputs of their own', () => {
    expect(byCode(lint(scripted("core.setOutput('other', 1);", 'acme/run-js@v1')), 'FP304')).toEqual([]);
  });
});
