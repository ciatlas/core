import { type ActionUse, type Definition, type GraphNode, type ProjectIndex, sym, type Usage } from './graph';
import { type Binding, type ExprSite, type LocatedRef, lookup, type SiteField, type UnitDecl } from './ir';
import { type Cell, comboLabel, expandMatrix } from './matrix';
import { secretsNeededBy } from './queries';
import type { Loc } from './source';

export interface TraceLeaf {
  /**
   * Downstream, what the value is used for, e.g. `run script`, `condition`, `runs-on`. Upstream, where it comes from
   * when that is not another symbol: `literal` (a plain value: passed by a caller or a step, or an env variable's or
   * output's own value), `omitted` (a caller or step does not pass the input), `value`, `missing` and `dynamic` (a
   * matrix key's combinations), `context` (read from a context the graph does not follow, such as
   * `github.event.pull_request.title` or `runner.os`; `text` is the reference), `invalid` (an expression that does not
   * parse) and `expression` (an expression that reads no context, e.g. a `format()` of literals).
   */
  role: string;
  where: string;
  loc: Loc;
  text: string;
}

export interface TraceNode {
  symbol: string;
  label: string;
  kind: GraphNode['kind'];
  unit?: string;
  loc?: Loc;
  /** How the value got here from the parent node. */
  via?: { loc: Loc; text: string; note?: string };
  children: TraceNode[];
  leaves: TraceLeaf[];
  /** Set when the branch stops early. */
  /** `seen`: this symbol's subtree is already shown elsewhere in the same trace. */
  stop?: 'cycle' | 'depth' | 'seen';
}

export type TraceDirection = 'down' | 'up';

export interface TraceOptions {
  direction?: TraceDirection;
  maxDepth?: number;
}

const ROLE: Partial<Record<SiteField, string>> = {
  'job.if': 'job condition',
  'job.name': 'job name',
  'step.if': 'step condition',
  'action.runs-if': 'pre/post condition',
  'step.run': 'run script',
  'step.env': 'step env',
  'step.other': 'step setting',
  'job.other': 'job setting',
  'job.strategy': 'matrix',
  'workflow.other': 'workflow setting',
  'step.with': 'action input',
  'job.with': 'workflow input',
  other: 'setting',
};

function where(site: ExprSite): string {
  const parts: string[] = [];
  if (site.job) parts.push(`jobs.${site.job}`);
  if (site.step !== undefined) parts.push(`steps[${site.step}]`);
  const tail = site.yamlPath.slice(site.step !== undefined ? 4 : site.job ? 2 : 0);
  if (tail.length) parts.push(tail.join('.'));
  return parts.join(' › ');
}

const short = (text: string) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 77)}...` : one;
};

/** Builds a tree of where a value flows to (`down`) or comes from (`up`). */
export function trace(index: ProjectIndex, symbol: string, opts: TraceOptions = {}): TraceNode {
  const direction = opts.direction ?? 'down';
  const maxDepth = opts.maxDepth ?? 12;
  // Each symbol is expanded once per trace; later occurrences point back to it. Shared subtrees (diamonds in the
  // call graph) would otherwise multiply the output exponentially.
  const expanded = new Set<string>();
  return direction === 'down'
    ? down(index, symbol, maxDepth, new Set(), expanded)
    : up(index, symbol, maxDepth, new Set(), expanded);
}

function base(index: ProjectIndex, symbol: string): TraceNode {
  const n = index.nodes.get(symbol);
  return {
    symbol,
    label: n?.label ?? symbol,
    kind: n?.kind ?? 'unresolved',
    ...(n?.unit ? { unit: n.unit } : {}),
    ...(n?.loc ? { loc: n.loc } : {}),
    children: [],
    leaves: [],
  };
}

/**
 * The node for `symbol`, and the path below it when the branch goes on. A branch stops at a cycle, at the depth limit,
 * or at a symbol already expanded elsewhere in the trace; otherwise the symbol is marked as expanded.
 */
function enter(
  index: ProjectIndex,
  symbol: string,
  depth: number,
  path: Set<string>,
  expanded: Set<string>,
): { node: TraceNode; next?: Set<string> } {
  const node = base(index, symbol);
  if (path.has(symbol)) return { node: { ...node, stop: 'cycle' } };
  if (depth <= 0) return { node: { ...node, stop: 'depth' } };
  if (expanded.has(symbol)) return { node: { ...node, stop: 'seen' } };
  expanded.add(symbol);
  return { node, next: new Set(path).add(symbol) };
}

// Symbols are split with indexOf rather than regexes like /^(.+)#secrets\.(.+)$/, which backtrack quadratically on
// symbols that repeat the separator (CodeQL js/polynomial-redos).

/** `<unit>#secrets.<name>` (see `sym.secret`); the last separator wins, as unit paths may contain it. */
function secretSymbol(symbol: string): { unit: string; name: string } | undefined {
  const sep = '#secrets.';
  for (let i = symbol.lastIndexOf(sep); i > 0; i = symbol.lastIndexOf(sep, i - 1)) {
    if (i + sep.length < symbol.length)
      return { unit: symbol.slice(0, i), name: symbol.slice(i + sep.length) };
  }
  return undefined;
}

