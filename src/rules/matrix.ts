import { definitelyFalsy, evaluateTemplate } from '../expressions';
import { sym } from '../graph';
import type { Binding, ExprSite, JobDecl, StepDecl, WorkflowDecl } from '../ir';
import { lookup } from '../ir';
import {
  type Combination,
  comboLabel,
  GITHUB_MATRIX_LIMIT,
  isEmptyValue,
  type MatrixExpansion,
  matrixResolver,
} from '../matrix';
import type { Loc } from '../source';
import { defineRule, type RelatedLocation, type RuleContext, type RuleDefinition } from './types';
import { chainRelated, chainTo, quote } from './util';

const hasMatrixRef = (site: ExprSite) =>
  site.segments.some((s) => s.refs.some((r) => r.context === 'matrix'));

/** True when an `if:` site is false for this combination whatever runtime state says (the step is skipped there). */
function skippedIn(guard: ExprSite, combo: Combination): boolean {
  const seg = guard.segments[0];
  if (guard.segments.length !== 1 || !seg?.expr.ast) return false;
  return definitelyFalsy(seg.expr.ast, matrixResolver(combo));
}

/** The step's `if:` decides whether a step-level site is evaluated (`matrix` is not available in a job's `if:`). */
function guardsOf(job: JobDecl, site: ExprSite): ExprSite[] {
  const step = site.step !== undefined ? job.steps[site.step] : undefined;
  return [step?.ifSite].filter((g): g is ExprSite => g !== undefined && g !== site);
}

/** Combinations in which `site` evaluates with a missing matrix key, grouped with the keys that were missing. */
function affectedCombos(
  site: ExprSite,
  exp: MatrixExpansion,
  predicate: (v: ReturnType<typeof evaluateTemplate>) => boolean,
  guards: ExprSite[] = [],
  onlyKey?: string,
): { combos: Combination[]; keys: string[]; perKey: Map<string, number> } {
  const known = new Set(exp.keys.map((k) => k.toLowerCase()));
  if (onlyKey !== undefined) for (const k of [...known]) if (k !== onlyKey.toLowerCase()) known.delete(k);
  const combos: Combination[] = [];
  const perKey = new Map<string, number>();
  for (const combo of exp.combos) {
    // Combinations where the job or step is skipped by its own `if:` never read the value.
    if (guards.some((g) => skippedIn(g, combo))) continue;
    const v = evaluateTemplate(site.text, matrixResolver(combo));
    const missing = v.taint.filter((t) => known.has(t.key.toLowerCase()));
    if (missing.length === 0 || !predicate(v)) continue;
    combos.push(combo);
    for (const key of new Set(missing.map((t) => t.key))) perKey.set(key, (perKey.get(key) ?? 0) + 1);
  }
  return { combos, keys: [...perKey.keys()], perKey };
}

function firstMatrixRefLoc(site: ExprSite, keys: string[]): Loc {
  const lower = keys.map((k) => k.toLowerCase());
  for (const seg of site.segments) {
    for (const r of seg.refs)
      if (r.context === 'matrix' && lower.includes((r.path[0] ?? '').toLowerCase())) return r.loc;
  }
  return site.loc;
}

