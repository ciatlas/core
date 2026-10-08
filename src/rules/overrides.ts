import type { Loc } from '../source';
import { defineRule, type RuleDefinition } from './types';

/** Days before expiry at which FP903 starts reminding. */
export const EXPIRY_WARNING_DAYS = 14;

const configLoc = (loc: Loc | undefined): Loc =>
  loc ?? { file: '.github/flowpact/flowpact.config.yml', line: 1, column: 1, endLine: 1, endColumn: 1 };

const describe = (o: { rule: string; target?: string | undefined; file?: string | undefined }) =>
  `${o.rule} on ${o.target ?? o.file}`;

export const overrideExpired = defineRule({
  code: 'FP901',
  name: 'override-expired',
  category: 'config',
  defaultSeverity: 'error',
  phase: 'post',
  docs: {
    summary: 'An override passed its `expires` date; the findings it suppressed are reported again.',
    why:
      'Overrides are meant to be temporary exceptions with an owner. An expired one means the follow-up work was not done ' +
      'and the original problem is back in scope.',
    fix: 'Fix the underlying findings and delete the override, or — if the exception is still justified — extend `expires` with an updated reason.',
    examples: {
      bad: `overrides:
  - rule: unused-input
    target: .github/workflows/pipeline.yml#inputs.legacy-flag
    reason: Read by the release dispatcher until the migration (JIRA-123)
    expires: 2026-01-31`,
      good: `# migration done: input removed, override deleted`,
    },
  },
  check(ctx) {
    for (const u of ctx.overrides ?? []) {
      // Like FP902: an override whose rule did not run (off, --only, contract rules under lint) is judged where it runs.
      if (!u.expired || u.inactive) continue;
      const owner = u.override.owner ? ` (owner ${u.override.owner})` : '';
      ctx.report({
        message: u.matched
          ? `Override for ${describe(u.override)} expired on ${u.override.expires}${owner}; ${u.matched} finding${u.matched === 1 ? ' is' : 's are'} reported again`
          : `Override for ${describe(u.override)} expired on ${u.override.expires}${owner}; it matches no finding now`,
        loc: configLoc(u.loc),
        fix: u.matched
          ? `Fix the finding${u.matched === 1 ? '' : 's'} and delete the override, or extend \`expires\` with an updated reason ("${u.override.reason}").`
          : 'Delete the override.',
      });
    }
  },
});

export const overrideUnused = defineRule({
  code: 'FP902',
  name: 'override-unused',
  category: 'config',
  defaultSeverity: 'warning',
  phase: 'post',
  docs: {
    summary: 'An override matches no finding — the problem was fixed, or the target is misspelled.',
    why: 'Stale overrides hide future problems at the same target and make the exception list untrustworthy.',
    fix: 'Delete the override, or correct its `rule` / `target` / `file` (use the `symbol` shown in JSON output or `flowpact lint --format json`).',
  },
  check(ctx) {
    for (const u of ctx.overrides ?? []) {
      if (u.expired || u.inactive || u.matched > 0) continue;
      ctx.report({
        message: `Override for ${describe(u.override)} matches no finding`,
        loc: configLoc(u.loc),
      });
    }
  },
});

export const overrideExpiringSoon = defineRule({
  code: 'FP903',
  name: 'override-expiring-soon',
  category: 'config',
  defaultSeverity: 'info',
  phase: 'post',
  docs: {
    summary: `An override expires within ${EXPIRY_WARNING_DAYS} days.`,
    why: 'A heads-up so the owner can finish the follow-up before the build starts failing.',
    fix: 'Fix the underlying findings, or extend `expires` with an updated reason.',
  },
  check(ctx) {
    for (const u of ctx.overrides ?? []) {
      if (u.expired || u.daysLeft === undefined || u.daysLeft > EXPIRY_WARNING_DAYS || u.matched === 0)
        continue;
      ctx.report({
        message: `Override for ${describe(u.override)} expires in ${u.daysLeft} day${u.daysLeft === 1 ? '' : 's'} (${u.override.expires})${u.override.owner ? ` — owner ${u.override.owner}` : ''}`,
        loc: configLoc(u.loc),
      });
    }
  },
});

export const overrideRules: RuleDefinition[] = [overrideExpired, overrideUnused, overrideExpiringSoon];
