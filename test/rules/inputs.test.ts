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

describe('FP101 missing-required-input', () => {
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
    const [f] = byCode(r, 'FP101');
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
    expect(byCode(r, 'FP101')).toEqual([]);
  });

  it('flags required action inputs (which GitHub does not enforce)', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n',
      '.github/actions/a/action.yml':
        'inputs:\n  must: { required: true }\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.must }}\n      shell: bash\n',
    });
    expect(byCode(r, 'FP101')[0]?.message).toMatch(/empty value/);
  });
});

describe('FP102 unknown-input', () => {
  it('flags undeclared inputs and suggests the closest name', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: x\n      nmae: y\n      zzz: 1\n',
      [`${WF}/callee.yml`]: callee,
    });
    const msgs = byCode(r, 'FP102').map((f) => f.message);
    expect(msgs).toEqual([
      '.github/workflows/callee.yml has no input "nmae" — did you mean "name"?',
      '.github/workflows/callee.yml has no input "zzz"',
    ]);
    expect(byCode(r, 'FP102')[0]!.fix).toBe('Rename "nmae" to "name".');
  });

  it('treats - and _ as equivalent when suggesting', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n        with:\n          cache_dir: x\n',
      '.github/actions/a/action.yml':
        'inputs:\n  cache-dir: {}\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.cache-dir }}\n      shell: bash\n',
    });
    expect(byCode(r, 'FP102')[0]?.message).toContain('did you mean "cache-dir"');
  });
});

describe('FP103 input-type-mismatch', () => {
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
    expect(byCode(r, 'FP103').map((f) => f.message)).toEqual([
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
    expect(byCode(r, 'FP103')).toEqual([]);
  });

  it('evaluates constant expressions', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        "on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      flag: ${{ 'yes' }}\n",
      [`${WF}/callee.yml`]: callee,
    });
    expect(byCode(r, 'FP103')).toHaveLength(1);
  });
});

describe('FP104 unused-input', () => {
  it('flags declared inputs that are never read, noting callers that still pass them', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      dead: 1\n',
      [`${WF}/callee.yml`]: callee.replace(
        'optional: { type: string, required: false }',
        'optional: { type: string, required: false }\n      dead: { type: string }',
      ),
    });
    const [f] = byCode(r, 'FP104');
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
    expect(byCode(r, 'FP104')).toEqual([]);
  });

  it('flags unused action inputs', () => {
    const r = lint({
      '.github/actions/a/action.yml':
        'inputs:\n  unused: {}\nruns:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n',
    });
    expect(byCode(r, 'FP104')[0]?.symbol).toBe('.github/actions/a#inputs.unused');
  });
});

