import { reportJsonSchema, reportSchema, toJsonReport } from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { lint, WF } from './helpers';

describe('JSON report', () => {
  const r = lint({
    [`${WF}/a.yml`]:
      'on:\n  workflow_dispatch:\n    inputs:\n      dead: {}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
  });

  it('validates against the published schema, with and without the graph', () => {
    expect(reportSchema.safeParse(toJsonReport(r)).success).toBe(true);
    const withGraph = toJsonReport(r, { includeGraph: true });
    expect(reportSchema.safeParse(withGraph).error).toBeUndefined();
    expect(withGraph.graph?.nodes.length).toBeGreaterThan(0);
  });

  it('round-trips through JSON', () => {
    const json = JSON.parse(JSON.stringify(toJsonReport(r)));
    expect(reportSchema.parse(json).findings[0]?.code).toBe('FP104');
    expect(json.meta.version).toBeDefined();
    expect(json.$schema).toBe('https://rumankazi.github.io/flowpact/schemas/report/v1.json');
  });

  it('exports a JSON schema', () => {
    expect(JSON.stringify(reportJsonSchema())).toContain('fingerprint');
  });
});
