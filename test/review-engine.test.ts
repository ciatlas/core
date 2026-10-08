/** Regression tests for findings of the adversarial review (engine: parser, evaluator, rules). */
import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF, yaml } from './helpers';

const callee = (inputs: string) =>
  `on:\n  workflow_call:\n    inputs:\n${inputs}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo \${{ toJSON(inputs) }}\n`;

describe('YAML anchors and aliases are resolved', () => {
  it('aliased strategy keeps the matrix', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          test:
            runs-on: \${{ matrix.os }}
            strategy: &strat
              matrix:
                os: [ubuntu-latest, windows-latest]
            steps: [{ run: echo }]
          lint:
            runs-on: \${{ matrix.os }}
            strategy: *strat
            steps: [{ run: echo }]
      `,
    });
    expect(codes(r)).not.toContain('FP404');
  });

  it('aliased include entries and scalar values keep their keys', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        env:
          DEF: &def ci-default.json
        jobs:
          a:
            runs-on: x
            strategy:
              matrix:
                include:
                  - &linux { os: ubuntu-latest, config: ci-linux.json }
            steps:
              - run: echo \${{ matrix.config }}
          b:
            runs-on: x
            strategy:
              matrix:
                os: [&u ubuntu-latest, windows-latest]
                include:
                  - { os: *u, config: *def }
                  - { os: windows-latest, config: ci-windows.json }
            steps:
              - uses: actions/setup-node@v4
                with:
                  node-version: \${{ matrix.config }}
          c:
            runs-on: x
            strategy:
              matrix:
                include: [*linux, { os: windows-latest, config: ci-windows.json }]
            steps:
              - uses: actions/setup-node@v4
                with:
                  node-version: \${{ matrix.config }}
      `,
    });
    expect(codes(r).filter((c) => c.startsWith('FP40'))).toEqual([]);
    const b = r.project.workflows.get(`${WF}/w.yml`)!.jobs.b!;
    expect(b.matrix!.include[0]!.values).toEqual({ os: 'ubuntu-latest', config: 'ci-default.json' });
  });
});

describe('matrix rules respect guards and deliberate checks', () => {
  const matrix = (steps: string) => yaml`
    on: push
    jobs:
      t:
        runs-on: \${{ matrix.os }}
        strategy:
          matrix:
            os: [ubuntu-latest, windows-latest]
            include:
              - os: windows-latest
                arch: x64
        steps:
${steps}
  `;

  it('skips combinations excluded by the step or job if:', () => {
    const r = lint({
      [`${WF}/m.yml`]: matrix(`          - if: matrix.arch
            uses: ilammy/msvc-dev-cmd@v1
            with:
              arch: \${{ matrix.arch }}
          - if: \${{ matrix.os == 'windows-latest' }}
            run: echo \${{ matrix.arch }}`),
    });
    expect(codes(r)).toEqual([]);
  });

  it('still reports when the guard does not exclude the combination', () => {
    const r = lint({
      [`${WF}/m.yml`]: matrix(`          - if: matrix.os != 'macos'
            run: echo \${{ matrix.arch }}`),
    });
    expect(codes(r)).toEqual(['FP402']);
  });

  it('does not report comparisons, negation or && guards', () => {
    const r = lint({
      [`${WF}/m.yml`]: matrix(`          - uses: actions/setup-node@v4
            with:
              cache: \${{ matrix.arch && 'npm' }}
          - env:
              HAS: \${{ matrix.arch != null }}
              NOT: \${{ !matrix.arch }}
              IS: \${{ matrix.arch == 'x64' }}
              CON: \${{ contains(matrix.arch, 'x') }}
            run: echo`),
    });
    expect(codes(r)).toEqual([]);
  });

  it('reports non-empty with: values that interpolate a missing key (FP402)', () => {
    const r = lint({
      [`${WF}/m.yml`]: matrix(`          - uses: some/action@v1
            with:
              args: --arch=\${{ matrix.arch }}
              path: \${{ format('cfg/{0}', matrix.arch) }}`),
    });
    expect(codes(r)).toEqual(['FP402', 'FP402']);
  });
});

