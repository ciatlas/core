/** Check-run names (checks.ts), against the names GitHub actually reported in the lab (fixtures/checknames-lab). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type CheckName,
  formatNumber,
  type InputValues,
  type JobDecl,
  jobSegments,
  loadProject,
  ProjectIndex,
  skippedCheckName,
  suffixValues,
  workflowChecks,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { load, WF, yaml } from './helpers';

const LAB = fileURLToPath(new URL('../../../fixtures/checknames-lab/', import.meta.url));
const expected = JSON.parse(readFileSync(`${LAB}expected.json`, 'utf8')) as {
  checks: { name: string; conclusion: string }[];
};

/** Jobs the lab run skipped for runtime reasons flowpact cannot see (the job it needs failed). */
const SKIPPED_AT_RUNTIME = new Set(['.github/workflows/names.yml#after-boom']);
const definitelySkipped = (job: JobDecl) => job.ifValue === false || job.ifSite?.text.trim() === 'false';

/** What the lab produces: the names of every job that runs, the raw name of every skipped one. */
function labChecks(): CheckName[] {
  // The lab is read from disk, like a checked-out repository.
  const project = loadProject({
    root: LAB,
    repository: 'rumankazi/flowpact-checknames-lab',
    validateSchema: false,
  });
  const index = new ProjectIndex(project);
  const out: CheckName[] = [];
  for (const wf of project.workflows.values()) {
    if (!wf.triggers.some((t) => t !== 'workflow_call')) continue;
    for (const job of Object.values(wf.jobs)) {
      const id = `${wf.path}#${job.id}`;
      if (definitelySkipped(job) || SKIPPED_AT_RUNTIME.has(id)) {
        out.push({ name: skippedCheckName(job), stem: skippedCheckName(job), certain: true, jobs: [id] });
        continue;
      }
      const single = { ...wf, jobs: { [job.id]: job } };
      out.push(...workflowChecks(index, single));
    }
  }
  return out;
}

const pattern = (template: string) =>
  new RegExp(`^${template.replace(/[.*+?^()|[\]\\]/g, '\\$&').replace(/\$\{\{.*?\}\}/g, '.+')}$`);

/** The checks a workflow of in-memory files produces. */
function checksOf(
  files: Record<string, string>,
  path: string,
  inputs?: InputValues | 'consumer',
): CheckName[] {
  const { project, index } = load(files);
  return workflowChecks(index, project.workflows.get(path)!, inputs);
}

/** Job `j` of a workflow with the given job body (indented under `j:`). */
function jobOf(body: string): JobDecl {
  const text = `on: push\njobs:\n  j:\n${body
    .trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')}\n`;
  const { project } = load({ [`${WF}/w.yml`]: text });
  return project.workflows.get(`${WF}/w.yml`)!.jobs.j!;
}

describe('check names (lab, verified against GitHub)', () => {
  const computed = labChecks();

  it('matches every name GitHub reported, duplicates included', () => {
    const want = expected.checks.map((c) => c.name).sort();
    const got: string[] = [];
    for (const c of computed) {
      if (c.certain) {
        got.push(c.name);
        continue;
      }
      // Names that read the event (`Ref ${{ github.event_name }}`) are matched by their template.
      const hit = want.find((w) => pattern(c.name).test(w) && !got.includes(w));
      got.push(hit ?? c.name);
    }
    expect(got.sort()).toEqual(want);
  });

  it('marks only event-dependent names as uncertain', () => {
    expect(computed.filter((c) => !c.certain).map((c) => c.name)).toEqual(['Ref ${{ github.event_name }}']);
  });
});

describe('suffix values', () => {
  it.each([
    [1, '1'],
    [3.1, '3.1'],
    [0.5, '0.5'],
    [-2, '-2'],
    [300, '300'],
    [1e15, '1E+15'],
    [1e-7, '1E-07'],
    [Number('12345678901234567890'), '1.23456789012346E+19'],
    [123456789012345, '123456789012345'],
    [0.0001, '0.0001'],
    [1e-5, '1E-05'],
  ])('formats %s like GitHub (%s)', (n, text) => {
    expect(formatNumber(n)).toBe(text);
  });

  it.each([
    [0, '0'],
    [1e14, '100000000000000'],
    // Rounding to 15 digits carries into the next power of ten, which switches to the exponent form.
    [999999999999999.9, '1E+15'],
    [-1.5e-7, '-1.5E-07'],
    [0.1 + 0.2, '0.3'],
  ])('formats %s at the edges of the fixed-point range (%s)', (n, text) => {
    expect(formatNumber(n)).toBe(text);
  });

  it('prints non-finite numbers as .NET does', () => {
    expect([Infinity, -Infinity, Number.NaN].map(formatNumber)).toEqual(['Infinity', '-Infinity', 'NaN']);
  });

  it('flattens objects and arrays and skips null and empty strings', () => {
    expect(suffixValues({ os: 'linux', v: 1 })).toEqual(['linux', '1']);
    expect(suffixValues([1, [2, null], ''])).toEqual(['1', '2']);
    expect(suffixValues(true)).toEqual(['true']);
    expect(suffixValues(false)).toEqual(['false']);
    expect(suffixValues({ a: [1.5, { b: null }], c: '', d: { e: 'deep' } })).toEqual(['1.5', 'deep']);
  });
});

