/** What a git dependency on this repository (`github:ciatlas/core#vX.Y.Z`) installs. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  private?: boolean;
  scripts?: Record<string, string>;
  exports: Record<string, Record<string, unknown>>;
  files: string[];
};

describe('package manifest', () => {
  it('runs nothing on install: pnpm refuses a git dependency that needs a build script', () => {
    for (const hook of [
      'preinstall',
      'install',
      'postinstall',
      'prepare',
      'preprepare',
      'postprepare',
      'prepack',
    ])
      expect(manifest.scripts?.[hook], hook).toBeUndefined();
  });

  it('ships its TypeScript source, which consumers bundle with the `source` condition', () => {
    expect(manifest.exports['.']).toEqual({
      browser: { source: './src/index.browser.ts', types: './src/index.browser.ts' },
      source: './src/index.ts',
      types: './src/index.ts',
    });
    expect(manifest.exports['./browser']).toEqual({
      source: './src/index.browser.ts',
      types: './src/index.browser.ts',
    });
    expect(manifest.files).toEqual(['src']);
  });

  it('is never published to npm', () => {
    expect(manifest.private).toBe(true);
  });
});
