import { Lexer, Parser } from '@actions/expressions';
import {
  Binary,
  ContextAccess,
  type Expr,
  FunctionCall,
  Grouping,
  IndexAccess,
  Literal,
  Logical,
  Star,
  Unary,
} from '@actions/expressions/ast';
import { Kind } from '@actions/expressions/data/expressiondata';
import { TokenType } from '@actions/expressions/lexer';

/** Every named context the GitHub Actions runtime knows about. */
export const KNOWN_CONTEXTS = [
  'github',
  'env',
  'vars',
  'job',
  'jobs',
  'steps',
  'runner',
  'secrets',
  'strategy',
  'matrix',
  'needs',
  'inputs',
] as const;

/** A reference such as `needs.build.outputs.version`, found inside an expression. */
export interface ExprRef {
  context: string;
  /** Property path after the context. `*` for a filter, `?` for a computed index. */
  path: string[];
  /**
   * True when the path contains a computed (`?`) segment or stops at the bare context. A path that stops at an object
   * below the context (`needs.build.outputs`) is not dynamic: `ProjectIndex.readsOf` resolves it to every output.
   */
  dynamic: boolean;
  /** Offsets relative to the expression source text. */
  start: number;
  end: number;
}

export interface ParsedExpression {
  /** Inner expression source, without `${{` `}}`. */
  source: string;
  ast?: Expr;
  error?: { message: string; offset: number };
  refs: ExprRef[];
}

/** A `${{ ... }}` occurrence inside a YAML scalar string. */
export interface TemplateSegment {
  /** Offsets of the whole `${{ ... }}` within the string. */
  start: number;
  end: number;
  /** Offset of the inner expression within the string. */
  innerStart: number;
  expr: ParsedExpression;
}

/** Splits a string into literal text and `${{ }}` expressions, respecting quoted strings inside expressions. */
export function findTemplateSegments(text: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('${{', i);
    if (open < 0) break;
    let j = open + 3;
    let inString = false;
    let close = -1;
    while (j < text.length) {
      const ch = text[j];
      if (inString) {
        if (ch === "'") {
          if (text[j + 1] === "'") j++;
          else inString = false;
        }
      } else if (ch === "'") {
        inString = true;
      } else if (ch === '}' && text[j + 1] === '}') {
        close = j;
        break;
      }
      j++;
    }
    if (close < 0) {
      const inner = text.slice(open + 3);
      segments.push({
        start: open,
        end: text.length,
        innerStart: open + 3,
        expr: {
          source: inner.trim(),
          refs: [],
          error: { message: "Unterminated expression: missing closing '}}'", offset: 0 },
        },
      });
      break;
    }
    const rawInner = text.slice(open + 3, close);
    const lead = rawInner.length - rawInner.trimStart().length;
    segments.push({
      start: open,
      end: close + 2,
      innerStart: open + 3 + lead,
      expr: parseExpression(rawInner.trim()),
    });
    i = close + 2;
  }
  return segments;
}

/**
 * The parser's message without its trailing "Located at position N…" (and the period and spaces before it). Found
 * with indexOf: the message repeats the offending token, and `/\.?\s*Located at position.*$/s` retried a long run of
 * spaces from every position (CodeQL js/polynomial-redos).
 */
function withoutPosition(message: string): string {
  const at = message.indexOf('Located at position');
  if (at < 0) return message;
  let end = at;
  while (end > 0 && /\s/.test(message[end - 1]!)) end--;
  if (message[end - 1] === '.') end--;
  return message.slice(0, end);
}

/** Functions that exist only in some contexts; the parser treats them as extensions. */
export const CONTEXT_FUNCTIONS = [
  { name: 'hashFiles', minArgs: 1, maxArgs: 255 },
  { name: 'success', minArgs: 0, maxArgs: 0 },
  { name: 'always', minArgs: 0, maxArgs: 0 },
  { name: 'failure', minArgs: 0, maxArgs: 0 },
  { name: 'cancelled', minArgs: 0, maxArgs: 0 },
];

const exprCache = new Map<string, ParsedExpression>();

