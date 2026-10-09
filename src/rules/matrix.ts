import {
  type ContextResolver,
  definitelyFalsy,
  evaluate,
  evaluateTemplate,
  fallbacksOf,
  findTemplateSegments,
  type Json,
  type TemplateSegment,
  UNKNOWN,
} from '../expressions';
import { type ProjectIndex, sym } from '../graph';
import type {
  Binding,
  ExprSite,
  InputDecl,
  JobDecl,
  LocatedRef,
  StepDecl,
  UnitDecl,
  WorkflowDecl,
} from '../ir';
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
import { chainRelated, chainTo, didYouMean, isWholeExpression, quote, useInCondition } from './util';

const hasMatrixRef = (site: ExprSite) =>
  site.segments.some((s) => s.refs.some((r) => r.context === 'matrix'));

const readsKey = (seg: { expr: TemplateSegment['expr'] }, key: string) =>
  seg.expr.refs.some((r) => r.context === 'matrix' && r.path[0]?.toLowerCase() === key.toLowerCase());

/**
 * Where a shell test starts: `[[`, `[` or `test` as a command — at the start of the line, after `;`, `&`, `|`, `(` or
 * `{`, or after `if`, `elif`, `while`, `until`, `then`, `do`, `else` or `!` — not as an argument (`cargo test -p`).
 */
const TEST_OPEN = /(?:^|[;&|({])\s*(?:(?:if|elif|while|until|then|do|else|!)\s+)*(\[\[|\[|test)(?=\s)/g;

/** A shell test is open at the end of `before` and, for `[[`/`[`, closed in `after` (both on the operand's line). */
function inShellTest(before: string, after: string): boolean {
  const open = [...before.matchAll(TEST_OPEN)].at(-1);
  if (!open) return false;
  const rest = before.slice(open.index + open[0].length);
  if (open[1] === 'test') return !/[;&|]/.test(rest);
  if (open[1] === '[[') return !rest.includes(']]') && /\s\]\](?:[\s;&|)]|$)/.test(after);
  return !/\s\](?:\s|$)/.test(rest) && /\s\](?:[\s;&|)]|$)/.test(after);
}

/**
 * The `${{ }}` segments of a `run:` script that are quoted operands of a shell test — `[[ -z "${{ matrix.k }}" ]]`,
 * `[ "${{ matrix.k }}" = on ]`, `[[ -d "${{ matrix.k }}" ]]`: an empty value gives a definite answer there, not a
 * degraded command. Indexes are those of `findTemplateSegments(script)`.
 */
