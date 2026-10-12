import { getWorkflowSchema } from '@actions/workflow-parser/workflows/workflow-schema';
import {
  compareLoc,
  createLogger,
  createParseContext,
  type Diagnostic,
  memorySink,
  parseWorkflowFile,
  silentLogger,
  type UnitDecl,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { mappingsAt, SCHEMA_ROOT, schemaFor, workflowSchema } from '../src/schema';
import { validateSchema } from '../src/validate';
import { load, WF, yaml } from './helpers';

const units = (files: Record<string, string>): UnitDecl[] => {
  const { project } = load(files);
  return [...project.workflows.values(), ...project.actions.values()];
};

const sorted = (ds: Diagnostic[]) => [...ds].sort((a, b) => compareLoc(a.loc, b.loc));

/**
 * A diagnostic's kind (`-` for none), and when it says whether the site's own expression parse finds the error too,
 * that as well: `expression/site` when it does, `expression/parser` when only the parser does.
 */
const kindOf = (d: Diagnostic) =>
  d.siteError === undefined ? (d.kind ?? '-') : `${d.kind ?? '-'}/${d.siteError ? 'site' : 'parser'}`;

/** Every schema diagnostic the loader records, as `kind file:line:column message`, in source order. */
function schemaErrors(files: Record<string, string>): string[] {
  return sorted(units(files).flatMap((u) => u.schemaErrors)).map(
    (d) => `${kindOf(d)} ${d.loc.file}:${d.loc.line}:${d.loc.column} ${d.message}`,
  );
}

/** The same, with the fix each diagnostic carries. */
function withFixes(files: Record<string, string>): string[] {
  return sorted(units(files).flatMap((u) => u.schemaErrors)).map(
    (d) => `${kindOf(d)} ${d.loc.file}:${d.loc.line}:${d.loc.column} ${d.message} | ${d.fix ?? ''}`,
  );
}

describe('invalid expressions', () => {
  it('marks a workflow’s expression errors as the site’s too, in every field, at the expression', () => {
    const [wf] = units({
      [`${WF}/w.yml`]: yaml`
        on: push
        env:
          A: \${{ a + b }}
        jobs:
          j:
            runs-on: \${{ contains(github.ref) }}
            name: \${{ fromJSON(1, 2) }}
            if: \${{ contains(github.event.pull_request.labels, 1, 2) }}
            env:
              B: \${{ foo(1) }}
            steps:
              - run: echo \${{ startsWith(github.ref) }} \${{ (github.ref }}
              - if: contains(github.ref, 1, 2)
                uses: some/action@v1
                with:
                  x: \${{ format() }}
                env:
                  C: \${{ hashFiles() }}
      `,
    });
    expect(
      sorted(wf!.schemaErrors).map(
        (d) =>
          `${kindOf(d)} ${d.loc.line}:${d.loc.column}-${d.loc.endColumn} at ${d.at!.line}:${d.at!.column} ${d.message}`,
      ),
    ).toEqual([
      "expression/site 3:6-18 at 3:6 Unexpected symbol: '+'",
      "expression/site 6:14-41 at 6:14 Too few parameters supplied: 'contains'",
      "expression/site 7:11-32 at 7:11 Too many parameters supplied: 'fromJSON'",
      "expression/site 8:9-64 at 8:9 Too many parameters supplied: 'contains'",
      "expression/site 10:10-23 at 10:10 Unrecognized function: 'foo'",
      // Two expressions in one scalar: `at` is the scalar, `loc` each expression.
      "expression/site 12:19-48 at 12:14 Too few parameters supplied: 'startsWith'",
      "expression/site 12:49-67 at 12:14 Unexpected end of expression: 'ref'",
      "expression/site 16:14-29 at 16:14 Too few parameters supplied: 'format'",
      "expression/site 18:14-32 at 18:14 Too few parameters supplied: 'hashFiles'",
    ]);
  });

  it('marks an action’s expression errors the same way', () => {
    expect(
      schemaErrors({
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          outputs:
            o:
              value: \${{ contains(steps.s.outputs.o) }}
          runs:
            using: composite
            steps:
              - id: s
                if: \${{ contains(github.ref, 1, 2) }}
                run: echo \${{ a + b }} \${{ foo(1) }}
                shell: bash
              - uses: some/action@v1
                with:
                  x: \${{ join() }}
                env:
                  Y: \${{ (github.ref }}
        `,
      }),
    ).toEqual([
      "expression/site .github/actions/a/action.yml:5:12 Too few parameters supplied: 'contains'",
      "expression/site .github/actions/a/action.yml:10:11 Too many parameters supplied: 'contains'",
      "expression/site .github/actions/a/action.yml:11:17 Unexpected symbol: '+'",
      "expression/site .github/actions/a/action.yml:11:30 Unrecognized function: 'foo'",
      "expression/site .github/actions/a/action.yml:15:12 Too few parameters supplied: 'join'",
      "expression/site .github/actions/a/action.yml:17:12 Unexpected end of expression: 'ref'",
    ]);
  });

  it('marks errors in multi-line scalars whose own parse fails too, and drops those the parser misreads there', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - run: |
                    echo \${{ contains(github.ref, 1, 2) }}
                - run: >
                    echo
                    \${{ format() }}
                - run: "echo
                    \${{ contains(github.ref) }}"
                - if: '\${{ github.ref == ''refs/heads/main''
                    && github.event_name == ''push'' }}'
                  run: x
                - if: >-
                    \${{ secrets.TOKEN != '' }}
                  run: x
        `,
      }),
    ).toEqual([
      `expression/site ${WF}/w.yml:7:16 Too many parameters supplied: 'contains'`,
      `expression/site ${WF}/w.yml:10:11 Too few parameters supplied: 'format'`,
      `expression/site ${WF}/w.yml:13:11 Too few parameters supplied: 'contains'`,
      // The quoted `if:` is valid: the parser read its doubled quotes as written.
      `context ${WF}/w.yml:17:11 Unrecognized named-value: 'secrets'`,
    ]);
  });

  it('tells the errors the site’s own parse does not find: an empty expression, and an expression in a key', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - run: echo \${{ }} \${{ contains(github.ref, 1, 2) }}
                  env:
                    \${{ a + b }}: x
        `,
      }),
    ).toEqual([
      `- ${WF}/w.yml:6:19 An expression was expected`,
      `expression/site ${WF}/w.yml:6:26 Too many parameters supplied: 'contains'`,
      `expression/parser ${WF}/w.yml:8:11 Unexpected symbol: '+'`,
    ]);
  });

  it('drops the type error a boolean, number or matrix field adds for an expression that did not parse', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          concurrency:
            group: g
            cancel-in-progress: \${{ contains(github.ref) }}
          jobs:
            j:
              runs-on: x
              timeout-minutes: \${{ a + b }}
              continue-on-error: \${{ fromJSON(1, 2) }}
              strategy:
                fail-fast: \${{ startsWith(github.ref) }}
                matrix:
                  n: \${{ contains(github.ref) }}
              steps:
                - run: echo
                  timeout-minutes: \${{ format() }}
        `,
      }),
    ).toEqual([
      `expression/site ${WF}/w.yml:4:23 Too few parameters supplied: 'contains'`,
      `expression/site ${WF}/w.yml:8:22 Unexpected symbol: '+'`,
      `expression/site ${WF}/w.yml:9:24 Too many parameters supplied: 'fromJSON'`,
      `expression/site ${WF}/w.yml:11:18 Too few parameters supplied: 'startsWith'`,
      `expression/site ${WF}/w.yml:13:12 Too few parameters supplied: 'contains'`,
      `expression/site ${WF}/w.yml:16:26 Too few parameters supplied: 'format'`,
    ]);
  });

  it('accepts a valid multi-line expression in a boolean field that the parser misreads', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              continue-on-error: '\${{ github.ref ==
                ''refs/heads/main'' }}'
              steps: [{ run: echo }]
        `,
      }),
    ).toEqual([]);
  });

  it('matches an unclosed ${{ with the site’s unterminated expression, and the parser’s limits with the site’s', () => {
    const step = (run: string) => `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: ${run}\n`;
    expect(schemaErrors({ [`${WF}/w.yml`]: step('echo ${{ github.ref') })).toEqual([
      `expression/site ${WF}/w.yml:6:14 The expression is not closed. An unescaped \${{ sequence was found, but the closing }} sequence was not found.`,
    ]);
    expect(
      schemaErrors({ [`${WF}/w.yml`]: step(`echo \${{ ${'('.repeat(60)}1${')'.repeat(60)} }}`) }),
    ).toEqual([`expression/site ${WF}/w.yml:6:19 Exceeded max expression depth 50: '('`]);
    expect(
      schemaErrors({ [`${WF}/w.yml`]: step(`echo \${{ format('{0}', '${'a'.repeat(22_000)}') }}`) }),
    ).toEqual([`expression/site ${WF}/w.yml:6:19 ErrorExceededMaxLength`]);
  });

  it('strips the file name from messages, even one that contains a colon', () => {
    expect(
      schemaErrors({
        [`${WF}/deploy:prod.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - run: echo \${{ contains(github.ref) }} \${{ a + b }}
        `,
      }),
    ).toEqual([
      `expression/site ${WF}/deploy:prod.yml:6:19 Too few parameters supplied: 'contains'`,
      `expression/site ${WF}/deploy:prod.yml:6:47 Unexpected symbol: '+'`,
    ]);
  });
});

describe('contexts and functions a field does not allow', () => {
  it('marks known contexts and functions as `context`, and unknown names as invalid expressions', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          env:
            X: 1
          jobs:
            j:
              runs-on: x
              env:
                H: \${{ hashFiles('x') }}
              steps:
                - run: echo \${{ foo.bar }}
            k:
              uses: ./.github/workflows/r.yml
              with:
                t: \${{ env.X }}
        `,
        [`${WF}/r.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                t: { type: string }
          jobs:
            r:
              runs-on: x
              steps: [{ run: x }]
        `,
        '.github/actions/c/action.yml': yaml`
          name: c
          description: d
          runs:
            using: composite
            steps:
              - if: \${{ secrets.T != '' }}
                shell: bash
                run: echo
        `,
      }),
    ).toEqual([
      "context .github/actions/c/action.yml:6:11 Unrecognized named-value: 'secrets'",
      `context ${WF}/w.yml:8:10 Unrecognized function: 'hashFiles'`,
      `expression/site ${WF}/w.yml:10:19 Unrecognized named-value: 'foo'`,
      `context ${WF}/w.yml:14:10 Unrecognized named-value: 'env'`,
    ]);
  });
});