export function parseExpression(source: string): ParsedExpression {
  const cached = exprCache.get(source);
  if (cached) return cached;
  let result: ParsedExpression;
  try {
    const tokens = new Lexer(source).lex().tokens;
    const ast = new Parser(tokens, [...KNOWN_CONTEXTS], CONTEXT_FUNCTIONS).parse();
    result = { source, ast, refs: collectRefs(ast, source) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tokRange = (err as { tok?: { range?: { start: { line: number; column: number } } } }).tok?.range;
    const posMatch = /Located at position (\d+)/.exec(message);
    const offset = tokRange
      ? offsetOf(source, tokRange.start.line, tokRange.start.column)
      : posMatch
        ? Math.max(0, Number(posMatch[1]) - 1)
        : 0;
    result = {
      source,
      refs: [],
      error: { message: withoutPosition(message), offset },
    };
  }
  exprCache.set(source, result);
  return result;
}

function offsetOf(source: string, line: number, column: number): number {
  let offset = 0;
  for (let l = 0; l < line; l++) {
    const nl = source.indexOf('\n', offset);
    if (nl < 0) break;
    offset = nl + 1;
  }
  return offset + column;
}

type Tok = { range: { start: { line: number; column: number }; end: { line: number; column: number } } };

function collectRefs(root: Expr, source: string): ExprRef[] {
  const refs: ExprRef[] = [];
  const startOf = (t: Tok) => offsetOf(source, t.range.start.line, t.range.start.column);
  const endOf = (t: Tok) => offsetOf(source, t.range.end.line, t.range.end.column);

  /** Returns the chain for `a.b['c']` or undefined when the base is not a context. */
  const chainOf = (e: Expr): { ctx: ContextAccess; path: string[]; end: number } | undefined => {
    if (e instanceof ContextAccess) {
      return { ctx: e, path: [], end: endOf(e.name as Tok) };
    }
    if (e instanceof IndexAccess) {
      const base = chainOf(e.expr);
      if (!base) return undefined;
      const idx = e.index;
      if (idx instanceof Star) return { ...base, path: [...base.path, '*'] };
      if (idx instanceof Literal && idx.literal.kind === Kind.String) {
        return {
          ...base,
          path: [...base.path, idx.literal.coerceString()],
          end: Math.max(
            base.end,
            endOf(idx.token as Tok) + (source[endOf(idx.token as Tok)] === ']' ? 1 : 0),
          ),
        };
      }
      if (idx instanceof Literal && idx.literal.kind === Kind.Number) {
        return { ...base, path: [...base.path, String(idx.literal.number())], end: base.end };
      }
      return { ...base, path: [...base.path, '?'] };
    }
    return undefined;
  };

  const visit = (e: Expr): void => {
    if (e instanceof ContextAccess || e instanceof IndexAccess) {
      const chain = chainOf(e);
      if (chain) {
        refs.push({
          context: chain.ctx.name.lexeme.toLowerCase(),
          path: chain.path,
          dynamic: chain.path.length === 0 || chain.path.includes('?'),
          start: startOf(chain.ctx.name as Tok),
          end: chain.end,
        });
        // Computed indexes may themselves contain references.
        let cur: Expr = e;
        while (cur instanceof IndexAccess) {
          if (!(cur.index instanceof Literal) && !(cur.index instanceof Star)) visit(cur.index);
          cur = cur.expr;
        }
        return;
      }
      if (e instanceof IndexAccess) {
        visit(e.expr);
        if (!(e.index instanceof Literal) && !(e.index instanceof Star)) visit(e.index);
      }
      return;
    }
    if (e instanceof Unary) visit(e.expr);
    else if (e instanceof Binary) {
      visit(e.left);
      visit(e.right);
    } else if (e instanceof Logical || e instanceof FunctionCall) {
      for (const arg of e.args) visit(arg);
    } else if (e instanceof Grouping) visit(e.group);
  };
  visit(root);
  // Make ref end offsets precise by scanning the source for the property chain.
  for (const r of refs) r.end = Math.max(r.end, refEndFromSource(source, r));
  return refs;
}

function refEndFromSource(source: string, ref: ExprRef): number {
  const re =
    /^[A-Za-z_][\w-]*(?:\s*(?:\.\s*(?:[A-Za-z_*][\w-]*)|\[\s*'(?:[^']|'')*'\s*\]|\[\s*\d+\s*\]|\[\s*\*\s*\]))*/;
  const m = re.exec(source.slice(ref.start));
  return m ? ref.start + m[0].length : ref.end;
}

// ---------------------------------------------------------------------------
// Partial evaluation
// ---------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Why a value may be wrong even though it is "known" (e.g. a matrix key that does not exist in a combination). */
export interface Taint {
  kind: 'missing-matrix-key';
  key: string;
}

export type EvalValue = { known: true; value: Json; taint: Taint[] } | { known: false; taint: Taint[] };

export const UNKNOWN: EvalValue = { known: false, taint: [] };
export const known = (value: Json, taint: Taint[] = []): EvalValue => ({ known: true, value, taint });

/** Supplies values for context references. Return `undefined` for "not statically known". */
export type ContextResolver = (ref: { context: string; path: string[] }) => EvalValue | undefined;

const mergeTaint = (...vals: EvalValue[]): Taint[] => {
  const out: Taint[] = [];
  for (const v of vals) for (const t of v.taint) if (!out.some((o) => o.key === t.key)) out.push(t);
  return out;
};

export function truthy(v: Json): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return true;
}

export function toNumber(v: Json): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    if (/^0x[0-9a-f]+$/i.test(s)) return Number.parseInt(s, 16);
    if (/^0o[0-7]+$/i.test(s)) return Number.parseInt(s.slice(2), 8);
    const n = Number(s);
    return Number.isNaN(n) ? Number.NaN : n;
  }
  return Number.NaN;
}

