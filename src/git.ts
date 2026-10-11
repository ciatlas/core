/**
 * Read-only access to another revision of the repository, so impact mode can analyse the base of a pull request (or
 * the last release) with the same rules as the working tree. Runs `git` directly (never through a shell) and only
 * reads; refs are verified before use. In-repository symlinks resolve like in the working tree; submodules are skipped.
 */
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import type { FileSystem } from './project';
import { trimChar } from './text';

export class GitError extends Error {}

const MAX_BUFFER = 256 * 1024 * 1024;
/** Like Linux, more links than this in one path is taken for a loop. */
const MAX_LINKS = 40;
/** Linked directories one commit's file system expands, as nodeFileSystem.walk does (see gitFileSystem). */
const MAX_LINKED_DIRS = 1_000;

function git(root: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      maxBuffer: MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input !== undefined ? { input } : {}),
    });
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer };
    if (e.code === 'ENOENT') throw new GitError('git is not installed or not on PATH');
    const detail = e.stderr?.toString().trim().split('\n')[0] ?? (err as Error).message;
    throw new GitError(detail);
  }
}

/** The top directory of the git work tree `root` is in, or undefined outside one. */
export function gitTopLevel(root: string): string | undefined {
  try {
    return git(root, ['rev-parse', '--show-toplevel']).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The commit a ref points at, or a GitError naming the ref. Refs starting with `-` are rejected. */
export function resolveCommit(root: string, ref: string): string {
  if (!ref || ref.startsWith('-')) throw new GitError(`invalid ref: ${JSON.stringify(ref)}`);
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
      .toString()
      .trim();
  } catch {
    // A remote-tracking ref (`origin/main`) is fetched as the remote's branch (`main`).
    const branch = ref.replace(/^(refs\/remotes\/)?origin\//, '');
    throw new GitError(
      `${ref} is not available in this clone. Fetch it first (for example \`git fetch origin ${branch}\`, or check out with fetch-depth: 0).`,
    );
  }
}

/** Whether `root` is inside a git work tree. */
export function isGitRepository(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).toString().trim() === 'true';
  } catch {
    return false;
  }
}

/** Repository-relative files at `commit` (regular files only), read lazily. */
export function gitFileSystem(root: string, commit: string): FileSystem & { commit: string } {
  // `ls-tree` paths are relative to the repository top level; flowpact paths are relative to `root`.
  const prefix = git(root, ['rev-parse', '--show-prefix']).toString().trim();
  // Tree paths, relative to the top level.
  const blobs = new Set<string>();
  const links = new Set<string>();
  const out = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString();
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (type === 'blob' && mode === '120000') links.add(path);
    // Regular files; submodules (commit entries) are skipped.
    else if (type === 'blob' && (mode === '100644' || mode === '100755')) blobs.add(path);
  }
  // In-repository symlinks resolve like they do in the working tree (a symlinked action is the same unit on both
  // sides), through other links and linked directories too; links that leave the repository (or `root`), point into
  // .git or loop are ignored, as nodeFileSystem does.
  const targets = new Map<string, string>();
  const target = (link: string) => {
    if (!targets.has(link))
      targets.set(link, git(root, ['cat-file', 'blob', `${commit}:${link}`]).toString());
    return targets.get(link)!;
  };
  /** The tree path `path` stands for once every link in it is followed, or undefined. */
  const resolve = (path: string): string | undefined => {
    let p = path;
    for (let followed = 0; ; followed++) {
      const parts = p.split('/');
      const end = parts.findIndex((_, i) => links.has(parts.slice(0, i + 1).join('/')));
      if (end < 0) return p;
      if (followed === MAX_LINKS) return undefined;
      const link = parts.slice(0, end + 1).join('/');
      const to = target(link);
      if (!to || posix.isAbsolute(to)) return undefined;
      p = trimChar(posix.join(posix.dirname(link), to, ...parts.slice(end + 1)), '/');
      if (p === '..' || p.startsWith('../') || p === '.git' || p.startsWith('.git/')) return undefined;
      if (p === '.') p = '';
    }
  };
  const top = trimChar(prefix, '/');
  const inRoot = (p: string) => top === '' || p === top || p.startsWith(`${top}/`);
  /** The files `root` shows, by path relative to it, with the tree path each reads. */
  const files = new Map<string, string>();
  const sortedBlobs = [...blobs].sort();
  const sortedLinks = [...links].sort();
  /** The paths in sorted `paths` that start with `prefix`, found by binary search: an expansion costs what it adds. */
  const within = (paths: string[], prefix: string): string[] => {
    let lo = 0;
    let hi = paths.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (paths[mid]! < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < paths.length && paths[i]!.startsWith(prefix); i++) out.push(paths[i]!);
    return out;
  };
  /**
   * The files `root` shows, by path relative to it, with the tree path each reads: tree directory `dir` shows as `as`.
   * Breadth first, through the links in `via`: a link to a directory that holds it or one of them loops, and is not
   * expanded. Like nodeFileSystem.walk, linked directories nest no deeper than the OS follows links (ELOOP) and at most
   * MAX_LINKED_DIRS of them are expanded, so links that fan out cannot multiply the tree; the shallowest are kept.
   */
  let expanded = 0;
  const queue: { dir: string; as: string; via: string[] }[] = [{ dir: top, as: '', via: [] }];
  for (let i = 0; i < queue.length; i++) {
    const { dir, as, via } = queue[i]!;
    if (via.length && expanded++ >= MAX_LINKED_DIRS) continue;
    const d = dir ? `${dir}/` : '';
    for (const f of within(sortedBlobs, d)) files.set(`${as}${f.slice(d.length)}`, f);
    for (const link of within(sortedLinks, d)) {
      const to = resolve(link);
      if (to === undefined || !inRoot(to)) continue;
      const at = `${as}${link.slice(d.length)}`;
      const chain = [...via, link];
      if (blobs.has(to)) files.set(at, to);
      else if (chain.length <= MAX_LINKS && !chain.some((l) => to === '' || l.startsWith(`${to}/`)))
        queue.push({ dir: to, as: `${at}/`, via: chain });
    }
  }
  const cache = new Map<string, string | undefined>();
  const norm = (p: string) => trimChar(p.startsWith('./') ? p.slice(2) : p, '/');
  const under = (dir: string) => {
    const d = norm(dir);
    return d === '' || d === '.' ? '' : `${d}/`;
  };
  return {
    commit,
    read(path) {
      const p = norm(path);
      if (!files.has(p)) return undefined;
      if (!cache.has(p))
        cache.set(p, git(root, ['cat-file', 'blob', `${commit}:${files.get(p)}`]).toString('utf8'));
      return cache.get(p);
    },
    list(dir) {
      const d = under(dir);
      return [...files.keys()].filter((f) => f.startsWith(d) && !f.slice(d.length).includes('/')).sort();
    },
    walk(dir) {
      const d = under(dir);
      return [...files.keys()].filter((f) => f.startsWith(d)).sort();
    },
    isDir(path) {
      const d = under(path);
      return [...files.keys()].some((f) => f.startsWith(d));
    },
  };
}
