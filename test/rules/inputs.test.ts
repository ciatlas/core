import { describe, expect, it } from 'vitest';
import { at, byCode, codes, lint, WF, yaml } from '../helpers';

const callee = yaml`
  on:
    workflow_call:
      inputs:
        name: { type: string, required: true }
        flag: { type: boolean, default: false }
        count: { type: number, required: false }
        optional: { type: string, required: false }
  jobs:
    j:
      runs-on: x
      if: inputs.flag && inputs.count > 0
      steps:
        - run: echo \${{ inputs.name }} \${{ inputs.optional }}
`;

describe('WFC101 missing-required-input', () => {
  it('flags a reusable call without a required input, at the uses: line', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with:
              flag: true
      `,
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'WFC101');
    expect(f?.message).toContain('without required input "name"');
    expect(at(f!)).toBe(`${WF}/caller.yml:4:11`);
    expect(f?.related.at(-1)?.loc.file).toBe(`${WF}/callee.yml`);
    expect(f?.symbol).toBe(`${WF}/callee.yml#inputs.name`);
  });

  it('does not flag required inputs that have a default, or that are passed', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      Name: x\n',
      [`${WF}/callee.yml`]: callee.replace('required: true }', 'required: true, default: d }'),
    });
    expect(byCode(r, 'WFC101')).toEqual([]);
  });

  it('flags required action inputs (which GitHub does not enforce)', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n',
      '.github/actions/a/action.yml':
        'inputs:\n  must: { required: true }\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.must }}\n      shell: bash\n',
    });
    expect(byCode(r, 'WFC101')[0]?.message).toMatch(/empty value/);
  });
});

describe('WFC102 unknown-input', () => {
  it('flags undeclared inputs and suggests the closest name', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: x\n      nmae: y\n      zzz: 1\n',
      [`${WF}/callee.yml`]: callee,
    });
    const msgs = byCode(r, 'WFC102').map((f) => f.message);
    expect(msgs).toEqual([
      '.github/workflows/callee.yml has no input "nmae" — did you mean "name"?',
      '.github/workflows/callee.yml has no input "zzz"',
    ]);
    expect(byCode(r, 'WFC102')[0]!.fix).toBe('Rename "nmae" to "name".');
  });

  it('treats - and _ as equivalent when suggesting', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n        with:\n          cache_dir: x\n',
      '.github/actions/a/action.yml':
        'inputs:\n  cache-dir: {}\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.cache-dir }}\n      shell: bash\n',
    });
    expect(byCode(r, 'WFC102')[0]?.message).toContain('did you mean "cache-dir"');
  });
});

