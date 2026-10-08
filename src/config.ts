import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isMap, isSeq, LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { insideRepository } from './project';
import type { Loc } from './source';
import { SCHEMA_VERSIONS, schemaUrl } from './version';

export const CONFIG_DIR = '.github/workflow-contracts';
export const CONFIG_FILES = ['wfc.config.yml', 'wfc.config.yaml'] as const;

export const severitySettingSchema = z.enum(['error', 'warning', 'info', 'off']);

export const overrideSchema = z
  .object({
    rule: z.string().min(1).describe('Rule code (WFC104) or name (unused-input) to suppress.'),
    target: z
      .string()
      .optional()
      .describe(
        'Symbol the finding is about, e.g. `.github/workflows/ci.yml#inputs.legacy`. Supports `*` and `**`.',
      ),
    file: z
      .string()
      .optional()
      .describe('Repo-relative file path, prefix or glob the finding is located in.'),
    reason: z.string().min(10).describe('Why this finding is accepted. Required, at least 10 characters.'),
    expires: z.iso
      .date()
      .optional()
      .describe(
        'YYYY-MM-DD (UTC). After the end of this day the finding is reported again, together with WFC901.',
      ),
    owner: z.string().optional().describe('Who owns the exception, e.g. `@platform-team`.'),
  })
  .strict()
  .refine((o) => o.target !== undefined || o.file !== undefined, {
    message:
      'set `target` or `file` so the override cannot silence a rule everywhere (use `rules:` for that)',
  });

export type Override = z.infer<typeof overrideSchema>;

export const configSchema = z
  .object({
    $schema: z.string().optional().describe('JSON Schema reference for editor autocomplete.'),
    version: z
      .literal(SCHEMA_VERSIONS.config)
      .default(SCHEMA_VERSIONS.config)
      .describe('Config schema version. Currently 1.'),
    repository: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional()
      .describe(
        'owner/repo of this repository. Lets `uses: owner/repo/.github/workflows/x.yml@ref` resolve locally.',
      ),
    rules: z
      .record(z.string(), severitySettingSchema)
      .default({})
      .describe('Severity per rule, keyed by code (WFC401) or name (empty-binding-for-matrix-combo).'),
    limits: z
      .object({
        nestingDepth: z
          .number()
          .int()
          .positive()
          .default(10)
          .describe('Maximum workflows in one call chain, counting the top-level workflow (WFC602).'),
        maxInputs: z
          .number()
          .int()
          .positive()
          .default(30)
          .describe('Inputs on one workflow_call interface before WFC605 suggests grouping them.'),
      })
      .strict()
      .prefault({})
      .describe('Thresholds used by structure rules.'),
    ignore: z
      .array(z.string())
      .default([])
      .describe('Repo-relative path prefixes or globs (`*`, `**`) whose findings are suppressed.'),
    overrides: z
      .array(overrideSchema)
      .default([])
      .describe('Accepted findings, each with a reason and an optional expiry date.'),
    matrixShapes: z
      .record(
        z.string().regex(/^[^#]+#[^#]+$/, 'use `<workflow path>#<job id>`'),
        z.object({ keys: z.array(z.string()).min(1) }).strict(),
      )
      .default({})
      .describe(
        'Declared keys of runtime-computed matrices, keyed by `<workflow path>#<job id>`. Lets wfc verify `matrix.*` reads (WFC404) instead of reporting WFC403.',
      ),
    plugins: z
      .array(z.string())
      .default([])
      .describe(
        'Repo-relative JavaScript modules (.js/.mjs) exporting extra rules (default export: rule or array of rules).',
      ),
  })
  .strict();

export type WfcConfig = z.infer<typeof configSchema>;

export const defaultConfig = (): WfcConfig => configSchema.parse({});

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export interface LoadedConfig {
  config: WfcConfig;
  /** Repo-relative path of the config file, when one was found. */
  file?: string;
  /** Raw text of the config file, for code frames. */
  text?: string;
  /** Location of each `overrides[i]` entry in the config file. */
  overrideLocs?: Loc[];
}

/** Finds and validates the config. An explicit `--config` path must exist; the default location is optional. */
export function loadConfig(root: string, explicit?: string): LoadedConfig {
  const candidates = explicit ? [explicit] : CONFIG_FILES.map((f) => join(root, CONFIG_DIR, f));
  for (const abs of candidates) {
    const full = explicit && !abs.startsWith('/') ? join(process.cwd(), abs) : abs;
    if (!existsSync(full)) {
      if (explicit) throw new ConfigError(`Config file not found: ${explicit}`, explicit);
      continue;
    }
    const rel = relative(root, full).split('\\').join('/');
    // The default location is part of the checkout: never follow a symlink out of the repository.
    if (!explicit && !insideRepository(root, full)) {
      throw new ConfigError(`${rel} links outside the repository; wfc does not read it`, rel);
    }
    const text = readFileSync(full, 'utf8');
    return { ...parseConfigText(text, rel), file: rel, text };
  }
  return { config: defaultConfig() };
}

/** Parses config YAML, keeping the location of each override for findings about it. */
export function parseConfigText(
  text: string,
  file = 'wfc.config.yml',
): { config: WfcConfig; overrideLocs: Loc[] } {
  const lineCounter = new LineCounter();
  const lines = text.split(/\r?\n/);
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  if (doc.errors.length) {
    throw new ConfigError(`Config file is not valid YAML: ${doc.errors[0]!.message.split('\n')[0]}`, file);
  }
  let data: unknown;
  try {
    data = doc.toJS() ?? {};
  } catch (err) {
    // e.g. yaml's alias limit ("Excessive alias count …").
    throw new ConfigError(`Config file cannot be read: ${(err as Error).message.split('\n')[0]}`, file);
  }
  const config = parseConfig(data, file);
  const overridesNode = isMap(doc.contents) ? doc.contents.get('overrides', true) : undefined;
  const overrideLocs: Loc[] = isSeq(overridesNode)
    ? overridesNode.items.map((item) => {
        const r = (item as { range?: [number, number, number] }).range ?? [0, 0, 0];
        const a = lineCounter.linePos(r[0]);
        return {
          file,
          line: a.line,
          column: a.col,
          endLine: a.line,
          endColumn: (lines[a.line - 1]?.trimEnd().length ?? a.col) + 1,
        };
      })
    : [];
  return { config, overrideLocs };
}

export function parseConfig(raw: unknown, file?: string): WfcConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    // Record-key failures hide the key schema's own message ("use `<workflow path>#<job id>`") one level down.
    const message = (i: z.core.$ZodIssue): string =>
      i.code === 'invalid_key' && i.issues.length
        ? `invalid key: ${i.issues.map((n) => n.message).join('; ')}`
        : i.message;
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${message(i)}`);
    throw new ConfigError(`Invalid config${file ? ` in ${file}` : ''}`, file, issues);
  }
  return result.data;
}

export function configJsonSchema(): Record<string, unknown> {
  return {
    $id: schemaUrl('config'),
    title: 'wfc configuration',
    ...z.toJSONSchema(configSchema, { io: 'input' }),
  };
}

/** Minimal glob: `*` matches within a segment, `**` across segments; plain strings match as path prefixes. */
export function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes('*'))
    return path === pattern || path.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`);
  const re = new RegExp(
    `^${pattern
      .split('**')
      .map((part) => part.split('*').map(escapeRe).join('[^/]*'))
      .join('.*')}$`,
  );
  return re.test(path);
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
