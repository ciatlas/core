import { type GraphNode, type ProjectIndex, sym, type Usage } from './graph';
import { type ExprSite, lookup, type SiteField } from './ir';
import { comboLabel, expandMatrix } from './matrix';
import { secretsNeededBy } from './rules/secrets';
import type { Loc } from './source';

export interface TraceLeaf {
  /** What the value is used for, e.g. `run script`, `condition`, `runs-on`. */
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

function down(
  index: ProjectIndex,
  symbol: string,
  depth: number,
  path: Set<string>,
  expanded: Set<string>,
): TraceNode {
  const node = base(index, symbol);
  if (path.has(symbol)) return { ...node, stop: 'cycle' };
  if (depth <= 0) return { ...node, stop: 'depth' };
  if (expanded.has(symbol)) return { ...node, stop: 'seen' };
  expanded.add(symbol);
  const next = new Set(path).add(symbol);

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
  const secret = /^(.+)#secrets\.(.+)$/.exec(symbol);
  const wf = secret ? index.project.workflows.get(secret[1]!) : undefined;
  if (secret && wf) {
    const name = secret[2]!;
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
  const node = base(index, symbol);
  if (path.has(symbol)) return { ...node, stop: 'cycle' };
  if (depth <= 0) return { ...node, stop: 'depth' };
  if (expanded.has(symbol)) return { ...node, stop: 'seen' };
  expanded.add(symbol);
  const next = new Set(path).add(symbol);

  // One parent per source and expression, even when the expression reads the symbol several times.
  const seenEdges = new Set<string>();
  for (const e of index.incoming(symbol, 'flows')) {
    const key =
      e.siteId !== undefined
        ? `${e.from}@site:${e.siteId}`
        : `${e.from}@${e.loc ? `${e.loc.file}:${e.loc.line}:${e.loc.column}` : ''}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const parent = up(index, e.from, depth - 1, next, expanded);
    const site = e.siteId !== undefined ? index.site(e.siteId) : undefined;
    if (e.loc) parent.via = { loc: e.loc, text: site ? short(site.text) : 'workflow output' };
    node.children.push(parent);
  }
  // A secret received through `secrets: inherit` comes from the caller's secret of the same name.
  const secret = /^(.+)#secrets\.(.+)$/.exec(symbol);
  if (secret) {
    const name = secret[2]!;
    for (const c of index.callersOf(secret[1]!)) {
      if (!c.job.secretsInherit) continue;
      const callerName = (c.caller.call && lookup(c.caller.call.secrets, name)?.name) ?? name;
      const parent = up(index, sym.secret(c.caller.path, callerName), depth - 1, next, expanded);
      parent.via = { loc: c.job.secretsLoc ?? c.job.loc, text: 'secrets: inherit', note: `jobs.${c.job.id}` };
      node.children.push(parent);
    }
  }
  const n = index.nodes.get(symbol);
  // A matrix key's sources are the combinations themselves; show each value and flag where it is missing.
  if (n?.kind === 'matrix' && n.unit) {
    const m = /#jobs\.(.+)\.matrix\.(.+)$/.exec(symbol);
    const wf = index.project.workflows.get(n.unit);
    const job = m && wf ? wf.jobs[m[1]!] : undefined;
    if (job?.matrix && m) {
      const key = m[2]!;
      const exp = expandMatrix(job.matrix);
      if (exp.dynamic) {
        node.leaves.push({
          role: 'dynamic',
          where: `jobs.${job.id}`,
          loc: job.matrix.loc,
          text: 'matrix is computed at runtime',
        });
      }
      for (const combo of exp.combos) {
        const cell = lookup(combo.values, key);
        const others = exp.keys.filter((k) => k.toLowerCase() !== key.toLowerCase());
        node.leaves.push({
          role: cell ? 'value' : 'missing',
          where: comboLabel(combo, others.length ? others : exp.keys),
          loc: job.matrix.loc,
          text: cell ? (cell.known ? JSON.stringify(cell.value) : '<expression>') : `(undefined → '')`,
        });
      }
    }
  }
  // Literal values and omissions by callers of a workflow / users of an action.
  if (n?.kind === 'input' && n.unit) {
    const name = symbol.slice(symbol.indexOf('#inputs.') + '#inputs.'.length);
    const calls = index.callersOf(n.unit);
    for (const c of calls) {
      const b = lookup(c.job.with, name);
      const where = `${c.caller.path} › jobs.${c.job.id}`;
      if (!b)
        node.leaves.push({ role: 'omitted', where, loc: c.job.uses?.loc ?? c.job.loc, text: '(not passed)' });
      else if (!b.site)
        node.leaves.push({ role: 'literal', where, loc: b.valueLoc, text: JSON.stringify(b.value) });
    }
    for (const u of index.usersOf(n.unit)) {
      const b = lookup(u.step.with, name);
      const where = `${u.unit.path}${u.job ? ` › jobs.${u.job.id}` : ''} › steps[${u.step.index}]`;
      if (!b)
        node.leaves.push({
          role: 'omitted',
          where,
          loc: u.step.uses?.loc ?? u.step.loc,
          text: '(not passed)',
        });
      else if (!b.site)
        node.leaves.push({ role: 'literal', where, loc: b.valueLoc, text: JSON.stringify(b.value) });
    }
  }
  return node;
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
