/**
 * Impact mode: grade what changed between a baseline (the base of a pull request, or the last release) and the working
 * tree for **published** units — reusable workflows and actions other repositories use — and compare it with the
 * release impact the pull request declares.
 */
import { type CheckName, workflowChecks } from './checks';
import { buildContract, diffContracts } from './contracts';
import { matchesPattern } from './glob';
import type { ProjectIndex } from './graph';
import type { ActionDecl, JobDecl, PermissionsDecl, UnitDecl, WorkflowDecl } from './ir';
import type { Loc } from './source';

export const IMPACT_LEVELS = ['none', 'patch', 'minor', 'major'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];
export const levelRank = (l: ImpactLevel) => IMPACT_LEVELS.indexOf(l);
export const maxLevel = (levels: ImpactLevel[]): ImpactLevel =>
  levels.reduce<ImpactLevel>((a, b) => (levelRank(b) > levelRank(a) ? b : a), 'none');

export interface ImpactChange {
  /** The published unit (workflow path or action directory). */
  unit: string;
  kind: 'check-name' | 'interface' | 'unit' | 'permissions' | 'runtime' | 'uses';
  level: ImpactLevel;
  /** False when the change involves something flowpact cannot evaluate (event data, dynamic matrices, …). */
  certain: boolean;
  message: string;
  /** Where to report it: the head location, or the unit's file. */
  loc: Loc;
}

export interface ImpactPolicy {
  /**
   * Globs of published units. Default: `workflow_call` workflows (except files starting with `_`, the usual mark of an
   * internal one) and the repository's root `action.yml`.
   */
  publish?: string[];
  /** Which declared source decides; the others are advisory. Default: `explicit` when given, else `title`. */
  declaredBy?: 'explicit' | 'title' | 'labels';
  labels: Record<ImpactLevel, string>;
  /** Conventional Commits type → level; types not listed declare `none`. */
  types: Record<string, ImpactLevel>;
  /** Count changes flowpact cannot fully resolve towards the required impact (`fail`) or only warn (`warn`). */
  uncertain: 'warn' | 'fail';
}

export const DEFAULT_IMPACT_POLICY: ImpactPolicy = {
  labels: { major: 'semver:major', minor: 'semver:minor', patch: 'semver:patch', none: 'semver:none' },
  types: { feat: 'minor', fix: 'patch', perf: 'patch' },
  uncertain: 'warn',
};

/** Whether other repositories may use the unit. */
export function isPublished(unit: UnitDecl, policy: Pick<ImpactPolicy, 'publish'>): boolean {
  if (policy.publish)
    return policy.publish.some((p) => matchesPattern(unit.file, p) || matchesPattern(unit.path, p));
  if (unit.kind === 'workflow')
    return unit.triggers.includes('workflow_call') && !unit.path.split('/').pop()!.startsWith('_');
  return unit.path === '.';
}

const fileStart = (file: string): Loc => ({ file, line: 1, column: 1, endLine: 1, endColumn: 1 });

// ---------------------------------------------------------------------------
// Check names
// ---------------------------------------------------------------------------

/** One job's checks (a job of the workflow, or a job of a workflow it calls), keyed by the chain of job ids. */
interface JobChecks {
  chain: string;
  stem: string;
  names: CheckName[];
  certain: boolean;
}

function jobChecks(index: ProjectIndex, wf: WorkflowDecl): Map<string, JobChecks> {
  const out = new Map<string, JobChecks>();
  // A published workflow's inputs come from its consumers, so names that read them are not known statically.
  for (const c of workflowChecks(index, wf, 'consumer')) {
    const chain = c.jobs.map((j) => j.split('#')[1]).join(' > ');
    const cur = out.get(chain);
    if (cur) {
      cur.names.push(c);
      cur.certain &&= c.certain;
    } else out.set(chain, { chain, stem: c.stem, names: [c], certain: c.certain });
  }
  return out;
}

const quoteName = (n: string) => `"… / ${n}"`;

function checkNameChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: WorkflowDecl,
  h: WorkflowDecl,
): ImpactChange[] {
  const before = jobChecks(base, b);
  const after = jobChecks(head, h);
  const jobLoc = (chain: string) => {
    const id = chain.split(' > ')[0]!;
    const job: JobDecl | undefined = h.jobs[id];
    return job?.nameLoc ?? job?.loc ?? fileStart(h.file);
  };
  const out: ImpactChange[] = [];
  const add = (level: ImpactLevel, certain: boolean, message: string, loc: Loc) =>
    out.push({ unit: h.path, kind: 'check-name', level, certain, message, loc });
  const headNames = new Set([...after.values()].flatMap((j) => j.names.map((n) => n.name)));
  const baseNames = new Set([...before.values()].flatMap((j) => j.names.map((n) => n.name)));
  const matchedHead = new Set<string>();

  for (const bj of before.values()) {
    let hj = after.get(bj.chain);
    // A job renamed by id but reporting the same names (or the same stem) is the same job to consumers.
    if (!hj) hj = [...after.values()].find((x) => !before.has(x.chain) && x.stem === bj.stem);
    if (!hj) {
      const gone = bj.names.filter((n) => !headNames.has(n.name));
      if (gone.length)
        add(
          'major',
          true,
          `${bj.names.length > 1 ? `checks ${quoteName(bj.stem)}` : `check ${quoteName(bj.names[0]!.name)}`} no longer reported; consumers that require ${bj.names.length > 1 ? 'them' : 'it'} wait forever`,
          fileStart(h.file),
        );
      continue;
    }
    matchedHead.add(hj.chain);
    if (bj.stem !== hj.stem) {
      // The static part changed: every name the job reports changed, whatever the unknown values are.
      add(
        'major',
        true,
        `check ${quoteName(bj.stem)} is now ${quoteName(hj.stem)}; consumers that require the old name wait forever`,
        jobLoc(hj.chain),
      );
      continue;
    }
    // Same stem: compare the names (matrix values). Unknown values cannot be compared.
    const removed = bj.names.filter((n) => n.certain && !headNames.has(n.name));
    const added = hj.names.filter((n) => n.certain && !baseNames.has(n.name));
    for (const n of removed)
      add(
        'major',
        true,
        `check ${quoteName(n.name)} no longer reported; consumers that require it wait forever`,
        jobLoc(hj.chain),
      );
    for (const n of added) add('minor', true, `new check ${quoteName(n.name)}`, jobLoc(hj.chain));
    const unsure = bj.names.some((n) => !n.certain) || hj.names.some((n) => !n.certain);
    if (unsure && JSON.stringify(bj.names.map((n) => n.name)) !== JSON.stringify(hj.names.map((n) => n.name)))
      add('major', false, `checks ${quoteName(bj.stem)} may report different names`, jobLoc(hj.chain));
  }
  for (const hj of after.values()) {
    if (matchedHead.has(hj.chain) || before.has(hj.chain)) continue;
    const fresh = hj.names.filter((n) => !baseNames.has(n.name));
    if (fresh.length)
      add(
        'minor',
        true,
        `new check${hj.names.length > 1 ? 's' : ''} ${quoteName(hj.names.length > 1 ? hj.stem : hj.names[0]!.name)}`,
        jobLoc(hj.chain),
      );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Interfaces, permissions, runtimes, uses
// ---------------------------------------------------------------------------

function contractLevel(path: string, breaking: boolean, message: string): ImpactLevel {
  const root = path.split('.')[0]!;
  // workflow_dispatch inputs belong to the publishing repository's manual runs; consumers call workflow_call.
  if (!['inputs', 'secrets', 'outputs'].includes(root)) return 'none';
  if (breaking) return 'major';
  if (/was added|now optional/.test(message)) return 'minor';
  if (/default/.test(message)) return 'minor';
  if (/description changed/.test(message)) return 'none';
  return 'patch';
}

/** The head declaration a contract change path (`inputs.<name>`, …) names; the file start when it was removed. */
function interfaceLoc(h: UnitDecl, path: string): Loc {
  const dot = path.indexOf('.');
  const kind = path.slice(0, dot);
  const name = path.slice(dot + 1);
  const decls: Record<string, { loc: Loc }> | undefined =
    h.kind === 'workflow'
      ? kind === 'inputs' || kind === 'secrets' || kind === 'outputs'
        ? h.call?.[kind]
        : undefined
      : kind === 'inputs' || kind === 'outputs'
        ? h[kind]
        : undefined;
  return (dot > 0 && decls && Object.hasOwn(decls, name) ? decls[name]?.loc : undefined) ?? fileStart(h.file);
}

function interfaceChanges(base: ProjectIndex, head: ProjectIndex, b: UnitDecl, h: UnitDecl): ImpactChange[] {
  const out: ImpactChange[] = [];
  for (const c of diffContracts(buildContract(base, b), buildContract(head, h))) {
    const level = contractLevel(c.path, c.breaking, c.message);
    if (level === 'none') continue;
    out.push({
      unit: h.path,
      kind: 'interface',
      level,
      certain: true,
      message: c.message,
      loc: interfaceLoc(h, c.path),
    });
  }
  return out;
}

type Scopes = Record<string, number> | 'inherit';
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
const LEVEL_NAMES = ['none', 'read', 'write'];
const SCOPES = [
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'security-events',
  'statuses',
];

function scopesOf(p: PermissionsDecl | undefined): Scopes {
  if (p === undefined) return 'inherit';
  if (p === 'read-all' || p === 'write-all') {
    const level = p === 'read-all' ? 1 : 2;
    return Object.fromEntries(SCOPES.map((s) => [s, s === 'id-token' && level === 1 ? 0 : level]));
  }
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, RANK[v] ?? 0]));
}