function comboRelated(job: JobDecl, combos: Combination[], keys: string[]): RelatedLocation[] {
  const out: RelatedLocation[] = [];
  const m = job.matrix!;
  for (const c of combos) {
    for (const idx of c.includes) {
      const entry = m.include[idx];
      if (!entry) continue;
      const lacks = keys.filter((k) => !lookup(entry.values, k));
      if (lacks.length === 0) continue;
      out.push({
        loc: entry.loc,
        message: `this include entry has no ${lacks.map((k) => `\`${k}\``).join(', ')}`,
      });
    }
  }
  if (out.length === 0)
    out.push({
      loc: m.loc,
      message: `matrix defined here; ${keys.map((k) => `\`${k}\``).join(', ')} is not set for every combination`,
    });
  return dedupe(out);
}

function dedupe(items: RelatedLocation[]): RelatedLocation[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.loc.file}:${i.loc.line}:${i.loc.column}:${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function* matrixJobs(ctx: RuleContext): Generator<{ wf: WorkflowDecl; job: JobDecl; exp: MatrixExpansion }> {
  for (const wf of ctx.index.project.workflows.values()) {
    for (const job of Object.values(wf.jobs)) {
      if (!job.matrix) continue;
      yield { wf, job, exp: ctx.matrix(wf, job) };
    }
  }
}

export const emptyBindingForMatrixCombo = defineRule({
  code: 'FP401',
  name: 'empty-binding-for-matrix-combo',
  category: 'matrix',
  defaultSeverity: 'error',
  docs: {
    summary:
      'An input passed under `with:` is empty for some matrix combinations because a matrix key is missing there.',
    why:
      'GitHub evaluates a missing matrix key to an empty string — no error, no warning. The affected matrix leg runs with ' +
      'an empty input, so the callee may skip its real work (e.g. a test configuration) while the run stays green.',
    fix: "Define the key in every combination (add it to the `include` entry or a matrix dimension), or add an explicit fallback: `${{ matrix.key || 'default' }}`.",
    examples: {
      bad: `strategy:
  matrix:
    include:
      - name: linux
        config: ci-linux.json
      - name: windows        # no "config" → empty input
uses: ./.github/workflows/run-tests.yml
with:
  config: \${{ matrix.config }}`,
      good: `    include:
      - name: linux
        config: ci-linux.json
      - name: windows
        config: ci-windows.json`,
    },
  },
  check(ctx) {
    for (const { wf, job, exp } of matrixJobs(ctx)) {
      // Over GitHub's limit the matrix is rejected as a whole (FP406); checking each combination would only be slow.
      if (exp.dynamic || exp.combos.length === 0 || exp.combos.length > GITHUB_MATRIX_LIMIT) continue;
      const targets: {
        binding: Binding;
        target: string;
        inputLoc?: Loc;
        symbol?: string;
        step?: StepDecl;
      }[] = [];
      if (job.uses) {
        const callee = ctx.index.calleeOf(job);
        for (const b of Object.values(job.with)) {
          const input = callee?.call ? lookup(callee.call.inputs, b.name) : undefined;
          targets.push({
            binding: b,
            target: callee?.path ?? job.uses.raw,
            ...(input ? { inputLoc: input.loc, symbol: sym.input(callee!.path, input.name) } : {}),
          });
        }
      }
      for (const step of job.steps) {
        const action = ctx.index.actionOf(step);
        for (const b of Object.values(step.with)) {
          const input = action ? lookup(action.inputs, b.name) : undefined;
          targets.push({
            binding: b,
            target: action?.path ?? step.uses?.raw ?? `step #${step.index + 1}`,
            step,
            ...(input ? { inputLoc: input.loc, symbol: sym.input(action!.path, input.name) } : {}),
          });
        }
      }
      for (const t of targets) {
        const site = t.binding.site;
        if (!site || !hasMatrixRef(site)) continue;
        const { combos, keys, perKey } = affectedCombos(site, exp, isEmptyValue, guardsOf(job, site));
        if (combos.length === 0) continue;
        const keyList = keys.map((k) => `matrix.${k}`).join(', ');
        const cause =
          keys.length === 1
            ? `matrix.${keys[0]} is not defined there`
            : `not defined there: ${keys.map((k) => `matrix.${k} (${perKey.get(k)})`).join(', ')}`;
        ctx.report({
          message: `Input ${quote(t.binding.name)} for ${t.target} is empty in ${combos.length} of ${exp.combos.length} matrix combinations — ${cause}`,
          loc: firstMatrixRefLoc(site, keys),
          combos: combos.map((c) => comboLabel(c, exp.keys)),
          symbol: t.symbol ?? `${wf.path}#jobs.${job.id}.with.${t.binding.name}`,
          related: [
            ...chainRelated(chainTo(ctx.index, wf.path)),
            ...comboRelated(job, combos, keys),
            ...(t.inputLoc
              ? [{ loc: t.inputLoc, message: `receives the empty value: input ${quote(t.binding.name)}` }]
              : []),
          ],
          fix: `Set ${keys.map((k) => `\`${k}\``).join(', ')} in every combination, or use a fallback: \`\${{ ${keyList.split(', ')[0]} || '<default>' }}\`.`,
        });
      }
    }
  },
});

const SKIP_FIELDS = new Set(['job.strategy']);
const WITH_FIELDS = new Set(['job.with', 'step.with']);

