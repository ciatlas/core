import type { MissingTarget, Project, UnverifiedUse, WorkspaceCaller } from './graph';
import type { ActionDecl, Binding, JobDecl, StepDecl, UnitDecl, UsesRef, WorkflowDecl } from './ir';
import type { Logger } from './logger';
import { normalizeRelative } from './parse';
import { type ScriptWrite, scriptWrites, writesTo } from './script-writes';
import { formatLoc, type Loc } from './source';

/**
 * The runner's workspace as far as a job's steps reveal it. A step's `uses: ./path` is resolved against the workspace
 * (GITHUB_WORKSPACE), not the repository, so what `./path` means depends on the `actions/checkout` steps before it.
 */
export interface Workspace {
  /** What is checked out where; the deepest mount containing a path decides what the path is. */
  mounts: Mount[];
  /** An `actions/checkout` step ran, so the layout no longer rests on the assumed checkout at the root. */
  managed: boolean;
  /** The last checkout to a path computed at runtime (`path: ${{ ... }}`): it may hold any path. */
  dynamic?: { path: string; repository?: string; loc: Loc };
  /**
   * Paths earlier steps' scripts write to (`cp -r tools/act dist/act`), in this action or job or in a caller: what is
   * there exists only at runtime.
   */
  writes: (ScriptWrite & { loc: Loc })[];
}

export interface Mount {
  /** Normalized workspace path; `.` is the workspace root. */
  path: string;
  /** Another repository (`owner/repo`, or the expression computing it); absent for this repository. */
  repository?: string;
  /** A `ref:` of this repository other than the running commit (`main`, `${{ github.base_ref }}`). */
  ref?: string;
  /** The `actions/checkout` step; absent for the assumed checkout of this repository at the root. */
  loc?: Loc;
}

/**
 * Before any checkout, assume this repository at the workspace root: most jobs check it out there, possibly through
 * a step flowpact cannot see into, and a `./` action is unusable otherwise.
 */
export const initialWorkspace = (): Workspace => ({ mounts: [{ path: '.' }], managed: false, writes: [] });

const CHECKOUT = /^actions\/checkout(?:@|$)/i;
/**
 * Contexts naming the workflow's own repository, or the fork a pull request comes from (the same tree at another
 * commit, as far as local actions go).
 */
const OWN_REPOSITORY =
  /^github\.(?:repository|event\.repository\.full_name|event\.pull_request\.(?:head|base)\.repo\.full_name|event\.workflow_run\.head_repository\.full_name)$/;
/**
 * Contexts naming the commit the workflow runs, or the head of the pull request it runs for: the files flowpact reads
 * (as far as local actions go).
 */
const RUNNING_REF =
  /^github\.(?:sha|ref|ref_name|head_ref|event\.(?:after|head_commit\.id|release\.tag_name|pull_request\.(?:head\.(?:sha|ref)|merge_commit_sha)|workflow_run\.head_(?:sha|branch)|merge_group\.head_(?:sha|ref)|check_(?:suite|run)\.head_sha))$/;
const PULL_REQUEST_REF =
  /^refs\/pull\/\$\{\{\s*github\.event\.(?:pull_request\.)?number\s*\}\}\/(?:merge|head)$/;

/** The values an expression can take: each `||` alternative, and of `cond && value`, the value. */
function alternatives(value: string): string[] | undefined {
  const m = /^\$\{\{(.*)\}\}$/s.exec(value);
  if (!m) return undefined;
  return m[1]!.split('||').map((alt) =>
    alt
      .split('&&')
      .at(-1)!
      .trim()
      .replace(/^\((.*)\)$/s, '$1')
      .trim(),
  );
}

/** `${{ a || b }}` where every alternative names this repository (or a pull request's fork of it). */
const ownRepositoryExpression = (value: string) =>
  !!alternatives(value)?.every((a) => OWN_REPOSITORY.test(a));

/** Whether a checkout's `ref:` is the running commit (or the pull request's head): none, or one of those contexts. */
const runningCommit = (value: string) =>
  value === '' || PULL_REQUEST_REF.test(value) || !!alternatives(value)?.every((a) => RUNNING_REF.test(a));