function shellTestSegments(script: string, segments = findTemplateSegments(script)): Set<number> {
  const out = new Set<number>();
  for (const [i, seg] of segments.entries()) {
    const quote = script[seg.start - 1];
    if ((quote !== '"' && quote !== "'") || script[seg.end] !== quote) continue;
    const lineStart = script.lastIndexOf('\n', seg.start - 1) + 1;
    const nl = script.indexOf('\n', seg.end);
    const before = script.slice(lineStart, seg.start - 1);
    const after = script.slice(seg.end + 1, nl < 0 ? script.length : nl);
    const operand =
      /(?:^|[\s(!])-[a-zA-Z]\s+$/.test(before) ||
      /^\s+(?:==?|!=)\s/.test(after) ||
      /\s(?:==?|!=)\s+$/.test(before);
    if (operand && inShellTest(before, after)) out.add(i);
  }
  return out;
}

/**
 * For a `run:` script, what still degrades when `key` is empty: the script without the `${{ }}` segments that only
 * test it in the shell, and the indexes of those segments (in `site.segments`, which follow the script's order).
 * `undefined` when every read of `key` is such a test (the script handles the empty value).
 */
function unhandledReads(site: ExprSite, key: string): { text: string; tested: Set<number> } | undefined {
  const all = { text: site.text, tested: new Set<number>() };
  if (site.field !== 'step.run') return all;
  const segments = findTemplateSegments(site.text);
  const tested = new Set(
    [...shellTestSegments(site.text, segments)].filter((i) => readsKey(segments[i]!, key)),
  );
  if (tested.size === 0) return all;
  if (tested.size === segments.filter((s) => readsKey(s, key)).length) return undefined;
  let text = '';
  let at = 0;
  for (const i of [...tested].sort((a, b) => a - b)) {
    text += site.text.slice(at, segments[i]!.start);
    at = segments[i]!.end;
  }
  return { text: text + site.text.slice(at), tested };
}

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
  text = site.text,
): { combos: Combination[]; keys: string[]; perKey: Map<string, number> } {
  const known = new Set(exp.keys.map((k) => k.toLowerCase()));
  if (onlyKey !== undefined) for (const k of [...known]) if (k !== onlyKey.toLowerCase()) known.delete(k);
  const combos: Combination[] = [];
  const perKey = new Map<string, number>();
  for (const combo of exp.combos) {
    // Combinations where the job or step is skipped by its own `if:` never read the value.
    if (guards.some((g) => skippedIn(g, combo))) continue;
    const v = evaluateTemplate(text, matrixResolver(combo));
    const missing = v.taint.filter((t) => known.has(t.key.toLowerCase()));
    if (missing.length === 0 || !predicate(v)) continue;
    combos.push(combo);
    for (const key of new Set(missing.map((t) => t.key))) perKey.set(key, (perKey.get(key) ?? 0) + 1);
  }
  return { combos, keys: [...perKey.keys()], perKey };
}

