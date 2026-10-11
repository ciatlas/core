import { loadProject, memoryFileSystem, type Project, ProjectIndex } from '@flowpact/core';

/** Strips the common leading indentation so YAML can be written inline in tests. */
export function yaml(strings: TemplateStringsArray, ...values: unknown[]): string {
  const raw = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '');
  const lines = raw.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return `${lines.map((l) => l.slice(indent)).join('\n')}\n`;
}

export const WF = '.github/workflows';

export interface LoadOptions {
  repository?: string;
  paths?: string[];
  publish?: string[];
  validateSchema?: boolean;
}

/** Loads a repository from in-memory files the way the linter does (schema validation on), without running any rule. */
export function load(
  files: Record<string, string>,
  opts: LoadOptions = {},
): { project: Project; index: ProjectIndex } {
  const project = loadProject({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    repository: opts.repository ?? 'acme/repo',
    validateSchema: opts.validateSchema ?? true,
    ...(opts.paths ? { paths: opts.paths } : {}),
    ...(opts.publish ? { publish: opts.publish } : {}),
  });
  return { project, index: new ProjectIndex(project) };
}
