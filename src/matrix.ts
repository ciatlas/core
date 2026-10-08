import { type ContextResolver, type EvalValue, type Json, known, UNKNOWN } from './expressions';
import { lookup, type MatrixDecl, type MatrixEntry } from './ir';

export type Cell = { known: true; value: Json } | { known: false };

export interface Combination {
  values: Record<string, Cell>;
  /** `product` combinations come from the cartesian product; `include` ones were created by an include entry. */
  origin: 'product' | 'include';
  /** Indexes of include entries merged into (or that created) this combination. */
  includes: number[];
}

export interface MatrixExpansion {
  combos: Combination[];
  /** Every key that appears in at least one combination. */
  keys: string[];
  /** False when part of the matrix is an expression, so the combination list may be incomplete or approximate. */
  exact: boolean;
  /** True when the matrix is entirely an expression (e.g. `${{ fromJSON(needs.setup.outputs.matrix) }}`). */
  dynamic: boolean;
  /** True when the product was too large to enumerate; `combos` is then empty. */
  truncated: boolean;
  /** Size of the cartesian product of the dimensions, before exclude/include. */
  productSize?: number;
  /**
   * When truncated: the fewest jobs the matrix can produce (after `exclude`; `include` only adds), when it can be
   * computed without listing the combinations.
   */
  minJobs?: number;
  /** True when the keys come from a `matrixShapes` declaration rather than the workflow. */
  declared?: boolean;
}

/** GitHub runs at most 256 jobs per matrix (after exclude/include). */
export const GITHUB_MATRIX_LIMIT = 256;
/** Products larger than this are not enumerated (exclude/include could not be applied correctly to a partial product). */
export const MAX_COMBINATIONS = 20_000;

export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]!));
  const ka = Object.keys(a);
  const kb = Object.keys(b as Record<string, Json>);
  return (
    ka.length === kb.length &&
    ka.every((k) => jsonEqual((a as Record<string, Json>)[k]!, (b as Record<string, Json>)[k] ?? null))
  );
}

/** Three-valued cell comparison: `undefined` when an unknown value is involved. */
function cellMatches(cell: Cell | undefined, value: Json): boolean | undefined {
  if (!cell) return false;
  if (!cell.known) return undefined;
  return jsonEqual(cell.value, value);
}

/**
 * How many product combinations survive `exclude`, without listing the product: only the dimensions some exclude
 * entry names are enumerated, the others multiply. Falls back to a lower bound (each entry removes at most its share of
 * the product) when even that is too large. Undefined when part of the matrix is an expression.
 */
function minJobsAfterExclude(m: MatrixDecl, productSize: number): number | undefined {
  if (m.excludeDynamic || m.includeDynamic) return undefined;
  if (m.dims.some((d) => d.values === null || d.unknownIndexes.length > 0)) return undefined;
  if (m.exclude.some((e) => e.dynamicKeys.length > 0)) return undefined;
  const size = new Map(m.dims.map((d) => [d.name, Math.max(1, d.values!.length)]));
  const named = m.dims.filter((d) => m.exclude.some((e) => d.name in e.values));
  const subSize = named.reduce((n, d) => n * size.get(d.name)!, 1);
  // An entry naming a key that is not a dimension never matches a product combination.
  const effective = m.exclude.filter((e) => Object.keys(e.values).every((k) => size.has(k)));
  if (subSize <= MAX_COMBINATIONS) {
    let survivors = 0;
    const walk = (i: number, values: Record<string, Json>) => {
      if (i === named.length) {
        if (!effective.some((e) => Object.entries(e.values).every(([k, v]) => jsonEqual(values[k]!, v))))
          survivors++;
        return;
      }
      const d = named[i]!;
      for (const v of d.values!) walk(i + 1, { ...values, [d.name]: v });
    };
    walk(0, {});
    return survivors * (productSize / subSize);
  }
  const removed = effective.reduce(
    (n, e) => n + productSize / Object.keys(e.values).reduce((p, k) => p * size.get(k)!, 1),
    0,
  );
  return Math.max(0, productSize - removed);
}

/**
 * Expands a matrix exactly the way GitHub does:
 * 1. cartesian product of the dimensions,
 * 2. `exclude` removes product combinations whose listed keys all match,
 * 3. each `include` entry is merged into every *original* combination it does not conflict with
 *    (original values are never overwritten; values added by earlier includes may be); if it fits none,
 *    it becomes a new combination.
 */
