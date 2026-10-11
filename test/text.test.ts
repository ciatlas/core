import {
  didYouMean,
  escapeControl,
  jsonSafe,
  neutralizeWorkflowCommands,
  trimChar,
  typoDistance,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';

const within = (ms: number, f: () => void) => {
  const started = performance.now();
  f();
  expect(performance.now() - started).toBeLessThan(ms);
};

describe('escapeControl', () => {
  it('makes C0 and C1 control characters visible, and keeps other text', () => {
    expect(escapeControl('\u001b[31mred\u001b[0m')).toBe('\\x1b[31mred\\x1b[0m');
    expect(escapeControl('a\nb\tc\rd')).toBe('a\\nb\\tc\\x0dd');
    expect(escapeControl('\u0000\u007f\u0085\u009f')).toBe('\\x00\\x7f\\x85\\x9f');
    expect(escapeControl('non\u00a0breaking, ünïcödé, ${{ x }}')).toBe(
      'non\u00a0breaking, ünïcödé, ${{ x }}',
    );
  });

  it('keeps line breaks on request, and still escapes the rest', () => {
    expect(escapeControl('line 1\nline 2\r\n\u001b[2m', true)).toBe('line 1\nline 2\\x0d\n\\x1b[2m');
  });
});

describe('neutralizeWorkflowCommands', () => {
  it('breaks `::` at the start of any line, after whitespace or colour codes', () => {
    expect(neutralizeWorkflowCommands('ok\n  ::error title=x::pwned\n::warning::y')).toBe(
      'ok\n  :\u200b:error title=x::pwned\n:\u200b:warning::y',
    );
    expect(neutralizeWorkflowCommands('\t\u001b[2;31m::set-output name=a::b')).toBe(
      '\t\u001b[2;31m:\u200b:set-output name=a::b',
    );
    // The runner trims U+0085 like whitespace.
    expect(neutralizeWorkflowCommands('\u0085::add-mask::x')).toBe('\u0085:\u200b:add-mask::x');
  });

  it('breaks the legacy `##[` anywhere in a line, and leaves other colons alone', () => {
    expect(neutralizeWorkflowCommands('Input "a##[set-output name=x]1" is unused')).toBe(
      'Input "a##\u200b[set-output name=x]1" is unused',
    );
    expect(neutralizeWorkflowCommands('a :: b')).toBe('a :: b');
    expect(neutralizeWorkflowCommands('std::string and a: b')).toBe('std::string and a: b');
    expect(neutralizeWorkflowCommands(': single')).toBe(': single');
  });
});

describe('jsonSafe', () => {
  it('escapes `##[` and the Unicode line separators without changing the data', () => {
    const data = { message: 'a##[set-output name=x]1', text: 'one\u2028two\u2029three' };
    const json = jsonSafe(JSON.stringify(data));
    expect(json).toBe('{"message":"a##\\u005bset-output name=x]1","text":"one\\u2028two\\u2029three"}');
    expect(json).not.toMatch(/##\[|\u2028|\u2029/);
    expect(JSON.parse(json)).toEqual(data);
  });

  it('leaves JSON without them as it is', () => {
    const json = JSON.stringify({ a: [1, '#[x]', '## ['] }, null, 2);
    expect(jsonSafe(json)).toBe(json);
  });
});

describe('trimChar', () => {
  it('trims runs at the end, and at the start on request', () => {
    expect(trimChar('a//', '/')).toBe('a');
    expect(trimChar('//a//', '/')).toBe('//a');
    expect(trimChar('//a//', '/', { start: true })).toBe('a');
    expect(trimChar('__a_b__', '_', { start: true })).toBe('a_b');
    expect(trimChar('a/b', '/')).toBe('a/b');
    expect(trimChar('///', '/')).toBe('');
    expect(trimChar('///', '/', { start: true })).toBe('');
    expect(trimChar('', '/')).toBe('');
  });

  it('is linear on long runs that do not reach the end (js/polynomial-redos)', () => {
    within(500, () => expect(trimChar(`a${'/'.repeat(200_000)}a`, '/')).toHaveLength(200_002));
  });
});

describe('typoDistance', () => {
  it('counts insertions, deletions and substitutions, case-sensitively', () => {
    expect(typoDistance('build', 'build')).toBe(0);
    expect(typoDistance('', 'abc')).toBe(3);
    expect(typoDistance('abc', '')).toBe(3);
    expect(typoDistance('kitten', 'sitting')).toBe(3);
    expect(typoDistance('FP101', 'fp101')).toBe(2);
  });

  it('counts swapping two neighbouring characters as one edit', () => {
    expect(typoDistance('ab', 'ba')).toBe(1);
    expect(typoDistance('FP110', 'FP101')).toBe(1);
    expect(typoDistance('deploy', 'delpoy')).toBe(1);
    expect(typoDistance('abc', 'ca')).toBe(3);
  });
});

describe('didYouMean', () => {
  const FILTERS = ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore', 'types'];

  it('suggests the closest name for a typo', () => {
    expect(didYouMean('runz', ['name', 'description', 'runs'])).toBe('runs');
    expect(didYouMean('brnaches', FILTERS)).toBe('branches');
    expect(didYouMean('typse', FILTERS)).toBe('types');
  });

  it('ignores case and treats `-` and `_` alike', () => {
    expect(didYouMean('RUNS', ['runs', 'name'])).toBe('runs');
    expect(didYouMean('working_directory', ['working-directory', 'shell'])).toBe('working-directory');
    expect(didYouMean('pathsignore', FILTERS)).toBe('paths-ignore');
  });

  it('takes an abbreviation or an extension of a name of three letters or more', () => {
    expect(didYouMean('ver', ['version', 'name'])).toBe('version');
    expect(didYouMean('branch', FILTERS)).toBe('branches');
    expect(didYouMean('inputs-list', ['inputs', 'outputs'])).toBe('inputs');
  });

  it('keeps the first of equally close names', () => {
    expect(didYouMean('cat', ['bat', 'hat'])).toBe('bat');
  });

  it('suggests nothing when no name is close enough', () => {
    expect(didYouMean('frobnicate', FILTERS)).toBeUndefined();
    expect(didYouMean('xy', ['abcd'])).toBeUndefined();
    expect(didYouMean('runs', [])).toBeUndefined();
  });

  it('allows more edits in longer names', () => {
    // Up to two edits, or a third of the name's length.
    expect(didYouMean('ab', ['abcd'])).toBe('abcd');
    expect(didYouMean('xyz-filter', ['abc-filter'])).toBe('abc-filter');
    expect(didYouMean('xyzw-filter', ['abcd-filter'])).toBeUndefined();
  });
});
