import { contractRules } from './contracts';
import { expressionRules } from './expressions';
import { impactRules } from './impact';
import { inputRules } from './inputs';
import { matrixRules } from './matrix';
import { outputRules } from './outputs';
import { overrideRules } from './overrides';
import { RuleRegistry } from './registry';
import { secretRules } from './secrets';
import { structureRules } from './structure';
import type { RuleDefinition } from './types';

export const builtinRules: RuleDefinition[] = [
  ...inputRules,
  ...secretRules,
  ...outputRules,
  ...matrixRules,
  ...expressionRules,
  ...structureRules,
  ...contractRules,
  ...impactRules,
  ...overrideRules,
];

/** A registry pre-loaded with every built-in rule. Register plugin rules on the returned instance. */
export function createRegistry(): RuleRegistry {
  const registry = new RuleRegistry();
  for (const rule of builtinRules) registry.register(rule, { builtin: true });
  return registry;
}

export { IMPACT_CODES } from './impact';
export * from './registry';
export * from './types';