export const isCheckout = (uses: UsesRef): boolean => CHECKOUT.test(uses.raw.trim());

const escapes = (path: string) => path === '..' || path.startsWith('../') || path.startsWith('/');

const text = (b: Binding | undefined): string =>
  b === undefined || b.value === null || typeof b.value === 'object' ? '' : String(b.value).trim();

/** `with.repository` of a checkout: `undefined` for this repository. */
function checkoutRepository(b: Binding | undefined, repository: string | undefined): string | undefined {
  const value = text(b);
  if (value === '' || ownRepositoryExpression(value)) return undefined;
  if (repository && value.toLowerCase() === repository.toLowerCase()) return undefined;
  return value;
}

/**
 * `with.path` of a checkout: a workspace path, `dynamic` when computed at runtime, or `outside` the workspace (which
 * actions/checkout rejects: the step fails).
 */
function checkoutPath(b: Binding | undefined): { path: string } | 'dynamic' | 'outside' {
  // `${{ github.workspace }}/dir` is `dir`; any other expression is only known at runtime.
  const value = text(b)
    .replace(/^\$\{\{\s*github\.workspace\s*\}\}(?:\/|$)/, '')
    .replaceAll('\\', '/');
  if (value.includes('${{')) return 'dynamic';
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return 'outside';
  const path = normalizeRelative(value);
  return escapes(path) ? 'outside' : { path };
}

const within = (path: string, dir: string) => dir === '.' || path === dir || path.startsWith(`${dir}/`);

/** The workspace after an `actions/checkout` step: it replaces whatever was at its path (and below). */
export function applyCheckout(ws: Workspace, step: StepDecl, repository: string | undefined): Workspace {
  const loc = step.uses?.loc ?? step.loc;
  const other = checkoutRepository(step.with.repository, repository);
  const placement = checkoutPath(step.with.path);
  // actions/checkout fails on a path outside the workspace, so it changes nothing the steps after it could use.
  if (placement === 'outside') return ws;
  const repo = other !== undefined ? { repository: other } : {};
  if (placement === 'dynamic')
    return { ...ws, managed: true, dynamic: { path: text(step.with.path), ...repo, loc } };
  const { path } = placement;
  const ref = text(step.with.ref);
  const mounts = ws.mounts.filter((m) => !within(m.path, path));
  mounts.push({ path, ...repo, ...(other === undefined && !runningCommit(ref) ? { ref } : {}), loc });
  return {
    mounts,
    managed: true,
    // A checkout at the root empties the whole workspace first, including a checkout to a path computed at runtime.
    ...(ws.dynamic && path !== '.' ? { dynamic: ws.dynamic } : {}),
    writes: ws.writes.filter((w) => !within(w.path, path)),
  };
}

/** The mount holding a workspace path (which must not escape the workspace), and the path inside it. */
export function locate(ws: Workspace, path: string): { mount: Mount; rel: string } {
  // A checkout replaces everything below its path, so the root mount is never removed by a deeper one.
  let best: Mount = ws.mounts.find((m) => m.path === '.') ?? { path: '.' };
  for (const m of ws.mounts)
    if (m.path !== '.' && within(path, m.path) && (best.path === '.' || m.path.length > best.path.length))
      best = m;
  const rel = best.path === '.' ? path : path === best.path ? '.' : path.slice(best.path.length + 1);
  return { mount: best, rel };
}

/** Identifies a workspace for memoizing walks through composite actions. */
export function workspaceKey(ws: Workspace): string {
  return JSON.stringify([
    ws.mounts.map((m) => [m.path, m.repository ?? null, m.ref ?? null, m.loc ? formatLoc(m.loc) : null]),
    ws.managed,
    ws.dynamic ? formatLoc(ws.dynamic.loc) : null,
    ws.writes.map((w) => [w.path, formatLoc(w.loc)]),
  ]);
}