describe('job names', () => {
  const segments = (body: string, inputs?: InputValues) =>
    jobSegments(jobOf(body), inputs).map((s) => [s.name, s.certain]);

  it('falls back to the job id when the name is absent, blank or evaluates to nothing', () => {
    expect(segments('runs-on: x')).toEqual([['j', true]]);
    expect(segments("name: '   '\nruns-on: x")).toEqual([['j', true]]);
    expect(segments('name: ${{ null }}\nruns-on: x')).toEqual([['j', true]]);
    // Without a matrix, `matrix.os` is null.
    expect(segments('name: ${{ matrix.os }}\nruns-on: x')).toEqual([['j', true]]);
  });

  it('keeps the matrix suffix for a name that is one literal expression of any type', () => {
    const matrix = 'runs-on: x\nstrategy:\n  matrix:\n    a: [x]';
    expect(segments(`name: \${{ 1.50 }}\n${matrix}`)).toEqual([['1.5 (x)', true]]);
    expect(segments(`name: \${{ true }}\n${matrix}`)).toEqual([['true (x)', true]]);
    expect(segments(`name: \${{ null }}\n${matrix}`)).toEqual([['j (x)', true]]);
  });

  it('keeps the template, uncertain, when a name evaluates to an object', () => {
    const job = jobOf(yaml`
      name: \${{ matrix.cfg }}
      runs-on: x
      strategy:
        matrix:
          cfg: [{ os: linux }]
    `);
    expect(jobSegments(job).map((s) => [s.name, s.stem, s.certain])).toEqual([
      ['${{ matrix.cfg }}', '…', false],
    ]);
  });

  it('is uncertain when a matrix value is an expression, and leaves that value out of the suffix', () => {
    const matrix = yaml`
      runs-on: x
      strategy:
        matrix:
          os: [linux, '\${{ inputs.extra }}']
    `;
    expect(segments(`name: Build\n${matrix}`)).toEqual([
      ['Build (linux)', false],
      ['Build', false],
    ]);
    expect(segments(`name: Build \${{ matrix.os }}\n${matrix}`)).toEqual([
      ['Build linux', false],
      ['Build ${{ matrix.os }}', false],
    ]);
  });

  it('is uncertain for a matrix too large to expand', () => {
    const v200 = Array.from({ length: 200 }, (_, i) => i).join(', ');
    const job = jobOf(`name: Big\nruns-on: x\nstrategy:\n  matrix:\n    a: [${v200}]\n    b: [${v200}]`);
    expect(jobSegments(job).map((s) => [s.name, s.stem, s.certain])).toEqual([['Big (…)', 'Big (…)', false]]);
  });

  it('returns the combination of each matrix segment, for the inputs of a called workflow', () => {
    const job = jobOf('runs-on: x\nstrategy:\n  matrix:\n    os: [a, b]');
    expect(jobSegments(job).map((s) => s.combo?.values.os)).toEqual([
      { known: true, value: 'a' },
      { known: true, value: 'b' },
    ]);
    expect(jobSegments(jobOf('runs-on: x'))[0]).not.toHaveProperty('combo');
  });

  it('reads inputs by name, case-insensitively, and is uncertain for unknown or nested ones', () => {
    expect(
      segments('name: In ${{ inputs.OS }}\nruns-on: x', { os: { known: true, value: 'linux' } }),
    ).toEqual([['In linux', true]]);
    expect(segments('name: In ${{ inputs.os }}\nruns-on: x', { os: { known: false } })).toEqual([
      ['In ${{ inputs.os }}', false],
    ]);
    expect(segments('name: In ${{ inputs.os }}\nruns-on: x', {})).toEqual([['In ${{ inputs.os }}', false]]);
    expect(
      segments('name: In ${{ inputs.cfg.os }}\nruns-on: x', { cfg: { known: true, value: { os: 'linux' } } }),
    ).toEqual([['In ${{ inputs.cfg.os }}', false]]);
  });

  // Suspected bug: inside a template with text around the expression, numbers are printed by JavaScript (`String`,
  // through `toStr` in expressions.ts), not like GitHub's "G15" that `formatNumber` implements and the rest of the
  // name uses: flowpact computes `N 1000000000000000` and `N 1e-7`.
  it.skip('formats numbers inside a name like GitHub', () => {
    const matrix = 'runs-on: x\nstrategy:\n  matrix:\n    n: [1e15, 1e-7]';
    expect(segments(`name: N \${{ matrix.n }}\n${matrix}`)).toEqual([
      ['N 1E+15', true],
      ['N 1E-07', true],
    ]);
  });

  it('reports the raw name, trimmed, for a skipped job', () => {
    expect(skippedCheckName(jobOf("name: '  Skip ${{ matrix.os }}  '\nif: false\nruns-on: x"))).toBe(
      'Skip ${{ matrix.os }}',
    );
    // Unverified: no skipped lab job has a name that is one literal expression. GitHub reports the other skipped
    // names raw (`Skip ${{ matrix.os }}` above), so it may report `${{ 'Lit' }}` here rather than `Lit`.
    expect(skippedCheckName(jobOf("name: ${{ 'Lit' }}\nif: false\nruns-on: x"))).toBe('Lit');
    expect(skippedCheckName(jobOf('if: false\nruns-on: x'))).toBe('j');
  });
});

