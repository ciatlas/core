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
 * leading whitespace) as a command; names from the analyzed YAML can land there, e.g. through word wrapping. A zero-width
 * space after the first colon keeps the text readable.
 */
export function neutralizeWorkflowCommands(s: string): string {
  return s.replace(/^((?:\s|\u001b\[[\d;]*m)*):(?=:)/gm, '$1:​');
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
