import { describe, expect, it } from 'vitest';
import { at, byCode, codes, lint, WF, yaml } from '../helpers';

describe('FP501 undefined-env-ref', () => {
  it('resolves env through step, job and workflow scope and earlier $GITHUB_ENV writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        env:
          W: 1
        jobs:
          j:
            runs-on: x
            env:
              J: 2
            steps:
              - run: echo "E=3" >> $GITHUB_ENV
              - env:
                  S: 4
                run: echo \${{ env.W }} \${{ env.J }} \${{ env.S }} \${{ env.E }} \${{ env.NOPE }}
      `,
    });
    expect(byCode(r, 'FP501').map((f) => f.message)).toEqual(['env.NOPE is not defined in this scope']);
  });

  it('points runner variables to the matching context', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ env.GITHUB_SHA }}\n',
    });
    const [f] = byCode(r, 'FP501');
    expect(f?.message).toContain('use github.sha');
    expect(f?.fix).toBe('Replace `env.GITHUB_SHA` with `github.sha`.');
  });

  it('gives up after steps that may export variables invisibly', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: some/action@v1\n      - run: echo ${{ env.FROM_ACTION }}\n',
    });
    expect(byCode(r, 'FP501')).toEqual([]);
  });
});

describe('FP502 expression-parse-error', () => {
  it('reports syntax errors at the offending token', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        "on: push\njobs:\n  j:\n    if: ${{ github.ref = 'main' }}\n    runs-on: x\n    steps: [{ run: x }]\n",
    });
    const [f] = byCode(r, 'FP502');
    expect(f?.message).toBe("Invalid expression \"github.ref = 'main'\": Unexpected symbol: '='");
    expect(at(f!)).toBe(`${WF}/w.yml:4:24`);
  });
});

describe('FP502 / FP503: an invalid expression is reported once', () => {
  const report = (files: Record<string, string>) =>
    lint(files, { schema: true })
      .findings.filter((f) => ['FP502', 'FP503', 'FP505'].includes(f.code))
      .map((f) => `${f.code} ${at(f)} ${f.message}`);

  it('reports a workflow’s invalid expressions as FP502 only, in every field', () => {
    expect(
      report({
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
                - if: \${{ contains(github.event.pull_request.labels, 1, 2) }}
                  run: echo \${{ startsWith(github.ref) }} \${{ (github.ref }}
                - if: contains(github.ref, 1, 2)
                  uses: some/action@v1
                  with:
                    x: \${{ format() }}
                  env:
                    C: \${{ hashFiles() }}
                - run: echo \${{ github.ref
        `,
      }),
    ).toEqual([
      `FP502 ${WF}/w.yml:3:12 Invalid expression "a + b": Unexpected symbol: '+'`,
      `FP502 ${WF}/w.yml:6:18 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:7:15 Invalid expression "fromJSON(1, 2)": Too many parameters supplied: 'fromJSON'`,
      `FP502 ${WF}/w.yml:8:13 Invalid expression "contains(github.event.pull_request.labels, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:10:14 Invalid expression "foo(1)": Unrecognized function: 'foo'`,
      `FP502 ${WF}/w.yml:12:17 Invalid expression "contains(github.event.pull_request.labels, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:13:23 Invalid expression "startsWith(github.ref)": Too few parameters supplied: 'startsWith'`,
      `FP502 ${WF}/w.yml:13:61 Invalid expression "(github.ref": Unexpected end of expression: 'ref'`,
      `FP502 ${WF}/w.yml:14:13 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:17:18 Invalid expression "format()": Too few parameters supplied: 'format'`,
      `FP502 ${WF}/w.yml:19:18 Invalid expression "hashFiles()": Too few parameters supplied: 'hashFiles'`,
      `FP502 ${WF}/w.yml:20:23 Invalid expression "github.ref": Unterminated expression: missing closing '}}'`,
    ]);
  });

  it('reports an action’s invalid expressions as FP502 only', () => {
    expect(
      report({
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
      `FP502 .github/actions/a/action.yml:5:16 Invalid expression "contains(steps.s.outputs.o)": Too few parameters supplied: 'contains'`,
      `FP502 .github/actions/a/action.yml:10:15 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 .github/actions/a/action.yml:11:23 Invalid expression "a + b": Unexpected symbol: '+'`,
      `FP502 .github/actions/a/action.yml:11:34 Invalid expression "foo(1)": Unrecognized function: 'foo'`,
      `FP502 .github/actions/a/action.yml:15:16 Invalid expression "join()": Too few parameters supplied: 'join'`,
      `FP502 .github/actions/a/action.yml:17:24 Invalid expression "(github.ref": Unexpected end of expression: 'ref'`,
    ]);
  });

  it('reports invalid expressions in multi-line scalars once, and not those the parser misreads there', () => {
    expect(
      report({
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
      `FP502 ${WF}/w.yml:7:20 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:10:15 Invalid expression "format()": Too few parameters supplied: 'format'`,
      `FP502 ${WF}/w.yml:12:15 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP505 ${WF}/w.yml:17:15 \`secrets\` is not available here — GitHub rejects the workflow ("Unrecognized named-value: 'secrets'")`,
    ]);
  });

  it('keeps schema errors that FP502 does not report, next to the expressions it does', () => {
    expect(
      report({
        [`${WF}/w.yml`]: yaml`
          on: push
          env:
            X: 1
          jobs:
            j:
              runs-on: x
              steps:
                - run: echo \${{ }} \${{ contains(github.ref, 1, 2) }}
                  env:
                    \${{ a + b }}: x
                  runz: x
            k:
              uses: ./.github/workflows/r.yml
              with:
                t: \${{ env.X }} \${{ contains(github.ref) }}
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
      }),
    ).toEqual([
      // An empty expression, and an expression in a key, which FP502 does not check.
      `FP503 ${WF}/w.yml:8:19 An expression was expected`,
      `FP502 ${WF}/w.yml:8:30 Invalid expression "contains(github.ref, 1, 2)": Too many parameters supplied: 'contains'`,
      `FP503 ${WF}/w.yml:10:11 Unexpected symbol: '+'`,
      `FP503 ${WF}/w.yml:11:9 Unexpected value 'runz'`,
      `FP505 ${WF}/w.yml:15:14 \`env\` is not available here — GitHub rejects the workflow ("Unrecognized named-value: 'env'")`,
      `FP502 ${WF}/w.yml:15:27 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
    ]);
  });

  it('reports an invalid expression in a boolean, number or matrix field once, without the type error that follows', () => {
    expect(
      report({
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
      `FP502 ${WF}/w.yml:4:27 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:8:28 Invalid expression "a + b": Unexpected symbol: '+'`,
      `FP502 ${WF}/w.yml:9:28 Invalid expression "fromJSON(1, 2)": Too many parameters supplied: 'fromJSON'`,
      `FP502 ${WF}/w.yml:11:22 Invalid expression "startsWith(github.ref)": Too few parameters supplied: 'startsWith'`,
      `FP502 ${WF}/w.yml:13:16 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/w.yml:16:30 Invalid expression "format()": Too few parameters supplied: 'format'`,
    ]);
  });

  it('accepts a valid multi-line expression in a boolean field that the parser misreads', () => {
    expect(
      report({
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

  it('reports invalid expressions as FP503 when FP502 does not run, once each', () => {
    const files = {
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            timeout-minutes: \${{ fromJSON(1, 2) }}
            steps:
              - run: echo \${{ contains(github.ref) }}
      `,
    };
    const fp503 = (opts: Parameters<typeof lint>[1]) =>
      lint(files, { schema: true, ...opts })
        .findings.filter((f) => ['FP502', 'FP503'].includes(f.code))
        .map((f) => `${f.code} ${at(f)} ${f.message}`);
    const expected = [
      `FP503 ${WF}/w.yml:5:22 Too many parameters supplied: 'fromJSON'`,
      `FP503 ${WF}/w.yml:7:19 Too few parameters supplied: 'contains'`,
    ];
    expect(fp503({ config: { rules: { FP502: 'off' } } })).toEqual(expected);
    expect(fp503({ only: ['FP503'] })).toEqual(expected);
  });

  it('reports an invalid expression once in a file whose path contains a colon', () => {
    expect(
      report({
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
      `FP502 ${WF}/deploy:prod.yml:6:23 Invalid expression "contains(github.ref)": Too few parameters supplied: 'contains'`,
      `FP502 ${WF}/deploy:prod.yml:6:53 Invalid expression "a + b": Unexpected symbol: '+'`,
    ]);
  });
});

describe('FP503 schema-violation / FP504 yaml-syntax-error', () => {
  it('validates against GitHub’s schema when enabled', () => {
    const r = lint(
      { [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: []\n' },
      { schema: true },
    );
    expect(byCode(r, 'FP503')[0]?.message).toBe("Unexpected value 'stepz'");
    expect(at(byCode(r, 'FP503')[0]!)).toBe(`${WF}/w.yml:5:5`);
  });

  it('validates action files', () => {
    const r = lint({ '.github/actions/a/action.yml': 'name: a\nrunz: {}\n' }, { schema: true });
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      'error .github/actions/a/action.yml:1:1 Required property is missing: runs',
      'warning .github/actions/a/action.yml:2:1 GitHub ignores this key: action metadata has no `runz` (did you mean `runs`?), so it has no effect',
    ]);
    expect(byCode(r, 'FP503')[1]?.fix).toBe('Rename it to `runs`.');
  });

  it('reports YAML errors once (no schema duplicate)', () => {
    const r = lint({ [`${WF}/w.yml`]: 'on: push\njobs: [a\n' }, { schema: true });
    expect(codes(r)).toContain('FP504');
    expect(codes(r)).not.toContain('FP503');
  });
});

describe('FP503 keys GitHub added after the parser’s schema', () => {
  const schema503 = (files: Record<string, string>) =>
    byCode(lint(files, { schema: true }), 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`);

  it('accepts background, wait, wait-all, cancel and parallel steps', () => {
    expect(
      schema503({
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
      }),
    ).toEqual([]);
  });

  it('still rejects background steps inside a composite action', () => {
    expect(
      schema503({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - run: npm start
                shell: bash
                background: true
        `,
      }),
    ).toEqual(["error .github/actions/a/action.yml:6:7 Unexpected value 'background'"]);
  });

  it('accepts cache-mode on the workflow, a job and a reusable-workflow call, and checks its value', () => {
    expect(
      schema503({
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
    ).toEqual([`error ${WF}/w.yml:13:17 Unexpected value 'readonly'`]);
  });
});

describe('FP503 keys GitHub ignores', () => {
  it('warns about a composite action’s top-level env with what it costs', () => {
    const r = lint(
      {
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
      },
      { schema: true },
    );
    const [f, ...rest] = byCode(r, 'FP503');
    expect(rest).toEqual([]);
    expect(f?.severity).toBe('warning');
    expect(at(f!)).toBe('.github/actions/a/action.yml:3:1');
    expect(f?.message).toBe(
      "GitHub ignores this key: actions have no top-level `env`, so the action's steps never see these values",
    );
    expect(f?.fix).toBe(
      'Set the variables in `env:` on the steps that read them, or declare them as inputs.',
    );
  });

  it('warns about event filters the event does not support, and suggests close names', () => {
    const r = lint(
      {
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
          jobs:
            j:
              runs-on: x
              steps: [{ run: x }]
        `,
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message} | ${f.fix}`)).toEqual([
      `warning ${WF}/w.yml:4:5 GitHub ignores this key: the \`release\` event does not support \`branches\`, so the workflow runs regardless of it | Remove it, or check the condition in a job's \`if:\` instead.`,
      `warning ${WF}/w.yml:6:5 GitHub ignores this key: the \`push\` event does not support \`branch\` (did you mean \`branches\`?), so the workflow runs regardless of it | Rename it to \`branches\`.`,
      `warning ${WF}/w.yml:8:5 GitHub ignores this key: the \`workflow_dispatch\` event does not support \`input\` (did you mean \`inputs\`?), so it has no effect | Rename it to \`inputs\`.`,
    ]);
  });

  it('keeps errors for what GitHub rejects: unknown events, activity types, workflow_call keys, job keys', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
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
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      `error ${WF}/w.yml:2:3 Unexpected value 'pull-request'`,
      `error ${WF}/w.yml:4:13 Unexpected value 'opend'`,
      `error ${WF}/w.yml:6:5 Unexpected value 'input'`,
      `error ${WF}/w.yml:10:5 Unexpected value 'stepz'`,
    ]);
  });

  it('warns that a YAML merge key under an event drops what it names, so the filters are not applied', () => {
    const r = lint(
      {
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
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message} | ${f.fix}`)).toEqual([
      'warning .github/actions/a/action.yml:6:1 GitHub ignores this key: YAML merge keys (`<<`) are not supported, so the keys merged here are not applied | GitHub does not support YAML merge keys (`<<`): repeat the keys at the top level.',
      `warning ${WF}/w.yml:5:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the filters in \`*filters\` are not applied to \`pull_request\` and the workflow runs regardless of them | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`pull_request\`, or alias the whole event (\`pull_request: *filters\`) instead.`,
      `warning ${WF}/w.yml:7:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the filters in \`*filters\` are not applied to \`pull_request_target\` and the workflow runs regardless of them | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`pull_request_target\`.`,
      `warning ${WF}/w.yml:10:5 GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so the keys merged here are not applied to \`workflow_dispatch\` | GitHub does not support YAML merge keys (\`<<\`): repeat the keys under \`workflow_dispatch\`.`,
    ]);
  });

  it('keeps a YAML merge key in a job or step an error, and says how to replace it', () => {
    const r = lint(
      {
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
      },
      { schema: true },
    );
    const findings = byCode(r, 'FP503');
    expect(findings.map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      `error ${WF}/w.yml:7:5 Unexpected value '<<'`,
      `error ${WF}/w.yml:7:5 Required property is missing: runs-on`,
    ]);
    expect(findings[0]?.fix).toBe('GitHub does not support YAML merge keys (`<<`): repeat the keys here.');
  });

  it('caps the warning at the configured severity and never raises it', () => {
    const files = {
      '.github/actions/a/action.yml': 'env: {}\nrunz: {}\n',
    };
    const sev = (rules: Record<string, string>) =>
      byCode(lint(files, { schema: true, config: { rules } }), 'FP503').map((f) => f.severity);
    expect(sev({})).toEqual(['error', 'warning', 'warning']);
    expect(sev({ FP503: 'error' })).toEqual(['error', 'warning', 'warning']);
    expect(sev({ FP503: 'warning' })).toEqual(['warning', 'warning', 'warning']);
    expect(sev({ FP503: 'info' })).toEqual(['info', 'info', 'info']);
    expect(sev({ FP503: 'off' })).toEqual([]);
  });
});

