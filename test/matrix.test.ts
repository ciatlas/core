import {
  type Combination,
  comboLabel,
  createParseContext,
  evaluateTemplate,
  expandMatrix,
  type Json,
  jsonEqual,
  type Loc,
  MAX_COMBINATIONS,
  type MatrixDecl,
  matrixResolver,
  parseWorkflowFile,
} from '@wfc/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { yaml } from './helpers';

function matrixOf(strategy: string): MatrixDecl {
  const text = `on: push\njobs:\n  j:\n    runs-on: x\n    strategy:\n${strategy
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n')}\n    steps: []\n`;
  const wf = parseWorkflowFile('w.yml', text, createParseContext());
  return wf.jobs.j!.matrix!;
}

const plain = (combos: Combination[]) =>
  combos.map((c) =>
    Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, v.known ? v.value : '<unknown>'])),
  );

describe('expandMatrix — GitHub documentation examples', () => {
  it('expands include entries exactly as documented', () => {
    const m = matrixOf(yaml`
      matrix:
        fruit: [apple, pear]
        animal: [cat, dog]
        include:
          - color: green
          - color: pink
            animal: cat
          - fruit: apple
            shape: circle
          - fruit: banana
          - fruit: banana
            animal: cat
    `);
    expect(plain(expandMatrix(m).combos)).toEqual([
      { fruit: 'apple', animal: 'cat', color: 'pink', shape: 'circle' },
      { fruit: 'apple', animal: 'dog', color: 'green', shape: 'circle' },
      { fruit: 'pear', animal: 'cat', color: 'pink' },
      { fruit: 'pear', animal: 'dog', color: 'green' },
      { fruit: 'banana' },
      { fruit: 'banana', animal: 'cat' },
    ]);
  });

  it('applies partial exclude matches', () => {
    const m = matrixOf(yaml`
      matrix:
        os: [macos-latest, windows-latest]
        version: [12, 14, 16]
        environment: [staging, production]
        exclude:
          - os: macos-latest
            version: 12
            environment: production
          - os: windows-latest
            version: 16
    `);
    const combos = plain(expandMatrix(m).combos);
    expect(combos).toHaveLength(9);
    expect(combos).not.toContainEqual({ os: 'macos-latest', version: 12, environment: 'production' });
    expect(combos.filter((c) => c.os === 'windows-latest' && c.version === 16)).toEqual([]);
  });

  it('turns an include-only matrix into one combination per entry', () => {
    const exp = expandMatrix(
      matrixOf(yaml`
        matrix:
          include:
            - name: linux
              config: a
            - name: windows
      `),
    );
    expect(plain(exp.combos)).toEqual([{ name: 'linux', config: 'a' }, { name: 'windows' }]);
    expect(exp.keys).toEqual(['name', 'config']);
    expect(exp.combos.map((c) => c.origin)).toEqual(['include', 'include']);
  });

  it('never overwrites original values but may overwrite added ones', () => {
    const exp = expandMatrix(
      matrixOf(yaml`
        matrix:
          os: [linux]
          include:
            - os: linux
              extra: one
            - extra: two
            - os: mac
              extra: three
      `),
    );
    expect(plain(exp.combos)).toEqual([
      { os: 'linux', extra: 'two' },
      { os: 'mac', extra: 'three' },
    ]);
  });

  it('compares object values deeply', () => {
    const exp = expandMatrix(
      matrixOf(yaml`
        matrix:
          cfg: [{a: 1}, {a: 2}]
          exclude:
            - cfg: {a: 2}
      `),
    );
    expect(plain(exp.combos)).toEqual([{ cfg: { a: 1 } }]);
  });
});

describe('expandMatrix — dynamic parts', () => {
  it('reports a fully dynamic matrix', () => {
    const exp = expandMatrix(matrixOf('matrix: ${{ fromJSON(needs.a.outputs.m) }}'));
    expect(exp).toMatchObject({ dynamic: true, exact: false, combos: [] });
  });

  it('keeps keys for expression values but marks them unknown', () => {
    const exp = expandMatrix(
      matrixOf(yaml`
        matrix:
          os: [linux, '\${{ inputs.extra-os }}']
          node: \${{ fromJSON(inputs.nodes) }}
      `),
    );
    expect(exp.exact).toBe(false);
    expect(exp.combos).toHaveLength(2);
    expect(plain(exp.combos)).toEqual([
      { os: 'linux', node: '<unknown>' },
      { os: '<unknown>', node: '<unknown>' },
    ]);
  });

  it('marks dynamic include/exclude as inexact', () => {
    const exp = expandMatrix(
      matrixOf(yaml`
      matrix:
        os: [linux]
        include: \${{ fromJSON(inputs.extra) }}
    `),
    );
    expect(exp.exact).toBe(false);
    expect(plain(exp.combos)).toEqual([{ os: 'linux' }]);
  });

  it('expands large products exactly and refuses products it cannot expand', () => {
    const v40 = Array.from({ length: 40 }, (_, i) => i).join(', ');
    const exact = expandMatrix(matrixOf(`matrix:\n  a: [${v40}]\n  b: [${v40}]\n  exclude:\n    - a: 0`));
    expect(exact).toMatchObject({ truncated: false, productSize: 1600 });
    expect(exact.combos).toHaveLength(1560);
    const v200 = Array.from({ length: 200 }, (_, i) => i).join(', ');
    const huge = expandMatrix(
      matrixOf(`matrix:\n  a: [${v200}]\n  b: [${v200}]\n  include:\n    - extra: 1`),
    );
    expect(huge).toMatchObject({
      truncated: true,
      productSize: 40000,
      combos: [],
      keys: ['a', 'b', 'extra'],
    });
    expect(MAX_COMBINATIONS).toBeLessThan(40000);
  });

  it('handles an absent matrix', () => {
    expect(expandMatrix(undefined)).toMatchObject({ combos: [], exact: true, dynamic: false });
  });
});