export function toStr(v: Json): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'string') return v;
  return Array.isArray(v) ? 'Array' : 'Object';
}

function looseEquals(a: Json, b: Json): boolean {
  const ta = jsonType(a);
  const tb = jsonType(b);
  if (ta !== tb) {
    if (ta === 'object' || tb === 'object' || ta === 'array' || tb === 'array') return false;
    return toNumber(a) === toNumber(b);
  }
  if (ta === 'string') return (a as string).toUpperCase() === (b as string).toUpperCase();
  if (ta === 'number' || ta === 'boolean' || ta === 'null') return a === b;
  return a === b;
}

function compare(a: Json, b: Json): number | undefined {
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toUpperCase();
    const y = b.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
  return x - y;
}

function jsonType(v: Json): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v as 'boolean' | 'number' | 'string' | 'object';
}

function literalToJson(lit: Literal): Json {
  switch (lit.literal.kind) {
    case Kind.String:
      return lit.literal.coerceString();
    case Kind.Number:
      return lit.literal.number();
    case Kind.Boolean:
      return lit.token.type === TokenType.TRUE;
    case Kind.Null:
      return null;
    default:
      return null;
  }
}

/** Evaluates as much of the expression as possible; anything that depends on runtime state yields `known: false`. */
export function evaluate(e: Expr, resolve: ContextResolver): EvalValue {
  if (e instanceof Literal) return known(literalToJson(e));
  if (e instanceof Grouping) return evaluate(e.group, resolve);
  if (e instanceof ContextAccess || e instanceof IndexAccess) {
    const chain = refChain(e, resolve);
    if (chain) {
      const resolved = resolve(chain);
      return resolved ?? UNKNOWN;
    }
    if (e instanceof IndexAccess) {
      const base = evaluate(e.expr, resolve);
      const idx = e.index instanceof Star ? undefined : evaluate(e.index, resolve);
      if (!base.known || !idx?.known) return { known: false, taint: mergeTaint(base, ...(idx ? [idx] : [])) };
      return known(indexInto(base.value, idx.value), mergeTaint(base, idx));
    }
    return UNKNOWN;
  }
  // Negation, comparisons and boolean functions turn a missing value into a well-defined boolean, so their result
  // carries no taint: `!matrix.x` or `matrix.x != ''` are deliberate presence checks, not empty values.
  if (e instanceof Unary) {
    const v = evaluate(e.expr, resolve);
    return v.known ? known(!truthy(v.value)) : UNKNOWN;
  }
  if (e instanceof Logical) {
    // `a || b` returns the first truthy operand and `a && b` the first falsy one. Only the operand that
    // is returned carries its taint, so `matrix.x || 'default'` is a deliberate fallback, not a missing value.
    const isAnd = e.operator.type === TokenType.AND;
    let last: EvalValue = UNKNOWN;
    for (const [i, arg] of e.args.entries()) {
      const v = evaluate(arg, resolve);
      last = v;
      if (!v.known) return v;
      if (isAnd ? !truthy(v.value) : truthy(v.value)) {
        // `matrix.x && 'value'` guards on the key: a falsy guard short-circuits on purpose.
        return isAnd && i < e.args.length - 1 ? { ...v, taint: [] } : v;
      }
    }
    return last;
  }
  if (e instanceof Binary) {
    const l = evaluate(e.left, resolve);
    const r = evaluate(e.right, resolve);
    const taint: Taint[] = [];
    if (!l.known || !r.known) return UNKNOWN;
    switch (e.operator.type) {
      case TokenType.EQUAL_EQUAL:
        return known(looseEquals(l.value, r.value), taint);
      case TokenType.BANG_EQUAL:
        return known(!looseEquals(l.value, r.value), taint);
      case TokenType.GREATER:
      case TokenType.GREATER_EQUAL:
      case TokenType.LESS:
      case TokenType.LESS_EQUAL: {
        const c = compare(l.value, r.value);
        if (c === undefined) return known(false, taint);
        const t = e.operator.type;
        return known(
          t === TokenType.GREATER
            ? c > 0
            : t === TokenType.GREATER_EQUAL
              ? c >= 0
              : t === TokenType.LESS
                ? c < 0
                : c <= 0,
          taint,
        );
      }
      default:
        return { known: false, taint };
    }
  }
  if (e instanceof FunctionCall) return evalCall(e, resolve);
  return UNKNOWN;
}

