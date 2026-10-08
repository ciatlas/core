/** Regressions for CodeQL code-scanning alerts: inputs that made regexes backtrack quadratically. */
import { analyze, classifyUses, createParseContext, memoryFileSystem, trace, trimChar } from '@flowpact/core';
import { describe, expect, it } from 'vitest';

const loc = { file: 'x.yml', line: 1, column: 1, endLine: 1, endColumn: 1 };
const within = (ms: number, f: () => void) => {
  const started = performance.now();
  f();
  expect(performance.now() - started).toBeLessThan(ms);
};

describe('trimChar', () => {
  it('trims runs at the end, and at the start on request', () => {
    expect(trimChar('a//', '/')).toBe('a');
    expect(trimChar('//a//', '/')).toBe('//a');
    expect(trimChar('__a_b__', '_', { start: true })).toBe('a_b');
    expect(trimChar('///', '/')).toBe('');
    expect(trimChar('', '/')).toBe('');
  });

  it('is linear on long runs that do not reach the end (js/polynomial-redos)', () => {
    within(500, () => expect(trimChar(`a${'/'.repeat(200_000)}a`, '/')).toHaveLength(200_002));
  });
});

describe('linear on adversarial input (js/polynomial-redos)', () => {
  it('normalizes local uses paths', () => {
    const ctx = createParseContext();
    expect(classifyUses('./.github/actions/x//', 'step', loc, ctx)).toMatchObject({
      target: '.github/actions/x',
    });
    expect(classifyUses('./', 'step', loc, ctx)).toMatchObject({ target: '.' });
    within(2_000, () => classifyUses(`./a${'/'.repeat(50_000)}a`, 'step', loc, ctx));
  });

  it('splits secret symbols without backtracking, in both directions', () => {
    const index = analyze({
      root: '/r',
      fs: memoryFileSystem({ '.github/workflows/a.yml': 'on: push\njobs: {}\n' }),
      validateSchema: false,
    }).index;
    const evil = `${'a#secrets.a'.repeat(50_000)}\n`;
    within(2_000, () => {
      trace(index, evil);
      trace(index, evil, { direction: 'up' });
    });
  });
});