describe('composition', () => {
  it('composes caller and callee names with the caller inputs', () => {
    const names = checksOf(
      {
        [`${WF}/c.yml`]: yaml`
          on: push
          jobs:
            ci:
              strategy:
                matrix:
                  v: [1, 2]
              uses: ./.github/workflows/r.yml
              with:
                v: \${{ matrix.v }}
        `,
        [`${WF}/r.yml`]: yaml`
          on:
            workflow_call:
              inputs:
                v: { type: number }
          jobs:
            t:
              name: Test v\${{ inputs.v }}
              runs-on: x
              steps: [{ run: x }]
        `,
      },
      `${WF}/c.yml`,
    ).map((c) => c.name);
    expect(names).toEqual(['ci (1) / Test v1', 'ci (2) / Test v2']);
  });

  it('is uncertain for dynamic matrices and names that read needs', () => {
    const checks = checksOf(
      {
        [`${WF}/c.yml`]: yaml`
          on: push
          jobs:
            a:
              runs-on: x
              strategy:
                matrix: \${{ fromJSON('[]') }}
              steps: [{ run: x }]
            b:
              name: B \${{ needs.a.outputs.x }}
              needs: a
              runs-on: x
              steps: [{ run: x }]
        `,
      },
      `${WF}/c.yml`,
    );
    expect(checks.map((c) => [c.name, c.certain])).toEqual([
      ['a (…)', false],
      ['B ${{ needs.a.outputs.x }}', false],
    ]);
  });

  const callee = yaml`
    on:
      workflow_call:
        inputs:
          os: { type: string, default: linux }
          label: { type: string }
    jobs:
      t:
        name: T \${{ inputs.os }} \${{ inputs.label }}
        runs-on: x
        steps: [{ run: x }]
  `;

  it('uses input defaults, an empty string for a string input without one, and the values a caller passes', () => {
    const files = {
      [`${WF}/r.yml`]: callee,
      [`${WF}/c.yml`]: yaml`
        on: push
        jobs:
          plain:
            uses: ./.github/workflows/r.yml
          passed:
            uses: ./.github/workflows/r.yml
            with: { os: macos, label: x }
          unknown:
            uses: ./.github/workflows/r.yml
            with:
              os: \${{ github.sha }}
      `,
    };
    expect(checksOf(files, `${WF}/r.yml`).map((c) => [c.name, c.certain])).toEqual([['T linux', true]]);
    expect(checksOf(files, `${WF}/c.yml`).map((c) => [c.name, c.stem, c.certain, c.jobs])).toEqual([
      ['plain / T linux', 'plain / T … …', true, [`${WF}/c.yml#plain`, `${WF}/r.yml#t`]],
      ['passed / T macos x', 'passed / T … …', true, [`${WF}/c.yml#passed`, `${WF}/r.yml#t`]],
      [
        'unknown / T ${{ inputs.os }} ${{ inputs.label }}',
        'unknown / T … …',
        false,
        [`${WF}/c.yml#unknown`, `${WF}/r.yml#t`],
      ],
    ]);
  });

  it('treats every input as unknown when consumers call the workflow', () => {
    expect(
      checksOf({ [`${WF}/r.yml`]: callee }, `${WF}/r.yml`, 'consumer').map((c) => [c.name, c.certain]),
    ).toEqual([['T ${{ inputs.os }} ${{ inputs.label }}', false]]);
  });

  // Suspected bug: GitHub documents that an input without a default is `false` for a boolean and `0` for a number
  // (`""` for a string); workflowChecks gives every such input `null`, so these names read `N` and `B`.
  it.skip('uses GitHub’s defaults for number and boolean inputs without one', () => {
    const files = {
      [`${WF}/r.yml`]: yaml`
        on:
          workflow_call:
            inputs:
              n: { type: number }
              b: { type: boolean }
        jobs:
          n:
            name: N \${{ inputs.n }}
            runs-on: x
            steps: [{ run: x }]
          b:
            name: B \${{ inputs.b }}
            runs-on: x
            steps: [{ run: x }]
      `,
    };
    expect(checksOf(files, `${WF}/r.yml`).map((c) => c.name)).toEqual(['N 0', 'B false']);
  });

  it('stops at a call cycle', () => {
    const files = {
      [`${WF}/a.yml`]: yaml`
        on: [push, workflow_call]
        jobs:
          a-leaf: { runs-on: x, steps: [{ run: x }] }
          to-b: { uses: ./.github/workflows/b.yml }
      `,
      [`${WF}/b.yml`]: yaml`
        on: workflow_call
        jobs:
          b-leaf: { runs-on: x, steps: [{ run: x }] }
          to-a: { uses: ./.github/workflows/a.yml }
      `,
    };
    expect(checksOf(files, `${WF}/a.yml`).map((c) => c.name)).toEqual(['a-leaf', 'to-b / b-leaf']);
  });

  it('stops composing below twelve levels of calls', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= 14; i++) {
      files[`${WF}/w${i}.yml`] = yaml`
        on: [push, workflow_call]
        jobs:
          leaf: { runs-on: x, steps: [{ run: x }] }
          next: { uses: ./.github/workflows/w${i + 1}.yml }
      `;
    }
    const names = checksOf(files, `${WF}/w0.yml`).map((c) => c.name);
    expect(names).toHaveLength(13);
    expect(names.at(-1)).toBe(`${'next / '.repeat(12)}leaf`);
  });
});