function refChain(e: Expr, resolve: ContextResolver): { context: string; path: string[] } | undefined {
  if (e instanceof ContextAccess) return { context: e.name.lexeme.toLowerCase(), path: [] };
  if (e instanceof IndexAccess) {
    const base = refChain(e.expr, resolve);
    if (!base) return undefined;
    if (e.index instanceof Star) return undefined;
    if (e.index instanceof Literal) return { ...base, path: [...base.path, toStr(literalToJson(e.index))] };
    const idx = evaluate(e.index, resolve);
    if (idx.known && (typeof idx.value === 'string' || typeof idx.value === 'number')) {
      return { ...base, path: [...base.path, String(idx.value)] };
    }
    return undefined;
  }
  return undefined;
}

function indexInto(base: Json, idx: Json): Json {
  if (Array.isArray(base)) {
    const n = toNumber(idx);
    return Number.isInteger(n) && n >= 0 && n < base.length ? (base[n] ?? null) : null;
  }
  if (base && typeof base === 'object') {
    const key = toStr(idx).toLowerCase();
    const hit = Object.keys(base).find((k) => k.toLowerCase() === key);
    return hit === undefined ? null : (base[hit] ?? null);
  }
  return null;
}

function evalCall(e: FunctionCall, resolve: ContextResolver): EvalValue {
  const name = e.functionName.lexeme.toLowerCase();
  const args = e.args.map((a) => evaluate(a, resolve));
  const taint = mergeTaint(...args);
  const allKnown = args.every((a) => a.known);
  const vals = args.map((a) => (a.known ? a.value : null));
  if (['success', 'failure', 'cancelled', 'always', 'hashfiles'].includes(name))
    return { known: false, taint };
  if (!allKnown) return { known: false, taint };
  switch (name) {
    case 'format': {
      const fmt = toStr(vals[0] ?? null);
      const out = fmt.replace(/\{\{|\}\}|\{(\d+)\}/g, (m, d) => {
        if (m === '{{') return '{';
        if (m === '}}') return '}';
        return toStr(vals[Number(d) + 1] ?? null);
      });
      return known(out, taint);
    }
    case 'contains': {
      const [hay, needle] = [vals[0] ?? null, vals[1] ?? null];
      if (Array.isArray(hay))
        return known(
          hay.some((h) => looseEquals(h, needle)),
          [],
        );
      return known(toStr(hay).toUpperCase().includes(toStr(needle).toUpperCase()), []);
    }
    case 'startswith':
      return known(
        toStr(vals[0] ?? null)
          .toUpperCase()
          .startsWith(toStr(vals[1] ?? null).toUpperCase()),
        [],
      );
    case 'endswith':
      return known(
        toStr(vals[0] ?? null)
          .toUpperCase()
          .endsWith(toStr(vals[1] ?? null).toUpperCase()),
        [],
      );
    case 'join': {
      const arr = vals[0] ?? null;
      const sep = vals.length > 1 ? toStr(vals[1] ?? null) : ',';
      return known(Array.isArray(arr) ? arr.map(toStr).join(sep) : toStr(arr), taint);
    }
    case 'tojson':
      return known(JSON.stringify(vals[0] ?? null, null, 2), taint);
    case 'fromjson':
      try {
        return known(JSON.parse(toStr(vals[0] ?? null)) as Json, taint);
      } catch {
        return { known: false, taint };
      }
    default:
      return { known: false, taint };
  }
}

