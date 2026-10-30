/**
 * Remote sources kept in a directory, for the fetcher's `cache` on a Node.js host: each file at
 * `<dir>/<host>/<owner>/<repo>/<sha>/<file>`. A file at a commit never changes, so nothing in it goes stale, and any of it
 * can be deleted at any time; the commits it holds are pruned, the least recently used first. Several processes may
 * share one directory: a file is written to a temporary name and renamed, so a reader never sees half of it.
 *
 * Whether to keep a directory at all (in CI, say) is the host's choice; `memoryRemoteCache` is the alternative.
 */
import { randomBytes } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { RemoteSourceCache, RemoteSourceKey } from './remote-fetch';

/** A commit in the cache: a source's key without its file. */
export type RemoteCacheCommit = Omit<RemoteSourceKey, 'file'>;

/** What became of bytes given to the cache: written, there already, not cachable (an unsafe path), or why not. */
export type RemoteCacheWrite = 'written' | 'present' | 'unsafe' | { failed: string };

export interface DirectoryRemoteCache extends RemoteSourceCache {
  readonly dir: string;
  get(key: RemoteSourceKey): Uint8Array | undefined;
  set(key: RemoteSourceKey, bytes: Uint8Array): void;
  /** `set`, saying what became of the bytes. Never throws. */
  write(key: RemoteSourceKey, bytes: Uint8Array): RemoteCacheWrite;
  /** The cached file's path on disk, for an editor to open; undefined when it is not cached. */
  locate(key: RemoteSourceKey): string | undefined;
}

