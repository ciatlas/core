import { sym } from '../graph';
import type { Diagnostic, ExprSite } from '../ir';
import { lookup } from '../ir';
import type { Loc } from '../source';
import { defineRule, type RuleDefinition } from './types';
import { quote } from './util';

const GITHUB_ENV_HINTS: Record<string, string> = {
  GITHUB_SHA: 'github.sha',
  GITHUB_REF: 'github.ref',
  GITHUB_REF_NAME: 'github.ref_name',
  GITHUB_REPOSITORY: 'github.repository',
  GITHUB_RUN_ID: 'github.run_id',
  GITHUB_RUN_NUMBER: 'github.run_number',
  GITHUB_ACTOR: 'github.actor',
  GITHUB_WORKSPACE: 'github.workspace',
  GITHUB_EVENT_NAME: 'github.event_name',
  GITHUB_HEAD_REF: 'github.head_ref',
  GITHUB_BASE_REF: 'github.base_ref',
  RUNNER_OS: 'runner.os',
  RUNNER_TEMP: 'runner.temp',
  RUNNER_ARCH: 'runner.arch',
};

export const undefinedEnvRef = defineRule({
  code: 'FP501',
  name: 'undefined-env-ref',
  category: 'expressions',
  defaultSeverity: 'warning',
  docs: {
    summary:
      '`${{ env.NAME }}` reads a variable that is not defined at workflow, job or step level, nor written to `$GITHUB_ENV` earlier.',
    why:
      'The `env` context only contains variables set by the workflow itself — not runner defaults like `GITHUB_SHA`. ' +
      'Reads of anything else evaluate to an empty string.',
    fix: 'Define the variable under `env:`, write it to `$GITHUB_ENV` in an earlier step, or use the matching context (e.g. `github.sha`).',
    examples: {
      bad: `run: echo \${{ env.GITHUB_SHA }}`,
      good: `run: echo \${{ github.sha }}   # or "$GITHUB_SHA" in the shell`,
    },
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      for (const site of wf.sites) {
        if (site.field === 'workflow.env' || site.field === 'input.default') continue;
        const job = site.job ? wf.jobs[site.job] : undefined;
        const step = job && site.step !== undefined ? job.steps[site.step] : undefined;
        for (const seg of site.segments) {
          for (const ref of seg.refs) {
            const name = ref.path[0];
            if (ref.context !== 'env' || !name || name === '*' || name === '?') continue;
            if (lookup(wf.env, name) || (job && lookup(job.env, name)) || (step && lookup(step.env, name)))
              continue;
            if (job) {
              const earlier = site.step === undefined ? job.steps : job.steps.slice(0, site.step);
              if (earlier.some((s) => s.writesEnv.dynamic)) continue;
              if (earlier.some((s) => s.writesEnv.names.some((n) => n.toLowerCase() === name.toLowerCase())))
                continue;
              // Composite actions and remote actions may export variables we cannot see.
              if (earlier.some((s) => s.uses && s.uses.kind !== 'docker')) continue;
            }
            const hint = GITHUB_ENV_HINTS[name.toUpperCase()];
            ctx.report({
              message: `env.${name} is not defined in this scope${hint ? ` — runner variables are not in the env context; use ${hint}` : ''}`,
              loc: ref.loc,
              symbol: sym.env(wf.path, site.job, name),
              ...(hint ? { fix: `Replace \`env.${name}\` with \`${hint}\`.` } : {}),
            });
          }
        }
      }
    }
  },
});

