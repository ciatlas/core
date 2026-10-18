import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { posixBasename, posixIsAbsolute, posixJoin, posixNormalize } from '../src/posix';

/** The helpers agree with Node's `path.posix` on every path the parser and the loader hand them. */
const PATHS = [
  '',
  '.',
  './',
  '/',
  '//',
  'a',
  'a/',
  './a',
  'a/./b',
  'a//b',
  'a/b/',
  'a/../b',
  'a/../../b',
  '../a',
  '..',
  '../..',
  '/a/../..',
  '/..',
  '/a/b/../c/',
  '.github/workflows/ci.yml',
  './.github/./actions/x/',
  'a/b/c/../../..',
  'a/b/c/../../../..',
];

describe('posix helpers', () => {
  it('normalize, join, basename and isAbsolute match node:path', () => {
    for (const p of PATHS) {
      expect(posixNormalize(p), `normalize(${JSON.stringify(p)})`).toBe(posix.normalize(p));
      expect(posixBasename(p), `basename(${JSON.stringify(p)})`).toBe(posix.basename(p));
      expect(posixIsAbsolute(p), `isAbsolute(${JSON.stringify(p)})`).toBe(posix.isAbsolute(p));
      for (const q of ['', '.', 'x', '../y', 'z/']) {
        expect(posixJoin(p, q), `join(${JSON.stringify(p)}, ${JSON.stringify(q)})`).toBe(posix.join(p, q));
      }
    }
    expect(posixJoin()).toBe(posix.join());
    expect(posixJoin('', '')).toBe(posix.join('', ''));
  });
});
