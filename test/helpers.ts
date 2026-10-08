import {
  type AnalysisResult,
  analyze,
  createLogger,
  type Finding,
  memoryFileSystem,
  memorySink,
  parseConfig,
} from '@wfc/core';

/** Strips the common leading indentation so YAML can be written inline in tests. */
export function yaml(strings: TemplateStringsArray, ...values: unknown[]): string {
  const raw = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '');
  const lines = raw.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return `${lines.map((l) => l.slice(indent)).join('\n')}\n`;
}

export interface LintOptions {
  config?: Record<string, unknown>;
  only?: string[];
  paths?: string[];
  schema?: boolean;
  repository?: string;
}

export function lint(
  files: Record<string, string>,
  opts: LintOptions = {},
): AnalysisResult & { logs: ReturnType<typeof memorySink>['records'] } {
  const sink = memorySink();
  const result = analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    config: parseConfig(opts.config ?? {}),
    validateSchema: opts.schema ?? false,
    repository: opts.repository ?? 'acme/repo',
    logger: createLogger({ level: 'trace', sink }),
    ...(opts.only ? { only: opts.only } : {}),
    ...(opts.paths ? { paths: opts.paths } : {}),
  });
  return Object.assign(result, { logs: sink.records });
}

export const codes = (r: { findings: Finding[] }) => r.findings.map((f) => f.code);
export const byCode = (r: { findings: Finding[] }, code: string) => r.findings.filter((f) => f.code === code);
export const at = (f: Finding) => `${f.loc.file}:${f.loc.line}:${f.loc.column}`;

export const WF = '.github/workflows';