describe('keys and shapes', () => {
  it('reports an unknown job key at the key', () => {
    const [wf] = units({ [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: []\n' });
    expect(wf!.schemaErrors).toEqual([
      {
        message: "Unexpected value 'stepz'",
        at: { line: 5, column: 5 },
        loc: { file: `${WF}/w.yml`, line: 5, column: 5, endLine: 5, endColumn: 10 },
      },
    ]);
  });

  it('validates action metadata, but does not require a name or description for local actions', () => {
    expect(withFixes({ '.github/actions/a/action.yml': 'name: a\nrunz: {}\n' })).toEqual([
      '- .github/actions/a/action.yml:1:1 Required property is missing: runs | ',
      'ignored .github/actions/a/action.yml:2:1 GitHub ignores this key: action metadata has no `runz` (did you mean `runs`?), so it has no effect | Rename it to `runs`.',
    ]);
    expect(
      schemaErrors({
        '.github/actions/a/action.yml':
          'runs:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n',
      }),
    ).toEqual([]);
  });

  it('accepts background, wait, wait-all, cancel and parallel steps in workflows, not in composite actions', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - id: server
                  background: true
                  run: npm start
                - id: build
                  background: true
                  uses: some/action@v1
                - wait: server
                - wait: [server, build]
                - cancel: server
                - wait-all:
                  continue-on-error: true
                - parallel:
                    - run: a
                    - uses: some/action@v1
        `,
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - run: npm start
                shell: bash
                background: true
        `,
      }),
    ).toEqual(["- .github/actions/a/action.yml:6:7 Unexpected value 'background'"]);
  });

  it('accepts cache-mode on the workflow, a job and a reusable-workflow call, and checks its value', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          cache-mode: read
          jobs:
            a:
              runs-on: x
              cache-mode: write-only
              steps: [{ run: x }]
            b:
              uses: ./.github/workflows/r.yml
              cache-mode: none
            c:
              runs-on: x
              cache-mode: readonly
              steps: [{ run: x }]
        `,
        [`${WF}/r.yml`]:
          'on: workflow_call\njobs:\n  r:\n    runs-on: x\n    cache-mode: write\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([`- ${WF}/w.yml:13:17 Unexpected value 'readonly'`]);
  });
});

describe('keys GitHub ignores', () => {
  it('marks a composite action’s top-level env as ignored, with what it costs', () => {
    expect(
      withFixes({
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          env:
            PINNED: 1.2.3
          runs:
            using: composite
            steps:
              - run: echo "\${{ env.PINNED }}"
                shell: bash
        `,
      }),
    ).toEqual([
      "ignored .github/actions/a/action.yml:3:1 GitHub ignores this key: actions have no top-level `env`, so the action's steps never see these values | Set the variables in `env:` on the steps that read them, or declare them as inputs.",
    ]);
  });

  it('marks event keys the event does not support as ignored, and suggests close names', () => {
    expect(
      withFixes({
        [`${WF}/w.yml`]: yaml`
          on:
            release:
              types: [published]
              branches: [main]
            push:
              branch: main
            workflow_dispatch:
              input:
                x: { type: string }
            pull_request:
              frobnicate: 1
          jobs:
            j:
              runs-on: x
              steps: [{ run: x }]
        `,
      }),
    ).toEqual([
      `ignored ${WF}/w.yml:4:5 GitHub ignores this key: the \`release\` event does not support \`branches\`, so the workflow runs regardless of it | Remove it, or check the condition in a job's \`if:\` instead.`,
      `ignored ${WF}/w.yml:6:5 GitHub ignores this key: the \`push\` event does not support \`branch\` (did you mean \`branches\`?), so the workflow runs regardless of it | Rename it to \`branches\`.`,
      `ignored ${WF}/w.yml:8:5 GitHub ignores this key: the \`workflow_dispatch\` event does not support \`input\` (did you mean \`inputs\`?), so it has no effect | Rename it to \`inputs\`.`,
      `ignored ${WF}/w.yml:11:5 GitHub ignores this key: the \`pull_request\` event does not support \`frobnicate\`, so it has no effect | Remove it.`,
    ]);
  });

  it('keeps errors for what GitHub rejects: unknown events, activity types, workflow_call and job keys', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          x-defaults: 1
          on:
            pull-request:
            issues:
              types: [opend]
            workflow_call:
              input: {}
          jobs:
            j:
              runs-on: x
              stepz: []
        `,
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          runs:
            using: composite
            stepz: []
        `,
      }),
    ).toEqual([
      "- .github/actions/a/action.yml:4:3 There's not enough info to determine what you meant. Add one of these properties: args, entrypoint, env, image, main, post, post-entrypoint, pre, pre-entrypoint, steps",
      "- .github/actions/a/action.yml:5:3 Unexpected value 'stepz'",
      `- ${WF}/w.yml:1:1 Unexpected value 'x-defaults'`,
      `- ${WF}/w.yml:3:3 Unexpected value 'pull-request'`,
      `- ${WF}/w.yml:5:13 Unexpected value 'opend'`,
      `- ${WF}/w.yml:7:5 Unexpected value 'input'`,
      `- ${WF}/w.yml:11:5 Unexpected value 'stepz'`,
    ]);
  });

  it('keeps the parser’s error for a key valid where it is anchored but aliased under an event without it', () => {
    // The parser reports aliased content at the anchored node, where `branches` is a valid `push` filter.
    expect(
      schemaErrors({
        [`${WF}/w.yml`]:
          'on:\n  push: &p\n    branches: [main]\n  release: *p\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([`- ${WF}/w.yml:3:5 Unexpected value 'branches'`]);
  });

  it('marks a YAML merge key under an event or at the top of an action as ignored, naming what it drops', () => {
    expect(
      withFixes({
        [`${WF}/w.yml`]: yaml`
          on:
            push: &filters
              branches: [main]
            pull_request:
              <<: *filters
            pull_request_target:
              <<: *filters
              types: [opened]
            workflow_dispatch:
              <<:
                inputs:
                  x: { type: string }
          jobs:
            j:
              runs-on: x
              steps: [{ run: x }]
        `,
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          runs:
            using: composite
            steps: []
          <<: { author: me }
        `,
      }),
    ).toEqual([
      'ignored .github/actions/a/action.yml:6:1 GitHub ignores this key: YAML merge keys (`<<`) are not supported, so the keys merged here are not applied | GitHub does not support YAML merge keys (`<<`): repeat the keys at the top level.',
      `ignored ${WF}/w.yml:5:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the filters in \`*filters\` are not applied to \`pull_request\` and the workflow runs regardless of them | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`pull_request\`, or alias the whole event (\`pull_request: *filters\`) instead.`,
      `ignored ${WF}/w.yml:7:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the filters in \`*filters\` are not applied to \`pull_request_target\` and the workflow runs regardless of them | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`pull_request_target\`.`,
      `ignored ${WF}/w.yml:10:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the keys merged here are not applied to \`workflow_dispatch\` | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`workflow_dispatch\`.`,
    ]);
  });

  it('names every alias a merge key lists', () => {
    expect(
      withFixes({
        '.github/actions/b/action.yml': yaml`
          x-meta: &meta { author: me }
          name: b
          description: d
          runs:
            using: composite
            steps: []
          <<: *meta
        `,
        [`${WF}/w.yml`]: yaml`
          on:
            pull_request: &a
              branches: [main]
            pull_request_target: &b
              paths: [src]
            push:
              <<: [*a, *b, *a]
          jobs:
            j:
              runs-on: x
              steps: [{ run: x }]
        `,
      }),
    ).toEqual([
      'ignored .github/actions/b/action.yml:1:1 GitHub ignores this key: action metadata has no `x-meta`, so it has no effect | Remove it.',
      'ignored .github/actions/b/action.yml:7:1 GitHub ignores this key: YAML merge keys (`<<`) are not supported, so the keys in `*meta` are not applied | GitHub does not support YAML merge keys (`<<`): repeat the keys at the top level.',
      `ignored ${WF}/w.yml:7:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the filters in \`*a\`, \`*b\` are not applied to \`push\` and the workflow runs regardless of them | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`push\`.`,
    ]);
  });

  it('keeps a YAML merge key in a job an error, and says how to replace it', () => {
    expect(
      withFixes({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            a: &defaults
              runs-on: x
              steps: [{ run: x }]
            b:
              <<: *defaults
              steps: [{ run: y }]
        `,
      }),
    ).toEqual([
      `- ${WF}/w.yml:7:5 Unexpected value '<<' | GitHub does not support YAML merge keys (\`<<\`): repeat the keys here.`,
      `- ${WF}/w.yml:7:5 Required property is missing: runs-on | `,
    ]);
  });
});

describe('steps and jobs that mix two shapes', () => {
  it('reports one wrong key on a uses step once, at that key', () => {
    const [action] = units({
      '.github/actions/a/action.yml': yaml`
        runs:
          using: composite
          steps:
            - name: Install
              working-directory: \${{ inputs.dir }}
              uses: taiki-e/install-action@v2
              with:
                tool: nextest
      `,
    });
    expect(action!.schemaErrors).toEqual([
      {
        message: "Unexpected value 'working-directory' (not allowed together with `uses`)",
        loc: { file: '.github/actions/a/action.yml', line: 5, column: 7, endLine: 5, endColumn: 24 },
      },
    ]);
  });

  it('reports a job that both runs steps and calls a workflow once', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              uses: ./.github/workflows/r.yml
              with:
                a: 1
        `,
        [`${WF}/r.yml`]:
          'on:\n  workflow_call:\n    inputs:\n      a: { type: number }\njobs:\n  r:\n    runs-on: x\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([`- ${WF}/w.yml:4:5 Unexpected value 'runs-on' (not allowed together with \`uses\`)`]);
  });

  it('reports what a job lacks for the shape it fits best when the parser guessed the other', () => {
    // `with` first makes the parser read a reusable-workflow call; the job fits one that runs steps better.
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              with:
                a: 1
              steps: [{ run: x }]
              timeout-minutes: 5
              env: {}
        `,
      }),
    ).toEqual([
      `- ${WF}/w.yml:4:5 Unexpected value 'with' (not allowed together with \`steps\`)`,
      `- ${WF}/w.yml:4:5 Required property is missing: runs-on`,
    ]);
  });

  it('keeps the parser’s errors when it guessed the closest shape, saying which key a misplaced one conflicts with', () => {
    expect(
      schemaErrors({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - working-directory: x
                shell: bash
                with:
                  a: 1
        `,
      }),
    ).toEqual([
      '- .github/actions/a/action.yml:4:7 Required property is missing: run',
      "- .github/actions/a/action.yml:6:7 Unexpected value 'with' (not allowed together with `shell`)",
    ]);
  });

  it('reports each typo at its own key, without blaming a valid one', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            a:
              runs_on: ubuntu-latest
              steps:
                - run: echo
                  shel: bash
                  wth: x
                - uses: actions/checkout@v4
                  wth:
                    a: 1
                  evn:
                    A: 1
            b:
              runs-on: ubuntu-latest
              run-on: x
              step:
                - run: echo
            c:
              uses: ./.github/workflows/r.yml
              with: {}
              secret: inherit
              needz: [a]
        `,
        [`${WF}/r.yml`]: 'on: workflow_call\njobs:\n  r:\n    runs-on: x\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([
      `- ${WF}/w.yml:4:5 Unexpected value 'runs_on'`,
      `- ${WF}/w.yml:4:5 Required property is missing: runs-on`,
      `- ${WF}/w.yml:7:9 Unexpected value 'shel'`,
      `- ${WF}/w.yml:8:9 Unexpected value 'wth'`,
      `- ${WF}/w.yml:10:9 Unexpected value 'wth'`,
      `- ${WF}/w.yml:12:9 Unexpected value 'evn'`,
      `- ${WF}/w.yml:16:5 Unexpected value 'run-on'`,
      `- ${WF}/w.yml:17:5 Unexpected value 'step'`,
      `- ${WF}/w.yml:22:5 Unexpected value 'secret'`,
      `- ${WF}/w.yml:23:5 Unexpected value 'needz'`,
    ]);
  });

  it('reports a misplaced key and a typo in a step the parser guessed wrong at their own keys', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - working-directory: x
                  uses: actions/checkout@v4
                  wth:
                    fetch-depth: 0
        `,
      }),
    ).toEqual([
      `- ${WF}/w.yml:6:9 Unexpected value 'working-directory' (not allowed together with \`uses\`)`,
      `- ${WF}/w.yml:8:9 Unexpected value 'wth'`,
    ]);
  });

  it('explains a misplaced key the same way whichever key comes first', () => {
    const step = (keys: string) =>
      schemaErrors({
        [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - ${keys}\n`,
      }).map((d) => d.replace(/^.*?:\d+:\d+ /, ''));
    const misplaced = "Unexpected value 'working-directory' (not allowed together with `uses`)";
    expect(step('uses: a/b@v1\n        working-directory: x')).toEqual([misplaced]);
    expect(step('working-directory: x\n        uses: a/b@v1')).toEqual([misplaced]);
    // A tie (one key of each shape): the parser’s guess stands, and its error says what it conflicts with.
    expect(step('run: echo\n        uses: a/b@v1')).toEqual([
      "Unexpected value 'uses' (not allowed together with `run`)",
    ]);
  });

  it('keeps the parser’s errors when no shape fits better than another', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - name: nothing to run
                  bogus: 1
        `,
      }),
    ).toEqual([
      `- ${WF}/w.yml:6:9 There's not enough info to determine what you meant. Add one of these properties: cancel, run, shell, uses, wait, wait-all, with, working-directory`,
      `- ${WF}/w.yml:7:9 Unexpected value 'bogus'`,
    ]);
  });

  // @actions/workflow-parser 0.3.61 looks a key up with `definition.properties[name]`, which finds an Object.prototype
  // member (`toString`, `constructor`) and fails the whole file. Validated against mappings whose properties have no
  // prototype, such a key is unknown, and the file's other errors stay.
  it('reports a key named like an Object.prototype member as an unknown key', () => {
    expect(
      schemaErrors({
        [`${WF}/w.yml`]:
          'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: x\n        toString: 1\n',
      }),
    ).toEqual([`- ${WF}/w.yml:7:9 Unexpected value 'toString'`]);
    expect(
      schemaErrors({
        [`${WF}/w.yml`]: 'on: push\nconstructor: 1\njobs:\n  j:\n    runs-on: x\n    stepz: 1\n',
        '.github/actions/a/action.yml': 'runs:\n  using: composite\n  valueOf: 1\n  steps: []\n',
      }),
    ).toEqual([
      "- .github/actions/a/action.yml:3:3 Unexpected value 'valueOf'",
      `- ${WF}/w.yml:2:1 Unexpected value 'constructor'`,
      `- ${WF}/w.yml:6:5 Unexpected value 'stepz'`,
    ]);
  });
});

