import { describe, expect, it } from 'vitest';
import { at, byCode, codes, lint, WF, yaml } from '../helpers';

const callee = yaml`
  on:
    workflow_call:
      inputs:
        config: { type: string, required: false }
        name: { type: string, required: true }
  jobs:
    j:
      runs-on: x
      steps:
        - run: echo \${{ inputs.config }} \${{ inputs.name }}
`;

describe('FP401 empty-binding-for-matrix-combo — the shipped-without-a-variant incident', () => {
  const files = (binding: string, extraEntry = '') => ({
    [`${WF}/root.yml`]: 'on: push\njobs:\n  t:\n    uses: ./.github/workflows/tests.yml\n',
    [`${WF}/tests.yml`]: yaml`
      on: workflow_call
      jobs:
        run:
          strategy:
            matrix:
              include:
                - name: linux
                  config: linux.json
                - name: windows${extraEntry}
          uses: ./.github/workflows/callee.yml
          with:
            name: \${{ matrix.name }}
            config: ${binding}
    `,
    // As in the incident: the callee skips its work when the optional config is empty.
    [`${WF}/callee.yml`]: callee.replace('runs-on: x', "runs-on: x\n    if: inputs.config != ''"),
  });

  it('names the combination, the include entry, the chain and the receiving input', () => {
    const r = lint(files('${{ matrix.config }}'));
    const [f] = byCode(r, 'FP401');
    expect(f?.severity).toBe('error');
    expect(f?.message).toBe(
      'Input "config" for .github/workflows/callee.yml is empty in 1 of 2 matrix combinations — matrix.config is not defined there',
    );
    expect(f?.combos).toEqual(['{ name: windows }']);
    expect(at(f!)).toBe(`${WF}/tests.yml:13:19`);
    expect(f?.related.map((x) => x.message)).toEqual([
      'jobs.t calls .github/workflows/tests.yml',
      'this include entry has no `config`',
      'receives the empty value: input "config"',
      'this condition reads "config", so the legs with an empty value take the other branch',
    ]);
    expect(f?.symbol).toBe(`${WF}/callee.yml#inputs.config`);
  });

  it("is the same error when the callee writes default: '' (GitHub's value for a missing default)", () => {
    const r = lint({
      ...files('${{ matrix.config }}'),
      [`${WF}/callee.yml`]: callee
        .replace(
          'config: { type: string, required: false }',
          "config: { type: string, required: false, default: '' }",
        )
        .replace('runs-on: x', "runs-on: x\n    if: inputs.config != ''"),
    });
    expect(byCode(r, 'FP401').map((f) => `${f.severity} ${at(f)}`)).toEqual([`error ${WF}/tests.yml:13:19`]);
  });

  it('is quiet with an explicit fallback or when every combination defines the key', () => {
    expect(byCode(lint(files("${{ matrix.config || 'default.json' }}")), 'FP401')).toEqual([]);
    expect(
      byCode(lint(files('${{ matrix.config }}', '\n                  config: win.json')), 'FP401'),
    ).toEqual([]);
  });

  it('catches the missing key through string functions', () => {
    expect(byCode(lint(files("${{ format('{0}', matrix.config) }}")), 'FP401')).toHaveLength(1);
  });

  it('works for product matrices with partial includes and for action inputs', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            strategy:
              matrix:
                os: [linux, mac]
                include:
                  - os: linux
                    target: x86
            steps:
              - uses: ./.github/actions/build
                with:
                  target: \${{ matrix.target }}
      `,
      '.github/actions/build/action.yml':
        'inputs:\n  target: { required: true }\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.target }}\n      shell: bash\n',
    });
    const [f] = byCode(r, 'FP401');
    expect(f?.combos).toEqual(['{ os: mac }']);
    expect(f?.related.at(-1)?.message).toBe('receives the empty value: input "target"');
  });

  it('also covers remote workflows and actions (the value is still empty)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            strategy:
              matrix:
                include: [{ a: 1, b: 2 }, { a: 3 }]
            uses: o/r/.github/workflows/x.yml@v1
            with:
              b: \${{ matrix.b }}
      `,
    });
    expect(codes(r)).toContain('FP401');
  });

  describe('weighs the empty value by the input that receives it', () => {
    const files = (decl: string, step = 'run: echo ${{ inputs.arm }}') => ({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            strategy:
              matrix:
                include: [{ arch: arm, arm: '7' }, { arch: amd64 }]
            steps:
              - uses: ./.github/actions/build-go
                with:
                  arm: \${{ matrix.arm }}
      `,
      '.github/actions/build-go/action.yml': `inputs:\n  arm: ${decl}\nruns:\n  using: composite\n  steps:\n    - ${step}\n      shell: bash\n`,
    });
    const run = (decl: string, step?: string) => byCode(lint(files(decl, step)), 'FP401');
    const gated = "if: inputs.arm != ''\n      run: echo arm";

    it('is quiet for an optional input whose default is empty (grafana build-go: "leave empty for non-ARM")', () => {
      expect(run("{ required: false, default: '' }")).toEqual([]);
      expect(run('{ required: false, default: }')).toEqual([]);
    });

    it('is quiet for an optional input without a default that no condition reads', () => {
      expect(run('{ required: false }')).toEqual([]);
    });

    it.each([
      ['without a default', '{ required: false }'],
      // GitHub gives a missing default as '' for a string: `default: ''` declares the same value.
      ["with default: ''", "{ required: false, default: '' }"],
      ['with default: (null)', '{ required: false, default: }'],
    ])('is an error when a condition in the callee reads an optional input %s', (_name, decl) => {
      const [f] = run(decl, gated);
      expect(f?.severity).toBe('error');
      expect(f?.related.at(-1)?.message).toBe(
        'this condition reads "arm", so the legs with an empty value take the other branch',
      );
    });

    it('is quiet when the condition only reads the input through a fallback (as FP105)', () => {
      expect(run('{ required: false }', "if: (inputs.arm || 'all') == 'all'\n      run: echo arm")).toEqual(
        [],
      );
      // A fallback elsewhere does not hide a condition that reads the value itself; that one is the related location.
      const [f] = run(
        '{ required: false }',
        "if: (inputs.arm || 'all') == 'all'\n      run: echo arm\n      shell: bash\n    - if: inputs.arm\n      run: echo arm",
      );
      expect(f?.severity).toBe('error');
      expect(f?.related.at(-1)?.loc.line).toBe(9);
    });

    it('is a warning when the empty value replaces a non-empty default', () => {
      const [f] = run("{ required: false, default: '6' }");
      expect(f?.severity).toBe('warning');
      expect(f?.message).toBe(
        `Input "arm" for .github/actions/build-go is empty in 1 of 2 matrix combinations — matrix.arm is not defined there, which replaces the input's default "6"`,
      );
    });

    it('stays an error for a required input', () => {
      expect(run('{ required: true }').map((f) => f.severity)).toEqual(['error']);
    });

    it('never raises a severity the config lowered', () => {
      const r = lint(files("{ default: '6' }"), { config: { rules: { FP401: 'info' } } });
      expect(byCode(r, 'FP401').map((f) => f.severity)).toEqual(['info']);
    });
  });

  it('does not guess about unknown matrix values', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: workflow_dispatch
        jobs:
          j:
            runs-on: x
            strategy:
              matrix:
                os: [linux, '\${{ github.event.inputs.os }}']
            steps:
              - uses: actions/setup@v1
                with:
                  os: \${{ matrix.os }}
      `,
    });
    expect(byCode(r, 'FP401')).toEqual([]);
  });
});

describe('FP402 matrix-key-missing-in-combo', () => {
  const w = (step: string) =>
    lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            continue-on-error: \${{ matrix.experimental }}
            strategy:
              matrix:
                suite: [unit, e2e]
                include:
                  - suite: e2e
                    shard: 1
                  - suite: canary
                    experimental: true
            steps:
              - ${step}
      `,
    });

  it('flags run scripts that interpolate a key missing in some combinations', () => {
    const [f] = byCode(w('run: ./test --shard ${{ matrix.shard }}'), 'FP402');
    expect(f?.message).toBe('matrix.shard is undefined in 2 of 3 combinations of jobs.j');
    expect(f?.combos).toEqual(['{ suite: unit }', '{ suite: canary, experimental: true }']);
    expect(f?.related[0]?.message).toBe('this include entry has no `shard`');
  });

  it('exempts conditions and continue-on-error', () => {
    const r = w('if: matrix.experimental\n          run: echo x');
    expect(byCode(r, 'FP402')).toEqual([]);
  });

  describe('treats quoted shell tests in run scripts as explicit handling', () => {
    // Every script also echoes `matrix.experimental` unguarded: that finding proves the script was analyzed.
    const script = (body: string) =>
      byCode(
        w(`run: |\n${`${body}\necho \${{ matrix.experimental }}`.replace(/^/gm, ' '.repeat(18))}`),
        'FP402',
      ).map((f) => f.message);
    const control = 'matrix.experimental is undefined in 2 of 3 combinations of jobs.j';

    it.each([
      // cilium build-go-caches.yaml: an empty require-dir means "always build"
      [
        '-z / -d (cilium)',
        'if [[ -z "${{ matrix.shard }}" ]] ||\n   [[ -d "${{ matrix.shard }}" ]]; then\n  echo build\nfi',
      ],
      ['-n', 'if [ -n "${{ matrix.shard }}" ]; then ./test --shard "$S"; fi'],
      // llvm libc-fullbuild-tests.yml
      [
        '== / != in [[ ]] (llvm)',
        'if [[ "${{ matrix.shard }}" != "SKIP" || "${{ matrix.shard }}" == "ON" ]]; then echo; fi',
      ],
      // cpython jit.yml
      ['= in [ ] (cpython)', 'if [ "${{ matrix.shard }}" = "true" ]; then echo; fi'],
      ['a comparison on the right', "test 'x' != '${{ matrix.shard }}' && echo"],
      ['test as a command after &&', 'cd x && test -n "${{ matrix.shard }}" && echo ok'],
      ['a negated test', 'if ! [ -z "${{ matrix.shard }}" ]; then echo; fi'],
    ])('%s', (_name, body) => {
      expect(script(body)).toEqual([control]);
    });

    it.each([
      ['an unquoted operand (the test breaks when it is empty)', '[[ ${{ matrix.shard }} == 1 ]] && echo'],
      ['a flag that looks like a test operator outside a test', 'cmake -D "${{ matrix.shard }}"'],
      [
        'a use after the test',
        'if [[ -z "${{ matrix.shard }}" ]]; then exit 0; fi\n./test --shard=${{ matrix.shard }}',
      ],
      // `test` and `[` only start a test as a command, not as an argument of one.
      ['cargo test -p', 'cargo test -p "${{ matrix.shard }}"'],
      ['go test -v', 'go test -v "${{ matrix.shard }}"'],
      ['npm test -w', 'npm test -w "${{ matrix.shard }}"'],
      ['pnpm test -F', "pnpm test -F '${{ matrix.shard }}'"],
      ['a flag compared after an argument named test', 'yarn test --filter="${{ matrix.shard }}" == x'],
      ['[[ inside a string', 'echo "[[ start" && tar -x "${{ matrix.shard }}" && echo "done ]]"'],
      ['a command after a closed [ ]', '[ -f x ] && cp -r "${{ matrix.shard }}" /dst ]'],
      ['an argument named test before ]', 'docker run -e "${{ matrix.shard }}" img test -x ]'],
    ])('still flags %s', (_name, body) => {
      expect(script(body)).toEqual(['matrix.shard is undefined in 2 of 3 combinations of jobs.j', control]);
    });

    it('points at the read that is still unguarded, not at the test', () => {
      const [f] = byCode(
        w('run: |\n                  [[ -n "${{ matrix.shard }}" ]] && ./t --shard=${{ matrix.shard }}'),
        'FP402',
      );
      // Column 22 is the read inside `[[ -n … ]]`; 61 the one after `--shard=`.
      expect(at(f!)).toBe(`${WF}/w.yml:16:61`);
    });
  });
});

