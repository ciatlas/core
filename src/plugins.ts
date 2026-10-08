import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, type WfcConfig } from './config';
import type { Logger } from './logger';
import { silentLogger } from './logger';
import type { RuleRegistry } from './rules/registry';
import type { RuleDefinition } from './rules/types';

const isRule = (v: unknown): v is RuleDefinition =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as RuleDefinition).code === 'string' &&
  typeof (v as RuleDefinition).check === 'function';

/**
 * Loads the modules listed under `plugins:` and registers their rules. A module may default-export a rule,
 * an array of rules or `{ rules: [...] }`, and/or export an array (or a single rule) as `rules`.
 */
export async function loadPlugins(
  root: string,
  config: WfcConfig,
  registry: RuleRegistry,
  logger: Logger = silentLogger,
): Promise<RuleDefinition[]> {
  const loaded: RuleDefinition[] = [];
  for (const spec of config.plugins) {
    const abs = isAbsolute(spec) ? spec : resolve(root, spec);
    if (!existsSync(abs))
      throw new ConfigError(`Plugin not found: ${spec}`, undefined, [`plugins: ${abs} does not exist`]);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`Plugin ${spec} failed to load: ${(err as Error).message}`);
    }
    const fromDefault = (v: unknown): unknown[] =>
      Array.isArray(v)
        ? v
        : isRule(v)
          ? [v]
          : Array.isArray((v as { rules?: unknown } | null)?.rules)
            ? (v as { rules: unknown[] }).rules
            : [];
    const exported = [...fromDefault(mod.default), ...(Array.isArray(mod.rules) ? mod.rules : [mod.rules])];
    const rules = [...new Set(exported)].filter(isRule);
    if (rules.length === 0) {
      throw new ConfigError(`Plugin ${spec} exports no rules`, undefined, [
        'export a rule, an array of rules or `{ rules: [...] }` as default (or an array as `rules`)',
      ]);
    }
    for (const rule of rules) registry.register(rule);
    logger.debug(`plugin loaded: ${spec}`, { rules: rules.map((r) => r.code) });
    loaded.push(...rules);
  }
  return loaded;
}