describe('YAML errors', () => {
  it('records invalid YAML as a parse error and does not validate the file against the schema', () => {
    const [wf] = units({ [`${WF}/w.yml`]: 'on: push\njobs: [a\n' });
    expect(wf!.parseErrors).toEqual([
      {
        message: 'Flow sequence in block collection must be sufficiently indented and end with a ]',
        loc: { file: `${WF}/w.yml`, line: 3, column: 1, endLine: 3, endColumn: 2 },
      },
    ]);
    expect(wf!.schemaErrors).toEqual([]);
  });

  it('records duplicate keys as a parse error at the repeated key', () => {
    const [wf] = units({ [`${WF}/w.yml`]: 'on: push\non: pull_request\njobs: {}\n' });
    expect(wf!.parseErrors.map((d) => `${d.loc.line}:${d.loc.column} ${d.message}`)).toEqual([
      '2:1 Map keys must be unique',
    ]);
    expect(wf!.schemaErrors).toEqual([]);
  });

  it('stops at an alias bomb instead of expanding it', () => {
    const lines = ['on: push', 'env:', '  L0: &l0 ["${{ github.sha }}", "x"]'];
    for (let i = 1; i <= 24; i++) lines.push(`  L${i}: &l${i} [*l${i - 1}, *l${i - 1}]`);
    lines.push('jobs:', '  j:', '    runs-on: x', '    steps: [{ run: x }]');
    const started = performance.now();
    const [wf] = units({ [`${WF}/a.yml`]: `${lines.join('\n')}\n` });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(wf!.parseErrors.map((d) => `${d.loc.line}:${d.loc.column} ${d.message}`)).toEqual([
      '18:14 YAML aliases expand to more than 50000 nodes; the file is not analyzed (possible alias bomb)',
    ]);
    expect(wf!.schemaErrors).toEqual([]);
  });
});