describe('FP403 dynamic-matrix-unverified', () => {
  it('reports runtime matrices whose keys are read', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          s:
            runs-on: x
            outputs: { m: x }
            steps: [{ run: x }]
          j:
            needs: s
            runs-on: \${{ matrix.os }}
            strategy:
              matrix: \${{ fromJSON(needs.s.outputs.m) }}
            steps: [{ run: x }]
      `,
    });
    expect(byCode(r, 'FP403')[0]?.message).toBe(
      'jobs.j has a runtime-computed matrix; reads of matrix.os cannot be verified',
    );
  });
});

describe('FP404 undefined-matrix-key', () => {
  it('flags keys no combination defines, and matrix reads in jobs without a matrix', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            strategy:
              matrix:
                suite: [unit]
            steps:
              - run: echo \${{ matrix.sute }}
          b:
            runs-on: x
            steps:
              - run: echo \${{ matrix.os }}
      `,
    });
    expect(byCode(r, 'FP404').map((f) => f.message)).toEqual([
      'matrix.sute is not defined in any combination of jobs.a (keys: suite)',
      'jobs.b has no matrix, so matrix.os is always empty',
    ]);
    // The typo is not double-reported as "missing in some combinations".
    expect(byCode(r, 'FP402')).toEqual([]);
  });

  describe('reads with a fallback that always applies (envoy _check_build_openssl.yml)', () => {
    const w = (value: string, extra = '') =>
      lint({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            build:
              runs-on: x
              strategy:
                matrix:
                  include:
                    - target: openssl
                      name: OpenSSL
              steps:
                - ${extra}run: echo "${value}"
        `,
      });
    const fp404 = (value: string, extra?: string) =>
      byCode(w(value, extra), 'FP404').map((f) => `${f.severity} ${f.loc.column} ${f.message}`);
    const severities = (value: string, extra?: string) =>
      byCode(w(value, extra), 'FP404').map((f) => f.severity);

    it.each([
      ['a fallback', '${{ matrix.docker-ci || false }}'],
      ['a fallback to another key', '${{ matrix.docker-ci || matrix.target }}'],
      ['a fallback to a runtime value', '${{ matrix.docker-ci || github.sha }}'],
      ['a fallback in parentheses, before another', "${{ (matrix.docker-ci || github.sha) || 'x' }}"],
      ['a fallback inside a function', "${{ fromJSON(matrix.docker-ci || '1') }}"],
    ])('reports %s once, as info', (_name, value) => {
      const found = byCode(w(value), 'FP404');
      expect(found.map((f) => f.severity)).toEqual(['info']);
      expect(found[0]?.message).toBe(
        'matrix.docker-ci is not defined in any combination of jobs.build (keys: target, name); the fallback always applies',
      );
    });

    // A comparison or test on a key no combination defines always gives the same answer: the mark of a typo.
    it.each([
      ['a plain read', '${{ matrix.docker-ci }}'],
      ['the fallback itself', '${{ github.event.inputs.ci || matrix.docker-ci }}'],
      ['a value built before the fallback', "${{ format('--ci={0}', matrix.docker-ci) || 'x' }}"],
      ['a read after a guard on something else', '${{ github.event.inputs.ci && matrix.docker-ci }}'],
      ['an empty fallback', "--config=${{ matrix.docker-ci || '' }}"],
      ['a fallback to another undefined key', '${{ matrix.docker-ci || matrix.docker-cd }}'],
      ['a comparison (always false)', "--gpu=${{ matrix.docker-ci == 'true' }}"],
      ['a comparison guarding a fallback (envoy)', '${{ matrix.docker-ci != false && true || false }}'],
      ['a && guard (the flag is never set)', "${{ matrix.docker-ci && '--flag' }}"],
      ['a negation', '${{ !matrix.docker-ci }}'],
      ['a quoted shell test (always true)', '[[ -z "${{ matrix.docker-ci }}" ]]'],
    ])('keeps %s an error', (_name, value) => {
      expect(severities(value).every((s) => s === 'error') && severities(value).length > 0).toBe(true);
    });

    it('keeps every read an error when the same key is also compared (envoy _publish_verify.yml)', () => {
      expect(
        fp404("${{ matrix.docker-ci == 'arm64' && format('-{0}', matrix.docker-ci) || '' }}").map(
          (f) => f.split(' ')[0],
        ),
      ).toEqual(['error', 'error']);
    });

    it('keeps an error on every plain read when one read in the script is unhandled', () => {
      expect(
        fp404("${{ matrix.docker-ci || 'x' }} ${{ matrix.docker-ci }}").map((f) => f.split(' ')[0]),
      ).toEqual(['error', 'error']);
    });

    it('keeps a fallback an error when the key is close to one the matrix defines', () => {
      expect(severities("${{ matrix.targets || 'all' }}")).toEqual(['error']);
    });

    it('keeps conditions on the key errors, whether always true or never true', () => {
      for (const condition of [
        "matrix.os == 'windows'",
        'matrix.skip != true',
        "matrix.oss != 'windows'",
        '${{ !matrix.skip }}',
        "matrix.skip == 'true' || github.event_name == 'push'",
      ])
        expect(severities('x', `if: ${condition}\n                  `), condition).toEqual(['error']);
      // A fallback that always applies is info in a condition too, unless the step then never runs.
      expect(severities('x', "if: (matrix.os || 'linux') == 'linux'\n                  ")).toEqual(['info']);
      expect(severities('x', 'if: matrix.skip || false\n                  ')).toEqual(['error']);
    });

    it('keeps an empty fallback passed to a callee an error', () => {
      const r = lint({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            call:
              strategy:
                matrix:
                  os: [linux, windows]
              uses: ./.github/workflows/b.yml
              with:
                config: \${{ matrix.conf || '' }}
        `,
        [`${WF}/b.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                config: { type: string, required: true }
          jobs:
            x:
              runs-on: x
              steps:
                - run: echo \${{ inputs.config }}
        `,
      });
      expect(byCode(r, 'FP404').map((f) => f.severity)).toEqual(['error']);
    });

    it('also applies to jobs without a matrix (airflow special-tests.yml keeps its error)', () => {
      const r = lint({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            a:
              name: "System test: \${{ matrix.test-group }}"
              runs-on: x
              steps:
                - run: echo \${{ matrix.os || 'linux' }}
        `,
      });
      expect(byCode(r, 'FP404').map((f) => `${f.severity} ${f.message}`)).toEqual([
        'error jobs.a has no matrix, so matrix.test-group is always empty',
        'info jobs.a has no matrix, so matrix.os is always empty; the fallback always applies',
      ]);
    });
  });
});
