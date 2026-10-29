import { matchesPattern } from './glob';
import { type Project, remoteKey, type UnverifiedUse } from './graph';
import type { ActionDecl, JobDecl, RemoteOrigin, UnitDecl, WorkflowDecl } from './ir';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import { createParseContext, parseActionFile, parseWorkflowFile } from './parse';
import { posixIsAbsolute } from './posix';
import { validateSchema } from './validate';
import { workspaceResolver } from './workspace';

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

export const toPosix = (p: string): string => p.split('\\').join('/');

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
  /** Globs of published actions: the actions they match are loaded even when nothing in the repository uses them. */
  publish?: string[];
  /**
   * The interfaces of remote reusable workflows and actions, by their `uses:` reference (`owner/repo/path@ref`), as
   * the YAML of a workflow or `action.yml` that declares them. Each becomes an external unit (see `Project.external`).
   */
  remotes?: RemoteInterface[];
}

export interface RemoteInterface {
  ref: string;
  kind: 'workflow' | 'action';
  text: string;
  /** The commit `text` was read at, when known; kept on the unit's `origin`. */
  sha?: string;
}

const isYaml = (p: string) => /\.ya?ml$/i.test(p);
const isActionFile = (p: string) => /(^|\/)action\.ya?ml$/i.test(p);
/** GitHub only runs workflows directly inside .github/workflows. */
const isWorkflowFile = (p: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(p);
/** GitHub matches the directory of a called workflow exactly, whatever the file system's case sensitivity. */
const isCallableWorkflowPath = (p: string) =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p.replace(/\.ya?ml$/i, (e) => e.toLowerCase()));
/** Local `uses:` targets must stay inside the repository. */
const escapesRoot = (p: string) => p === '..' || p.startsWith('../') || posixIsAbsolute(p);

/** What a host supplies to the loader: its file system when the caller gives none, and its path arithmetic. */
export interface ProjectHost {
  /** The file system for `root` when `LoadProjectOptions.fs` is absent; a host without one makes `fs` required. */
  defaultFs?: (root: string) => FileSystem;
  /** `p` (relative to `root`, or absolute on the host) as a repository-relative POSIX path; `..` when it escapes. */
  relativeTo: (root: string, p: string) => string;
}

/** Loads a project through a host (`loadProject` of the Node and browser entries wire one in). */
// The body of 2.4.0's loadProject, unchanged behind the host; splitting it is a change of its own.
// fallow-ignore-next-line complexity
export function loadProjectWith(opts: LoadProjectOptions, host: ProjectHost): Project {
  const logger = (opts.logger ?? silentLogger).child('load');
  const fs = opts.fs ?? host.defaultFs?.(opts.root);
  if (!fs) throw new Error('loadProject needs a file system here: pass fs (memoryFileSystem(files))');
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
  // uses it, and so are the actions `publish` matches (each once, however many patterns match it).
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
  // A path of `.` (or the root's absolute path) means: report on everything.
  let wholeRepository = false;
  const ignoredTargets: string[] = [];
  for (const p of opts.paths ?? []) {
    const rel = host.relativeTo(opts.root, p) || '.';
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
      // Files that are not valid YAML already carry parse errors; the schema parser would only repeat them.
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
    ...externalUnits(opts.remotes, ctx),
  };
}

/**
 * The external units of remote interfaces (see `LoadProjectOptions.remotes`), by `remoteKey` of their reference; none
 * without remotes. Each is parsed as its own repository's, so its `./` and same-repository `uses:` name that
 * repository's files, never the caller's; site ids stay unique across the project.
 */
function externalUnits(
  remotes: RemoteInterface[] = [],
  ctx: ReturnType<typeof createParseContext>,
): Pick<Project, 'external'> {
  if (!remotes.length) return {};
  const out = new Map<string, UnitDecl>();
  for (const r of remotes) {
    const origin = originOf(r);
    const own = {
      nextSiteId: ctx.nextSiteId,
      ...(origin ? { repository: `${origin.owner}/${origin.repo}` } : {}),
    };
    const unit: UnitDecl =
      r.kind === 'workflow'
        ? parseWorkflowFile(r.ref, r.text, own)
        : parseActionFile(r.ref, r.ref, r.text, own);
    out.set(remoteKey(r.ref), { ...unit, external: true, ...(origin ? { origin } : {}) });
  }
  return { external: out };
}

/** `owner/repo[/path]@ref` of a remote reference; undefined when it does not name a repository and a ref. */
function originOf(r: RemoteInterface): RemoteOrigin | undefined {
  const value = r.ref.trim();
  const at = value.indexOf('@');
  const [owner = '', repo = '', ...path] = (at < 0 ? value : value.slice(0, at)).split('/');
  const ref = at < 0 ? '' : value.slice(at + 1);
  if (!owner || !repo || !ref) return undefined;
  return { owner, repo, path: path.join('/'), ref, ...(r.sha ? { sha: r.sha } : {}) };
}
