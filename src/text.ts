/**
 * Makes control characters visible (`\u001b` → `\x1b`). Names in messages come from the analyzed YAML; raw escape
 * sequences or newlines in them could rewrite the terminal or inject `::workflow-commands::` into CI logs.
 */
export function escapeControl(s: string, keepNewlines = false): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
    if (keepNewlines && ch === '\n') return ch;
    if (ch === '\n') return '\\n';
    if (ch === '\t') return '\\t';
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
}

/**
 * Stops output lines from being read as GitHub workflow commands. The runner treats a line starting with `::` (after
 * leading whitespace, which for it includes U+0085) as a command, and a legacy `##[command]` anywhere in a line; names
 * from the analyzed YAML can land in either, e.g. through word wrapping or a code frame. A zero-width space keeps the
 * text readable.
 */
export function neutralizeWorkflowCommands(s: string): string {
  return s.replace(/^((?:\s|\u0085|\u001b\[[\d;]*m)*):(?=:)/gm, '$1:\u200b').replace(/##\[/g, '##\u200b[');
}

/**
 * JSON text that no CI log can read as a workflow command, with the same data: `##[` (a legacy command anywhere in a
 * line) is written `##\u005b`, and U+2028/U+2029 (which the stdout guard takes for line breaks) as escapes. In JSON
 * these can only occur inside strings, where the escapes are valid.
 */
export function jsonSafe(json: string): string {
  return json
    .replace(/##\[/g, '##\\u005b')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * `s` without runs of `ch` at its end (and at its start with `start: true`). A loop rather than `/x+$/`, which
 * backtracks quadratically on long runs that are not at the end (CodeQL js/polynomial-redos).
 */
export function trimChar(s: string, ch: string, { start = false } = {}): string {
  let from = 0;
  let to = s.length;
  if (start) while (from < to && s[from] === ch) from++;
  while (to > from && s[to - 1] === ch) to--;
  return s.slice(from, to);
}

function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array<number>(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[x.length]![y.length]!;
}

/** Edit distance that counts swapping two neighbouring characters as one edit (optimal string alignment). */
export function typoDistance(x: string, y: string): number {
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1])
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[x.length]![y.length]!;
}

/** Suggests the closest name, treating `-`/`_` as equivalent. */
export function didYouMean(name: string, candidates: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, '');
  let best: { c: string; d: number } | undefined;
  for (const c of candidates) {
    const [a, b] = [norm(name), norm(c)];
    // Abbreviations (`ver` → `version`) are as likely as typos.
    const prefix = Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));
    const d = a === b ? 0 : prefix ? 1 : editDistance(name, c);
    if (!best || d < best.d) best = { c, d };
  }
  if (!best) return undefined;
  return best.d <= Math.max(2, Math.floor(name.length / 3)) ? best.c : undefined;
}