describe('FP105 optional-input-no-default-in-condition', () => {
  const w = (callerWith: string, condition = 'inputs.optional', opts?: Parameters<typeof lint>[1]) =>
    lint(
      {
        [`${WF}/caller.yml`]: `on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n${callerWith}`,
        [`${WF}/callee.yml`]: callee.replace('if: inputs.flag && inputs.count > 0', `if: ${condition}`),
      },
      opts,
    );
  /** Nothing is published, so the local callers are all the callers there are. */
  const internal = { config: { impact: { publish: [] } } };

  it('flags the condition when some caller omits the input', () => {
    const [f] = byCode(w(''), 'FP105');
    expect(f?.message).toBe(
      `Condition reads optional input "optional", which has no default and is '' when omitted`,
    );
    expect(f?.related.map((r) => r.message)).toContain('.github/workflows/caller.yml › jobs.call omits it');
  });

  it('is quiet when every caller of an internal workflow passes the input', () => {
    expect(byCode(w('      optional: gpu\n', 'inputs.optional', internal), 'FP105')).toEqual([]);
    // `_`-prefixed reusable workflows are internal by default.
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/_callee.yml\n    with:\n      optional: gpu\n',
      [`${WF}/_callee.yml`]: callee.replace('if: inputs.flag && inputs.count > 0', 'if: inputs.optional'),
    });
    expect(byCode(r, 'FP105')).toEqual([]);
  });

  it('still flags a published workflow that every local caller passes the input to', () => {
    const [f] = byCode(w('      optional: gpu\n'), 'FP105');
    expect(f?.related.map((r) => r.message)).toEqual([
      'declared optional without a default; every caller here passes it, but this unit is published (see `impact.publish`), so callers in other repositories can omit it',
    ]);
  });

  it('flags the root action.yml even when its self-test passes the input (it is published)', () => {
    const files = (publish?: string[]) =>
      lint(
        {
          'action.yml': yaml`
            name: published
            inputs:
              token: { required: false }
            runs:
              using: composite
              steps:
                - if: inputs.token
                  run: echo has token
                  shell: bash
          `,
          [`${WF}/selftest.yml`]: yaml`
            on: push
            jobs:
              t:
                runs-on: x
                steps:
                  - uses: ./
                    with:
                      token: \${{ secrets.X }}
          `,
        },
        publish ? { config: { impact: { publish } } } : {},
      );
    expect(byCode(files(), 'FP105').map((f) => at(f))).toEqual(['action.yml:7:11']);
    expect(byCode(files([]), 'FP105')).toEqual([]);
  });

  it.each([
    "inputs.optional == 'yes'",
    "inputs.optional != 'true'",
    "'gpu' == inputs.optional",
    "inputs.optional != ''",
    'inputs.optional == null',
    "contains(inputs.optional, 'tootsuite')",
    `contains(fromJSON('["core","v1"]'), inputs.optional)`,
    "startsWith(inputs.optional, 'v')",
    "github.repository_owner == 'pytorch' && (inputs.optional == 'H100' || inputs.optional == 'A100')",
    // langchain _release.yml: a fallback inside a test
    "startsWith(inputs.optional || inputs.name, 'libs/core')",
    "format('{0}-x', inputs.optional) == '-x'",
    // terraform-provider-aws team_working_board: the explicit check guards the other read
    "inputs.optional != '' && inputs.optional != steps.get_status.outputs.current",
  ])('is quiet when the condition handles the omitted case: %s', (condition) => {
    const r = w('', `\${{ ${condition} }}`);
    expect(codes(r).filter((c) => ['FP105', 'FP502', 'FP504'].includes(c))).toEqual([]);
  });

  it.each([
    'inputs.optional',
    '${{ !inputs.optional }}',
    "inputs.optional && github.event_name == 'push'",
    '${{ inputs.optional && always() }}',
    'inputs.optional == github.ref',
    "fromJSON(inputs.optional).enabled && github.event_name == 'push'",
  ])('flags a condition decided by the value as it is: %s', (condition) => {
    expect(byCode(w('', condition), 'FP105')).toHaveLength(1);
  });

  it('asks the users of a local action too (the identical workflow input was already quiet)', () => {
    const files = (stepWith: string) => ({
      [`${WF}/main.yml`]: `on: push\njobs:\n  s:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/a\n${stepWith}`,
      '.github/actions/a/action.yml': yaml`
        name: a
        inputs:
          mode: { required: false }
        runs:
          using: composite
          steps:
            - if: inputs.mode
              run: echo fast
              shell: bash
      `,
    });
    expect(byCode(lint(files('        with: { mode: fast }\n')), 'FP105')).toEqual([]);
    const [f] = byCode(lint(files('')), 'FP105');
    expect(f?.related.map((r) => r.message)).toEqual([
      'declared optional without a default',
      '.github/workflows/main.yml › jobs.s › step #1 omits it',
    ]);
  });

  describe('when a caller passes one of the inputs a condition reads (#38)', () => {
    const condition = 'if: ${{ inputs.app-id || inputs.client-id }}';
    const declared = '{ type: string, required: false }';

    it('reports both for a published workflow, since other repositories can omit either', () => {
      const r = lint({
        [`${WF}/caller.yml`]: `on: push\njobs:\n  c:\n    uses: ./.github/workflows/token.yml\n    with:\n      client-id: \${{ vars.CLIENT_ID }}\n`,
        [`${WF}/token.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                app-id: ${declared}
                client-id: ${declared}
          jobs:
            j:
              runs-on: x
              steps:
                - ${condition}
                  run: echo token
        `,
      });
      expect(byCode(r, 'FP105').map((f) => f.message)).toEqual([
        `Condition reads optional input "app-id", which has no default and is '' when omitted (so is "client-id", read by the same condition)`,
        `Condition reads optional input "client-id", which has no default and is '' when omitted (so is "app-id", read by the same condition)`,
      ]);
    });

    it('reports the omitted one for a local action, saying every caller passes the other', () => {
      const r = lint({
        [`${WF}/w.yml`]: `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/token\n        with:\n          client-id: \${{ vars.CLIENT_ID }}\n`,
        '.github/actions/token/action.yml': yaml`
          name: token
          inputs:
            app-id: { required: false }
            client-id: { required: false }
          runs:
            using: composite
            steps:
              - ${condition}
                run: echo token
                shell: bash
        `,
      });
      expect(byCode(r, 'FP105').map((f) => `${at(f)} ${f.message}`)).toEqual([
        `.github/actions/token/action.yml:8:15 Condition reads optional input "app-id", which has no default and is '' when omitted ("client-id", also read by this condition, is passed by every caller)`,
      ]);
    });
  });

  it('reports every optional input a condition depends on, each naming the others (#38)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              app-id: { type: string, required: false }
              client-id: { type: string, required: false }
              private-key: { type: string, required: false }
        jobs:
          j:
            runs-on: x
            steps:
              - if: \${{ inputs.app-id || inputs.client-id }}
                run: echo token
              - if: \${{ inputs.private-key }}
                run: echo key
      `,
    });
    expect(byCode(r, 'FP105').map((f) => `${at(f)} ${f.message}`)).toEqual([
      `${WF}/w.yml:11:17 Condition reads optional input "app-id", which has no default and is '' when omitted (so is "client-id", read by the same condition)`,
      `${WF}/w.yml:11:34 Condition reads optional input "client-id", which has no default and is '' when omitted (so is "app-id", read by the same condition)`,
      `${WF}/w.yml:13:17 Condition reads optional input "private-key", which has no default and is '' when omitted`,
    ]);
    expect(byCode(r, 'FP105').map((f) => f.symbol)).toEqual([
      `${WF}/w.yml#inputs.app-id`,
      `${WF}/w.yml#inputs.client-id`,
      `${WF}/w.yml#inputs.private-key`,
    ]);
  });

  it('ignores booleans (false is a natural default)', () => {
    expect(
      byCode(lint({ [`${WF}/callee.yml`]: callee }), 'FP105')
        .map((f) => f.message)
        .join(),
    ).not.toContain('"flag"');
  });
});