/**
 * What each job requests, by chain of job ids, including the jobs of called workflows (GitHub checks nested jobs
 * against what the caller grants, so they count too).
 */
function requestedByJob(
  index: ProjectIndex,
  wf: WorkflowDecl,
  depth = 0,
  seen = new Set<string>(),
): Map<string, Scopes> {
  const out = new Map<string, Scopes>();
  for (const job of Object.values(wf.jobs)) {
    const callee = job.uses ? index.calleeOf(job) : undefined;
    if (callee) {
      if (depth >= 10 || seen.has(callee.path)) continue;
      for (const [chain, s] of requestedByJob(index, callee, depth + 1, new Set([...seen, wf.path])))
        out.set(`${job.id} > ${chain}`, s);
      continue;
    }
    if (!job.uses) out.set(job.id, scopesOf(job.permissions ?? wf.permissions));
  }
  return out;
}

function permissionChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: WorkflowDecl,
  h: WorkflowDecl,
): ImpactChange[] {
  const before = requestedByJob(base, b);
  const after = requestedByJob(head, h);
  const workflowLevel = scopesOf(b.permissions);
  const out: ImpactChange[] = [];
  for (const [chain, hs] of after) {
    if (hs === 'inherit') continue;
    const bs = before.get(chain) ?? workflowLevel;
    const widened = Object.entries(hs).filter(([k, v]) =>
      bs === 'inherit' ? v >= 2 || (k === 'id-token' && v > 0) : v > (bs[k] ?? 0),
    );
    if (!widened.length) continue;
    const job = h.jobs[chain.split(' > ')[0]!];
    out.push({
      unit: h.path,
      kind: 'permissions',
      level: 'major',
      // From an explicit set we know it widened; from inherited permissions it depends on what callers grant.
      certain: bs !== 'inherit',
      message: `jobs.${chain.replaceAll(' > ', ' › ')} now requests ${widened.map(([k, v]) => `${k}: ${LEVEL_NAMES[v]}`).join(', ')}; callers that grant less fail when the run starts`,
      loc: job?.loc ?? fileStart(h.file),
    });
  }
  return out;
}

function remoteUses(unit: UnitDecl): Set<string> {
  const out = new Set<string>();
  const steps = unit.kind === 'workflow' ? Object.values(unit.jobs).flatMap((j) => j.steps) : unit.steps;
  for (const s of steps) if (s.uses?.kind === 'remote-action') out.add(s.uses.raw.split('@')[0]!);
  if (unit.kind === 'workflow')
    for (const j of Object.values(unit.jobs))
      if (j.uses?.kind === 'remote-workflow') out.add(j.uses.raw.split('@')[0]!);
  return out;
}

function usesChanges(b: UnitDecl, h: UnitDecl): ImpactChange[] {
  const before = remoteUses(b);
  return [...remoteUses(h)]
    .filter((u) => !before.has(u))
    .sort()
    .map((u) => ({
      unit: h.path,
      kind: 'uses' as const,
      level: 'minor' as const,
      certain: true,
      message: `now uses ${u}; consumers whose organization only allows listed actions (or requires SHA pinning) must allow it`,
      loc: fileStart(h.file),
    }));
}

function runtimeChanges(b: ActionDecl, h: ActionDecl): ImpactChange[] {
  if ((b.using ?? '') === (h.using ?? '')) return [];
  return [
    {
      unit: h.path,
      kind: 'runtime',
      level: 'major',
      certain: true,
      message: `runs.using changed from ${b.using ?? '(none)'} to ${h.using ?? '(none)'}; runners or GHES versions without it cannot run the action`,
      loc: fileStart(h.file),
    },
  ];
}

