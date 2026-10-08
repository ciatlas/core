import { posix } from 'node:path';
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  type Scalar,
  visit,
  type YAMLMap,
} from 'yaml';
import { findTemplateSegments, type Json, parseExpression } from './expressions';
import type {
  ActionDecl,
  Binding,
  Diagnostic,
  ExprSegment,
  ExprSite,
  InputDecl,
  JobDecl,
  MatrixDecl,
  MatrixDim,
  MatrixEntry,
  OutputDecl,
  PermissionsDecl,
  SecretDecl,
  SiteField,
  StepDecl,
  UsesRef,
  WorkflowDecl,
} from './ir';
import { type Loc, SourceFile } from './source';
import { trimChar } from './text';

export interface ParseContext {
  /** `owner/repo` of the analyzed repository, used to resolve same-repo `uses:` references. */
  repository?: string;
  nextSiteId: () => number;
}

export function createParseContext(repository?: string): ParseContext {
  let id = 0;
  return { ...(repository ? { repository } : {}), nextSiteId: () => ++id };
}

type YPath = (string | number)[];

interface Unit {
  source: SourceFile;
  sites: ExprSite[];
  siteByPath: Map<string, ExprSite>;
  parseErrors: Diagnostic[];
}

const pathKey = (p: YPath) => JSON.stringify(p);

function nodeLoc(source: SourceFile, node: Node | null | undefined): Loc {
  const r = node?.range;
  if (!r) return source.loc(0, 0);
  return source.loc(r[0], r[1]);
}

function pairs(node: unknown): Pair<Scalar, Node>[] {
  if (!isMap(node)) return [];
  return (node as YAMLMap<Scalar, Node>).items.filter((p) => isPair(p) && isScalar(p.key)) as Pair<
    Scalar,
    Node
  >[];
}

function get(node: unknown, key: string): Node | undefined {
  for (const p of pairs(node))
    if (String(p.key.value) === key) return (p.value ?? undefined) as Node | undefined;
  return undefined;
}

function getPair(node: unknown, key: string): Pair<Scalar, Node> | undefined {
  return pairs(node).find((p) => String(p.key.value) === key);
}

function str(node: unknown): string | undefined {
  if (isScalar(node) && node.value !== null && node.value !== undefined) return String(node.value);
  return undefined;
}

function toJs(node: unknown): Json {
  if (node === null || node === undefined) return null;
  if (isScalar(node) || isMap(node) || isSeq(node)) return (node as Node).toJSON() as Json;
  return null;
}

// ---------------------------------------------------------------------------
// Expression sites
// ---------------------------------------------------------------------------

