import { compareLoc, formatLoc, type Loc, SourceFile } from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { WF } from './helpers';

/** A source file whose line counter the YAML parser has filled, as the loader does. */
function parsed(path: string, text: string): SourceFile {
  const source = new SourceFile(path, text);
  parseDocument(text, { lineCounter: source.lineCounter });
  return source;
}

const loc = (file: string, line: number, column: number): Loc => ({
  file,
  line,
  column,
  endLine: line,
  endColumn: column + 1,
});

describe('SourceFile', () => {
  it('splits the text into lines, LF or CRLF', () => {
    expect(new SourceFile('a.yml', 'on: push\r\njobs: {}\n').lines).toEqual(['on: push', 'jobs: {}', '']);
    expect(new SourceFile('a.yml', 'x').lines).toEqual(['x']);
  });

  it('turns character offsets into 1-based line and column ranges', () => {
    const text = 'on: push\njobs:\n  build: {}\n';
    const source = parsed(`${WF}/ci.yml`, text);
    const start = text.indexOf('build');
    expect(source.loc(start, start + 'build'.length)).toEqual({
      file: `${WF}/ci.yml`,
      line: 3,
      column: 3,
      endLine: 3,
      endColumn: 8,
    });
    // A range may span lines; an empty one sits at its start.
    expect(source.loc(0, text.indexOf('jobs') + 4)).toMatchObject({
      line: 1,
      column: 1,
      endLine: 2,
      endColumn: 5,
    });
    expect(source.loc(start)).toMatchObject({ line: 3, column: 3, endLine: 3, endColumn: 3 });
  });

  it('clamps a negative start to the beginning, and an end before the start to the start', () => {
    const source = parsed('a.yml', 'on: push\njobs: {}\n');
    expect(source.loc(-5, 2)).toMatchObject({ line: 1, column: 1, endLine: 1, endColumn: 3 });
    expect(source.loc(12, 3)).toMatchObject({ line: 2, column: 4, endLine: 2, endColumn: 4 });
  });

  // The end is clamped against the clamped start, so a range that ends before the beginning ends there too.
  it('clamps the end of a range that ends before the beginning', () => {
    const source = parsed('a.yml', 'on: push\njobs: {}\n');
    expect(source.loc(-5)).toMatchObject({ line: 1, column: 1, endLine: 1, endColumn: 1 });
    expect(source.loc(-5, -3)).toMatchObject({ line: 1, column: 1, endLine: 1, endColumn: 1 });
  });
});

describe('formatLoc', () => {
  it('formats file:line:column, as editors and CI annotations link it', () => {
    expect(formatLoc(loc(`${WF}/ci.yml`, 12, 7))).toBe('.github/workflows/ci.yml:12:7');
    expect(formatLoc({ file: `${WF}/deploy:prod.yml`, line: 1, column: 1 })).toBe(
      '.github/workflows/deploy:prod.yml:1:1',
    );
  });
});

describe('compareLoc', () => {
  it('orders by file, then line, then column', () => {
    const locs = [
      loc('b.yml', 1, 1),
      loc('a.yml', 10, 2),
      loc('a.yml', 2, 9),
      loc('a.yml', 10, 1),
      loc('.github/actions/x/action.yml', 5, 5),
    ];
    expect([...locs].sort(compareLoc).map(formatLoc)).toEqual([
      '.github/actions/x/action.yml:5:5',
      'a.yml:2:9',
      'a.yml:10:1',
      'a.yml:10:2',
      'b.yml:1:1',
    ]);
    expect(compareLoc(loc('a.yml', 3, 4), { ...loc('a.yml', 3, 4), endLine: 9 })).toBe(0);
  });
});