describe('FP106 passthrough-dropped', () => {
  it('reports the caller binding of an input the callee never reads', () => {
    const r = lint({
      [`${WF}/caller.yml`]:
        'on: push\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    with:\n      name: n\n      ignored: x\n',
      [`${WF}/callee.yml`]: callee.replace(
        'optional: { type: string, required: false }',
        'optional: { type: string, required: false }\n      ignored: { type: string }',
      ),
    });
    const [f] = byCode(r, 'FP106');
    expect(f?.severity).toBe('info');
    expect(at(f!)).toBe(`${WF}/caller.yml:7:7`);
  });
});

describe('FP107 optional-forwarded-to-required', () => {
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
    const [f] = byCode(r, 'FP107');
    expect(f?.message).toBe(
      'Required input "name" of .github/workflows/callee.yml is fed from optional input "outer" without a default',
    );
    expect(at(f!)).toBe(`${WF}/caller.yml:9:17`);
  });

  it.each(['{ type: string, required: true }', '{ type: string, default: x }'])('is quiet for %s', (decl) => {
    expect(
      byCode(lint({ [`${WF}/caller.yml`]: caller(decl), [`${WF}/callee.yml`]: callee }), 'FP107'),
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
    expect(byCode(r, 'FP107')).toEqual([]);
  });
});

describe('FP108 undefined-input-ref', () => {
  it('flags reads of undeclared inputs with a suggestion', () => {
    const r = lint({
      [`${WF}/callee.yml`]: callee.replace('${{ inputs.name }}', '${{ inputs.nam }}'),
    });
    const [f] = byCode(r, 'FP108');
    expect(f?.message).toBe('.github/workflows/callee.yml has no input "nam" — did you mean "name"?');
    expect(f?.fix).toBe('Use `inputs.name`.');
  });

  it('flags github.event.inputs reads too', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ github.event.inputs.nope }}\n',
    });
    expect(codes(r)).toEqual(['FP108']);
  });
});
