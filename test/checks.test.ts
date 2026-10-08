/** The check-name engine against the names GitHub actually reported in the lab (fixtures/checknames-lab). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  type CheckName,
  formatNumber,
  type JobDecl,
  skippedCheckName,
  suffixValues,
  workflowChecks,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { lint, WF } from './helpers';

const LAB = fileURLToPath(new URL('../../../fixtures/checknames-lab/', import.meta.url));
const expected = JSON.parse(readFileSync(`${LAB}expected.json`, 'utf8')) as {
  checks: { name: string; conclusion: string }[];
};

/** Jobs the lab run skipped for runtime reasons flowpact cannot see (the job it needs failed). */
const SKIPPED_AT_RUNTIME = new Set(['.github/workflows/names.yml#after-boom']);
const definitelySkipped = (job: JobDecl) => job.ifValue === false || job.ifSite?.text.trim() === 'false';

/** What the lab produces: the names of every job that runs, the raw name of every skipped one. */
function labChecks(): CheckName[] {
  const r = analyze({
    root: LAB,
    validateSchema: false,
    only: [],
    repository: 'rumankazi/flowpact-checknames-lab',
  });
  const out: CheckName[] = [];
  for (const wf of r.project.workflows.values()) {
    if (!wf.triggers.some((t) => t !== 'workflow_call')) continue;
    for (const job of Object.values(wf.jobs)) {
      const id = `${wf.path}#${job.id}`;
      if (definitelySkipped(job) || SKIPPED_AT_RUNTIME.has(id)) {
        out.push({ name: skippedCheckName(job), stem: skippedCheckName(job), certain: true, jobs: [id] });
        continue;
      }
      const single = { ...wf, jobs: { [job.id]: job } };
      out.push(...workflowChecks(r.index, single));
    }
  }
  return out;
}

const pattern = (template: string) =>
  new RegExp(`^${template.replace(/[.*+?^()|[\]\\]/g, '\\$&').replace(/\$\{\{.*?\}\}/g, '.+')}$`);

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

  it('flattens objects and arrays and skips null and empty strings', () => {
    expect(suffixValues({ os: 'linux', v: 1 })).toEqual(['linux', '1']);
    expect(suffixValues([1, [2, null], ''])).toEqual(['1', '2']);
    expect(suffixValues(true)).toEqual(['true']);
  });
});

describe('composition', () => {
  it('composes caller and callee names with the caller inputs', () => {
    const r = lint({
      [`${WF}/c.yml`]:
        'on: push\njobs:\n  ci:\n    strategy:\n      matrix:\n        v: [1, 2]\n    uses: ./.github/workflows/r.yml\n    with:\n      v: ${{ matrix.v }}\n',
      [`${WF}/r.yml`]:
        'on:\n  workflow_call:\n    inputs:\n      v: { type: number }\njobs:\n  t:\n    name: Test v${{ inputs.v }}\n    runs-on: x\n    steps: [{ run: x }]\n',
    });
    const names = workflowChecks(r.index, r.project.workflows.get(`${WF}/c.yml`)!).map((c) => c.name);
    expect(names).toEqual(['ci (1) / Test v1', 'ci (2) / Test v2']);
  });

  it('is uncertain for dynamic matrices and names that read needs', () => {
    const r = lint({
      [`${WF}/c.yml`]:
        "on: push\njobs:\n  a:\n    runs-on: x\n    strategy:\n      matrix: ${{ fromJSON('[]') }}\n    steps: [{ run: x }]\n  b:\n    name: B ${{ needs.a.outputs.x }}\n    needs: a\n    runs-on: x\n    steps: [{ run: x }]\n",
    });
    const checks = workflowChecks(r.index, r.project.workflows.get(`${WF}/c.yml`)!);
    expect(checks.map((c) => [c.name, c.certain])).toEqual([
      ['a (…)', false],
      ['B ${{ needs.a.outputs.x }}', false],
    ]);
  });
});

describe('stems', () => {
  const stems = (name: string) => {
    const r = lint({
      [`${WF}/r.yml`]: `on: workflow_call\njobs:\n  t:\n    name: ${JSON.stringify(name)}\n    runs-on: x\n    steps: [{ run: x }]\n`,
    });
    return workflowChecks(r.index, r.project.workflows.get(`${WF}/r.yml`)!, 'consumer').map((c) => c.stem);
  };

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
    const r = lint({
      [`${WF}/c.yml`]:
        "on: push\npermissions:\n  contents: read\njobs:\n  a:\n    name: Build ${{ matrix.os }}\n    if: false\n    permissions: write-all\n    runs-on: x\n    steps: [{ run: x }]\n  b:\n    name: ''\n    permissions: { contents: write, id-token: write, bogus: maybe }\n    runs-on: x\n    steps: [{ run: x }]\n",
    });
    const wf = r.project.workflows.get(`${WF}/c.yml`)!;
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.a!.permissions).toBe('write-all');
    expect(wf.jobs.a!.ifValue).toBe(false);
    expect(wf.jobs.a!.nameSite?.field).toBe('job.name');
    expect(wf.jobs.b!.name).toBe('');
    expect(wf.jobs.b!.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
  });
});
