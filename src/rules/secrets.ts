import { type ContextResolver, definitelyFalsy, evaluateTemplate, known, UNKNOWN } from '../expressions';
import type { CallSite, ProjectIndex } from '../graph';
import { sym } from '../graph';
import { type ExprSite, lookup, type WorkflowDecl } from '../ir';
import { escapeControl } from '../text';
import { defineRule, type RuleDefinition } from './types';
import {
  chainRelated,
  chainTo,
  didYouMean,
  isWholeExpression,
  listNames,
  quote,
  readsContextDynamically,
  refsOf,
} from './util';

const BUILTIN_SECRETS = new Set(['github_token']);

/** Secrets a workflow reads directly, plus those read by callees it hands every secret to via `secrets: inherit`. */
export function secretsNeededBy(
  index: ProjectIndex,
  wf: WorkflowDecl,
  seen = new Set<string>(),
): Set<string> {
  const out = new Set<string>();
  if (seen.has(wf.path)) return out;
  seen.add(wf.path);
  for (const { ref } of refsOf(wf)) {
    const name = ref.path[0];
    if (
      ref.context === 'secrets' &&
      name &&
      name !== '*' &&
      name !== '?' &&
      !BUILTIN_SECRETS.has(name.toLowerCase())
    ) {
      out.add(name);
    }
  }
  for (const job of Object.values(wf.jobs)) {
    if (!job.secretsInherit) continue;
    const callee = index.calleeOf(job);
    if (callee) for (const s of secretsNeededBy(index, callee, seen)) out.add(s);
  }
  return out;
}

export const missingRequiredSecret = defineRule({
  code: 'FP201',
  name: 'missing-required-secret',
  category: 'secrets',
  defaultSeverity: 'error',
  docs: {
    summary: 'A reusable workflow is called without one of its required secrets.',
    why: 'GitHub fails the run when a required secret is not passed — but only when that call path actually executes.',
    fix: 'Pass the secret under `secrets:`, or use `secrets: inherit` if the callee should see all repository secrets.',
    examples: {
      bad: `uses: ./.github/workflows/deploy.yml
secrets:
  token: \${{ secrets.TOKEN }}
  # deploy.yml also requires "registry-password"`,
      good: `secrets:
  token: \${{ secrets.TOKEN }}
  registry-password: \${{ secrets.REGISTRY_PASSWORD }}`,
    },
  },
  check(ctx) {
    for (const call of ctx.index.callSites) {
      if (call.job.secretsInherit) continue;
      for (const s of Object.values(call.callee.call?.secrets ?? {})) {
        if (!s.required || lookup(call.job.secrets, s.name)) continue;
        ctx.report({
          message: `jobs.${call.job.id} calls ${call.callee.path} without required secret ${quote(s.name)}`,
          loc: call.job.uses?.loc ?? call.job.loc,
          symbol: sym.secret(call.callee.path, s.name),
          related: [
            ...chainRelated(chainTo(ctx.index, call.caller.path)),
            { loc: s.loc, message: 'declared required here' },
          ],
        });
      }
    }
  },
});

export const unknownSecret = defineRule({
  code: 'FP202',
  name: 'unknown-secret',
  category: 'secrets',
  defaultSeverity: 'error',
  docs: {
    summary: 'A caller passes a secret the reusable workflow does not declare.',
    why: 'GitHub rejects the call ("Invalid secret … is not defined in the referenced workflow").',
    fix: 'Declare the secret under `on.workflow_call.secrets` in the callee, fix the name, or remove it.',
  },
  check(ctx) {
    for (const call of ctx.index.callSites) {
      const declared = call.callee.call?.secrets ?? {};
      for (const b of Object.values(call.job.secrets)) {
        if (lookup(declared, b.name)) continue;
        const guess = didYouMean(b.name, Object.keys(declared));
        ctx.report({
          message: `${call.callee.path} has no secret ${quote(b.name)}${guess ? ` — did you mean ${quote(guess)}?` : ''}`,
          loc: b.loc,
          symbol: sym.secret(call.callee.path, b.name),
          related: call.callee.call
            ? [
                {
                  loc: call.callee.call.loc,
                  message: `declared secrets: ${listNames(Object.keys(declared))}`,
                },
              ]
            : [],
        });
      }
    }
  },
});

export const unusedSecret = defineRule({
  code: 'FP203',
  name: 'unused-secret',
  category: 'secrets',
  defaultSeverity: 'warning',
  generatedFiles: 'skip',
  docs: {
    summary: 'A `workflow_call` secret is declared but never read.',
    why: 'Every caller must still wire the secret, widening its exposure for nothing.',
    fix: 'Remove the declaration and the callers’ `secrets:` bindings, or use the secret where intended.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      if (!wf.call) continue;
      if (readsContextDynamically(wf, 'secrets')) continue;
      for (const s of Object.values(wf.call.secrets)) {
        if (ctx.index.usagesOf(sym.secret(wf.path, s.name)).length > 0) continue;
        // Forwarded implicitly to a callee through `secrets: inherit`.
        const inherited = Object.values(wf.jobs).some((j) => {
          const callee = j.secretsInherit ? ctx.index.calleeOf(j) : undefined;
          return callee
            ? [...secretsNeededBy(ctx.index, callee)].some((n) => n.toLowerCase() === s.name.toLowerCase())
            : false;
        });
        if (inherited) continue;
        ctx.report({
          message: `Secret ${quote(s.name)} of ${wf.path} is never read`,
          loc: s.loc,
          symbol: sym.secret(wf.path, s.name),
        });
      }
    }
  },
});

