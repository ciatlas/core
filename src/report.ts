import { z } from 'zod';
import type { AnalysisResult } from './analyze';
import { schemaUrl } from './version';

const locSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});

export const findingSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9]{1,9}\d{3}$/),
  name: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  category: z.string(),
  message: z.string(),
  loc: locSchema,
  related: z.array(z.object({ loc: locSchema, message: z.string() })),
  combos: z.array(z.string()).optional(),
  symbol: z.string().optional(),
  why: z.string(),
  fix: z.string(),
  docsUrl: z.url(),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
});

export const reportSchema = z.object({
  $schema: z.string(),
  meta: z.object({
    tool: z.string(),
    version: z.string(),
    schemas: z.object({ config: z.number(), contract: z.number(), report: z.number() }),
    node: z.string(),
    platform: z.string(),
    root: z.string(),
    configFile: z.string().optional(),
    repository: z.string().optional(),
    durationMs: z.number().nonnegative(),
  }),
  summary: z.object({
    errors: z.number().int(),
    warnings: z.number().int(),
    infos: z.number().int(),
    total: z.number().int(),
    workflows: z.number().int(),
    actions: z.number().int(),
    jobs: z.number().int(),
    matrixCombinations: z.number().int(),
    graph: z.object({ nodes: z.number().int(), edges: z.number().int() }),
    byCode: z.record(z.string(), z.number().int()),
    byFile: z.record(z.string(), z.number().int()),
    suppressed: z.number().int(),
  }),
  findings: z.array(findingSchema),
  suppressed: z.array(
    findingSchema.extend({
      override: z.object({
        index: z.number().int(),
        reason: z.string(),
        expires: z.string().optional(),
        owner: z.string().optional(),
      }),
    }),
  ),
  contracts: z
    .object({
      drift: z.boolean(),
      breaking: z.number().int(),
      counts: z.object({
        create: z.number().int(),
        update: z.number().int(),
        delete: z.number().int(),
        unchanged: z.number().int(),
      }),
      entries: z.array(
        z.object({
          file: z.string(),
          status: z.enum(['create', 'update', 'delete', 'unchanged']),
          unit: z.string().optional(),
          invalid: z.string().optional(),
          changes: z.array(z.object({ breaking: z.boolean(), path: z.string(), message: z.string() })),
        }),
      ),
    })
    .optional(),
  impact: z
    .object({
      baseline: z.object({ kind: z.enum(['ref', 'release']), ref: z.string(), commit: z.string() }),
      required: z.enum(['none', 'patch', 'minor', 'major']),
      declared: z
        .object({
          kind: z.enum(['explicit', 'title', 'labels', 'version']),
          value: z.string(),
          level: z.enum(['none', 'patch', 'minor', 'major']),
        })
        .optional(),
      ok: z.boolean(),
      changes: z.array(
        z.object({
          unit: z.string(),
          kind: z.string(),
          level: z.enum(['none', 'patch', 'minor', 'major']),
          certain: z.boolean(),
          message: z.string(),
          loc: locSchema,
        }),
      ),
    })
    .optional(),
  rules: z.array(
    z.object({ code: z.string(), name: z.string(), severity: z.enum(['error', 'warning', 'info', 'off']) }),
  ),
  graph: z
    .object({
      nodes: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          label: z.string(),
          unit: z.string().optional(),
          loc: locSchema.optional(),
        }),
      ),
      edges: z.array(
        z.object({
          from: z.string(),
          to: z.string(),
          kind: z.string(),
          loc: locSchema.optional(),
          siteId: z.number().int().optional(),
        }),
      ),
    })
    .optional(),
});

export type JsonReport = z.infer<typeof reportSchema>;

export function toJsonReport(result: AnalysisResult, opts: { includeGraph?: boolean } = {}): JsonReport {
  return {
    $schema: schemaUrl('report'),
    meta: { ...result.meta, durationMs: result.durationMs },
    summary: result.summary,
    findings: result.findings,
    suppressed: result.suppressed,
    ...(result.contracts
      ? {
          contracts: {
            drift: result.contracts.drift,
            breaking: result.contracts.breaking,
            counts: result.contracts.counts,
            // File contents are omitted; use `flowpact generate --dry-run` or the patch for those.
            entries: result.contracts.entries.map(({ before: _b, after: _a, ...e }) => e),
          },
        }
      : {}),
    ...(result.impact
      ? {
          impact: {
            baseline: result.impact.baseline,
            required: result.impact.verdict.required,
            ...(result.impact.verdict.declared ? { declared: result.impact.verdict.declared } : {}),
            ok: result.impact.verdict.ok,
            changes: result.impact.changes,
          },
        }
      : {}),
    rules: result.rules,
    ...(opts.includeGraph ? { graph: result.index.toJSON() } : {}),
  };
}

export function reportJsonSchema(): Record<string, unknown> {
  return { $id: schemaUrl('report'), title: 'flowpact report', ...z.toJSONSchema(reportSchema) };
}
