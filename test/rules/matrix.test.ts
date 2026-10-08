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

describe('WFC401 empty-binding-for-matrix-combo — the shipped-without-a-variant incident', () => {
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
    [`${WF}/callee.yml`]: callee,
  });

  it('names the combination, the include entry, the chain and the receiving input', () => {
    const r = lint(files('${{ matrix.config }}'));
    const [f] = byCode(r, 'WFC401');
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
    ]);
    expect(f?.symbol).toBe(`${WF}/callee.yml#inputs.config`);
  });

  it('is quiet with an explicit fallback or when every combination defines the key', () => {
    expect(byCode(lint(files("${{ matrix.config || 'default.json' }}")), 'WFC401')).toEqual([]);
    expect(
      byCode(lint(files('${{ matrix.config }}', '\n                  config: win.json')), 'WFC401'),
    ).toEqual([]);
  });

  it('catches the missing key through string functions', () => {
    expect(byCode(lint(files("${{ format('{0}', matrix.config) }}")), 'WFC401')).toHaveLength(1);
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
    const [f] = byCode(r, 'WFC401');
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
    expect(codes(r)).toContain('WFC401');
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
    expect(byCode(r, 'WFC401')).toEqual([]);
  });
});

describe('WFC402 matrix-key-missing-in-combo', () => {
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
    const [f] = byCode(w('run: ./test --shard ${{ matrix.shard }}'), 'WFC402');
    expect(f?.message).toBe('matrix.shard is undefined in 2 of 3 combinations of jobs.j');
    expect(f?.combos).toEqual(['{ suite: unit }', '{ suite: canary, experimental: true }']);
    expect(f?.related[0]?.message).toBe('this include entry has no `shard`');
  });

  it('exempts conditions and continue-on-error', () => {
    const r = w('if: matrix.experimental\n          run: echo x');
    expect(byCode(r, 'WFC402')).toEqual([]);
  });
});

describe('WFC403 dynamic-matrix-unverified', () => {
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
    expect(byCode(r, 'WFC403')[0]?.message).toBe(
      'jobs.j has a runtime-computed matrix; reads of matrix.os cannot be verified',
    );
  });
});

describe('WFC404 undefined-matrix-key', () => {
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
    expect(byCode(r, 'WFC404').map((f) => f.message)).toEqual([
      'matrix.sute is not defined in any combination of jobs.a (keys: suite)',
      'jobs.b has no matrix, so matrix.os is always empty',
    ]);
    // The typo is not double-reported as "missing in some combinations".
    expect(byCode(r, 'WFC402')).toEqual([]);
  });
});