describe('inputs', () => {
  it('FP101 flags a missing required reusable-workflow input even with a default', () => {
    const r = lint({
      [`${WF}/top.yml`]: 'on: push\njobs:\n  call:\n    uses: ./.github/workflows/called.yml\n',
      [`${WF}/called.yml`]: callee("      a: { type: string, required: true, default: 'x' }"),
    });
    expect(codes(r)).toContain('FP101');
  });

  it('FP101 still accepts a default for composite action inputs', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n',
      '.github/actions/a/action.yml':
        "inputs:\n  must: { required: true, default: 'x' }\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.must }}\n      shell: bash\n",
    });
    expect(codes(r)).not.toContain('FP101');
  });

  it('FP104 skips JavaScript and Docker actions', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/js\n        with: { token: t }\n      - uses: ./.github/actions/dock\n        with: { path: p }\n',
      '.github/actions/js/action.yml':
        'inputs:\n  token: { required: true }\nruns:\n  using: node20\n  main: index.js\n',
      '.github/actions/dock/action.yml': 'inputs:\n  path: {}\nruns:\n  using: docker\n  image: Dockerfile\n',
    });
    expect(codes(r)).not.toContain('FP104');
  });

  it('github.event.inputs in called workflows and actions belongs to the dispatching workflow', () => {
    const r = lint({
      [`${WF}/top.yml`]: yaml`
        on:
          workflow_dispatch:
            inputs:
              env-name: { type: string, required: true }
        jobs:
          call:
            uses: ./.github/workflows/called.yml
      `,
      [`${WF}/called.yml`]: yaml`
        on: workflow_call
        jobs:
          j:
            runs-on: x
            steps:
              - run: echo \${{ github.event.inputs.env-name }}
              - uses: ./.github/actions/comp
      `,
      '.github/actions/comp/action.yml':
        'runs:\n  using: composite\n  steps:\n    - run: echo ${{ github.event.inputs.env-name }}\n      shell: bash\n',
    });
    expect(codes(r)).not.toContain('FP108');
    expect(codes(r)).not.toContain('FP104');
  });

  it('FP105 accepts explicit empty checks and number inputs', () => {
    const r = lint({
      [`${WF}/d.yml`]: yaml`
        on:
          workflow_dispatch:
            inputs:
              target: { type: string, required: false }
              shards: { type: number, required: false }
        jobs:
          a:
            if: inputs.target != ''
            runs-on: x
            steps: [{ run: echo }]
          b:
            if: inputs.shards > 1
            runs-on: x
            steps: [{ run: echo }]
      `,
    });
    expect(codes(r)).not.toContain('FP105');
  });

  it('FP107 knows optional numbers default to 0', () => {
    const r = lint({
      [`${WF}/outer.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              retries: { type: number, required: false }
        jobs:
          call:
            uses: ./.github/workflows/inner.yml
            with:
              retries: \${{ inputs.retries }}
      `,
      [`${WF}/inner.yml`]: callee('      retries: { type: number, required: true }'),
    });
    expect(codes(r)).not.toContain('FP107');
  });
});

describe('outputs and run scripts', () => {
  it('reads every write on a line and if/else one-liners', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - id: a
                run: echo "x=1" >> "$GITHUB_OUTPUT"; echo "y=2" >> "$GITHUB_OUTPUT"
              - id: b
                run: |
                  echo "skip=false" >> "$GITHUB_OUTPUT"
                  if [ -f x ]; then echo "skip=true" >> "$GITHUB_OUTPUT"; else echo "reason=missing" >> "$GITHUB_OUTPUT"; fi
              - run: echo "A=1" >> "$GITHUB_ENV" && echo "B=2" >> "$GITHUB_ENV"
              - run: echo \${{ steps.a.outputs.y }} \${{ steps.b.outputs.reason }} \${{ env.B }}
      `,
    });
    expect(codes(r)).toEqual([]);
  });

  it('knows actions/github-script always sets result', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/github-script@v7
                id: gs
                with:
                  script: |
                    core.setOutput('other', 'x');
                    return 42;
              - run: echo "\${{ steps.gs.outputs.result }} \${{ steps.gs.outputs.other }}"
      `,
    });
    expect(codes(r)).toEqual([]);
  });

  it('allows undeclared outputs of JavaScript actions but not of composite actions', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: js\n        uses: ./.github/actions/js\n      - id: comp\n        uses: ./.github/actions/comp\n      - run: echo ${{ steps.js.outputs.undeclared }} ${{ steps.comp.outputs.undeclared }}\n',
      '.github/actions/js/action.yml': 'outputs:\n  sha: {}\nruns:\n  using: node20\n  main: index.js\n',
      '.github/actions/comp/action.yml':
        'outputs:\n  sha:\n    value: x\nruns:\n  using: composite\n  steps: []\n',
    });
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      '.github/actions/comp has no output "undeclared"',
    ]);
  });
});