export interface DirectoryRemoteCacheOptions {
  /**
   * The most the directory holds, in bytes (128 MiB by default): over that after a write, the least recently used
   * commits are removed, never one this cache read or wrote. The size is read from disk once, at the first write.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

const FULL_SHA = /^[0-9a-f]{40}$/;

/** Names Windows reserves for devices, with any extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Whether a part of a path is a file name on every platform: not empty, `.` or `..`, without a separator, a drive's
 * colon, another character Windows rejects or a control character (NUL among them), not ending in a dot or a space,
 * and no device name.
 */
function safeName(s: string): boolean {
  if (s === '' || s === '.' || s === '..' || /[<>:"/\\|?*]/.test(s) || /[. ]$/.test(s)) return false;
  if (WINDOWS_RESERVED.test(s)) return false;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return false;
  return true;
}

/** A commit's parts in the cache: in lower case, as GitHub matches host, owner and repository in any case. */
const commitParts = (c: RemoteCacheCommit) => [c.host, c.owner, c.repo, c.sha].map((p) => p.toLowerCase());

/** A commit's directory, `<dir>/<host>/<owner>/<repo>/<sha>`; undefined when a part could not be a file name safely. */
function commitDir(dir: string, c: RemoteCacheCommit): string | undefined {
  const parts = commitParts(c);
  return FULL_SHA.test(parts[3]!) && parts.every(safeName) ? join(dir, ...parts) : undefined;
}

/**
 * Where a remote source is kept: `<dir>/<host>/<owner>/<repo>/<sha>/<file>`, host, owner, repository and commit in lower
 * case (as `memoryRemoteCache` keys them), and the file as the repository names it: `Deploy.yml` and `deploy.yml` are two
 * files. Undefined when a part could
 * not be a file name safely (`..`, an absolute path, a drive, NUL, a character Windows rejects): such a file is not
 * cached. `file` comes from remote content, so this is the guard against a path that leaves the directory.
 */
export function remoteCachePath(dir: string, key: RemoteSourceKey): string | undefined {
  const at = commitDir(dir, key);
  const parts = key.file.split('/');
  return at && parts.every(safeName) ? join(at, ...parts) : undefined;
}

/**
 * Whether the file at `path` is named exactly `file` below its commit's directory, through no link: on a file system
 * that ignores case, `deploy.yml` would otherwise open `Deploy.yml`, another file of the same commit.
 */
function exactly(at: string, file: string, path: string): boolean {
  const real = realpathSync.native(path);
  const base = realpathSync.native(at);
  return (
    real.startsWith(base + sep) &&
    real
      .slice(base.length + 1)
      .split(sep)
      .join('/') === file
  );
}

/** Marks a commit as just used, so pruning removes it last (the time of its directory). */
function touch(at: string): void {
  const now = new Date();
  try {
    utimesSync(at, now, now);
  } catch {
    // Pruned meanwhile: nothing to mark.
  }
}

/** Removes a file if it is there; when its directory is not even one, there is nothing to remove. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // ENOTDIR and the like: the temporary file was never written.
  }
}

/** The key of a commit, for the set of those a cache used. */
const commitId = (c: RemoteCacheCommit) => commitParts(c).join('/');

/** The path of a source cached in `dir` under exactly its key; undefined when it is not there. */
function locateIn(dir: string, key: RemoteSourceKey): string | undefined {
  const path = remoteCachePath(dir, key);
  const at = commitDir(dir, key);
  if (!path || !at) return undefined;
  try {
    return exactly(at, key.file, path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a file found where a source goes is that source: there under exactly its name, through no link. */
const presentIn = (dir: string, key: RemoteSourceKey): RemoteCacheWrite =>
  locateIn(dir, key)
    ? 'present'
    : { failed: `${key.file} is taken by another name, a link or one in another case` };

/** Writes a source to `dir` unless it is there: to a temporary file, then renamed, so a reader never sees half of it. */
function writeIn(dir: string, key: RemoteSourceKey, bytes: Uint8Array): RemoteCacheWrite {
  const path = remoteCachePath(dir, key);
  if (!path) return 'unsafe';
  if (existsSync(path)) return presentIn(dir, key);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    // The bytes are a file another repository serves, kept on purpose: never run, at most what the fetcher accepts
    // (1 MB by default), digest-checked by it, under a path whose every part was checked above, read-only.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, bytes, { mode: 0o400, flag: 'wx' });
    renameSync(tmp, path);
    return 'written';
  } catch (e) {
    removeQuietly(tmp);
    // Another process wrote it first (Windows refuses the rename then); a file at a commit is the same file.
    return existsSync(path) ? presentIn(dir, key) : { failed: (e as Error).message };
  }
}

/**
 * A `RemoteSourceCache` in a directory, created when first written. Files are written read-only, and directories for
 * your user alone: the files of private repositories land here too. Never throws: a failure is a miss, or not kept.
 */
export function directoryRemoteCache(
  dir: string,
  opts: DirectoryRemoteCacheOptions = {},
): DirectoryRemoteCache {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const used = new Set<string>();
  /** The directory's size as of the last prune and the writes since; unknown until the first write. */
  let size: number | undefined;
  const use = (key: RemoteSourceKey) => {
    touch(commitDir(dir, key)!);
    used.add(commitId(key));
  };
  const write = (key: RemoteSourceKey, bytes: Uint8Array): RemoteCacheWrite => {
    const outcome = writeIn(dir, key, bytes);
    if (outcome === 'present') use(key);
    if (outcome !== 'written') return outcome;
    use(key);
    if (size !== undefined) size += bytes.byteLength;
    if (size === undefined || size > maxBytes)
      size = pruneRemoteCache(dir, { maxBytes, keep: (c) => used.has(commitId(c)) }).bytes;
    return outcome;
  };
  return {
    dir,
    get(key) {
      const path = locateIn(dir, key);
      if (!path) return undefined;
      try {
        const bytes = new Uint8Array(readFileSync(path));
        use(key);
        return bytes;
      } catch {
        return undefined;
      }
    },
    set(key, bytes) {
      write(key, bytes);
    },
    write,
    locate: (key) => locateIn(dir, key),
  };
}

export interface RemoteCachePruneOptions {
  /** The most the directory keeps, in bytes: over that, the least recently used commits go first. */
  maxBytes?: number;
  /** How many of the most recently used commits of each repository to keep; 0 empties the cache. */
  keepCommits?: number;
  /** Commits never removed: those the process that prunes uses. */
  keep?: (commit: RemoteCacheCommit) => boolean;
}

/** What a prune did: how many commits it removed, the bytes left, and why one could not be removed. */
export interface RemoteCachePruned {
  removed: number;
  bytes: number;
  failed?: string;
}

/** A commit's directory found in the cache, with when it was last used and the bytes of its files. */
interface Found extends RemoteCacheCommit {
  path: string;
  time: number;
  bytes: number;
}

/**
 * Removes commits from a directory cache: beyond `keepCommits` of each repository, then the least recently used while
 * it holds over `maxBytes`. Only directories named by a commit at `<host>/<owner>/<repo>/<sha>` are removed, never a link
 * or anything else put there, then the directories left empty above them. Never throws.
 */
export function pruneRemoteCache(dir: string, opts: RemoteCachePruneOptions): RemoteCachePruned {
  const out: RemoteCachePruned = { removed: 0, bytes: 0 };
  const left = new Set(commitsIn(dir));
  const remove = (c: Found) => {
    if (opts.keep?.(c) || !removeCommit(c, out)) return false;
    left.delete(c);
    removeIfEmpty(join(dir, c.host, c.owner, c.repo));
    removeIfEmpty(join(dir, c.host, c.owner));
    removeIfEmpty(join(dir, c.host));
    return true;
  };
  if (opts.keepCommits !== undefined) for (const c of beyond(left, opts.keepCommits)) remove(c);
  out.bytes = [...left].reduce((n, c) => n + c.bytes, 0);
  const max = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  for (const c of [...left].sort((a, b) => a.time - b.time)) {
    if (out.bytes <= max) break;
    if (remove(c)) out.bytes -= c.bytes;
  }
  return out;
}

/** Removes a commit's directory, counting it, or noting why it could not. */
function removeCommit(c: Found, out: RemoteCachePruned): boolean {
  try {
    rmSync(c.path, { recursive: true, force: true });
    out.removed++;
    return true;
  } catch (e) {
    out.failed ??= (e as Error).message;
    return false;
  }
}

/** The commits of each repository beyond its `keep` most recently used. */
function beyond(commits: Iterable<Found>, keep: number): Found[] {
  const byRepo = new Map<string, Found[]>();
  for (const c of commits) {
    const repo = join(c.host, c.owner, c.repo);
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), c]);
  }
  return [...byRepo.values()].flatMap((repo) => repo.sort((a, b) => b.time - a.time).slice(keep));
}

/** The directories of a directory, without following links; none when it cannot be read. */
function subdirs(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
}

/** Every commit in the cache, with when it was last used and its size. */
function commitsIn(dir: string): Found[] {
  let paths: string[][] = [[]];
  for (let depth = 0; depth < 4; depth++)
    paths = paths.flatMap((parts) => subdirs(join(dir, ...parts)).map((d) => [...parts, d.name]));
  return paths.flatMap((parts) => {
    const [host, owner, repo, sha] = parts as [string, string, string, string];
    if (!FULL_SHA.test(sha)) return [];
    const path = join(dir, ...parts);
    try {
      return [{ host, owner, repo, sha, path, time: lstatSync(path).mtimeMs, bytes: sizeOf(path) }];
    } catch {
      return [];
    }
  });
}

/** The bytes of the files under a directory, without following links. */
function sizeOf(path: string): number {
  let n = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) n += sizeOf(p);
    else if (e.isFile())
      try {
        n += lstatSync(p).size;
      } catch {
        // Removed meanwhile.
      }
  }
  return n;
}

/** Removes a directory when it is empty, and leaves it otherwise. */
function removeIfEmpty(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Not empty, or gone: either way there is nothing to do.
  }
}
