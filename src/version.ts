/** Tool identity. `VERSION` is asserted against package.json by a test so it cannot drift. */
export const TOOL_NAME = 'flowpact';
export const VERSION = '0.3.0'; // x-release-please-version

/** Versions of every on-disk / on-wire format flowpact reads or writes. Bump on breaking changes. */
export const SCHEMA_VERSIONS = {
  config: 1,
  contract: 1,
  report: 1,
} as const;

export const DOCS_BASE_URL = 'https://rumankazi.github.io/flowpact';

export const schemaUrl = (name: keyof typeof SCHEMA_VERSIONS): string =>
  `${DOCS_BASE_URL}/schemas/${name}/v${SCHEMA_VERSIONS[name]}.json`;

export const ruleDocsUrl = (code: string): string => `${DOCS_BASE_URL}/docs/rules/${code.toLowerCase()}`;

export interface ToolMeta {
  tool: string;
  version: string;
  schemas: { config: number; contract: number; report: number };
  node: string;
  platform: string;
}

export function toolMeta(): ToolMeta {
  return {
    tool: TOOL_NAME,
    version: VERSION,
    schemas: { ...SCHEMA_VERSIONS },
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

/** One-line banner, e.g. `flowpact v0.1.0 · config schema v1 · contract schema v1 · report schema v1 · node v24.1.0`. */
export function bannerText(meta: ToolMeta = toolMeta()): string {
  const s = meta.schemas;
  return `${meta.tool} v${meta.version} · config schema v${s.config} · contract schema v${s.contract} · report schema v${s.report} · node ${meta.node}`;
}