/** Where one step's `uses:` leads in one workspace. */
type Outcome =
  | {
      kind: 'local';
      target: string;
      found: boolean;
      checkout?: { path: string; loc: Loc };
      /**
       * No checkout of this repository is at the workspace root, where the path points: where it is checked out
       * instead (maybe nowhere). A `found` target is then in the repository but not in the workspace.
       */
      elsewhere?: { path: string; loc: Loc }[];
    }
  | { kind: 'unverified'; info: Pick<UnverifiedUse, 'reason' | 'checkout' | 'writer'> }
  /** `$/path@ref`, which GitHub rejects. */
  | { kind: 'invalid' }
  /** `owner/repo/path@ref` of this repository that is not in the working tree: it may exist at that ref. */
  | { kind: 'skip' };

interface StepRecord {
  unit: UnitDecl;
  job?: string;
  step: StepDecl;
  /** Outcomes in workspaces reached from a workflow job, with the composite-action steps leading there (first seen). */
  rooted: Map<string, { outcome: Outcome; via: WorkspaceCaller[] }>;
  /** Outcomes for actions nothing here reaches, in the assumed workspace. */
  assumed: Map<string, { outcome: Outcome; via: WorkspaceCaller[] }>;
}

export interface WorkspaceResolverOptions {
  repository?: string;
  /** Loads the action in a repository directory (`undefined` when it does not exist). */
  loadAction(dir: string): ActionDecl | undefined;
  /** Whether a directory exists in the repository. */
  isDir(dir: string): boolean;
  logger: Logger;
}

/**
 * Resolves steps' local `uses:` by walking jobs in order, through composite actions (whose steps run in the caller's
 * workspace and whose checkouts and scripts change it). An action used from several workspaces gets the outcomes of
 * all of them: its target is where it is found, and a workspace where it is missing is reported with the caller.
 */
