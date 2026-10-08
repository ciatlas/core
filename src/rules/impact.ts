import type { ImpactChange, ImpactLevel, ImpactResult } from '../impact';
import { countedChanges, levelRank } from '../impact';
import type { Loc } from '../source';
import { defineRule, type RelatedLocation, type RuleDefinition } from './types';

const describeSource = (s: { kind: string; value: string }) =>
  s.kind === 'explicit'
    ? 'the explicit impact'
    : s.kind === 'version'
      ? `the version bump ${s.value}`
      : `the ${s.kind === 'title' ? 'title' : 'labels'} "${s.value}"`;

const related = (changes: ImpactChange[]): RelatedLocation[] =>
  changes.slice(0, 20).map((c) => ({ loc: c.loc, message: `${c.level}: ${c.message}` }));

/** Where a verdict is reported: its first driving change, else any change, else the first published file. */
const verdictLoc = (impact: ImpactResult, changes: ImpactChange[]): Loc =>
  changes[0]?.loc ??
  impact.changes[0]?.loc ?? {
    file: impact.publishedFiles[0] ?? 'action.yml',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
  };

/** The changes that decide the required level (uncertain ones too when `impact.uncertain` is `fail`). */
const driving = (impact: ImpactResult, level: ImpactLevel) =>
  countedChanges(impact.changes, impact.policy).filter((c) => c.level === level);

export const impactUnderDeclared = defineRule({
  code: 'FP810',
  name: 'impact-under-declared',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary:
      'The changes to published workflows or actions need a bigger release than the pull request declares.',
    why:
      'Consumers pin a floating tag (`@v1`) or a version range and take every release in it. A breaking change released ' +
      'as a minor or patch reaches them without warning: a renamed job leaves their required status check waiting ' +
      'forever, a removed input fails their run.',
    fix: 'Declare the required impact (for example retitle the pull request `feat!: …` for a major release), or keep the published interface and check names compatible.',
    examples: {
      bad: `# PR title: "fix: tidy the test job"
jobs:
  test:
    name: Unit tests   # was "Test": consumers' required check "… / Test" never reports`,
      good: `# PR title: "fix!: rename the test job's check to Unit tests"`,
    },
  },
  check(ctx) {
    const v = ctx.impact?.verdict;
    if (
      !v?.declared ||
      levelRank(v.required) <= levelRank(v.declared.level) ||
      levelRank(v.required) < levelRank('minor')
    )
      return;
    const changes = driving(ctx.impact!, v.required);
    ctx.report({
      message: `Declared ${v.declared.level} (${describeSource(v.declared)}), but the changes require ${v.required}: ${changes[0]?.message ?? ''}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ''}`,
      loc: verdictLoc(ctx.impact!, changes),
      related: related(changes),
      symbol: `impact#${v.required}`,
    });
  },
});

export const impactConflict = defineRule({
  code: 'FP811',
  name: 'impact-declaration-conflict',
  category: 'contracts',
  defaultSeverity: 'error',
  docs: {
    summary: 'Another source declares a bigger impact than the one the release tool reads.',
    why:
      'Release tools read one thing — usually the squashed commit title. A `semver:major` label on a `fix:` pull ' +
      'request looks right in review, but the release is cut as a patch.',
    fix: 'Make the authoritative source (`impact.declaredBy`, the title by default) declare the impact, for example `feat!: …`.',
  },
  check(ctx) {
    const v = ctx.impact?.verdict;
    if (!v?.declared || !v.conflict) return;
    ctx.report({
      message: `${describeSource(v.conflict)} declares ${v.conflict.level}, but ${describeSource(v.declared)} — what the release tool reads — declares ${v.declared.level}`,
      loc: verdictLoc(ctx.impact!, []),
      symbol: 'impact#conflict',
    });
  },
});

export const impactOverDeclared = defineRule({
  code: 'FP812',
  name: 'impact-over-declared',
  category: 'contracts',
  defaultSeverity: 'info',
  docs: {
    summary: 'The pull request declares a bigger impact than its workflow and action changes require.',
    why: 'Not a problem: the release may contain changes flowpact does not grade. Reported so the declaration is visible.',
    fix: 'Nothing to fix if the release has other changes; otherwise declare the smaller impact.',
  },
  check(ctx) {
    const v = ctx.impact?.verdict;
    if (!v?.declared || levelRank(v.declared.level) <= levelRank(v.required)) return;
    ctx.report({
      message: `Declared ${v.declared.level} (${describeSource(v.declared)}); the workflow and action changes require ${v.required}`,
      loc: verdictLoc(ctx.impact!, []),
      symbol: 'impact#over',
    });
  },
});

export const impactUndeclared = defineRule({
  code: 'FP813',
  name: 'impact-undeclared',
  category: 'contracts',
  defaultSeverity: 'info',
  docs: {
    summary: 'No release impact is declared; flowpact reports the impact the changes require.',
    why: 'Without a declaration there is nothing to check against. The required impact is still useful when cutting a release.',
    fix: 'Declare the impact: a Conventional Commits pull request title (`feat: …`, `fix!: …`), a `semver:*` label, or `--expect`.',
  },
  check(ctx) {
    const v = ctx.impact?.verdict;
    if (!v || v.declared) return;
    const changes = driving(ctx.impact!, v.required);
    ctx.report({
      message: `No impact declared; the changes to published workflows and actions require ${v.required}`,
      loc: verdictLoc(ctx.impact!, changes),
      related: related(changes),
      symbol: 'impact#undeclared',
    });
  },
});

export const impactUncertain = defineRule({
  code: 'FP814',
  name: 'impact-uncertain',
  category: 'contracts',
  defaultSeverity: 'warning',
  docs: {
    summary: 'A change to a published unit depends on something flowpact cannot evaluate statically.',
    why:
      'For example a check name built from the triggering event, `needs` outputs or `vars`, or a matrix computed at ' +
      'runtime. flowpact cannot tell whether consumers see a different check name, so it does not count the change ' +
      '(`impact.uncertain: fail` counts it).',
    fix: 'Review the change by hand, or make the name static (a literal `name:` or one built only from `matrix` and `inputs`).',
  },
  check(ctx) {
    for (const c of ctx.impact?.changes ?? []) {
      if (c.certain) continue;
      ctx.report({ message: `Possibly ${c.level}: ${c.message}`, loc: c.loc, symbol: `${c.unit}#impact` });
    }
  },
});

export const impactRules: RuleDefinition[] = [
  impactUnderDeclared,
  impactConflict,
  impactOverDeclared,
  impactUndeclared,
  impactUncertain,
];

export const IMPACT_CODES = impactRules.map((r) => r.code);
