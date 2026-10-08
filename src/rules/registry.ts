import { ruleDocsUrl } from '../version';
import { CATEGORIES, type RuleDefinition } from './types';

export const CODE_PATTERN = /^([A-Z][A-Z0-9]{1,9}?)(\d)(\d{2})$/;
export const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const BUILTIN_PREFIX = 'FP';
/** The prefix of built-in rules before 0.2.0; kept reserved so old codes never point at a plugin rule. */
export const LEGACY_PREFIX = 'WFC';

export class RuleRegistryError extends Error {}

/** Holds every rule flowpact can run. Built-in rules use the `FP` prefix; plugins must bring their own. */
export class RuleRegistry {
  private readonly byCode = new Map<string, RuleDefinition>();
  private readonly byName = new Map<string, RuleDefinition>();

  register(rule: RuleDefinition, opts: { builtin?: boolean } = {}): this {
    const m = CODE_PATTERN.exec(rule.code);
    if (!m) {
      throw new RuleRegistryError(
        `Invalid rule code "${rule.code}": expected <PREFIX><category digit><2 digits>, e.g. FP401 or ACME101`,
      );
    }
    const [, prefix, cat] = m;
    if (!NAME_PATTERN.test(rule.name))
      throw new RuleRegistryError(`Invalid rule name "${rule.name}": use kebab-case`);
    if (opts.builtin && prefix !== BUILTIN_PREFIX) {
      throw new RuleRegistryError(`Built-in rule ${rule.code} must use the ${BUILTIN_PREFIX} prefix`);
    }
    if (!opts.builtin && (prefix === BUILTIN_PREFIX || prefix === LEGACY_PREFIX)) {
      throw new RuleRegistryError(`Rule ${rule.code}: the ${prefix} prefix is reserved for built-in rules`);
    }
    if (!opts.builtin && !rule.docsUrl)
      throw new RuleRegistryError(`Rule ${rule.code}: plugin rules must set docsUrl`);
    const expected = CATEGORIES[Number(cat) as keyof typeof CATEGORIES];
    if (!expected) throw new RuleRegistryError(`Rule ${rule.code}: unknown category digit ${cat}`);
    if (expected.id !== rule.category) {
      throw new RuleRegistryError(
        `Rule ${rule.code}: category digit ${cat} means "${expected.id}" but the rule declares "${rule.category}"`,
      );
    }
    if (this.byCode.has(rule.code)) throw new RuleRegistryError(`Duplicate rule code ${rule.code}`);
    if (this.byName.has(rule.name)) throw new RuleRegistryError(`Duplicate rule name ${rule.name}`);
    this.byCode.set(rule.code, rule);
    this.byName.set(rule.name, rule);
    return this;
  }

  /** Looks a rule up by code (`FP401`, case-insensitive) or name (`empty-binding-for-matrix-combo`). */
  get(codeOrName: string): RuleDefinition | undefined {
    return this.byCode.get(codeOrName.toUpperCase()) ?? this.byName.get(codeOrName.toLowerCase());
  }

  all(): RuleDefinition[] {
    return [...this.byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  docsUrl(rule: RuleDefinition): string {
    return rule.docsUrl ?? ruleDocsUrl(rule.code);
  }
}