describe('WFC103 input-type-mismatch', () => {
  it('flags quoted booleans and non-numeric literals for typed inputs', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with:
              name: n
              flag: "true"
              count: many
      `,
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'WFC103').map((f) => f.message)).toEqual([
      'Input "flag" of .github/workflows/callee.yml is a boolean, but jobs.call passes a string ("true")',
      'Input "count" of .github/workflows/callee.yml is a number, but jobs.call passes a string ("many")',
    ]);
  });

  it('accepts correct literals and statically unknown expressions', () => {
    const r = lint({
      [`${WF}/caller.yml`]: yaml`
        on: push
        jobs:
          call:
            uses: ./.github/workflows/callee.yml
            with:
              name: n
              flag: \${{ github.event_name == 'push' }}
              count: 3
      `,
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'WFC103')).toEqual([]);
  });

  it('evaluates constant expressions', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        "on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      flag: ${{ 'yes' }}\n",
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'WFC103')).toHaveLength(1);
  });
});

describe('WFC104 unused-input', () => {
  it('flags declared inputs that are never read, noting callers that still pass them', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      dead: 1\n',
      [`${WF}/callee.yml`]: callee.replace(
        'optional: { type: string, required: false }',
        'optional: { type: string, required: false }\n      dead: { type: string }',
      ),
    });
    const [f] = byCode(r, 'WFC104');
    expect(f?.message).toBe(
      'Input "dead" of .github/workflows/callee.yml is never read (yet 1 caller passes it)',
    );
    expect(f?.related[0]?.message).toBe('passed here');
  });

  it('counts github.event.inputs reads and skips files that read inputs dynamically', () => {
    const r = lint({
      [`${WF}/a.yml`]:
        'on:\n  workflow_dispatch:\n    inputs:\n      x: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ github.event.inputs.x }}\n',
      [`${WF}/b.yml`]:
        "on:\n  workflow_dispatch:\n    inputs:\n      y: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo '${{ toJSON(inputs) }}'\n",
    });
    expect(byCode(r, 'WFC104')).toEqual([]);
  });

  it('flags unused action inputs', () => {
    const r = lint({
      '.github/actions/a/action.yml':
        'inputs:\n  unused: {}\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n',
    });
    expect(byCode(r, 'WFC104')[0]?.symbol).toBe('.github/actions/a#inputs.unused');
  });
});

describe('WFC105 optional-input-no-default-in-condition', () => {
  const w = (callerWith: string) =>
    lint({
      [`${WF}/caller.yml`]: `on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n${callerWith}`,
      [`${WF}/callee.yml`]: callee.replace(
        'if: inputs.flag && inputs.count > 0',
        "if: inputs.optional == 'gpu'",
      ),
    });

  it('flags the condition when some caller omits the input', () => {
    const [f] = byCode(w(''), 'WFC105');
    expect(f?.message).toContain('optional input "optional"');
    expect(f?.related.map((r) => r.message)).toContain('.github/workflows/caller.yml › jobs.call omits it');
  });

  it('is quiet when every caller passes the input', () => {
    expect(byCode(w('      optional: gpu\n'), 'WFC105')).toEqual([]);
  });

  it('ignores booleans (false is a natural default)', () => {
    expect(
      byCode(lint({ [`${WF}/callee.yml`]: callee }), 'WFC105')
        .map((f) => f.message)
        .join(),
    ).not.toContain('"flag"');
  });
});

describe('WFC106 passthrough-dropped', () => {
  it('reports the caller binding of an input the callee never reads', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      ignored: x\n',
      [`${WF}/callee.yml`]: callee.replace(
        'optional: { type: string, required: false }',
        'optional: { type: string, required: false }\n      ignored: { type: string }',
      ),
    });
    const [f] = byCode(r, 'WFC106');
    expect(f?.severity).toBe('info');
    expect(at(f!)).toBe(`${WF}/caller.yml:7:7`);
  });
});

describe('WFC107 optional-forwarded-to-required', () => {
  const caller = (decl: string) => yaml`
    on:
      workflow_call:
        inputs:
          outer: ${decl}
    jobs:
      call:
        uses: ./.github/workflows/callee.yml
        with:
          name: \${{ inputs.outer }}
  `;

  it('flags a required input fed from an optional input without a default', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('{ type: string, required: false }'),
      [`${WF}/callee.yml`]: callee,
    });
    const [f] = byCode(r, 'WFC107');
    expect(f?.message).toBe(
      'Required input "name" of .github/workflows/callee.yml is fed from optional input "outer" without a default',
    );
    expect(at(f!)).toBe(`${WF}/caller.yml:9:17`);
  });

  it.each(['{ type: string, required: true }', '{ type: string, default: x }'])('is quiet for %s', (decl) => {
    expect(
      byCode(lint({ [`${WF}/caller.yml`]: caller(decl), [`${WF}/callee.yml`]: callee }), 'WFC107'),
    ).toEqual([]);
  });

  it('is quiet when a fallback is provided', () => {
    const r = lint({
      [`${WF}/caller.yml`]: caller('{ type: string }').replace(
        '${{ inputs.outer }}',
        "${{ inputs.outer || 'x' }}",
      ),
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'WFC107')).toEqual([]);
  });
});

describe('WFC108 undefined-input-ref', () => {
  it('flags reads of undeclared inputs with a suggestion', () => {
    const r = lint({
      [`${WF}/callee.yml`]: callee.replace('${{ inputs.name }}', '${{ inputs.nam }}'),
    });
    const [f] = byCode(r, 'WFC108');
    expect(f?.message).toBe('.github/workflows/callee.yml has no input "nam" — did you mean "name"?');
    expect(f?.fix).toBe('Use `inputs.name`.');
  });

  it('flags github.event.inputs reads too', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ github.event.inputs.nope }}\n',
    });
    expect(codes(r)).toEqual(['WFC108']);
  });
});
