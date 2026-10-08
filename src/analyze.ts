import { createHash } from 'node:crypto';
import { ConfigError, defaultConfig, type FlowpactConfig, matchesPattern, type Override } from './config';
import { type ContractPlan, contractsInScope, planContracts, scopePlan } from './contracts';
import { type Project, ProjectIndex } from './graph';
import { computeImpact, type DeclaredInput, type ImpactPolicy, type ImpactResult } from './impact';
import type { JobDecl, UnitDecl } from './ir';
import { type Logger, silentLogger } from './logger';
import { declaredMatrix, expandMatrix, type MatrixExpansion } from './matrix';
import { detectRepository, type FileSystem, loadProject, nodeFileSystem } from './project';
import { createRegistry, IMPACT_CODES } from './rules/index';
import type { RuleRegistry } from './rules/registry';
import type {
  Finding,
  OverrideUsage,
  ReportInput,
  RuleContext,
  RuleDefinition,
  Severity,
  SeveritySetting,
} from './rules/types';
import { didYouMean } from './rules/util';
import { compareLoc, type Loc, SourceFile } from './source';
import { escapeControl } from './text';
import { type ToolMeta, toolMeta } from './version';

export interface AnalyzeOptions {
  root: string;
  paths?: string[];
  fs?: FileSystem;
  config?: FlowpactConfig;
  configFile?: string;
  registry?: RuleRegistry;
  logger?: Logger;
  validateSchema?: boolean;
  repository?: string;
  /** Only run these rules (codes or names). */
  only?: string[];
  /**
   * Impact mode: the baseline's project (analysed from git), where it came from, what the pull request declares and
   * the policy (read from the baseline's config, so a pull request cannot relax its own check).
   */
  impact?: {
    base: ProjectIndex;
    baseline: ImpactResult['baseline'];
    declared: DeclaredInput;
    policy: ImpactPolicy;
    /** Files of the units the baseline published; their head versions are loaded even when nothing uses them. */
    publishedFiles?: string[];
  };
  /** Compare against the contracts in `.github/flowpact/` (`flowpact check`). */
  checkContracts?: boolean;
  /** Clock for override expiry; defaults to the current time. */
  now?: Date;
  /** Locations of `overrides[i]` in the config file (from `loadConfig`). */
  overrideLocs?: Loc[];
  /** Raw config text, so findings about the config can show a code frame. */
  configText?: string;
  /**
   * The config lists plugins that were deliberately not loaded (e.g. the action on untrusted events): rules and
   * overrides that name unknown rules are then tolerated instead of being a config error.
   */
  pluginsSkipped?: boolean;
}

/** A finding that an override accepted. */
export interface SuppressedFinding extends Finding {
  override: { index: number; reason: string; expires?: string; owner?: string };
}

export interface Summary {
  errors: number;
  warnings: number;
  infos: number;
  total: number;
  workflows: number;
  actions: number;
  jobs: number;
  matrixCombinations: number;
  graph: { nodes: number; edges: number };
  byCode: Record<string, number>;
  byFile: Record<string, number>;
  /** Findings accepted by overrides (not counted above). */
  suppressed: number;
}

export interface AnalysisResult {
  meta: ToolMeta & { root: string; configFile?: string; repository?: string };
  project: Project;
  index: ProjectIndex;
  findings: Finding[];
  summary: Summary;
  /** Effective severity per rule after config. */
  rules: { code: string; name: string; severity: SeveritySetting }[];
  /** Findings accepted by overrides, with the override that accepted them. */
  suppressed: SuppressedFinding[];
  /** Contract comparison (check mode only). */
  contracts?: ContractPlan;
  /** The config file, for code frames of FP9xx findings. */
  configSource?: SourceFile;
  /** Impact mode's changes and verdict, when it ran. */
  impact?: ImpactResult;
  /**
   * With plugins skipped: config entries naming rules that are not loaded (presumably plugin rules). They are ignored
   * for this run; the caller should show them as warnings.
   */
  unloadedRules?: string[];
  durationMs: number;
}