const describeUnit = (u: UnitDecl) =>
  u.kind === 'workflow' ? `reusable workflow ${u.path}` : `action ${u.path}`;

/**
 * Every graded change to a published unit between `base` and `head`. `headExists` tells whether a unit's file is still
 * in the working tree (a unit can exist without being loaded, e.g. an action nothing here uses any more).
 */
export function impactChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  policy: Pick<ImpactPolicy, 'publish'>,
  headExists: (file: string) => boolean = () => false,
): ImpactChange[] {
  const out: ImpactChange[] = [];
  const baseUnits = new Map(base.units().map((u) => [u.path, u]));
  const headUnits = new Map(head.units().map((u) => [u.path, u]));
  for (const [path, b] of baseUnits) {
    if (!isPublished(b, policy)) continue;
    const h = headUnits.get(path);
    if (!h || h.kind !== b.kind) {
      if (!h && headExists(b.file)) continue;
      out.push({
        unit: path,
        kind: 'unit',
        level: 'major',
        certain: true,
        message: `${describeUnit(b)} was removed or moved; consumers that reference it fail`,
        loc: fileStart(b.file),
      });
      continue;
    }
    if (!isPublished(h, policy)) {
      out.push({
        unit: path,
        kind: 'unit',
        level: 'major',
        certain: true,
        message:
          h.kind === 'workflow'
            ? `${path} can no longer be called (no workflow_call)`
            : `${path} is no longer published`,
        loc: fileStart(h.file),
      });
      continue;
    }
    if (h.parseErrors.length) {
      out.push({
        unit: path,
        kind: 'unit',
        level: 'major',
        certain: !b.parseErrors.length,
        message: `${describeUnit(h)} has YAML errors (${h.parseErrors[0]!.message}); consumers' runs fail`,
        loc: h.parseErrors[0]!.loc,
      });
      continue;
    }
    if (b.parseErrors.length) {
      out.push({
        unit: path,
        kind: 'unit',
        level: 'patch',
        certain: false,
        message: `${describeUnit(h)} could not be compared: the baseline has YAML errors`,
        loc: fileStart(h.file),
      });
      continue;
    }
    out.push(...interfaceChanges(base, head, b, h), ...usesChanges(b, h));
    if (b.kind === 'workflow' && h.kind === 'workflow')
      out.push(...checkNameChanges(base, head, b, h), ...permissionChanges(base, head, b, h));
    if (b.kind === 'action' && h.kind === 'action') out.push(...runtimeChanges(b, h));
  }
  for (const [path, h] of headUnits) {
    if (!isPublished(h, policy)) continue;
    const b = baseUnits.get(path);
    if (b && isPublished(b, policy)) continue;
    out.push({
      unit: path,
      kind: 'unit',
      level: 'minor',
      certain: true,
      message: `new ${describeUnit(h)}`,
      loc: fileStart(h.file),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declared impact and verdict
// ---------------------------------------------------------------------------

export interface DeclaredSource {
  kind: 'explicit' | 'title' | 'labels' | 'version';
  /** What was read, e.g. the title or the label. */
  value: string;
  level: ImpactLevel;
}

/** `feat!: …` → major, `feat: …` → minor, `fix: …` → patch, other types → none; not Conventional → undefined. */
export function levelFromTitle(title: string, types: Record<string, ImpactLevel>): ImpactLevel | undefined {
  const m = /^([a-z]+)(\([^)]*\))?(!)?: \S/i.exec(title.trim());
  if (!m) return undefined;
  if (m[3]) return 'major';
  return types[m[1]!.toLowerCase()] ?? 'none';
}

export function levelFromLabels(labels: string[], map: Record<ImpactLevel, string>): ImpactLevel | undefined {
  const found = IMPACT_LEVELS.filter((l) => labels.some((x) => x.toLowerCase() === map[l].toLowerCase()));
  return found.length ? maxLevel([...found]) : undefined;
}

/** release-please's pre-1.0 settings (`bump-minor-pre-major`, `bump-patch-for-minor-pre-major`). */
export interface PreMajorBumps {
  bumpMinorPreMajor: boolean;
  bumpPatchForMinorPreMajor: boolean;
}

export interface DeclaredInput {
  explicit?: ImpactLevel;
  title?: string;
  labels?: string[];
  /** A release pull request: the proposed version and the version of the baseline release. */
  release?: { version: string; previous: string } & PreMajorBumps;
}

/**
 * The level a version bump declares. Before 1.0, release-please bumps the minor for breaking changes with
 * `bump-minor-pre-major`, and the patch for features with `bump-patch-for-minor-pre-major`.
 */
export function levelFromVersions(previous: string, next: string, bumps: PreMajorBumps): ImpactLevel {
  const parse = (v: string) =>
    v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number) as [number, number, number];
  const [pa, pb, pc] = parse(previous);
  const [na, nb, nc] = parse(next);
  if (na > pa) return 'major';
  if (nb > pb) return na === 0 && bumps.bumpMinorPreMajor ? 'major' : 'minor';
  if (nc > pc) return na === 0 && bumps.bumpPatchForMinorPreMajor ? 'minor' : 'patch';
  return 'none';
}

export interface ImpactVerdict {
  required: ImpactLevel;
  declared?: DeclaredSource;
  /** Sources that are not authoritative; one declaring more than the authoritative source is a conflict. */
  advisory: DeclaredSource[];
  conflict?: DeclaredSource;
  /** Required impact is covered by the declared one (or nothing is declared). */
  ok: boolean;
}

/** The changes that count towards the required impact. */
export const countedChanges = (changes: ImpactChange[], policy: Pick<ImpactPolicy, 'uncertain'>) =>
  changes.filter((c) => c.certain || policy.uncertain === 'fail');

export function impactVerdict(
  changes: ImpactChange[],
  input: DeclaredInput,
  policy: ImpactPolicy,
): ImpactVerdict {
  const required = maxLevel(countedChanges(changes, policy).map((c) => c.level));
  const sources: DeclaredSource[] = [];
  if (input.explicit) sources.push({ kind: 'explicit', value: input.explicit, level: input.explicit });
  if (input.release) {
    const level = levelFromVersions(input.release.previous, input.release.version, input.release);
    sources.push({ kind: 'version', value: `${input.release.previous} → ${input.release.version}`, level });
  } else if (input.title !== undefined) {
    const level = levelFromTitle(input.title, policy.types);
    if (level) sources.push({ kind: 'title', value: input.title, level });
  }
  if (input.labels?.length) {
    const level = levelFromLabels(input.labels, policy.labels);
    if (level) sources.push({ kind: 'labels', value: input.labels.join(', '), level });
  }
  // Exactly one authoritative source: an explicit level, the release version, or the configured one (title by
  // default). Falling back to another source would declare something the release tool never reads.
  const authority: DeclaredSource['kind'] = input.explicit
    ? 'explicit'
    : input.release
      ? 'version'
      : (policy.declaredBy ?? 'title');
  const declared = sources.find((s) => s.kind === authority);
  const advisory = sources.filter((s) => s !== declared);
  const conflict = declared
    ? advisory.find((s) => levelRank(s.level) > levelRank(declared.level))
    : undefined;
  // `patch` against `none` is not worth failing for: the change reaches users with the next release either way.
  const under =
    declared && levelRank(required) > levelRank(declared.level) && levelRank(required) >= levelRank('minor');
  return {
    required,
    ...(declared ? { declared } : {}),
    advisory,
    ...(conflict ? { conflict } : {}),
    ok: !under && !conflict,
  };
}

/** Impact mode's result: where the baseline came from, every graded change and the verdict. */
export interface ImpactResult {
  baseline: { kind: 'ref' | 'release'; ref: string; commit: string };
  changes: ImpactChange[];
  verdict: ImpactVerdict;
  policy: ImpactPolicy;
  /** Files of the published units (base and head), e.g. to place findings that are not about one change. */
  publishedFiles: string[];
}

/** Grades the changes and judges the declaration in one step. */
export function computeImpact(
  base: ProjectIndex,
  head: ProjectIndex,
  baseline: ImpactResult['baseline'],
  declared: DeclaredInput,
  policy: ImpactPolicy,
  headExists?: (file: string) => boolean,
): ImpactResult {
  const changes = impactChanges(base, head, policy, headExists);
  const publishedFiles = [
    ...new Set([...head.units(), ...base.units()].filter((u) => isPublished(u, policy)).map((u) => u.file)),
  ].sort();
  return { baseline, changes, verdict: impactVerdict(changes, declared, policy), policy, publishedFiles };
}
