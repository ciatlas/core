/**
 * Check-run names of jobs, as GitHub reports them (and as branch protection requires them).
 *
 * The rules come from GitHub's actual check runs in a lab repository (fixtures/checknames-lab):
 * - The name is the job's `name`, trimmed at both ends; the job id when there is none or it is blank.
 * - A matrix job gets ` (v1, v2, …)` unless its `name` is dynamic: a template with text around an expression, or an
 *   expression that is not a single literal (`Build ${{ matrix.os }}`, `${{ matrix.os }}`, `Lit ${{ 'X' }}` get no
 *   suffix; `${{ 'Only' }}` does).
 * - The suffix lists the combination's values: the matrix dimensions in declared order for product combinations
 *   (keys an `include` adds to them are left out), every key of the entry for combinations an `include` created.
 *   `null` and `''` are skipped, objects and arrays are flattened, numbers are formatted like .NET's "G15".
 * - A job in a called workflow reports `<caller> / <callee>`, one ` / ` per level; callee names read the caller's
 *   `with:` values (or the input defaults).
 */
import { Literal } from '@actions/expressions/ast';
import {
  type ContextResolver,
  type EvalValue,
  evaluate,
  evaluateTemplate,
  findTemplateSegments,
  type Json,
  known,
  type TemplateSegment,
  UNKNOWN,
} from './expressions';
import type { ProjectIndex } from './graph';
import { type JobDecl, lookup, type WorkflowDecl } from './ir';
import { type Combination, expandMatrix, type MatrixExpansion, matrixResolver } from './matrix';

export interface CheckName {
  /** The check-run name (context), e.g. `call-mx (p) / build`. */
  name: string;
  /**
   * The part of the name that does not depend on values: the static name with ` (…)` for a matrix suffix, or the
   * template with `…` for each expression (`Build …`). A changed stem means every name the job reports changed.
   */
  stem: string;
  /** False when part of the name depends on something flowpact cannot evaluate (event data, `needs`, `vars`, …). */
  certain: boolean;
  /** The jobs that produce it, outermost first, as `<workflow path>#<job id>`. */
  jobs: string[];
}

/** Formats a number like .NET's `ToString("G15")`, which GitHub uses for matrix values. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(n)));
  const [mantissa, e] = n.toPrecision(15).split('e') as [string, string | undefined];
  const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp > -5 && exp < 15 && e === undefined) return trim(mantissa);
  const sci = n.toExponential(14);
  const [m, x] = sci.split('e') as [string, string];
  const power = Number(x);
  return `${trim(m)}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
}

/** A matrix value as it appears in the suffix: flattened, with `null` and `''` left out. */
export function suffixValues(value: Json): string[] {
  if (value === null || value === '') return [];
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  if (typeof value === 'number') return [formatNumber(value)];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(suffixValues);
  return Object.values(value).flatMap(suffixValues);
}

const toText = (v: EvalValue): string | undefined => {
  if (!v.known) return undefined;
  const value = v.value;
  if (value === null) return '';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  return undefined;
};

/** How a job's `name` decides the check name. */
type NameKind =
  | { kind: 'static'; text: string }
  | { kind: 'dynamic'; template: string; segments: TemplateSegment[] };

function nameKind(job: JobDecl): NameKind {
  const raw = job.name ?? '';
  const segments = findTemplateSegments(raw);
  if (segments.length === 0) return { kind: 'static', text: raw.trim() };
  const only = segments.length === 1 && raw.trim() === raw.slice(segments[0]!.start, segments[0]!.end).trim();
  const ast = segments[0]!.expr.ast;
  // A name that is a single literal expression counts as plain text: it keeps the matrix suffix.
  if (only && ast instanceof Literal) {
    return { kind: 'static', text: (toText(evaluate(ast, () => undefined)) ?? '').trim() };
  }
  return { kind: 'dynamic', template: raw, segments };
}

function suffix(combo: Combination, exp: MatrixExpansion, job: JobDecl): { text: string; certain: boolean } {
  const m = job.matrix!;
  const keys =
    combo.origin === 'include'
      ? Object.keys(m.include[combo.includes[0]!]?.values ?? {})
      : m.dims.map((d) => d.name);
  let certain = exp.exact;
  const parts: string[] = [];
  for (const key of keys) {
    const cell = lookup(combo.values, key);
    if (!cell) continue;
    if (!cell.known) {
      certain = false;
      continue;
    }
    parts.push(...suffixValues(cell.value));
  }
  return { text: parts.length ? ` (${parts.join(', ')})` : '', certain };
}

/** The template with `…` for each expression (`Build …`), from the parsed segments rather than a backtracking regex. */
function templateStem(template: string, segments: TemplateSegment[]): string {
  let out = '';
  let at = 0;
  for (const seg of segments) {
    out += `${template.slice(at, seg.start)}…`;
    at = seg.end;
  }
  return (out + template.slice(at)).trim();
}