describe('FP503 steps and jobs that mix two shapes', () => {
  const schema503 = (files: Record<string, string>) =>
    byCode(lint(files, { schema: true }), 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`);

  it('reports one wrong key on a uses step once, at that key', () => {
    expect(
      schema503({
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
      }),
    ).toEqual([
      "error .github/actions/a/action.yml:5:7 Unexpected value 'working-directory' (not allowed together with `uses`)",
    ]);
  });

  it('reports a job that both runs steps and calls a workflow once', () => {
    expect(
      schema503({
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
    ).toEqual([`error ${WF}/w.yml:4:5 Unexpected value 'runs-on' (not allowed together with \`uses\`)`]);
  });

  it('keeps the parser’s errors when it guessed the closest shape, saying which key a misplaced one conflicts with', () => {
    expect(
      schema503({
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
      'error .github/actions/a/action.yml:4:7 Required property is missing: run',
      "error .github/actions/a/action.yml:6:7 Unexpected value 'with' (not allowed together with `shell`)",
    ]);
  });

  it('reports each typo at its own key, without blaming a valid one', () => {
    expect(
      schema503({
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
      `error ${WF}/w.yml:4:5 Unexpected value 'runs_on'`,
      `error ${WF}/w.yml:4:5 Required property is missing: runs-on`,
      `error ${WF}/w.yml:7:9 Unexpected value 'shel'`,
      `error ${WF}/w.yml:8:9 Unexpected value 'wth'`,
      `error ${WF}/w.yml:10:9 Unexpected value 'wth'`,
      `error ${WF}/w.yml:12:9 Unexpected value 'evn'`,
      `error ${WF}/w.yml:16:5 Unexpected value 'run-on'`,
      `error ${WF}/w.yml:17:5 Unexpected value 'step'`,
      `error ${WF}/w.yml:22:5 Unexpected value 'secret'`,
      `error ${WF}/w.yml:23:5 Unexpected value 'needz'`,
    ]);
  });

  it('reports a misplaced key and a typo in a step the parser guessed wrong at their own keys', () => {
    expect(
      schema503({
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
      `error ${WF}/w.yml:6:9 Unexpected value 'working-directory' (not allowed together with \`uses\`)`,
      `error ${WF}/w.yml:8:9 Unexpected value 'wth'`,
    ]);
  });

  it('explains a misplaced key the same way whichever key comes first', () => {
    const step = (keys: string) =>
      schema503({
        [`${WF}/w.yml`]: `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - ${keys}\n`,
      }).map((f) => f.replace(/^.*?:\d+:\d+ /, ''));
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
      schema503({
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
    ).toHaveLength(2);
  });
});
