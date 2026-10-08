import { FeatureFlags } from '@actions/expressions/features';
import { NoOperationTraceWriter, parseWorkflow } from '@actions/workflow-parser';
import { parseAction } from '@actions/workflow-parser/actions/action-parser';
import type { MappingDefinition } from '@actions/workflow-parser/templates/schema/mapping-definition';
import type { TemplateSchema } from '@actions/workflow-parser/templates/schema/template-schema';
import {
  TemplateContext,
  TemplateValidationErrors,
} from '@actions/workflow-parser/templates/template-context';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { CONTEXT_FUNCTIONS, KNOWN_CONTEXTS } from './expressions';
import type { Diagnostic, UnitDecl } from './ir';
import type { Logger } from './logger';
import { didYouMean } from './rules/util';
import { mappingsAt, SCHEMA_ROOT, schemaFor, workflowSchema } from './schema';
import type { Loc } from './source';

/** Syntax problems are reported by FP502 with better positions; drop the parser's duplicates. */
const SYNTAX_NOISE = [/Unexpected symbol/i, /Unexpected end of expression/i, /Unclosed expression/i];

/** Action metadata that GitHub's schema requires but the runner does not need for local actions. */
const LOCAL_ACTION_NOISE = /Required property is missing: (name|description)\b/i;

const CONTEXT_NAMES = new Set<string>(KNOWN_CONTEXTS);
const FUNCTION_NAMES = new Set(CONTEXT_FUNCTIONS.map((f) => f.name.toLowerCase()));

/**
 * GitHub runs background steps (`background`, `wait`, `wait-all`, `cancel`); @actions/workflow-parser 0.3.61 rejects
 * them unless the caller turns on this experimental flag.
 */
const WORKFLOW_FEATURES = new FeatureFlags({ allowBackgroundSteps: true });

/** Event filters: keys GitHub uses to decide whether an event triggers the workflow. */
const EVENT_FILTERS = [
  'branches',
  'branches-ignore',
  'tags',
  'tags-ignore',
  'paths',
  'paths-ignore',
  'types',
  'workflows',
];

/**
 * "Unrecognized named-value: 'env'" for a context flowpact knows means the context is not available in that field
 * (GitHub's context-availability rules); for an unknown name it is a typo already reported by FP502.
 */
function classify(message: string): 'drop' | 'context' | 'schema' {
  if (SYNTAX_NOISE.some((re) => re.test(message))) return 'drop';
  const named = /Unrecognized named-value: '([^']+)'/i.exec(message);
  if (named) return CONTEXT_NAMES.has(named[1]!.toLowerCase()) ? 'context' : 'drop';
  const fn = /Unrecognized function: '([^']+)'/i.exec(message);
  if (fn) return FUNCTION_NAMES.has(fn[1]!.toLowerCase()) ? 'context' : 'drop';
  return 'schema';
}