export function workspaceResolver(opts: WorkspaceResolverOptions) {
  const records = new Map<StepDecl, StepRecord>();
  /** Workspaces each composite action was walked in, and the workspace it left behind. */
  const walkedIn = new Map<ActionDecl, Map<string, Workspace>>();
  const active = new Set<ActionDecl>();
  /** What each `run:` step writes, parsed once however many workspaces its action is walked in. */
  const stepWrites = new Map<StepDecl, Workspace['writes']>();
  /** A path in one of this repository's top-level directories (such as `.github`): never another checkout's. */
  const inRepositoryDir = (rel: string) => rel === '.' || opts.isDir(rel.split('/')[0]!);

  /** The write that best explains a path: the path itself, then a file in it, then a directory holding it; latest. */
  const writerOf = (ws: Workspace, path: string) => {
    let best: Workspace['writes'][number] | undefined;
    let rank = 3;
    for (const w of ws.writes) {
      if (!writesTo(w, path, opts.isDir)) continue;
      const r = w.path === path ? 0 : w.path.startsWith(`${path}/`) ? 1 : 2;
      if (r <= rank) [best, rank] = [w, r];
    }
    return best;
  };

  const resolve = (uses: UsesRef, ws: Workspace): Outcome => {
    const target = uses.target!;
    if (uses.selfRef !== undefined) return { kind: 'invalid' };
    if (uses.workspacePath === undefined) {
      // `$/path` and `owner/repo/path@ref` of this repository: the repository itself, whatever the workspace holds.
      const found = opts.loadAction(target) !== undefined;
      if (!found && uses.sameRepoRef !== undefined && !escapes(target)) return { kind: 'skip' };
      return { kind: 'local', target, found };
    }
    const path = uses.workspacePath;
    if (escapes(path)) return { kind: 'unverified', info: { reason: 'outside-workspace' } };
    const { mount, rel } = locate(ws, path);
    if (mount.repository !== undefined && mount.loc) {
      const checkout = { repository: mount.repository, path: mount.path, loc: mount.loc };
      return { kind: 'unverified', info: { reason: 'other-repository', checkout } };
    }
    const checkout =
      mount.loc && mount.path !== '.' ? { checkout: { path: mount.path, loc: mount.loc } } : {};
    // Only a checkout of this repository at the root puts it there (before any checkout, it is assumed). A checkout to
    // a path computed at runtime may be at the root.
    const rootless = mount.path === '.' && !mount.loc && ws.managed && !ws.dynamic;
    const elsewhere = () =>
      ws.mounts.flatMap((m) => (m.loc && m.repository === undefined ? [{ path: m.path, loc: m.loc }] : []));
    if (opts.loadAction(rel)) {
      // Verified as the best guess for what the step means, and reported: GitHub looks for it in the workspace.
      if (rootless && !writerOf(ws, path))
        return { kind: 'local', target: rel, found: true, elsewhere: elsewhere() };
      return { kind: 'local', target: rel, found: true, ...checkout };
    }
    const write = writerOf(ws, path);
    if (write) {
      const writer = { loc: write.loc, path: write.path, command: write.command };
      return { kind: 'unverified', info: { reason: 'created-at-runtime', writer } };
    }
    // Another ref of this repository may hold what the working tree does not.
    if (mount.loc && mount.ref !== undefined) {
      const at = { path: mount.path, ref: mount.ref, loc: mount.loc };
      return { kind: 'unverified', info: { reason: 'other-ref', checkout: at } };
    }
    // Without this repository at the root, or with a checkout to a path computed at runtime, a path outside its
    // top-level directories may be some other step's; one inside them (a typo under `.github`) is broken either way.
    if (mount.path === '.' && ((ws.managed && !mount.loc) || ws.dynamic) && !inRepositoryDir(rel)) {
      const dynamic = ws.dynamic ? { checkout: ws.dynamic } : {};
      return { kind: 'unverified', info: { reason: 'not-checked-out', ...dynamic } };
    }
    if (rootless) return { kind: 'local', target: rel, found: false, elsewhere: elsewhere() };
    return { kind: 'local', target: rel, found: false, ...checkout };
  };

  const record = (
    unit: UnitDecl,
    job: string | undefined,
    step: StepDecl,
    outcome: Outcome,
    rooted: boolean,
    via: WorkspaceCaller[],
  ) => {
    let r = records.get(step);
    if (!r) {
      r = { unit, ...(job !== undefined ? { job } : {}), step, rooted: new Map(), assumed: new Map() };
      records.set(step, r);
    }
    const outcomes = rooted ? r.rooted : r.assumed;
    const key = JSON.stringify(outcome);
    if (!outcomes.has(key)) outcomes.set(key, { outcome, via });
  };

  const walk = (
    unit: UnitDecl,
    job: string | undefined,
    steps: StepDecl[],
    start: Workspace,
    rooted: boolean,
    via: WorkspaceCaller[],
  ) => {
    let ws = start;
    for (const step of steps) {
      if (step.run !== undefined) {
        let writes = stepWrites.get(step);
        if (!writes) {
          const loc = step.runLoc ?? step.loc;
          writes = scriptWrites(step.run).map((w) => ({ ...w, loc }));
          stepWrites.set(step, writes);
        }
        if (writes.length) ws = { ...ws, writes: [...ws.writes, ...writes] };
      }
      const uses = step.uses;
      if (!uses) continue;
      if (isCheckout(uses)) {
        ws = applyCheckout(ws, step, opts.repository);
        continue;
      }
      if (uses.kind !== 'local-action' || uses.target === undefined) continue;
      const outcome = resolve(uses, ws);
      record(unit, job, step, outcome, rooted, via);
      const action = outcome.kind === 'local' && outcome.found ? opts.loadAction(outcome.target) : undefined;
      if (action) {
        const caller = {
          from: unit.path,
          ...(job !== undefined ? { job } : {}),
          loc: uses.loc,
          action: action.path,
        };
        ws = enter(action, ws, rooted, [...via, caller]);
      }
    }
    return ws;
  };

  /** Walks a composite action's steps in the caller's workspace; returns the workspace its steps leave behind. */
  const enter = (action: ActionDecl, ws: Workspace, rooted: boolean, via: WorkspaceCaller[]): Workspace => {
    if (active.has(action)) return ws; // an action using itself fails on GitHub; never loop
    const key = `${rooted}|${workspaceKey(ws)}`;
    const seen = walkedIn.get(action) ?? new Map<string, Workspace>();
    walkedIn.set(action, seen);
    const known = seen.get(key);
    if (known) return known;
    active.add(action);
    const after = walk(action, undefined, action.steps, ws, rooted, via);
    active.delete(action);
    seen.set(key, after);
    return after;
  };

  return {
    walkJob(wf: WorkflowDecl, job: JobDecl) {
      walk(wf, job.id, job.steps, initialWorkspace(), true, []);
    },

    /**
     * Actions no workflow here reaches (published ones, or ones used from other repositories) run in an unknown
     * workspace: assume this repository at the root. Those that others among them use go last, so they are walked in
     * their callers' workspaces instead.
     */
    walkRemainingActions(actions: Map<string, ActionDecl>) {
      for (;;) {
        const rest = [...actions.values()].filter((a) => !walkedIn.has(a));
        if (!rest.length) return;
        const used = new Set(rest.flatMap((a) => a.steps.map((s) => s.uses?.target)));
        enter(rest.find((a) => !used.has(a.path)) ?? rest[0]!, initialWorkspace(), false, []);
      }
    },

    /** Settles every step's `uses:` and lists what is missing, invalid or not verifiable. */
    finish(out: {
      missing: Project['missing'];
      invalid: NonNullable<Project['invalidTargets']>;
      unverified: UnverifiedUse[];
    }) {
      for (const r of records.values()) {
        const rooted = r.rooted.size > 0;
        const entries = [...(rooted ? r.rooted : r.assumed).values()];
        const local = entries.flatMap((e) =>
          e.outcome.kind === 'local' ? [{ ...e, outcome: e.outcome }] : [],
        );
        // Found in the workspace anywhere gives the target, then found in the repository, then missing from it, then
        // not verifiable.
        const { outcome } =
          local.find((e) => e.outcome.found && !e.outcome.elsewhere) ??
          local.find((e) => e.outcome.found) ??
          local[0] ??
          entries[0]!;
        const uses = r.step.uses!;
        const where = {
          uses,
          from: r.unit.path,
          ...(r.job !== undefined ? { job: r.job } : {}),
          step: r.step.index,
        };
        if (outcome.kind === 'local') {
          uses.target = outcome.target;
          // Each path that is missing in some workspace. When the step resolves otherwise elsewhere, the failure
          // depends on who runs the action, so it names that caller.
          const fails = (o: Outcome) => o.kind === 'local' && (!o.found || o.elsewhere !== undefined);
          const reported = new Set<string>();
          for (const { outcome: o, via } of local) {
            if (!fails(o) || reported.has(o.target)) continue;
            reported.add(o.target);
            const varies = entries.some(
              (e) => !fails(e.outcome) || (e.outcome.kind === 'local' && e.outcome.target !== o.target),
            );
            const missing: MissingTarget = {
              ...where,
              ...(o.target !== uses.target ? { target: o.target } : {}),
              ...(o.found ? { inRepository: true } : {}),
              ...(o.checkout ? { checkout: o.checkout } : {}),
              ...(o.elsewhere ? { elsewhere: o.elsewhere } : {}),
              ...(varies && rooted && via.length ? { via } : {}),
            };
            out.missing.push(missing);
            const what = o.found ? 'local reference outside the workspace' : 'unresolved local reference';
            opts.logger.warn(`${what} ${uses.raw}`, { from: r.unit.path });
          }
        } else if (outcome.kind === 'unverified') {
          uses.kind = 'workspace-action';
          delete uses.target;
          out.unverified.push({ ...where, ...outcome.info });
          opts.logger.debug(`workspace path not verified (${outcome.info.reason}): ${uses.raw}`, {
            from: r.unit.path,
          });
        } else if (outcome.kind === 'invalid') {
          out.invalid.push({ ...where, reason: 'self-ref' });
        } else {
          opts.logger.debug(`same-repository reference not in the working tree: ${uses.raw}`);
        }
      }
    },
  };
}
