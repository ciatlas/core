import { LineCounter } from 'yaml';

/** A 1-based source position range inside a repo-relative file. */
export interface Loc {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export class SourceFile {
  readonly lines: string[];
  readonly lineCounter = new LineCounter();

  constructor(
    /** Repo-relative POSIX path, e.g. `.github/workflows/ci.yml`. */
    readonly path: string,
    readonly text: string,
  ) {
    this.lines = text.split(/\r?\n/);
  }

  /** Converts a [start, end) character offset range to a {@link Loc}. Requires the line counter to be populated by the YAML parser. */
  loc(start: number, end: number = start): Loc {
    const a = this.lineCounter.linePos(Math.max(0, start));
    const b = this.lineCounter.linePos(Math.max(start, end));
    return { file: this.path, line: a.line, column: a.col, endLine: b.line, endColumn: b.col };
  }
}

export function formatLoc(loc: Pick<Loc, 'file' | 'line' | 'column'>): string {
  return `${loc.file}:${loc.line}:${loc.column}`;
}

export function compareLoc(a: Loc, b: Loc): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column;
}