interface ParserError {
  message: string;
  range?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

function workflowContext(): TemplateContext {
  const context = new TemplateContext(
    new TemplateValidationErrors(),
    workflowSchema(),
    new NoOperationTraceWriter(),
  );
  context.state.featureFlags = WORKFLOW_FEATURES;
  return context;
}

/**
 * Validates a workflow or action against GitHub's schema using @actions/workflow-parser
 * (the parser behind GitHub's Actions language service). Never throws: if the parser itself fails,
 * validation is skipped for that file and the reason is logged.
 */
export function validateSchema(unit: UnitDecl, logger: Logger): Diagnostic[] {
  try {
    const file = { name: unit.file, content: unit.source.text };
    const result =
      unit.kind === 'workflow'
        ? parseWorkflow(file, workflowContext())
        : parseAction(file, new NoOperationTraceWriter());
    const errors = result.context.errors.getErrors() as ParserError[];
    const diagnostics = errors
      .filter((e) => classify(e.message) !== 'drop')
      .filter((e) => !(unit.kind === 'action' && LOCAL_ACTION_NOISE.test(e.message)))
      .map((e): Diagnostic => {
        const r = e.range;
        const at = /\(Line: (\d+), Col: (\d+)\)/.exec(e.message);
        const message = e.message
          .replace(/^[^:]*\.ya?ml(?: \(Line: \d+, Col: \d+\))?:\s*/, '')
          .replace(/\.\s*Located at position \d+ within expression:.*$/s, '');
        return {
          message,
          ...(classify(e.message) === 'context' ? { kind: 'context' as const } : {}),
          ...(at ? { at: { line: Number(at[1]), column: Number(at[2]) } } : {}),
          loc: r
            ? {
                file: unit.file,
                line: r.start.line,
                column: r.start.column,
                endLine: r.end.line,
                endColumn: r.end.column,
              }
            : { file: unit.file, line: 1, column: 1, endLine: 1, endColumn: 1 },
        };
      });
    return explain(unit, diagnostics);
  } catch (err) {
    logger.debug(`schema validation skipped for ${unit.file}`, { reason: (err as Error).message });
    return [];
  }
}

type Path = (string | number)[];

interface MapNode {
  path: Path;
  keys: KeyNode[];
  loc: Loc;
}

interface KeyNode {
  name: string;
  map: MapNode;
  loc: Loc;
  /** For a YAML merge key (`<<`): the aliases it names (`*filters`) and the keys of the mappings they point to. */
  merge?: { aliases: string[]; keys: string[] };
}

/** Every mapping and key of the file, by the `line:column` where the parser reports problems with them. */
interface Shape {
  maps: Map<string, MapNode>;
  keys: Map<string, KeyNode>;
}

const posKey = (line: number, column: number) => `${line}:${column}`;

function shapeOf(unit: UnitDecl): Shape | undefined {
  const lineCounter = new LineCounter();
  const doc = parseDocument(unit.source.text, { lineCounter, prettyErrors: false, strict: false });
  if (doc.errors.length > 0) return undefined;
  const shape: Shape = { maps: new Map(), keys: new Map() };
  const locOf = (range: [number, number, number?]): Loc => {
    const a = lineCounter.linePos(range[0]);
    const b = lineCounter.linePos(range[1]);
    return { file: unit.file, line: a.line, column: a.col, endLine: b.line, endColumn: b.col };
  };
  const mergeOf = (value: unknown): KeyNode['merge'] => {
    const sources = isSeq(value) ? value.items : [value];
    const maps = sources.map((s) => (isAlias(s) ? s.resolve(doc) : s)).filter(isMap);
    const keys = maps.flatMap((m) => m.items.flatMap((p) => (isScalar(p.key) ? [String(p.key.value)] : [])));
    const aliases = sources.filter(isAlias).map((a) => `*${a.source}`);
    return { aliases: [...new Set(aliases)], keys };
  };
  const walk = (node: unknown, path: Path): void => {
    if (isSeq(node)) {
      for (const [i, item] of node.items.entries()) walk(item, [...path, i]);
      return;
    }
    // Aliases are not followed: the parser reports problems in aliased content at the anchored node.
    if (!isMap(node) || !node.range) return;
    const map: MapNode = { path, keys: [], loc: locOf(node.range) };
    shape.maps.set(posKey(map.loc.line, map.loc.column), map);
    for (const pair of node.items) {
      if (!isScalar(pair.key) || !pair.key.range) continue;
      const name = String(pair.key.value);
      const key: KeyNode = { name, map, loc: locOf(pair.key.range) };
      // Merge keys are a YAML 1.1 extension. GitHub's parser, like @actions/workflow-parser, reads `<<` as an ordinary
      // key: the mapping it names is not merged.
      if (name === '<<') key.merge = mergeOf(pair.value);
      map.keys.push(key);
      shape.keys.set(posKey(key.loc.line, key.loc.column), key);
      walk(pair.value, [...path, name]);
    }
  };
  walk(doc.contents, []);
  return shape;
}

const unexpectedValue = (name: string) => `Unexpected value '${name}'`;

/** The property a mapping shape defines for a key (own properties only: a key may be named `toString`). */
const propertyOf = (def: MappingDefinition, name: string) =>
  Object.hasOwn(def.properties, name) ? def.properties[name] : undefined;

/**
 * Turns parser errors into what GitHub actually does: keys of steps (or jobs) that mix two shapes are reported against
 * the shape the step fits best, and keys GitHub silently ignores are marked as such instead of as errors that stop
 * the run.
 */
function explain(unit: UnitDecl, diagnostics: Diagnostic[]): Diagnostic[] {
  if (!diagnostics.some((d) => !d.kind)) return diagnostics;
  const shape = shapeOf(unit);
  if (!shape) return diagnostics;
  const schema = schemaFor(unit.kind);
  const root = SCHEMA_ROOT[unit.kind];

  // The key an `Unexpected value 'k'` diagnostic is about.
  const keyOf = new Map<Diagnostic, KeyNode>();
  const groups = new Map<MapNode, Diagnostic[]>();
  for (const d of diagnostics) {
    if (d.kind) continue;
    const pos = posKey(d.loc.line, d.loc.column);
    const unexpected = /^Unexpected value '(.*)'$/s.exec(d.message);
    const key = unexpected ? shape.keys.get(pos) : undefined;
    let map: MapNode | undefined;
    if (key && key.name === unexpected![1]) {
      keyOf.set(d, key);
      map = key.map;
    } else if (d.message.startsWith('Required property is missing: ')) {
      map = shape.maps.get(pos);
    }
    if (map) groups.set(map, [...(groups.get(map) ?? []), d]);
  }

  // The first diagnostic of a group stands for the group's new diagnostics, the others for none.
  const replaced = new Map<Diagnostic, Diagnostic[]>();
  for (const [map, group] of groups) {
    const resolved = resolveAlternatives(map, group, keyOf, schema, root);
    if (!resolved) continue;
    for (const [i, d] of group.entries()) replaced.set(d, i === 0 ? resolved : []);
  }

  const out: Diagnostic[] = [];
  for (const d of diagnostics.flatMap((d) => replaced.get(d) ?? [d])) {
    const key = keyOf.get(d);
    // Only the parser's own `Unexpected value 'k'`: an explained key is about the step's shape, not the key itself.
    if (!key || d.message !== unexpectedValue(key.name)) {
      out.push(d);
      continue;
    }
    const ignored = ignoredKey(unit.kind, key, schema, root);
    if (ignored) out.push({ ...d, kind: 'ignored', ...ignored });
    else if (key.merge) out.push({ ...d, fix: mergeFix(key, 'here', 'the whole mapping') });
    else out.push(d);
  }
  return out;
}

/**
 * The parser picks between alternative shapes (a `run` or a `uses` step, a job that runs steps or calls a workflow)
 * by the first key that only some of them allow, then reports every other key against that choice. When that guess
 * is wrong, one misplaced key produces errors that blame the right ones; those are reported against the shape the
 * mapping fits best instead: one error per key it does not allow, at that key, and one per required key it lacks.
 * When the guess is right, the parser's errors stay. Either way, a key another shape allows says which key it
 * conflicts with. Returns `undefined` to keep the parser's errors as they are.
 */
function resolveAlternatives(
  map: MapNode,
  group: Diagnostic[],
  keyOf: Map<Diagnostic, KeyNode>,
  schema: TemplateSchema,
  root: string,
): Diagnostic[] | undefined {
  const shapes = mappingsAt(schema, root, map.path);
  if (shapes.length < 2) return undefined;
  const names = new Set(map.keys.map((k) => k.name));
  const scored = shapes
    .map((def) => {
      const unexpected = def.looseKeyType ? [] : map.keys.filter((k) => !propertyOf(def, k.name));
      const missing = Object.entries(def.properties)
        .filter(([name, p]) => p.required && !names.has(name))
        .map(([name]) => name);
      return { def, unexpected, missing, score: unexpected.length + missing.length };
    })
    .sort((a, b) => a.score - b.score);
  const [best, runnerUp] = scored;
  if (!best || !runnerUp || best.score === 0) return undefined;

  // Whether every parser error is a problem with this shape too.
  const agrees = (def: MappingDefinition) =>
    group.every((d) => {
      const key = keyOf.get(d);
      if (key) return !def.looseKeyType && !propertyOf(def, key.name);
      return propertyOf(def, d.message.slice('Required property is missing: '.length))?.required === true;
    });
  // `k (not allowed together with `uses`)`, when another shape allows k and the mapping has a key only `def` allows.
  const explained = (def: MappingDefinition) => {
    const others = shapes.filter((s) => s !== def);
    const own = map.keys.filter((k) => propertyOf(def, k.name) && !others.some((o) => propertyOf(o, k.name)));
    const anchor = own.find((k) => propertyOf(def, k.name)!.required) ?? own[0];
    return (key: KeyNode, d: Diagnostic): Diagnostic => {
      if (!anchor || !others.some((o) => propertyOf(o, key.name))) return d;
      const e = { ...d, message: `${d.message} (not allowed together with \`${anchor.name}\`)` };
      keyOf.set(e, key);
      return e;
    };
  };

  if (best.score < runnerUp.score && !agrees(best.def)) {
    const explain = explained(best.def);
    return [
      ...best.unexpected.map((key) => {
        const parsed = group.find((d) => keyOf.get(d) === key);
        const d = parsed ?? { message: unexpectedValue(key.name), loc: key.loc };
        keyOf.set(d, key);
        return explain(key, d);
      }),
      ...best.missing.map((name) => {
        const message = `Required property is missing: ${name}`;
        return group.find((d) => d.message === message) ?? { message, loc: map.loc };
      }),
    ];
  }

  // The parser guessed a shape that fits as well as any: keep its errors, and say why a misplaced key is wrong.
  const guesses = scored.filter((s) => s.score === best.score && agrees(s.def));
  if (guesses.length !== 1) return undefined;
  const explain = explained(guesses[0]!.def);
  return group.map((d) => (keyOf.has(d) ? explain(keyOf.get(d)!, d) : d));
}

/**
 * Keys GitHub accepts and ignores, unlike the strict schema the parser (and GitHub's editor tooling) validates with:
 * - unknown top-level keys of action metadata: the runner reads action.yml with a schema that allows any extra key;
 * - unknown keys under an event in `on:`: GitHub reads only the filters each event supports (`workflow_call`, which
 *   declares an interface, is validated in full).
 * A YAML merge key (`<<`) is such a key too, and what it loses is the keys it was meant to merge.
 */
function ignoredKey(
  kind: UnitDecl['kind'],
  key: KeyNode,
  schema: TemplateSchema,
  root: string,
): { message: string; fix: string } | undefined {
  const { path } = key.map;
  const shapes = mappingsAt(schema, root, path);
  const known = [...new Set(shapes.flatMap((s) => Object.keys(s.properties)))];
  // The error is about another occurrence of this key (YAML aliases report at the anchored node).
  if (known.includes(key.name)) return undefined;
  const guess = didYouMean(key.name, known);
  const hint = guess ? ` (did you mean \`${guess}\`?)` : '';
  const rename = guess ? `Rename it to \`${guess}\`.` : undefined;

  if (kind === 'action' && path.length === 0) {
    if (key.merge) {
      return {
        message: `GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so ${merged(key)} are not applied`,
        fix: mergeFix(key, 'at the top level'),
      };
    }
    if (key.name === 'env') {
      return {
        message:
          "GitHub ignores this key: actions have no top-level `env`, so the action's steps never see these values",
        fix: 'Set the variables in `env:` on the steps that read them, or declare them as inputs.',
      };
    }
    return {
      message: `GitHub ignores this key: action metadata has no \`${key.name}\`${hint}, so it has no effect`,
      fix: rename ?? 'Remove it.',
    };
  }

  const event = path[1];
  if (
    kind === 'workflow' &&
    path.length === 2 &&
    path[0] === 'on' &&
    typeof event === 'string' &&
    event !== 'workflow_call' &&
    shapes.length > 0
  ) {
    if (key.merge) {
      const filters = key.merge.keys.some((k) => EVENT_FILTERS.includes(k));
      return {
        message: `GitHub ignores this key: YAML merge keys (\`<<\`) are not supported, so ${merged(key, filters ? 'filters' : 'keys')} are not applied to \`${event}\`${filters ? ' and the workflow runs regardless of them' : ''}`,
        fix: mergeFix(key, `under \`${event}\``, `the whole event (\`${event}: ${key.merge.aliases[0]}\`)`),
      };
    }
    const filter = didYouMean(key.name, EVENT_FILTERS) !== undefined;
    return {
      message: `GitHub ignores this key: the \`${event}\` event does not support \`${key.name}\`${hint}, ${filter ? 'so the workflow runs regardless of it' : 'so it has no effect'}`,
      fix: rename ?? (filter ? "Remove it, or check the condition in a job's `if:` instead." : 'Remove it.'),
    };
  }
  return undefined;
}

/** What a merge key was meant to bring in: "the filters in `*filters`". */
function merged(key: KeyNode, what = 'keys'): string {
  const aliases = key.merge?.aliases ?? [];
  return aliases.length > 0
    ? `the ${what} in ${aliases.map((a) => `\`${a}\``).join(', ')}`
    : `the ${what} merged here`;
}

/** How to replace a merge key: repeat the keys, or alias the whole mapping when it adds nothing of its own. */
function mergeFix(key: KeyNode, where: string, whole?: string): string {
  const repeat = `GitHub does not support YAML merge keys (\`<<\`): repeat the keys ${where}`;
  const single = key.merge?.aliases.length === 1 && key.map.keys.length === 1;
  return whole && single ? `${repeat}, or alias ${whole} instead.` : `${repeat}.`;
}