/** `<unit>#jobs.<job>.matrix.<key>` (see `sym.matrix`); job ids contain no dots, so the first `.matrix.` ends the id. */
function matrixSymbol(symbol: string, unit: string): { job: string; key: string } | undefined {
  const prefix = `${unit}#jobs.`;
  if (!symbol.startsWith(prefix)) return undefined;
  const rest = symbol.slice(prefix.length);
  const at = rest.indexOf('.matrix.');
  if (at <= 0 || at + '.matrix.'.length >= rest.length) return undefined;
  return { job: rest.slice(0, at), key: rest.slice(at + '.matrix.'.length) };
}

function down(
  index: ProjectIndex,
  symbol: string,
  depth: number,
  path: Set<string>,
  expanded: Set<string>,
): TraceNode {
  const { node, next } = enter(index, symbol, depth, path, expanded);
  if (!next) return node;

  const seenSinks = new Set<string>();
  for (const u of index.usagesOf(symbol)) {
    if (u.sink) {
      if (seenSinks.has(`${u.sink}@${u.site.id}`)) continue;
      seenSinks.add(`${u.sink}@${u.site.id}`);
      const child = down(index, u.sink, depth - 1, next, expanded);
      child.via = { loc: u.ref.loc, text: short(u.site.text) };
      node.children.push(child);
    } else {
      node.leaves.push(leafOf(u));
    }
  }
  // Propagation that is structural rather than an expression (callee output → caller job output, etc.).
  for (const e of index.outgoing(symbol, 'flows')) {
    if (e.siteId !== undefined) continue;
    const child = down(index, e.to, depth - 1, next, expanded);
    if (e.loc) child.via = { loc: e.loc, text: 'workflow output', note: 'exposed to the caller' };
    node.children.push(child);
  }
  // `secrets: inherit` forwards the secret under the same name, possibly through workflows that never read it.
  const secret = secretSymbol(symbol);
  const wf = secret ? index.project.workflows.get(secret.unit) : undefined;
  if (secret && wf) {
    const name = secret.name;
    for (const job of Object.values(wf.jobs)) {
      const callee = job.secretsInherit ? index.calleeOf(job) : undefined;
      if (!callee) continue;
      const needed = [...secretsNeededBy(index, callee)].some((s) => s.toLowerCase() === name.toLowerCase());
      if (!needed) continue;
      const target = sym.secret(
        callee.path,
        (callee.call && lookup(callee.call.secrets, name)?.name) ?? name,
      );
      const child = down(index, target, depth - 1, next, expanded);
      child.via = { loc: job.secretsLoc ?? job.loc, text: 'secrets: inherit', note: `jobs.${job.id}` };
      node.children.push(child);
    }
  }
  return node;
}

