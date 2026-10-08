import { analyze, memoryFileSystem } from '@flowpact/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const ident = fc.constantFrom('a', 'b', 'build', 'test', 'x-y', 'node_version');
const expr = fc.oneof(
  fc.constantFrom(
    'inputs.a',
    'matrix.os',
    "needs.build.outputs['v']",
    'steps.s.outputs.o',
    "format('{0}', matrix.x)",
    'fromJSON(inputs.b)[0]',
    'secrets.TOKEN',
    'env.X',
    'github.event.inputs.a',
    'inputs[',
    "'unterminated",
    '== 1',
    '',
  ),
  fc.string({ maxLength: 12 }),
);
const scalar = fc.oneof(
  expr.map((e) => `\${{ ${e} }}`),
  fc.constantFrom('true', 'false', '1', "''", 'plain text', '[a, b]', '{a: 1}', '${{', '}}'),
);
const mapping = (depth: number): fc.Arbitrary<string> =>
  depth <= 0
    ? scalar
    : fc
        .array(
          fc.tuple(
            fc.constantFrom(
              'on',
              'jobs',
              'uses',
              'with',
              'needs',
              'strategy',
              'matrix',
              'include',
              'exclude',
              'steps',
              'run',
              'if',
              'outputs',
              'inputs',
              'secrets',
              'env',
              'id',
              'workflow_call',
              'runs',
              'using',
            ),
            fc.oneof(
              scalar,
              fc.constant('./.github/workflows/w0.yml'),
              fc.constant('./.github/actions/a'),
              ident,
            ),
          ),
          { maxLength: 6 },
        )
        .map((pairs) => pairs.map(([k, v]) => `${k}: ${v}`).join('\n'));

/** Random, often invalid, but YAML-shaped workflow documents. */
const document = fc.oneof(
  mapping(2),
  fc
    .tuple(fc.array(ident, { maxLength: 4 }), fc.array(scalar, { maxLength: 4 }), fc.boolean())
    .map(([jobs, vals, call]) =>
      [
        call ? 'on:\n  workflow_call:\n    inputs:\n      a: { type: string, required: true }' : 'on: push',
        'jobs:',
        ...jobs.flatMap((j, i) => [
          `  ${j}${i}:`,
          i % 2 ? '    uses: ./.github/workflows/w0.yml' : '    runs-on: x',
          `    needs: [${jobs[0] ?? 'a'}0]`,
          '    strategy:',
          '      matrix:',
          `        include: [{ os: ${vals[0] ?? 'x'} }, { cfg: 1 }]`,
          i % 2
            ? `    with:\n      a: ${vals[1] ?? 'x'}`
            : `    steps:\n      - id: s\n        run: echo ${vals[2] ?? ''}\n      - uses: ./.github/actions/a\n        with: { q: ${vals[3] ?? 1} }`,
        ]),
      ].join('\n'),
    ),
  fc.string({ maxLength: 200 }),
);

describe('robustness', () => {
  let run = 0;
  it('never throws on arbitrary workflow-shaped input', () => {
    fc.assert(
      fc.property(fc.array(document, { minLength: 1, maxLength: 3 }), document, (docs, actionDoc) => {
        const files: Record<string, string> = { '.github/actions/a/action.yml': actionDoc };
        for (const [i, d] of docs.entries()) files[`.github/workflows/w${i}.yml`] = d;
        const r = analyze({
          root: '/v',
          fs: memoryFileSystem(files),
          validateSchema: run++ % 3 === 0,
          repository: 'a/b',
        });
        for (const f of r.findings) {
          expect(f.loc.line).toBeGreaterThan(0);
          expect(f.loc.column).toBeGreaterThan(0);
          expect(f.docsUrl).toMatch(/^https:/);
        }
      }),
      { numRuns: 300 },
    );
  });
});