function classify(
  kind: 'workflow' | 'action',
  p: YPath,
): Pick<ExprSite, 'field' | 'job' | 'step' | 'key'> & { cond: boolean } {
  if (kind === 'workflow') {
    if (p[0] === 'jobs' && typeof p[1] === 'string') {
      const job = p[1];
      if (p[2] === 'steps' && typeof p[3] === 'number') {
        const step = p[3];
        const f = p[4];
        if (f === 'if' && p.length === 5) return { field: 'step.if', job, step, cond: true };
        if (f === 'with' && typeof p[5] === 'string')
          return { field: 'step.with', job, step, key: p[5], cond: false };
        if (f === 'env' && typeof p[5] === 'string')
          return { field: 'step.env', job, step, key: p[5], cond: false };
        if (f === 'run') return { field: 'step.run', job, step, cond: false };
        return { field: 'step.other', job, step, cond: false };
      }
      const f = p[2];
      if (f === 'if' && p.length === 3) return { field: 'job.if', job, cond: true };
      if (f === 'name' && p.length === 3) return { field: 'job.name', job, cond: false };
      if (f === 'with' && typeof p[3] === 'string') return { field: 'job.with', job, key: p[3], cond: false };
      if (f === 'secrets' && typeof p[3] === 'string')
        return { field: 'job.secrets', job, key: p[3], cond: false };
      if (f === 'env' && typeof p[3] === 'string') return { field: 'job.env', job, key: p[3], cond: false };
      if (f === 'outputs' && typeof p[3] === 'string')
        return { field: 'job.output', job, key: p[3], cond: false };
      if (f === 'strategy') return { field: 'job.strategy', job, cond: false };
      return { field: 'job.other', job, cond: false };
    }
    if (p[0] === 'env' && typeof p[1] === 'string') return { field: 'workflow.env', key: p[1], cond: false };
    if (
      p[0] === 'on' &&
      p[1] === 'workflow_call' &&
      p[2] === 'outputs' &&
      typeof p[3] === 'string' &&
      p[4] === 'value'
    ) {
      return { field: 'workflow.output', key: p[3], cond: false };
    }
    if (p[0] === 'on' && p[2] === 'inputs' && p[4] === 'default' && typeof p[3] === 'string') {
      return { field: 'input.default', key: p[3], cond: false };
    }
    return { field: 'workflow.other', cond: false };
  }
  if (p[0] === 'runs' && p[1] === 'steps' && typeof p[2] === 'number') {
    const step = p[2];
    const f = p[3];
    if (f === 'if' && p.length === 4) return { field: 'step.if', step, cond: true };
    if (f === 'with' && typeof p[4] === 'string') return { field: 'step.with', step, key: p[4], cond: false };
    if (f === 'env' && typeof p[4] === 'string') return { field: 'step.env', step, key: p[4], cond: false };
    if (f === 'run') return { field: 'step.run', step, cond: false };
    return { field: 'step.other', step, cond: false };
  }
  if (p[0] === 'runs' && (p[1] === 'pre-if' || p[1] === 'post-if') && p.length === 2) {
    return { field: 'action.runs-if', cond: true };
  }
  if (p[0] === 'outputs' && typeof p[1] === 'string' && p[2] === 'value') {
    return { field: 'action.output', key: p[1], cond: false };
  }
  if (p[0] === 'inputs' && typeof p[1] === 'string' && p[2] === 'default') {
    return { field: 'input.default', key: p[1], cond: false };
  }
  return { field: 'other', cond: false };
}

function collectSites(
  unit: Unit,
  kind: 'workflow' | 'action',
  ownerPath: string,
  ctx: ParseContext,
  root: Node,
) {
  const visit = (node: unknown, p: YPath) => {
    if (isMap(node)) {
      for (const pair of pairs(node)) visit(pair.value, [...p, String(pair.key.value)]);
      return;
    }
    if (isSeq(node)) {
      for (const [i, item] of node.items.entries()) visit(item, [...p, i]);
      return;
    }
    if (!isScalar(node)) return;
    const c = classify(kind, p);
    const isString = typeof node.value === 'string';
    // A bare `if:` is an expression even without `${{ }}`; booleans like `if: false` are literals.
    if (!isString && !c.cond) return;
    const text = isString ? (node.value as string) : String(node.value);
    if (!c.cond && !text.includes('${{')) return;
    if (c.cond && !isString) return;
    const site = buildSite(unit, node as Scalar, text, c, p, ownerPath, ctx);
    unit.sites.push(site);
    unit.siteByPath.set(pathKey(p), site);
  };
  visit(root, []);
}