/** The first read of one of `keys`, outside the segments in `skip` (indexes in `site.segments`). */
function firstMatrixRefLoc(site: ExprSite, keys: string[], skip: Set<number> = new Set()): Loc {
  const lower = keys.map((k) => k.toLowerCase());
  for (const [i, seg] of site.segments.entries()) {
    if (skip.has(i)) continue;
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

/**
 * How serious an empty value is for the input that receives it:
 * - `error` when the input is required, unknown (e.g. a remote callee), or its default is empty (none, `''` or `~`) and
 *   an `if:` in the callee reads it other than through a fallback: the legs with an empty value skip or change that
 *   work, like the incident flowpact was built for;
 * - `warning` when the empty value replaces a non-empty `default`;
 * - `undefined` (not reported) for other optional inputs: the callee handles the empty value like an omitted input.
 */
function emptyInputImpact(
  index: ProjectIndex,
  callee: UnitDecl | undefined,
  input: InputDecl | undefined,
): { severity: 'error' | 'warning'; related: RelatedLocation[]; note: string } | undefined {
  if (!callee || !input || input.required) return { severity: 'error', related: [], note: '' };
  const value: Json | undefined = input.default;
  if (value !== undefined && value !== null && value !== '') {
    const shown = typeof value === 'string' ? quote(value) : JSON.stringify(value);
    return { severity: 'warning', related: [], note: `, which replaces the input's default ${shown}` };
  }
  // A missing default is '' for a string, the same as `default: ''`. A fallback (`inputs.x || 'all'`) replaces it.
  const condition = index
    .usagesOf(sym.input(callee.path, input.name))
    .find((u) => u.site.isCondition && useInCondition(u.site, u.ref) !== 'fallback');
  if (!condition) return undefined;
  return {
    severity: 'error',
    related: [
      {
        loc: condition.ref.loc,
        message: `this condition reads ${quote(input.name)}, so the legs with an empty value take the other branch`,
      },
    ],
    note: '',
  };
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
    fix:
      "Define the key in every combination (add it to the `include` entry or a matrix dimension), or add an explicit fallback: `${{ matrix.key || 'default' }}`. " +
      "Reported as an error when the input is required (or the callee is not in the repository) or when its default is empty (none, or `default: ''`) and an `if:` in the callee reads it, and as a warning when the empty value replaces a non-empty `default`. " +
      "Not reported for other optional inputs (an empty default that no condition reads, or reads only through a fallback such as `inputs.x || 'all'`): the callee handles the empty value like an omitted input.",
    examples: {
      bad: `strategy:
  matrix:
    include:
      - name: linux
        config: ci-linux.json
      - name: windows        # no "config" → empty input
uses: ./.github/workflows/run-tests.yml   # declares config: { required: true }
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
        callee?: UnitDecl;
        input?: InputDecl;
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
            ...(callee ? { callee } : {}),
            ...(input ? { input, symbol: sym.input(callee!.path, input.name) } : {}),
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
            ...(action ? { callee: action } : {}),
            ...(input ? { input, symbol: sym.input(action!.path, input.name) } : {}),
          });
        }
      }
      for (const t of targets) {
        const site = t.binding.site;
        if (!site || !hasMatrixRef(site)) continue;
        const impact = emptyInputImpact(ctx.index, t.callee, t.input);
        if (!impact) continue;
        const { combos, keys, perKey } = affectedCombos(site, exp, isEmptyValue, guardsOf(job, site));
        if (combos.length === 0) continue;
        const keyList = keys.map((k) => `matrix.${k}`).join(', ');
        const cause =
          keys.length === 1
            ? `matrix.${keys[0]} is not defined there`
            : `not defined there: ${keys.map((k) => `matrix.${k} (${perKey.get(k)})`).join(', ')}`;
        ctx.report({
          message: `Input ${quote(t.binding.name)} for ${t.target} is empty in ${combos.length} of ${exp.combos.length} matrix combinations — ${cause}${impact.note}`,
          loc: firstMatrixRefLoc(site, keys),
          combos: combos.map((c) => comboLabel(c, exp.keys)),
          symbol: t.symbol ?? `${wf.path}#jobs.${job.id}.with.${t.binding.name}`,
          related: [
            ...chainRelated(chainTo(ctx.index, wf.path)),
            ...comboRelated(job, combos, keys),
            ...(t.input
              ? [{ loc: t.input.loc, message: `receives the empty value: input ${quote(t.binding.name)}` }]
              : []),
            ...impact.related,
          ],
          fix: `Set ${keys.map((k) => `\`${k}\``).join(', ')} in every combination, or use a fallback: \`\${{ ${keyList.split(', ')[0]} || '<default>' }}\`.`,
          severity: impact.severity,
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
    fix: 'Define the key for every combination, or add a fallback (`${{ matrix.key || \'default\' }}`). Not reported: conditions (`if:`) and `continue-on-error`, comparisons and negations (`matrix.key != \'\'`, `!matrix.key`), `matrix.key && ...` guards, quoted shell tests in `run:` scripts (`[[ -z "${{ matrix.key }}" ]]`, `[ "${{ matrix.key }}" = on ]`), and combinations where the job or step is skipped by its own `if:`.',
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
          // A script that only tests the value in the shell (`[[ -z "${{ matrix.k }}" ]]`) handles the empty case.
          const unhandled = unhandledReads(site, key);
          if (!unhandled) continue;
          const guards = guardsOf(job, site);
          const { combos } = affectedCombos(site, exp, predicate, guards, key, unhandled.text);
          if (combos.length === 0) continue;
          // The count says how often the key is missing; combinations where the whole input is empty are FP401's.
          const all = WITH_FIELDS.has(site.field)
            ? affectedCombos(site, exp, () => true, guards, key).combos.length
            : combos.length;
          const rest = all - combos.length;
          ctx.report({
            message: `matrix.${key} is undefined in ${all} of ${exp.combos.length} combinations of jobs.${job.id}${rest ? `; in ${rest} of them the whole input is empty (FP401)` : ''}`,
            loc: firstMatrixRefLoc(site, [key], unhandled.tested),
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
    why:
      'The value is always empty — almost certainly a typo or a key that was renamed in the matrix. A comparison or ' +
      'test on it always gives the same answer, and a condition on it never changes. Only a read with a fallback that ' +
      "is not empty (`matrix.key || 'default'`) is info, since the fallback always applies, unless the key is close " +
      'to one the matrix defines.',
    fix: 'Fix the key name, add it to the matrix, or drop the read if the fallback is what you want.',
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
        // The reads of each undefined key, in order (the first spelling names the key).
        const reads = new Map<string, LocatedRef[]>();
        for (const seg of site.segments) {
          for (const r of seg.refs) {
            const k = r.path[0];
            if (r.context !== 'matrix' || !k || k === '*' || k === '?' || keys.has(k.toLowerCase())) continue;
            reads.set(k.toLowerCase(), [...(reads.get(k.toLowerCase()) ?? []), r]);
          }
        }
        for (const refs of reads.values()) {
          const k = refs[0]!.path[0]!;
          const where = job.matrix
            ? `matrix.${k} is not defined in any combination of jobs.${job.id} (keys: ${exp!.keys.join(', ') || 'none'})`
            : `jobs.${job.id} has no matrix, so matrix.${k} is always empty`;
          const related = job.matrix ? [{ loc: job.matrix.loc, message: 'matrix defined here' }] : [];
          if (onlyFallbacks(site, k, job, exp)) {
            ctx.report({
              message: `${where}; the fallback always applies`,
              loc: refs[0]!.loc,
              symbol: sym.matrix(wf.path, job.id, k),
              related,
              severity: 'info',
            });
            continue;
          }
          for (const r of refs)
            ctx.report({ message: where, loc: r.loc, symbol: sym.matrix(wf.path, job.id, k), related });
        }
      }
    }
  },
});

