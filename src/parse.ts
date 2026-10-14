import { posix } from 'node:path';
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  type Scalar,
  visit,
  type YAMLMap,
} from 'yaml';
import {
  type ExprRef,
  findTemplateSegments,
  type Json,
  type ParsedExpression,
  parseExpression,
  type TemplateSegment,
} from './expressions';
import type {
  ActionDecl,
  Binding,
  Diagnostic,
  ExprSegment,
  ExprSite,
  InputDecl,
  JobDecl,
  MatrixDecl,
  MatrixDim,
  MatrixEntry,
  OutputDecl,
  PermissionsDecl,
  SecretDecl,
  StepDecl,
  UsesRef,
  WorkflowDecl,
} from './ir';
import { type Loc, SourceFile } from './source';
import { trimChar } from './text';

export interface ParseContext {
  /** `owner/repo` of the analyzed repository, used to resolve same-repo `uses:` references. */
  repository?: string;
  nextSiteId: () => number;
}

export function createParseContext(repository?: string): ParseContext {
  let id = 0;
  return { ...(repository ? { repository } : {}), nextSiteId: () => ++id };
}

type YPath = (string | number)[];

interface Unit {
  source: SourceFile;
  sites: ExprSite[];
  siteByPath: Map<string, ExprSite>;
  parseErrors: Diagnostic[];
}

const pathKey = (p: YPath) => JSON.stringify(p);

function nodeLoc(source: SourceFile, node: Node | null | undefined): Loc {
  const r = node?.range;
  if (!r) return source.loc(0, 0);
  return source.loc(r[0], r[1]);
}

function pairs(node: unknown): Pair<Scalar, Node>[] {
  if (!isMap(node)) return [];
  return (node as YAMLMap<Scalar, Node>).items.filter((p) => isPair(p) && isScalar(p.key)) as Pair<
    Scalar,
    Node
  >[];
}

function get(node: unknown, key: string): Node | undefined {
  for (const p of pairs(node))
    if (String(p.key.value) === key) return (p.value ?? undefined) as Node | undefined;
  return undefined;
}

function getPair(node: unknown, key: string): Pair<Scalar, Node> | undefined {
  return pairs(node).find((p) => String(p.key.value) === key);
}

function str(node: unknown): string | undefined {
  if (isScalar(node) && node.value !== null && node.value !== undefined) return String(node.value);
  return undefined;
}

function toJs(node: unknown): Json {
  if (node === null || node === undefined) return null;
  if (isScalar(node) || isMap(node) || isSeq(node)) return (node as Node).toJSON() as Json;
  return null;
}

// ---------------------------------------------------------------------------
// Expression sites
// ---------------------------------------------------------------------------

function classify(
  kind: 'workflow' | 'action',
  p: YPath,
): Pick<ExprSite, 'field' | 'job' | 'step' | 'key'> & { cond: boolean } {
  if (kind === 'workflow') {
    if (p[0] === 'jobs' && typeof p[1] === 'string') {
      const job = p[1];
      if (p[2] === 'steps' && typeof p[3] === 'number') {
        const step = p[3];
        const f = p[4];
        if (f === 'if' && p.length === 5) return { field: 'step.if', job, step, cond: true };
        if (f === 'with' && typeof p[5] === 'string')
          return { field: 'step.with', job, step, key: p[5], cond: false };
        if (f === 'env' && typeof p[5] === 'string')
          return { field: 'step.env', job, step, key: p[5], cond: false };
        if (f === 'run') return { field: 'step.run', job, step, cond: false };
        return { field: 'step.other', job, step, cond: false };
      }
      const f = p[2];
      if (f === 'if' && p.length === 3) return { field: 'job.if', job, cond: true };
      if (f === 'name' && p.length === 3) return { field: 'job.name', job, cond: false };
      if (f === 'with' && typeof p[3] === 'string') return { field: 'job.with', job, key: p[3], cond: false };
      if (f === 'secrets' && typeof p[3] === 'string')
        return { field: 'job.secrets', job, key: p[3], cond: false };
      if (f === 'env' && typeof p[3] === 'string') return { field: 'job.env', job, key: p[3], cond: false };
      if (f === 'outputs' && typeof p[3] === 'string')
        return { field: 'job.output', job, key: p[3], cond: false };
      if (f === 'strategy') return { field: 'job.strategy', job, cond: false };
      return { field: 'job.other', job, cond: false };
    }
    if (p[0] === 'env' && typeof p[1] === 'string') return { field: 'workflow.env', key: p[1], cond: false };
    if (
      p[0] === 'on' &&
      p[1] === 'workflow_call' &&
      p[2] === 'outputs' &&
      typeof p[3] === 'string' &&
      p[4] === 'value'
    ) {
      return { field: 'workflow.output', key: p[3], cond: false };
    }
    if (p[0] === 'on' && p[2] === 'inputs' && p[4] === 'default' && typeof p[3] === 'string') {
      return { field: 'input.default', key: p[3], cond: false };
    }
    return { field: 'workflow.other', cond: false };
  }
  if (p[0] === 'runs' && p[1] === 'steps' && typeof p[2] === 'number') {
    const step = p[2];
    const f = p[3];
    if (f === 'if' && p.length === 4) return { field: 'step.if', step, cond: true };
    if (f === 'with' && typeof p[4] === 'string') return { field: 'step.with', step, key: p[4], cond: false };
    if (f === 'env' && typeof p[4] === 'string') return { field: 'step.env', step, key: p[4], cond: false };
    if (f === 'run') return { field: 'step.run', step, cond: false };
    return { field: 'step.other', step, cond: false };
  }
  if (p[0] === 'runs' && (p[1] === 'pre-if' || p[1] === 'post-if') && p.length === 2) {
    return { field: 'action.runs-if', cond: true };
  }
  if (p[0] === 'outputs' && typeof p[1] === 'string' && p[2] === 'value') {
    return { field: 'action.output', key: p[1], cond: false };
  }
  if (p[0] === 'inputs' && typeof p[1] === 'string' && p[2] === 'default') {
    return { field: 'input.default', key: p[1], cond: false };
  }
  return { field: 'other', cond: false };
}

function collectSites(
  unit: Unit,
  kind: 'workflow' | 'action',
  ownerPath: string,
  ctx: ParseContext,
  root: Node,
) {
  const visit = (node: unknown, p: YPath) => {
    if (isMap(node)) {
      for (const pair of pairs(node)) visit(pair.value, [...p, String(pair.key.value)]);
      return;
    }
    if (isSeq(node)) {
      for (const [i, item] of node.items.entries()) visit(item, [...p, i]);
      return;
    }
    if (!isScalar(node)) return;
    const c = classify(kind, p);
    const isString = typeof node.value === 'string';
    // A bare `if:` is an expression even without `${{ }}`; booleans like `if: false` are literals.
    if (!isString && !c.cond) return;
    const text = isString ? (node.value as string) : String(node.value);
    if (!c.cond && !text.includes('${{')) return;
    if (c.cond && !isString) return;
    const site = buildSite(unit, node as Scalar, text, c, p, ownerPath, ctx);
    unit.sites.push(site);
    unit.siteByPath.set(pathKey(p), site);
  };
  visit(root, []);
}

