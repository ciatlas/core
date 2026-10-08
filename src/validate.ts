import { NoOperationTraceWriter, parseWorkflow } from '@actions/workflow-parser';
import { parseAction } from '@actions/workflow-parser/actions/action-parser';
import { CONTEXT_FUNCTIONS, KNOWN_CONTEXTS } from './expressions';
import type { Diagnostic, UnitDecl } from './ir';
import type { Logger } from './logger';

/** Syntax problems are reported by FP502 with better positions; drop the parser's duplicates. */
const SYNTAX_NOISE = [/Unexpected symbol/i, /Unexpected end of expression/i, /Unclosed expression/i];

/** Action metadata that GitHub's schema requires but the runner does not need for local actions. */
const LOCAL_ACTION_NOISE = /Required property is missing: (name|description)\b/i;

const CONTEXT_NAMES = new Set<string>(KNOWN_CONTEXTS);
const FUNCTION_NAMES = new Set(CONTEXT_FUNCTIONS.map((f) => f.name.toLowerCase()));

/**
 * "Unrecognized named-value: 'env'" for a context flowpact knows means the context is not available in that field
 * (GitHub's context-availability rules); for an unknown name it is a typo already reported by FP502.
 */
function classify(message: string): 'drop' | 'context' | 'schema' {
  if (SYNTAX_NOISE.some((re) => re.test(message))) return 'drop';
  const named = /Unrecognized named-value: '([^']+)'/i.exec(message);
  if (named) return CONTEXT_NAMES.has(named[1]!.toLowerCase()) ? 'context' : 'drop';
  const fn = /Unrecognized function: '([^']+)'/i.exec(message);
  if (fn) return FUNCTION_NAMES.has(fn[1]!.toLowerCase()) ? 'context' : 'drop';
  return 'schema';
}

interface ParserError {
  message: string;
  range?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

/**
 * Validates a workflow or action against GitHub's schema using @actions/workflow-parser
 * (the parser behind GitHub's Actions language service). Never throws: if the parser itself fails,
 * validation is skipped for that file and the reason is logged.
 */
export function validateSchema(unit: UnitDecl, logger: Logger): Diagnostic[] {
  try {
    const file = { name: unit.file, content: unit.source.text };
    const result =
      unit.kind === 'workflow'
        ? parseWorkflow(file, new NoOperationTraceWriter())
        : parseAction(file, new NoOperationTraceWriter());
    const errors = result.context.errors.getErrors() as ParserError[];
    return errors
      .filter((e) => classify(e.message) !== 'drop')
      .filter((e) => !(unit.kind === 'action' && LOCAL_ACTION_NOISE.test(e.message)))
      .map((e) => {
        const r = e.range;
        const at = /\(Line: (\d+), Col: (\d+)\)/.exec(e.message);
        const message = e.message
          .replace(/^[^:]*\.ya?ml(?: \(Line: \d+, Col: \d+\))?:\s*/, '')
          .replace(/\.\s*Located at position \d+ within expression:.*$/s, '');
        return {
          message,
          ...(classify(e.message) === 'context' ? { kind: 'context' as const } : {}),
          ...(at ? { at: { line: Number(at[1]), column: Number(at[2]) } } : {}),
          loc: r
            ? {
                file: unit.file,
                line: r.start.line,
                column: r.start.column,
                endLine: r.end.line,
                endColumn: r.end.column,
              }
            : { file: unit.file, line: 1, column: 1, endLine: 1, endColumn: 1 },
        };
      });
  } catch (err) {
    logger.debug(`schema validation skipped for ${unit.file}`, { reason: (err as Error).message });
    return [];
  }
}
