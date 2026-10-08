import { describe, expect, it } from 'vitest';
import { scriptWrites, writesTo } from '../src/script-writes';

const writes = (script: string) => scriptWrites(script).map((w) => `${w.command} ${w.path}`);

describe('scriptWrites', () => {
  it('finds the destinations of copies, moves and links, and what they receive by name', () => {
    expect(writes('cp -r tools/act ./dist/act')).toEqual(['cp dist/act', 'cp dist/act/act']);
    expect(writes('mv -f a b c/')).toEqual(['mv c', 'mv c/a', 'mv c/b']);
    expect(writes('ln -sf ../shared/act vendor/act')).toEqual(['ln vendor/act', 'ln vendor/act/act']);
    expect(writes('cp -t dist/ tools/act')).toEqual(['cp dist', 'cp dist/act']);
    expect(writes('rsync -a --delete tools/act/ "$GITHUB_WORKSPACE/out"')).toEqual([
      'rsync out',
      'rsync out/act',
    ]);
    expect(writes('Copy-Item -Path tools\\act -Destination dist\\act -Recurse')).toEqual([
      'copy-item dist/act',
    ]);
  });

  it('finds created directories and files, clones, extractions, downloads and redirections', () => {
    expect(
      writes(`
        mkdir -p dist/a dist/b
        git clone --depth 1 -b main https://github.com/acme/tools.git vendor/tools
        git clone https://github.com/acme/other.git
        git -C vendor worktree add base main
        tar -xzf a.tgz -C unpacked
        unzip -q a.zip -d unzipped
        curl -sSL -o dl/action.yml https://example.com/action.yml
        echo "runs:" > gen/action.yml 2>&1
        echo x | tee -a log/out.txt >/dev/null
      `),
    ).toEqual([
      'mkdir dist/a',
      'mkdir dist/b',
      'git clone vendor/tools',
      'git clone other',
      'git worktree add vendor/base',
      'tar unpacked',
      'unzip unzipped',
      'curl dl/action.yml',
      '> gen/action.yml',
      'tee log/out.txt',
    ]);
  });

  it('only reads paths, not mentions, and skips what it cannot place', () => {
    expect(writes('ls .github/actions/biuld || true')).toEqual([]);
    expect(writes('echo "./.github/actions/biuld is fine"')).toEqual([]);
    expect(writes('cat .github/actions/x/action.yml # cp a b')).toEqual([]);
    // Variables, globs, absolute paths and paths outside the workspace are not places in the workspace.
    expect(writes('cp a "$DEST" && cp b /tmp/x && cp c ../up && cp d ${{ inputs.dir }}')).toEqual([]);
    expect(writes('mkdir -p "${{ github.workspace }}/gen"')).toEqual(['mkdir gen']);
  });

  it('follows cd, and loses track after a cd it cannot follow', () => {
    expect(
      writes('cd tools && cp -r act ../dist/act\ncd "$RUNNER_TEMP"\nmkdir lost\ncd\nmkdir found'),
    ).toEqual(['cp dist/act', 'cp dist/act/act', 'mkdir found']);
    expect(writes('pushd sub\nmkdir a\npopd\nmkdir b')).toEqual(['mkdir sub/a', 'mkdir b']);
  });

  it('skips heredoc bodies and joins continued lines', () => {
    expect(
      writes("cat > gen/action.yml <<'EOF'\ncp -r nothing here\nEOF\ncp -r tools/act \\\n  dist/act"),
    ).toEqual(['> gen/action.yml', 'cp dist/act', 'cp dist/act/act']);
  });

  it('looks past prefixes and xargs to the command', () => {
    expect(writes('sudo -E mkdir -p /opt/x out')).toEqual(['mkdir out']);
    expect(writes('FOO=1 env BAR=2 cp a b')).toEqual(['cp b', 'cp b/a']);
    expect(writes('find . -name "*.yml" | xargs -I {} cp {} staged/')).toEqual(['cp staged']);
    expect(writes('if cp -r a out; then echo ok; fi')).toEqual(['cp out', 'cp out/a']);
  });
});

describe('writesTo', () => {
  const isRepoDir = (dir: string) => dir === '.github' || dir === 'tools';
  const w = (path: string) => ({ path, command: 'cp' });

  it('matches the path, a file inside it, or a directory holding it', () => {
    expect(writesTo(w('dist/act'), 'dist/act', isRepoDir)).toBe(true);
    expect(writesTo(w('dist/act/action.yml'), 'dist/act', isRepoDir)).toBe(true);
    expect(writesTo(w('dist'), 'dist/act', isRepoDir)).toBe(true);
    expect(writesTo(w('dister'), 'dist', isRepoDir)).toBe(false);
  });

  it('does not let a directory of the repository, or the workspace root, excuse every path in it', () => {
    expect(writesTo(w('.github'), '.github/actions/biuld', isRepoDir)).toBe(false);
    expect(writesTo(w('.github/act'), '.github/act', isRepoDir)).toBe(true);
    expect(writesTo(w('.'), 'dist/act', isRepoDir)).toBe(false);
    expect(writesTo(w('dist'), '.', isRepoDir)).toBe(false);
  });
});