/**
 * How a condition uses the value of a context reference:
 * - `truthiness`: the value decides the condition as it is (`inputs.x`, `!inputs.x`, `inputs.x && …`);
 * - `compared`: it is compared with a constant or searched for one (`inputs.x == 'yes'`, `contains(inputs.x, 'a')`),
 *   which answers definitely for an empty value too;
 * - `fallback`: an empty value is replaced (`inputs.x || 'default'` inside a comparison or function argument);
 * - `value`: anything else (an argument of `fromJSON`, a comparison with another runtime value, …).
 */
export type ConditionUse = 'truthiness' | 'compared' | 'fallback' | 'value';

/** True when an expression reads no context and calls no runtime-only function, so its value is fixed. */
function isConstant(e: Expr): boolean {
  if (e instanceof Literal) return true;
  if (e instanceof Grouping) return isConstant(e.group);
  if (e instanceof Unary) return isConstant(e.expr);
  if (e instanceof Binary) return isConstant(e.left) && isConstant(e.right);
  if (e instanceof Logical) return e.args.every(isConstant);
  if (e instanceof FunctionCall) {
    const name = e.functionName.lexeme.toLowerCase();
    return (
      !['success', 'failure', 'cancelled', 'always', 'hashfiles'].includes(name) && e.args.every(isConstant)
    );
  }
  return false;
}

/** Functions that test a value against another: `contains(inputs.x, 'a')` answers definitely for an empty value. */
const TEST_FUNCTIONS = new Set(['contains', 'startswith', 'endswith']);
/** Functions whose result is their (converted) argument, so a comparison of the result compares the argument. */
const VALUE_FUNCTIONS = new Set(['format', 'join', 'tojson']);

/**
 * How the condition `expr` uses each context reference it reads, keyed by the reference's start offset (`ExprRef.start`).
 * `whole` is false for a condition with text around its `${{ }}` (a string, so every value is just interpolated).
 */
export function conditionUses(expr: ParsedExpression, whole = true): Map<number, ConditionUse> {
  const out = new Map<number, ConditionUse>();
  if (!expr.ast) return out;
  const source = expr.source;
  const visit = (e: Expr, use: ConditionUse): void => {
    if (e instanceof Grouping) {
      visit(e.group, use);
      return;
    }
    if (e instanceof ContextAccess || e instanceof IndexAccess) {
      let cur: Expr = e;
      while (cur instanceof IndexAccess) {
        if (!(cur.index instanceof Literal) && !(cur.index instanceof Star)) visit(cur.index, 'value');
        cur = cur.expr;
      }
      if (cur instanceof ContextAccess) {
        const t = cur.name as Tok;
        out.set(offsetOf(source, t.range.start.line, t.range.start.column), use);
      } else visit(cur, 'value');
      return;
    }
    if (e instanceof Unary) {
      visit(e.expr, 'truthiness');
      return;
    }
    if (e instanceof Logical) {
      const isAnd = e.operator.type === TokenType.AND;
      for (const [i, arg] of e.args.entries()) {
        const fallback = !isAnd && i < e.args.length - 1 && use !== 'truthiness';
        visit(arg, fallback ? 'fallback' : use);
      }
      return;
    }
    if (e instanceof Binary) {
      const [l, r] = [isConstant(e.left), isConstant(e.right)];
      visit(e.left, r ? 'compared' : 'value');
      visit(e.right, l ? 'compared' : 'value');
      return;
    }
    if (e instanceof FunctionCall) {
      const name = e.functionName.lexeme.toLowerCase();
      if (TEST_FUNCTIONS.has(name)) {
        for (const [i, arg] of e.args.entries()) {
          const other = e.args.some((a, j) => j !== i && isConstant(a));
          visit(arg, other ? 'compared' : 'value');
        }
        return;
      }
      const passes = VALUE_FUNCTIONS.has(name) && use === 'compared';
      for (const arg of e.args) visit(arg, passes ? 'compared' : 'value');
    }
  };
  visit(expr.ast, whole ? 'truthiness' : 'value');
  return out;
}

