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
  type MatrixDecl,
  type SiteField,
  type UnitDecl,
  type WorkflowDecl,
} from './ir';
import { type Cell, comboLabel, expandMatrix } from './matrix';
import { BUILTIN_SECRETS, needsSecret, refsOf, secretsNeededBy } from './queries';
import type { Loc } from './source';

export interface TraceLeaf {
  /**
   * Downstream, what the value is used for, e.g. `run script`, `condition`, `runs-on`. Upstream, where it comes from
   * when that is not another symbol: `literal` (a plain value: passed by a caller or a step, an env variable's or
   * output's own value, or an input's default), `omitted` (a caller or step does not pass the input), `value`,
   * `missing` and `dynamic` (a matrix key's combinations), `context` (read from a context the graph does not follow,
   * such as `github.event.pull_request.title` or `runner.os`, from the caller's event: `github` in a workflow that can
   * be called (`github.event.inputs.<name>`, `toJSON(github)`), or from a whole object that may hold more than the
   * members the files declare, such as `toJSON(secrets)` or `toJSON(github)`; `text` is the reference), `invalid` (an
   * expression that does not parse, or, in an input's default, a reference to a context or a call to a function GitHub
   * does not allow there; `text` is then the reference, or the function's name and `()` at the expression's place) and
   * `expression` (an expression that reads no context, e.g. a `format()` of literals).
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
  /**
   * The graph node's label, such as `inputs.<name>` or `secrets.<name>`. A symbol the graph has no node for is
   * `unresolved` and named the way the graph names a symbol a unit reads without declaring it: `unit` is the workflow or
   * action its id names, and the label is the rest of the id (`secrets.<name>` for `<unit>#secrets.<name>`). An id that
   * names no unit of the project is its own label.
   */
  label: string;
  kind: GraphNode['kind'];
  unit?: string;
  loc?: Loc;
  /**
   * How the value got here from the parent node: the expression it passes through, `secrets: inherit`, or `workflow
   * output` or `action output` for the output of a reusable workflow or an action that becomes the output of the job or
   * step using it. `note` qualifies it, and is one of:
   * - `exposed to the caller`: a `workflow output` or `action output`, downstream;
   * - `jobs.<id>`: `secrets: inherit`, naming the calling job that passes the secret on, in both directions;
   * - `the default of inputs.<name>`: upstream, the expression of an input's default, which reads the parent (another
   *   input or a `vars` value) where a caller or step omits the input;
   * - `when dispatched`: upstream, for a workflow input read through `github` (`github.event.inputs.<name>`,
   *   `toJSON(github)`), whose event holds the input only when the workflow is dispatched (see `readsCallerEvent`).
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
  const n = index.nodes.get(symbol) ?? unresolvedNode(index, symbol);
  return {
    symbol,
    label: n.label,
    kind: n.kind,
    ...(n.unit ? { unit: n.unit } : {}),
    ...(n.loc ? { loc: n.loc } : {}),
    children: [],
    leaves: [],
  };
}

/**
 * The node of a symbol the graph has none for (see `TraceNode.label`): a secret that `secrets: inherit` hands a
 * workflow that neither declares it nor reads it by name, an input or secret a caller or step passes that the callee
 * does not declare, or an id asked for that nothing declares or reads.
 */
function unresolvedNode(index: ProjectIndex, symbol: string): Omit<GraphNode, 'id'> {
  const unit = unitOf(index, symbol);
  if (!unit) return { kind: 'unresolved', label: symbol };
  return { kind: 'unresolved', label: symbol.slice(unit.length + 1), unit };
}

/** The unit of the project an id names before `#`: the longest that fits, as unit paths may contain `#`. */
function unitOf(index: ProjectIndex, symbol: string): string | undefined {
  let found: string | undefined;
  for (const { path } of index.units())
    if (path.length > (found?.length ?? 0) && symbol.startsWith(`${path}#`)) found = path;
  return found;
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
 * and its reads through `github` (`github.event.inputs.<name>`, `toJSON(github)`, directly or through the step's own
 * env) take the caller's event, not this value (see `usageReadsCallerEvent`).
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
 * that is for an input the workflow reads through `github` (see `usageReadsCallerEvent`). Each symbol is expanded at
 * most twice.
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
  for (const u of [...index.usagesOf(symbol), ...inheritedWholeReads(index, symbol)]) {
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

/**
 * Propagation that is structural rather than an expression: a reusable workflow's output to the calling job's output,
 * an action's output to the output of the step that uses it.
 */
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
      if (e.loc) c.via = { loc: e.loc, text: outputEdge(index, e), note: 'exposed to the caller' };
      return c;
    });
}