export const expressionParseError = defineRule({
  code: 'FP502',
  name: 'expression-parse-error',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary: 'A `${{ }}` expression (or an `if:` condition) cannot be parsed.',
    why: 'GitHub rejects the workflow when it is triggered, or fails the step that contains the expression.',
    fix: 'Fix the syntax: strings use single quotes, `==` for equality, and every `${{` needs a closing `}}`.',
    examples: {
      bad: `if: \${{ inputs.mode = "release" }}`,
      good: `if: \${{ inputs.mode == 'release' }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const site of unit.sites) {
        for (const seg of site.segments) {
          if (!seg.expr.error) continue;
          const loc = { ...seg.loc };
          if (seg.loc.line === seg.loc.endLine) {
            loc.column = seg.loc.column + seg.expr.error.offset;
            loc.endColumn = Math.max(loc.column + 1, seg.loc.endColumn);
          }
          ctx.report({
            message: `Invalid expression ${quote(seg.expr.source.length > 60 ? `${seg.expr.source.slice(0, 57)}...` : seg.expr.source)}: ${seg.expr.error.message}`,
            loc,
          });
        }
      }
    }
  },
});

export const schemaViolation = defineRule({
  code: 'FP503',
  name: 'schema-violation',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary:
      'The file does not match GitHub’s workflow / action schema (validated with GitHub’s own parser).',
    why: 'GitHub refuses to run a workflow with schema errors, often only when the trigger fires.',
    fix: 'Correct the key or value reported; the message comes from @actions/workflow-parser, the parser GitHub’s tooling uses.',
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const e of unit.schemaErrors) if (!e.kind) ctx.report({ message: e.message, loc: e.loc });
    }
  },
});

export const contextNotAvailable = defineRule({
  code: 'FP505',
  name: 'context-not-available',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary:
      'An expression uses a context or function that GitHub does not allow in that field (e.g. `env` in a reusable workflow call’s `with:`).',
    why:
      'GitHub only makes some contexts available per field. `env` is not passed to reusable workflows and cannot be used in ' +
      '`jobs.<id>.with` or `jobs.<id>.if`; `secrets` cannot be used in `if:`. GitHub rejects the whole workflow when it is ' +
      'triggered — often only on the branch or event that reaches it. Reported by GitHub’s own parser.',
    fix: 'Use a context that is available there: pass values through `inputs`/`vars`, compute them in an earlier job and read `needs.<job>.outputs`, or move the check into a step (`if: env.X == ...` works in steps).',
    examples: {
      bad: `env:
  TARGET: prod
jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    with:
      target: \${{ env.TARGET }}   # env is not available here`,
      good: `jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    with:
      target: \${{ vars.TARGET }}`,
    },
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      // 1. What GitHub's own parser reports (expressions inside ${{ }}).
      for (const e of unit.schemaErrors) {
        if (e.kind !== 'context') continue;
        const name = /'([^']+)'/.exec(e.message)?.[1];
        ctx.report({
          message: `${name ? `\`${name}\`` : 'This context'} is not available here — ${unit.kind === 'workflow' ? 'GitHub rejects the workflow' : 'GitHub fails the step using the action'} ("${e.message}")`,
          loc: refLocFor(unit.sites, e, name) ?? e.loc,
        });
      }
      // 2. Bare `if:` conditions, which the parser does not validate, against GitHub's context-availability table.
      for (const site of unit.sites) {
        if (!site.isCondition || site.text.includes('${{')) continue;
        const table = CONDITION_TABLES[`${unit.kind}:${site.field}`];
        if (!table) continue;
        const rejects =
          unit.kind === 'workflow' ? 'GitHub rejects the workflow' : 'GitHub fails the step using the action';
        for (const seg of site.segments) {
          for (const ref of seg.refs) {
            if (table.contexts.has(ref.context)) continue;
            ctx.report({
              message: `\`${ref.context}\` is not available in ${table.label} — ${rejects} ("Unrecognized named-value: '${ref.context}'")`,
              loc: ref.loc,
            });
          }
          if (!table.functions) continue;
          for (const fn of functionCalls(seg.expr.source)) {
            const name = fn.name.toLowerCase();
            if (STANDARD_FUNCTIONS.has(name) || table.functions.has(name)) continue;
            ctx.report({
              message: `\`${fn.name}()\` is not available in ${table.label} — ${rejects} ("Unrecognized function: '${fn.name}'")`,
              loc: seg.expr.source.includes('\n')
                ? seg.loc
                : {
                    ...seg.loc,
                    column: seg.loc.column + fn.offset,
                    endLine: seg.loc.line,
                    endColumn: seg.loc.column + fn.offset + fn.name.length,
                  },
            });
          }
        }
      }
    }
  },
});

/** Function names called in an expression (outside string literals), with their offset. */
function functionCalls(source: string): { name: string; offset: number }[] {
  const blanked = source.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length));
  return [...blanked.matchAll(/(?<![\w.-])([A-Za-z_]\w*)\s*\(/g)].map((m) => ({
    name: m[1]!,
    offset: m.index,
  }));
}

const STANDARD_FUNCTIONS = new Set([
  'contains',
  'startswith',
  'endswith',
  'format',
  'join',
  'tojson',
  'fromjson',
]);
const STATUS_FUNCTIONS = ['always', 'success', 'failure', 'cancelled'];

/**
 * https://docs.github.com/actions/learn-github-actions/contexts#context-availability and GitHub's workflow and action
 * schemas: contexts (and, where they are restricted, functions) allowed in each bare condition.
 */
const CONDITION_TABLES: Record<string, { label: string; contexts: Set<string>; functions?: Set<string> }> = {
  'workflow:job.if': {
    label: "a job's `if:`",
    contexts: new Set(['github', 'needs', 'vars', 'inputs']),
    functions: new Set(STATUS_FUNCTIONS),
  },
  'workflow:step.if': {
    label: "a step's `if:`",
    contexts: new Set([
      'github',
      'needs',
      'strategy',
      'matrix',
      'job',
      'runner',
      'env',
      'vars',
      'steps',
      'inputs',
    ]),
  },
  'action:step.if': {
    label: "a composite action step's `if:`",
    contexts: new Set(['github', 'inputs', 'strategy', 'matrix', 'steps', 'job', 'runner', 'env']),
  },
  'action:action.runs-if': {
    label: "an action's `pre-if:`/`post-if:`",
    contexts: new Set(['runner', 'github', 'job', 'strategy', 'matrix', 'env', 'inputs']),
  },
};

/** Maps a parser error to the offending reference: the parser's own range is off for multi-line scalars. */
function refLocFor(sites: ExprSite[], e: Diagnostic, name: string | undefined): Loc | undefined {
  if (!e.at || !name) return undefined;
  const site = sites.find((s) => s.loc.line === e.at!.line && Math.abs(s.loc.column - e.at!.column) <= 1);
  for (const seg of site?.segments ?? [])
    for (const r of seg.refs) if (r.context === name.toLowerCase()) return r.loc;
  return site?.loc;
}

export const yamlSyntaxError = defineRule({
  code: 'FP504',
  name: 'yaml-syntax-error',
  category: 'expressions',
  defaultSeverity: 'error',
  docs: {
    summary: 'The file is not valid YAML.',
    why: 'Nothing in the file can run, and every analysis of it is incomplete.',
    fix: 'Fix the YAML syntax at the reported position (indentation, unclosed quotes, duplicate keys).',
  },
  check(ctx) {
    for (const unit of ctx.index.units()) {
      for (const e of unit.parseErrors) ctx.report({ message: e.message, loc: e.loc });
    }
  },
});

export const expressionRules: RuleDefinition[] = [
  contextNotAvailable,
  undefinedEnvRef,
  expressionParseError,
  schemaViolation,
  yamlSyntaxError,
];