function buildSite(
  unit: Unit,
  node: Scalar,
  text: string,
  c: ReturnType<typeof classify>,
  p: YPath,
  ownerPath: string,
  ctx: ParseContext,
): ExprSite {
  const { source } = unit;
  const [start, end] = node.range ?? [0, 0];
  const raw = source.text.slice(start, end);
  const segments: ExprSegment[] = [];

  // Offsets in the decoded value drift from the source in folded/literal blocks, quoted strings with escapes and
  // CRLF files, so each reference is located by searching for its own text in the raw scalar, in order.
  let cursor = 0;
  const locateSegment = (absInner: number, expr: ReturnType<typeof parseExpression>): ExprSegment => {
    cursor = Math.max(cursor, absInner - start);
    const refs = expr.refs.map((r) => {
      const refText = expr.source.slice(r.start, r.end);
      const found = refText ? raw.indexOf(refText, cursor) : -1;
      if (found >= 0) {
        cursor = found + refText.length;
        return { ...r, loc: source.loc(start + found, start + found + refText.length) };
      }
      return { ...r, loc: source.loc(absInner + r.start, absInner + r.end) };
    });
    return { expr, loc: source.loc(absInner, absInner + expr.source.length), refs };
  };

  const templated = findTemplateSegments(text);
  const wholeIsTemplate =
    templated.length === 1 && text.trim() === text.slice(templated[0]!.start, templated[0]!.end);
  if (c.cond && !wholeIsTemplate && templated.length === 0) {
    const inner = text.trim();
    const expr = parseExpression(inner);
    const idx = raw.indexOf(inner.slice(0, Math.min(inner.length, 40)));
    segments.push(locateSegment(start + Math.max(0, idx), expr));
  } else {
    let searchFrom = 0;
    for (const seg of templated) {
      const idx = raw.indexOf('${{', searchFrom);
      const absOpen = idx >= 0 ? start + idx : start;
      if (idx >= 0) searchFrom = idx + 3;
      const lead = seg.innerStart - seg.start;
      const rawAfter = idx >= 0 ? raw.slice(idx + 3) : '';
      const leadRaw = idx >= 0 ? 3 + (rawAfter.length - rawAfter.trimStart().length) : lead;
      segments.push(locateSegment(absOpen + leadRaw, seg.expr));
    }
  }

  return {
    id: ctx.nextSiteId(),
    file: source.path,
    ownerPath,
    field: c.field,
    ...(c.job !== undefined ? { job: c.job } : {}),
    ...(c.step !== undefined ? { step: c.step } : {}),
    ...(c.key !== undefined ? { key: c.key } : {}),
    yamlPath: p,
    text,
    loc: source.loc(start, end),
    isCondition: c.cond,
    segments,
  };
}

// ---------------------------------------------------------------------------
// Structured extraction
// ---------------------------------------------------------------------------

function bindings(unit: Unit, node: unknown, base: YPath): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const site = unit.siteByPath.get(pathKey([...base, name]));
    out[name] = {
      name,
      loc: nodeLoc(unit.source, pair.key),
      valueLoc: nodeLoc(unit.source, (pair.value as Node) ?? pair.key),
      value: toJs(pair.value),
      ...(site ? { site } : {}),
    };
  }
  return out;
}

function inputDecls(unit: Unit, node: unknown): Record<string, InputDecl> {
  const out: Record<string, InputDecl> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const def = pair.value;
    const defaultPair = getPair(def, 'default');
    const type = str(get(def, 'type'));
    const description = str(get(def, 'description'));
    const opts = get(def, 'options');
    out[name] = {
      name,
      ...(type ? { type } : {}),
      required: toJs(get(def, 'required')) === true,
      hasDefault: defaultPair !== undefined && toJs(defaultPair.value) !== null,
      ...(defaultPair ? { default: toJs(defaultPair.value) } : {}),
      ...(description ? { description } : {}),
      ...(isSeq(opts) ? { options: (toJs(opts) as Json[]).map(String) } : {}),
      loc: nodeLoc(unit.source, pair.key),
    };
  }
  return out;
}

function secretDecls(unit: Unit, node: unknown): Record<string, SecretDecl> {
  const out: Record<string, SecretDecl> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const description = str(get(pair.value, 'description'));
    out[name] = {
      name,
      required: toJs(get(pair.value, 'required')) === true,
      ...(description ? { description } : {}),
      loc: nodeLoc(unit.source, pair.key),
    };
  }
  return out;
}

