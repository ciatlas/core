import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject as loadOnNode } from '../src/index';
import { loadProject, memoryFileSystem } from '../src/index.browser';

const SRC = resolve(import.meta.dirname, '../src');

/** Every module the browser entry reaches through relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^(?:import|export)[^'"]*from\s+'(\.[^']+)'/gm)) {
      const target = join(dirname(file), m[1]!);
      queue.push(target.endsWith('.ts') ? target : `${target}.ts`);
    }
  }
  return seen;
}

describe('the browser entry', () => {
  it('reaches no module that imports a Node built-in', () => {
    const files = reachable(join(SRC, 'index.browser.ts'));
    expect(files.size).toBeGreaterThan(10);
    const offenders = [...files].filter((f) => /from\s+'node:/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
    expect([...files].some((f) => f.endsWith('/git.ts') || f.endsWith('/node-fs.ts'))).toBe(false);
  });

  it('loads the files it is given and names its targets by repository-relative paths', () => {
    const files = {
      '.github/workflows/ci.yml':
        'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/x\n',
      '.github/actions/x/action.yml':
        'name: x\nruns:\n  using: composite\n  steps:\n    - run: echo\n      shell: bash\n',
    };
    const project = loadProject({
      root: '.',
      fs: memoryFileSystem(files),
      paths: ['./.github/workflows/ci.yml', '.github/actions'],
      validateSchema: false,
    });
    expect([...project.workflows.keys()]).toEqual(['.github/workflows/ci.yml']);
    expect([...project.actions.keys()]).toEqual(['.github/actions/x']);
    expect([...project.targets]).toEqual(['.github/workflows/ci.yml', '.github/actions/x/action.yml']);
    expect(project.missingTargets).toEqual([]);
  });

  it('refuses to load without a file system, while the Node entry reads the disk', () => {
    expect(() => loadProject({ root: '.' })).toThrow(/needs a file system here: pass fs/);
    const onDisk = loadOnNode({
      root: resolve(import.meta.dirname, 'fixtures/checknames-lab'),
      validateSchema: false,
    });
    expect(onDisk.workflows.size).toBeGreaterThan(0);
  });
});
