import { type ConditionUse, conditionUses, findTemplateSegments } from '../expressions';
import type { CallSite, ProjectIndex } from '../graph';
import type { ExprSite, LocatedRef, UnitDecl, WorkflowDecl } from '../ir';
import { escapeControl } from '../text';
import type { RelatedLocation } from './types';

/**
 * True when a condition site is one expression — bare, or a single `${{ }}` with nothing around it — rather than a
 * string with interpolations (which is always truthy when not empty).
 */
export function isWholeExpression(site: ExprSite): boolean {
  if (site.segments.length !== 1) return false;
  const templated = findTemplateSegments(site.text);
  return (
    templated.length === 0 ||
    (templated.length === 1 && site.text.trim() === site.text.slice(templated[0]!.start, templated[0]!.end))
  );
}

/** How a condition site uses a reference: only the value of a whole-expression `if:` decides by truthiness. */
export function useInCondition(site: ExprSite, ref: LocatedRef): ConditionUse | undefined {
  const seg = site.segments.find((s) => s.refs.includes(ref));
  return seg ? conditionUses(seg.expr, isWholeExpression(site)).get(ref.start) : undefined;
}

export function* refsOf(unit: UnitDecl): Generator<{ site: ExprSite; ref: LocatedRef }> {
  for (const site of unit.sites)
    for (const seg of site.segments) for (const ref of seg.refs) yield { site, ref };
}

/**
 * True when a unit reads a context as a whole or through a computed key (`toJSON(inputs)`, `inputs[matrix.k]`),
 * which makes "never read" conclusions unsafe.
 */
export function readsContextDynamically(unit: UnitDecl, context: string): boolean {
  // An expression we could not parse may read anything, so "never read" cannot be concluded.
  if (unit.parseErrors.length > 0 || unit.sites.some((s) => s.segments.some((seg) => seg.expr.error)))
    return true;
  for (const { ref } of refsOf(unit)) {
    // `needs.build.outputs[matrix.k]` names its job: the graph counts it as a read of each output of that job.
    if (ref.context === context && ref.dynamic && !namesOwner(ref)) return true;
    if (context === 'inputs' && ref.context === 'github' && ref.path[0] === 'event') {
      if (
        ref.path.length === 1 ||
        (ref.path[1] === 'inputs' && (ref.path.length === 2 || ref.path[2] === '?'))
      )
        return true;
    }
  }
  return false;
}

/** A computed read of outputs whose job or step is named statically (see `ProjectIndex.readsOf`). */
function namesOwner(ref: LocatedRef): boolean {
  const owner = ref.path[0];
  return (
    (ref.context === 'needs' || ref.context === 'jobs' || ref.context === 'steps') &&
    owner !== undefined &&
    owner !== '?' &&
    owner !== '*'
  );
}

/** Shortest call chain from a top-level workflow down to `target` (outermost call first). */
export function chainTo(index: ProjectIndex, target: string): CallSite[] {
  const queue: { path: string; chain: CallSite[] }[] = [{ path: target, chain: [] }];
  const seen = new Set([target]);
  // Only reached when every path loops back (a cycle); fall back to the longest chain seen.
  let fallback: CallSite[] = [];
  while (queue.length) {
    const { path, chain } = queue.shift()!;
    const callers = index.callersOf(path);
    if (callers.length === 0) return chain;
    if (chain.length > fallback.length) fallback = chain;
    for (const c of callers) {
      if (seen.has(c.caller.path)) continue;
      seen.add(c.caller.path);
      queue.push({ path: c.caller.path, chain: [c, ...chain] });
    }
  }
  return fallback;
}

export function chainRelated(chain: CallSite[]): RelatedLocation[] {
  return chain.map((c) => ({
    loc: c.job.uses?.loc ?? c.job.loc,
    message: `jobs.${c.job.id} calls ${c.callee.path}`,
  }));
}

export function editDistance(a: string, b: string): number {
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

/** Quotes a name from the analyzed YAML, making control characters (incl. newlines) visible. */
export const quote = (s: string) => `"${escapeControl(s)}"`;

export function listNames(names: string[], max = 6): string {
  if (names.length === 0) return '(none)';
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, … (+${names.length - max})` : shown;
}

/** Workflows that are only ever invoked via `workflow_call`. */
export function isCallOnly(wf: WorkflowDecl): boolean {
  return wf.triggers.length === 1 && wf.triggers[0] === 'workflow_call';
}