export const matrixKeyMissingInCombo = defineRule({
  code: 'FP402',
  name: 'matrix-key-missing-in-combo',
  category: 'matrix',
  defaultSeverity: 'warning',
  docs: {
    summary: 'An expression reads a matrix key that is only defined in some combinations.',
    why:
      'In combinations without the key the value is an empty string. Scripts, env vars and runner labels built from it ' +
      'silently degrade (e.g. `--config=` with no value).',
    fix: "Define the key for every combination, or add a fallback (`${{ matrix.key || 'default' }}`). Not reported: conditions (`if:`) and `continue-on-error`, comparisons and negations (`matrix.key != ''`, `!matrix.key`), `matrix.key && ...` guards, and combinations where the job or step is skipped by its own `if:`.",
  },
  check(ctx) {
    for (const { wf, job, exp } of matrixJobs(ctx)) {
      if (exp.dynamic || exp.combos.length === 0 || exp.combos.length > GITHUB_MATRIX_LIMIT) continue;
      for (const site of wf.sites) {
        if (site.job !== job.id || site.isCondition || SKIP_FIELDS.has(site.field) || !hasMatrixRef(site))
          continue;
        if (site.yamlPath.at(-1) === 'continue-on-error') continue;
        // Empty `with:` values are FP401's; here only values that still degrade (e.g. `--config=`).
        const predicate = WITH_FIELDS.has(site.field)
          ? (v: ReturnType<typeof evaluateTemplate>) => !isEmptyValue(v)
          : () => true;
        // One finding per key, so counts are right and each key can be overridden on its own.
        const read = new Map<string, string>();
        for (const seg of site.segments)
          for (const r of seg.refs)
            if (r.context === 'matrix' && r.path[0] && !read.has(r.path[0].toLowerCase()))
              read.set(r.path[0].toLowerCase(), r.path[0]);
        for (const key of read.values()) {
          const guards = guardsOf(job, site);
          const { combos } = affectedCombos(site, exp, predicate, guards, key);
          if (combos.length === 0) continue;
          // The count says how often the key is missing; combinations where the whole input is empty are FP401's.
          const all = WITH_FIELDS.has(site.field)
            ? affectedCombos(site, exp, () => true, guards, key).combos.length
            : combos.length;
          const rest = all - combos.length;
          ctx.report({
            message: `matrix.${key} is undefined in ${all} of ${exp.combos.length} combinations of jobs.${job.id}${rest ? `; in ${rest} of them the whole input is empty (FP401)` : ''}`,
            loc: firstMatrixRefLoc(site, [key]),
            combos: combos.map((c) => comboLabel(c, exp.keys)),
            symbol: sym.matrix(wf.path, job.id, key),
            related: comboRelated(job, combos, [key]),
          });
        }
      }
    }
  },
});

export const dynamicMatrixUnverified = defineRule({
  code: 'FP403',
  name: 'dynamic-matrix-unverified',
  category: 'matrix',
  defaultSeverity: 'info',
  docs: {
    summary:
      'The matrix is computed at runtime, so flowpact cannot check that every combination defines the keys it reads.',
    why: 'Dynamic matrices (`fromJSON(...)`) hide the same empty-value failure mode as static ones, but no tool can see it.',
    fix: 'Declare the keys in the config (`matrixShapes: { "<workflow>#<job>": { keys: [os, config] } }`) so flowpact can verify reads, prefer a static matrix, or validate the generated JSON in the job that produces it.',
  },
  check(ctx) {
    for (const { wf, job, exp } of matrixJobs(ctx)) {
      const m = job.matrix!;
      if (exp.declared || (!exp.dynamic && !m.includeDynamic)) continue;
      const keys = new Set<string>();
      for (const site of wf.sites) {
        if (site.job !== job.id) continue;
        for (const seg of site.segments)
          for (const r of seg.refs) if (r.context === 'matrix' && r.path[0]) keys.add(r.path[0]);
      }
      if (keys.size === 0) continue;
      ctx.report({
        message: `jobs.${job.id} has a runtime-computed matrix; reads of ${[...keys].map((k) => `matrix.${k}`).join(', ')} cannot be verified`,
        loc: m.loc,
        symbol: sym.job(wf.path, job.id),
      });
    }
  },
});

