import { readFileSync } from 'node:fs';
import { bannerText, SCHEMA_VERSIONS, schemaUrl, toolMeta, VERSION } from '@wfc/core';
import { describe, expect, it } from 'vitest';

const pkg = (p: string) =>
  JSON.parse(readFileSync(new URL(`../../${p}/package.json`, import.meta.url), 'utf8')).version;

describe('version', () => {
  it('matches every package.json', () => {
    expect(VERSION).toBe(pkg('core'));
    expect(VERSION).toBe(pkg('cli'));
    expect(VERSION).toBe(pkg('reporters'));
  });
  it('reports tool, version and schema versions in the banner', () => {
    const b = bannerText();
    expect(b).toContain(`wfc v${VERSION}`);
    for (const [k, v] of Object.entries(SCHEMA_VERSIONS)) expect(b).toContain(`${k} schema v${v}`);
    expect(toolMeta()).toMatchObject({ tool: 'wfc', version: VERSION, node: process.version });
    expect(schemaUrl('report')).toBe('https://rumankazi.github.io/wfc/schemas/report/v1.json');
  });
});
