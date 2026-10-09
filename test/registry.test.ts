import {
  builtinRules,
  CATEGORIES,
  CODE_PATTERN,
  createRegistry,
  defineRule,
  RuleRegistry,
  RuleRegistryError,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';

const rule = (over: Partial<Parameters<typeof defineRule>[0]> = {}) =>
  defineRule({
    code: 'ACME101',
    name: 'acme-rule',
    category: 'inputs',
    defaultSeverity: 'warning',
    docs: { summary: 's', why: 'w', fix: 'f' },
    docsUrl: 'https://example.com/acme101',
    check: () => {},
    ...over,
  });

describe('RuleRegistry', () => {
  it('accepts plugin rules with their own prefix and docs', () => {
    const r = createRegistry().register(rule());
    expect(r.get('acme101')?.name).toBe('acme-rule');
    expect(r.get('acme-rule')?.code).toBe('ACME101');
    expect(r.docsUrl(r.get('ACME101')!)).toBe('https://example.com/acme101');
  });

  it.each([
    [{ code: 'BAD' }, /Invalid rule code/],
    [{ code: 'FP199' }, /reserved for built-in/],
    [{ docsUrl: undefined }, /must set docsUrl/],
    [{ name: 'Not Kebab' }, /kebab-case/],
    [{ category: 'secrets' as const }, /category digit 1 means "inputs"/],
    [{ code: 'ACME001' }, /unknown category digit 0/],
    [{ generatedFiles: 'ignore' as 'skip' }, /generatedFiles must be "report" or "skip", got "ignore"/],
  ])('rejects %j', (over, msg) => {
    expect(() => new RuleRegistry().register(rule(over))).toThrow(msg);
  });

  it('rejects duplicate codes and names, and non-FP built-ins', () => {
    const r = new RuleRegistry().register(rule());
    expect(() => r.register(rule())).toThrow(RuleRegistryError);
    expect(() => r.register(rule({ code: 'ACME102' }))).toThrow(/Duplicate rule name/);
    expect(() => new RuleRegistry().register(rule(), { builtin: true })).toThrow(/must use the FP prefix/);
  });
});

describe('built-in rules', () => {
  const registry = createRegistry();

  it('all register, with unique codes and names', () => {
    expect(registry.all()).toHaveLength(builtinRules.length);
  });

  it.each(builtinRules.map((r) => [r.code, r]))(
    '%s has complete docs and a matching category',
    (_code, r) => {
      expect(CODE_PATTERN.test(r.code)).toBe(true);
      const digit = Number(CODE_PATTERN.exec(r.code)![2]) as keyof typeof CATEGORIES;
      expect(CATEGORIES[digit].id).toBe(r.category);
      expect(r.docs.summary.length).toBeGreaterThan(20);
      expect(r.docs.why.length).toBeGreaterThan(30);
      expect(r.docs.fix.length).toBeGreaterThan(10);
      expect(registry.docsUrl(r)).toBe(
        `https://rumankazi.github.io/flowpact/docs/rules/${r.code.toLowerCase()}`,
      );
    },
  );
});