/**
 * Sorts config references to unknown rules. With plugins skipped, a name may belong to a plugin rule and is tolerated —
 * unless it uses the built-in `FP` prefix or is a near miss of a built-in rule, which makes it a typo.
 */
function triageUnknown(
  registry: RuleRegistry,
  key: string,
  path: string,
  allowUnknown: boolean | undefined,
  out: { hard: string[]; tolerated: string[] },
) {
  const guess = didYouMean(
    key,
    registry.all().flatMap((r) => [r.code, r.name]),
  );
  const issue = `${path}: unknown rule${guess ? ` (did you mean ${guess}?)` : ` "${key}"`}`;
  if (allowUnknown && !guess && !/^FP\d/i.test(key)) out.tolerated.push(issue);
  else out.hard.push(issue);
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function resolveSeverities(
  registry: RuleRegistry,
  config: FlowpactConfig,
  opts: { allowUnknown?: boolean; logger?: Logger; unloaded?: string[] } = {},
): Map<string, SeveritySetting> {
  const out = new Map<string, SeveritySetting>();
  for (const rule of registry.all()) out.set(rule.code, rule.defaultSeverity);
  const unknown = { hard: [] as string[], tolerated: [] as string[] };
  for (const [key, setting] of Object.entries(config.rules)) {
    const rule = registry.get(key);
    if (!rule) {
      triageUnknown(registry, key, `rules.${key}`, opts.allowUnknown, unknown);
      continue;
    }
    out.set(rule.code, setting);
  }
  if (unknown.hard.length) throw new ConfigError('Config references unknown rules', undefined, unknown.hard);
  if (unknown.tolerated.length) {
    opts.logger?.warn(
      `config sets severities for rules that are not loaded: ${unknown.tolerated.join('; ')}`,
    );
    opts.unloaded?.push(...unknown.tolerated);
  }
  return out;
}

export function fingerprint(code: string, symbol: string | undefined, file: string, message: string): string {
  const normalized = message.replace(/\d+/g, '#');
  return createHash('sha1')
    .update(`${code}|${symbol ?? ''}|${file}|${normalized}`)
    .digest('hex')
    .slice(0, 16);
}

export function analyze(opts: AnalyzeOptions): AnalysisResult {
  const started = performance.now();
  const logger = opts.logger ?? silentLogger;
  const config = opts.config ?? defaultConfig();
  // Units to load even when nothing here uses them: what the config (and, in impact mode, the baseline) publishes.
  const publishPatterns = [
    ...new Set([
      ...(config.impact.publish ?? []),
      ...(opts.impact?.policy.publish ?? []),
      ...(opts.impact?.publishedFiles ?? []),
    ]),
  ];
  const registry = opts.registry ?? createRegistry();
  const repository = opts.repository ?? config.repository ?? detectRepository(opts.root);
  logger.debug('config resolved', {
    file: opts.configFile ?? '(defaults)',
    repository: repository ?? '(unknown)',
    rules: Object.keys(config.rules).length,
  });

  const project = logger.time('load project', () =>
    loadProject({
      root: opts.root,
      ...(opts.fs ? { fs: opts.fs } : {}),
      ...(opts.paths ? { paths: opts.paths } : {}),
      ...(publishPatterns.length ? { publish: publishPatterns } : {}),
      ...(repository ? { repository } : {}),
      validateSchema: opts.validateSchema ?? true,
      logger,
    }),
  );

  const index = logger.time('build graph', () => new ProjectIndex(project));
  logger.info(
    `graph built: ${index.nodes.size} symbols, ${index.edges.length} edges, ${index.callSites.length} reusable calls`,
  );

  const matrixCache = new Map<JobDecl, MatrixExpansion>();
  let combinations = 0;
  const matrix = (unit: UnitDecl, job: JobDecl): MatrixExpansion => {
    let exp = matrixCache.get(job);
    if (!exp) {
      const shape = config.matrixShapes[`${unit.path}#${job.id}`];
      if (shape && (job.matrix?.dynamic || job.matrix?.includeDynamic)) {
        // Declared keys complement whatever the workflow states statically.
        const staticKeys = expandMatrix(job.matrix).keys;
        exp = declaredMatrix([...new Set([...staticKeys, ...shape.keys])]);
      } else {
        exp = expandMatrix(job.matrix);
      }
      matrixCache.set(job, exp);
      combinations += exp.combos.length;
      logger.debug(`matrix expanded: ${unit.path} › jobs.${job.id}`, {
        combinations: exp.combos.length,
        keys: exp.keys,
        exact: exp.exact,
        dynamic: exp.dynamic,
      });
    }
    return exp;
  };
  // Expand every matrix up front so stats and debug logs are complete even if no rule asks.
  for (const wf of project.workflows.values())
    for (const job of Object.values(wf.jobs)) if (job.matrix) matrix(wf, job);

  const allowUnknown = opts.pluginsSkipped === true;
  const unloaded: string[] = [];
  const severities = resolveSeverities(registry, config, { allowUnknown, logger, unloaded });
  const unknownOnly = (opts.only ?? []).filter((o) => !registry.get(o));
  if (unknownOnly.length) {
    const names = registry.all().flatMap((r) => [r.code, r.name]);
    throw new ConfigError(
      'Unknown rule passed to --only',
      undefined,
      unknownOnly.map((o) => {
        const guess = didYouMean(o, names);
        return `${o}: unknown rule${guess ? ` (did you mean ${guess}?)` : ''}`;
      }),
    );
  }
  const only = opts.only?.map((o) => registry.get(o)!.code);
  const ruleLog = logger.child('rules');

  const contractInScope = contractsInScope(index);
  let contracts: ContractPlan | undefined;
  if (opts.checkContracts) {
    contracts = logger.time('compare contracts', () =>
      planContracts(index, opts.fs ?? nodeFileSystem(opts.root)),
    );
    // With paths, only the contracts in scope count (drift output, patch, summary).
    if (project.targets.size > 0) contracts = scopePlan(contracts, contractInScope);
    logger.info(
      `contracts: ${contracts.counts.unchanged} unchanged, ${contracts.counts.update} outdated, ${contracts.counts.create} missing, ${contracts.counts.delete} orphaned`,
      { breaking: contracts.breaking },
    );
  }

  const impact = opts.impact
    ? logger.time('impact', () =>
        computeImpact(
          opts.impact!.base,
          index,
          opts.impact!.baseline,
          opts.impact!.declared,
          opts.impact!.policy,
        ),
      )
    : undefined;

  const runRules = (phase: 'main' | 'post', extra: Partial<RuleContext>): Finding[] => {
    const out: Finding[] = [];
    for (const rule of registry.all()) {
      if ((rule.phase ?? 'main') !== phase) continue;
      const severity = severities.get(rule.code) ?? rule.defaultSeverity;
      if (severity === 'off' || (only && !only.includes(rule.code))) {
        ruleLog.trace(`${rule.code} ${rule.name} skipped`, { severity });
        continue;
      }
      const before = out.length;
      const ctx: RuleContext = {
        index,
        config,
        logger: ruleLog.child(rule.code),
        matrix,
        ...(opts.configFile ? { configFile: opts.configFile } : {}),
        ...(contracts ? { contracts } : {}),
        ...(impact ? { impact } : {}),
        ...extra,
        report: (input) => out.push(toFinding(rule, severity, input, registry)),
      };
      const t0 = performance.now();
      try {
        rule.check(ctx);
      } catch (err) {
        ruleLog.error(`${rule.code} ${rule.name} crashed: ${(err as Error).message}`, {
          stack: (err as Error).stack,
        });
        throw err;
      }
      ruleLog.debug(`${rule.code} ${rule.name}`, {
        findings: out.length - before,
        ms: Math.round((performance.now() - t0) * 100) / 100,
      });
    }
    return out;
  };

  const findings = dedupe(runRules('main', {}));
  // Overrides are matched against the whole repository, so linting a subset of files does not make
  // overrides for other files look unused; the scope filter is applied afterwards.
  const applied = applyOverrides(
    findings,
    config,
    registry,
    opts.overrideLocs ?? [],
    opts.now ?? new Date(),
    { allowUnknown, unloaded },
  );
  for (const u of applied.usage) {
    const code = registry.get(u.override.rule)?.code ?? '';
    const severity = severities.get(code);
    const rule = registry.get(code);
    // Contract rules only run in check mode; under `lint` their overrides cannot be judged. Rules of skipped plugins
    // never run at all.
    const notRun =
      !rule ||
      (IMPACT_CODES.includes(rule.code)
        ? !opts.impact
        : rule.category === 'contracts' && !opts.checkContracts);
    if (severity === 'off' || (only && !only.includes(code)) || notRun) u.inactive = true;
  }
  // The contract of a targeted workflow belongs to it (e.g. a conflicted contract, FP805), and so do the contracts
  // that list it as a consumer.
  const scopedEntries = (contracts?.entries ?? []).filter(contractInScope);
  const contractFilesInScope = new Set(scopedEntries.map((e) => e.file));
  // Contract findings are reported on the workflow they describe; they follow their contract into scope.
  const contractUnitsInScope = new Set(
    scopedEntries.flatMap((e) => (e.unit ? [index.unit(e.unit)?.file ?? e.unit] : [])),
  );
  const inScope = (f: Finding) =>
    (project.targets.size === 0 ||
      project.targets.has(f.loc.file) ||
      contractFilesInScope.has(f.loc.file) ||
      (f.category === 'contracts' && contractUnitsInScope.has(f.loc.file))) &&
    !config.ignore.some((p) => matchesPattern(f.loc.file, p));
  const accepted = applied.kept.filter(inScope);
  const suppressed = applied.suppressed.filter(inScope);
  const usage = applied.usage;
  if (accepted.length + suppressed.length !== findings.length) {
    logger.debug(
      `filtered ${findings.length - accepted.length - suppressed.length} finding(s) by targets/ignore`,
    );
  }
  if (config.overrides.length) {
    logger.info(
      `overrides: ${suppressed.length} finding(s) suppressed by ${usage.filter((u) => u.matched && !u.expired).length} override(s)`,
      {
        expired: usage.filter((u) => u.expired).length,
        unused: usage.filter((u) => !u.matched && !u.expired && !u.inactive).length,
      },
    );
  }
  const post = runRules('post', { overrides: usage });
  const kept = dedupe([...accepted, ...post]).sort(
    (a, b) =>
      compareLoc(a.loc, b.loc) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.code.localeCompare(b.code),
  );

  const summary = summarize(project, index, kept, combinations, suppressed.length);
  const durationMs = Math.round(performance.now() - started);
  logger.info(
    `analysis finished: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} info`,
    { ms: durationMs },
  );

  return {
    meta: {
      ...toolMeta(),
      root: opts.root,
      ...(opts.configFile ? { configFile: opts.configFile } : {}),
      ...(repository ? { repository } : {}),
    },
    project,
    index,
    findings: kept,
    summary,
    rules: registry
      .all()
      .map((r) => ({ code: r.code, name: r.name, severity: severities.get(r.code) ?? r.defaultSeverity })),
    suppressed,
    ...(contracts ? { contracts } : {}),
    ...(unloaded.length ? { unloadedRules: unloaded } : {}),
    ...(impact ? { impact } : {}),
    ...(opts.configFile && opts.configText !== undefined
      ? { configSource: new SourceFile(opts.configFile, opts.configText) }
      : {}),
    durationMs,
  };
}

function toFinding(
  rule: RuleDefinition,
  severity: SeveritySetting,
  input: ReportInput,
  registry: RuleRegistry,
): Finding {
  return {
    code: rule.code,
    name: rule.name,
    severity: severity as Severity,
    category: rule.category,
    message: escapeControl(input.message),
    loc: input.loc,
    related: (input.related ?? []).map((r) => ({ ...r, message: escapeControl(r.message) })),
    ...(input.combos?.length ? { combos: input.combos.map((c) => escapeControl(c)) } : {}),
    ...(input.symbol ? { symbol: escapeControl(input.symbol) } : {}),
    why: rule.docs.why,
    // Per-finding fixes embed names from the YAML, so newlines are escaped unless the rule vouches for the text.
    fix:
      input.fix !== undefined
        ? escapeControl(input.fix, input.fixMultiline === true)
        : escapeControl(rule.docs.fix, true),
    docsUrl: registry.docsUrl(rule),
    fingerprint: fingerprint(rule.code, input.symbol, input.loc.file, input.message),
  };
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.code}|${f.loc.file}:${f.loc.line}:${f.loc.column}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(
  project: Project,
  index: ProjectIndex,
  findings: Finding[],
  combinations: number,
  suppressed: number,
): Summary {
  const byCode: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  for (const f of findings) {
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    byFile[f.loc.file] = (byFile[f.loc.file] ?? 0) + 1;
  }
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    infos: findings.filter((f) => f.severity === 'info').length,
    total: findings.length,
    workflows: project.workflows.size,
    actions: project.actions.size,
    jobs: [...project.workflows.values()].reduce((n, wf) => n + Object.keys(wf.jobs).length, 0),
    matrixCombinations: combinations,
    graph: { nodes: index.nodes.size, edges: index.edges.length },
    byCode,
    byFile,
    suppressed,
  };
}

