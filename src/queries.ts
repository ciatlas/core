import type { CallSite, ProjectIndex } from './graph';
import type { ExprSite, LocatedRef, UnitDecl, WorkflowDecl } from './ir';

/** Every reference in a unit's expressions, with the site it is in. */
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

/** Workflows that are only ever invoked via `workflow_call`. */
export function isCallOnly(wf: WorkflowDecl): boolean {
  return wf.triggers.length === 1 && wf.triggers[0] === 'workflow_call';
}

/** Secrets every workflow can read without declaring them (lowercase): the automatic `GITHUB_TOKEN`. */
export const BUILTIN_SECRETS: ReadonlySet<string> = new Set(['github_token']);

/**
 * The secrets a workflow needs from its caller: those it, or a callee it hands every secret to through
 * `secrets: inherit`, reads (see `secretsNeededBy`).
 */
export interface NeededSecrets {
  /** The secrets read by name, as written, without the automatic `GITHUB_TOKEN`. */
  names: Set<string>;
  /**
   * Set when one of them reads the whole `secrets` context or a computed key of it (`toJSON(secrets)`, `secrets.*`,
   * `secrets[inputs.name]`): the workflow then needs every secret it gets, named or not. Through `secrets: inherit`,
   * that is every secret its caller has, so no list of names stands for it.
   */
  all: boolean;
}

/**
 * The secrets a workflow reads, plus those read by the callees it hands every secret to through `secrets: inherit`, and
 * theirs in turn. A callee called with `secrets:` is not followed: it gets only the secrets named there, which the
 * caller reads by name to pass them.
 */
export function secretsNeededBy(
  index: ProjectIndex,
  wf: WorkflowDecl,
  seen = new Set<string>(),
): NeededSecrets {
  const out: NeededSecrets = { names: new Set(), all: false };
  if (seen.has(wf.path)) return out;
  seen.add(wf.path);
  for (const { ref } of refsOf(wf)) addSecretRead(out, ref);
  for (const callee of inheritCallees(index, wf)) {
    const inner = secretsNeededBy(index, callee, seen);
    for (const name of inner.names) out.names.add(name);
    if (inner.all) out.all = true;
  }
  return out;
}

/** Counts a reference of `secrets`: one secret by name, or every secret for a whole object or a computed key. */
function addSecretRead(out: NeededSecrets, ref: LocatedRef): void {
  if (ref.context !== 'secrets') return;
  const name = ref.path[0];
  if (!name || name === '*' || name === '?') out.all = true;
  else if (!BUILTIN_SECRETS.has(name.toLowerCase())) out.names.add(name);
}

/** The workflows a workflow's jobs call with `secrets: inherit`. */
function inheritCallees(index: ProjectIndex, wf: WorkflowDecl): WorkflowDecl[] {
  return Object.values(wf.jobs).flatMap((job) => {
    const callee = job.secretsInherit ? index.calleeOf(job) : undefined;
    return callee ? [callee] : [];
  });
}

/**
 * Whether a workflow needs the secret `name` from its caller: it, or a callee it hands every secret to, reads it by
 * name (ignoring case) or reads every secret (see `NeededSecrets.all`). Never the automatic `GITHUB_TOKEN`, which every
 * workflow gets without being passed it.
 */
export function needsSecret(needed: NeededSecrets, name: string): boolean {
  const lower = name.toLowerCase();
  if (BUILTIN_SECRETS.has(lower)) return false;
  return needed.all || [...needed.names].some((n) => n.toLowerCase() === lower);
}
