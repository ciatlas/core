/**
 * Everything impact mode needs before `analyze()`: the declared impact (flags or the GitHub event), the baseline
 * (the pull request's base, the commit before a push, or the last release for a release pull request) analysed from
 * git, and the policy from the baseline's config.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type AnalyzeOptions, analyze } from './analyze';
import {
  CONFIG_DIR,
  CONFIG_FILES,
  ConfigError,
  defaultConfig,
  type FlowpactConfig,
  parseConfigText,
} from './config';
import { type GitError, gitFileSystem, resolveCommit } from './git';
import { type DeclaredInput, type ImpactLevel, type ImpactPolicy, isPublished } from './impact';
import type { Logger } from './logger';
import type { FileSystem } from './project';

export class ImpactSetupError extends Error {}

export interface ImpactRequest {
  /** Explicit baseline ref; default: the pull request base, the commit before a push, or the remote's default branch. */
  base?: string;
  expect?: ImpactLevel;
  title?: string;
  labels?: string[];
  /** The GitHub event (`GITHUB_EVENT_NAME` and the parsed `GITHUB_EVENT_PATH`), when running in Actions. */
  event?: { name?: string; payload?: GitHubEventPayload };
  repository?: string;
  /** The config file the head uses, relative to the root (`--config`); the same path is read from the baseline. */
  configPath?: string;
  /** Called with refs (commits, `refs/tags/…`) the clone lacks, so a shallow checkout can fetch them. */
  fetch?: (refs: string[]) => void;
}

export interface GitHubEventPayload {
  pull_request?: { title?: string; labels?: { name?: string }[]; base?: { sha?: string; ref?: string } };
  before?: string;
}

export type PreparedImpact =
  | { skip: string }
  | { options: NonNullable<AnalyzeOptions['impact']>; notes: string[] };

/** Reads `GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH` (a missing or unreadable payload is treated as none). */
export function githubEvent(env: NodeJS.ProcessEnv = process.env): ImpactRequest['event'] {
  if (!env.GITHUB_EVENT_NAME) return undefined;
  let payload: GitHubEventPayload | undefined;
  try {
    if (env.GITHUB_EVENT_PATH) payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    payload = undefined;
  }
  return { name: env.GITHUB_EVENT_NAME, ...(payload ? { payload } : {}) };
}

/** release-please's release pull request title (`chore(main): release 0.3.0`, `chore: release main`). */
export const RELEASE_TITLE = /^chore(\([^)]*\))?: release\b/i;
const RELEASE_LABEL = 'autorelease: pending';

export function isReleasePullRequest(title: string | undefined, labels: string[]): boolean {
  return (title !== undefined && RELEASE_TITLE.test(title)) || labels.includes(RELEASE_LABEL);
}

function readJson(fs: FileSystem, path: string): Record<string, unknown> | undefined {
  const text = fs.read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The project's version: release-please's manifest (root component), else the root package.json. */
function versionOf(fs: FileSystem): string | undefined {
  const manifest = readJson(fs, '.release-please-manifest.json');
  const v = manifest?.['.'];
  if (typeof v === 'string') return v;
  const pkg = readJson(fs, 'package.json');
  return typeof pkg?.version === 'string' ? pkg.version : undefined;
}

/** release-please's settings for the root package; a package's own setting overrides the top level. */
function releaseSettings(fs: FileSystem) {
  const config = readJson(fs, 'release-please-config.json') ?? {};
  const pkg = ((config.packages as Record<string, Record<string, unknown>> | undefined)?.['.'] ??
    {}) as Record<string, unknown>;
  const get = (key: string) => (pkg[key] ?? config[key]) as unknown;
  const component = (get('component') ?? get('package-name')) as string | undefined;
  return {
    bumpMinorPreMajor: get('bump-minor-pre-major') === true,
    bumpPatchForMinorPreMajor: get('bump-patch-for-minor-pre-major') === true,
    includeV: get('include-v-in-tag') !== false,
    component:
      get('include-component-in-tag') === true && typeof component === 'string' ? component : undefined,
  };
}

/** The baseline's config: from `configPath` or the default locations; undefined when it has none or it is invalid. */
function baselineConfig(
  fs: FileSystem,
  configPath: string | undefined,
  notes: string[],
): FlowpactConfig | undefined {
  const candidates = configPath ? [configPath] : CONFIG_FILES.map((f) => `${CONFIG_DIR}/${f}`);
  for (const path of candidates) {
    const text = fs.read(path);
    if (text === undefined) continue;
    try {
      return parseConfigText(text, path).config;
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      notes.push(`the baseline's ${path} is invalid (${err.message}); using the default impact settings`);
      return undefined;
    }
  }
  return undefined;
}

const workingTree = (root: string): FileSystem => ({
  read: (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return undefined;
    }
  },
  list: () => [],
  walk: () => [],
  isDir: () => false,
});

/** The commit `ref` points at, fetching it through `fetch` when the clone lacks it. */
function commitOf(root: string, ref: string, fetch: ImpactRequest['fetch']): string {
  try {
    return resolveCommit(root, ref);
  } catch (err) {
    if (!fetch) throw new ImpactSetupError((err as GitError).message);
    fetch([ref]);
    try {
      return resolveCommit(root, ref);
    } catch (again) {
      throw new ImpactSetupError((again as GitError).message);
    }
  }
}

