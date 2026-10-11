import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { matchesPattern } from './glob';
import type { Project, UnverifiedUse } from './graph';
import type { ActionDecl, JobDecl, WorkflowDecl } from './ir';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import { createParseContext, parseActionFile, parseWorkflowFile } from './parse';
import { validateSchema } from './validate';
import { workspaceResolver } from './workspace';

export const WORKFLOWS_DIR = '.github/workflows';
/** How many links one path may go through (the OS's ELOOP limit), and how many linked directories one walk expands. */
const MAX_LINKS = 40;
const MAX_LINKED_DIRS = 1_000;
export const ACTIONS_DIR = '.github/actions';

/** Read-only file access, so the loader runs on disk and against in-memory fixtures alike. */
export interface FileSystem {
  read(path: string): string | undefined;
  /** Lists files (repo-relative, POSIX) directly inside `dir`. */
  list(dir: string): string[];
  /** Lists files (repo-relative, POSIX) anywhere below `dir`. */
  walk(dir: string): string[];
  isDir(path: string): boolean;
}

const toPosix = (p: string) => p.split('\\').join('/');

/**
 * Whether `abs` (after following symlinks) is inside the repository at `root` and outside its `.git` directory. A
 * checkout can contain symlinks; this keeps flowpact from reading e.g. /etc or the persisted git credentials, and from
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
  if (escapesRoot(rel)) return false;
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
      let linked = 0;
      const queue: { dir: string; above: Set<string>; links: number }[] = [
        { dir: toPosix(dir), above: new Set(), links: 0 },
      ];
      for (let i = 0; i < queue.length; i++) {
        const next = queue[i]!;
        const real = realpathSync(abs(next.dir));
        if (next.above.has(real)) continue;
        const above = new Set(next.above).add(real);
        for (const name of readdirSync(abs(next.dir))) {
          // Dependencies and git internals never hold workflows or published actions.
          if (name === 'node_modules' || name === '.git') continue;
          const p = toPosix(join(next.dir, name));
          if (isFile(p)) out.push(p);
          else if (inside(p) && statSync(abs(p)).isDirectory()) {
            const link = lstatSync(abs(p)).isSymbolicLink();
            if (link && (next.links >= MAX_LINKS || linked++ >= MAX_LINKED_DIRS)) continue;
            queue.push({ dir: p, above, links: next.links + (link ? 1 : 0) });
          }
        }
      }
      return out;
    },
    isDir: (p) => inside(p) && statSync(abs(p)).isDirectory(),
  };
}

/** The prefix of the paths below `dir`: `a/` for `a`, `a/`, `./a` or `./a/`, and `` for the root (`.`, `./`, ``). */
const dirPrefix = (dir: string) => {
  const d = toPosix(dir)
    .replace(/^\.(\/|$)/, '')
    .replace(/\/$/, '');
  return d ? `${d}/` : '';
};