function buildSite(
  unit: Unit,
  node: Scalar,
  text: string,
  c: ReturnType<typeof classify>,
  p: YPath,
  ownerPath: string,
  ctx: ParseContext,
): ExprSite {
  const { source } = unit;
  const scalar = rawScalar(source, node);
  const templated = findTemplateSegments(text);
  const segments =
    c.cond && templated.length === 0 ? [conditionSegment(scalar, text)] : templateSegments(scalar, templated);

  return {
    id: ctx.nextSiteId(),
    file: source.path,
    ownerPath,
    field: c.field,
    ...(c.job !== undefined ? { job: c.job } : {}),
    ...(c.step !== undefined ? { step: c.step } : {}),
    ...(c.key !== undefined ? { key: c.key } : {}),
    yamlPath: p,
    text,
    loc: source.loc(scalar.start, scalar.start + scalar.raw.length),
    isCondition: c.cond,
    segments,
  };
}

/** A scalar as written, where the expressions of its decoded value are located. Offsets are relative to `raw`. */
interface RawScalar {
  source: SourceFile;
  /** The scalar's offset in the file. */
  start: number;
  /** The scalar's source text: its quotes, escapes, indentation and line breaks included. */
  raw: string;
  /** An expression's string quote as written: a single-quoted scalar doubles each `'`. */
  quote: string;
  /** Whether the source spells characters with `\` escapes, as a double-quoted scalar does. */
  escapes: boolean;
  /** Where the value starts: past the opening quote of a quoted scalar, or past the header line of a block scalar. */
  open: number;
  /** Where the value ends: at the closing quote of a quoted scalar. */
  close: number;
}

function rawScalar(source: SourceFile, node: Scalar): RawScalar {
  const [start, end] = node.range ?? [0, 0];
  const raw = source.text.slice(start, end);
  const quoted = node.type === 'QUOTE_SINGLE' || node.type === 'QUOTE_DOUBLE';
  return {
    source,
    start,
    raw,
    quote: node.type === 'QUOTE_SINGLE' ? "''" : "'",
    escapes: node.type === 'QUOTE_DOUBLE',
    open: valueStart(node.type, raw),
    close: quoted ? raw.length - 1 : raw.length,
  };
}

/**
 * Where a scalar's value starts in its source. A block scalar's range includes its header line (`|`, `>`, their
 * indicators and a comment), whose text is not in the value: a `'`, `${{` or copy of an expression there is skipped.
 * A block that ends the file on its header line has an empty value, which starts past the header.
 */
function valueStart(type: Scalar['type'], raw: string): number {
  if (type === 'QUOTE_SINGLE' || type === 'QUOTE_DOUBLE') return 1;
  if (type !== 'BLOCK_LITERAL' && type !== 'BLOCK_FOLDED') return 0;
  const headerEnd = raw.indexOf('\n');
  return headerEnd < 0 ? raw.length : headerEnd + 1;
}

/**
 * A bare `if:` is one expression: the whole value, from its first character that is not a space. A search for the
 * value's first characters could instead find a later line that repeats them.
 */
function conditionSegment(s: RawScalar, text: string): ExprSegment {
  return locateExpression(s, skipSpace(s, s.open), parseExpression(text.trim()), false).segment;
}

/**
 * Each `${{ }}` is found after the one before it ends, so a `${{` inside a string literal does not start one. It is
 * found as the value reads it, which finds each one the value holds: a double-quoted scalar may write it as escapes
 * (`\x24{{`) or across a `\` line break.
 */
function templateSegments(s: RawScalar, templated: TemplateSegment[]): ExprSegment[] {
  let searchFrom = s.open;
  return templated.map((seg) => {
    const located = locateExpression(s, skipSpace(s, pastWritten(s, '${{', searchFrom)), seg.expr, true);
    searchFrom = located.end;
    return located.segment;
  });
}

/**
 * Past the spaces and line breaks from `i`, which the decoded value trims. A double-quoted scalar may write them as
 * escapes: `\t`, `\x20`, `\ `, or a `\` that joins the next line.
 */
function skipSpace(s: RawScalar, i: number): number {
  let at = i;
  for (let n = spaceLength(s, at); n > 0; n = spaceLength(s, at)) at += n;
  return at;
}

/** The length of the space at `at`: a character, or an escape that stands for one; 0 for anything else. */
function spaceLength(s: RawScalar, at: number): number {
  if (/\s/.test(s.raw[at] ?? '')) return 1;
  const esc = s.escapes ? ESCAPE_AT_START.exec(s.raw.slice(at, at + 10)) : null;
  return esc && escapesSpace(esc) ? esc[0].length : 0;
}

/** A `\` escape of a double-quoted scalar that starts the text: its hex digits, or the one character after the `\`. */
const ESCAPE_AT_START = /^\\(?:x([\dA-Fa-f]{2})|u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8})|([\s\S]))/;

/** The one-character escapes that stand for a space or a line break, and the line break a `\` joins to the next line. */
const SPACE_ESCAPES = new Set(['t', '\t', 'n', 'v', 'f', 'r', ' ', '_', 'L', 'P', '\n', '\r']);

/** Whether an escape stands for a space or a line break, as the decoded value's `trim()` takes them. */
function escapesSpace(esc: RegExpExecArray): boolean {
  if (esc[4] !== undefined) return SPACE_ESCAPES.has(esc[4]);
  const code = escapedCode(esc);
  return code < 0x10000 && /\s/.test(String.fromCharCode(code));
}

/** The code point an escape's hex digits spell. */
const escapedCode = (esc: RegExpExecArray) => Number.parseInt(esc[1] ?? esc[2] ?? esc[3] ?? '0', 16);

/**
 * The character an escape spells as the value reads it: `\x2e` is a `.`, `\U0001002e` is not, and a one-character
 * escape (`\0`, `\"`) reads as a control character, which no delimiter or name is; YAML decodes no code past U+10FFFF.
 */
const escapedChar = (esc: RegExpExecArray) => String.fromCodePoint(Math.min(escapedCode(esc), 0x10ffff));

