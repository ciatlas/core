/**
 * The remote references a project names, each resolved where it is written: a `uses:` in another repository's unit
 * (see `Project.external`) names that repository's files, at its commit, never the caller's. One resolver serves the
 * fetch closure and every host that follows a call into a remote, so they never disagree on a key.
 */
import type { Project } from './graph';
import type { RemoteOrigin, UnitDecl, UsesRef } from './ir';
import { createParseContext, parseActionFile, parseWorkflowFile } from './parse';
import {
  fetchRemoteSourceAt,
  type RemoteFailureKind,
  RemoteFetchError,
  type RemoteFetchOptions,
  type RemoteSource,
  type RemoteSourceCache,
  resolveRemoteCommit,
} from './remote-fetch';
import { isFullSha, parseRemoteRef, type RemoteKind, type RemoteRef, remoteKey } from './remote-ref';

/** GitHub calls only workflows directly inside `.github/workflows`, matching the directory's case exactly. */
const CALLABLE = /^\.github\/workflows\/[^/]+\.[yY][aA]?[mM][lL]$/;

/**
 * The remote reference a `uses:` names, or undefined when it names none: a remote `uses:` as written; and inside an
 * external unit, whose `./` and same-repository references name its own repository, a same-repository reference as
 * written, and a job's `./path` or a `$/path` as `<owner>/<repo>/<path>@<origin.sha ?? origin.ref>` (the commit of the
 * unit that names it). A step's `./path` is the runner's workspace, usually the caller's checkout, so it names none; nor
 * does anything local in a local unit, nor anything in an external unit without an `origin`.
 */
export function remoteRefOfUses(unit: UnitDecl, uses: UsesRef): RemoteRef | undefined {
  const kind: RemoteKind = uses.kind.endsWith('workflow') ? 'workflow' : 'action';
  if (uses.kind === 'remote-workflow' || uses.kind === 'remote-action') return parseRemoteRef(uses.raw, kind);
  if (uses.kind !== 'local-workflow' && uses.kind !== 'local-action') return undefined;
  if (!unit.external || !unit.origin || uses.workspacePath !== undefined) return undefined;
  if (uses.self || (kind === 'workflow' && uses.raw.trim().startsWith('./')))
    return uses.selfRef === undefined && uses.target ? atOrigin(unit.origin, uses.target, kind) : undefined;
  return parseRemoteRef(uses.raw, kind);
}

/** A path of an external unit's repository, at the unit's commit; undefined for one GitHub would not run. */
function atOrigin(o: RemoteOrigin, target: string, kind: RemoteKind): RemoteRef | undefined {
  if (kind === 'workflow' ? !CALLABLE.test(target) : target === '..' || target.startsWith('../'))
    return undefined;
  return parseRemoteRef(`${o.owner}/${o.repo}${target === '.' ? '' : `/${target}`}@${o.sha ?? o.ref}`, kind);
}

/**
 * The remote references of `units` (by default the project's workflows and actions and its external units), each once
 * by `remoteKey`, sorted by it. Give `units` to scope them, as to the units some paths reach.
 */
export function remoteRefsOf(
  project: Project,
  units: Iterable<UnitDecl> = [
    ...project.workflows.values(),
    ...project.actions.values(),
    ...(project.external?.values() ?? []),
  ],
): RemoteRef[] {
  const out = new Map<string, RemoteRef>();
  for (const unit of units)
    for (const uses of usesOf(unit)) {
      const r = remoteRefOfUses(unit, uses);
      if (r && !out.has(remoteKey(r.raw))) out.set(remoteKey(r.raw), r);
    }
  return [...out].sort(([a], [b]) => compare(a, b)).map(([, r]) => r);
}

