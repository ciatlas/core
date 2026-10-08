import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF } from '../helpers';

const call = (target: string) =>
  `on: workflow_call\njobs:\n  next:\n    uses: ./.github/workflows/${target}\n`;

describe('FP601 call-cycle', () => {
  it('reports each cycle once', () => {
    const r = lint({
      [`${WF}/a.yml`]: call('b.yml').replace('workflow_call', 'push'),
      [`${WF}/b.yml`]: call('c.yml'),
      [`${WF}/c.yml`]: call('b.yml'),
    });
    expect(byCode(r, 'FP601').map((f) => f.message)).toEqual([
      'Call cycle: .github/workflows/b.yml → .github/workflows/c.yml → .github/workflows/b.yml',
    ]);
  });
});

describe('FP602 nesting-depth', () => {
  const chain = (n: number) => {
    const files: Record<string, string> = {
      [`${WF}/w1.yml`]: call('w2.yml').replace('workflow_call', 'push'),
    };
    for (let i = 2; i < n; i++) files[`${WF}/w${i}.yml`] = call(`w${i + 1}.yml`);
    files[`${WF}/w${n}.yml`] = 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n';
    return files;
  };
  it('respects limits.nestingDepth', () => {
    expect(byCode(lint(chain(4), { config: { limits: { nestingDepth: 4 } } }), 'FP602')).toEqual([]);
    const [f] = byCode(lint(chain(5), { config: { limits: { nestingDepth: 4 } } }), 'FP602');
    expect(f?.message).toMatch(/^Call chain is 5 workflows deep \(limit 4\)/);
    expect(f?.related).toHaveLength(4);
  });
  it('defaults to 10', () => {
    expect(byCode(lint(chain(10)), 'FP602')).toEqual([]);
    expect(byCode(lint(chain(11)), 'FP602')).toHaveLength(1);
  });
});

describe('FP603 / FP606 / FP608', () => {
  const r = lint({
    [`${WF}/w.yml`]: [
      'on: push',
      'jobs:',
      '  remote:',
      '    uses: other/repo/.github/workflows/x.yml@v1',
      '  same-repo:',
      '    uses: acme/repo/.github/workflows/lib.yml@main',
      '  gone:',
      '    uses: ./.github/workflows/gone.yml',
      '  j:',
      '    needs: [remote, ghost]',
      '    runs-on: x',
      '    steps:',
      '      - uses: ./.github/actions/missing',
      '',
    ].join('\n'),
    [`${WF}/lib.yml`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
  });
  it('reports remote calls as unverified, but resolves same-repo references', () => {
    expect(byCode(r, 'FP603').map((f) => f.symbol)).toEqual(['remote:other/repo/.github/workflows/x.yml@v1']);
    expect(r.index.callSites.map((c) => c.callee.path)).toEqual([`${WF}/lib.yml`]);
  });
  it('reports missing local workflows and actions', () => {
    expect(byCode(r, 'FP606').map((f) => f.message)).toEqual([
      'Workflow ".github/workflows/gone.yml" does not exist',
      'Action ".github/actions/missing" does not exist',
    ]);
  });
  it('reports needs on unknown jobs', () => {
    expect(byCode(r, 'FP608')[0]?.message).toBe(
      'jobs.j needs "ghost", which is not a job in .github/workflows/w.yml (jobs: remote, same-repo, gone, j)',
    );
  });
});

describe('FP604 needs-without-data (opt-in)', () => {
  const files = {
    [`${WF}/w.yml`]:
      'on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: x }]\n  b:\n    needs: a\n    runs-on: x\n    steps: [{ run: x }]\n',
  };
  it('is off by default', () => expect(codes(lint(files))).not.toContain('FP604'));
  it('reports ordering-only dependencies when enabled', () => {
    expect(
      byCode(lint(files, { config: { rules: { 'needs-without-data': 'info' } } }), 'FP604'),
    ).toHaveLength(1);
  });
});

describe('FP605 large-interface / FP607 unreferenced-reusable-workflow', () => {
  const inputs = Array.from({ length: 4 }, (_, i) => `      i${i}: { type: string, default: x }`).join('\n');
  const reads = Array.from({ length: 4 }, (_, i) => `\${{ inputs.i${i} }}`).join(' ');
  const r = lint(
    {
      [`${WF}/big.yml`]: `on:\n  workflow_call:\n    inputs:\n${inputs}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${reads}\n`,
    },
    { config: { limits: { maxInputs: 3 } } },
  );
  it('flags interfaces above limits.maxInputs', () => {
    expect(byCode(r, 'FP605')[0]?.message).toBe(
      '.github/workflows/big.yml declares 4 workflow_call inputs (limit 3)',
    );
  });
  it('flags call-only workflows without callers', () => {
    expect(byCode(r, 'FP607')).toHaveLength(1);
  });
});