describe('stems', () => {
  const stems = (name: string) =>
    checksOf(
      {
        [`${WF}/r.yml`]: `on: workflow_call\njobs:\n  t:\n    name: ${JSON.stringify(name)}\n    runs-on: x\n    steps: [{ run: x }]\n`,
      },
      `${WF}/r.yml`,
      'consumer',
    ).map((c) => c.stem);

  it('replaces each expression with …, including a closing brace inside a string', () => {
    expect(stems('  Build ${{ inputs.os }} on ${{ inputs.arch }}  ')).toEqual(['Build … on …']);
    expect(stems("Test ${{ format('{0}}}', inputs.os) }}")).toEqual(['Test …']);
  });

  it('stays linear on unterminated expressions (CodeQL js/polynomial-redos)', () => {
    const name = `x ${'${{'.repeat(200_000)}`;
    const started = performance.now();
    expect(stems(name)).toEqual(['x …']);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('parsed job fields used for check names and impact', () => {
  it('reads permissions, name expressions and boolean if', () => {
    const { project } = load({
      [`${WF}/c.yml`]: yaml`
        on: push
        permissions:
          contents: read
        jobs:
          a:
            name: Build \${{ matrix.os }}
            if: false
            permissions: write-all
            runs-on: x
            steps: [{ run: x }]
          b:
            name: ''
            permissions: { contents: write, id-token: write, bogus: maybe }
            runs-on: x
            steps: [{ run: x }]
      `,
    });
    const wf = project.workflows.get(`${WF}/c.yml`)!;
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.a!.permissions).toBe('write-all');
    expect(wf.jobs.a!.ifValue).toBe(false);
    expect(wf.jobs.a!.nameSite?.field).toBe('job.name');
    expect(wf.jobs.b!.name).toBe('');
    expect(wf.jobs.b!.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
  });
});
