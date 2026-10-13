import { CONTEXT_FUNCTIONS, calledFunctions } from './expressions';
import {
  type ActionUse,
  type Definition,
  type GraphEdge,
  type GraphNode,
  type ProjectIndex,
  sym,
  type Usage,
} from './graph';
import {
  type Binding,
  type ExprSegment,
  type ExprSite,
  type InputDecl,
  type JobDecl,
  type LocatedRef,
  lookup,
  type SiteField,
  type UnitDecl,
} from './ir';
import { type Cell, comboLabel, expandMatrix } from './matrix';
import { secretsNeededBy } from './queries';
import type { Loc } from './source';

export interface TraceLeaf {
  /**
   * Downstream, what the value is used for, e.g. `run script`, `condition`, `runs-on`. Upstream, where it comes from
   * when that is not another symbol: `literal` (a plain value: passed by a caller or a step, an env variable's or
   * output's own value, or an input's default), `omitted` (a caller or step does not pass the input), `value`,
   * `missing` and `dynamic` (a matrix key's combinations), `context` (read from a context the graph does not follow,
   * such as `github.event.pull_request.title` or `runner.os`, or from the caller's event: `github.event.inputs.<name>`
   * in a workflow that can be called; `text` is the reference), `invalid` (an expression that does not parse, or, in an
   * input's default, a reference to a context or a call to a function GitHub does not allow there; `text` is then the
   * reference, or the function's name and `()` at the expression's place) and `expression` (an expression that reads
   * no context, e.g. a `format()` of literals).
   *
   * When a caller or step omits an input, its `default:` is the value there, so the input's trace also ends at the
   * default, after the calls: a `literal`, or the `context`, `invalid` or `expression` leaves of an expression, with
   * `where` naming it (`<unit> › on.workflow_call.inputs.<name>.default`, `<unit> › inputs.<name>.default` in an
   * action). GitHub evaluates a default when the input is omitted, with a few contexts only:
   * - a `workflow_call` input's default may read `github`, `inputs` and `vars`. The workflow's own `workflow_call`
   *   inputs and the variables it reads are the node's children. An input only `workflow_dispatch` declares, or none
   *   does, is empty when the workflow is called, and `github` is the caller's (`github.event.inputs.<name>` is the
   *   caller's event, not this workflow's input): each a `context`;
   * - an action input's default may read the calling job's `github`, `strategy`, `matrix`, `job` and `runner`, each a
   *   `context`, and call `hashFiles()`.
   *
   * A reference to any other context there (`env`, `secrets`, `steps`, `needs`, an action's `inputs` or `vars`) is
   * `invalid`, as is a call to a status function (`success()`, …) or, in a `workflow_call` default, `hashFiles()`. A
   * default no call falls back to is not shown, nor is a required `workflow_call` input's: GitHub fails the run when a
   * caller omits that input.
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
  /**
   * How the value got here from the parent node. `note` qualifies it: `when dispatched` for a workflow input read
   * through `github.event.inputs`, which holds the input only when the workflow is dispatched (see `readsCallerEvent`).
   */
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
 * or at a symbol already expanded elsewhere in the trace under the same `key`; otherwise the key is marked as expanded.
 */
function enter(
  index: ProjectIndex,
  symbol: string,
  depth: number,
  path: Set<string>,
  expanded: Set<string>,
  key = symbol,
): { node: TraceNode; next?: Set<string> } {
  const node = base(index, symbol);
  if (path.has(symbol)) return { node: { ...node, stop: 'cycle' } };
  if (depth <= 0) return { node: { ...node, stop: 'depth' } };
  if (expanded.has(key)) return { node: { ...node, stop: 'seen' } };
  expanded.add(key);
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

/**
 * `called`: the symbol is a workflow input entered through a caller's `with:`, so the workflow runs as a called one,
 * and its `github.event.inputs` reads take the caller's event, not this value (see `readsCallerEvent`).
 */
function down(
  index: ProjectIndex,
  symbol: string,
  depth: number,
  path: Set<string>,
  expanded: Set<string>,
  called = false,
): TraceNode {
  const { node, next } = enter(index, symbol, depth, path, expanded, downKey(index, symbol, called));
  if (!next) return node;
  const child = (to: string, calledInput = false) => down(index, to, depth - 1, next, expanded, calledInput);
  addReads(index, symbol, called, child, node);
  node.children = [
    ...node.children,
    ...structuralChildren(index, symbol, child),
    ...inheritChildren(index, symbol, child),
  ];
  return node;
}

/**
 * What a symbol is expanded once for downstream: the symbol, and whether it is `called` when that changes its reads,
 * that is for an input the workflow reads through `github.event.inputs`. Each symbol is expanded at most twice.
 */
function downKey(index: ProjectIndex, symbol: string, called: boolean): string {
  const skips = called && index.usagesOf(symbol).some((u) => usageReadsCallerEvent(index, u));
  return skips ? `${symbol}\0called` : symbol;
}

/** What reads the value: a symbol each expression defines (a child, once per expression) or a use (a leaf). */
function addReads(
  index: ProjectIndex,
  symbol: string,
  called: boolean,
  child: (to: string, calledInput?: boolean) => TraceNode,
  node: TraceNode,
): void {
  const seenSinks = new Set<string>();
  for (const u of index.usagesOf(symbol)) {
    if (called && usageReadsCallerEvent(index, u)) continue;
    if (!u.sink) {
      node.leaves.push(leafOf(u));
      continue;
    }
    if (seenSinks.has(`${u.sink}@${u.site.id}`)) continue;
    seenSinks.add(`${u.sink}@${u.site.id}`);
    // A caller's `with:` value is the called workflow's input.
    const c = child(u.sink, u.site.field === 'job.with');
    c.via = { loc: u.ref.loc, text: short(u.site.text) };
    node.children.push(c);
  }
}

/** Propagation that is structural rather than an expression (callee output → caller job output, etc.). */
function structuralChildren(
  index: ProjectIndex,
  symbol: string,
  child: (to: string) => TraceNode,
): TraceNode[] {
  return index
    .outgoing(symbol, 'flows')
    .filter((e) => e.siteId === undefined)
    .map((e) => {
      const c = child(e.to);
      if (e.loc) c.via = { loc: e.loc, text: 'workflow output', note: 'exposed to the caller' };
      return c;
    });
}

/** `secrets: inherit` forwards the secret under the same name, possibly through workflows that never read it. */
function inheritChildren(index: ProjectIndex, symbol: string, child: (to: string) => TraceNode): TraceNode[] {
  const secret = secretSymbol(symbol);
  const wf = secret ? index.project.workflows.get(secret.unit) : undefined;
  if (!secret || !wf) return [];
  return Object.values(wf.jobs).flatMap((job) => {
    const target = inheritedSecret(index, job, secret.name);
    if (!target) return [];
    const c = child(target);
    c.via = { loc: job.secretsLoc ?? job.loc, text: 'secrets: inherit', note: `jobs.${job.id}` };
    return [c];
  });
}

/** The callee's secret a job's `secrets: inherit` hands the secret `name` to, when the callee needs it. */
function inheritedSecret(index: ProjectIndex, job: JobDecl, name: string): string | undefined {
  const callee = job.secretsInherit ? index.calleeOf(job) : undefined;
  if (!callee) return undefined;
  const needed = [...secretsNeededBy(index, callee)].some((s) => s.toLowerCase() === name.toLowerCase());
  if (!needed) return undefined;
  return sym.secret(callee.path, (callee.call && lookup(callee.call.secrets, name)?.name) ?? name);
}

/**
 * Whether a read is `github.event.inputs…` in a workflow that can be called. GitHub gives a called workflow its
 * caller's `github` context ("the github context is always associated with the caller workflow"), with the caller's
 * event payload, so there `github.event.inputs` holds the caller's own dispatch inputs, or nothing, and never the
 * values passed in `with:`. The graph resolves the read to the workflow's input, which holds only when the workflow
 * is dispatched.
 */
function readsCallerEvent(index: ProjectIndex, u: { site: ExprSite; ref: LocatedRef }): boolean {
  const unit = index.project.workflows.get(u.site.ownerPath);
  return !!unit?.call && isEventInputs(u.ref);
}

const isEventInputs = (ref: LocatedRef) =>
  ref.context === 'github' && ref.path[0] === 'event' && ref.path[1] === 'inputs';

/**
 * Whether a usage reads its symbol only through `github.event.inputs` in a workflow that can be called (see
 * `readsCallerEvent`): directly, or through the step's own env value it reads (`env.X`, where the step's `env:` has
 * `X: ${{ github.event.inputs.z }}`), which the graph resolves to what the value reads.
 */
function usageReadsCallerEvent(index: ProjectIndex, u: Usage): boolean {
  const wf = index.project.workflows.get(u.site.ownerPath);
  if (!wf?.call) return false;
  if (isEventInputs(u.ref)) return true;
  const own = ownEnv(index, wf, u.site, u.ref)?.site;
  const reads = own
    ? own.segments.flatMap((seg) => seg.refs.filter((ref) => index.readsOf(wf, own, ref).includes(u.symbol)))
    : [];
  return reads.length > 0 && reads.every(isEventInputs);
}

/** The node of a parent upstream: a symbol traced on up, or the dispatch input alone (see `dispatchedInput`). */
type Parent = (from: string, dispatched?: boolean) => TraceNode;

function up(
  index: ProjectIndex,
  symbol: string,
  depth: number,
  path: Set<string>,
  expanded: Set<string>,
): TraceNode {
  const { node, next } = enter(index, symbol, depth, path, expanded);
  if (!next) return node;
  const parent: Parent = (from, dispatched = false) =>
    dispatched ? dispatchedInput(index, from, depth - 1, next) : up(index, from, depth - 1, next, expanded);
  const fallback = omittedDefault(index, symbol);

  node.children = [
    ...flowParents(index, symbol, parent),
    ...inheritParents(index, symbol, parent),
    ...(fallback ? defaultParents(index, fallback, parent) : []),
  ];
  node.leaves = endSources(index, symbol, fallback);
  return node;
}

/**
 * Where the trace ends: a matrix key's combinations, callers' literal values and omissions, then the input's default
 * when a call omits it, and what each definition reads that is not a symbol. Arrays are joined, not spread into
 * `push`, which has an argument limit.
 */
function endSources(index: ProjectIndex, symbol: string, fallback: InputDefault | undefined): TraceLeaf[] {
  const n = index.nodes.get(symbol);
  const matrix = n?.unit && n.kind === 'matrix' ? matrixSources(index, symbol, n.unit) : [];
  const callers = n?.unit && n.kind === 'input' ? callerValues(index, symbol, n.unit) : [];
  return [
    ...matrix,
    ...callers,
    ...(fallback ? defaultSources(index, fallback) : []),
    ...index.definitionsOf(symbol).flatMap((def) => definitionSources(index, def)),
  ];
}

/**
 * A workflow input that a value reads only through `github.event.inputs`: the value entered when the workflow is
 * dispatched. When it is called, the read takes the caller's event instead (a `context` leaf, see `readsCallerEvent`),
 * so the callers' `with:` values, which the input holds then, are not where the value comes from: the input is shown,
 * but not traced on up, nor marked as expanded, so that a read of it through `inputs` still is.
 */
function dispatchedInput(index: ProjectIndex, symbol: string, depth: number, path: Set<string>): TraceNode {
  const node = base(index, symbol);
  if (path.has(symbol)) return { ...node, stop: 'cycle' };
  if (depth <= 0) return { ...node, stop: 'depth' };
  return node;
}

/**
 * Whether every read of `from` in the site is `github.event.inputs` in a workflow that can be called, directly or
 * through the step's own env (see `usageReadsCallerEvent`).
 */
function readsOnlyCallerEvent(index: ProjectIndex, from: string, siteId: number | undefined): boolean {
  const reads = index.usagesOf(from).filter((u) => u.site.id === siteId);
  return reads.length > 0 && reads.every((u) => usageReadsCallerEvent(index, u));
}

/** The symbols the value is computed from, through `flows` edges: one parent per source and expression. */
function flowParents(index: ProjectIndex, symbol: string, parent: Parent): TraceNode[] {
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
    parents.push(flowParent(index, e, parent));
  }
  return parents;
}

/** The parent a `flows` edge comes from, with how the value got here: `when dispatched` for a dispatch input alone. */
function flowParent(index: ProjectIndex, e: GraphEdge, parent: Parent): TraceNode {
  const dispatched = readsOnlyCallerEvent(index, e.from, e.siteId);
  const p = parent(e.from, dispatched);
  const site = e.siteId !== undefined ? index.site(e.siteId) : undefined;
  const note = dispatched ? { note: 'when dispatched' } : {};
  if (e.loc) p.via = { loc: e.loc, text: site ? short(site.text) : 'workflow output', ...note };
  return p;
}

/** A secret received through `secrets: inherit` comes from the caller's secret of the same name. */
function inheritParents(index: ProjectIndex, symbol: string, parent: Parent): TraceNode[] {
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

/** A job calling a reusable workflow, or a step using an action: what it passes, and where. */
interface Call {
  with: Record<string, Binding>;
  where: string;
  loc: Loc;
}

/** The jobs that call the workflow `unit`, then the steps that use the action `unit`. */
function callsOf(index: ProjectIndex, unit: string): Call[] {
  const calls = index.callersOf(unit).map((c) => ({
    with: c.job.with,
    where: `${c.caller.path} › jobs.${c.job.id}`,
    loc: c.job.uses?.loc ?? c.job.loc,
  }));
  const uses = index
    .usersOf(unit)
    .map((u) => ({ with: u.step.with, where: stepWhere(u), loc: u.step.uses?.loc ?? u.step.loc }));
  return [...calls, ...uses];
}

/** `<unit>#inputs.<name>` (see `sym.input`) → `<name>`. */
const inputName = (symbol: string) => symbol.slice(symbol.indexOf('#inputs.') + '#inputs.'.length);

/** Literal values and omissions by the callers of a workflow and the steps that use an action. */
function callerValues(index: ProjectIndex, symbol: string, unit: string): TraceLeaf[] {
  const name = inputName(symbol);
  return callsOf(index, unit)
    .map((c) => valueLeaf(lookup(c.with, name), c.where, c.loc))
    .filter((l): l is TraceLeaf => l !== undefined);
}

/** An input's `default:`, and the place its leaves name (`<unit> › on.workflow_call.inputs.<name>.default`). */
interface InputDefault {
  unit: UnitDecl;
  input: InputDecl;
  where: string;
}

/**
 * The input's default when a caller or step omits the input, which makes the default its value there. A default no
 * call falls back to is not a source.
 */
function omittedDefault(index: ProjectIndex, symbol: string): InputDefault | undefined {
  const declared = calledInput(index, symbol);
  if (!declared || !defaultApplies(declared.unit, declared.input)) return undefined;
  const { unit, input } = declared;
  if (callsOf(index, unit.path).every((c) => lookup(c.with, input.name))) return undefined;
  const at = unit.kind === 'action' ? 'inputs' : 'on.workflow_call.inputs';
  return { unit, input, where: `${unit.path} › ${at}.${input.name}.default` };
}

/** The input `symbol`, among the inputs a call passes (see `callInputs`). */
function calledInput(index: ProjectIndex, symbol: string): { unit: UnitDecl; input: InputDecl } | undefined {
  const n = index.nodes.get(symbol);
  const unit = n?.kind === 'input' && n.unit ? index.unit(n.unit) : undefined;
  if (!unit) return undefined;
  const input = lookup(callInputs(unit), inputName(symbol));
  return input && { unit, input };
}

/**
 * The inputs a call passes: an action's, or a workflow's `workflow_call` ones. Calls never pass a `workflow_dispatch`
 * input, so its default never applies to them.
 */
const callInputs = (unit: UnitDecl) => (unit.kind === 'action' ? unit.inputs : (unit.call?.inputs ?? {}));

/**
 * Whether GitHub uses the input's default when a call omits it. It does not for a required `workflow_call` input: the
 * run fails instead. An action's `required` is not enforced, so its default applies.
 */
const defaultApplies = (unit: UnitDecl, input: InputDecl) =>
  input.hasDefault && !(unit.kind === 'workflow' && input.required);

/** The default as a source: a plain value (`literal`), or what its expression reads that is not a symbol. */
function defaultSources(index: ProjectIndex, d: InputDefault): TraceLeaf[] {
  const { input, where } = d;
  if (input.defaultSite) {
    return siteSources(index, d.unit, input.defaultSite, where, {
      reads: (site, ref) => defaultReads(index, d, site, ref),
      functions: DEFAULT_FUNCTIONS[d.unit.kind],
    });
  }
  return [
    { role: 'literal', where, loc: input.defaultLoc ?? input.loc, text: JSON.stringify(input.default) },
  ];
}

/**
 * The contexts GitHub evaluates an input's default with (its schemas' `workflow-call-input-default` and
 * `input-default-context`): a `workflow_call` input's, the caller's `github`, and `inputs` and `vars`; an action
 * input's, the calling job's `github`, `strategy`, `matrix`, `job` and `runner`.
 */
const DEFAULT_CONTEXTS: Record<UnitDecl['kind'], ReadonlySet<string>> = {
  workflow: new Set(['github', 'inputs', 'vars']),
  action: new Set(['github', 'strategy', 'matrix', 'job', 'runner']),
};

/**
 * The functions of `CONTEXT_FUNCTIONS` those schemas allow in a default, lowercase: none in a `workflow_call` input's,
 * `hashFiles` in an action input's. GitHub's parser rejects the others there ("Unrecognized function").
 */
const DEFAULT_FUNCTIONS: Record<UnitDecl['kind'], ReadonlySet<string>> = {
  workflow: new Set(),
  action: new Set(['hashfiles']),
};

/**
 * What a reference in an input's default reads: the workflow's own `workflow_call` inputs and the variables a
 * `workflow_call` default names, no symbol for the other contexts it may read, and `invalid` for a context GitHub
 * does not allow in that default. The default applies when the workflow is called, and then `inputs` holds its
 * `workflow_call` inputs only (an input only `workflow_dispatch` declares, or none does, is empty) and `github` is the
 * caller's (`github.event.inputs.<name>` there is not this workflow's input).
 */
function defaultReads(index: ProjectIndex, d: InputDefault, site: ExprSite, ref: LocatedRef): Reads {
  if (!DEFAULT_CONTEXTS[d.unit.kind].has(ref.context)) return 'invalid';
  if (ref.context === 'vars') return index.readsOf(d.unit, site, ref);
  if (ref.context !== 'inputs') return [];
  const called = callInputs(d.unit);
  return index.readsOf(d.unit, site, ref).filter((symbol) => lookup(called, inputName(symbol)));
}

/** The symbols an expression default reads (another input, `vars`): one parent each. */
function defaultParents(
  index: ProjectIndex,
  d: InputDefault,
  parent: (from: string) => TraceNode,
): TraceNode[] {
  const site = d.input.defaultSite;
  if (!site) return [];
  const reads = site.segments.flatMap((seg) =>
    seg.refs.flatMap((ref) =>
      symbolsOf(defaultReads(index, d, site, ref)).map((symbol) => ({ symbol, ref })),
    ),
  );
  const seen = new Set<string>();
  return reads.flatMap(({ symbol, ref }) => {
    if (seen.has(symbol)) return [];
    seen.add(symbol);
    const p = parent(symbol);
    p.via = { loc: ref.loc, text: short(site.text), note: `the default of inputs.${d.input.name}` };
    return [p];
  });
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
  return siteSources(index, unit, site, placeOf(unit, site.job, site.step));
}

/** The symbols a reference reads, or `invalid` for a context GitHub does not allow where it is written. */
type Reads = string[] | 'invalid';

/** What a reference in `site` reads. */
type Reader = (site: ExprSite, ref: LocatedRef) => Reads;

const symbolsOf = (reads: Reads): string[] => (reads === 'invalid' ? [] : reads);

/** How an expression's references and calls are read where it is written. */
interface Reading {
  /** What each reference reads. */
  reads: Reader;
  /** The functions of `CONTEXT_FUNCTIONS` GitHub allows there, lowercase; any of them when absent. */
  functions?: ReadonlySet<string>;
}

/**
 * What an expression site reads that is not a symbol, or the expression itself when it reads nothing. `reading` says
 * what each of its references reads (`definitionReads` by default) and which functions it may call.
 */
function siteSources(
  index: ProjectIndex,
  unit: UnitDecl,
  site: ExprSite,
  where: string,
  reading: Reading = { reads: definitionReads(index, unit) },
): TraceLeaf[] {
  const found = new Map<string, TraceLeaf>();
  collectSources(index, unit, { ...reading, site, where }, found);
  const readsNothing = site.segments.every((seg) => seg.refs.length === 0 && !seg.expr.error);
  if (readsNothing && found.size === 0)
    return [{ role: 'expression', where, loc: site.loc, text: short(site.text) }];
  return [...found.values()];
}

/** The same place as the `literal` and `omitted` leaves of a call: the unit, the job, and the step for an action. */
function placeOf(unit: UnitDecl, job?: string, step?: number): string {
  return [unit.path, job && `jobs.${job}`, step !== undefined && `steps[${step}]`]
    .filter(Boolean)
    .join(' › ');
}

/** The site whose sources are collected, the place its leaves name, and how it is read. */
interface SourceSite extends Reading {
  site: ExprSite;
  where: string;
}

/** Adds the leaves for what `site` reads that is not a symbol, once per context (contexts ignore case). */
function collectSources(
  index: ProjectIndex,
  unit: UnitDecl,
  at: SourceSite,
  found: Map<string, TraceLeaf>,
): void {
  const { site, where } = at;
  for (const seg of site.segments) {
    if (seg.expr.error) {
      add(found, `invalid@${seg.loc.line}:${seg.loc.column}`, {
        role: 'invalid',
        where,
        loc: seg.loc,
        text: short(seg.expr.source),
      });
    }
    addCalls(found, at, seg);
    for (const ref of seg.refs) {
      const own = ownEnv(index, unit, site, ref);
      if (own?.site) collectSources(index, unit, { ...at, site: own.site }, found);
      else if (own) add(found, `literal@${own.valueLoc.line}:${own.valueLoc.column}`, ownLiteral(own, where));
      else addRead(found, where, seg, ref, at.reads(site, ref));
    }
  }
}

const CONTEXT_FUNCTION_NAMES = new Set(CONTEXT_FUNCTIONS.map((f) => f.name.toLowerCase()));

/**
 * A call to a function of `CONTEXT_FUNCTIONS` that GitHub does not allow where the site is (`hashFiles()` in a
 * `workflow_call` default) ends the trace as `invalid`, at the expression, once per function.
 */
function addCalls(found: Map<string, TraceLeaf>, at: SourceSite, seg: ExprSegment): void {
  const allowed = at.functions;
  if (!allowed) return;
  for (const name of calledFunctions(seg.expr)) {
    const fn = name.toLowerCase();
    if (!CONTEXT_FUNCTION_NAMES.has(fn) || allowed.has(fn)) continue;
    const leaf = { role: 'invalid', where: at.where, loc: seg.loc, text: `${name}()` };
    add(found, `invalid:${fn}()@${seg.loc.line}:${seg.loc.column}`, leaf);
  }
}

/** A reference that reads no symbol ends the trace: at its context, or as `invalid` where GitHub does not allow it. */
function addRead(
  found: Map<string, TraceLeaf>,
  where: string,
  seg: ExprSegment,
  ref: LocatedRef,
  reads: Reads,
): void {
  const leaf = { where, loc: ref.loc, text: refText(seg.expr.source, ref) };
  if (reads === 'invalid')
    add(found, `invalid@${ref.loc.line}:${ref.loc.column}`, { role: 'invalid', ...leaf });
  else if (reads.length === 0)
    add(found, `context:${[ref.context, ...ref.path].join('.').toLowerCase()}`, { role: 'context', ...leaf });
}

/**
 * What a reference in a definition reads: the symbols the graph resolves it to, or none for `github.event.inputs` in a
 * workflow that can be called, which holds the caller's event when the workflow is called (see `readsCallerEvent`), so
 * the reference ends at that context, which the graph does not follow.
 */
function definitionReads(index: ProjectIndex, unit: UnitDecl): Reader {
  return (site, ref) => (readsCallerEvent(index, { site, ref }) ? [] : index.readsOf(unit, site, ref));
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