/** The combinations to evaluate a job's expressions in; a job without a matrix has one, without any key. */
function combosOf(exp: MatrixExpansion | undefined): Combination[] {
  if (exp && exp.combos.length > 0 && exp.combos.length <= GITHUB_MATRIX_LIMIT) return exp.combos;
  // Too many (or too many to list): each known key with a value that is not known.
  const values = Object.fromEntries((exp?.keys ?? []).map((k) => [k, { known: false as const }]));
  return [{ values, origin: 'product', includes: [] }];
}

const unknownKey =
  (resolve: ContextResolver, key: string): ContextResolver =>
  (ref) =>
    ref.context === 'matrix' && ref.path[0]?.toLowerCase() === key ? UNKNOWN : resolve(ref);

/**
 * True when every read of `key`, which no combination defines, is a fallback that always applies: a non-last operand
 * of `||` whose result is not empty (`matrix.k || 'x'`, `matrix.k || env.X`) in every combination where the site is
 * evaluated. Any other read — plain, compared, negated, a `&&` guard, a shell test, `matrix.k || ''` — uses the
 * always-empty value and gives the same answer in every run, the mark of a typo; so does a condition that is never
 * true, and a key close to one the matrix defines (`matrix.oss || 'linux'` next to `os`).
 */
function onlyFallbacks(site: ExprSite, key: string, job: JobDecl, exp: MatrixExpansion | undefined): boolean {
  if (exp && didYouMean(key, exp.keys)) return false;
  const lower = key.toLowerCase();
  const guards = guardsOf(job, site);
  const combos = combosOf(exp).filter((c) => !guards.some((g) => skippedIn(g, c)));
  if (site.isCondition && isWholeExpression(site)) {
    const ast = site.segments[0]!.expr.ast;
    if (!ast) return false;
    const neverTrue = combos.every((c) => {
      const resolve = matrixResolver(c);
      return definitelyFalsy(ast, resolve) && !definitelyFalsy(ast, unknownKey(resolve, lower));
    });
    if (neverTrue) return false;
  }
  for (const seg of site.segments) {
    const reads = seg.refs.filter((r) => r.context === 'matrix' && r.path[0]?.toLowerCase() === lower);
    if (reads.length === 0) continue;
    const fallbacks = fallbacksOf(seg.expr);
    for (const r of reads) {
      const fallback = fallbacks.get(r.start);
      if (!fallback) return false;
      if (combos.some((c) => isEmptyValue(evaluate(fallback, matrixResolver(c))))) return false;
    }
  }
  return true;
}

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