/** The character at `at` as the value reads it, and its length as written: an escape's in a double-quoted scalar. */
function charAt(s: RawScalar, at: number): [string, number] {
  const esc = s.escapes ? ESCAPE_AT_START.exec(s.raw.slice(at, at + 10)) : null;
  return esc ? [escapedChar(esc), esc[0].length] : [s.raw[at] ?? '', 1];
}

/**
 * The length of `text` written at `at` as the value reads it, or 0 when it is not there. A double-quoted scalar may
 * write its characters as escapes (`\x7d` for `}`) and join them across lines with a `\` line break, which the value
 * reads as nothing, with the next line's indentation.
 */
function writtenLength(s: RawScalar, at: number, text: string): number {
  let i = at;
  for (let n = 0; n < text.length; n++) {
    if (n > 0) i = pastJoins(s, i);
    const [char, length] = charAt(s, i);
    if (char !== text[n]) return 0;
    i += length;
  }
  return i - at;
}

/** Past the `\` line breaks at `at` in a double-quoted scalar, each with the next line's indentation. */
function pastJoins(s: RawScalar, at: number): number {
  let i = at;
  while (s.escapes && s.raw[i] === '\\' && /^\r?\n/.test(s.raw.slice(i + 1, i + 3))) {
    i = s.raw.indexOf('\n', i) + 1;
    while (s.raw[i] === ' ' || s.raw[i] === '\t') i++;
  }
  return i;
}

/** Past the first `text` written from `from` as `writtenLength` reads it, or at the end of the value without one. */
function pastWritten(s: RawScalar, text: string, from: number): number {
  let i = from;
  while (i < s.close && !writtenLength(s, i, text)) i += charAt(s, i)[1];
  return i + writtenLength(s, i, text);
}

/**
 * Locates the expression that starts at `from` in the raw scalar. Offsets in the decoded value drift from the source in
 * folded and literal blocks, quoted scalars with escapes and CRLF files, so each reference is found by its own text, in
 * the order they are written, within the expression and outside its string literals (a copy of the text there is not
 * the reference). A reference the source spells with an escape (`\x62` for `b` in a double-quoted scalar) keeps the
 * expression's own offsets. The expression ends where the source ends it, before its `}}` or the end of the value.
 */
function locateExpression(
  s: RawScalar,
  from: number,
  expr: ParsedExpression,
  closes: boolean,
): { segment: ExprSegment; end: number } {
  const scan = scanExpression(s, from, closes);
  const at = s.start + from;
  let cursor = from;
  const locs = new Map<ExprRef, Loc>();
  // A chain's computed indexes are listed from the right (`a[b][c]` lists `c` before `b`): searched in that order, the
  // search would start past the reference on the left.
  for (const r of expr.refs.toSorted((a, b) => a.start - b.start)) {
    // In a single-quoted scalar, a reference's own quotes (`github.event['action']`) are doubled too.
    const written = expr.source.slice(r.start, r.end).replaceAll("'", s.quote);
    const span = written ? spanOf(s, written, cursor, scan) : undefined;
    // A computed index can sit inside the reference before it (`github.event[inputs.x].y`): search on from its start.
    if (span) cursor = span[0] + 1;
    const [start, end] = span ? [s.start + span[0], s.start + span[1]] : [at + r.start, at + r.end];
    locs.set(r, s.source.loc(start, end));
  }
  const refs = expr.refs.map((r) => ({ ...r, loc: locs.get(r)! }));
  const end = s.start + expressionEnd(s, from, scan.end);
  return { segment: { expr, loc: s.source.loc(at, end), refs }, end: scan.end };
}

/**
 * Where the expression from `from` ends before `to`: past its last character that is not a space, as the decoded
 * value's `trim()` leaves it. An escape is one character: `\\t` is a `\` and a `t`, not a tab.
 */
function expressionEnd(s: RawScalar, from: number, to: number): number {
  let end = from;
  for (let i = from; i < to; ) {
    const space = spaceLength(s, i);
    i += space || charAt(s, i)[1];
    if (!space) end = i;
  }
  return end;
}

/**
 * Where a reference is written from `from`: as the expression reads it, or else word by word. A reference holds spaces
 * and line breaks only between its names or in a bracketed key (`github.event['a\nb']`), which the source may write
 * as a line break and indentation, a blank line or an escape. Its first word is then found as `indexOutside` finds it,
 * and each word after it past the spaces before it; where they do not follow, at the next copy of the first word. An
 * earlier copy can be another reference (`inputs.ab` before `inputs\n.ab`, as a chain's computed indexes are visited
 * from the right) or the start of one not found (`github.event['a\x63']`).
 */
function spanOf(
  s: RawScalar,
  written: string,
  from: number,
  scan: RawExpression,
): [number, number] | undefined {
  const found = indexOutside(s, written, from, scan);
  if (found >= 0) return [found, found + written.length];
  const [first = '', ...rest] = written.split(/\s+/);
  if (rest.length === 0) return undefined;
  let start = indexOutside(s, first, from, scan);
  while (start >= 0) {
    const end = wordsEnd(s, rest, start + first.length);
    if (end !== undefined && end <= scan.end) return [start, end];
    start = indexOutside(s, first, start + 1, scan);
  }
  return undefined;
}

/**
 * The end of `words` written from `from`, each after at least one space, line break or space escape: with none, the
 * words would join (`inputs['a b']` would match `inputs['ab']`).
 */
function wordsEnd(s: RawScalar, words: string[], from: number): number | undefined {
  let end = from;
  for (const word of words) {
    const at = skipSpace(s, end);
    if (at === end || !s.raw.startsWith(word, at)) return undefined;
    end = at + word.length;
  }
  return end;
}

/** An expression as written: where it ends, and the `[start, end)` of each string literal, quotes included. */
interface RawExpression {
  end: number;
  strings: [number, number][];
}

/**
 * Scans an expression the way `findTemplateSegments` scans the decoded value, reading each delimiter as `writtenLength`
 * does: the scalar's `quote` opens and closes a string, and a doubled one inside it is an escaped quote. With `closes`,
 * the expression ends at the first `}}` outside a string; otherwise (a bare `if:`), and without one, at the end of the
 * value.
 */
function scanExpression(s: RawScalar, from: number, closes: boolean): RawExpression {
  const strings: [number, number][] = [];
  let i = from;
  while (i < s.close) {
    const quote = writtenLength(s, i, s.quote);
    if (quote) {
      const end = stringEnd(s, i + quote);
      strings.push([i, end]);
      i = end;
    } else if (closes && writtenLength(s, i, '}}')) {
      return { end: i, strings };
    } else {
      i += charAt(s, i)[1];
    }
  }
  return { end: s.close, strings };
}

