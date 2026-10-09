import type { FlowpactConfig, Override } from '../config';
import type { ContractPlan } from '../contracts';
import type { ProjectIndex } from '../graph';
import type { ImpactResult } from '../impact';
import type { JobDecl, UnitDecl } from '../ir';
import type { Logger } from '../logger';
import type { MatrixExpansion } from '../matrix';
import type { Loc } from '../source';

export type Severity = 'error' | 'warning' | 'info';
export type SeveritySetting = Severity | 'off';

export const CATEGORIES = {
  1: { id: 'inputs', title: 'Inputs' },
  2: { id: 'secrets', title: 'Secrets' },
  3: { id: 'outputs', title: 'Outputs' },
  4: { id: 'matrix', title: 'Matrix' },
  5: { id: 'expressions', title: 'Env & expressions' },
  6: { id: 'structure', title: 'Graph structure' },
  7: { id: 'hygiene', title: 'Hygiene' },
  8: { id: 'contracts', title: 'Contracts' },
  9: { id: 'config', title: 'Config & overrides' },
} as const;

export type RuleCategory = (typeof CATEGORIES)[keyof typeof CATEGORIES]['id'];

export interface RuleDocs {
  /** One line, shown in `flowpact rules` and as the docs page subtitle. */
  summary: string;
  /** Why this matters — shown under every finding. */
  why: string;
  /** How to fix it — shown under every finding. */
  fix: string;
  /** What the rule deliberately leaves out — shown on the docs page and by `flowpact explain`, not with findings. */
  scope?: string;
  /** Minimal YAML examples rendered on the docs page. */
  examples?: { bad: string; good: string };
}

export interface RelatedLocation {
  loc: Loc;
  message: string;
}

export interface Finding {
  code: string;
  name: string;
  severity: Severity;
  category: RuleCategory;
  message: string;
  loc: Loc;
  /** Supporting locations; for cross-workflow issues this is the call chain, outermost first. */
  related: RelatedLocation[];
  /** Matrix combinations affected, as labels. */
  combos?: string[];
  /** Stable symbol id the finding is about (used for overrides and `flowpact trace`). */
  symbol?: string;
  why: string;
  fix: string;
  docsUrl: string;
  /** Stable hash of code + symbol/location + message; survives unrelated edits. */
  fingerprint: string;
}

export interface ReportInput {
  message: string;
  loc: Loc;
  related?: RelatedLocation[];
  combos?: string[];
  symbol?: string;
  /** Instance-specific fix text; the rule's generic fix is used when omitted. */
  fix?: string;
  /**
   * Keep newlines in `fix` (e.g. a YAML snippet). Only set it when every interpolated value cannot contain a newline,
   * such as identifiers parsed from expressions; otherwise newlines are shown as `\n`.
   */
  fixMultiline?: boolean;
  /**
   * Report this finding below the rule's severity (e.g. a key GitHub ignores, where the rule's other findings are keys
   * it rejects). It only ever lowers: the finding gets the less severe of this and the rule's configured severity.
   */
  severity?: Severity;
}

/** How each configured override was used in this run (available to post-phase rules). */
export interface OverrideUsage {
  index: number;
  override: Override;
  loc?: Loc;
  matched: number;
  expired: boolean;
  /** Days until expiry (negative when expired); undefined without `expires`. */
  daysLeft?: number;
  /** The override's rule did not run (turned off or excluded by `--only`), so its usage cannot be judged. */
  inactive?: boolean;
  /**
   * When it matches no finding: how many findings it would match that are not reported because they are about the
   * internals of generated files.
   */
  skippedInGenerated?: number;
}

export interface RuleContext {
  readonly index: ProjectIndex;
  readonly config: FlowpactConfig;
  readonly logger: Logger;
  /** Repo-relative path of the config file, when one was loaded. */
  readonly configFile?: string;
  /** Contract comparison; only present in check mode (`flowpact check`). */
  readonly contracts?: ContractPlan;
  /** Impact mode: graded changes of published units and the verdict; only present when impact mode runs. */
  readonly impact?: ImpactResult;
  /** Override usage; only present for post-phase rules. */
  readonly overrides?: OverrideUsage[];
  /** Cached matrix expansion of a job. */
  matrix(unit: UnitDecl, job: JobDecl): MatrixExpansion;
  /** Whether a rule runs in this analysis: loaded, not turned off, and selected by `--only` if that is given. */
  runs(code: string): boolean;
  report(input: ReportInput): void;
}

export interface RuleDefinition {
  /** `<PREFIX><category digit><two digits>`, e.g. `FP401`. */
  code: string;
  /** kebab-case, e.g. `empty-binding-for-matrix-combo`. */
  name: string;
  category: RuleCategory;
  defaultSeverity: SeveritySetting;
  docs: RuleDocs;
  /** Required for third-party rules; built-in rules derive it from the code. */
  docsUrl?: string;
  /**
   * `post` rules run after overrides were applied and see `ctx.overrides`; their own findings cannot be
   * suppressed by overrides. Default: `main`.
   */
  phase?: 'main' | 'post';
  /**
   * `skip` drops the rule's findings located in generated files (a `DO NOT EDIT` header, a gh-aw `.lock.yml`), which
   * nobody edits by hand. For rules about a file's own internals, such as dead declarations or style; checks of calls
   * between units keep `report`. Default: `report`.
   */
  generatedFiles?: 'report' | 'skip';
  check(ctx: RuleContext): void;
}

export function defineRule(rule: RuleDefinition): RuleDefinition {
  return rule;
}