const DAY = 86_400_000;

/** Glob for symbols and paths: `**` matches anything, `*` anything except `/`. Exact match otherwise. */
export function matchesTarget(value: string, pattern: string): boolean {
  if (!pattern.includes('*')) return value === pattern;
  const re = new RegExp(
    `^${pattern
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*')}$`,
  );
  return re.test(value);
}

export function overrideMatches(o: Override, code: string, f: Finding): boolean {
  if (code !== f.code) return false;
  if (o.target !== undefined && (f.symbol === undefined || !matchesTarget(f.symbol, o.target))) return false;
  if (o.file !== undefined && !matchesPattern(f.loc.file, o.file) && !matchesTarget(f.loc.file, o.file))
    return false;
  return true;
}

/** Splits findings into kept and suppressed, and records how each override was used. */
export function applyOverrides(
  findings: Finding[],
  config: FlowpactConfig,
  registry: RuleRegistry,
  locs: Loc[],
  now: Date,
  opts: { allowUnknown?: boolean; unloaded?: string[] } = {},
): { kept: Finding[]; suppressed: SuppressedFinding[]; usage: OverrideUsage[] } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const unknown = { hard: [] as string[], tolerated: [] as string[] };
  const usage: (OverrideUsage & { code: string })[] = config.overrides.map((override, index) => {
    const rule = registry.get(override.rule);
    if (!rule) triageUnknown(registry, override.rule, `overrides.${index}.rule`, opts.allowUnknown, unknown);
    const daysLeft = override.expires
      ? Math.round((Date.parse(`${override.expires}T00:00:00Z`) - today) / DAY)
      : undefined;
    return {
      index,
      override,
      code: rule?.code ?? '',
      ...(locs[index] ? { loc: locs[index] } : {}),
      matched: 0,
      expired: daysLeft !== undefined && daysLeft < 0,
      ...(daysLeft !== undefined ? { daysLeft } : {}),
    };
  });
  if (unknown.hard.length)
    throw new ConfigError('Config overrides reference unknown rules', undefined, unknown.hard);
  opts.unloaded?.push(...unknown.tolerated);
  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    const matching = usage.filter((u) => overrideMatches(u.override, u.code, f));
    for (const u of matching) u.matched++;
    const active = matching.find((u) => !u.expired);
    if (!active) {
      kept.push(f);
      continue;
    }
    const o = active.override;
    suppressed.push({
      ...f,
      override: {
        index: active.index,
        reason: o.reason,
        ...(o.expires ? { expires: o.expires } : {}),
        ...(o.owner ? { owner: o.owner } : {}),
      },
    });
  }
  return { kept, suppressed, usage: usage.map(({ code: _code, ...u }) => u) };
}

/** Exit code policy shared by the CLI and the action. */
export function exitCodeFor(
  summary: Pick<Summary, 'errors' | 'warnings'>,
  failOn: 'error' | 'warning' | 'never',
): number {
  if (failOn === 'never') return 0;
  if (summary.errors > 0) return 1;
  if (failOn === 'warning' && summary.warnings > 0) return 1;
  return 0;
}