/** Past the quote that closes the string whose text starts at `from`, or the end of the value when none does. */
function stringEnd(s: RawScalar, from: number): number {
  let i = from;
  while (i < s.close) {
    const doubled = writtenLength(s, i, s.quote.repeat(2));
    const quote = doubled ? 0 : writtenLength(s, i, s.quote);
    if (quote) return i + quote;
    i += doubled || charAt(s, i)[1];
  }
  return s.close;
}

/**
 * The first copy of `text` from `from` that ends within the expression, does not start inside one of its strings and
 * does not continue a name or property chain: in `fromJSON(env.X).inputs.a` and `fromJSON(env.X). inputs.a`,
 * `inputs.a` is a property, not a reference.
 */
function indexOutside(s: RawScalar, text: string, from: number, scan: RawExpression): number {
  let at = s.raw.indexOf(text, from);
  while (at >= 0 && at + text.length <= scan.end) {
    const inString = scan.strings.find(([start, end]) => at >= start && at < end);
    if (!inString && !continuesName(s, at)) return at;
    at = s.raw.indexOf(text, inString ? inString[1] : at + 1);
  }
  return -1;
}

const NAME_CHAR = /[\w.-]/;

/**
 * A `\` escape of a double-quoted scalar that ends the text, its backslash not itself escaped: its hex digits, or the one
 * character after the `\` (a space or a line break too), in the groups of `ESCAPE_AT_START`.
 */
const ESCAPE_AT_END =
  /(?:^|[^\\])(?:\\\\)*\\(?:x([\dA-Fa-f]{2})|u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8})|([0abtnvfreN_LP \t\n\r]))$/;

/**
 * Whether the text at `at` continues a name or property chain: the character before it is `.`, a word character or `-`,
 * or it is a `.` before spaces and line breaks (`fromJSON(env.X). inputs.a`, or a `.` that ends a line). A
 * double-quoted scalar may write those characters as escapes, and join the lines with a `\`.
 */
function continuesName(s: RawScalar, at: number): boolean {
  const start = spaceStart(s, at);
  const before = charBefore(s, start);
  return start < at ? before === '.' : NAME_CHAR.test(before);
}

/** Where the spaces and line breaks before `at` start, within the value: a block scalar's header line is not in it. */
function spaceStart(s: RawScalar, at: number): number {
  let i = at;
  for (let n = spaceLengthBefore(s, i); n > 0 && i - n >= s.open; n = spaceLengthBefore(s, i)) i -= n;
  return i;
}

/** The length of the space that ends at `at`: a character, or an escape that stands for one; 0 for anything else. */
function spaceLengthBefore(s: RawScalar, at: number): number {
  const esc = escapeBefore(s, at);
  // None of the characters after an escape's `\` is a `\`.
  if (esc) return escapesSpace(esc) ? esc[0].length - esc[0].lastIndexOf('\\') : 0;
  return /\s/.test(s.raw[at - 1] ?? '') ? 1 : 0;
}

/** The character before `at` as the value reads it: a double-quoted scalar may write it as an escape. */
function charBefore(s: RawScalar, at: number): string {
  const esc = escapeBefore(s, at);
  return esc ? escapedChar(esc) : (s.raw[at - 1] ?? '');
}

/** The escape that ends at `at`, in a double-quoted scalar. */
function escapeBefore(s: RawScalar, at: number): RegExpExecArray | null {
  return s.escapes ? ESCAPE_AT_END.exec(s.raw.slice(Math.max(0, at - 16), at)) : null;
}

// ---------------------------------------------------------------------------
// Structured extraction
// ---------------------------------------------------------------------------

function bindings(unit: Unit, node: unknown, base: YPath): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const site = unit.siteByPath.get(pathKey([...base, name]));
    out[name] = {
      name,
      loc: nodeLoc(unit.source, pair.key),
      valueLoc: nodeLoc(unit.source, (pair.value as Node) ?? pair.key),
      value: toJs(pair.value),
      ...(site ? { site } : {}),
    };
  }
  return out;
}

function inputDecls(unit: Unit, node: unknown, base: YPath): Record<string, InputDecl> {
  const out: Record<string, InputDecl> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const def = pair.value;
    const type = str(get(def, 'type'));
    const description = str(get(def, 'description'));
    const opts = get(def, 'options');
    out[name] = {
      name,
      ...(type ? { type } : {}),
      required: toJs(get(def, 'required')) === true,
      ...defaultOf(unit, getPair(def, 'default'), [...base, name, 'default']),
      ...(description ? { description } : {}),
      ...(isSeq(opts) ? { options: (toJs(opts) as Json[]).map(String) } : {}),
      loc: nodeLoc(unit.source, pair.key),
    };
  }
  return out;
}

/** An input's `default:` (at `path`): its value, where it is written, and its expression when it is one. */
function defaultOf(
  unit: Unit,
  pair: Pair<Scalar, Node> | undefined,
  path: YPath,
): Pick<InputDecl, 'hasDefault' | 'default' | 'defaultLoc' | 'defaultSite'> {
  if (!pair) return { hasDefault: false };
  const site = unit.siteByPath.get(pathKey(path));
  return {
    hasDefault: toJs(pair.value) !== null,
    default: toJs(pair.value),
    defaultLoc: nodeLoc(unit.source, pair.value ?? pair.key),
    ...(site ? { defaultSite: site } : {}),
  };
}

function secretDecls(unit: Unit, node: unknown): Record<string, SecretDecl> {
  const out: Record<string, SecretDecl> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const description = str(get(pair.value, 'description'));
    out[name] = {
      name,
      required: toJs(get(pair.value, 'required')) === true,
      ...(description ? { description } : {}),
      loc: nodeLoc(unit.source, pair.key),
    };
  }
  return out;
}

function outputDecls(unit: Unit, node: unknown, base: YPath, valueKey: boolean): Record<string, OutputDecl> {
  const out: Record<string, OutputDecl> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const valueNode = valueKey ? get(pair.value, 'value') : pair.value;
    const site = unit.siteByPath.get(pathKey(valueKey ? [...base, name, 'value'] : [...base, name]));
    const description = valueKey ? str(get(pair.value, 'description')) : undefined;
    out[name] = {
      name,
      loc: nodeLoc(unit.source, pair.key),
      ...(description ? { description } : {}),
      ...(valueNode !== undefined ? { value: toJs(valueNode) } : {}),
      ...(site ? { site } : {}),
    };
  }
  return out;
}

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** `a/./b/` → `a/b`, `` → `.`. Anything escaping the root (`../x`) keeps its `..` and is never read. */
export function normalizeRelative(path: string): string {
  return trimChar(posix.normalize(trimChar(path, '/') || '.'), '/') || '.';
}