export function expandMatrix(m: MatrixDecl | undefined): MatrixExpansion {
  if (!m) return { combos: [], keys: [], exact: true, dynamic: false, truncated: false };
  if (m.dynamic) return { combos: [], keys: [], exact: false, dynamic: true, truncated: false };

  let exact = !m.includeDynamic && !m.excludeDynamic;
  const truncated = false;
  const dimNames = m.dims.map((d) => d.name);
  const productSize = m.dims.reduce((n, d) => n * (d.values === null ? 1 : Math.max(1, d.values.length)), 1);
  const truncatedResult = (minJobs: number | undefined): MatrixExpansion => {
    // Too large to enumerate: report the keys only; rules that need combinations stay silent.
    const keys = [...dimNames];
    for (const e of m.include) for (const k of Object.keys(e.values)) if (!keys.includes(k)) keys.push(k);
    return {
      combos: [],
      keys,
      exact: false,
      dynamic: false,
      truncated: true,
      productSize,
      ...(minJobs !== undefined ? { minJobs } : {}),
    };
  };
  const large = m.dims.length > 0 && productSize > MAX_COMBINATIONS;
  if (large) {
    // A large product is still listed when exclude brings it down: excluded combinations are dropped while the
    // product is built, as soon as all the keys of an exclude entry are set.
    const minJobs = minJobsAfterExclude(m, productSize);
    if (minJobs === undefined || minJobs > MAX_COMBINATIONS) return truncatedResult(minJobs);
  }
  const pruneAt = new Map<number, MatrixEntry[]>();
  for (const ex of m.exclude) {
    const idx = Object.keys(ex.values).map((k) => dimNames.indexOf(k));
    if (ex.dynamicKeys.length || idx.length === 0 || idx.includes(-1)) continue;
    const at = Math.max(...idx);
    pruneAt.set(at, [...(pruneAt.get(at) ?? []), ex]);
  }

  let product: Combination[] = [];
  if (m.dims.length > 0) {
    product = [{ values: {}, origin: 'product', includes: [] }];
    for (const [i, dim] of m.dims.entries()) {
      const cells: Cell[] =
        dim.values === null
          ? [{ known: false }]
          : dim.values.map((v, i) =>
              dim.unknownIndexes.includes(i) ? { known: false } : { known: true, value: v },
            );
      if (dim.values === null || dim.unknownIndexes.length > 0) exact = false;
      const prune = pruneAt.get(i) ?? [];
      const next: Combination[] = [];
      for (const combo of product) {
        for (const cell of cells) {
          const values = { ...combo.values, [dim.name]: cell };
          // Definite matches only; unknown cells are left to the exclude pass below.
          if (
            prune.some((ex) =>
              Object.entries(ex.values).every(([k, v]) => cellMatches(values[k], v) === true),
            )
          )
            continue;
          next.push({ origin: 'product', includes: [], values });
        }
      }
      if (large && next.length > MAX_COMBINATIONS)
        return truncatedResult(minJobsAfterExclude(m, productSize));
      product = next;
    }
  }

  for (const ex of m.exclude) {
    product = product.filter((combo) => {
      let all = true;
      for (const [k, v] of Object.entries(ex.values)) {
        if (ex.dynamicKeys.includes(k)) {
          exact = false;
          all = false;
          break;
        }
        const r = cellMatches(combo.values[k], v);
        if (r === undefined) exact = false;
        if (r !== true) {
          all = false;
          break;
        }
      }
      return !all;
    });
  }

  const originals = product;
  const created: Combination[] = [];
  m.include.forEach((entry, idx) => {
    const entryCells: Record<string, Cell> = {};
    for (const [k, v] of Object.entries(entry.values)) {
      entryCells[k] = entry.dynamicKeys.includes(k) ? { known: false } : { known: true, value: v };
    }
    let merged = false;
    for (const combo of originals) {
      let fits = true;
      for (const [k, cell] of Object.entries(entryCells)) {
        if (!dimNames.includes(k)) continue;
        if (!cell.known) {
          exact = false;
          continue;
        }
        const r = cellMatches(combo.values[k], cell.value);
        if (r === undefined) exact = false;
        if (r === false) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      for (const [k, cell] of Object.entries(entryCells)) {
        if (!dimNames.includes(k)) combo.values[k] = cell;
      }
      combo.includes.push(idx);
      merged = true;
    }
    if (!merged) created.push({ values: { ...entryCells }, origin: 'include', includes: [idx] });
  });

  const combos = [...originals, ...created];
  const keys: string[] = [];
  for (const c of combos) for (const k of Object.keys(c.values)) if (!keys.includes(k)) keys.push(k);
  return { combos, keys, exact, dynamic: false, truncated, productSize };
}

/** Human-readable label such as `{ os: windows-latest, node: 20 }`. */
export function comboLabel(combo: Combination, keys?: string[]): string {
  const shown = keys ?? Object.keys(combo.values);
  const parts = shown
    .filter((k) => k in combo.values)
    .map((k) => {
      const c = combo.values[k]!;
      return `${k}: ${c.known ? (typeof c.value === 'string' ? c.value : JSON.stringify(c.value)) : '<expr>'}`;
    });
  return `{ ${parts.join(', ')} }`;
}

/** Resolver that answers `matrix.*` from a concrete combination, marking missing keys with a taint. */
export function matrixResolver(combo: Combination): ContextResolver {
  return ({ context, path }) => {
    if (context !== 'matrix') return undefined;
    if (path.length === 0) return UNKNOWN;
    const key = path[0]!;
    const cell = lookup(combo.values, key);
    if (!cell) return known(null, [{ kind: 'missing-matrix-key', key }]);
    if (!cell.known) return UNKNOWN;
    let value: Json = cell.value;
    for (const seg of path.slice(1)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) value = lookup(value, seg) ?? null;
      else if (Array.isArray(value)) value = value[Number(seg)] ?? null;
      else value = null;
    }
    return known(value);
  };
}

export function isEmptyValue(v: EvalValue): boolean {
  return v.known && (v.value === null || v.value === '');
}

/** Expansion for a runtime-computed matrix whose keys were declared in the config (`matrixShapes`). */
export function declaredMatrix(keys: string[]): MatrixExpansion {
  const values: Record<string, Cell> = Object.fromEntries(keys.map((k) => [k, { known: false } as Cell]));
  return {
    combos: [{ values, origin: 'product', includes: [] }],
    keys,
    exact: false,
    dynamic: false,
    truncated: false,
    declared: true,
  };
}
