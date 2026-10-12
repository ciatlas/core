import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ACTIONS_DIR,
  createLogger,
  detectRepository,
  type FileSystem,
  insideRepository,
  loadProject,
  memoryFileSystem,
  memorySink,
  nodeFileSystem,
  overlayFileSystem,
  type Project,
  WORKFLOWS_DIR,
} from '@ciatlas/core';
import { afterAll, describe, expect, it } from 'vitest';
import { load, WF, yaml } from './helpers';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flowpact-core-project-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let dirs = 0;
/** A new directory under the test's temporary directory, with `files` written into it. */
function disk(files: Record<string, string> = {}): string {
  const root = join(tmp, `repo-${++dirs}`);
  mkdirSync(root, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const PLAIN = yaml`
  name: p
  description: d
  runs:
    using: composite
    steps:
      - run: echo hi
        shell: bash
`;
const composite = (...uses: string[]) =>
  `name: c\ndescription: d\nruns:\n  using: composite\n  steps:\n${uses.map((u) => `    - uses: ${u}\n`).join('')}`;
const JOB = 'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo hi\n';

const keys = (m: Map<string, unknown>) => [...m.keys()];
const missing = (p: Project) =>
  p.missing.map((m) => [m.from, m.job ?? null, m.step ?? null, m.uses.kind, m.target ?? m.uses.target]);
const invalid = (p: Project) =>
  (p.invalidTargets ?? []).map((m) => [m.from, m.job ?? null, m.step ?? null, m.reason, m.uses.raw]);

describe('loadProject: what it loads', () => {
  it('discovers workflows directly in .github/workflows, actions under .github/actions, and the root action', () => {
    const { project } = load({
      [`${WF}/b.yml`]: JOB,
      [`${WF}/a.yaml`]: JOB,
      [`${WF}/C.YML`]: JOB,
      [`${WF}/sub/nested.yml`]: JOB,
      [`${WF}/README.md`]: '# workflows',
      '.github/actions/x/action.yml': PLAIN,
      '.github/actions/deep/y/action.yaml': PLAIN,
      '.github/actions/x/notes.yml': 'not: an action',
      '.github/dependabot.yml': 'version: 2',
      'action.yml': PLAIN,
      'tools/unused/action.yml': PLAIN,
    });
    expect(keys(project.workflows)).toEqual([`${WF}/C.YML`, `${WF}/a.yaml`, `${WF}/b.yml`]);
    expect(keys(project.actions)).toEqual(['.github/actions/deep/y', '.github/actions/x', '.']);
    expect(project.actions.get('.github/actions/deep/y')!.file).toBe('.github/actions/deep/y/action.yaml');
    expect(project.actions.get('.')!.file).toBe('action.yml');
    expect(project).toMatchObject({
      root: '/virtual/repo',
      repository: 'acme/repo',
      missingTargets: [],
      ignoredTargets: [],
      missing: [],
      invalidTargets: [],
      unverified: [],
    });
    expect(project.targets.size).toBe(0);
    expect(project.wholeRepository).toBeUndefined();
    expect(WORKFLOWS_DIR).toBe(WF);
    expect(ACTIONS_DIR).toBe('.github/actions');
  });

  it('loads a root action.yaml, and no repository when none is given', () => {
    const project = loadProject({ root: '/r', fs: memoryFileSystem({ 'action.yaml': PLAIN }) });
    expect(project.actions.get('.')!.file).toBe('action.yaml');
    expect('repository' in project).toBe(false);
  });

  it('follows local references to actions outside .github/actions, through composite actions', () => {
    const { project, index } = load({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: ./tools/outer
              - uses: ./
      `,
      'tools/outer/action.yml': composite('./tools/inner'),
      'tools/inner/action.yaml': PLAIN,
      'action.yml': PLAIN,
      'tools/unused/action.yml': PLAIN,
    });
    expect(keys(project.actions).sort()).toEqual(['.', 'tools/inner', 'tools/outer']);
    expect(index.usersOf('tools/inner').map((u) => u.unit.path)).toEqual(['tools/outer']);
    expect(index.usersOf('.').map((u) => u.step.index)).toEqual([1]);
    expect(project.missing).toEqual([]);
  });

  it('resolves reusable workflow calls, and lists the ones that are missing or that GitHub rejects', () => {
    const { project, index } = load({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          local:
            uses: ./.github/workflows/lib.yml
          same-repo:
            uses: acme/repo/.github/workflows/lib.yml@main
          self:
            uses: $/.github/workflows/lib.yml
          upper:
            uses: ./.github/workflows/upper.YML
          remote:
            uses: other/repo/.github/workflows/x.yml@v1
          gone:
            uses: ./.github/workflows/gone.yml
          at-ref:
            uses: acme/repo/.github/workflows/only-on-main.yml@main
          outside:
            uses: ./tools/flow.yml
          nested:
            uses: ./.github/workflows/sub/flow.yml
          case:
            uses: ./.GitHub/workflows/lib.yml
          pinned-self:
            uses: $/.github/workflows/lib.yml@main
      `,
      [`${WF}/lib.yml`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
      [`${WF}/upper.YML`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
      'tools/flow.yml': 'on: workflow_call\njobs: {}\n',
      [`${WF}/sub/flow.yml`]: 'on: workflow_call\njobs: {}\n',
    });
    expect(index.callSites.map((c) => `${c.job.id} → ${c.callee.path}`)).toEqual([
      `local → ${WF}/lib.yml`,
      `same-repo → ${WF}/lib.yml`,
      `self → ${WF}/lib.yml`,
      `upper → ${WF}/upper.YML`,
    ]);
    // `owner/repo/...@ref` of this repository may exist at that ref, so only the local path is missing.
    expect(missing(project)).toEqual([[`${WF}/w.yml`, 'gone', null, 'local-workflow', `${WF}/gone.yml`]]);
    expect(invalid(project)).toEqual([
      [`${WF}/w.yml`, 'outside', null, 'not-callable', './tools/flow.yml'],
      [`${WF}/w.yml`, 'nested', null, 'not-callable', './.github/workflows/sub/flow.yml'],
      [`${WF}/w.yml`, 'case', null, 'not-callable', './.GitHub/workflows/lib.yml'],
      [`${WF}/w.yml`, 'pinned-self', null, 'self-ref', '$/.github/workflows/lib.yml@main'],
    ]);
    // Invalid targets are not loaded.
    expect(keys(project.workflows).sort()).toEqual([`${WF}/lib.yml`, `${WF}/upper.YML`, `${WF}/w.yml`]);
  });

  it('lists local actions that do not exist, and `$/` steps with an @ref', () => {
    const { project } = load({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: ./.github/actions/missing
              - uses: $/.github/actions/a@v1
              - uses: ./.github/actions/a
      `,
      '.github/actions/a/action.yml': composite('./.github/actions/also-missing'),
    });
    expect(missing(project)).toEqual([
      [`${WF}/w.yml`, 'j', 0, 'local-action', '.github/actions/missing'],
      ['.github/actions/a', null, 0, 'local-action', '.github/actions/also-missing'],
    ]);
    expect(invalid(project)).toEqual([[`${WF}/w.yml`, 'j', 1, 'self-ref', '$/.github/actions/a@v1']]);
    expect(project.invalidTargets![0]!.uses.selfRef).toBe('v1');
  });

  it('validates each unit against GitHub’s schema unless told not to, except files that are not valid YAML', () => {
    const files = {
      [`${WF}/ok.yml`]: JOB,
      [`${WF}/typo.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: []\n',
      [`${WF}/broken.yml`]: 'on: [push\n',
      '.github/actions/a/action.yml': 'name: a\ndescription: d\nruns:\n  using: composite\n  stepz: []\n',
    };
    const { project } = load(files);
    const errors = (p: Project) =>
      Object.fromEntries(
        [...p.workflows.values(), ...p.actions.values()].map((u) => [u.path, u.schemaErrors.length > 0]),
      );
    expect(errors(project)).toEqual({
      [`${WF}/broken.yml`]: false,
      [`${WF}/ok.yml`]: false,
      [`${WF}/typo.yml`]: true,
      '.github/actions/a': true,
    });
    expect(project.workflows.get(`${WF}/broken.yml`)!.parseErrors.length).toBeGreaterThan(0);
    expect(project.workflows.get(`${WF}/typo.yml`)!.schemaErrors.map((e) => e.loc.line)).toContain(5);
    expect(Object.values(errors(load(files, { validateSchema: false }).project))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('logs what it found and what it could not resolve', () => {
    const sink = memorySink();
    loadProject({
      root: '/virtual/repo',
      fs: memoryFileSystem({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            gone:
              uses: ./.github/workflows/gone.yml
            outside:
              uses: ./tools/flow.yml
            at-ref:
              uses: acme/repo/.github/workflows/x.yml@main
            j:
              runs-on: x
              steps:
                - uses: actions/checkout@v5
                  with: { path: src }
                - uses: ./.github/actions/missing
                - uses: ./.github/actions/a
                - uses: ./shared/x
                - uses: acme/repo/tools/x@main
        `,
        '.github/actions/a/action.yml': PLAIN,
        'docs/x.md': '# x',
      }),
      repository: 'acme/repo',
      paths: ['nope.yml', 'docs/x.md'],
      logger: createLogger({ level: 'debug', sink }),
    });
    const messages = (level: string) => sink.records.filter((r) => r.level === level).map((r) => r.message);
    expect(messages('info')).toContain('discovered 1 workflow(s) and 1 local action(s)');
    expect(messages('warn')).toEqual(
      expect.arrayContaining([
        'paths not found: nope.yml',
        'paths that are not workflows or actions: docs/x.md',
        'unresolved local reference ./.github/workflows/gone.yml',
        'reusable workflow outside .github/workflows: ./tools/flow.yml',
        'unresolved local reference ./.github/actions/missing',
        'local reference outside the workspace ./.github/actions/a',
      ]),
    );
    // A step in a checkout that is not there, and same-repository references at a ref, are only noted for debugging.
    for (const raw of ['./shared/x', 'acme/repo/.github/workflows/x.yml@main', 'acme/repo/tools/x@main']) {
      expect(messages('debug').some((m) => m.includes(raw))).toBe(true);
      expect(messages('warn').some((m) => m.includes(raw))).toBe(false);
    }
    expect(sink.records.find((r) => r.message === 'files')!.data).toEqual({
      workflows: [`${WF}/w.yml`],
      actions: ['.github/actions/a/action.yml'],
    });
    expect(sink.records.find((r) => r.message.startsWith('unresolved'))!.data).toEqual({
      from: `${WF}/w.yml`,
    });
  });
});

describe('loadProject: paths to report on', () => {
  const files = {
    [`${WF}/a.yml`]: JOB,
    [`${WF}/b.yml`]: JOB,
    [`${WF}/sub/c.yml`]: JOB,
    '.github/actions/x/action.yml': PLAIN,
    '.github/dependabot.yml': 'version: 2',
    'tools/t/action.yml': PLAIN,
    'docs/guide.yml': 'title: x',
  };
  const targets = (paths: string[]) => {
    const { project } = load(files, { paths });
    return {
      targets: [...project.targets].sort(),
      missing: project.missingTargets,
      ignored: project.ignoredTargets,
      ...(project.wholeRepository ? { whole: true } : {}),
    };
  };

  it('reports on workflow and action files, given relative or absolute', () => {
    expect(targets([`${WF}/a.yml`, `./${WF}/b.yml`, '/virtual/repo/.github/actions/x/action.yml'])).toEqual({
      targets: ['.github/actions/x/action.yml', `${WF}/a.yml`, `${WF}/b.yml`],
      missing: [],
      ignored: [],
    });
  });

  it('reports on the workflows and actions in a directory, not on other YAML there', () => {
    expect(targets(['.github'])).toEqual({
      targets: ['.github/actions/x/action.yml', `${WF}/a.yml`, `${WF}/b.yml`],
      missing: [],
      ignored: [],
    });
    expect(targets([`${WF}/`]).targets).toEqual([`${WF}/a.yml`, `${WF}/b.yml`]);
  });

  it('loads an action given as a path even when nothing uses it', () => {
    expect(load(files).project.actions.has('tools/t')).toBe(false);
    for (const path of ['tools/t/action.yml', 'tools', 'tools/t']) {
      const { project } = load(files, { paths: [path] });
      expect([...project.targets]).toEqual(['tools/t/action.yml']);
      expect(keys(project.actions)).toEqual(['tools/t', '.github/actions/x']);
    }
  });

  it('reports on the repository’s own action', () => {
    const { project } = load({ ...files, 'action.yaml': PLAIN }, { paths: ['action.yaml'] });
    expect([...project.targets]).toEqual(['action.yaml']);
    expect(project.actions.get('.')!.file).toBe('action.yaml');
  });

  it('lists paths that do not exist or leave the repository, keeping their spelling', () => {
    expect(targets(['nope.yml', '../outside.yml', '/elsewhere/a.yml', `${WF}/a.yml`])).toEqual({
      targets: [`${WF}/a.yml`],
      missing: ['nope.yml', '../outside.yml', '/elsewhere/a.yml'],
      ignored: [],
    });
  });

  it('lists paths that are neither workflows nor actions: other YAML, nested workflows, directories without either', () => {
    expect(targets(['.github/dependabot.yml', `${WF}/sub/c.yml`, 'docs'])).toEqual({
      targets: [],
      missing: [],
      ignored: ['.github/dependabot.yml', `${WF}/sub/c.yml`, 'docs'],
    });
  });

  it('reports on everything when a path is the repository root', () => {
    for (const root of ['.', './', '/virtual/repo', '/virtual/repo/']) {
      expect(targets([root, `${WF}/a.yml`])).toEqual({ targets: [], missing: [], ignored: [], whole: true });
    }
  });
});

describe('loadProject: published actions', () => {
  const files = {
    [`${WF}/w.yml`]: JOB,
    'tools/a/action.yml': PLAIN,
    'tools/b/action.yaml': PLAIN,
    'tools/deep/c/action.yml': composite('./tools/deep/gone'),
    'other/d/action.yml': PLAIN,
    '.github/actions/e/action.yml': PLAIN,
    'action.yml': PLAIN,
    'README.md': '# readme',
  };
  const loaded = (publish: string[]) =>
    keys(load(files, { publish }).project.actions)
      .filter((a) => a !== '.' && a !== '.github/actions/e')
      .sort();
  /** The action files the loader lists in its `files` debug record, sorted. */
  const listed = (publish: string[]) => {
    const sink = memorySink();
    loadProject({
      root: '/virtual/repo',
      fs: memoryFileSystem(files),
      publish,
      validateSchema: false,
      logger: createLogger({ level: 'debug', sink }),
    });
    return (sink.records.find((r) => r.message === 'files')!.data as { actions: string[] }).actions.sort();
  };

  it('loads nothing outside .github/actions that is not used, unless published', () => {
    expect(loaded([])).toEqual([]);
  });

  it.each<[string[], string[]]>([
    [['tools/*'], ['tools/a', 'tools/b']],
    [['tools/**'], ['tools/a', 'tools/b', 'tools/deep/c']],
    [['tools/*/action.yml'], ['tools/a']],
    [['**/action.yml'], ['other/d', 'tools/a', 'tools/deep/c']],
    [['*/d'], ['other/d']],
    [['other/d'], ['other/d']],
    [['other/d/'], ['other/d']],
    [['other/d/action.yml'], ['other/d']],
    [['tools/b/action.yaml'], ['tools/b']],
    [
      ['tools/*', 'other/d'],
      ['other/d', 'tools/a', 'tools/b'],
    ],
  ])('publish %j loads %j', (publish, expected) => {
    expect(loaded(publish)).toEqual(expected);
  });

  it('adds nothing for published paths that are missing, not actions, or under .github/actions', () => {
    expect(listed([])).toEqual(['.github/actions/e/action.yml', 'action.yml']);
    expect(listed(['missing/x', 'missing/*', 'README.md', '.github/actions/e', '.github/actions/*'])).toEqual(
      ['.github/actions/e/action.yml', 'action.yml'],
    );
  });

  // The root action, or an action two patterns match, is listed and counted once in "discovered N local action(s)".
  it('treats `./dir` and `dir` as the same published unit, and keeps .github/actions out either way', () => {
    expect(listed(['tools/b', './tools/b'])).toEqual(listed(['tools/b']));
    expect(listed(['./.github/actions/e'])).toEqual(listed([]));
  });

  it('lists each published action once', () => {
    expect(listed(['action.yml'])).toEqual(['.github/actions/e/action.yml', 'action.yml']);
    expect(listed(['.', './'])).toEqual(['.github/actions/e/action.yml', 'action.yml']);
    expect(listed(['other/*', 'other/d/action.yml'])).toEqual([
      '.github/actions/e/action.yml',
      'action.yml',
      'other/d/action.yml',
    ]);
  });

  // Like a glob matching the same directory.
  it('loads a published directory whose action is action.yaml', () => {
    expect(loaded(['tools/b'])).toEqual(['tools/b']);
    expect(loaded(['tools/b/'])).toEqual(['tools/b']);
  });

  it('resolves a published action’s steps in the assumed workspace', () => {
    const { project } = load(files, { publish: ['tools/deep/*'] });
    expect(missing(project)).toEqual([['tools/deep/c', null, 0, 'local-action', 'tools/deep/gone']]);
  });
});

describe('memoryFileSystem', () => {
  it('reads `./` spellings, and never Object.prototype members', () => {
    const fs = memoryFileSystem({ 'a/x.yml': '1' });
    expect(fs.read('./a/x.yml')).toBe('1');
    expect(['constructor', 'toString', '__proto__'].map((p) => fs.read(p))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  const fs = memoryFileSystem({
    './a/one.yml': '1',
    'a\\two.yml': '2',
    'a/sub/three.yml': '3',
    'top.md': 't',
  });

  it('reads files by repository-relative POSIX path, whatever the spelling of the keys', () => {
    expect(fs.read('a/one.yml')).toBe('1');
    expect(fs.read('a/two.yml')).toBe('2');
    expect(fs.read('a\\two.yml')).toBe('2');
    expect(fs.read('a/missing.yml')).toBeUndefined();
  });

  it('lists the files directly in a directory, walks all below it, and knows directories', () => {
    expect(fs.list('a')).toEqual(['a/one.yml', 'a/two.yml']);
    expect(fs.list('a/sub')).toEqual(['a/sub/three.yml']);
    expect(fs.list('missing')).toEqual([]);
    expect(fs.walk('a')).toEqual(['a/one.yml', 'a/two.yml', 'a/sub/three.yml']);
    expect(fs.walk('.')).toEqual(['a/one.yml', 'a/two.yml', 'a/sub/three.yml', 'top.md']);
    expect(fs.walk('')).toEqual(fs.walk('.'));
    expect(fs.isDir('a')).toBe(true);
    expect(fs.isDir('a/')).toBe(true);
    expect(fs.isDir('a/sub')).toBe(true);
    expect(fs.isDir('a/one.yml')).toBe(false);
    expect(fs.isDir('top.md')).toBe(false);
    expect(fs.isDir('missing')).toBe(false);
  });

  // Like nodeFileSystem and gitFileSystem.
  it('lists the files at the repository root as `.`, and a directory however it is spelled', () => {
    expect(fs.list('.')).toEqual(['top.md']);
    expect(fs.list('')).toEqual(['top.md']);
    expect(fs.isDir('.')).toBe(true);
    expect(fs.list('a/')).toEqual(['a/one.yml', 'a/two.yml']);
    expect(fs.list('./a')).toEqual(['a/one.yml', 'a/two.yml']);
    expect(fs.walk('./a/')).toEqual(fs.walk('a'));
    expect(fs.isDir('./a')).toBe(true);
  });
});

describe('overlayFileSystem', () => {
  const base = memoryFileSystem({
    [`${WF}/a.yml`]: 'disk',
    [`${WF}/only-base.yml`]: 'base',
    '.github/actions/b/action.yml': 'action',
    'README.md': 'readme',
  });
  const fs = overlayFileSystem(
    base,
    new Map([
      [`${WF}/a.yml`, 'buffer'],
      [`./${WF}/new.yml`, 'new'],
      ['notes.md', 'notes'],
      ['drafts\\x.yml', 'draft'],
    ]),
  );

  it('reads unsaved text first and falls back to the base', () => {
    expect(fs.read(`${WF}/a.yml`)).toBe('buffer');
    expect(fs.read(`./${WF}/new.yml`)).toBe('new');
    expect(fs.read(`${WF}/new.yml`)).toBe('new');
    expect(fs.read('drafts/x.yml')).toBe('draft');
    expect(fs.read('.github/actions/b/action.yml')).toBe('action');
    expect(fs.read(`${WF}/only-base.yml`)).toBe('base');
    expect(fs.read(`${WF}/gone.yml`)).toBeUndefined();
  });

  it('lists overlaid files once, next to the base files', () => {
    expect(fs.list(WF).sort()).toEqual([`${WF}/a.yml`, `${WF}/new.yml`, `${WF}/only-base.yml`]);
    // The overlay's own files under other spellings of the directory (and the base's: see below).
    expect(fs.list(`./${WF}/`)).toContain(`${WF}/new.yml`);
    expect(fs.list('.')).toContain('notes.md');
    expect(fs.list('drafts')).toEqual(['drafts/x.yml']);
    expect(fs.walk('.github').sort()).toEqual([
      '.github/actions/b/action.yml',
      `${WF}/a.yml`,
      `${WF}/new.yml`,
      `${WF}/only-base.yml`,
    ]);
    expect(fs.walk('.').sort()).toEqual([
      '.github/actions/b/action.yml',
      `${WF}/a.yml`,
      `${WF}/new.yml`,
      `${WF}/only-base.yml`,
      'README.md',
      'drafts/x.yml',
      'notes.md',
    ]);
    expect(fs.isDir(WF)).toBe(true);
    expect(fs.isDir(`${WF}/`)).toBe(true);
    // A directory only the overlay has.
    expect(fs.isDir('drafts')).toBe(true);
    expect(fs.isDir('.github/other')).toBe(false);
    expect(fs.isDir('notes.md')).toBe(false);
  });

  // Over a memory base as over nodeFileSystem (what production overlays wrap).
  it('lists the base’s files under any spelling of a directory', () => {
    expect(fs.list(`./${WF}/`).sort()).toEqual([`${WF}/a.yml`, `${WF}/new.yml`, `${WF}/only-base.yml`]);
    expect(fs.list('.').sort()).toEqual(['README.md', 'notes.md']);
  });

  it('lets the loader see unsaved files', () => {
    const edited = overlayFileSystem(
      memoryFileSystem({ [`${WF}/a.yml`]: JOB }),
      new Map([[`${WF}/b.yml`, 'on: push\njobs:\n  j:\n    uses: ./.github/workflows/gone.yml\n']]),
    );
    const project = loadProject({ root: '/r', fs: edited, repository: 'acme/repo' });
    expect(keys(project.workflows)).toEqual([`${WF}/a.yml`, `${WF}/b.yml`]);
    expect(missing(project)).toEqual([[`${WF}/b.yml`, 'j', null, 'local-workflow', `${WF}/gone.yml`]]);
  });
});

describe('nodeFileSystem', () => {
  it('walks a directory linked into itself once, and every other link to a directory', () => {
    const root = disk({ '.github/actions/x/action.yml': 'a', 'shared/action.yml': 'b' });
    symlinkSync('.', join(root, '.github/actions/self'));
    symlinkSync('.', join(root, '.github/actions/self2'));
    symlinkSync('../../shared', join(root, '.github/actions/one'));
    symlinkSync('../../shared', join(root, '.github/actions/two'));
    expect(nodeFileSystem(root).walk('.github/actions').sort()).toEqual([
      '.github/actions/one/action.yml',
      '.github/actions/two/action.yml',
      '.github/actions/x/action.yml',
    ]);
  });

  it('bounds linked directories that fan out, keeping the shallowest paths', () => {
    const root = disk({ 'w/F24/f.txt': '24' });
    // 24 levels of directories that each link twice to the next: 2^24 paths if every link were followed.
    for (let i = 0; i < 24; i++) {
      mkdirSync(join(root, `w/F${i}`), { recursive: true });
      writeFileSync(join(root, `w/F${i}`, 'f.txt'), `${i}`);
      symlinkSync(`../F${i + 1}`, join(root, `w/F${i}/a`));
      symlinkSync(`../F${i + 1}`, join(root, `w/F${i}/b`));
    }
    const walked = nodeFileSystem(root).walk('w/F0');
    expect(walked.length).toBeLessThan(5_000);
    expect(walked).toContain('w/F0/a/f.txt');
    expect(walked).toContain('w/F0/b/a/b/f.txt');
  });

  const outside = disk({ 'secret.yml': 'TOP SECRET: [\n', 'dir/x.yml': 'outside' });

  /** A repository on disk with workflows, an action, git internals, dependencies and symlinks in and out. */
  const repo = () => {
    const root = disk({
      [`${WF}/ok.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/x\n',
      '.github/actions/x/action.yml': PLAIN,
      'shared/act/action.yml': PLAIN,
      'node_modules/pkg/action.yml': PLAIN,
      'sub/node_modules/pkg/action.yml': PLAIN,
      '.git/config': '[http]\n  extraheader = AUTHORIZATION: basic c2VjcmV0\n',
      'README.md': 'readme',
    });
    symlinkSync(join(outside, 'secret.yml'), join(root, WF, 'leak.yml'));
    symlinkSync('../../.git/config', join(root, WF, 'git.yml'));
    symlinkSync('ok.yml', join(root, WF, 'alias.yml'));
    symlinkSync(join(outside, 'dir'), join(root, 'out'));
    symlinkSync('shared', join(root, 'linked'));
    return root;
  };

  it('reads files inside the repository, following symlinks that stay inside it', () => {
    const root = repo();
    const fs = nodeFileSystem(root);
    expect(fs.read(`${WF}/ok.yml`)).toBe(readFileSync(join(root, WF, 'ok.yml'), 'utf8'));
    expect(fs.read(`${WF}/alias.yml`)).toBe(fs.read(`${WF}/ok.yml`));
    expect(fs.read('linked/act/action.yml')).toBe(PLAIN);
    expect(fs.read(`./${WF}/ok.yml`)).toBe(fs.read(`${WF}/ok.yml`));
    expect(fs.read(`${WF}/missing.yml`)).toBeUndefined();
    // A directory is not a file.
    expect(fs.read(WF)).toBeUndefined();
  });

  it('never reads through symlinks out of the repository or into .git, nor up out of it', () => {
    const root = repo();
    const fs = nodeFileSystem(root);
    expect(fs.read(`${WF}/leak.yml`)).toBeUndefined();
    expect(fs.read(`${WF}/git.yml`)).toBeUndefined();
    expect(fs.read('.git/config')).toBeUndefined();
    expect(fs.read('out/x.yml')).toBeUndefined();
    expect(fs.isDir('out')).toBe(false);
    expect(fs.list('out')).toEqual([]);
    expect(fs.walk('out')).toEqual([]);
    // `..` leaves the repository even where the file exists.
    expect(fs.read(`../${outside.split('/').at(-1)}/secret.yml`)).toBeUndefined();
    expect(fs.read(`${WF}/../../README.md`)).toBeUndefined();
  });

  // Only a case-insensitive file system (macOS, Windows) opens a path in another case; on Linux there is nothing to
  // check, as the file system already finds nothing.
  const probe = disk({ 'Probe.txt': '' });
  it.runIf(existsSync(join(probe, 'probe.txt')))('reads paths only in their exact case', () => {
    const root = repo();
    for (const path of [`${WF}/OK.yml`, '.GitHub/workflows/ok.yml', '.GITHUB'])
      expect(existsSync(join(root, path)), path).toBe(true);
    const fs = nodeFileSystem(root);
    expect(fs.read(`${WF}/OK.yml`)).toBeUndefined();
    expect(fs.read('.GitHub/workflows/ok.yml')).toBeUndefined();
    expect(fs.isDir('.GITHUB')).toBe(false);
  });

  it('lists the files directly in a directory, and walks all below it except dependencies and git internals', () => {
    const root = repo();
    const fs = nodeFileSystem(root);
    expect(fs.list(WF).sort()).toEqual([`${WF}/alias.yml`, `${WF}/ok.yml`]);
    expect(fs.list('.github')).toEqual([]);
    expect(fs.list('.').sort()).toEqual(['README.md']);
    expect(fs.list('missing')).toEqual([]);
    expect(fs.list('README.md')).toEqual([]);
    expect(fs.walk('.github').sort()).toEqual([
      '.github/actions/x/action.yml',
      `${WF}/alias.yml`,
      `${WF}/ok.yml`,
    ]);
    const all = fs.walk('.');
    expect(all).toEqual(
      expect.arrayContaining([
        '.github/actions/x/action.yml',
        `${WF}/alias.yml`,
        `${WF}/ok.yml`,
        'README.md',
        'shared/act/action.yml',
      ]),
    );
    // Whether a symlinked directory inside the repository is walked into depends on the Node.js version.
    expect(all.filter((f) => !f.startsWith('linked/'))).toHaveLength(5);
    expect(fs.walk('missing')).toEqual([]);
    expect(fs.walk('README.md')).toEqual([]);
    expect(fs.isDir('.github')).toBe(true);
    expect(fs.isDir('linked')).toBe(true);
    expect(fs.isDir('README.md')).toBe(false);
    expect(fs.isDir('missing')).toBe(false);
    expect(fs.isDir('.git')).toBe(false);
  });

  it.runIf(process.getuid?.() !== 0)('does not read a file whose directory cannot be listed', () => {
    const root = disk({ 'locked/a.yml': 'x' });
    chmodSync(join(root, 'locked'), 0o111);
    try {
      // The file can be opened, but its name's case cannot be checked.
      expect(readFileSync(join(root, 'locked/a.yml'), 'utf8')).toBe('x');
      expect(nodeFileSystem(root).read('locked/a.yml')).toBeUndefined();
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });

  it('is what loadProject reads by default', () => {
    const root = repo();
    const project = loadProject({ root, repository: 'a/b' });
    expect(keys(project.workflows).sort()).toEqual([`${WF}/alias.yml`, `${WF}/ok.yml`]);
    expect(keys(project.actions)).toEqual(['.github/actions/x']);
    expect(project.root).toBe(root);
    expect(JSON.stringify([...project.workflows.values()].map((w) => w.source.text))).not.toContain('SECRET');
  });
});

describe('insideRepository', () => {
  const root = disk({ '.github/workflows/a.yml': 'x', '..hidden/a.yml': 'x', '.git/config': 'x' });
  const away = disk({ 'f.yml': 'x' });
  symlinkSync(root, join(away, 'door'));
  symlinkSync(away, join(root, 'exit'));
  symlinkSync(join(root, '.git'), join(root, 'gitdir'));

  it.each([
    ['.', true],
    ['.github/workflows/a.yml', true],
    ['new/dir/not-yet.yml', true],
    ['.git', false],
    ['.git/config', false],
    ['.git/new', false],
    ['gitdir/config', false],
    ['exit/f.yml', false],
    ['exit/new.yml', false],
    ['..', false],
  ])('%s → %s', (path, expected) => {
    expect(insideRepository(root, join(root, path))).toBe(expected);
  });

  // Only `..` as a whole segment leaves it.
  it('keeps a name that starts with `..` inside the repository', () => {
    expect(insideRepository(root, join(root, '..hidden/a.yml'))).toBe(true);
  });

  it('judges the real path, whatever the spelling', () => {
    // Through a symlink outside that points in: inside.
    expect(insideRepository(root, join(away, 'door', 'a.yml'))).toBe(true);
    expect(insideRepository(root, join(away, 'f.yml'))).toBe(false);
    expect(insideRepository(root, `${root}-sibling/a.yml`)).toBe(false);
    // The root itself may be given through a symlink.
    expect(insideRepository(join(away, 'door'), join(root, '.github'))).toBe(true);
  });

  it('accepts a root that does not exist yet, by its resolved path', () => {
    const missingRoot = join(tmp, 'not-created', 'repo');
    expect(insideRepository(missingRoot, join(missingRoot, 'a', 'b.yml'))).toBe(true);
    expect(insideRepository(missingRoot, join(tmp, 'not-created', 'other.yml'))).toBe(false);
  });
});

describe('detectRepository', () => {
  const withConfig = (config: string) => disk({ '.git/config': config });

  it('prefers GITHUB_REPOSITORY', () => {
    const root = withConfig('[remote "origin"]\n\turl = https://github.com/acme/from-config.git\n');
    expect(detectRepository(root, { GITHUB_REPOSITORY: 'acme/from-env' })).toBe('acme/from-env');
    expect(detectRepository(root, { GITHUB_REPOSITORY: '' })).toBe('acme/from-config');
  });

  it('is undefined without GITHUB_REPOSITORY or .git/config', () => {
    expect(detectRepository(disk(), {})).toBeUndefined();
  });

  it.each([
    ['https://github.com/Acme/Repo.git', 'Acme/Repo'],
    ['https://github.com/acme/repo', 'acme/repo'],
    ['git@github.com:acme/repo.git', 'acme/repo'],
    ['ssh://git@github.com/acme/repo.git', 'acme/repo'],
    ['https://x-access-token:t@github.com/acme/repo.git', 'acme/repo'],
    ['https://gitlab.com/acme/repo.git', undefined],
    ['https://github.com/acme', undefined],
  ])('reads origin %s as %s', (url, expected) => {
    const root = withConfig(
      `[core]\n\tbare = false\n[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = ${url}\n[branch "main"]\n\tremote = origin\n`,
    );
    expect(detectRepository(root, {})).toBe(expected);
  });

  it('only reads the origin remote', () => {
    expect(
      detectRepository(withConfig('[remote "upstream"]\n\turl = https://github.com/acme/upstream.git\n'), {}),
    ).toBeUndefined();
    expect(
      detectRepository(
        withConfig(
          '[remote "upstream"]\n\turl = https://github.com/acme/upstream.git\n[remote "origin"]\n\turl = git@github.com:me/fork.git\n',
        ),
        {},
      ),
    ).toBe('me/fork');
  });

  // Even when the push URL comes first.
  it('reads origin’s url, not its pushurl', () => {
    const root = withConfig(
      '[remote "origin"]\n\tpushurl = git@github.com:me/push.git\n\turl = https://github.com/acme/fetch.git\n',
    );
    expect(detectRepository(root, {})).toBe('acme/fetch');
  });
});

/** The FileSystem interface is all the loader needs: any implementation works. */
describe('loadProject with another FileSystem', () => {
  it('only uses read, list, walk and isDir', () => {
    const files: Record<string, string> = {
      [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: ./lib/act\n',
      'lib/act/action.yml': PLAIN,
    };
    const calls: string[] = [];
    const inner = memoryFileSystem(files);
    const spy =
      <T>(name: string, fn: (path: string) => T) =>
      (path: string): T => {
        calls.push(`${name} ${path}`);
        return fn(path);
      };
    const fs: FileSystem = {
      read: spy('read', inner.read),
      list: spy('list', inner.list),
      walk: spy('walk', inner.walk),
      isDir: spy('isDir', inner.isDir),
    };
    const project = loadProject({ root: '/r', fs, validateSchema: false });
    expect(keys(project.actions)).toEqual(['lib/act']);
    expect(calls).toEqual(
      expect.arrayContaining([`list ${WF}`, 'walk .github/actions', 'read lib/act/action.yml']),
    );
  });
});
