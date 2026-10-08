import {
  type ContextResolver,
  evaluate,
  evaluateTemplate,
  findTemplateSegments,
  known,
  parseExpression,
  toNumber,
  toStr,
  truthy,
  UNKNOWN,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';

const refs = (src: string) =>
  parseExpression(src).refs.map(
    (r) => `${r.context}${r.path.length ? `.${r.path.join('.')}` : ''}${r.dynamic ? '!' : ''}`,
  );
const noCtx: ContextResolver = () => undefined;
const ev = (src: string, resolve: ContextResolver = noCtx) => {
  const p = parseExpression(src);
  if (!p.ast) throw new Error(p.error?.message);
  return evaluate(p.ast, resolve);
};

describe('findTemplateSegments', () => {
  it('finds every ${{ }} with offsets', () => {
    const text = 'a ${{ inputs.x }} b ${{matrix.y}}';
    const segs = findTemplateSegments(text);
    expect(segs.map((s) => [s.start, s.end, s.expr.source])).toEqual([
      [2, 17, 'inputs.x'],
      [20, 33, 'matrix.y'],
    ]);
    expect(text.slice(segs[0]!.innerStart, segs[0]!.innerStart + 8)).toBe('inputs.x');
  });

  it('ignores }} inside single-quoted strings', () => {
    const segs = findTemplateSegments("${{ format('{0}}}', inputs.a) }}");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.expr.source).toBe("format('{0}}}', inputs.a)");
  });

  it('reports unterminated expressions', () => {
    const segs = findTemplateSegments('echo ${{ inputs.a ');
    expect(segs[0]!.expr.error?.message).toMatch(/Unterminated/);
  });

  it('returns nothing for plain text', () => {
    expect(findTemplateSegments('echo $HOME and {{ not }}')).toEqual([]);
  });
});

describe('parseExpression references', () => {
  it('extracts dotted, bracketed and nested references', () => {
    expect(refs("inputs.foo && needs.build.outputs['x'] || format('{0}', matrix.cfg)")).toEqual([
      'inputs.foo',
      'needs.build.outputs.x',
      'matrix.cfg',
    ]);
  });

  it('marks computed indexes and bare contexts as dynamic', () => {
    expect(refs('inputs[matrix.key]')).toEqual(['inputs.?!', 'matrix.key']);
    expect(refs('toJSON(inputs)')).toEqual(['inputs!']);
  });

  it('keeps filters and hyphenated names', () => {
    expect(refs('github.event.inputs.release-notes')).toEqual(['github.event.inputs.release-notes']);
    expect(refs('needs.*.result')).toEqual(['needs.*.result']);
  });

  it('lowercases context names but keeps property case', () => {
    expect(refs('Inputs.Foo')).toEqual(['inputs.Foo']);
  });

  it('records precise offsets', () => {
    const src = "github.ref == 'x' && steps.meta.outputs.version";
    const r = parseExpression(src).refs[1]!;
    expect(src.slice(r.start, r.end)).toBe('steps.meta.outputs.version');
  });

  it('accepts context-specific functions', () => {
    expect(parseExpression("hashFiles('**/lock')").error).toBeUndefined();
    expect(parseExpression('success() && always()').error).toBeUndefined();
  });

  it('reports syntax errors with an offset', () => {
    const p = parseExpression("inputs.mode = 'release'");
    expect(p.error?.message).toMatch(/Unexpected symbol/);
    expect(p.error?.offset).toBe(12);
    expect(parseExpression('foo.bar').error?.message).toMatch(/named-value/);
  });
});

describe('coercions', () => {
  it.each([
    [null, false],
    [0, false],
    [Number.NaN, false],
    ['', false],
    ['0', true],
    [[], true],
    [{}, true],
  ])('truthy(%j) = %s', (v, expected) => expect(truthy(v as never)).toBe(expected));

  it('converts to number and string like GitHub', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber('')).toBe(0);
    expect(toNumber(' 42 ')).toBe(42);
    expect(toNumber('0x1f')).toBe(31);
    expect(toNumber('abc')).toBeNaN();
    expect(toNumber(true)).toBe(1);
    expect(toNumber([])).toBeNaN();
    expect(toStr(null)).toBe('');
    expect(toStr(false)).toBe('false');
    expect(toStr([1])).toBe('Array');
    expect(toStr({})).toBe('Object');
  });
});