describe('validateSchema', () => {
  it('is skipped when the loader is asked not to validate', () => {
    const { project } = load(
      { [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: []\n' },
      { validateSchema: false },
    );
    expect(project.workflows.get(`${WF}/w.yml`)!.schemaErrors).toEqual([]);
  });

  it('keeps the parser’s messages as they are for a file that is not valid YAML', () => {
    // The loader never validates such a file; called directly, the duplicate key leaves nothing to explain.
    const wf = parseWorkflowFile(
      `${WF}/w.yml`,
      'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: 1\n    stepz: 2\n',
      createParseContext(),
    );
    expect(wf.parseErrors.map((d) => d.message)).toEqual(['Map keys must be unique']);
    expect(validateSchema(wf, silentLogger).map((d) => `${d.loc.line}:${d.loc.column} ${d.message}`)).toEqual(
      ["5:5 Unexpected value 'stepz'", "6:5 'stepz' is already defined"],
    );
  });

  it('never throws: a file the parser cannot read is skipped, and the reason logged', () => {
    const sink = memorySink();
    const unit = {
      kind: 'workflow',
      file: `${WF}/broken.yml`,
      get source(): never {
        throw new Error('unreadable');
      },
    } as unknown as UnitDecl;
    expect(validateSchema(unit, createLogger({ level: 'debug', sink }))).toEqual([]);
    expect(sink.records.map((r) => [r.level, r.message, r.data])).toEqual([
      ['debug', `schema validation skipped for ${WF}/broken.yml`, { reason: 'unreadable' }],
    ]);
  });
});

describe('schema', () => {
  it('adds cache-mode to the workflow schema without changing the parser’s own, once', () => {
    const schema = workflowSchema();
    expect(workflowSchema()).toBe(schema);
    expect(schemaFor('workflow')).toBe(schema);
    const hasCacheMode = (s: typeof schema, path: (string | number)[]) =>
      mappingsAt(s, SCHEMA_ROOT.workflow, path).some((m) => 'cache-mode' in m.properties);
    expect(hasCacheMode(schema, [])).toBe(true);
    expect(hasCacheMode(schema, ['jobs', 'build'])).toBe(true);
    // The parser (0.3.61) lacks cache-mode, so flowpact extends a copy and leaves the parser's own without it. Once a
    // parser release defines cache-mode, workflowSchema() is the parser's own schema and the shim can go.
    const parser = getWorkflowSchema();
    const native = parser.definitions['cache-mode'] !== undefined;
    expect(schema === parser).toBe(native);
    expect(hasCacheMode(parser, [])).toBe(native);
    expect(hasCacheMode(parser, ['jobs', 'build'])).toBe(native);
  });

  it('lists the mapping shapes the schema allows at a path', () => {
    const wf = schemaFor('workflow');
    const shapes = (path: (string | number)[]) =>
      mappingsAt(wf, SCHEMA_ROOT.workflow, path).map((m) => Object.keys(m.properties));
    // A job runs steps or calls a workflow; a step is a `run` step or a `uses` step.
    const job = shapes(['jobs', 'build']);
    expect(job).toHaveLength(2);
    expect(job.some((keys) => keys.includes('steps') && !keys.includes('uses'))).toBe(true);
    expect(job.some((keys) => keys.includes('uses') && !keys.includes('steps'))).toBe(true);
    const step = shapes(['jobs', 'build', 'steps', 0]);
    expect(step.some((keys) => keys.includes('run') && !keys.includes('uses'))).toBe(true);
    expect(step.some((keys) => keys.includes('uses') && !keys.includes('run'))).toBe(true);
    // Not a mapping, or not a path the schema knows.
    expect(shapes(['jobs', 'build', 'steps'])).toEqual([]);
    expect(shapes(['nope'])).toEqual([]);
    expect(shapes(['jobs', 'build', 'steps', 'x'])).toEqual([]);

    const action = mappingsAt(schemaFor('action'), SCHEMA_ROOT.action, []);
    expect(action.map((m) => Object.keys(m.properties).sort())).toEqual([
      ['author', 'branding', 'description', 'inputs', 'name', 'outputs', 'runs'],
    ]);
  });
});
