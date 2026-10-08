import { ConfigError, parseConfig } from '@wfc/core';
import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF, yaml } from './helpers';

const files = {
  [`${WF}/m.yml`]: yaml`
    on: push
    jobs:
      setup:
        runs-on: ubuntu-latest
        outputs:
          matrix: \${{ steps.gen.outputs.matrix }}
        steps:
          - id: gen
            run: echo "matrix=$(./gen-matrix.sh)" >> "$GITHUB_OUTPUT"
      dynamic:
        needs: setup
        runs-on: \${{ matrix.os }}
        strategy:
          matrix: \${{ fromJSON(needs.setup.outputs.matrix) }}
        steps:
          - run: ./test.sh --config "\${{ matrix.config }}" --shard "\${{ matrix.shard }}"
      extra:
        needs: setup
        runs-on: ubuntu-latest
        strategy:
          matrix:
            os: [linux]
            include: \${{ fromJSON(needs.setup.outputs.matrix) }}
        steps:
          - run: echo \${{ matrix.os }} \${{ matrix.flavor }}
  `,
};

const MATRIX = ['WFC401', 'WFC402', 'WFC403', 'WFC404'];
const shapes = (s: Record<string, string[]>) => ({
  matrixShapes: Object.fromEntries(Object.entries(s).map(([k, keys]) => [k, { keys }])),
});

describe('matrixShapes', () => {
  it('without a shape, reads of a runtime-computed matrix are unverified (WFC403)', () => {
    const r = lint(files, { only: MATRIX });
    expect(byCode(r, 'WFC403').map((f) => f.message)).toEqual([
      'jobs.dynamic has a runtime-computed matrix; reads of matrix.os, matrix.config, matrix.shard cannot be verified',
      'jobs.extra has a runtime-computed matrix; reads of matrix.os, matrix.flavor cannot be verified',
    ]);
    expect(codes(r).filter((c) => c !== 'WFC403')).toEqual([]);
  });

  it('with declared keys: no WFC403 and no false positives for declared keys', () => {
    const r = lint(files, {
      only: MATRIX,
      config: shapes({
        [`${WF}/m.yml#dynamic`]: ['os', 'config', 'shard'],
        [`${WF}/m.yml#extra`]: ['os', 'flavor'],
      }),
    });
    expect(codes(r)).toEqual([]);
    expect(r.summary.matrixCombinations).toBe(2);
  });

  it('reports reads of undeclared keys as WFC404', () => {
    const r = lint(files, { only: MATRIX, config: shapes({ [`${WF}/m.yml#dynamic`]: ['os', 'config'] }) });
    expect(byCode(r, 'WFC403').map((f) => f.symbol)).toEqual([`${WF}/m.yml#jobs.extra`]);
    const f = byCode(r, 'WFC404');
    expect(f.map((x) => [x.message, x.symbol])).toEqual([
      [
        'matrix.shard is not defined in any combination of jobs.dynamic (keys: os, config)',
        `${WF}/m.yml#jobs.dynamic.matrix.shard`,
      ],
    ]);
    expect(f[0]!.related.map((x) => x.message)).toEqual(['matrix defined here']);
    expect(codes(r).filter((c) => c === 'WFC401' || c === 'WFC402')).toEqual([]);
  });

  it('matches keys case-insensitively, like GitHub', () => {
    const r = lint(files, {
      only: MATRIX,
      config: shapes({
        [`${WF}/m.yml#dynamic`]: ['OS', 'Config', 'SHARD'],
        [`${WF}/m.yml#extra`]: ['os', 'flavor'],
      }),
    });
    expect(codes(r)).toEqual([]);
  });

  it('does not change static matrices', () => {
    const r = lint(
      {
        [`${WF}/s.yml`]: yaml`
          on: push
          jobs:
            t:
              runs-on: x
              strategy:
                matrix:
                  os: [a, b]
              steps:
                - run: echo \${{ matrix.os }} \${{ matrix.nope }}
        `,
      },
      { only: MATRIX, config: shapes({ [`${WF}/s.yml#t`]: ['os', 'nope'] }) },
    );
    expect(byCode(r, 'WFC404').map((f) => f.symbol)).toEqual([`${WF}/s.yml#jobs.t.matrix.nope`]);
    expect(r.summary.matrixCombinations).toBe(2);
  });

  it('validates the config shape', () => {
    expect(() => parseConfig(shapes({ [`${WF}/m.yml`]: ['os'] }))).toThrow(ConfigError);
    expect(() => parseConfig(shapes({ [`${WF}/m.yml#dynamic`]: [] }))).toThrow(ConfigError);
    try {
      parseConfig(shapes({ 'm.yml#a#b': ['os'] }));
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).issues[0]).toContain('use `<workflow path>#<job id>`');
    }
  });
});

describe('matrixShapes — merging and unused entries', () => {
  it('keeps static keys when an include is runtime-computed', () => {
    const r = lint(files, { config: shapes({ [`${WF}/m.yml#extra`]: ['flavor'] }) });
    const extra = byCode(r, 'WFC404').filter((f) => f.symbol?.includes('#jobs.extra.'));
    expect(extra).toEqual([]);
  });

  it('reports shapes that match no runtime-computed matrix (WFC405)', () => {
    const r = lint(files, {
      config: shapes({
        [`${WF}/m.yml#dynamic`]: ['os', 'config', 'shard'],
        [`${WF}/m.yml#setup`]: ['x'],
        [`${WF}/m.yml#nope`]: ['x'],
        [`${WF}/gone.yml#dynamic`]: ['x'],
      }),
    });
    expect(byCode(r, 'WFC405').map((f) => f.message)).toEqual([
      'matrixShapes entry ".github/workflows/m.yml#setup" is not used: jobs.setup has no runtime-computed matrix',
      'matrixShapes entry ".github/workflows/m.yml#nope" is not used: .github/workflows/m.yml has no job "nope"',
      'matrixShapes entry ".github/workflows/gone.yml#dynamic" is not used: no workflow ".github/workflows/gone.yml"',
    ]);
  });
});