export const secretsInherit = defineRule({
  code: 'FP204',
  name: 'secrets-inherit',
  category: 'secrets',
  defaultSeverity: 'info',
  generatedFiles: 'skip',
  docs: {
    summary:
      '`secrets: inherit` hands every repository secret to the callee; flowpact lists what is actually needed.',
    why:
      'Inherit makes the secret flow invisible: nobody can tell from the caller which secrets reach which job, and every ' +
      'nested workflow gets all of them.',
    fix: 'Replace `secrets: inherit` with an explicit `secrets:` mapping of the secrets listed in the message.',
    examples: {
      bad: `uses: ./.github/workflows/deploy.yml
secrets: inherit`,
      good: `uses: ./.github/workflows/deploy.yml
secrets:
  DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}`,
    },
  },
  check(ctx) {
    for (const call of ctx.index.callSites) {
      if (!call.job.secretsInherit) continue;
      const needed = [...secretsNeededBy(ctx.index, call.callee)].sort();
      ctx.report({
        message: `jobs.${call.job.id} inherits all secrets; ${call.callee.path} and its callees read ${needed.length ? listNames(needed, 10) : 'none'}`,
        loc: call.job.secretsLoc ?? call.job.loc,
        symbol: `${call.caller.path}#jobs.${call.job.id}.secrets`,
        fix: needed.length
          ? `Replace with:\nsecrets:\n${needed.map((n) => `  ${escapeControl(n)}: \${{ secrets.${escapeControl(n)} }}`).join('\n')}`
          : 'Remove `secrets: inherit`; the callee reads no secrets.',
        // The snippet's own line breaks are kept; the names are escaped (`secrets['…']` can hold any string).
        fixMultiline: true,
      });
    }
  },
});

export const undeclaredSecretRef = defineRule({
  code: 'FP205',
  name: 'undeclared-secret-ref',
  category: 'secrets',
  defaultSeverity: 'error',
  docs: {
    summary:
      'A reusable workflow reads a secret it does not declare, and some caller does not use `secrets: inherit`.',
    why:
      'Inside a called workflow only declared (or inherited) secrets exist. Reading anything else yields an empty string, ' +
      'so authentication steps fail late or, worse, fall back to anonymous access.',
    fix:
      'Declare the secret under `on.workflow_call.secrets` and pass it from every caller, or use `secrets: inherit`. ' +
      "Callers whose `with:` values make the reading job's or step's `if:` false (e.g. an omitted input in " +
      "`if: contains(inputs.registries, 'docker.io')`) are not counted: the read never runs for them.",
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      if (!wf.call) continue;
      const strictCallers = ctx.index.callersOf(wf.path).filter((c) => !c.job.secretsInherit);
      if (strictCallers.length === 0) continue;
      const resolvers = new Map(strictCallers.map((c) => [c, callerInputsResolver(wf, c)]));
      for (const { site, ref } of refsOf(wf)) {
        const name = ref.path[0];
        if (ref.context !== 'secrets' || !name || name === '*' || name === '?') continue;
        if (BUILTIN_SECRETS.has(name.toLowerCase()) || lookup(wf.call.secrets, name)) continue;
        // A caller whose inputs make the job's or step's `if:` false never runs the read.
        const guards = guardsOf(wf, site);
        const reached = strictCallers.filter((c) => !guards.some((g) => isFalse(g, resolvers.get(c)!)));
        if (reached.length === 0) continue;
        ctx.report({
          message: `${wf.path} reads secrets.${name}, which is not declared — it is empty when called from ${reached.length} caller${reached.length > 1 ? 's' : ''} without \`secrets: inherit\``,
          loc: ref.loc,
          symbol: sym.secret(wf.path, name),
          related: reached.slice(0, 3).map((c) => ({
            loc: c.job.uses?.loc ?? c.job.loc,
            message: `${c.caller.path} › jobs.${c.job.id} passes explicit secrets`,
          })),
        });
      }
    }
  },
});

/**
 * The called workflow's `inputs` as one caller sets them: literal `with:` values, and for omitted inputs the default
 * (or `false`, `0`, `''` by type, as GitHub does). Values computed from expressions at runtime stay unknown.
 */
function callerInputsResolver(callee: WorkflowDecl, call: CallSite): ContextResolver {
  return ({ context, path }) => {
    if (context !== 'inputs') return undefined;
    if (path.length !== 1 || !path[0]) return UNKNOWN;
    const decl = lookup(callee.call?.inputs ?? {}, path[0]);
    if (!decl) return UNKNOWN;
    const b = lookup(call.job.with, decl.name);
    if (b) return b.site ? evaluateTemplate(b.site.text, () => undefined) : known(b.value);
    if (decl.hasDefault) {
      const d = decl.default ?? null;
      return typeof d === 'string' && d.includes('${{') ? UNKNOWN : known(d);
    }
    return known(decl.type === 'boolean' ? false : decl.type === 'number' ? 0 : '');
  };
}

/** The `if:` sites that decide whether a site in a job or step is evaluated. */
function guardsOf(wf: WorkflowDecl, site: ExprSite): ExprSite[] {
  const job = site.job !== undefined ? wf.jobs[site.job] : undefined;
  const step = job && site.step !== undefined ? job.steps[site.step] : undefined;
  return [job?.ifSite, step?.ifSite].filter((g): g is ExprSite => g !== undefined && g !== site);
}

/** True when a condition is false whatever the runtime-only parts evaluate to. */
function isFalse(guard: ExprSite, resolve: ContextResolver): boolean {
  const ast = isWholeExpression(guard) ? guard.segments[0]!.expr.ast : undefined;
  return ast !== undefined && definitelyFalsy(ast, resolve);
}

export const secretRules: RuleDefinition[] = [
  missingRequiredSecret,
  unknownSecret,
  unusedSecret,
  secretsInherit,
  undeclaredSecretRef,
];