export function memoryFileSystem(files: Record<string, string>): FileSystem {
  const norm = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [toPosix(k).replace(/^\.\//, ''), v]),
  );
  const keys = Object.keys(norm);
  return {
    read: (p) => {
      const key = toPosix(p).replace(/^\.\//, '');
      return Object.hasOwn(norm, key) ? norm[key] : undefined;
    },
    list: (dir) =>
      keys.filter((k) => k.startsWith(dirPrefix(dir)) && !k.slice(dirPrefix(dir).length).includes('/')),
    walk: (dir) => keys.filter((k) => k.startsWith(dirPrefix(dir))),
    isDir: (p) => keys.some((k) => k.startsWith(dirPrefix(p))),
  };
}

/**
 * `base` with some files replaced or added by in-memory text, such as an editor's unsaved buffers. Keys are
 * repo-relative paths; the caller decides which files may be overlaid (they bypass `base`'s checks).
 */
export function overlayFileSystem(base: FileSystem, files: ReadonlyMap<string, string>): FileSystem {
  const norm = new Map([...files].map(([k, v]) => [toPosix(k).replace(/^\.\//, ''), v]));
  const keys = [...norm.keys()];
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    read: (p) => norm.get(toPosix(p).replace(/^\.\//, '')) ?? base.read(p),
    list: (dir) =>
      union(
        base.list(dir),
        keys.filter((k) => k.startsWith(dirPrefix(dir)) && !k.slice(dirPrefix(dir).length).includes('/')),
      ),
    walk: (dir) =>
      union(
        base.walk(dir),
        keys.filter((k) => k.startsWith(dirPrefix(dir))),
      ),
    isDir: (p) => base.isDir(p) || (dirPrefix(p) !== '' && keys.some((k) => k.startsWith(dirPrefix(p)))),
  };
}

export interface LoadProjectOptions {
  root: string;
  fs?: FileSystem;
  /** Files or directories (relative to root or absolute) to report on. Everything is still loaded for context. */
  paths?: string[];
  repository?: string;
  validateSchema?: boolean;
  logger?: Logger;
  /** Globs of published units (`impact.publish`): matching actions are loaded even when nothing here uses them. */
  publish?: string[];
}

const isYaml = (p: string) => /\.ya?ml$/i.test(p);
const isActionFile = (p: string) => /(^|\/)action\.ya?ml$/i.test(p);
/** GitHub only runs workflows directly inside .github/workflows. */
const isWorkflowFile = (p: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(p);
/** GitHub matches the directory of a called workflow exactly, whatever the file system's case sensitivity. */
const isCallableWorkflowPath = (p: string) =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p.replace(/\.ya?ml$/i, (e) => e.toLowerCase()));
/** Local `uses:` targets must stay inside the repository. */
const escapesRoot = (p: string) => p === '..' || p.startsWith('../') || isAbsolute(p);

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

export function loadProject(opts: LoadProjectOptions): Project {
  const logger = (opts.logger ?? silentLogger).child('load');
  const fs = opts.fs ?? nodeFileSystem(opts.root);
  const ctx = createParseContext(opts.repository);
  const workflows = new Map<string, WorkflowDecl>();
  const actions = new Map<string, ActionDecl>();
  const missing: Project['missing'] = [];
  const invalid: NonNullable<Project['invalidTargets']> = [];

  const loadWorkflow = (path: string): WorkflowDecl | undefined => {
    if (workflows.has(path)) return workflows.get(path);
    if (escapesRoot(path)) return undefined;
    const text = fs.read(path);
    if (text === undefined) return undefined;
    const wf = logger.time(`parse ${path}`, () => parseWorkflowFile(path, text, ctx));
    workflows.set(path, wf);
    logger.debug(`parsed workflow ${path}`, {
      jobs: Object.keys(wf.jobs).length,
      expressions: wf.sites.length,
    });
    return wf;
  };

  /** The metadata file of the action in `dir`: action.yml, else action.yaml. */
  const actionFile = (dir: string): string | undefined => {
    const base = dir === '.' ? '' : `${dir}/`;
    return [`${base}action.yml`, `${base}action.yaml`].find((f) => fs.read(f) !== undefined);
  };

  const loadAction = (dir: string): ActionDecl | undefined => {
    if (actions.has(dir)) return actions.get(dir);
    if (escapesRoot(dir)) return undefined;
    const file = actionFile(dir);
    if (!file) return undefined;
    const action = logger.time(`parse ${file}`, () => parseActionFile(dir, file, fs.read(file)!, ctx));
    actions.set(dir, action);
    logger.debug(`parsed action ${dir}`, { using: action.using, steps: action.steps.length });
    return action;
  };

  const discovered = fs.list(WORKFLOWS_DIR).filter(isYaml).sort();
  const actionFiles = new Set(fs.walk(ACTIONS_DIR).filter(isActionFile).sort());
  // The repository's own action (what `uses: owner/repo@ref` runs) is part of the project even when no workflow here
  // uses it, and so are the actions `impact.publish` lists (each once, however many patterns match it).
  const rootAction = actionFile('.');
  if (rootAction) actionFiles.add(rootAction);
  for (const raw of opts.publish ?? []) {
    // One spelling per path, so `./tools/b` and `tools/b` are the same unit.
    const pattern = toPosix(raw).replace(/^\.\//, '') || '.';
    // An exact file or directory is loaded directly; a glob walks the directory before its first wildcard.
    if (!/[*?[]/.test(pattern)) {
      const file = isActionFile(pattern) ? pattern : actionFile(pattern.replace(/\/$/, ''));
      if (file && !file.startsWith('.github/actions/') && fs.read(file) !== undefined) actionFiles.add(file);
      continue;
    }
    const literal = pattern.split(/[*?[]/)[0]!;
    const dir = literal.includes('/') ? literal.slice(0, literal.lastIndexOf('/')) : '';
    for (const f of dir ? fs.walk(dir) : fs.walk('.')) {
      if (!isActionFile(f) || f.startsWith('.github/actions/')) continue;
      const unitDir = f.replace(/\/?action\.ya?ml$/i, '') || '.';
      if (matchesPattern(f, pattern) || matchesPattern(unitDir, pattern)) actionFiles.add(f);
    }
  }
  logger.info(`discovered ${discovered.length} workflow(s) and ${actionFiles.size} local action(s)`);
  logger.debug('files', { workflows: discovered, actions: [...actionFiles] });

  const targets = new Set<string>();
  const missingTargets: string[] = [];
  // `flowpact lint .` (or the root's absolute path) means: report on everything.
  let wholeRepository = false;
  const ignoredTargets: string[] = [];
  for (const p of opts.paths ?? []) {
    const rel = toPosix(relative(opts.root, resolve(opts.root, p))) || '.';
    if (rel === '.' || rel === '') {
      wholeRepository = true;
      continue;
    }
    if (escapesRoot(rel)) {
      missingTargets.push(p);
    } else if (fs.isDir(rel)) {
      // Only real workflows and action metadata, not dependabot.yml, issue forms or other YAML.
      const found = fs.walk(rel).filter((f) => isWorkflowFile(f) || isActionFile(f));
      if (found.length === 0) ignoredTargets.push(p);
      for (const f of found) targets.add(f);
    } else if (fs.read(rel) === undefined) {
      missingTargets.push(p);
    } else if (isWorkflowFile(rel) || isActionFile(rel)) {
      targets.add(rel);
    } else {
      ignoredTargets.push(p);
    }
  }
  if (wholeRepository) targets.clear();
  if (missingTargets.length) logger.warn(`paths not found: ${missingTargets.join(', ')}`);
  if (ignoredTargets.length)
    logger.warn(`paths that are not workflows or actions: ${ignoredTargets.join(', ')}`);
  for (const t of targets) {
    if (isActionFile(t)) loadAction(t.replace(/\/?action\.ya?ml$/i, '') || '.');
    else if (isYaml(t)) loadWorkflow(t);
  }

  for (const f of discovered) loadWorkflow(f);
  for (const f of actionFiles) loadAction(f.replace(/\/?action\.ya?ml$/i, '') || '.');

  // Follow local references until closure (actions outside .github/actions, workflows passed by path), walking each
  // job's steps in order: a step's `./path` is relative to the runner's workspace, which its checkouts shape.
  const unverified: UnverifiedUse[] = [];
  const resolver = workspaceResolver({
    ...(opts.repository ? { repository: opts.repository } : {}),
    loadAction,
    isDir: (dir) => fs.isDir(dir),
    logger,
  });

  const noteCall = (wf: WorkflowDecl, job: JobDecl, pending: WorkflowDecl[]) => {
    const uses = job.uses;
    if (!uses?.target) return;
    const where = { uses, from: wf.path, job: job.id };
    if (uses.selfRef !== undefined) {
      invalid.push({ ...where, reason: 'self-ref' });
      return;
    }
    // Reusable workflows must live directly in .github/workflows; anything else is a broken reference.
    if (!isCallableWorkflowPath(uses.target)) {
      invalid.push({ ...where, reason: 'not-callable' });
      logger.warn(`reusable workflow outside .github/workflows: ${uses.raw}`, { from: wf.path });
      return;
    }
    const found = loadWorkflow(uses.target);
    // `owner/repo/...@ref` for this repository may exist at that ref even if not in the working tree.
    if (!found && uses.sameRepoRef && !escapesRoot(uses.target)) {
      logger.debug(`same-repository reference not in the working tree: ${uses.raw}`);
    } else if (!found) {
      missing.push(where);
      logger.warn(`unresolved local reference ${uses.raw}`, { from: wf.path });
    } else {
      pending.push(found);
    }
  };

  const pending: WorkflowDecl[] = [...workflows.values()];
  const walked = new Set<WorkflowDecl>();
  while (pending.length) {
    const wf = pending.shift()!;
    if (walked.has(wf)) continue;
    walked.add(wf);
    for (const job of Object.values(wf.jobs)) {
      if (job.uses?.kind === 'local-workflow') noteCall(wf, job, pending);
      resolver.walkJob(wf, job);
    }
  }
  resolver.walkRemainingActions(actions);
  resolver.finish({ missing, invalid, unverified });

  if (opts.validateSchema !== false) {
    logger.time('schema validation', () => {
      // Files that are not valid YAML are reported by FP504; the schema parser would only repeat that.
      for (const u of [...workflows.values(), ...actions.values()]) {
        if (u.parseErrors.length === 0) u.schemaErrors = validateSchema(u, logger);
      }
    });
  }

  return {
    root: opts.root,
    ...(opts.repository ? { repository: opts.repository } : {}),
    workflows,
    actions,
    targets,
    ...(wholeRepository ? { wholeRepository } : {}),
    missingTargets,
    ignoredTargets,
    missing,
    invalidTargets: invalid,
    unverified,
  };
}