describe('structure and references', () => {
  it('FP609 reports calls to workflows without workflow_call, and nothing misleading', () => {
    const r = lint({
      [`${WF}/top.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/called.yml\n    with:\n      target: prod\n',
      [`${WF}/called.yml`]:
        'on:\n  workflow_dispatch:\n    inputs:\n      target: { type: string, required: true }\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ inputs.target }}\n',
    });
    expect(codes(r)).toEqual(['FP609']);
    expect(byCode(r, 'FP609')[0]!.message).toContain('not reusable');
  });

  it('loads the action at the repository root (uses: ./)', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./\n        with: { nope: 1 }\n',
      'action.yml':
        'inputs:\n  token: {}\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.token }}\n      shell: bash\n',
    });
    expect(byCode(r, 'FP102').map((f) => f.message)).toEqual(['. has no input "nope"']);
    expect(codes(r)).not.toContain('FP606');
  });

  it('never reads local uses: targets outside the repository', () => {
    const r = lint({
      [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./../../etc\n',
    });
    expect(byCode(r, 'FP606').length).toBe(1);
    expect(r.project.actions.size).toBe(0);
  });

  it('does not report same-repo @ref references that are missing from the working tree', () => {
    const r = lint({
      [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    uses: acme/repo/.github/workflows/old.yml@v1\n',
    });
    expect(codes(r)).not.toContain('FP606');
  });
});

describe('schema: context availability (FP505)', () => {
  it('reports env in a reusable call with:, keeps typos for FP502 only', () => {
    const r = lint(
      {
        [`${WF}/c.yml`]: yaml`
          on: push
          env:
            TARGET: prod
          jobs:
            k:
              uses: ./.github/workflows/r.yml
              with:
                t: \${{ env.TARGET }}
        `,
        [`${WF}/r.yml`]: callee('      t: { type: string }'),
      },
      { schema: true },
    );
    const f = byCode(r, 'FP505');
    expect(f.map((x) => x.message)).toEqual([
      '`env` is not available here — GitHub rejects the workflow ("Unrecognized named-value: \'env\'")',
    ]);
    expect(f[0]!.loc.line).toBe(8);
    expect(codes(r)).not.toContain('FP503');
  });

  it('does not require name/description for local actions', () => {
    const r = lint(
      {
        '.github/actions/a/action.yml':
          'runs:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n',
      },
      { schema: true },
    );
    expect(codes(r)).not.toContain('FP503');
  });
});

describe('reference locations in folded, literal and quoted conditions', () => {
  it('points at the reference itself', () => {
    const text = yaml`
      on: push
      jobs:
        j:
          if: >-
            github.event_name == 'push' &&
            env.NOT_DEFINED_ANYWHERE == 'x'
          runs-on: x
          steps:
            - if: |
                github.event_name == 'push' &&
                env.ALSO_UNDEFINED == 'y'
              run: echo
            - if: 'github.event_name == ''push'' && env.QUOTED_UNDEF'
              run: echo
    `;
    const r = lint({ [`${WF}/w.yml`]: text });
    const lines = text.split('\n');
    const locs = r.index
      .units()[0]!
      .sites.flatMap((s) => s.segments.flatMap((seg) => seg.refs))
      .filter((ref) => ref.context === 'env');
    expect(locs.map((l) => lines[l.loc.line - 1]!.slice(l.loc.column - 1, l.loc.endColumn - 1))).toEqual([
      'env.NOT_DEFINED_ANYWHERE',
      'env.ALSO_UNDEFINED',
      'env.QUOTED_UNDEF',
    ]);
  });

  it('handles CRLF files', () => {
    const text =
      'on: push\r\njobs:\r\n  j:\r\n    runs-on: x\r\n    steps:\r\n      - run: |\r\n          echo one\r\n          echo ${{ inputs.zzz }}\r\n';
    const [f] = byCode(lint({ [`${WF}/w.yml`]: text }), 'FP108');
    expect(f?.loc).toMatchObject({ line: 8, column: 20 });
  });
});