function outputDecls(unit: Unit, node: unknown, base: YPath, valueKey: boolean): Record<string, OutputDecl> {
  const out: Record<string, OutputDecl> = {};
  for (const pair of pairs(node)) {
    const name = String(pair.key.value);
    const valueNode = valueKey ? get(pair.value, 'value') : pair.value;
    const site = unit.siteByPath.get(pathKey(valueKey ? [...base, name, 'value'] : [...base, name]));
    const description = valueKey ? str(get(pair.value, 'description')) : undefined;
    out[name] = {
      name,
      loc: nodeLoc(unit.source, pair.key),
      ...(description ? { description } : {}),
      ...(valueNode !== undefined ? { value: toJs(valueNode) } : {}),
      ...(site ? { site } : {}),
    };
  }
  return out;
}

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** `a/./b/` → `a/b`, `` → `.`. Anything escaping the root (`../x`) keeps its `..` and is never read. */
export function normalizeRelative(path: string): string {
  return trimChar(posix.normalize(trimChar(path, '/') || '.'), '/') || '.';
}

export function classifyUses(raw: string, at: 'job' | 'step', loc: Loc, ctx: ParseContext): UsesRef {
  const value = raw.trim();
  if (value.startsWith('docker://')) return { raw, loc, kind: 'docker' };
  const kind = at === 'job' ? 'local-workflow' : 'local-action';
  if (value.startsWith('$/')) {
    // `$/path` is this repository at the running commit, wherever the workspace is. GitHub rejects an `@ref` suffix.
    const refAt = value.indexOf('@');
    const target = normalizeRelative(refAt < 0 ? value.slice(2) : value.slice(2, refAt));
    return { raw, loc, kind, target, self: true, ...(refAt < 0 ? {} : { selfRef: value.slice(refAt + 1) }) };
  }
  if (value.startsWith('./')) {
    // `./` alone is an action in the repository root. A job's `./` is relative to the repository; a step's to the
    // runner's workspace, which the loader maps through the job's checkouts (`target` assumes the repository root).
    const target = normalizeRelative(value.slice(2));
    if (at === 'job') return { raw, loc, kind, target };
    return { raw, loc, kind, target, workspacePath: target };
  }
  const [path = '', ref] = value.split('@');
  const parts = path.split('/');
  const repo = parts.slice(0, 2).join('/');
  const rest = parts.slice(2).join('/');
  if (ctx.repository && repo.toLowerCase() === ctx.repository.toLowerCase()) {
    if (at === 'job' && WORKFLOW_FILE.test(rest)) {
      return { raw, loc, kind: 'local-workflow', target: rest, ...(ref ? { sameRepoRef: ref } : {}) };
    }
    if (at === 'step') {
      return { raw, loc, kind: 'local-action', target: rest || '.', ...(ref ? { sameRepoRef: ref } : {}) };
    }
  }
  return { raw, loc, kind: at === 'job' ? 'remote-workflow' : 'remote-action' };
}

/**
 * Heuristically finds names written to `$GITHUB_OUTPUT` / `$GITHUB_ENV` by an inline script.
 * `dynamic` means the script writes something we cannot name (e.g. `cat file >> $GITHUB_OUTPUT`).
 */
