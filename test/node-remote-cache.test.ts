/**
 * Remote sources kept in a directory (ported from flowpact's `remotes-cache.test.ts`): where a file goes, which paths it
 * refuses, how it writes and reads bytes, and how it prunes.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  directoryRemoteCache,
  fetchRemoteSourceAt,
  parseRemoteRef,
  pruneRemoteCache,
  type RemoteSourceKey,
  remoteCachePath,
} from '@ciatlas/core';
import { afterEach, describe, expect, it } from 'vitest';

const SHA = (c: string) => c.repeat(40);
const KEY: RemoteSourceKey = {
  host: 'github.com',
  owner: 'octo',
  repo: 'ship',
  sha: SHA('a'),
  file: 'action.yml',
};
const bytes = (s: string) => new TextEncoder().encode(s);
const posix = process.platform !== 'win32';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'core-cache-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('remoteCachePath', () => {
  const dir = join('/cache', 'remotes');

  it('keeps a file by host, owner, repository, commit and path', () => {
    expect(remoteCachePath(dir, { ...KEY, file: '.github/workflows/Deploy.yml' })).toBe(
      join(dir, 'github.com', 'octo', 'ship', SHA('a'), '.github', 'workflows', 'Deploy.yml'),
    );
    expect(remoteCachePath(dir, { ...KEY, host: 'ghes.example' })).toBe(
      join(dir, 'ghes.example', 'octo', 'ship', SHA('a'), 'action.yml'),
    );
    // Host, owner, repository and commit in lower case, as GitHub matches them; the file as the repository names it.
    expect(
      remoteCachePath(dir, { host: 'GitHub.com', owner: 'Octo', repo: 'Ship', sha: SHA('A'), file: 'A.yml' }),
    ).toBe(join(dir, 'github.com', 'octo', 'ship', SHA('a'), 'A.yml'));
  });

  it('refuses a file that could leave the directory or is no file name on every platform', () => {
    for (const file of [
      '../../../etc/passwd',
      'a/../../b',
      '..',
      './action.yml',
      'a//action.yml',
      '/etc/passwd',
      'action.yml/',
      'C:/x/action.yml',
      'a\\..\\b/action.yml',
      'a\u0000b/action.yml',
      'action.yml\u0000.txt',
      'con/action.yml',
      'LPT1.txt/action.yml',
      'dir./action.yml',
      'dir /action.yml',
      'a\u0001b/action.yml',
      'a|b/action.yml',
      '',
    ])
      expect(remoteCachePath(dir, { ...KEY, file }), JSON.stringify(file)).toBeUndefined();
  });

  it('refuses a host, owner, repository or commit that is not one safe name', () => {
    for (const host of ['..', '.', '', 'ghes.example:8443', 'a/b', '/abs', 'a\u0000b'])
      expect(remoteCachePath(dir, { ...KEY, host }), host).toBeUndefined();
    expect(remoteCachePath(dir, { ...KEY, owner: '..' })).toBeUndefined();
    expect(remoteCachePath(dir, { ...KEY, owner: 'a/..' })).toBeUndefined();
    expect(remoteCachePath(dir, { ...KEY, repo: '.' })).toBeUndefined();
    expect(remoteCachePath(dir, { ...KEY, repo: 'x\\..' })).toBeUndefined();
    expect(remoteCachePath(dir, { ...KEY, sha: 'v1' })).toBeUndefined();
    expect(remoteCachePath(dir, { ...KEY, sha: SHA('g') })).toBeUndefined();
    expect(remoteCachePath(dir, { ...KEY, sha: `../${SHA('a').slice(3)}` })).toBeUndefined();
  });
});

describe('directoryRemoteCache', () => {
  it('writes bytes once, read-only, and reads the same bytes back', () => {
    const dir = tempDir();
    const cache = directoryRemoteCache(dir);
    const key = { ...KEY, file: 'setup/action.yaml' };
    // A byte order mark and bytes that are not UTF-8: kept as served, for the fetcher's digest.
    const served = new Uint8Array([0xef, 0xbb, 0xbf, 0x6e, 0x3a, 0xff, 0x0a]);
    expect(cache.get(key)).toBeUndefined();
    expect(cache.locate(key)).toBeUndefined();
    expect(cache.write(key, served)).toBe('written');
    expect(cache.get(key)).toEqual(served);
    const path = cache.locate(key)!;
    expect(path).toBe(join(dir, 'github.com', 'octo', 'ship', SHA('a'), 'setup', 'action.yaml'));
    if (posix) {
      // Read-only, and for your user alone: private repositories' files land here too.
      expect(statSync(path).mode & 0o777).toBe(0o400);
      expect(statSync(join(dir, 'github.com')).mode & 0o077).toBe(0);
    }
    expect(cache.write(key, bytes('other'))).toBe('present');
    cache.set(key, bytes('other'));
    expect(cache.get(key)).toEqual(served);
    expect(readdirSync(join(dir, 'github.com', 'octo', 'ship', SHA('a'), 'setup'))).toEqual(['action.yaml']);
  });

  it('keeps the same file of the same commit apart by host', () => {
    const cache = directoryRemoteCache(tempDir());
    cache.set(KEY, bytes('github.com'));
    cache.set({ ...KEY, host: 'ghes.example' }, bytes('ghes'));
    expect(new TextDecoder().decode(cache.get(KEY))).toBe('github.com');
    expect(new TextDecoder().decode(cache.get({ ...KEY, host: 'ghes.example' }))).toBe('ghes');
    expect(cache.get({ ...KEY, host: 'other.example' })).toBeUndefined();
  });

  it('matches the file in its case, also where the file system does not', () => {
    const cache = directoryRemoteCache(tempDir());
    const upper = { ...KEY, file: '.github/workflows/Deploy.yml' };
    const lower = { ...KEY, file: '.github/workflows/deploy.yml' };
    cache.set(upper, bytes('upper'));
    expect(cache.get(lower)).toBeUndefined();
    expect(cache.locate(lower)).toBeUndefined();
    // Kept apart where the file system tells the two apart; not kept (a miss each time) where it cannot.
    const outcome = cache.write(lower, bytes('lower'));
    expect(new TextDecoder().decode(cache.get(upper))).toBe('upper');
    if (outcome === 'written') expect(new TextDecoder().decode(cache.get(lower))).toBe('lower');
    else {
      expect(outcome).toEqual({
        failed: `${lower.file} is taken by another name, a link or one in another case`,
      });
      expect(cache.get(lower)).toBeUndefined();
    }
  });

  it('refuses an unsafe path, and says why it could not write, without throwing', () => {
    const dir = tempDir();
    const cache = directoryRemoteCache(dir);
    expect(cache.write({ ...KEY, file: '../../x.yml' }, bytes('x'))).toBe('unsafe');
    expect(cache.write({ ...KEY, host: '..' }, bytes('x'))).toBe('unsafe');
    expect(cache.get({ ...KEY, file: '../../x.yml' })).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    // A file where the host's directory would go.
    writeFileSync(join(dir, 'github.com'), '');
    expect(cache.write(KEY, bytes('x'))).toEqual({ failed: expect.any(String) });
    expect(cache.get(KEY)).toBeUndefined();
    // A directory that cannot be created at all.
    expect(directoryRemoteCache(join(dir, 'github.com', 'below')).write(KEY, bytes('x'))).toEqual({
      failed: expect.any(String),
    });
  });

  it.runIf(posix)('reads no file through a link someone put in the cache', () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, 'secret'), 'secret');
    const at = join(dir, 'github.com', 'octo', 'ship', SHA('a'));
    mkdirSync(at, { recursive: true });
    symlinkSync(join(outside, 'secret'), join(at, 'action.yml'));
    const cache = directoryRemoteCache(dir);
    expect(cache.get(KEY)).toBeUndefined();
    expect(cache.locate(KEY)).toBeUndefined();
    expect(cache.write(KEY, bytes('x'))).toEqual({ failed: expect.stringContaining('a link') });
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('secret');
  });

  it("serves the fetcher: what it read once is read from the directory, by another process's cache too", async () => {
    const dir = tempDir();
    const ref = parseRemoteRef('Octo/Setup@v1', 'action')!;
    const served: string[] = [];
    const fetch = async (url: string) => {
      served.push(url);
      return new Response('runs:\n  using: node24\n');
    };
    const first = await fetchRemoteSourceAt(ref, SHA('b'), { fetch, cache: directoryRemoteCache(dir) });
    expect(served).toHaveLength(1);
    expect(existsSync(join(dir, 'github.com', 'octo', 'setup', SHA('b'), 'action.yml'))).toBe(true);
    const offline = async (): Promise<Response> => {
      throw new Error('offline');
    };
    const again = await fetchRemoteSourceAt(ref, SHA('b'), {
      fetch: offline,
      cache: directoryRemoteCache(dir),
      expectDigest: first.digest,
    });
    expect(again).toEqual(first);
  });
});

describe('pruneRemoteCache', () => {
  /** A cache with github.com octo/ship at commits 1–4 used in that order (4 last), and octo/setup at 5 (used first). */
  function seeded() {
    const dir = tempDir();
    const cache = directoryRemoteCache(dir);
    let t = 1_700_000_000;
    for (const c of ['5', '1', '2', '3', '4']) {
      const repo = c === '5' ? 'setup' : 'ship';
      cache.set({ ...KEY, repo, sha: SHA(c) }, bytes(c.repeat(10)));
      const at = new Date(++t * 1000);
      utimesSync(join(dir, 'github.com', 'octo', repo, SHA(c)), at, at);
    }
    return dir;
  }
  const left = (dir: string, repo = 'ship') => readdirSync(join(dir, 'github.com', 'octo', repo)).sort();

  it('keeps the most recently used commits of each repository', () => {
    const dir = seeded();
    expect(pruneRemoteCache(dir, { keepCommits: 2 })).toEqual({ removed: 2, bytes: 30 });
    expect(left(dir)).toEqual([SHA('3'), SHA('4')]);
    expect(left(dir, 'setup')).toEqual([SHA('5')]);
  });

  it('removes the least recently used commits, across repositories, until under the size', () => {
    const dir = seeded();
    expect(pruneRemoteCache(dir, { maxBytes: 25 })).toEqual({ removed: 3, bytes: 20 });
    expect(left(dir)).toEqual([SHA('3'), SHA('4')]);
    expect(existsSync(join(dir, 'github.com', 'octo', 'setup'))).toBe(false);
    expect(pruneRemoteCache(dir, { maxBytes: 20 })).toEqual({ removed: 0, bytes: 20 });
  });

  it('never removes a commit kept, and counts it', () => {
    const dir = seeded();
    const keep = (c: { repo: string; sha: string }) => c.sha === SHA('1') || c.repo === 'setup';
    expect(pruneRemoteCache(dir, { keepCommits: 1, maxBytes: 0, keep })).toEqual({ removed: 3, bytes: 20 });
    expect(left(dir)).toEqual([SHA('1')]);
    expect(left(dir, 'setup')).toEqual([SHA('5')]);
  });

  it('marks a commit as used when it reads it, so it outlives the ones not used since', () => {
    const dir = seeded();
    expect(directoryRemoteCache(dir).get({ ...KEY, sha: SHA('1') })).toBeDefined();
    pruneRemoteCache(dir, { keepCommits: 1 });
    expect(left(dir)).toEqual([SHA('1')]);
  });

  it('empties the cache with 0, removing empty directories, and leaves what it did not put there', () => {
    const dir = seeded();
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    mkdirSync(join(dir, 'github.com', 'octo', 'ship', 'not-a-commit'));
    const outside = tempDir();
    mkdirSync(join(outside, SHA('9')));
    writeFileSync(join(outside, SHA('9'), 'keep.txt'), 'keep');
    symlinkSync(join(outside, SHA('9')), join(dir, 'github.com', 'octo', 'setup', SHA('9')), 'dir');
    expect(pruneRemoteCache(dir, { keepCommits: 0 })).toEqual({ removed: 5, bytes: 0 });
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(readdirSync(join(dir, 'github.com', 'octo', 'ship'))).toEqual(['not-a-commit']);
    // The link is not a cached commit: neither it nor what it points at is touched.
    expect(readFileSync(join(outside, SHA('9'), 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'github.com', 'octo', 'setup', SHA('9')))).toBe(true);
    expect(pruneRemoteCache(join(dir, 'missing'), { keepCommits: 0 })).toEqual({ removed: 0, bytes: 0 });
  });

  it('measures the files of nested directories, without following links', () => {
    const dir = tempDir();
    const cache = directoryRemoteCache(dir);
    cache.set({ ...KEY, file: '.github/workflows/a.yml' }, bytes('12345'));
    cache.set({ ...KEY, file: 'action.yml' }, bytes('123'));
    if (posix) symlinkSync('/etc/hosts', join(dir, 'github.com', 'octo', 'ship', SHA('a'), 'link'));
    expect(pruneRemoteCache(dir, {})).toEqual({ removed: 0, bytes: 8 });
  });
});

