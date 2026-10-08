import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Project } from './graph';
import type { ActionDecl, UnitDecl, UsesRef, WorkflowDecl } from './ir';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import { createParseContext, parseActionFile, parseWorkflowFile } from './parse';
import { validateSchema } from './validate';

export const WORKFLOWS_DIR = '.github/workflows';
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
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
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
      return (readdirSync(abs(dir), { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
        .map((e) => toPosix(relative(root, join(e.parentPath, e.name))))
        .filter((f) => isFile(f));
    },
    isDir: (p) => inside(p) && statSync(abs(p)).isDirectory(),
  };
}

export function memoryFileSystem(files: Record<string, string>): FileSystem {
  const norm = Object.fromEntries(
    Object.entries(files).map(([k, v]) => [toPosix(k).replace(/^\.\//, ''), v]),
  );
  const keys = Object.keys(norm);
  return {
    read: (p) => norm[toPosix(p)],
    list: (dir) => keys.filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')),
    walk: (dir) => keys.filter((k) => k.startsWith(`${dir}/`)),
    isDir: (p) => keys.some((k) => k.startsWith(`${toPosix(p).replace(/\/$/, '')}/`)),
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
  const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(text)?.[1];
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
  const invalid: Project['missing'] = [];

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

  const loadAction = (dir: string): ActionDecl | undefined => {
    if (actions.has(dir)) return actions.get(dir);
    if (escapesRoot(dir)) return undefined;
    const base = dir === '.' ? '' : `${dir}/`;
    const file = [`${base}action.yml`, `${base}action.yaml`].find((f) => fs.read(f) !== undefined);
    if (!file) return undefined;
    const action = logger.time(`parse ${file}`, () => parseActionFile(dir, file, fs.read(file)!, ctx));
    actions.set(dir, action);
    logger.debug(`parsed action ${dir}`, { using: action.using, steps: action.steps.length });
    return action;
  };

  const discovered = fs.list(WORKFLOWS_DIR).filter(isYaml).sort();
  const actionFiles = fs.walk(ACTIONS_DIR).filter(isActionFile).sort();
  logger.info(`discovered ${discovered.length} workflow(s) and ${actionFiles.length} local action(s)`);
  logger.debug('files', { workflows: discovered, actions: actionFiles });

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
  for (const f of actionFiles) loadAction(f.replace(/\/action\.ya?ml$/i, ''));

  // Follow local references until closure (actions outside .github/actions, workflows passed by path).
  const resolveRefs = (unit: UnitDecl) => {
    const note = (uses: UsesRef, extra: { job?: string; step?: number }) => {
      if (!uses.target) return;
      // Reusable workflows must live directly in .github/workflows; anything else is a broken reference.
      if (uses.kind === 'local-workflow' && !isCallableWorkflowPath(uses.target)) {
        invalid.push({ uses, from: unit.path, ...extra });
        logger.warn(`reusable workflow outside .github/workflows: ${uses.raw}`, { from: unit.path });
        return;
      }
      const found = uses.kind === 'local-workflow' ? loadWorkflow(uses.target) : loadAction(uses.target);
      // `owner/repo/...@ref` for this repository may exist at that ref even if not in the working tree.
      if (!found && uses.sameRepoRef && !escapesRoot(uses.target)) {
        logger.debug(`same-repository reference not in the working tree: ${uses.raw}`);
        return;
      }
      if (!found) {
        missing.push({ uses, from: unit.path, ...extra });
        logger.warn(`unresolved local reference ${uses.raw}`, { from: unit.path });
      } else {
        queue.push(found);
      }
    };
    if (unit.kind === 'workflow') {
      for (const job of Object.values(unit.jobs)) {
        if (job.uses?.kind === 'local-workflow') note(job.uses, { job: job.id });
        for (const step of job.steps)
          if (step.uses?.kind === 'local-action') note(step.uses, { job: job.id, step: step.index });
      }
    } else {
      for (const step of unit.steps)
        if (step.uses?.kind === 'local-action') note(step.uses, { step: step.index });
    }
  };
  const queue: UnitDecl[] = [...workflows.values(), ...actions.values()];
  const done = new Set<UnitDecl>();
  while (queue.length) {
    const u = queue.shift()!;
    if (done.has(u)) continue;
    done.add(u);
    resolveRefs(u);
  }

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
  };
}