function up(
  index: ProjectIndex,
  symbol: string,
  depth: number,
  path: Set<string>,
  expanded: Set<string>,
): TraceNode {
  const { node, next } = enter(index, symbol, depth, path, expanded);
  if (!next) return node;
  const parent = (from: string) => up(index, from, depth - 1, next, expanded);

  node.children = [...flowParents(index, symbol, parent), ...inheritParents(index, symbol, parent)];
  node.leaves = endSources(index, symbol);
  return node;
}

/**
 * Where the trace ends: a matrix key's combinations, callers' literal values and omissions, and what each definition
 * reads that is not a symbol. Arrays are joined, not spread into `push`, which has an argument limit.
 */
function endSources(index: ProjectIndex, symbol: string): TraceLeaf[] {
  const n = index.nodes.get(symbol);
  const matrix = n?.unit && n.kind === 'matrix' ? matrixSources(index, symbol, n.unit) : [];
  const callers = n?.unit && n.kind === 'input' ? callerValues(index, symbol, n.unit) : [];
  return [
    ...matrix,
    ...callers,
    ...index.definitionsOf(symbol).flatMap((def) => definitionSources(index, def)),
  ];
}

/** The symbols the value is computed from, through `flows` edges: one parent per source and expression. */
function flowParents(index: ProjectIndex, symbol: string, parent: (from: string) => TraceNode): TraceNode[] {
  const parents: TraceNode[] = [];
  // One parent per source and expression, even when the expression reads the symbol several times.
  const seenEdges = new Set<string>();
  for (const e of index.incoming(symbol, 'flows')) {
    const key =
      e.siteId !== undefined
        ? `${e.from}@site:${e.siteId}`
        : `${e.from}@${e.loc ? `${e.loc.file}:${e.loc.line}:${e.loc.column}` : ''}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const p = parent(e.from);
    const site = e.siteId !== undefined ? index.site(e.siteId) : undefined;
    if (e.loc) p.via = { loc: e.loc, text: site ? short(site.text) : 'workflow output' };
    parents.push(p);
  }
  return parents;
}

/** A secret received through `secrets: inherit` comes from the caller's secret of the same name. */
function inheritParents(
  index: ProjectIndex,
  symbol: string,
  parent: (from: string) => TraceNode,
): TraceNode[] {
  const secret = secretSymbol(symbol);
  if (!secret) return [];
  const parents: TraceNode[] = [];
  const name = secret.name;
  for (const c of index.callersOf(secret.unit)) {
    if (!c.job.secretsInherit) continue;
    const callerName = (c.caller.call && lookup(c.caller.call.secrets, name)?.name) ?? name;
    const p = parent(sym.secret(c.caller.path, callerName));
    p.via = { loc: c.job.secretsLoc ?? c.job.loc, text: 'secrets: inherit', note: `jobs.${c.job.id}` };
    parents.push(p);
  }
  return parents;
}

/** A matrix key's sources are the combinations themselves: each value, and where it is missing. */
function matrixSources(index: ProjectIndex, symbol: string, unit: string): TraceLeaf[] {
  const m = matrixSymbol(symbol, unit);
  const wf = index.project.workflows.get(unit);
  const job = m && wf ? wf.jobs[m.job] : undefined;
  if (!job?.matrix || !m) return [];
  const matrix = job.matrix;
  const exp = expandMatrix(matrix);
  const others = exp.keys.filter((k) => k.toLowerCase() !== m.key.toLowerCase());
  const dynamic: TraceLeaf[] = exp.dynamic
    ? [{ role: 'dynamic', where: `jobs.${job.id}`, loc: matrix.loc, text: 'matrix is computed at runtime' }]
    : [];
  return [
    ...dynamic,
    ...exp.combos.map((combo) =>
      comboLeaf(
        lookup(combo.values, m.key),
        comboLabel(combo, others.length ? others : exp.keys),
        matrix.loc,
      ),
    ),
  ];
}

/** One combination's value of the key, or `missing` when the combination does not define it. */
function comboLeaf(cell: Cell | undefined, where: string, loc: Loc): TraceLeaf {
  if (!cell) return { role: 'missing', where, loc, text: `(undefined → '')` };
  return { role: 'value', where, loc, text: cell.known ? JSON.stringify(cell.value) : '<expression>' };
}

/** Literal values and omissions by the callers of a workflow and the steps that use an action. */
function callerValues(index: ProjectIndex, symbol: string, unit: string): TraceLeaf[] {
  const name = symbol.slice(symbol.indexOf('#inputs.') + '#inputs.'.length);
  const calls = index
    .callersOf(unit)
    .map((c) =>
      valueLeaf(
        lookup(c.job.with, name),
        `${c.caller.path} › jobs.${c.job.id}`,
        c.job.uses?.loc ?? c.job.loc,
      ),
    );
  const uses = index
    .usersOf(unit)
    .map((u) => valueLeaf(lookup(u.step.with, name), stepWhere(u), u.step.uses?.loc ?? u.step.loc));
  return [...calls, ...uses].filter((l): l is TraceLeaf => l !== undefined);
}

/** `<file> › jobs.<job> › steps[<n>]`, without the job in an action. */
function stepWhere(u: ActionUse): string {
  return `${u.unit.path}${u.job ? ` › jobs.${u.job.id}` : ''} › steps[${u.step.index}]`;
}

/** `omitted` when a call does not pass the input, `literal` when it passes a plain value; nothing for an expression. */
function valueLeaf(b: Binding | undefined, where: string, usesLoc: Loc): TraceLeaf | undefined {
  if (!b) return { role: 'omitted', where, loc: usesLoc, text: '(not passed)' };
  if (!b.site) return { role: 'literal', where, loc: b.valueLoc, text: JSON.stringify(b.value) };
  return undefined;
}

/**
 * Where a definition's value comes from when that is not a symbol (the symbols it reads are the node's children
 * already, through its `flows` edges): a plain value (`literal`); contexts the graph does not follow (`context`), such
 * as `github.event.pull_request.title`, `runner.os`, `needs.<job>.result`, `steps.<id>.outcome` or an `env` value
 * written to `$GITHUB_ENV`, followed through the step's own `env:`; an expression that does not parse (`invalid`); or,
 * when it reads nothing at all, the expression as written (`expression`).
 */
function definitionSources(index: ProjectIndex, def: Definition): TraceLeaf[] {
  if (!('site' in def)) {
    const where = placeOf(def.unit, def.job);
    return [{ role: 'literal', where, loc: def.loc, text: JSON.stringify(def.value) }];
  }
  const { unit, site } = def;
  const where = placeOf(unit, site.job, site.step);
  const found = new Map<string, TraceLeaf>();
  collectSources(index, unit, site, where, found);
  const readsNothing = site.segments.every((seg) => seg.refs.length === 0 && !seg.expr.error);
  if (readsNothing) return [{ role: 'expression', where, loc: site.loc, text: short(site.text) }];
  return [...found.values()];
}

/** The same place as the `literal` and `omitted` leaves of a call: the unit, the job, and the step for an action. */
function placeOf(unit: UnitDecl, job?: string, step?: number): string {
  return [unit.path, job && `jobs.${job}`, step !== undefined && `steps[${step}]`]
    .filter(Boolean)
    .join(' › ');
}

/** Adds the leaves for what `site` reads that is not a symbol, once per context (contexts ignore case). */
function collectSources(
  index: ProjectIndex,
  unit: UnitDecl,
  site: ExprSite,
  where: string,
  found: Map<string, TraceLeaf>,
): void {
  for (const seg of site.segments) {
    if (seg.expr.error) {
      add(found, `invalid@${seg.loc.line}:${seg.loc.column}`, {
        role: 'invalid',
        where,
        loc: seg.loc,
        text: short(seg.expr.source),
      });
    }
    for (const ref of seg.refs) {
      const own = ownEnv(index, unit, site, ref);
      if (own?.site) collectSources(index, unit, own.site, where, found);
      else if (own) add(found, `literal@${own.valueLoc.line}:${own.valueLoc.column}`, ownLiteral(own, where));
      else if (index.readsOf(unit, site, ref).length === 0)
        add(found, `context:${[ref.context, ...ref.path].join('.').toLowerCase()}`, {
          role: 'context',
          where,
          loc: ref.loc,
          text: refText(seg.expr.source, ref),
        });
    }
  }
}

/**
 * The step's own `env:` entry a reference reads: it shadows the job's and the workflow's for the rest of the step, and
 * its value (evaluated against the outer env) is where the reference's value comes from.
 */
function ownEnv(index: ProjectIndex, unit: UnitDecl, site: ExprSite, ref: LocatedRef): Binding | undefined {
  const name = ref.path[0];
  if (ref.context !== 'env' || site.field === 'step.env' || !name || name === '*' || name === '?')
    return undefined;
  return lookup(index.stepOf(unit, site)?.env ?? {}, name);
}

/** Keeps the first leaf of each key: the place where the source is first written. */
function add(found: Map<string, TraceLeaf>, key: string, leaf: TraceLeaf): void {
  if (!found.has(key)) found.set(key, leaf);
}

function ownLiteral(own: Binding, where: string): TraceLeaf {
  return { role: 'literal', where, loc: own.valueLoc, text: JSON.stringify(own.value) };
}

/** The reference as written, on one line; a computed index at its end shows as `[…]`. */
function refText(source: string, ref: LocatedRef): string {
  const text = source
    .slice(ref.start, ref.end)
    .replace(/\s*([.[\]])\s*/g, '$1')
    .replace(/\s+/g, ' ');
  return ref.path.at(-1) === '?' ? `${text}[…]` : text;
}

function leafOf(u: Usage): TraceLeaf {
  return {
    role: u.site.isCondition ? 'condition' : (ROLE[u.site.field] ?? u.site.field),
    where: where(u.site),
    loc: u.ref.loc,
    text: short(u.site.text),
  };
}

export interface SymbolMatch {
  id: string;
  node: GraphNode;
}

/**
 * Resolves a user query to graph symbols. Accepts full ids (`.github/workflows/ci.yml#inputs.env`),
 * basenames (`ci.yml#inputs.env`), `file:name` shorthand (`ci.yml:env` → inputs/secrets/outputs named `env`)
 * and bare files (`ci.yml` → every input, secret and output of that workflow).
 */
export function resolveSymbols(index: ProjectIndex, query: string): SymbolMatch[] {
  const all = [...index.nodes.values()];
  const exact = index.nodes.get(query);
  if (exact) {
    if (exact.kind === 'workflow' || exact.kind === 'action') return interfaceOf(index, exact.id);
    return [{ id: exact.id, node: exact }];
  }
  const [filePart = '', rest] = query.includes('#') ? query.split('#', 2) : query.split(':', 2);
  const files = [...new Set(all.filter((n) => n.unit).map((n) => n.unit!))].filter(
    (u) => u === filePart || u.endsWith(`/${filePart}`) || u.replace(/\.ya?ml$/, '').endsWith(filePart),
  );
  if (files.length === 0) return [];
  if (!rest) return files.flatMap((f) => interfaceOf(index, f));
  const wanted = rest.toLowerCase();
  return all
    .filter((n) => n.unit && files.includes(n.unit))
    .filter((n) => {
      const suffix = n.id.slice(n.id.indexOf('#') + 1).toLowerCase();
      if (suffix === wanted) return true;
      return (
        !query.includes('#') &&
        ['input', 'secret', 'output'].includes(n.kind) &&
        suffix.split('.').pop() === wanted
      );
    })
    .map((n) => ({ id: n.id, node: n }));
}

function interfaceOf(index: ProjectIndex, unit: string): SymbolMatch[] {
  return [...index.nodes.values()]
    .filter((n) => n.unit === unit && ['input', 'secret', 'output'].includes(n.kind))
    .sort((a, b) => (a.loc && b.loc ? a.loc.line - b.loc.line : a.id.localeCompare(b.id)))
    .map((n) => ({ id: n.id, node: n }));
}