function defaultBase(root: string): string {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      resolveCommit(root, ref);
      return ref;
    } catch {
      // try the next one
    }
  }
  throw new ImpactSetupError('No baseline: pass --base <ref> (for example --base origin/main).');
}

const ZERO_SHA = /^0+$/;

/** Resolves the baseline and the declaration, and analyses the baseline. */
export function prepareImpact(
  root: string,
  headConfig: FlowpactConfig,
  req: ImpactRequest,
  logger?: Logger,
): PreparedImpact {
  const eventName = req.event?.name;
  if (eventName === 'merge_group') return { skip: 'merge_group: impact was checked on the pull request' };
  if (eventName === 'pull_request_target' && !req.base) {
    throw new ImpactSetupError(
      'pull_request_target runs on the default branch, so it would compare the default branch with itself. Run impact mode on pull_request (or pass a base and check out the pull request head).',
    );
  }
  const payload = req.event?.payload;
  const pr = payload?.pull_request;
  const title = req.title ?? pr?.title;
  const labels = req.labels ?? (pr?.labels ?? []).map((l) => l.name ?? '').filter(Boolean);
  const notes: string[] = [];

  let baseRef: string;
  if (req.base) baseRef = req.base;
  else if (pr?.base?.sha) baseRef = pr.base.sha;
  else if (eventName === 'push' && payload?.before && !ZERO_SHA.test(payload.before))
    baseRef = payload.before;
  else if (eventName === 'push') return { skip: 'push without a previous commit (new branch or tag)' };
  else baseRef = defaultBase(root);

  let kind: 'ref' | 'release' = 'ref';
  let release: DeclaredInput['release'];
  let commit = commitOf(root, baseRef, req.fetch);

  if (isReleasePullRequest(title, labels)) {
    // A release pull request changes only versions and the changelog; what matters is everything since the last
    // release, against the version it proposes.
    const previous = versionOf(gitFileSystem(root, commit));
    const next = versionOf(workingTree(root));
    if (previous && next && previous !== next) {
      const settings = releaseSettings(workingTree(root));
      const tags = [
        ...(settings.component
          ? [`${settings.component}-v${previous}`, `${settings.component}-${previous}`]
          : []),
        settings.includeV ? `v${previous}` : previous,
        settings.includeV ? previous : `v${previous}`,
      ];
      const found = () =>
        tags.find((t) => {
          try {
            resolveCommit(root, `refs/tags/${t}`);
            return true;
          } catch {
            return false;
          }
        });
      let tag = found();
      if (!tag && req.fetch) {
        req.fetch(tags.map((t) => `+refs/tags/${t}:refs/tags/${t}`));
        tag = found();
      }
      if (!tag)
        throw new ImpactSetupError(
          `No release tag for ${previous} (tried ${tags.join(', ')}); fetch tags first.`,
        );
      release = {
        previous,
        version: next,
        bumpMinorPreMajor: settings.bumpMinorPreMajor,
        bumpPatchForMinorPreMajor: settings.bumpPatchForMinorPreMajor,
      };
      baseRef = tag;
      kind = 'release';
      commit = commitOf(root, `refs/tags/${tag}`, undefined);
      notes.push(`release pull request: ${previous} → ${next}, compared with ${tag}`);
    }
  }

  let head: string | undefined;
  try {
    head = resolveCommit(root, 'HEAD');
  } catch {
    head = undefined;
  }
  if (head === commit) return { skip: `the baseline ${baseRef} is the checked-out commit` };

  let fs: FileSystem;
  try {
    fs = gitFileSystem(root, commit);
  } catch (err) {
    throw new ImpactSetupError((err as Error).message);
  }
  const configPath = req.configPath
    ? relative(root, join(root, req.configPath)).split('\\').join('/')
    : undefined;
  const baseConfig = baselineConfig(fs, configPath, notes);
  // Policy comes from the baseline (or the defaults), never from the pull request, so it cannot relax its own check.
  const policy: ImpactPolicy = { ...(baseConfig ?? defaultConfig()).impact };
  if (JSON.stringify(policy) !== JSON.stringify(headConfig.impact)) {
    notes.push('this pull request changes impact settings; they apply after it is merged');
  }
  logger?.debug('impact baseline', { ref: baseRef, commit, kind });
  const base = analyze({
    root,
    fs,
    config: baseConfig ?? defaultConfig(),
    validateSchema: false,
    only: [],
    ...(req.repository ? { repository: req.repository } : {}),
  });
  return {
    options: {
      base: base.index,
      baseline: { kind, ref: baseRef, commit },
      declared: {
        ...(req.expect ? { explicit: req.expect } : {}),
        ...(title !== undefined && !release ? { title } : {}),
        ...(labels.length ? { labels } : {}),
        ...(release ? { release } : {}),
      },
      policy,
      // Load the head's copies of what the baseline published, so a unit that still exists is compared, not "removed".
      publishedFiles: base.index
        .units()
        .filter((u) => isPublished(u, policy))
        .map((u) => u.file),
    },
    notes,
  };
}
