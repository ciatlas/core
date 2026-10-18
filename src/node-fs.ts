import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Project } from './graph';
import {
  type FileSystem,
  type LoadProjectOptions,
  loadProjectWith,
  type ProjectHost,
  toPosix,
} from './project';

/** The project loader on a Node.js host: the working tree on disk, and `owner/repo` from the environment or git. */

/** How many links one path may go through (the OS's ELOOP limit), and how many linked directories one walk expands. */
const MAX_LINKS = 40;
const MAX_LINKED_DIRS = 1_000;

/** A directory waiting to be walked, with the real paths above it and how many links led to it. */
interface Pending {
  dir: string;
  above: Set<string>;
  links: number;
}

/**
 * Whether `abs` (after following symlinks) is inside the repository at `root` and outside its `.git` directory. A
 * checkout can contain symlinks; this keeps a caller from reading e.g. /etc or the persisted git credentials, and from
 * writing through a link. A path that does not exist yet is judged by its nearest existing parent.
 */
export function insideRepository(root: string, abs: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = resolve(root);
  }
  let target = resolve(abs);
  let rest = '';
  for (;;) {
    try {
      target = join(realpathSync(target), rest);
      break;
    } catch {
      const parent = dirname(target);
      if (parent === target) return false;
      rest = join(basename(target), rest);
      target = parent;
    }
  }
  const rel = toPosix(relative(realRoot, target));
  if (rel === '') return true;
  // `..` as a whole segment: `..hidden` is a name inside the repository.
  if (rel === '..' || rel.startsWith('../')) return false;
  return rel !== '.git' && !rel.startsWith('.git/');
}

export function nodeFileSystem(root: string): FileSystem {
  const abs = (p: string) => join(root, p);
  const listings = new Map<string, Set<string>>();
  /** On case-insensitive file systems, `.GitHub/x.YML` opens `.github/x.yml`; GitHub (Linux) would not find it. */
  const exactCase = (p: string): boolean => {
    let dir = root;
    for (const part of toPosix(p)
      .split('/')
      .filter((x) => x && x !== '.')) {
      if (part === '..') return false;
      let names = listings.get(dir);
      if (!names) {
        try {
          names = new Set(readdirSync(dir));
        } catch {
          return false;
        }
        listings.set(dir, names);
      }
      if (!names.has(part)) return false;
      dir = join(dir, part);
    }
    return true;
  };
  /** Follows symlinks and accepts only existing targets inside the repository (see insideRepository). */
  const inside = (p: string): boolean => existsSync(abs(p)) && exactCase(p) && insideRepository(root, abs(p));
  const isFile = (p: string) => inside(p) && statSync(abs(p)).isFile();
  /** One directory of the walk: its files to `out`, its subdirectories to `queue`. */
  const expand = (next: Pending, out: string[], queue: Pending[], budget: { linked: number }): void => {
    const real = realpathSync(abs(next.dir));
    if (next.above.has(real)) return;
    const above = new Set(next.above).add(real);
    for (const name of readdirSync(abs(next.dir))) {
      // Dependencies and git internals never hold workflows or published actions.
      if (name === 'node_modules' || name === '.git') continue;
      const p = toPosix(join(next.dir, name));
      if (isFile(p)) out.push(p);
      else if (inside(p) && statSync(abs(p)).isDirectory()) enqueue(p, next, above, queue, budget);
    }
  };
  /** A subdirectory onto the queue, unless it is a link past the depth or count the walk allows. */
  const enqueue = (
    p: string,
    next: Pending,
    above: Set<string>,
    queue: Pending[],
    budget: { linked: number },
  ): void => {
    const link = lstatSync(abs(p)).isSymbolicLink();
    if (link && (next.links >= MAX_LINKS || budget.linked++ >= MAX_LINKED_DIRS)) return;
    queue.push({ dir: p, above, links: next.links + (link ? 1 : 0) });
  };
  return {
    read: (p) => (isFile(p) ? readFileSync(abs(p), 'utf8') : undefined),
    list: (dir) => {
      if (!inside(dir) || !statSync(abs(dir)).isDirectory()) return [];
      return readdirSync(abs(dir))
        .map((name) => toPosix(join(dir, name)))
        .filter((f) => isFile(f));
    },
    walk: (dir) => {
      if (!inside(dir) || !statSync(abs(dir)).isDirectory()) return [];
      // Breadth first, like readdirSync's `recursive`, which follows linked directories without noticing a link to a
      // directory that holds it: such a loop is not entered again (other links to the same directory still are). As in
      // gitFileSystem, linked directories nest no deeper than the OS follows links and are expanded a bounded number of
      // times, so links that fan out cannot multiply the walk; the shallowest paths are kept.
      const out: string[] = [];
      const queue: Pending[] = [{ dir: toPosix(dir), above: new Set(), links: 0 }];
      const budget = { linked: 0 };
      for (let i = 0; i < queue.length; i++) expand(queue[i]!, out, queue, budget);
      return out;
    },
    isDir: (p) => inside(p) && statSync(abs(p)).isDirectory(),
  };
}

/** Detects `owner/repo` from GITHUB_REPOSITORY or the `origin` remote in .git/config. */
export function detectRepository(
  root: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  const gitConfig = join(root, '.git', 'config');
  if (!existsSync(gitConfig)) return undefined;
  const text = readFileSync(gitConfig, 'utf8');
  // `url` at the start of a line, not the end of `pushurl`.
  const origin = /\[remote "origin"\][^[]*?^[ \t]*url\s*=\s*(\S+)/m.exec(text)?.[1];
  const m = origin && /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin);
  return m ? m[1] : undefined;
}

const nodeHost: ProjectHost = {
  defaultFs: (root) => nodeFileSystem(root),
  relativeTo: (root, p) => {
    const rel = relative(root, resolve(root, p));
    // Another drive on Windows: `relative` returns an absolute path, which escapes like `..` does.
    return isAbsolute(rel) ? '..' : toPosix(rel);
  },
};

/** Loads the project at `root`: from disk unless `fs` says otherwise. */
export function loadProject(opts: LoadProjectOptions): Project {
  return loadProjectWith(opts, nodeHost);
}