/** A workflow's inputs: absent = not passed (the default applies), `known: false` = passed but not known statically. */
export type InputValues = Record<string, { known: true; value: Json } | { known: false }>;

/** The resolver for a job's `name`: matrix values of the combination and the (caller-supplied) inputs. */
function nameResolver(combo: Combination | undefined, inputs: InputValues): ContextResolver {
  const matrix = combo ? matrixResolver(combo) : undefined;
  return (ref) => {
    if (ref.context === 'matrix') return matrix ? matrix(ref) : known(null);
    if (ref.context === 'inputs') {
      if (ref.path.length !== 1) return UNKNOWN;
      const v = lookup(inputs, ref.path[0]!);
      return v?.known ? known(v.value) : UNKNOWN;
    }
    return undefined;
  };
}

/**
 * The check names one job produces when it runs (one per matrix combination), without the caller prefix. A job that
 * calls a reusable workflow returns the caller segments only; see `workflowChecks` for the composed names.
 */
export function jobSegments(
  job: JobDecl,
  inputs: InputValues = {},
): { name: string; stem: string; certain: boolean; combo?: Combination }[] {
  const kind = nameKind(job);
  const exp = job.matrix ? expandMatrix(job.matrix) : undefined;
  const combos: (Combination | undefined)[] =
    exp && !exp.dynamic && !exp.truncated && exp.combos.length ? exp.combos : [undefined];
  const matrixUnknown = !!exp && (exp.dynamic || exp.truncated);
  const stem =
    kind.kind === 'static'
      ? `${kind.text || job.id}${exp ? ' (…)' : ''}`
      : templateStem(kind.template, kind.segments);
  return combos.map((combo) => {
    if (kind.kind === 'static') {
      const base = kind.text || job.id;
      if (!combo || !exp)
        return { name: matrixUnknown ? `${base} (…)` : base, stem, certain: !matrixUnknown };
      const s = suffix(combo, exp, job);
      return { name: `${base}${s.text}`, stem, certain: s.certain, combo };
    }
    const text = toText(evaluateTemplate(kind.template, nameResolver(combo, inputs)))?.trim();
    const certain = text !== undefined && !matrixUnknown && (!exp || exp.exact);
    return {
      name: text === undefined ? kind.template.trim() : text || job.id,
      stem,
      certain,
      ...(combo ? { combo } : {}),
    };
  });
}

/** The single check GitHub reports for a job that is skipped (its `if:` is false, or a job it needs failed). */
export function skippedCheckName(job: JobDecl): string {
  const kind = nameKind(job);
  return kind.kind === 'static' ? kind.text || job.id : kind.template.trim();
}

/** Values a caller passes to a called workflow, for one caller combination (resolved against the caller's inputs). */
function callerInputs(job: JobDecl, combo: Combination | undefined, own: InputValues): InputValues {
  const out: InputValues = {};
  for (const [name, b] of Object.entries(job.with)) {
    if (!b.site) {
      out[name] = { known: true, value: b.value as Json };
      continue;
    }
    const v = evaluateTemplate(b.site.text, nameResolver(combo, own));
    out[name] = v.known ? { known: true, value: v.value } : { known: false };
  }
  return out;
}

const MAX_DEPTH = 12;

/**
 * Every check name a workflow's jobs produce when they run, with the names of called workflows composed in
 * (`caller / callee`). `inputs` are the workflow's own inputs when it is called; missing ones use their defaults.
 */
export function workflowChecks(
  index: ProjectIndex,
  wf: WorkflowDecl,
  /** The workflow's inputs, or `'consumer'` when consumers call it with values of their own (all unknown). */
  inputs: InputValues | 'consumer' = {},
  depth = 0,
  seen: Set<string> = new Set(),
): CheckName[] {
  const values: InputValues = {};
  for (const [name, input] of Object.entries(wf.call?.inputs ?? {})) {
    const given = inputs === 'consumer' ? { known: false as const } : lookup(inputs, name);
    if (given) values[name] = given;
    else if (input.hasDefault) values[name] = { known: true, value: input.default as Json };
    else values[name] = { known: true, value: null };
  }
  const out: CheckName[] = [];
  for (const job of Object.values(wf.jobs)) {
    const id = `${wf.path}#${job.id}`;
    const callee = job.uses ? index.calleeOf(job) : undefined;
    for (const seg of jobSegments(job, values)) {
      if (!callee) {
        out.push({ name: seg.name, stem: seg.stem, certain: seg.certain, jobs: [id] });
        continue;
      }
      if (depth >= MAX_DEPTH || seen.has(callee.path)) continue;
      const nested = workflowChecks(
        index,
        callee,
        callerInputs(job, seg.combo, values),
        depth + 1,
        new Set([...seen, wf.path]),
      );
      for (const c of nested) {
        out.push({
          name: `${seg.name} / ${c.name}`,
          stem: `${seg.stem} / ${c.stem}`,
          certain: seg.certain && c.certain,
          jobs: [id, ...c.jobs],
        });
      }
    }
  }
  return out;
}