describe('matrixResolver', () => {
  const [combo] = expandMatrix(
    matrixOf(yaml`
      matrix:
        include:
          - name: Linux
            cfg: {path: a.json}
    `),
  ).combos;

  it('resolves keys case-insensitively and walks nested objects', () => {
    expect(evaluateTemplate('${{ matrix.NAME }}', matrixResolver(combo!))).toMatchObject({ value: 'Linux' });
    expect(evaluateTemplate('${{ matrix.cfg.path }}', matrixResolver(combo!))).toMatchObject({
      value: 'a.json',
    });
  });

  it('taints missing keys', () => {
    const v = evaluateTemplate('${{ matrix.config }}', matrixResolver(combo!));
    expect(v).toEqual({ known: true, value: null, taint: [{ kind: 'missing-matrix-key', key: 'config' }] });
  });

  it('labels combinations', () => {
    expect(comboLabel(combo!)).toBe('{ name: Linux, cfg: {"path":"a.json"} }');
    expect(comboLabel(combo!, ['name'])).toBe('{ name: Linux }');
  });
});

// ---------------------------------------------------------------------------
// Property-based: compare against a naive, independently written reference.
// ---------------------------------------------------------------------------

type Obj = Record<string, Json>;

/** Literal transcription of the algorithm in GitHub's "Using a matrix for your jobs" docs. */
function reference(dims: Record<string, Json[]>, include: Obj[], exclude: Obj[]): Obj[] {
  const keys = Object.keys(dims);
  let combos: Obj[] = keys.length ? [{}] : [];
  for (const k of keys) combos = combos.flatMap((c) => dims[k]!.map((v) => ({ ...c, [k]: v })));
  combos = combos.filter(
    (c) => !exclude.some((e) => Object.entries(e).every(([k, v]) => k in c && jsonEqual(c[k]!, v))),
  );
  const originals = combos.map((c) => ({ ...c }));
  const extra: Obj[] = [];
  for (const inc of include) {
    let added = false;
    combos.forEach((c, i) => {
      const orig = originals[i]!;
      const fits = Object.entries(inc).every(([k, v]) => !(k in orig) || jsonEqual(orig[k]!, v));
      if (fits) {
        Object.assign(c, inc);
        added = true;
      }
    });
    if (!added) extra.push({ ...inc });
  }
  return [...combos, ...extra];
}

const loc: Loc = { file: 'x', line: 1, column: 1, endLine: 1, endColumn: 1 };
const value = fc.oneof(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 2 }), fc.boolean());
const entry = fc.dictionary(fc.constantFrom('k1', 'k2', 'k3', 'x1', 'x2'), value, { maxKeys: 3 });

describe('expandMatrix — properties', () => {
  it('matches the reference algorithm for arbitrary static matrices', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom('k1', 'k2', 'k3'),
          fc.uniqueArray(value, { minLength: 1, maxLength: 3, comparator: jsonEqual }),
          { maxKeys: 3 },
        ),
        fc.array(entry, { maxLength: 4 }),
        fc.array(entry, { maxLength: 3 }),
        (dims, include, exclude) => {
          const m: MatrixDecl = {
            loc,
            dynamic: false,
            dims: Object.entries(dims).map(([name, values]) => ({ name, loc, values, unknownIndexes: [] })),
            include: include.map((values) => ({ loc, values, dynamicKeys: [], keyLocs: {} })),
            exclude: exclude.map((values) => ({ loc, values, dynamicKeys: [], keyLocs: {} })),
            includeDynamic: false,
            excludeDynamic: false,
          };
          const actual = plain(expandMatrix(m).combos);
          expect(actual).toEqual(reference(dims, include, exclude));
        },
      ),
      { numRuns: 500 },
    );
  });

  it('every key of every combination appears in `keys`', () => {
    fc.assert(
      fc.property(fc.array(entry, { minLength: 1, maxLength: 5 }), (include) => {
        const m: MatrixDecl = {
          loc,
          dynamic: false,
          dims: [],
          include: include.map((values) => ({ loc, values, dynamicKeys: [], keyLocs: {} })),
          exclude: [],
          includeDynamic: false,
          excludeDynamic: false,
        };
        const exp = expandMatrix(m);
        for (const c of exp.combos) for (const k of Object.keys(c.values)) expect(exp.keys).toContain(k);
      }),
    );
  });
});