export function classifyUses(raw: string, at: 'job' | 'step', loc: Loc, ctx: ParseContext): UsesRef {
  const value = raw.trim();
  if (value.startsWith('docker://')) return { raw, loc, kind: 'docker' };
  const kind = at === 'job' ? 'local-workflow' : 'local-action';
  if (value.startsWith('$/')) {
    // `$/path` is this repository at the running commit, wherever the workspace is. GitHub rejects an `@ref` suffix.
    const refAt = value.indexOf('@');
    const target = normalizeRelative(refAt < 0 ? value.slice(2) : value.slice(2, refAt));
    return { raw, loc, kind, target, self: true, ...(refAt < 0 ? {} : { selfRef: value.slice(refAt + 1) }) };
  }
  if (value.startsWith('./')) {
    // `./` alone is an action in the repository root. A job's `./` is relative to the repository; a step's to the
    // runner's workspace, which the loader maps through the job's checkouts (`target` assumes the repository root).
    const target = normalizeRelative(value.slice(2));
    if (at === 'job') return { raw, loc, kind, target };
    return { raw, loc, kind, target, workspacePath: target };
  }
  const [path = '', ref] = value.split('@');
  const parts = path.split('/');
  const repo = parts.slice(0, 2).join('/');
  const rest = parts.slice(2).join('/');
  if (ctx.repository && repo.toLowerCase() === ctx.repository.toLowerCase()) {
    if (at === 'job' && WORKFLOW_FILE.test(rest)) {
      return { raw, loc, kind: 'local-workflow', target: rest, ...(ref ? { sameRepoRef: ref } : {}) };
    }
    if (at === 'step') {
      return { raw, loc, kind: 'local-action', target: rest || '.', ...(ref ? { sameRepoRef: ref } : {}) };
    }
  }
  return { raw, loc, kind: at === 'job' ? 'remote-workflow' : 'remote-action' };
}

/**
 * Heuristically finds names written to `$GITHUB_OUTPUT` / `$GITHUB_ENV` by an inline script.
 * `dynamic` means the script writes something we cannot name (e.g. `cat file >> $GITHUB_OUTPUT`).
 */