/**
 * The context references that are the subject of a fallback: a non-last operand of `a || b` (parentheses and nested
 * `||` included), so an empty value is replaced by the operands after it. Keyed by the reference's start offset
 * (`ExprRef.start`), with the whole `||` expression, whose value is what the read turns into. References that are not
 * such an operand (the last one, a comparison's, a function argument's) are absent.
 */
export function fallbacksOf(expr: ParsedExpression): Map<number, Expr> {
  const out = new Map<number, Expr>();
  if (!expr.ast) return out;
  const unwrap = (e: Expr): Expr => (e instanceof Grouping ? unwrap(e.group) : e);
  const isOr = (e: Expr): e is Logical => e instanceof Logical && e.operator.type === TokenType.OR;
  const operands = (e: Expr): Expr[] => {
    const u = unwrap(e);
    return isOr(u) ? u.args.flatMap(operands) : [u];
  };
  const refStart = (e: Expr): number | undefined => {
    let cur = e;
    while (cur instanceof IndexAccess) cur = cur.expr;
    if (!(cur instanceof ContextAccess)) return undefined;
    const t = cur.name as Tok;
    return offsetOf(expr.source, t.range.start.line, t.range.start.column);
  };
  const visit = (e: Expr): void => {
    const u = unwrap(e);
    if (isOr(u)) {
      const ops = operands(u);
      for (const [i, op] of ops.entries()) {
        const start = i < ops.length - 1 ? refStart(op) : undefined;
        if (start !== undefined) out.set(start, u);
        visit(op);
      }
    } else if (u instanceof IndexAccess) {
      visit(u.expr);
      if (!(u.index instanceof Literal) && !(u.index instanceof Star)) visit(u.index);
    } else if (u instanceof Unary) visit(u.expr);
    else if (u instanceof Binary) {
      visit(u.left);
      visit(u.right);
    } else if (u instanceof Logical || u instanceof FunctionCall) for (const arg of u.args) visit(arg);
  };
  visit(expr.ast);
  return out;
}

/**
 * True when a condition is falsy whatever the runtime-only parts evaluate to — e.g. `always() && matrix.k` in a
 * combination without `k`. Used to decide that a guarded step or job is skipped; values are never derived from it.
 */
export function definitelyFalsy(e: Expr, resolve: ContextResolver): boolean {
  if (e instanceof Grouping) return definitelyFalsy(e.group, resolve);
  if (e instanceof Logical) {
    return e.operator.type === TokenType.AND
      ? e.args.some((a) => definitelyFalsy(a, resolve))
      : e.args.every((a) => definitelyFalsy(a, resolve));
  }
  if (e instanceof Unary) return definitelyTruthy(e.expr, resolve);
  const v = evaluate(e, resolve);
  return v.known && !truthy(v.value);
}

export function definitelyTruthy(e: Expr, resolve: ContextResolver): boolean {
  if (e instanceof Grouping) return definitelyTruthy(e.group, resolve);
  if (e instanceof Logical) {
    return e.operator.type === TokenType.AND
      ? e.args.every((a) => definitelyTruthy(a, resolve))
      : e.args.some((a) => definitelyTruthy(a, resolve));
  }
  if (e instanceof Unary) return definitelyFalsy(e.expr, resolve);
  const v = evaluate(e, resolve);
  return v.known && truthy(v.value);
}

/**
 * Evaluates a whole YAML scalar that may mix literal text and `${{ }}` segments.
 * A scalar that is exactly one segment keeps the expression's type; otherwise the result is a string.
 */
export function evaluateTemplate(text: string, resolve: ContextResolver): EvalValue {
  const segments = findTemplateSegments(text);
  if (segments.length === 0) return known(text);
  const first = segments[0]!;
  if (segments.length === 1 && first.start === 0 && first.end === text.length) {
    return first.expr.ast ? evaluate(first.expr.ast, resolve) : UNKNOWN;
  }
  let out = '';
  let cursor = 0;
  const parts: EvalValue[] = [];
  for (const seg of segments) {
    out += text.slice(cursor, seg.start);
    const v = seg.expr.ast ? evaluate(seg.expr.ast, resolve) : UNKNOWN;
    parts.push(v);
    if (!v.known) return { known: false, taint: mergeTaint(...parts) };
    out += toStr(v.value);
    cursor = seg.end;
  }
  out += text.slice(cursor);
  return known(out, mergeTaint(...parts));
}
