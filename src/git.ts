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
    throw new GitError(
      `${ref} is not available in this clone. Fetch it first (for example \`git fetch origin ${ref}\`, or check out with fetch-depth: 0).`,
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
  const files = new Set<string>();
  const links: string[] = [];
  const out = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString();
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (prefix && !path.startsWith(prefix)) continue;
    if (type === 'blob' && mode === '120000') links.push(path);
    // Regular files; submodules (commit entries) are skipped.
    else if (type === 'blob' && (mode === '100644' || mode === '100755'))
      files.add(path.slice(prefix.length));
  }
  // In-repository symlinks resolve like they do in the working tree (a symlinked action is the same unit on both
  // sides); links that leave the repository or point into .git are ignored, as nodeFileSystem does.
  const alias = new Map<string, string>();
  for (const link of links) {
    const target = posix.normalize(
      posix.join(posix.dirname(link), git(root, ['cat-file', 'blob', `${commit}:${link}`]).toString()),
    );
    if (target.startsWith('../') || target === '..' || target === '.git' || target.startsWith('.git/'))
      continue;
    if (prefix && !target.startsWith(prefix)) continue;
    const from = link.slice(prefix.length);
    const to = target.slice(prefix.length);
    if (files.has(to)) {
      alias.set(from, to);
      files.add(from);
      continue;
    }
    for (const f of [...files]) {
      if (!f.startsWith(`${to}/`)) continue;
      const virtual = `${from}/${f.slice(to.length + 1)}`;
      alias.set(virtual, f);
      files.add(virtual);
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
        cache.set(
          p,
          git(root, ['cat-file', 'blob', `${commit}:${prefix}${alias.get(p) ?? p}`]).toString('utf8'),
        );
      return cache.get(p);
    },
    list(dir) {
      const d = under(dir);
      return [...files].filter((f) => f.startsWith(d) && !f.slice(d.length).includes('/')).sort();
    },
    walk(dir) {
      const d = under(dir);
      return [...files].filter((f) => f.startsWith(d)).sort();
    },
    isDir(path) {
      const d = under(path);
      return [...files].some((f) => f.startsWith(d));
    },
  };
}
