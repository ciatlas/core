/**
 * A directory cache when another process renames the same file first, as two processes on Windows can (ported from
 * flowpact's `remotes-cache-race.test.ts`): no error, no change, no temporary file left.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryRemoteCache } from '@ciatlas/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `renameSync` as Windows answers a rename onto a file another process has just written: that file is there, and EPERM.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const renameSync = (from: string, to: string) => {
    fs.writeFileSync(to, 'name: first\n', { mode: 0o400 });
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), {
      code: 'EPERM',
    });
  };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});

const SHA = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('directoryRemoteCache racing another process', () => {
  it('finds the file the other process wrote, keeps it, and leaves no temporary file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-race-'));
    dirs.push(dir);
    const cache = directoryRemoteCache(dir);
    const key = { host: 'github.com', owner: 'octo', repo: 'setup', sha: SHA, file: 'action.yml' };
    expect(cache.write(key, new TextEncoder().encode('name: second\n'))).toBe('present');
    expect(readFileSync(cache.locate(key)!, 'utf8')).toBe('name: first\n');
    expect(readdirSync(join(dir, 'github.com', 'octo', 'setup', SHA))).toEqual(['action.yml']);
  });
});