export const undefinedMatrixKey = defineRule({
  code: 'FP404',
  name: 'undefined-matrix-key',
  category: 'matrix',
  defaultSeverity: 'error',
  docs: {
    summary: 'An expression reads a matrix key that no combination defines (or the job has no matrix).',
    why: 'The value is always empty — almost certainly a typo or a key that was renamed in the matrix.',
    fix: 'Fix the key name, or add it to the matrix.',
  },
  check(ctx) {
    for (const wf of ctx.index.project.workflows.values()) {
      for (const site of wf.sites) {
        if (!site.job || site.field === 'job.strategy') continue;
        const job = wf.jobs[site.job];
        if (!job) continue;
        const exp = job.matrix ? ctx.matrix(wf, job) : undefined;
        if (exp && !exp.declared && (exp.dynamic || job.matrix?.includeDynamic)) continue;
        const keys = new Set((exp?.keys ?? []).map((k) => k.toLowerCase()));
        for (const seg of site.segments) {
          for (const r of seg.refs) {
            const k = r.path[0];
            if (r.context !== 'matrix' || !k || k === '*' || k === '?' || keys.has(k.toLowerCase())) continue;
            ctx.report({
              message: job.matrix
                ? `matrix.${k} is not defined in any combination of jobs.${job.id} (keys: ${exp!.keys.join(', ') || 'none'})`
                : `jobs.${job.id} has no matrix, so matrix.${k} is always empty`,
              loc: r.loc,
              symbol: sym.matrix(wf.path, job.id, k),
              ...(job.matrix ? { related: [{ loc: job.matrix.loc, message: 'matrix defined here' }] } : {}),
            });
          }
        }
      }
    }
  },
});

export const unusedMatrixShape = defineRule({
  code: 'FP405',
  name: 'unused-matrix-shape',
  category: 'matrix',
  defaultSeverity: 'warning',
  docs: {
    summary: 'A `matrixShapes` entry in the config does not match a job with a runtime-computed matrix.',
    why: 'A mistyped workflow path or job id means the shape is silently ignored and the matrix stays unverified.',
    fix: 'Use `<workflow path>#<job id>` exactly as in the repository (e.g. `.github/workflows/test.yml#test`), or remove the entry.',
  },
  check(ctx) {
    for (const key of Object.keys(ctx.config.matrixShapes)) {
      const [path = '', jobId = ''] = key.split('#');
      const wf = ctx.index.project.workflows.get(path);
      const job = wf?.jobs[jobId];
      const reason = !wf
        ? `no workflow ${quote(path)}`
        : !job
          ? `${path} has no job ${quote(jobId)}`
          : !job.matrix || (!job.matrix.dynamic && !job.matrix.includeDynamic)
            ? `jobs.${jobId} has no runtime-computed matrix`
            : undefined;
      if (!reason) continue;
      ctx.report({
        message: `matrixShapes entry ${quote(key)} is not used: ${reason}`,
        loc: {
          file: ctx.configFile ?? '.github/flowpact/flowpact.config.yml',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
        },
        symbol: key,
      });
    }
  },
});

export const matrixTooLarge = defineRule({
  code: 'FP406',
  name: 'matrix-too-large',
  category: 'matrix',
  defaultSeverity: 'error',
  docs: {
    summary: `A job's matrix produces more than ${GITHUB_MATRIX_LIMIT} jobs, which GitHub rejects.`,
    why: `GitHub generates at most ${GITHUB_MATRIX_LIMIT} jobs per matrix (after \`exclude\` and \`include\`) and fails the workflow run otherwise.`,
    fix: 'Split the job, drop dimensions or values, or `exclude` combinations you do not need.',
  },
  check(ctx) {
    for (const { wf, job, exp } of matrixJobs(ctx)) {
      // A product too large to list is reported only when exclude cannot bring it under the limit.
      const n = exp.truncated ? (exp.minJobs ?? 0) : exp.exact ? exp.combos.length : 0;
      if (n <= GITHUB_MATRIX_LIMIT) continue;
      ctx.report({
        message: exp.truncated
          ? `jobs.${job.id} expands to at least ${n} matrix jobs (GitHub allows ${GITHUB_MATRIX_LIMIT}); flowpact did not list them`
          : `jobs.${job.id} expands to ${n} matrix jobs (GitHub allows ${GITHUB_MATRIX_LIMIT})`,
        loc: job.matrix!.loc,
        symbol: sym.job(wf.path, job.id),
      });
    }
  },
});

export const matrixRules: RuleDefinition[] = [
  matrixTooLarge,
  emptyBindingForMatrixCombo,
  matrixKeyMissingInCombo,
  dynamicMatrixUnverified,
  undefinedMatrixKey,
  unusedMatrixShape,
];