describe('directoryRemoteCache over its size', () => {
  it('prunes the least recently used commits after a write, never one it used', () => {
    const dir = tempDir();
    const old = directoryRemoteCache(dir);
    let t = 1_700_000_000;
    for (const c of ['1', '2', '3']) {
      old.set({ ...KEY, sha: SHA(c) }, bytes('x'.repeat(10)));
      const at = new Date(++t * 1000);
      utimesSync(join(dir, 'github.com', 'octo', 'ship', SHA(c)), at, at);
    }
    const cache = directoryRemoteCache(dir, { maxBytes: 25 });
    // Read, so used: kept although it is the oldest.
    expect(cache.get({ ...KEY, sha: SHA('1') })).toBeDefined();
    expect(cache.write({ ...KEY, sha: SHA('4') }, bytes('x'.repeat(10)))).toBe('written');
    expect(readdirSync(join(dir, 'github.com', 'octo', 'ship')).sort()).toEqual([SHA('1'), SHA('4')]);
    // The size is counted from there: the next write over it prunes again.
    expect(cache.write({ ...KEY, sha: SHA('5') }, bytes('x'.repeat(4)))).toBe('written');
    expect(readdirSync(join(dir, 'github.com', 'octo', 'ship')).sort()).toEqual([
      SHA('1'),
      SHA('4'),
      SHA('5'),
    ]);
    expect(cache.write({ ...KEY, repo: 'other', sha: SHA('6') }, bytes('x'))).toBe('written');
    expect(readdirSync(join(dir, 'github.com', 'octo', 'ship')).sort()).toEqual([
      SHA('1'),
      SHA('4'),
      SHA('5'),
    ]);
  });
});
