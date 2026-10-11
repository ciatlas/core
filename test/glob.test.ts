import { matchesPattern } from '@flowpact/core';
import { describe, expect, it } from 'vitest';

describe('matchesPattern', () => {
  it.each([
    // A plain string is the path itself, or a directory holding it.
    ['.github/workflows/a.yml', '.github/workflows/a.yml', true],
    ['.github/workflows/a.yml', '.github/workflows', true],
    ['.github/workflows/a.yml', '.github/workflows/', true],
    ['.github/workflows/a.yml', '.github', true],
    // A prefix only matches whole segments.
    ['.github/workflows/a.yml', '.github/work', false],
    ['.github/workflows-old/a.yml', '.github/workflows', false],
    // A trailing slash names a directory: the directory's own path does not match it.
    ['.github/workflows', '.github/workflows/', false],
    ['.github/workflows', '.github/workflows/a.yml', false],
  ])('matchesPattern(%s, %s) = %s (plain prefix)', (path, pattern, expected) => {
    expect(matchesPattern(path, pattern)).toBe(expected);
  });

  it.each([
    // `*` stays within one segment.
    ['.github/workflows/a.yml', '.github/workflows/*.yml', true],
    ['.github/workflows/.yml', '.github/workflows/*.yml', true],
    ['.github/workflows/sub/a.yml', '.github/workflows/*.yml', false],
    ['.github/workflows/a.yaml', '.github/workflows/*.yml', false],
    ['.github/actions/build', '.github/actions/*', true],
    ['.github/actions/build/action.yml', '.github/actions/*', false],
    ['tools/a/action.yml', 'tools/*/action.yml', true],
    ['tools/a/b/action.yml', 'tools/*/action.yml', false],
    ['.github/workflows/release-1.yml', '.github/workflows/release-*.yml', true],
    // The whole path must match: a glob is not a prefix.
    ['.github/workflows/a.yml.bak', '.github/workflows/*.yml', false],
    ['x/.github/workflows/a.yml', '.github/workflows/*.yml', false],
  ])('matchesPattern(%s, %s) = %s (`*`)', (path, pattern, expected) => {
    expect(matchesPattern(path, pattern)).toBe(expected);
  });

  it.each([
    // `**` crosses segments.
    ['.github/workflows/sub/a.yml', '.github/**/a.yml', true],
    ['.github/a/b/c/a.yml', '.github/**/a.yml', true],
    ['tools/a/b/action.yml', 'tools/**', true],
    ['tools', 'tools/**', false],
    ['tools/a/b', 'tools/**/b', true],
    // `**/` also matches no directory at all.
    ['.github/a.yml', '.github/**/a.yml', true],
    ['action.yml', '**/action.yml', true],
    ['deep/er/action.yml', '**/action.yml', true],
    ['deep/er/my-action.yml', '**/action.yml', false],
    // `**` inside a segment matches across segments too.
    ['tools/a/b.yml', 'tools/**.yml', true],
  ])('matchesPattern(%s, %s) = %s (`**`)', (path, pattern, expected) => {
    expect(matchesPattern(path, pattern)).toBe(expected);
  });

  it('treats every other character literally: no `?`, character classes, braces or negation', () => {
    // Regular-expression syntax in a glob is escaped, so `.` is a dot, not any character.
    expect(matchesPattern('.github/workflows/ayml', '.github/workflows/*.yml')).toBe(false);
    expect(matchesPattern('a+b/x.yml', 'a+b/*.yml')).toBe(true);
    expect(matchesPattern('a(b)/x.yml', 'a(b)/*.yml')).toBe(true);
    expect(matchesPattern('$x^/x.yml', '$x^/*.yml')).toBe(true);
    // `?` and `[...]` are literal characters.
    expect(matchesPattern('tools/a1/x', 'tools/a?/*')).toBe(false);
    expect(matchesPattern('tools/a?/x', 'tools/a?/*')).toBe(true);
    expect(matchesPattern('tools/a/x', 'tools/[ab]/*')).toBe(false);
    expect(matchesPattern('tools/[ab]/x', 'tools/[ab]/*')).toBe(true);
    expect(matchesPattern('tools/a1', 'tools/a?')).toBe(false);
    // `{a,b}` is not expanded.
    expect(matchesPattern('a.yml', '{a,b}.yml')).toBe(false);
    expect(matchesPattern('a.yml', '*.{yml,yaml}')).toBe(false);
    // A leading `!` is part of the path, not a negation.
    expect(matchesPattern('other/a', '!tools')).toBe(false);
    expect(matchesPattern('!tools/a', '!tools')).toBe(true);
    expect(matchesPattern('b.yml', '!a*.yml')).toBe(false);
  });

  it('is case-sensitive, like GitHub', () => {
    expect(matchesPattern('.github/workflows/A.yml', '.github/workflows/a.yml')).toBe(false);
    expect(matchesPattern('.GitHub/workflows/a.yml', '.github/**')).toBe(false);
    expect(matchesPattern('.github/workflows/a.YML', '.github/workflows/*.yml')).toBe(false);
  });
});
