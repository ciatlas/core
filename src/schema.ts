import { getActionSchema } from '@actions/workflow-parser/actions/action-schema';
import type { Definition } from '@actions/workflow-parser/templates/schema/definition';
import { DefinitionType } from '@actions/workflow-parser/templates/schema/definition-type';
import type { MappingDefinition } from '@actions/workflow-parser/templates/schema/mapping-definition';
import { OneOfDefinition } from '@actions/workflow-parser/templates/schema/one-of-definition';
import { PropertyDefinition } from '@actions/workflow-parser/templates/schema/property-definition';
import type { SequenceDefinition } from '@actions/workflow-parser/templates/schema/sequence-definition';
import { StringDefinition } from '@actions/workflow-parser/templates/schema/string-definition';
import type { TemplateSchema } from '@actions/workflow-parser/templates/schema/template-schema';
import { StringToken } from '@actions/workflow-parser/templates/tokens/string-token';
import { getWorkflowSchema } from '@actions/workflow-parser/workflows/workflow-schema';

/** Root definitions @actions/workflow-parser validates against (the strict ones its editor tooling uses). */
export const SCHEMA_ROOT = { workflow: 'workflow-root-strict', action: 'action-root-strict' } as const;

/**
 * `cache-mode` (workflow and job level) is documented and run by GitHub but missing from the parser's schema
 * (0.3.61). https://docs.github.com/actions/reference/workflows-and-actions/workflow-syntax#cache-mode
 */
const CACHE_MODE = {
  values: ['read', 'write', 'write-only', 'none'],
  in: ['workflow-root', 'workflow-root-strict', 'job-factory', 'workflow-job'],
};

let workflow: TemplateSchema | undefined;

/**
 * GitHub's workflow schema plus the keys GitHub runs that the parser does not know yet. The parser's own (shared,
 * cached) schema is left untouched: the copy shares its definitions and replaces only the mappings it extends.
 */
export function workflowSchema(): TemplateSchema {
  if (workflow) return workflow;
  const base = getWorkflowSchema();
  if (base.definitions['cache-mode']) {
    workflow = base;
    return workflow;
  }
  const definitions: Record<string, Definition> = { ...base.definitions };
  const cacheMode = new OneOfDefinition('cache-mode');
  for (const value of CACHE_MODE.values) {
    const constant = new StringDefinition(`cache-mode-${value}`);
    constant.constant = value;
    definitions[constant.key] = constant;
    cacheMode.oneOf.push(constant.key);
  }
  definitions[cacheMode.key] = cacheMode;
  const property = new PropertyDefinition(new StringToken(undefined, undefined, cacheMode.key, undefined));
  for (const name of CACHE_MODE.in) {
    const mapping = definitions[name];
    if (mapping?.definitionType !== DefinitionType.Mapping) continue;
    const { properties } = mapping as MappingDefinition;
    if (properties['cache-mode']) continue;
    definitions[name] = clone(mapping as MappingDefinition, {
      properties: { ...properties, 'cache-mode': property },
    });
  }
  workflow = clone(base, { definitions });
  return workflow;
}

export function schemaFor(kind: 'workflow' | 'action'): TemplateSchema {
  return kind === 'workflow' ? workflowSchema() : getActionSchema();
}

function clone<T extends object>(value: T, overrides: Partial<Record<keyof T, unknown>>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(value) as object) as T, value, overrides);
}

/** A definition and every definition its `one-of` (recursively) refers to. */
function expand(schema: TemplateSchema, name: string, seen = new Set<string>()): Definition[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const def = schema.definitions[name];
  if (!def) return [];
  if (def.definitionType !== DefinitionType.OneOf) return [def];
  return (def as OneOfDefinition).oneOf.flatMap((n) => expand(schema, n, seen));
}

/**
 * The mapping shapes GitHub's schema allows at a YAML path (keys and sequence indexes from the document root). More
 * than one means the parser picks between alternatives (`one-of`), such as a `run` step and a `uses` step.
 */
export function mappingsAt(
  schema: TemplateSchema,
  root: string,
  path: (string | number)[],
): MappingDefinition[] {
  let types = [root];
  for (const seg of path) {
    const next = new Set<string>();
    for (const def of types.flatMap((t) => expand(schema, t))) {
      if (typeof seg === 'number' && def.definitionType === DefinitionType.Sequence) {
        next.add((def as SequenceDefinition).itemType);
      } else if (typeof seg === 'string' && def.definitionType === DefinitionType.Mapping) {
        const mapping = def as MappingDefinition;
        const property = mapping.properties[seg];
        if (property) next.add(property.type);
        else if (mapping.looseValueType) next.add(mapping.looseValueType);
      }
    }
    types = [...next];
  }
  const out = new Set<MappingDefinition>();
  for (const t of types)
    for (const def of expand(schema, t))
      if (def.definitionType === DefinitionType.Mapping) out.add(def as MappingDefinition);
  return [...out];
}