describe('evaluate', () => {
  it('evaluates literals and comparison operators', () => {
    expect(ev("'ABC' == 'abc'")).toEqual(known(true));
    expect(ev("1 == '1'")).toEqual(known(true));
    expect(ev("null == ''")).toEqual(known(true));
    expect(ev('2 > 1')).toEqual(known(true));
    expect(ev("'b' < 'A'")).toEqual(known(false));
    expect(ev("'a' != 'b'")).toEqual(known(true));
    expect(ev('!0')).toEqual(known(true));
    expect(ev("'x' > 1")).toEqual(known(false));
  });

  it('returns operands, not booleans, from && and ||', () => {
    expect(ev("'' || 'fallback'")).toEqual(known('fallback'));
    expect(ev("'a' && 'b'")).toEqual(known('b'));
    expect(ev("0 && 'b'")).toEqual(known(0));
    expect(ev("'a' || 'b'")).toEqual(known('a'));
  });

  it('evaluates built-in functions', () => {
    expect(ev("format('{0}-{1}{{x}}', 'a', 1)")).toEqual(known('a-1{x}'));
    expect(ev("contains('Hello', 'ELL')")).toEqual(known(true));
    expect(ev("contains(fromJSON('[1,2]'), 2)")).toEqual(known(true));
    expect(ev("startsWith('refs/heads/main', 'REFS/')")).toEqual(known(true));
    expect(ev("endsWith('a.yml', '.YML')")).toEqual(known(true));
    expect(ev('join(fromJSON(\'["a","b"]\'), \'+\')')).toEqual(known('a+b'));
    expect(ev("join('x')")).toEqual(known('x'));
    expect(ev('fromJSON(\'{"a":{"b":3}}\').a.b')).toEqual(known(3));
    expect(ev("fromJSON('[1,2]')[1]")).toEqual(known(2));
    expect(ev("toJSON('x')")).toEqual(known('"x"'));
    expect(ev("fromJSON('not json')")).toEqual(UNKNOWN);
  });

  it('treats runtime-only functions and contexts as unknown', () => {
    expect(ev('success()').known).toBe(false);
    expect(ev("hashFiles('x')").known).toBe(false);
    expect(ev('github.sha').known).toBe(false);
    expect(ev('github.sha == 1').known).toBe(false);
  });

  it('propagates taint of the returned operand only', () => {
    const resolve: ContextResolver = ({ context, path }) =>
      context === 'matrix' && path[0] === 'missing'
        ? known(null, [{ kind: 'missing-matrix-key', key: 'missing' }])
        : undefined;
    expect(ev("matrix.missing || 'default'", resolve)).toEqual(known('default'));
    expect(ev('matrix.missing', resolve).taint).toHaveLength(1);
    expect(ev("format('--c={0}', matrix.missing)", resolve)).toEqual(
      known('--c=', [{ kind: 'missing-matrix-key', key: 'missing' }]),
    );
  });

  it('resolves computed indexes through the resolver', () => {
    const resolve: ContextResolver = ({ context, path }) => {
      if (context === 'matrix' && path[0] === 'k') return known('a');
      if (context === 'inputs' && path[0] === 'a') return known('A');
      return undefined;
    };
    expect(ev('inputs[matrix.k]', resolve)).toEqual(known('A'));
  });
});

describe('evaluateTemplate', () => {
  const resolve: ContextResolver = ({ context, path }) =>
    context === 'matrix' ? known(path[0] === 'n' ? 3 : 'x') : undefined;
  it('keeps the type of a single whole expression', () => {
    expect(evaluateTemplate('${{ matrix.n }}', resolve)).toEqual(known(3));
  });
  it('interpolates mixed text as a string', () => {
    expect(evaluateTemplate('a-${{ matrix.n }}-${{ matrix.s }}', resolve)).toEqual(known('a-3-x'));
  });
  it('is unknown when any part is unknown', () => {
    expect(evaluateTemplate('a-${{ github.sha }}', resolve).known).toBe(false);
  });
  it('returns plain text unchanged', () => {
    expect(evaluateTemplate('plain', resolve)).toEqual(known('plain'));
  });
});