/**
 * What a structural `flows` edge carries: `action output` when it comes from an action's output, `workflow output`
 * when it comes from a reusable workflow's. The unit of its `from` symbol says which.
 */
function outputEdge(index: ProjectIndex, e: GraphEdge): string {
  const unit = index.nodes.get(e.from)?.unit;
  return unit && index.project.actions.has(unit) ? 'action output' : 'workflow output';
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

/**
 * The callee's secret a job's `secrets: inherit` hands the secret `name` to, when the callee needs it: it, or a callee
 * it hands every secret to, reads it by name or reads, or may read, every secret (see `NeededSecrets.all`).
 */
function inheritedSecret(index: ProjectIndex, job: JobDecl, name: string): string | undefined {
  const callee = job.secretsInherit ? index.calleeOf(job) : undefined;
  if (!callee || !needsSecret(secretsNeededBy(index, callee), name)) return undefined;
  return sym.secret(callee.path, (callee.call && lookup(callee.call.secrets, name)?.name) ?? name);
}

/**
 * A workflow's reads of every secret, as reads of `symbol`: a secret the workflow does not declare, which a caller's
 * `secrets: inherit` hands it with every other secret the caller has (see `inheritsUndeclared`). The graph reads them
 * as reads of the declared secrets only (see `ProjectIndex.readsOf`).
 */
function inheritedWholeReads(index: ProjectIndex, symbol: string): Usage[] {
  const secret = secretSymbol(symbol);
  const wf = secret && index.project.workflows.get(secret.unit);
  if (!secret || !wf || !inheritsUndeclared(index, wf, secret.name)) return [];
  return [...refsOf(wf)]
    .filter(({ site, ref }) => readsEverySecret(index, wf, site, ref))
    .map(({ site, ref }) => {
      const sink = index.sinkOf(wf, site);
      return { symbol, site, ref, ...(sink ? { sink } : {}), whole: true };
    });
}

/**
 * Whether the secret `name` reaches a workflow that does not declare it: a caller hands it every secret through
 * `secrets: inherit`. Not the automatic `GITHUB_TOKEN`, which every workflow gets without it.
 */
function inheritsUndeclared(index: ProjectIndex, wf: WorkflowDecl, name: string): boolean {
  if (BUILTIN_SECRETS.has(name.toLowerCase()) || (wf.call && lookup(wf.call.secrets, name))) return false;
  return index.callersOf(wf.path).some((c) => c.job.secretsInherit);
}

/** Whether a reference reads the whole `secrets` context or a computed key of it: `toJSON(secrets)`, `secrets.*`. */
const isWholeSecrets = (ref: LocatedRef) => ref.context === 'secrets' && !namesMember(ref);

/**
 * Whether a reference reads every secret: the whole `secrets` context or a computed key of it (`toJSON(secrets)`,
 * `secrets.*`, `secrets[inputs.name]`), or a value of the step's own env that does, which the graph reads through.
 */
function readsEverySecret(index: ProjectIndex, unit: UnitDecl, site: ExprSite, ref: LocatedRef): boolean {
  if (isWholeSecrets(ref)) return true;
  return ownEnv(index, unit, site, ref).some((own) =>
    own.site?.segments.some((seg) => seg.refs.some(isWholeSecrets)),
  );
}

/**
 * Whether a read is of `github` in a workflow that can be called. GitHub gives a called workflow its caller's `github`
 * context ("the github context is always associated with the caller workflow"), with the caller's event payload, so
 * there `github.event.inputs`, and a whole or computed `github` or `github.event`, hold the caller's own dispatch
 * inputs, or nothing, and never the values passed in `with:`. The graph reads them as the workflow's dispatch inputs,
 * which they hold only when the workflow is dispatched.
 */
function readsCallerEvent(index: ProjectIndex, u: { site: ExprSite; ref: LocatedRef }): boolean {
  const unit = index.project.workflows.get(u.site.ownerPath);
  return !!unit?.call && readsGithub(u.ref);
}

/**
 * Whether a reference reads `github`. The only symbols it can read are dispatch inputs, through `github.event`:
 * `github.event.inputs.<name>`, or a whole or computed `github`, `github.event` or `github.event.inputs` (see
 * `ProjectIndex.readsOf`).
 */
const readsGithub = (ref: LocatedRef) => ref.context === 'github';

/**
 * Whether a usage reads its symbol only through `github` in a workflow that can be called: directly
 * (`github.event.inputs.<name>`, `toJSON(github)`, `github.event[x]`), or through the step's own env values it reads
 * (`env.X`, where the step's `env:` has `X: ${{ toJSON(github) }}`, or a whole `env`, which reads every own value),
 * which the graph resolves to what the values read. The symbol is then one of the workflow's `workflow_dispatch`
 * inputs, which `github.event` holds only when the workflow is dispatched: when it is called, GitHub gives it the
 * caller's `github` context and event (see `readsCallerEvent`), so the usage never takes in the value a caller passes
 * in `with:`. A rule about that value, such as one that looks for an input a callee never takes in, can skip such
 * usages.
 */
export function usageReadsCallerEvent(index: ProjectIndex, u: Usage): boolean {
  const wf = index.project.workflows.get(u.site.ownerPath);
  if (!wf?.call) return false;
  if (readsGithub(u.ref)) return true;
  const reads = ownEnv(index, wf, u.site, u.ref).flatMap((own) =>
    own.site ? refsReading(index, wf, own.site, u.symbol) : [],
  );
  return reads.length > 0 && reads.every(readsGithub);
}

/** The references of a site that read `symbol`. */
function refsReading(index: ProjectIndex, unit: UnitDecl, site: ExprSite, symbol: string): LocatedRef[] {
  return site.segments.flatMap((seg) =>
    seg.refs.filter((ref) => index.readsOf(unit, site, ref).includes(symbol)),
  );
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
    ...inheritedWholeParents(index, symbol, parent),
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
 * A workflow input that a value reads only through `github` (`github.event.inputs.<name>`, `toJSON(github)`, directly
 * or through the step's own env): the value entered when the workflow is dispatched. When it is called, the read takes
 * the caller's event instead (a `context` leaf, see `readsCallerEvent`), so the callers' `with:` values, which the
 * input holds then, are not where the value comes from: the input is shown, but not traced on up, nor marked as
 * expanded, so that a read of it through `inputs` still is.
 */
function dispatchedInput(index: ProjectIndex, symbol: string, depth: number, path: Set<string>): TraceNode {
  const node = base(index, symbol);
  if (path.has(symbol)) return { ...node, stop: 'cycle' };
  if (depth <= 0) return { ...node, stop: 'depth' };
  return node;
}

/**
 * Whether every read of `from` in the site is through `github` in a workflow that can be called, directly or through
 * the step's own env (see `usageReadsCallerEvent`).
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

/**
 * The parent a `flows` edge comes from, with how the value got here: `when dispatched` for a dispatch input alone. The
 * graph reads only `workflow_dispatch` inputs through `github` (see `ProjectIndex.readsOf`), so such an edge never
 * comes from an input that no dispatch sets.
 */
function flowParent(index: ProjectIndex, e: GraphEdge, parent: Parent): TraceNode {
  const dispatched = readsOnlyCallerEvent(index, e.from, e.siteId);
  const p = parent(e.from, dispatched);
  const site = e.siteId !== undefined ? index.site(e.siteId) : undefined;
  const note = dispatched ? { note: 'when dispatched' } : {};
  if (e.loc) p.via = { loc: e.loc, text: site ? short(site.text) : outputEdge(index, e), ...note };
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

/**
 * The secrets a definition's read of every secret takes from the callers that hand its workflow every secret through
 * `secrets: inherit` (see `inheritedNames`): one parent per secret and expression, each the workflow's secret, which
 * `inheritParents` follows on up. The graph links the secrets the workflow declares (see `ProjectIndex.readsOf`), and
 * those the expression also reads by name, which `flowParents` lists already; downstream, `inheritedWholeReads` goes
 * the other way. The read's `secrets` context leaf stands for the secrets it gets that no parent lists.
 */
function inheritedWholeParents(index: ProjectIndex, symbol: string, parent: Parent): TraceNode[] {
  return index.definitionsOf(symbol).flatMap((def) => {
    if (!('site' in def) || def.unit.kind !== 'workflow') return [];
    const { unit, site } = def;
    const ref = site.segments.flatMap((seg) => seg.refs).find((r) => readsEverySecret(index, unit, site, r));
    if (!ref) return [];
    const linked = linkedSecrets(index, symbol, site);
    return inheritedNames(index, unit)
      .filter((name) => !linked.has(name.toLowerCase()))
      .map((name) => {
        const p = parent(sym.secret(unit.path, name));
        p.via = { loc: ref.loc, text: short(site.text) };
        return p;
      });
  });
}

/**
 * The secrets the graph links to `symbol` from a site, in lower case: secret names ignore case, so a caller's `DEPLOY`
 * is the `deploy` the site reads by name.
 */
function linkedSecrets(index: ProjectIndex, symbol: string, site: ExprSite): Set<string> {
  return new Set(
    index.incoming(symbol, 'flows').flatMap((e) => {
      const secret = e.siteId === site.id ? secretSymbol(e.from) : undefined;
      return secret ? [secret.name.toLowerCase()] : [];
    }),
  );
}

/**
 * The secrets a workflow gets through `secrets: inherit` that the callers handing them on name themselves, once each
 * ignoring case: those each workflow that hands it every secret, directly or through others that do, declares or reads
 * by name, without the automatic `GITHUB_TOKEN` or the secrets the workflow declares.
 *
 * Next to these and the secrets the graph links, the read's `secrets` context leaf (see `holdsUndeclared`) stands for
 * every other secret the workflow gets: the automatic `GITHUB_TOKEN`, and each secret those callers have without
 * declaring or reading it by name themselves. That is a secret only another of their callees reads by name (when
 * top.yml hands every secret to named.yml, which reads `Z`, and to this workflow, `Z` is not listed here, though the
 * trace down from top.yml's `Z` reaches this read), or one no file names, such as a repository secret of a workflow
 * run by an event.
 */
function inheritedNames(index: ProjectIndex, wf: WorkflowDecl): string[] {
  const names = new Map<string, string>();
  for (const caller of inheritingCallers(index, wf)) {
    for (const name of namedSecrets(caller))
      if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  return [...names.values()].filter((n) => inheritsUndeclared(index, wf, n));
}

/** The workflows that hand `wf` every secret through `secrets: inherit`, and those that hand them every secret, … */
function inheritingCallers(index: ProjectIndex, wf: WorkflowDecl): WorkflowDecl[] {
  const found = new Map<string, WorkflowDecl>([[wf.path, wf]]);
  // A Map's iteration visits the entries added while it runs: each caller found is searched in turn.
  for (const unit of found.values()) {
    for (const c of index.callersOf(unit.path))
      if (c.job.secretsInherit && !found.has(c.caller.path)) found.set(c.caller.path, c.caller);
  }
  found.delete(wf.path);
  return [...found.values()];
}

/** The secrets a workflow declares under `workflow_call` or reads by name, as written. */
function namedSecrets(wf: WorkflowDecl): string[] {
  const declared = Object.values(wf.call?.secrets ?? {}).map((s) => s.name);
  const read = [...refsOf(wf)].flatMap(({ ref }) =>
    ref.context === 'secrets' && namesMember(ref) ? [ref.path[0]!] : [],
  );
  return [...declared, ...read];
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
    for (const ref of seg.refs) refSources(index, { unit, at, seg, ref }, found);
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

/**
 * What a reference in a definition reads: the symbols the graph resolves it to, or none for `github` in a workflow
 * that can be called, which holds the caller's event when the workflow is called (see `readsCallerEvent`), so
 * the reference ends at that context, which the graph does not follow.
 */
function definitionReads(index: ProjectIndex, unit: UnitDecl): Reader {
  return (site, ref) => (readsCallerEvent(index, { site, ref }) ? [] : index.readsOf(unit, site, ref));
}

/**
 * Adds the leaves for one reference: the sources of the step's own env values it reads, `invalid` where GitHub does
 * not allow it, and the context itself when it reads no symbol or may read members the files do not declare (see
 * `holdsUndeclared`).
 */
function refSources(
  index: ProjectIndex,
  { unit, at, seg, ref }: { unit: UnitDecl; at: SourceSite; seg: ExprSegment; ref: LocatedRef },
  found: Map<string, TraceLeaf>,
): void {
  const owns = ownEnv(index, unit, at.site, ref);
  for (const own of owns) {
    if (own.site) collectSources(index, unit, { ...at, site: own.site }, found);
    else add(found, `literal@${own.valueLoc.line}:${own.valueLoc.column}`, ownLiteral(own, at.where));
  }
  const reads = at.reads(at.site, ref);
  const leaf = { where: at.where, loc: ref.loc, text: refText(seg.expr.source, ref) };
  if (reads === 'invalid') {
    add(found, `invalid@${ref.loc.line}:${ref.loc.column}`, { role: 'invalid', ...leaf });
    return;
  }
  const unfollowed = owns.length === 0 && reads.length === 0;
  if (unfollowed || holdsUndeclared(unit, at.site, ref))
    add(found, `context:${[ref.context, ...ref.path].join('.').toLowerCase()}`, { role: 'context', ...leaf });
}

/**
 * The step's own `env:` entries a reference reads: they shadow the job's and the workflow's for the rest of the step,
 * and their values (evaluated against the outer env) are where the reference's value comes from. `env.NAME` reads the
 * one entry of that name; a whole `env` or a computed key reads them all.
 */
function ownEnv(index: ProjectIndex, unit: UnitDecl, site: ExprSite, ref: LocatedRef): Binding[] {
  if (ref.context !== 'env' || site.field === 'step.env') return [];
  const env = index.stepOf(unit, site)?.env ?? {};
  if (!namesMember(ref)) return Object.values(env);
  const own = lookup(env, ref.path[0]!);
  return own ? [own] : [];
}

/** Whether a reference names one member of its context: `env.NAME`, not `toJSON(env)`, `env.*` or `env[expr]`. */
function namesMember(ref: LocatedRef): boolean {
  return namesKey(ref.path[0]);
}

/** Whether a path segment names a key: it is not missing, a `*` filter or a computed `?` index. */
const namesKey = (segment: string | undefined) => !!segment && segment !== '*' && segment !== '?';

/**
 * Whether a whole object or computed key of `secrets`, `matrix`, `env` or `inputs` may hold members the files do not
 * declare. The graph reads it as the declared members (see `ProjectIndex.readsOf`); the context stays a source next to
 * them:
 * - `secrets`, always: `GITHUB_TOKEN` is always there, and `secrets: inherit` passes the caller's other secrets;
 * - `matrix`, when the matrix or part of its `include` is computed at runtime (see `MatrixDecl.includeDynamic`);
 * - `env`, always: in an action it also holds its caller's env, and in a job what was written to `$GITHUB_ENV` before
 *   the site is evaluated. Any step can write it (a `run:` script, also through a script file it runs, or an action,
 *   through `core.exportVariable`), and so can what the runner runs before the first step: the `pre:` steps of the
 *   job's actions and a self-hosted runner's job-started hook. What they write is in the env of every later step;
 * - `inputs`, in an action: the runner puts every `with:` key of the step in it, declared or not, and only warns about
 *   the others;
 * - `github`, when it stops at `github` or at one of its properties (`toJSON(github)`, `github.event`), or takes a
 *   computed key or a `*` filter there (`github[x]`, `github.event.*`): the rest of the context and of the event is
 *   there too, next to the dispatch inputs the graph reads it as.
 * A workflow's `inputs` and `github.event.inputs` hold the declared inputs only: GitHub rejects any other.
 */
function holdsUndeclared(unit: UnitDecl, site: ExprSite, ref: LocatedRef): boolean {
  if (ref.context === 'github') return !namesKey(ref.path[0]) || !namesKey(ref.path[1]);
  if (namesMember(ref)) return false;
  switch (ref.context) {
    case 'secrets':
    case 'env':
      return true;
    case 'matrix':
      return keysAtRuntime(jobOf(unit, site)?.matrix);
    case 'inputs':
      return unit.kind === 'action';
    default:
      return false;
  }
}

/** Whether a matrix has keys only known at runtime: the matrix, or part of its `include`, is an expression. */
function keysAtRuntime(matrix: MatrixDecl | undefined): boolean {
  return !!matrix && (matrix.dynamic || matrix.includeDynamic);
}

/** The job a site of a workflow is in. */
function jobOf(unit: UnitDecl, site: ExprSite): JobDecl | undefined {
  return unit.kind === 'workflow' && site.job ? unit.jobs[site.job] : undefined;
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
