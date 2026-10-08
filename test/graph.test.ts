import { resolveSymbols, sym, trace } from '@wfc/core';
import { describe, expect, it } from 'vitest';
import { lint, WF, yaml } from './helpers';

const files = {
  [`${WF}/root.yml`]: yaml`
    on:
      workflow_dispatch:
        inputs:
          config: { type: string, required: true }
    jobs:
      mid:
        uses: ./.github/workflows/mid.yml
        with:
          cfg: \${{ inputs.config }}
        secrets: inherit
      after:
        needs: mid
        runs-on: x
        steps:
          - run: echo \${{ needs.mid.outputs.result }}
  `,
  [`${WF}/mid.yml`]: yaml`
    on:
      workflow_call:
        inputs:
          cfg: { type: string, required: true }
        outputs:
          result:
            value: \${{ jobs.leaf.outputs.r }}
    jobs:
      leaf:
        uses: ./.github/workflows/leaf.yml
        with:
          path: config/\${{ inputs.cfg }}
        secrets: inherit
  `,
  [`${WF}/leaf.yml`]: yaml`
    on:
      workflow_call:
        inputs:
          path: { type: string, required: true }
        outputs:
          r:
            value: \${{ jobs.j.outputs.r }}
    jobs:
      j:
        runs-on: x
        outputs:
          r: \${{ steps.s.outputs.r }}
        steps:
          - id: s
            if: inputs.path != ''
            run: echo "r=\${{ inputs.path }}" >> $GITHUB_OUTPUT && echo \${{ secrets.TOKEN }}
  `,
};

describe('ProjectIndex', () => {
  const { index } = lint(files);

  it('indexes call sites and data-flow edges', () => {
    expect(index.callSites.map((c) => `${c.caller.path}→${c.callee.path}`).sort()).toEqual([
      `${WF}/mid.yml→${WF}/leaf.yml`,
      `${WF}/root.yml→${WF}/mid.yml`,
    ]);
    const flows = index.edges.filter((e) => e.kind === 'flows').map((e) => `${e.from} → ${e.to}`);
    expect(flows).toContain(
      `${sym.input(`${WF}/root.yml`, 'config')} → ${sym.input(`${WF}/mid.yml`, 'cfg')}`,
    );
    expect(flows).toContain(
      `${sym.output(`${WF}/mid.yml`, 'result')} → ${sym.jobOutput(`${WF}/root.yml`, 'mid', 'result')}`,
    );
    expect(index.edges.filter((e) => e.kind === 'inherits')).toHaveLength(2);
  });

  it('records usages with their sink', () => {
    const [u] = index.usagesOf(sym.input(`${WF}/mid.yml`, 'cfg'));
    expect(u?.sink).toBe(sym.input(`${WF}/leaf.yml`, 'path'));
  });

  it('serializes deterministically', () => {
    const a = JSON.stringify(index.toJSON());
    const b = JSON.stringify(lint(files).index.toJSON());
    expect(a).toBe(b);
    expect(index.toJSON()).toMatchSnapshot();
  });
});

describe('trace', () => {
  const { index } = lint(files);

  it('follows a value down through every level', () => {
    const t = trace(index, sym.input(`${WF}/root.yml`, 'config'));
    const mid = t.children[0]!;
    expect(mid.symbol).toBe(sym.input(`${WF}/mid.yml`, 'cfg'));
    const leaf = mid.children[0]!;
    expect(leaf.symbol).toBe(sym.input(`${WF}/leaf.yml`, 'path'));
    expect(leaf.via?.text).toBe('config/${{ inputs.cfg }}');
    expect(leaf.leaves.map((l) => l.role).sort()).toEqual(['condition', 'run script']);
  });

  it('follows outputs back up to the consuming job', () => {
    const t = trace(index, sym.jobOutput(`${WF}/leaf.yml`, 'j', 'r'));
    const flat = JSON.stringify(t);
    expect(flat).toContain(sym.output(`${WF}/mid.yml`, 'result'));
    expect(flat).toContain(sym.jobOutput(`${WF}/root.yml`, 'mid', 'result'));
  });

  it('follows secrets through inherit', () => {
    const { index: i2 } = lint({
      ...files,
      [`${WF}/root.yml`]: files[`${WF}/root.yml`]!.replace(
        'workflow_dispatch:',
        'workflow_call:\n    secrets:\n      TOKEN: {}\n  workflow_dispatch:',
      ),
    });
    const t = trace(i2, sym.secret(`${WF}/root.yml`, 'TOKEN'));
    const mid = t.children[0]!;
    expect(mid.via?.text).toBe('secrets: inherit');
    expect(mid.children[0]?.symbol).toBe(sym.secret(`${WF}/leaf.yml`, 'TOKEN'));
    expect(mid.children[0]?.leaves[0]?.role).toBe('run script');
  });

  it('traces upstream with literal values and omissions', () => {
    const { index: i2 } = lint({
      ...files,
      [`${WF}/other.yml`]:
        'on: push\njobs:\n  a:\n    uses: ./.github/workflows/leaf.yml\n    with:\n      path: literal\n  b:\n    uses: ./.github/workflows/leaf.yml\n',
    });
    const t = trace(i2, sym.input(`${WF}/leaf.yml`, 'path'), { direction: 'up' });
    expect(t.children[0]?.symbol).toBe(sym.input(`${WF}/mid.yml`, 'cfg'));
    expect(t.leaves.map((l) => `${l.role}:${l.text}`)).toEqual(['literal:"literal"', 'omitted:(not passed)']);
  });

  it('stops at cycles and depth limits', () => {
    const t = trace(index, sym.input(`${WF}/root.yml`, 'config'), { maxDepth: 1 });
    expect(t.children[0]?.stop).toBe('depth');
  });
});

describe('resolveSymbols', () => {
  const { index } = lint(files);
  it.each([
    [`${WF}/mid.yml#inputs.cfg`, [`${WF}/mid.yml#inputs.cfg`]],
    ['mid.yml#inputs.cfg', [`${WF}/mid.yml#inputs.cfg`]],
    ['mid.yml:cfg', [`${WF}/mid.yml#inputs.cfg`]],
    ['mid:result', [`${WF}/mid.yml#outputs.result`]],
    ['mid.yml', [`${WF}/mid.yml#inputs.cfg`, `${WF}/mid.yml#outputs.result`]],
    ['nope.yml', []],
  ])('%s', (q, expected) => {
    expect(resolveSymbols(index, q).map((m) => m.id)).toEqual(expected);
  });
});