export function scanRunWrites(script: string, fileVar: 'GITHUB_OUTPUT' | 'GITHUB_ENV') {
  const names = new Set<string>();
  let dynamic = false;
  let mentions = false;
  // A redirect (or tee) into the file: `>> "$GITHUB_OUTPUT"`, `>> ${GITHUB_OUTPUT}`, `| tee -a $env:GITHUB_OUTPUT`.
  const redirect = new RegExp(`(?:>>|\\|\\s*tee(?:\\s+-a)?)\\s*["']?\\$(?:env:)?\\{?${fileVar}\\}?["']?`);
  // `OUT=$GITHUB_OUTPUT` (then `>> "$OUT"`): the writes go through an alias we do not follow.
  const alias = new RegExp(
    `(?:^|[\\s;&|(])(?:export\\s+|local\\s+|declare\\s+(?:-\\w+\\s+)*)?[A-Za-z_]\\w*=["']?\\$\\{?${fileVar}\\b`,
  );
  for (const line of script.split(/\r?\n/)) {
    if (!line.includes(fileVar)) continue;
    mentions = true;
    if (alias.test(line)) {
      dynamic = true;
      continue;
    }
    // A line may hold several writes (`a >> $F; b >> $F`, if/else one-liners): scan the text before each redirect.
    const chunks = line.split(redirect);
    const written = chunks.length > 1 ? chunks.slice(0, -1) : [line];
    for (const chunk of written) {
      const found = [...chunk.matchAll(/(?:^|[\s"'`(;])([A-Za-z_][\w-]*)(?:=|<<)/g)].map((m) => m[1]!);
      // `cat out.txt >> $GITHUB_OUTPUT`, `} >> $GITHUB_OUTPUT` (grouped writes) or `echo "$name=..."`.
      if (found.length === 0 || /\$\{?\w+\}?(?:=|<<)/.test(chunk)) dynamic = true;
      for (const n of found) if (n !== fileVar) names.add(n);
    }
  }
  // `core.setOutput('name', ...)` / `core.exportVariable('NAME', ...)` in node scripts.
  const api = fileVar === 'GITHUB_OUTPUT' ? 'setOutput' : 'exportVariable';
  for (const m of script.matchAll(new RegExp(`\\b${api}\\(`, 'g'))) {
    mentions = true;
    // Only a complete string literal (no interpolation, no concatenation) names the output; anything else is dynamic.
    const literal = /^\s*(?:(['"])([^'"\\\n]+)\1|`([^`$\\]+)`)\s*,/.exec(script.slice(m.index + m[0].length));
    const name = literal?.[2] ?? literal?.[3];
    if (name) names.add(name);
    else dynamic = true;
  }
  return { names: [...names], dynamic, mentions };
}

function steps(
  unit: Unit,
  node: unknown,
  base: YPath,
  at: 'workflow' | 'action',
  ctx: ParseContext,
): StepDecl[] {
  if (!isSeq(node)) return [];
  return node.items.map((item, index) => {
    const p = [...base, index];
    const id = str(get(item, 'id'));
    const idPair = getPair(item, 'id');
    const usesNode = get(item, 'uses');
    const runNode = get(item, 'run');
    const run = str(runNode);
    const name = str(get(item, 'name'));
    const usesRaw = str(usesNode);
    const ifSite = unit.siteByPath.get(pathKey([...p, 'if']));
    const ifNode = get(item, 'if');
    const ifValue = isScalar(ifNode) && typeof ifNode.value === 'boolean' ? ifNode.value : undefined;
    void at;
    return {
      index,
      ...(id ? { id, idLoc: nodeLoc(unit.source, idPair?.key) } : {}),
      ...(name ? { name } : {}),
      loc: nodeLoc(unit.source, item as Node),
      ...(usesRaw ? { uses: classifyUses(usesRaw, 'step', nodeLoc(unit.source, usesNode), ctx) } : {}),
      ...(run !== undefined ? { run, runLoc: nodeLoc(unit.source, runNode) } : {}),
      with: bindings(unit, get(item, 'with'), [...p, 'with']),
      env: bindings(unit, get(item, 'env'), [...p, 'env']),
      ...(ifValue !== undefined ? { ifValue } : {}),
      ...(ifSite ? { ifSite } : {}),
      writesOutputs:
        run !== undefined ? scanRunWrites(run, 'GITHUB_OUTPUT') : scriptWrites(item, 'GITHUB_OUTPUT'),
      writesEnv: (() => {
        const s = run !== undefined ? scanRunWrites(run, 'GITHUB_ENV') : scriptWrites(item, 'GITHUB_ENV');
        return { names: s.names, dynamic: s.dynamic };
      })(),
    } satisfies StepDecl;
  });
}

/** `actions/github-script` and similar take an inline script in `with.script`. */
function scriptWrites(item: unknown, fileVar: 'GITHUB_OUTPUT' | 'GITHUB_ENV') {
  const script = str(get(get(item, 'with'), 'script'));
  if (!script) return { names: [], dynamic: false, mentions: false };
  const scanned = scanRunWrites(script, fileVar);
  const githubScript = /(^|\/)github-script@/.test(str(get(item, 'uses')) ?? '');
  // Any other action that takes a script may set outputs of its own; github-script's are what its script sets.
  const dynamic =
    scanned.dynamic || scriptDelegates(script) || (fileVar === 'GITHUB_OUTPUT' && !githubScript);
  // actions/github-script always publishes the script's return value as the `result` output.
  if (fileVar === 'GITHUB_OUTPUT' && githubScript) {
    return { names: [...new Set([...scanned.names, 'result'])], dynamic, mentions: true };
  }
  return { ...scanned, dynamic };
}

/**
 * Node built-in modules that cannot run other code, so loading them does not hand the script's writes elsewhere.
 * `child_process`, `vm`, `worker_threads` and `module` can, and still count as delegation.
 */
const INERT_BUILTIN =
  /(?<![\w$.])(?:require|import)\s*\(\s*(['"])(?:node:)?(?:assert|buffer|crypto|dns|events|fs|http|https|net|os|path|querystring|readline|stream|string_decoder|timers|tls|url|util|zlib)(?:\/[\w/]*)?\1\s*\)/g;

/**
 * True when a script's writes cannot be seen in its text: it hands its toolkit to code outside the script, which may
 * then set any output or variable — it loads a module (`require(...)`, `import(...)`; Node built-ins such as `fs` or
 * `path` aside), evaluates code, runs a program (`exec.exec(...)`, which inherits `GITHUB_OUTPUT`), or passes `core`
 * on (`run({ core })`, `setupGlobals(core, github)`, `const c = core`) instead of only calling `core.<method>(...)`
 * itself — or a `${{ }}` expression puts code into it.
 */
function scriptDelegates(script: string): boolean {
  const code = codeOf(script.replace(INERT_BUILTIN, 'null'));
  // An expression outside a literal is substituted into the code before the script runs (`script: ${{ inputs.code }}`).
  if (code.includes('${{')) return true;
  if (
    /(?<![\w$.])(?:require|__original_require__|import|eval)\s*\(|^\s*import\s|\bnew\s+Function\b|(?<![\w$.])arguments\b(?!\s*:)|(?<![\w$.])exec\s*\.\s*(?:exec|getExecOutput)\s*\(/m.test(
      code,
    )
  )
    return true;
  // `core` used as a value rather than as the receiver of a method call.
  return /(?<![\w$.])core(?![\w$])(?!\s*\??\.\s*[A-Za-z_$])/.test(code);
}

/**
 * The code of a JavaScript source, so a word in prose is not mistaken for code: comments and the text of string and
 * template literals are dropped, but the code in a template's `${...}` is kept. A `${{ }}` expression inside a literal
 * is text as well; one in code position stays. A linear scan, since regexes for comments backtrack.
 */
function codeOf(src: string): string {
  let i = 0;
  /** Code up to the end of the source, or within a template substitution up to the `}` that closes it. */
  const code = (substitution: boolean): string => {
    let out = '';
    let depth = 0;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? src.length : nl;
      } else if (ch === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end < 0 ? src.length : end + 2;
        out += ' ';
      } else if (ch === "'" || ch === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
        out += '""';
        i = j + 1;
      } else if (ch === '`') {
        i++;
        out += `""${template()}""`;
      } else {
        if (ch === '{') depth++;
        else if (ch === '}' && depth-- === 0 && substitution) {
          i++;
          return out;
        }
        out += ch;
        i++;
      }
    }
    return out;
  };
  /** The code in the substitutions of a template literal, from after its opening backtick to past the closing one. */
  const template = (): string => {
    let out = '';
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '\\') {
        i += 2;
      } else if (ch === '`') {
        i++;
        return out;
      } else if (ch === '$' && src[i + 1] === '{' && src[i + 2] === '{') {
        // A GitHub expression: its value becomes part of the text before the script runs.
        const end = src.indexOf('}}', i + 3);
        i = end < 0 ? src.length : end + 2;
      } else if (ch === '$' && src[i + 1] === '{') {
        i += 2;
        out += ` ${code(true)} `;
      } else {
        i++;
      }
    }
    return out;
  };
  return code(false);
}

function matrixEntries(unit: Unit, node: unknown, base: YPath): MatrixEntry[] {
  if (!isSeq(node)) return [];
  return node.items.map((item, i) => {
    const values: Record<string, Json> = {};
    const keyLocs: Record<string, Loc> = {};
    const dynamicKeys: string[] = [];
    for (const pair of pairs(item)) {
      const k = String(pair.key.value);
      values[k] = toJs(pair.value);
      keyLocs[k] = nodeLoc(unit.source, pair.key);
      if (unit.siteByPath.has(pathKey([...base, i, k]))) dynamicKeys.push(k);
    }
    return { loc: nodeLoc(unit.source, item as Node), values, keyLocs, dynamicKeys };
  });
}

function matrix(unit: Unit, strategy: unknown, base: YPath): MatrixDecl | undefined {
  const pair = getPair(strategy, 'matrix');
  if (!pair) return undefined;
  const loc = nodeLoc(unit.source, pair.key);
  const mp = [...base, 'matrix'];
  if (isScalar(pair.value)) return dynamicMatrix(unit, loc, mp);
  const dims: MatrixDim[] = [];
  let include = NO_FILTER;
  let exclude = NO_FILTER;
  for (const p of pairs(pair.value)) {
    const k = String(p.key.value);
    if (k === 'include') include = matrixFilter(unit, p.value, [...mp, k]);
    else if (k === 'exclude') exclude = matrixFilter(unit, p.value, [...mp, k]);
    else dims.push(matrixDim(unit, p, [...mp, k]));
  }
  return {
    loc,
    dynamic: false,
    dims,
    include: include.entries,
    exclude: exclude.entries,
    includeDynamic: include.dynamic,
    excludeDynamic: exclude.dynamic,
  };
}

/** A matrix that is one expression as a whole (`matrix: ${{ fromJSON(...) }}`): everything is known only at runtime. */
function dynamicMatrix(unit: Unit, loc: Loc, path: YPath): MatrixDecl {
  const site = unit.siteByPath.get(pathKey(path));
  return {
    loc,
    dynamic: true,
    ...(site ? { dynamicSite: site } : {}),
    dims: [],
    include: [],
    exclude: [],
    includeDynamic: true,
    excludeDynamic: true,
  };
}

const NO_FILTER = { entries: [] as MatrixEntry[], dynamic: false };

/**
 * A matrix's `include` or `exclude`: its entries, and `dynamic` when part of it is known only at runtime: the list is
 * an expression, or one of its items is (`- ${{ fromJSON(inputs.extra) }}`, which evaluates to an entry of any keys).
 * Such an item is not an entry here: as one with no keys, it would match every combination, and an `exclude` would
 * remove them all.
 */
function matrixFilter(unit: Unit, node: unknown, path: YPath): { entries: MatrixEntry[]; dynamic: boolean } {
  if (isScalar(node)) return { entries: [], dynamic: true };
  const items = isSeq(node) ? node.items : [];
  const expression = (i: number) => unit.siteByPath.has(pathKey([...path, i]));
  return {
    entries: matrixEntries(unit, node, path).filter((_, i) => !expression(i)),
    dynamic: items.some((_, i) => expression(i)),
  };
}

/** One dimension of a matrix: its values, with the indexes of those that are expressions, or `null` for one. */
function matrixDim(unit: Unit, p: Pair<Scalar, Node>, path: YPath): MatrixDim {
  const name = String(p.key.value);
  const loc = nodeLoc(unit.source, p.key);
  if (!isSeq(p.value)) return { name, loc, values: null, unknownIndexes: [] };
  const expression = (i: number) => unit.siteByPath.has(pathKey([...path, i]));
  return {
    name,
    loc,
    values: toJs(p.value) as Json[],
    unknownIndexes: p.value.items.map((_, i) => i).filter(expression),
  };
}

function jobs(unit: Unit, node: unknown, ctx: ParseContext): Record<string, JobDecl> {
  const out: Record<string, JobDecl> = {};
  for (const pair of pairs(node)) {
    const id = String(pair.key.value);
    const j = pair.value;
    const p: YPath = ['jobs', id];
    const needsNode = get(j, 'needs');
    const needs: JobDecl['needs'] = [];
    if (isScalar(needsNode) && needsNode.value != null) {
      needs.push({ id: String(needsNode.value), loc: nodeLoc(unit.source, needsNode) });
    } else if (isSeq(needsNode)) {
      for (const n of needsNode.items) {
        if (isScalar(n)) needs.push({ id: String(n.value), loc: nodeLoc(unit.source, n) });
      }
    }
    const usesNode = get(j, 'uses');
    const usesRaw = str(usesNode);
    const secretsPair = getPair(j, 'secrets');
    const secretsInherit = isScalar(secretsPair?.value) && String(secretsPair.value.value) === 'inherit';
    const ifSite = unit.siteByPath.get(pathKey([...p, 'if']));
    const name = str(get(j, 'name'));
    const nameSite = unit.siteByPath.get(pathKey([...p, 'name']));
    const namePair = getPair(j, 'name');
    const perms = permissions(get(j, 'permissions'));
    const ifNode = get(j, 'if');
    const ifValue = isScalar(ifNode) && typeof ifNode.value === 'boolean' ? ifNode.value : undefined;
    const strategy = get(j, 'strategy');
    const m = matrix(unit, strategy, [...p, 'strategy']);
    out[id] = {
      id,
      loc: nodeLoc(unit.source, pair.key),
      ...(name !== undefined ? { name } : {}),
      ...(nameSite ? { nameSite } : {}),
      ...(namePair?.value ? { nameLoc: nodeLoc(unit.source, namePair.value as Node) } : {}),
      ...(perms ? { permissions: perms } : {}),
      ...(ifValue !== undefined ? { ifValue } : {}),
      needs,
      ...(ifSite ? { ifSite } : {}),
      ...(usesRaw ? { uses: classifyUses(usesRaw, 'job', nodeLoc(unit.source, usesNode), ctx) } : {}),
      with: bindings(unit, get(j, 'with'), [...p, 'with']),
      secrets: secretsInherit ? {} : bindings(unit, secretsPair?.value, [...p, 'secrets']),
      secretsInherit,
      ...(secretsPair ? { secretsLoc: nodeLoc(unit.source, secretsPair.key) } : {}),
      env: bindings(unit, get(j, 'env'), [...p, 'env']),
      outputs: outputDecls(unit, get(j, 'outputs'), [...p, 'outputs'], false),
      ...(m ? { matrix: m } : {}),
      steps: steps(unit, get(j, 'steps'), [...p, 'steps'], 'workflow', ctx),
    };
  }
  return out;
}

/** `permissions:` as written: `read-all` / `write-all`, or a map of scopes (unknown values are skipped). */
function permissions(node: unknown): PermissionsDecl | undefined {
  if (isScalar(node)) {
    const v = String(node.value);
    return v === 'read-all' || v === 'write-all' ? v : undefined;
  }
  if (!isMap(node)) return undefined;
  const out: Record<string, 'read' | 'write' | 'none'> = {};
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    const value = isScalar(pair.value) ? String(pair.value.value) : undefined;
    if (key && (value === 'read' || value === 'write' || value === 'none')) out[key] = value;
  }
  return out;
}

/** Upper bound on the nodes alias expansion may produce; real workflows stay far below it. */
const MAX_ALIAS_EXPANSION = 50_000;

/**
 * Counts the nodes alias resolution would produce, memoized per node (linear in the document). Returns the alias at
 * which the budget is exceeded, if any, so `a: &a [*b, *b]` chains cannot blow up memory and time.
 */
function aliasExpansionTooLarge(doc: ReturnType<typeof parseDocument>): Node | undefined {
  const memo = new Map<unknown, number>();
  let culprit: Node | undefined;
  const size = (node: unknown): number => {
    if (node === null || node === undefined) return 1;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    memo.set(node, 1); // guards against self-referencing aliases while counting
    let n = 1;
    if (isAlias(node)) {
      n = size(node.resolve(doc));
      if (n > MAX_ALIAS_EXPANSION && !culprit) culprit = node as unknown as Node;
    } else if (isMap(node)) {
      for (const p of node.items) n += size((p as Pair).key) + size((p as Pair).value);
    } else if (isSeq(node)) {
      for (const item of node.items) n += size(item);
    }
    n = Math.min(n, MAX_ALIAS_EXPANSION + 1);
    memo.set(node, n);
    return n;
  };
  return size(doc.contents) > MAX_ALIAS_EXPANSION ? (culprit ?? (doc.contents as Node)) : undefined;
}

function load(path: string, text: string): { unit: Unit; root: Node | undefined } {
  const source = new SourceFile(path, text);
  const doc = parseDocument(text, { lineCounter: source.lineCounter, prettyErrors: false, strict: false });
  // GitHub supports anchors and aliases: replace every alias with the node it points to, so the IR sees the same
  // structure GitHub does. Locations then point at the anchored definition.
  const aliasBomb = doc.errors.length === 0 ? aliasExpansionTooLarge(doc) : undefined;
  if (doc.errors.length === 0 && !aliasBomb) {
    visit(doc, {
      Alias(_, alias) {
        const target = alias.resolve(doc);
        return target ? (target as Node) : undefined;
      },
    });
  }
  const parseErrors: Diagnostic[] = doc.errors.map((e) => ({
    message: e.message.split('\n')[0]!,
    loc: source.loc(e.pos[0], e.pos[1]),
  }));
  if (aliasBomb) {
    parseErrors.push({
      message: `YAML aliases expand to more than ${MAX_ALIAS_EXPANSION} nodes; the file is not analyzed (possible alias bomb)`,
      loc: source.loc(aliasBomb.range?.[0] ?? 0, aliasBomb.range?.[1] ?? 0),
    });
  }
  return {
    unit: { source, sites: [], siteByPath: new Map(), parseErrors },
    root: (doc.contents ?? undefined) as Node | undefined,
  };
}

const AUTO = '(?:auto(?:matically)?[- ]?)?';

/**
 * Comment text, without its `#`, that marks a generated file. Each pattern is a generator's own phrasing, so a header
 * that only talks about generated things (`Generated docs are published by this workflow`, `Builds the autogenerated
 * client`, `Please do not edit the deploy keys`) does not count.
 */
const GENERATED_HEADER = [
  // Capitals, as generators write it (`DO NOT EDIT.`, `DO NOT EDIT MANUALLY`), unless a lowercase sentence follows.
  /\bDO NOT (?:EDIT|MODIFY)\b(?!\s+[a-z])/,
  /\bdo not (?:edit|modify) (?:this (?:file|workflow)|manually|by hand|directly)\b/i,
  /@generated\b/,
  new RegExp(`\\b(?:this|the) (?:file|workflow) (?:is|was|has been|will be) ${AUTO}generated\\b`, 'i'),
  new RegExp(`\\bthis is an? ${AUTO}generated (?:file|workflow)\\b`, 'i'),
  // Only at the start of the comment: `Generated by praktika`, `Code generated from x.j2`, `AUTOGENERATED FILE`.
  new RegExp(`^(?:(?:code|file|workflow) )?${AUTO}generated (?:(?:by|from|with|using) \\S+|file\\b)`, 'i'),
];
const GENERATED_HEADER_LINES = 10;

/**
 * Why a workflow or action file counts as generated, if it does: a marker in the comment block that opens the file
 * (within its first lines), or the `.lock.yml` suffix of GitHub Agentic Workflows. Comments further down, like
 * `# run.sh is generated by …`, do not count. The embedding tool may let its own settings overrule this.
 */
export function generatedMarker(path: string, text: string): string | undefined {
  for (const line of text.split('\n', GENERATED_HEADER_LINES)) {
    const t = line.trim();
    // Blank lines, the document start and directives (`%YAML 1.2`) may come before the header.
    if (t === '' || t === '---' || t.startsWith('%')) continue;
    if (!t.startsWith('#')) break;
    const comment = t.replace(/^#+\s*/, '');
    let first: RegExpExecArray | undefined;
    for (const re of GENERATED_HEADER) {
      const m = re.exec(comment);
      if (m && (!first || m.index < first.index)) first = m;
    }
    if (first) return first[0];
  }
  return /\.lock\.ya?ml$/i.test(path) ? '.lock.yml' : undefined;
}

export function parseWorkflowFile(path: string, text: string, ctx: ParseContext): WorkflowDecl {
  const { unit, root } = load(path, text);
  const generated = generatedMarker(path, text);
  if (root) collectSites(unit, 'workflow', path, ctx, root);
  const on = get(root, 'on');
  const triggers: string[] = [];
  if (isScalar(on) && on.value != null) {
    triggers.push(String(on.value));
  } else if (isSeq(on)) {
    for (const t of on.items) if (isScalar(t)) triggers.push(String(t.value));
  } else {
    for (const p of pairs(on)) triggers.push(String(p.key.value));
  }

  const callPair = getPair(on, 'workflow_call');
  const dispatchPair = getPair(on, 'workflow_dispatch');
  const call = triggers.includes('workflow_call')
    ? {
        loc: nodeLoc(unit.source, callPair?.key ?? (on as Node)),
        inputs: inputDecls(unit, get(callPair?.value, 'inputs'), ['on', 'workflow_call', 'inputs']),
        secrets: secretDecls(unit, get(callPair?.value, 'secrets')),
        outputs: outputDecls(unit, get(callPair?.value, 'outputs'), ['on', 'workflow_call', 'outputs'], true),
      }
    : undefined;
  const dispatch = triggers.includes('workflow_dispatch')
    ? {
        loc: nodeLoc(unit.source, dispatchPair?.key ?? (on as Node)),
        inputs: inputDecls(unit, get(dispatchPair?.value, 'inputs'), ['on', 'workflow_dispatch', 'inputs']),
      }
    : undefined;
  const name = str(get(root, 'name'));
  const workflowPermissions = permissions(get(root, 'permissions'));
  return {
    kind: 'workflow',
    path,
    file: path,
    ...(name ? { name } : {}),
    source: unit.source,
    sites: unit.sites,
    parseErrors: unit.parseErrors,
    schemaErrors: [],
    ...(generated ? { generated } : {}),
    triggers,
    ...(call ? { call } : {}),
    ...(dispatch ? { dispatch } : {}),
    env: bindings(unit, get(root, 'env'), ['env']),
    ...(workflowPermissions ? { permissions: workflowPermissions } : {}),
    jobs: jobs(unit, get(root, 'jobs'), ctx),
  };
}

/** `dir` is the repo-relative action directory (what `uses: ./dir` points at); `file` is its action.yml. */
export function parseActionFile(dir: string, file: string, text: string, ctx: ParseContext): ActionDecl {
  const { unit, root } = load(file, text);
  if (root) collectSites(unit, 'action', dir, ctx, root);
  const runs = get(root, 'runs');
  const using = str(get(runs, 'using'));
  const name = str(get(root, 'name'));
  const generated = generatedMarker(file, text);
  return {
    kind: 'action',
    path: dir,
    file,
    ...(name ? { name } : {}),
    source: unit.source,
    sites: unit.sites,
    parseErrors: unit.parseErrors,
    schemaErrors: [],
    ...(generated ? { generated } : {}),
    ...(using ? { using } : {}),
    inputs: inputDecls(unit, get(root, 'inputs'), ['inputs']),
    outputs: outputDecls(unit, get(root, 'outputs'), ['outputs'], true),
    steps: steps(unit, get(runs, 'steps'), ['runs', 'steps'], 'action', ctx),
  };
}