export function scanRunWrites(script: string, fileVar: 'GITHUB_OUTPUT' | 'GITHUB_ENV') {
  const names = new Set<string>();
  let dynamic = false;
  let mentions = false;
  // A redirect (or tee) into the file: `>> "$GITHUB_OUTPUT"`, `>> ${GITHUB_OUTPUT}`, `| tee -a $env:GITHUB_OUTPUT`.
  const redirect = new RegExp(`(?:>>|\\|\\s*tee(?:\\s+-a)?)\\s*["']?\\$(?:env:)?\\{?${fileVar}\\}?["']?`);
  // `OUT=$GITHUB_OUTPUT` (then `>> "$OUT"`): the writes go through an alias we do not follow.
  const alias = new RegExp(
    `(?:^|[\\s;&|(])(?:export\\s+|local\\s+|declare\\s+(?:-\\w+\\s+)*)?[A-Za-z_]\\w*=["']?\\$\\{?${fileVar}\\b`,
  );
  for (const line of script.split(/\r?\n/)) {
    if (!line.includes(fileVar)) continue;
    mentions = true;
    if (alias.test(line)) {
      dynamic = true;
      continue;
    }
    // A line may hold several writes (`a >> $F; b >> $F`, if/else one-liners): scan the text before each redirect.
    const chunks = line.split(redirect);
    const written = chunks.length > 1 ? chunks.slice(0, -1) : [line];
    for (const chunk of written) {
      const found = [...chunk.matchAll(/(?:^|[\s"'`(;])([A-Za-z_][\w-]*)(?:=|<<)/g)].map((m) => m[1]!);
      // `cat out.txt >> $GITHUB_OUTPUT`, `} >> $GITHUB_OUTPUT` (grouped writes) or `echo "$name=..."`.
      if (found.length === 0 || /\$\{?\w+\}?(?:=|<<)/.test(chunk)) dynamic = true;
      for (const n of found) if (n !== fileVar) names.add(n);
    }
  }
  // `core.setOutput('name', ...)` / `core.exportVariable('NAME', ...)` in node scripts.
  const api = fileVar === 'GITHUB_OUTPUT' ? 'setOutput' : 'exportVariable';
  for (const m of script.matchAll(new RegExp(`\\b${api}\\(`, 'g'))) {
    mentions = true;
    // Only a complete string literal (no interpolation, no concatenation) names the output; anything else is dynamic.
    const literal = /^\s*(?:(['"])([^'"\\\n]+)\1|`([^`$\\]+)`)\s*,/.exec(script.slice(m.index + m[0].length));
    const name = literal?.[2] ?? literal?.[3];
    if (name) names.add(name);
    else dynamic = true;
  }
  return { names: [...names], dynamic, mentions };
}

function steps(
  unit: Unit,
  node: unknown,
  base: YPath,
  at: 'workflow' | 'action',
  ctx: ParseContext,
): StepDecl[] {
  if (!isSeq(node)) return [];
  return node.items.map((item, index) => {
    const p = [...base, index];
    const id = str(get(item, 'id'));
    const idPair = getPair(item, 'id');
    const usesNode = get(item, 'uses');
    const runNode = get(item, 'run');
    const run = str(runNode);
    const name = str(get(item, 'name'));
    const usesRaw = str(usesNode);
    const ifSite = unit.siteByPath.get(pathKey([...p, 'if']));
    void at;
    return {
      index,
      ...(id ? { id, idLoc: nodeLoc(unit.source, idPair?.key) } : {}),
      ...(name ? { name } : {}),
      loc: nodeLoc(unit.source, item as Node),
      ...(usesRaw ? { uses: classifyUses(usesRaw, 'step', nodeLoc(unit.source, usesNode), ctx) } : {}),
      ...(run !== undefined ? { run, runLoc: nodeLoc(unit.source, runNode) } : {}),
      with: bindings(unit, get(item, 'with'), [...p, 'with']),
      env: bindings(unit, get(item, 'env'), [...p, 'env']),
      ...(ifSite ? { ifSite } : {}),
      writesOutputs:
        run !== undefined ? scanRunWrites(run, 'GITHUB_OUTPUT') : scriptWrites(item, 'GITHUB_OUTPUT'),
      writesEnv: (() => {
        const s = run !== undefined ? scanRunWrites(run, 'GITHUB_ENV') : scriptWrites(item, 'GITHUB_ENV');
        return { names: s.names, dynamic: s.dynamic };
      })(),
    } satisfies StepDecl;
  });
}

/** `actions/github-script` and similar take an inline script in `with.script`. */
function scriptWrites(item: unknown, fileVar: 'GITHUB_OUTPUT' | 'GITHUB_ENV') {
  const script = str(get(get(item, 'with'), 'script'));
  if (!script) return { names: [], dynamic: false, mentions: false };
  const scanned = scanRunWrites(script, fileVar);
  // actions/github-script always publishes the script's return value as the `result` output.
  if (fileVar === 'GITHUB_OUTPUT' && /(^|\/)github-script@/.test(str(get(item, 'uses')) ?? '')) {
    return { ...scanned, names: [...new Set([...scanned.names, 'result'])], mentions: true };
  }
  return scanned;
}

function matrixEntries(unit: Unit, node: unknown, base: YPath): MatrixEntry[] {
  if (!isSeq(node)) return [];
  return node.items.map((item, i) => {
    const values: Record<string, Json> = {};
    const keyLocs: Record<string, Loc> = {};
    const dynamicKeys: string[] = [];
    for (const pair of pairs(item)) {
      const k = String(pair.key.value);
      values[k] = toJs(pair.value);
      keyLocs[k] = nodeLoc(unit.source, pair.key);
      if (unit.siteByPath.has(pathKey([...base, i, k]))) dynamicKeys.push(k);
    }
    return { loc: nodeLoc(unit.source, item as Node), values, keyLocs, dynamicKeys };
  });
}

function matrix(unit: Unit, strategy: unknown, base: YPath): MatrixDecl | undefined {
  const pair = getPair(strategy, 'matrix');
  if (!pair) return undefined;
  const node = pair.value;
  const loc = nodeLoc(unit.source, pair.key);
  const mp = [...base, 'matrix'];
  if (isScalar(node)) {
    const site = unit.siteByPath.get(pathKey(mp));
    return {
      loc,
      dynamic: true,
      ...(site ? { dynamicSite: site } : {}),
      dims: [],
      include: [],
      exclude: [],
      includeDynamic: true,
      excludeDynamic: true,
    };
  }
  const dims: MatrixDim[] = [];
  let include: MatrixEntry[] = [];
  let exclude: MatrixEntry[] = [];
  let includeDynamic = false;
  let excludeDynamic = false;
  for (const p of pairs(node)) {
    const k = String(p.key.value);
    if (k === 'include') {
      if (isScalar(p.value)) includeDynamic = true;
      else include = matrixEntries(unit, p.value, [...mp, 'include']);
      continue;
    }
    if (k === 'exclude') {
      if (isScalar(p.value)) excludeDynamic = true;
      else exclude = matrixEntries(unit, p.value, [...mp, 'exclude']);
      continue;
    }
    if (isSeq(p.value)) {
      const unknownIndexes: number[] = [];
      p.value.items.forEach((_, i) => {
        if (unit.siteByPath.has(pathKey([...mp, k, i]))) unknownIndexes.push(i);
      });
      dims.push({
        name: k,
        loc: nodeLoc(unit.source, p.key),
        values: toJs(p.value) as Json[],
        unknownIndexes,
      });
    } else {
      dims.push({ name: k, loc: nodeLoc(unit.source, p.key), values: null, unknownIndexes: [] });
    }
  }
  return { loc, dynamic: false, dims, include, exclude, includeDynamic, excludeDynamic };
}

function jobs(unit: Unit, node: unknown, ctx: ParseContext): Record<string, JobDecl> {
  const out: Record<string, JobDecl> = {};
  for (const pair of pairs(node)) {
    const id = String(pair.key.value);
    const j = pair.value;
    const p: YPath = ['jobs', id];
    const needsNode = get(j, 'needs');
    const needs: JobDecl['needs'] = [];
    if (isScalar(needsNode) && needsNode.value != null) {
      needs.push({ id: String(needsNode.value), loc: nodeLoc(unit.source, needsNode) });
    } else if (isSeq(needsNode)) {
      for (const n of needsNode.items) {
        if (isScalar(n)) needs.push({ id: String(n.value), loc: nodeLoc(unit.source, n) });
      }
    }
    const usesNode = get(j, 'uses');
    const usesRaw = str(usesNode);
    const secretsPair = getPair(j, 'secrets');
    const secretsInherit = isScalar(secretsPair?.value) && String(secretsPair.value.value) === 'inherit';
    const ifSite = unit.siteByPath.get(pathKey([...p, 'if']));
    const name = str(get(j, 'name'));
    const nameSite = unit.siteByPath.get(pathKey([...p, 'name']));
    const namePair = getPair(j, 'name');
    const perms = permissions(get(j, 'permissions'));
    const ifNode = get(j, 'if');
    const ifValue = isScalar(ifNode) && typeof ifNode.value === 'boolean' ? ifNode.value : undefined;
    const strategy = get(j, 'strategy');
    const m = matrix(unit, strategy, [...p, 'strategy']);
    out[id] = {
      id,
      loc: nodeLoc(unit.source, pair.key),
      ...(name !== undefined ? { name } : {}),
      ...(nameSite ? { nameSite } : {}),
      ...(namePair?.value ? { nameLoc: nodeLoc(unit.source, namePair.value as Node) } : {}),
      ...(perms ? { permissions: perms } : {}),
      ...(ifValue !== undefined ? { ifValue } : {}),
      needs,
      ...(ifSite ? { ifSite } : {}),
      ...(usesRaw ? { uses: classifyUses(usesRaw, 'job', nodeLoc(unit.source, usesNode), ctx) } : {}),
      with: bindings(unit, get(j, 'with'), [...p, 'with']),
      secrets: secretsInherit ? {} : bindings(unit, secretsPair?.value, [...p, 'secrets']),
      secretsInherit,
      ...(secretsPair ? { secretsLoc: nodeLoc(unit.source, secretsPair.key) } : {}),
      env: bindings(unit, get(j, 'env'), [...p, 'env']),
      outputs: outputDecls(unit, get(j, 'outputs'), [...p, 'outputs'], false),
      ...(m ? { matrix: m } : {}),
      steps: steps(unit, get(j, 'steps'), [...p, 'steps'], 'workflow', ctx),
    };
  }
  return out;
}

/** `permissions:` as written: `read-all` / `write-all`, or a map of scopes (unknown values are skipped). */
function permissions(node: unknown): PermissionsDecl | undefined {
  if (isScalar(node)) {
    const v = String(node.value);
    return v === 'read-all' || v === 'write-all' ? v : undefined;
  }
  if (!isMap(node)) return undefined;
  const out: Record<string, 'read' | 'write' | 'none'> = {};
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
    const value = isScalar(pair.value) ? String(pair.value.value) : undefined;
    if (key && (value === 'read' || value === 'write' || value === 'none')) out[key] = value;
  }
  return out;
}

/** Upper bound on the nodes alias expansion may produce; real workflows stay far below it. */
export const MAX_ALIAS_EXPANSION = 50_000;

/**
 * Counts the nodes alias resolution would produce, memoized per node (linear in the document). Returns the alias at
 * which the budget is exceeded, if any, so `a: &a [*b, *b]` chains cannot blow up memory and time.
 */
function aliasExpansionTooLarge(doc: ReturnType<typeof parseDocument>): Node | undefined {
  const memo = new Map<unknown, number>();
  let culprit: Node | undefined;
  const size = (node: unknown): number => {
    if (node === null || node === undefined) return 1;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    memo.set(node, 1); // guards against self-referencing aliases while counting
    let n = 1;
    if (isAlias(node)) {
      n = size(node.resolve(doc));
      if (n > MAX_ALIAS_EXPANSION && !culprit) culprit = node as unknown as Node;
    } else if (isMap(node)) {
      for (const p of node.items) n += size((p as Pair).key) + size((p as Pair).value);
    } else if (isSeq(node)) {
      for (const item of node.items) n += size(item);
    }
    n = Math.min(n, MAX_ALIAS_EXPANSION + 1);
    memo.set(node, n);
    return n;
  };
  return size(doc.contents) > MAX_ALIAS_EXPANSION ? (culprit ?? (doc.contents as Node)) : undefined;
}

function load(path: string, text: string): { unit: Unit; root: Node | undefined } {
  const source = new SourceFile(path, text);
  const doc = parseDocument(text, { lineCounter: source.lineCounter, prettyErrors: false, strict: false });
  // GitHub supports anchors and aliases: replace every alias with the node it points to, so the IR sees the same
  // structure GitHub does. Locations then point at the anchored definition.
  const aliasBomb = doc.errors.length === 0 ? aliasExpansionTooLarge(doc) : undefined;
  if (doc.errors.length === 0 && !aliasBomb) {
    visit(doc, {
      Alias(_, alias) {
        const target = alias.resolve(doc);
        return target ? (target as Node) : undefined;
      },
    });
  }
  const parseErrors: Diagnostic[] = doc.errors.map((e) => ({
    message: e.message.split('\n')[0]!,
    loc: source.loc(e.pos[0], e.pos[1]),
  }));
  if (aliasBomb) {
    parseErrors.push({
      message: `YAML aliases expand to more than ${MAX_ALIAS_EXPANSION} nodes; the file is not analyzed (possible alias bomb)`,
      loc: source.loc(aliasBomb.range?.[0] ?? 0, aliasBomb.range?.[1] ?? 0),
    });
  }
  return {
    unit: { source, sites: [], siteByPath: new Map(), parseErrors },
    root: (doc.contents ?? undefined) as Node | undefined,
  };
}

export function parseWorkflowFile(path: string, text: string, ctx: ParseContext): WorkflowDecl {
  const { unit, root } = load(path, text);
  if (root) collectSites(unit, 'workflow', path, ctx, root);
  const on = get(root, 'on');
  const triggers: string[] = [];
  if (isScalar(on) && on.value != null) {
    triggers.push(String(on.value));
  } else if (isSeq(on)) {
    for (const t of on.items) if (isScalar(t)) triggers.push(String(t.value));
  } else {
    for (const p of pairs(on)) triggers.push(String(p.key.value));
  }

  const callPair = getPair(on, 'workflow_call');
  const dispatchPair = getPair(on, 'workflow_dispatch');
  const call = triggers.includes('workflow_call')
    ? {
        loc: nodeLoc(unit.source, callPair?.key ?? (on as Node)),
        inputs: inputDecls(unit, get(callPair?.value, 'inputs')),
        secrets: secretDecls(unit, get(callPair?.value, 'secrets')),
        outputs: outputDecls(unit, get(callPair?.value, 'outputs'), ['on', 'workflow_call', 'outputs'], true),
      }
    : undefined;
  const dispatch = triggers.includes('workflow_dispatch')
    ? {
        loc: nodeLoc(unit.source, dispatchPair?.key ?? (on as Node)),
        inputs: inputDecls(unit, get(dispatchPair?.value, 'inputs')),
      }
    : undefined;
  const name = str(get(root, 'name'));
  const workflowPermissions = permissions(get(root, 'permissions'));
  return {
    kind: 'workflow',
    path,
    file: path,
    ...(name ? { name } : {}),
    source: unit.source,
    sites: unit.sites,
    parseErrors: unit.parseErrors,
    schemaErrors: [],
    triggers,
    ...(call ? { call } : {}),
    ...(dispatch ? { dispatch } : {}),
    env: bindings(unit, get(root, 'env'), ['env']),
    ...(workflowPermissions ? { permissions: workflowPermissions } : {}),
    jobs: jobs(unit, get(root, 'jobs'), ctx),
  };
}

/** `dir` is the repo-relative action directory (what `uses: ./dir` points at); `file` is its action.yml. */
export function parseActionFile(dir: string, file: string, text: string, ctx: ParseContext): ActionDecl {
  const { unit, root } = load(file, text);
  if (root) collectSites(unit, 'action', dir, ctx, root);
  const runs = get(root, 'runs');
  const using = str(get(runs, 'using'));
  const name = str(get(root, 'name'));
  return {
    kind: 'action',
    path: dir,
    file,
    ...(name ? { name } : {}),
    source: unit.source,
    sites: unit.sites,
    parseErrors: unit.parseErrors,
    schemaErrors: [],
    ...(using ? { using } : {}),
    inputs: inputDecls(unit, get(root, 'inputs')),
    outputs: outputDecls(unit, get(root, 'outputs'), ['outputs'], true),
    steps: steps(unit, get(runs, 'steps'), ['runs', 'steps'], 'action', ctx),
  };
}

export type { SiteField };
