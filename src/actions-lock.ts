/**
 * GitHub's workflow dependency lockfile, `.github/workflows/actions.lock`, written by `gh actions-lock`, Dependabot and
 * Renovate (https://docs.github.com/actions/concepts/security/workflow-dependency-lockfiles). It records the commit each
 * action runs in the workflows it covers, whatever the action's tag or branch points at now. This module reads the file
 * and never writes it. The schema is before 1.0 (v0.0.3 when this was written), so it is read tolerantly: unknown keys
 * are ignored, and a file with a version it does not know is not used.
 */
import { parse as parseYaml } from 'yaml';

export const ACTIONS_LOCK_FILE = '.github/workflows/actions.lock';

/** The schema versions read: v0.0.1 to v0.0.3 so far, which differ in keys this reader does not use. */
const KNOWN_VERSION = /^v0\.0\.\d+$/;

export interface ActionsLock {
  version: string;
  /** Each covered ("onboarded") workflow file, with the pins it uses (by `actionsLockKey`), its actions' own included. */
  workflows: Map<string, Set<string>>;
  /** The commit (40 lowercase hex) each pin runs, by `actionsLockKey`. A pin with a commit in another form is left out. */
  commits: Map<string, string>;
}

/** The file read, or why it cannot be used: it does not parse, does not have the expected shape, or has an unknown version. */
export type ActionsLockRead = { lock: ActionsLock; error?: undefined } | { lock?: undefined; error: string };

/** What the lookup needs of a `uses:` reference: its kind (job-level `uses:` = `workflow`) and `owner/repo@ref`. */
export interface ActionsLockRef {
  kind: 'workflow' | 'action';
  owner: string;
  repo: string;
  ref: string;
}

/** A pin as `actions.lock` keys it: owner and repository in any case, then the ref, without a path. */
export const actionsLockKey = (owner: string, repo: string, ref: string) =>
  `${owner.toLowerCase()}/${repo.toLowerCase()}@${ref}`;

/**
 * A pin's key from the file. `gh actions-lock` writes `owner/repo@ref`; an `owner/repo/path@ref` is keyed by its
 * repository too, because the commit belongs to the repository. Undefined for anything else.
 */
function keyOf(pin: string): string | undefined {
  const m = /^([^/@:]+)\/([^/@:]+)(?:\/[^@:]*)?@([^:]+)$/.exec(pin);
  return m ? actionsLockKey(m[1]!, m[2]!, m[3]!) : undefined;
}

/** A dependency's commit without its algorithm (`sha1-<40 hex>`); undefined for another form. */
const commitOf = (commit: unknown) =>
  typeof commit === 'string' ? /^sha1-([0-9a-f]{40})$/i.exec(commit)?.[1]?.toLowerCase() : undefined;

const workflowPathOf = (path: string) => path.replace(/^\.\//, '');

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads `actions.lock`'s text. The caller reads the file (`ACTIONS_LOCK_FILE`), so this runs in a browser too. */
export function readActionsLock(text: string): ActionsLockRead {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    return { error: `not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  if (!isRecord(data) || typeof data.version !== 'string')
    return { error: 'not a workflow dependency lockfile: it has no version' };
  if (!KNOWN_VERSION.test(data.version))
    return { error: `version ${data.version} is not one this reader knows (v0.0.x)` };
  const workflows = workflowsOf(data.workflows ?? {});
  if (!workflows) return { error: '`workflows` is not a map of workflow files to lists of pins' };
  const commits = commitsOf(data.dependencies ?? {});
  if (!commits) return { error: '`dependencies` is not a map of pins to their commits' };
  return { lock: { version: data.version, workflows, commits } };
}

function workflowsOf(value: unknown): ActionsLock['workflows'] | undefined {
  if (!isRecord(value)) return undefined;
  const workflows = new Map<string, Set<string>>();
  for (const [path, pins] of Object.entries(value)) {
    if (!Array.isArray(pins) || !pins.every((p) => typeof p === 'string')) return undefined;
    const keys = pins.map(keyOf).filter((k) => k !== undefined);
    workflows.set(workflowPathOf(path), new Set(keys));
  }
  return workflows;
}

function commitsOf(value: unknown): ActionsLock['commits'] | undefined {
  if (!isRecord(value)) return undefined;
  const commits = new Map<string, string>();
  for (const [pin, dependency] of Object.entries(value)) {
    if (!isRecord(dependency)) return undefined;
    const key = keyOf(pin);
    const commit = commitOf(dependency.commit);
    if (key && commit) commits.set(key, commit);
  }
  return commits;
}

/**
 * Whether GitHub runs the lock's pin for a reference of this kind and key, used in the workflow at `workflowPath`. The
 * rule lives here alone, so that what the lab finds changes one function.
 *
 * - Documented: the lock pins actions only, the actions they use included. It "doesn't pin calls to reusable
 *   workflows (`jobs.<job_id>.uses`)", and a reusable workflow's own actions are pinned by the lockfile of the
 *   repository that defines it, not by the caller's.
 * - **Assumed, UNVERIFIED** (simulci lab case R9): the pin applies only where `workflowPath` is a covered workflow
 *   whose own list names it. The docs onboard workflows one at a time, but that an uncovered workflow using the same
 *   `owner/repo@ref` resolves the ref as usual, rather than running the pinned commit, has not been observed. A covered
 *   workflow that uses an action its list lacks fails on GitHub; here it simply has no pin.
 */
function pinApplies(
  lock: ActionsLock,
  workflowPath: string,
  kind: ActionsLockRef['kind'],
  key: string,
): boolean {
  return kind === 'action' && (lock.workflows.get(workflowPathOf(workflowPath))?.has(key) ?? false);
}

/**
 * The commit GitHub runs for `ref` where the workflow at `workflowPath` (repository-relative, `.github/workflows/ci.yml`)
 * uses it, directly or through its actions; undefined when the lock pins none there (see `pinApplies`). A reference with
 * a path (`actions/cache/restore@v4`) is pinned by its repository's key (`actions/cache@v4`).
 */
export function actionsLockCommit(
  lock: ActionsLock | undefined,
  workflowPath: string,
  ref: ActionsLockRef,
): string | undefined {
  if (!lock) return undefined;
  const key = actionsLockKey(ref.owner, ref.repo, ref.ref);
  return pinApplies(lock, workflowPath, ref.kind, key) ? lock.commits.get(key) : undefined;
}