function* usesOf(unit: UnitDecl): Generator<UsesRef> {
  const users =
    unit.kind === 'action' ? unit.steps : Object.values(unit.jobs).flatMap((j) => [j, ...j.steps]);
  for (const { uses } of users) if (uses) yield uses;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The commit to read a remote reference at, and the digest its file must have when the host knows it. */
export interface RemotePin {
  sha: string;
  digest?: string;
}

export interface RemoteClosure {
  /** What was read, sorted by `remoteKey` of the reference, then commit. */
  sources: RemoteSource[];
  /** What could not be resolved or read, once per `remoteKey`, sorted by it. */
  failed: { ref: string; kind: RemoteFailureKind; error: string }[];
  /** The references past `maxDepth` or `maxUnits` that nothing else read, sorted by `remoteKey`. */
  limited: string[];
}

export interface RemoteClosureOptions extends RemoteFetchOptions {
  /** Whether a reference with no pin and no full-SHA ref is resolved live (else it is not read). */
  resolveUnpinned: boolean;
  /** How deep to follow: the project's own references are at depth 1. Default 10. */
  maxDepth?: number;
  /** How many sources to read at most. Default 200. */
  maxUnits?: number;
}

/** A reference to read, and the source whose body names it (none for the project's own). */
interface Found {
  ref: RemoteRef;
  parent?: RemoteSource;
}

/**
 * The remote sources a project reaches: its own remote references, then the ones each source read names (resolved by
 * `remoteRefOfUses`, so a `./` inside a remote is read at that remote's commit), breadth first. Each reference is read
 * at `pin`'s commit, which may depend on the source that names it; else at its ref when that is a full SHA; else, with
 * `resolveUnpinned`, at the commit its ref points at now (resolved once per reference); else not at all. A reference
 * at a commit is read once, so cycles stop.
 *
 * A `RemoteFetchError` is recorded in `failed`; anything else (an abort, a host's `pin` throwing) rejects.
 */
export async function fetchRemoteClosure(
  project: Project,
  pin: (r: RemoteRef, parent?: RemoteSource) => RemotePin | undefined | Promise<RemotePin | undefined>,
  opts: RemoteClosureOptions,
): Promise<RemoteClosure> {
  const run: RemoteFetchOptions = { ...opts, unreachableHosts: opts.unreachableHosts ?? new Map() };
  const { maxDepth = 10, maxUnits = 200, concurrency = 8 } = opts;
  const sources: RemoteSource[] = [];
  const failed = new Map<string, RemoteClosure['failed'][number]>();
  const limited = new Map<string, string>();
  const read = new Set<string>();
  const resolved = new Map<string, Promise<string>>();
  const progress = { done: 0, total: 0 };
  const report = (ref: string, outcome: 'fetched' | 'cached' | 'failed') =>
    opts.onProgress?.({ done: ++progress.done, total: progress.total, ref, outcome });
  const fail = (r: RemoteRef, e: unknown) => {
    if (!(e instanceof RemoteFetchError)) throw e;
    failed.set(remoteKey(r.raw), { ref: r.raw, kind: e.kind, error: e.message });
  };

  const commitOf = async ({ ref, parent }: Found): Promise<RemotePin | undefined> => {
    const pinned = (await pin(ref, parent)) ?? (isFullSha(ref.ref) ? { sha: ref.ref } : undefined);
    if (pinned || !opts.resolveUnpinned) return pinned;
    const key = remoteKey(ref.raw);
    if (!resolved.has(key)) resolved.set(key, resolveRemoteCommit(ref, run));
    try {
      return { sha: await resolved.get(key)! };
    } catch (e) {
      const first = !failed.has(key);
      fail(ref, e);
      if (first) {
        progress.total++;
        report(ref.raw, 'failed');
      }
      return undefined;
    }
  };

  let level = remoteRefsOf(project, [...project.workflows.values(), ...project.actions.values()]).map(
    (ref): Found => ({ ref }),
  );
  for (let depth = 1; level.length; depth++) {
    if (depth > maxDepth) {
      for (const { ref } of level) limited.set(remoteKey(ref.raw), ref.raw);
      break;
    }
    const pins = await mapLimited(level, concurrency, commitOf);
    const admitted: (Found & RemotePin)[] = [];
    level.forEach((found, i) => {
      const p = pins[i];
      const key = remoteKey(found.ref.raw);
      if (!p || read.has(`${key}@${p.sha.toLowerCase()}`)) return;
      if (read.size >= maxUnits) limited.set(key, found.ref.raw);
      else {
        read.add(`${key}@${p.sha.toLowerCase()}`);
        admitted.push({ ...found, ...p });
      }
    });
    progress.total += admitted.length;
    const next: Found[] = [];
    await mapLimited(admitted, concurrency, async ({ ref, sha, digest }) => {
      const cache = opts.cache && watched(opts.cache);
      try {
        const source = await fetchRemoteSourceAt(ref, sha, {
          ...run,
          ...(cache ? { cache } : {}),
          ...(digest !== undefined ? { expectDigest: digest } : {}),
        });
        sources.push(source);
        for (const child of remoteRefsOf(project, [unitOf(source)]))
          next.push({ ref: child, parent: source });
        report(ref.raw, cache && !cache.kept ? 'cached' : 'fetched');
      } catch (e) {
        fail(ref, e);
        report(ref.raw, 'failed');
      }
    });
    level = next.sort((a, b) => compare(foundKey(a), foundKey(b)));
  }

  const done = new Set([...sources.map((s) => remoteKey(s.ref.raw)), ...failed.keys()]);
  return {
    sources: sources.sort(
      (a, b) => compare(remoteKey(a.ref.raw), remoteKey(b.ref.raw)) || compare(a.sha, b.sha),
    ),
    failed: [...failed].sort(([a], [b]) => compare(a, b)).map(([, f]) => f),
    limited: [...limited]
      .filter(([key]) => !done.has(key))
      .sort(([a], [b]) => compare(a, b))
      .map(([, raw]) => raw),
  };
}

/** A cache that notes whether anything was kept in it: a read that kept nothing came from the cache. */
function watched(cache: RemoteSourceCache): RemoteSourceCache & { kept: boolean } {
  return {
    kept: false,
    get: (key) => cache.get(key),
    set(key, bytes) {
      this.kept = true;
      return cache.set(key, bytes);
    },
  };
}

/** A found reference's order: by its key, then by the source that names it. */
const foundKey = ({ ref, parent }: Found) =>
  `${remoteKey(ref.raw)}\n${parent ? `${remoteKey(parent.ref.raw)}@${parent.sha}` : ''}`;

/** A source's unit, parsed as its own repository's at the commit it was read at (as `loadProject`'s `remotes`). */
function unitOf({ ref: r, sha, text }: RemoteSource): UnitDecl {
  const ctx = createParseContext(`${r.owner}/${r.repo}`);
  const unit =
    r.kind === 'workflow' ? parseWorkflowFile(r.raw, text, ctx) : parseActionFile(r.raw, r.raw, text, ctx);
  return { ...unit, external: true, origin: { owner: r.owner, repo: r.repo, path: r.path, ref: r.ref, sha } };
}

/** `work` over each item, `limit` at a time, the results in the items' order. */
async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return out;
}
