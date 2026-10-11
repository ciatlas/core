import {
  createParseContext,
  type Loc,
  type Project,
  parseWorkflowFile,
  type StepDecl,
  type UsesRef,
} from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import {
  applyCheckout,
  initialWorkspace,
  isCheckout,
  locate,
  type Mount,
  type Workspace,
  workspaceKey,
} from '../src/workspace';
import { load, WF, yaml } from './helpers';

const W = `${WF}/w.yml`;

/** The steps of a job whose `steps:` is `list`; the first step is on line 6 of the workflow. */
const stepsOf = (list: string, repository = 'acme/repo'): StepDecl[] =>
  parseWorkflowFile(
    W,
    `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n${list.replace(/^(?=.)/gm, '      ')}`,
    createParseContext(repository),
  ).jobs.j!.steps;

/** Applies each step that is a checkout, in order, to the assumed workspace. */
const checkouts = (list: string, repository: string | null = 'acme/repo', start = initialWorkspace()) =>
  stepsOf(list, repository ?? 'acme/repo').reduce(
    (ws, s) => applyCheckout(ws, s, repository ?? undefined),
    start,
  );

const mount = (m: Mount) =>
  `${m.path}${m.repository !== undefined ? ` <${m.repository}>` : ''}${m.ref !== undefined ? ` @${m.ref}` : ''}${m.loc ? ` :${m.loc.line}` : ''}`;
const mounts = (ws: Workspace) => ws.mounts.map(mount);
const loc = (line: number, file = W): Loc => ({ file, line, column: 1, endLine: line, endColumn: 2 });
const uses = (raw: string): UsesRef => ({ raw, loc: loc(1), kind: 'remote-action' });

describe('isCheckout', () => {
  it.each([
    ['actions/checkout@v5', true],
    ['actions/checkout@0123456789abcdef', true],
    ['actions/checkout', true],
    ['Actions/Checkout@v4', true],
    ['  actions/checkout@v5  ', true],
    ['actions/checkout-extra@v1', false],
    ['my/actions/checkout@v1', false],
    ['./actions/checkout', false],
  ])('%s → %s', (raw, expected) => {
    expect(isCheckout(uses(raw))).toBe(expected);
  });
});

describe('applyCheckout', () => {
  it('starts from this repository assumed at the workspace root, and replaces it with a checkout there', () => {
    const start = initialWorkspace();
    expect(start).toEqual({ mounts: [{ path: '.' }], managed: false, writes: [] });
    // Each call gives a fresh workspace.
    expect(initialWorkspace()).not.toBe(start);

    const [co] = stepsOf(yaml`
      - uses: actions/checkout@v5
    `);
    const ws = applyCheckout(start, co!, 'acme/repo');
    expect(mounts(ws)).toEqual(['. :6']);
    expect(ws.managed).toBe(true);
    expect(ws.dynamic).toBeUndefined();
    // The mount points at the step's `uses:`.
    expect(ws.mounts[0]!.loc).toEqual(co!.uses!.loc);
    expect(start.mounts).toEqual([{ path: '.' }]);
  });

  it.each([
    ['src/app', 'src/app'],
    ['./copy/', 'copy'],
    ['a/../b', 'b'],
    ['a\\b', 'a/b'],
    ['${{ github.workspace }}/tools', 'tools'],
    ['${{github.workspace}}/tools/', 'tools'],
  ])('mounts a checkout to `path: %s` at %s, next to the root', (path, expected) => {
    const ws = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          path: '${path}'
    `);
    expect(mounts(ws)).toEqual(['.', `${expected} :6`]);
    expect(ws.managed).toBe(true);
  });

  it.each(['.', './', '${{ github.workspace }}', "''"])('treats `path: %s` as the workspace root', (path) => {
    const ws = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          path: ${path}
    `);
    expect(mounts(ws)).toEqual(['. :6']);
  });

  it.each([
    '/abs/dir',
    'C:/work',
    'C:\\work',
    '..',
    '../sibling',
    'a/../../up',
    '${{ github.workspace }}/../x',
  ])('ignores a checkout to `path: %s`, outside the workspace (the step fails)', (path) => {
    const start = initialWorkspace();
    const [co] = stepsOf(yaml`
      - uses: actions/checkout@v5
        with:
          path: '${path}'
    `);
    expect(applyCheckout(start, co!, 'acme/repo')).toBe(start);
  });

  it('records a checkout to a path computed at runtime, until a checkout at the root empties the workspace', () => {
    const dynamic = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          repository: acme/\${{ matrix.plugin }}
          path: \${{ matrix.plugin }}
    `);
    expect(mounts(dynamic)).toEqual(['.']);
    expect(dynamic.managed).toBe(true);
    expect(dynamic.dynamic).toEqual({
      path: '${{ matrix.plugin }}',
      repository: 'acme/${{ matrix.plugin }}',
      loc: expect.objectContaining({ file: W, line: 6 }),
    });

    const sub = checkouts(
      yaml`
        - uses: actions/checkout@v5
          with:
            path: sub
      `,
      'acme/repo',
      dynamic,
    );
    expect(mounts(sub)).toEqual(['.', 'sub :6']);
    expect(sub.dynamic).toBe(dynamic.dynamic);

    const root = checkouts(
      yaml`
        - uses: actions/checkout@v5
      `,
      'acme/repo',
      sub,
    );
    expect(mounts(root)).toEqual(['. :6']);
    expect(root.dynamic).toBeUndefined();

    // A dynamic path of this repository has no repository.
    const own = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          path: \${{ inputs.dir }}
    `);
    expect(own.dynamic).toEqual({ path: '${{ inputs.dir }}', loc: expect.objectContaining({ line: 6 }) });
  });

  it.each([
    ['other/tools', 'other/tools'],
    ['Acme/Repo', undefined],
    ["''", undefined],
    ['${{ github.repository }}', undefined],
    ['${{ github.event.repository.full_name }}', undefined],
    ['${{ github.event.pull_request.head.repo.full_name || github.repository }}', undefined],
    ['${{ github.event.pull_request.base.repo.full_name }}', undefined],
    ['${{ github.event.workflow_run.head_repository.full_name }}', undefined],
    ["${{ github.event_name == 'pull_request_target' && github.repository }}", undefined],
    ['${{ (github.repository) }}', undefined],
    ['${{ inputs.repo || github.repository }}', '${{ inputs.repo || github.repository }}'],
    ['${{ inputs.repo }}', '${{ inputs.repo }}'],
  ])('reads `repository: %s` as %s (undefined: this repository)', (repository, expected) => {
    const ws = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          repository: ${repository}
          path: dir
    `);
    expect(ws.mounts[1]!.repository).toBe(expected);
  });

  it('only recognizes this repository by name when it knows the repository', () => {
    const ws = checkouts(
      yaml`
        - uses: actions/checkout@v5
          with:
            repository: acme/repo
            ref: main
      `,
      null,
    );
    // Another repository's checkout has no `ref` of this repository.
    expect(mounts(ws)).toEqual(['. <acme/repo> :6']);
  });

  it.each([
    ['main', 'main'],
    ['${{ github.base_ref }}', '${{ github.base_ref }}'],
    ['${{ inputs.ref || github.sha }}', '${{ inputs.ref || github.sha }}'],
    ['', undefined],
    ['${{ github.sha }}', undefined],
    ['${{ github.ref }}', undefined],
    ['${{ github.ref_name }}', undefined],
    ['${{ github.head_ref || github.ref }}', undefined],
    ['${{ github.event.pull_request.head.sha }}', undefined],
    ['${{ github.event.pull_request.merge_commit_sha }}', undefined],
    ['${{ github.event.workflow_run.head_branch }}', undefined],
    ['${{ github.event.merge_group.head_sha }}', undefined],
    ['${{ github.event.check_suite.head_sha }}', undefined],
    ['${{ github.event.release.tag_name }}', undefined],
    ['${{ github.event.after }}', undefined],
    ['${{ (github.event.head_commit.id) }}', undefined],
    [
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}",
      undefined,
    ],
    ['refs/pull/${{ github.event.pull_request.number }}/merge', undefined],
    ['refs/pull/${{ github.event.number }}/head', undefined],
    ['refs/pull/${{ github.event.number }}/files', 'refs/pull/${{ github.event.number }}/files'],
  ])('reads `ref: %s` as %s (undefined: the running commit)', (ref, expected) => {
    const ws = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          ref: "${ref}"
          path: old
    `);
    expect(ws.mounts[1]!.ref).toBe(expected);
  });

  it('keeps no ref for another repository', () => {
    const ws = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          repository: other/tools
          ref: main
          path: tools
    `);
    expect(mounts(ws)).toEqual(['.', 'tools <other/tools> :6']);
  });

  it('replaces whatever was at its path and below, including what scripts wrote there', () => {
    const start: Workspace = {
      ...initialWorkspace(),
      writes: [
        { path: 'a/x', command: 'cp', loc: loc(2) },
        { path: 'ab/y', command: 'cp', loc: loc(3) },
        { path: 'a', command: 'mkdir', loc: loc(4) },
        { path: 'a/b/z', command: 'cp', loc: loc(5) },
      ],
    };
    const [deep, sibling, parent] = stepsOf(yaml`
      - uses: actions/checkout@v5
        with: { path: a/b }
      - uses: actions/checkout@v5
        with: { path: abc }
      - uses: actions/checkout@v5
        with: { path: a }
    `);
    const one = applyCheckout(start, deep!, 'acme/repo');
    expect(mounts(one)).toEqual(['.', 'a/b :6']);
    expect(one.writes.map((w) => w.path)).toEqual(['a/x', 'ab/y', 'a']);
    const two = applyCheckout(one, sibling!, 'acme/repo');
    expect(mounts(two)).toEqual(['.', 'a/b :6', 'abc :8']);
    expect(two.writes).toEqual(one.writes);
    // Only whole segments: `a` replaces `a/b` and what was written in `a`, not `abc` or `ab/y`.
    const three = applyCheckout(two, parent!, 'acme/repo');
    expect(mounts(three)).toEqual(['.', 'abc :8', 'a :10']);
    expect(three.writes.map((w) => w.path)).toEqual(['ab/y']);
    // A checkout at the root replaces every mount and every write.
    const root = checkouts('- uses: actions/checkout@v5\n', 'acme/repo', three);
    expect(mounts(root)).toEqual(['. :6']);
    expect(root.writes).toEqual([]);
  });

  it('ignores the step’s `with:` values that are not text', () => {
    const ws = checkouts(yaml`
      - uses: actions/checkout@v5
        with:
          path: [a, b]
          repository: { x: 1 }
          ref: null
    `);
    expect(mounts(ws)).toEqual(['. :6']);
  });
});

describe('locate', () => {
  const ws: Workspace = {
    mounts: [
      { path: '.', loc: loc(1) },
      { path: 'src/app/deep', repository: 'other/deep', loc: loc(3) },
      { path: 'src', loc: loc(2) },
      { path: 'tools', repository: 'other/tools', loc: loc(4) },
    ],
    managed: true,
    writes: [],
  };
  const where = (path: string) => {
    const { mount: m, rel } = locate(ws, path);
    return `${m.path} ${rel}`;
  };

  it('finds the deepest mount holding a path, and the path inside it', () => {
    expect(where('src/app/deep/x')).toBe('src/app/deep x');
    expect(where('src/app/x')).toBe('src app/x');
    expect(where('src')).toBe('src .');
    expect(where('tools/lint/setup')).toBe('tools lint/setup');
    expect(where('.github/actions/a')).toBe('. .github/actions/a');
    // Only whole segments: `srcx` is not in `src`.
    expect(where('srcx/a')).toBe('. srcx/a');
    expect(where('.')).toBe('. .');
  });

  it('assumes the root when no mount is there', () => {
    const bare: Workspace = { mounts: [{ path: 'sub', loc: loc(5) }], managed: true, writes: [] };
    expect(locate(bare, 'x/y')).toEqual({ mount: { path: '.' }, rel: 'x/y' });
    expect(locate(bare, 'sub/y')).toEqual({ mount: bare.mounts[0], rel: 'y' });
  });
});

describe('workspaceKey', () => {
  const base: Workspace = {
    mounts: [{ path: '.' }, { path: 'src', loc: loc(2) }],
    managed: true,
    writes: [{ path: 'dist', command: 'cp', loc: loc(3) }],
  };

  it('identifies equal workspaces by value', () => {
    expect(workspaceKey(base)).toBe(workspaceKey(structuredClone(base)));
  });

  it.each<[string, Workspace]>([
    ['another mount', { ...base, mounts: [{ path: '.' }, { path: 'lib', loc: loc(2) }] }],
    ['the same path from another step', { ...base, mounts: [{ path: '.' }, { path: 'src', loc: loc(9) }] }],
    [
      'another repository',
      { ...base, mounts: [{ path: '.' }, { path: 'src', repository: 'o/r', loc: loc(2) }] },
    ],
    ['another ref', { ...base, mounts: [{ path: '.' }, { path: 'src', ref: 'main', loc: loc(2) }] }],
    ['the assumed root replaced', { ...base, mounts: [{ path: '.', loc: loc(1) }, base.mounts[1]!] }],
    ['unmanaged', { ...base, managed: false }],
    ['a dynamic checkout', { ...base, dynamic: { path: '${{ x }}', loc: loc(4) } }],
    ['another write', { ...base, writes: [{ path: 'out', command: 'cp', loc: loc(3) }] }],
    ['a write from another step', { ...base, writes: [{ path: 'dist', command: 'cp', loc: loc(7) }] }],
  ])('tells apart a workspace with %s', (_, other) => {
    expect(workspaceKey(other)).not.toBe(workspaceKey(base));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// workspaceResolver, through the loader: how each step's `./path` resolves in the workspace its job (and, for a
// composite action, each caller) sets up.
// ---------------------------------------------------------------------------------------------------------------

const A = '.github/actions/a/action.yml';
const ACTION = yaml`
  name: a
  description: d
  inputs:
    req: { description: r, required: true }
  outputs:
    out: { description: o, value: x }
  runs:
    using: composite
    steps:
      - run: echo hi
        shell: bash
`;
/** An action with nothing to verify, for paths whose only question is whether they exist. */
const PLAIN = yaml`
  name: p
  description: d
  runs:
    using: composite
    steps:
      - run: echo hi
        shell: bash
`;
const B = '.github/actions/build/action.yml';

const at = (l: Loc) => `${l.file}:${l.line}`;
const line = (l: Loc) => (l.file === W ? `${l.line}` : at(l));

/** The project's missing local targets: where, which path, and why. */
const missing = (p: Project) =>
  p.missing.map((m) => ({
    at: line(m.uses.loc),
    target: m.target ?? m.uses.target,
    ...(m.inRepository ? { inRepository: true } : {}),
    ...(m.checkout ? { checkout: `${m.checkout.path} ${line(m.checkout.loc)}` } : {}),
    ...(m.elsewhere ? { elsewhere: m.elsewhere.map((c) => `${c.path} ${line(c.loc)}`) } : {}),
    ...(m.via ? { via: m.via.map((v) => `${at(v.loc)} ${v.action}`) } : {}),
  }));

/** The project's steps whose `./path` is not verified, and why. */
const unverified = (p: Project) =>
  (p.unverified ?? []).map((u) => ({
    at: line(u.uses.loc),
    reason: u.reason,
    ...(u.checkout ? { checkout: { ...u.checkout, loc: line(u.checkout.loc) } } : {}),
    ...(u.writer ? { writer: { ...u.writer, loc: line(u.writer.loc) } } : {}),
  }));

/** `kind target` of each step's `uses:` in job `job` of `w.yml`. */
const resolved = (p: Project, job = 'j', file = W) =>
  p.workflows
    .get(file)!
    .jobs[job]!.steps.flatMap((s) => (s.uses ? [`${s.uses.kind} ${s.uses.target ?? '-'}`] : []));

describe('workspaceResolver: a step’s ./path is relative to the workspace', () => {
  it('maps ./path through a checkout of this repository at `path:`', () => {
    const { project, index } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src/app
              - uses: ./src/app/.github/actions/a
                with:
                  req: 1
              - uses: ./src/app/.github/actions/gone
      `,
      [A]: ACTION,
    });
    expect(resolved(project)).toEqual([
      'remote-action -',
      'local-action .github/actions/a',
      'local-action .github/actions/gone',
    ]);
    expect(missing(project)).toEqual([{ at: '12', target: '.github/actions/gone', checkout: 'src/app 6' }]);
    expect(unverified(project)).toEqual([]);
    expect(index.usersOf('.github/actions/a').map((u) => u.step.index)).toEqual([1]);
  });

  it('still reports actions missing from this repository (root checkout, or `repository:` naming it)', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - uses: ./.github/actions/gone
              - uses: actions/checkout@v5
                with:
                  repository: Acme/Repo
                  path: ./copy/
              - uses: ./copy/.github/actions/gone-too
      `,
    });
    expect(missing(project)).toEqual([
      { at: '7', target: '.github/actions/gone' },
      { at: '12', target: '.github/actions/gone-too', checkout: 'copy 8' },
    ]);
  });

  it('does not verify actions in another repository’s checkout', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  repository: acme/shared-actions
                  path: shared
              - uses: ./shared/setup
                with:
                  anything: 1
              - uses: actions/checkout@v5
                with:
                  repository: other/tools
              - uses: ./.github/actions/a
      `,
      [A]: ACTION,
    });
    expect(unverified(project)).toEqual([
      {
        at: '10',
        reason: 'other-repository',
        checkout: { repository: 'acme/shared-actions', path: 'shared', loc: '6' },
      },
      { at: '16', reason: 'other-repository', checkout: { repository: 'other/tools', path: '.', loc: '13' } },
    ]);
    expect(missing(project)).toEqual([]);
    // Neither is a local action any more: the step is kept as a workspace action, without a target.
    expect(resolved(project)).toEqual([
      'remote-action -',
      'workspace-action -',
      'remote-action -',
      'workspace-action -',
    ]);
    expect(project.unverified!.map((u) => [u.from, u.job, u.step])).toEqual([
      [W, 'j', 1],
      [W, 'j', 3],
    ]);
  });

  it('treats a pull request’s fork as this repository', () => {
    const { project, index } = load({
      [W]: yaml`
        on: pull_request_target
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  repository: \${{ github.event.pull_request.head.repo.full_name || github.repository }}
              - uses: ./.github/actions/a
      `,
      [A]: ACTION,
    });
    expect(unverified(project)).toEqual([]);
    expect(missing(project)).toEqual([]);
    expect(index.usersOf('.github/actions/a')).toHaveLength(1);
  });

  it('never reads paths outside the workspace', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - run: cp -r .github/actions/a ../trusted/
              - uses: ./../trusted/a
      `,
      [A]: ACTION,
    });
    expect(unverified(project)).toEqual([{ at: '7', reason: 'outside-workspace' }]);
    expect(missing(project)).toEqual([]);
    expect([...project.actions.keys()]).toEqual(['.github/actions/a']);
  });

  it('does not verify paths outside this repository’s directories that no checkout of it covers, or that an earlier step writes', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src/app
              - uses: ./tools/lint
              - uses: ./.github/actions/a
          k:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - run: |
                  mkdir -p dist
                  cp -r tools/action ./dist/action
              - uses: ./dist/action
      `,
      [A]: ACTION,
    });
    expect(unverified(project)).toEqual([
      { at: '9', reason: 'not-checked-out' },
      { at: '18', reason: 'created-at-runtime', writer: { loc: '15', path: 'dist/action', command: 'cp' } },
    ]);
    // A path in this repository is verified as the best guess, and reported: GitHub looks for it in the workspace.
    expect(missing(project)).toEqual([
      { at: '10', target: '.github/actions/a', inRepository: true, elsewhere: ['src/app 6'] },
    ]);
    expect(resolved(project)).toEqual([
      'remote-action -',
      'workspace-action -',
      'local-action .github/actions/a',
    ]);
  });

  it('does not report paths a checkout to a runtime-computed path may hold, but keeps typos in this repository’s directories', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            strategy:
              matrix:
                plugin: [a, b]
            steps:
              - uses: actions/checkout@v5
              - uses: actions/checkout@v5
                with:
                  repository: acme/\${{ matrix.plugin }}
                  path: \${{ matrix.plugin }}
              - uses: ./a/setup
              - uses: ./.github/actions/typo
      `,
      [A]: ACTION,
    });
    expect(unverified(project)).toEqual([
      {
        at: '14',
        reason: 'not-checked-out',
        checkout: { path: '${{ matrix.plugin }}', repository: 'acme/${{ matrix.plugin }}', loc: '10' },
      },
    ]);
    expect(missing(project)).toEqual([{ at: '15', target: '.github/actions/typo' }]);
  });

  it('reports typos under this repository’s directories when it is not checked out at the workspace root', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          src:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src
              - uses: ./.github/actions/build
              - uses: ./.github/actions/biuld
          other:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  repository: acme/tools
                  path: tools
              - uses: ./.github/actions/biuld
              - uses: ./lint/setup
      `,
      [B]: PLAIN,
    });
    expect(missing(project)).toEqual([
      { at: '9', target: '.github/actions/build', inRepository: true, elsewhere: ['src 6'] },
      { at: '10', target: '.github/actions/biuld', elsewhere: ['src 6'] },
      // Only another repository is checked out: this one is nowhere.
      { at: '18', target: '.github/actions/biuld', elsewhere: [] },
    ]);
    // Outside this repository's top-level directories, the path may be what some other step puts there.
    expect(unverified(project)).toEqual([{ at: '19', reason: 'not-checked-out' }]);
  });

  it('only excuses a missing path that an earlier script writes to, not one it merely mentions', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          mentions:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - run: ls .github/actions/biuld || true
              - run: echo "./.github/actions/biuld is fine"
              - run: cp -r .github/actions/build .github/
              - uses: ./.github/actions/biuld
          writes:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - run: |
                  git clone --depth 1 https://github.com/acme/tools.git vendor/tools
                  cd vendor && tar -xzf ../a.tgz -C unpacked
                  cat > "$GITHUB_WORKSPACE/gen/act/action.yml" <<'EOF'
                  runs: { using: composite, steps: [] }
                  EOF
              - uses: ./vendor/tools/setup
              - uses: ./vendor/unpacked/act
              - uses: ./gen/act
      `,
      [B]: PLAIN,
    });
    expect(missing(project)).toEqual([{ at: '10', target: '.github/actions/biuld' }]);
    expect(unverified(project).map((u) => [u.at, u.writer?.command, u.writer?.path])).toEqual([
      ['21', 'git clone', 'vendor/tools'],
      ['22', 'tar', 'vendor/unpacked'],
      ['23', '>', 'gen/act/action.yml'],
    ]);
  });

  it('names the write that best explains a path: the path itself, then a file in it, then a directory holding it; the latest of equals', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - run: cp -r a out/act
              - run: cp -r b out
              - run: mv c out/act
              - uses: ./out/act
              - run: cat > gen/act/action.yml
              - run: cp -r d gen
              - uses: ./gen/act
              - run: cp -r e lib
              - run: cp -r f lib/sub
              - uses: ./lib/sub/act
      `,
    });
    expect(unverified(project).map((u) => [u.at, u.writer?.loc, u.writer?.command, u.writer?.path])).toEqual([
      ['9', '8', 'mv', 'out/act'],
      ['12', '10', '>', 'gen/act/action.yml'],
      ['15', '14', 'cp', 'lib/sub'],
    ]);
  });

  it('does not report a path missing from a checkout of this repository at another ref', () => {
    const { project } = load({
      [W]: yaml`
        on: pull_request
        jobs:
          a:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - uses: actions/checkout@v5
                with:
                  ref: release-1.0
                  path: old
              - uses: ./old/.github/actions/legacy
              - uses: acme/repo/.github/actions/legacy@release-1.0
              - uses: ./old/.github/actions/build
          b:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  ref: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}
              - uses: ./.github/actions/biuld
              - uses: actions/checkout@v5
                with:
                  ref: refs/pull/\${{ github.event.pull_request.number }}/merge
                  path: pr
              - uses: ./pr/.github/actions/biuld
      `,
      [B]: PLAIN,
    });
    expect(unverified(project)).toEqual([
      { at: '11', reason: 'other-ref', checkout: { path: 'old', ref: 'release-1.0', loc: '7' } },
    ]);
    // `owner/repo/path@ref` of this repository may exist at that ref: neither missing nor unverified.
    expect(resolved(project, 'a')).toEqual([
      'remote-action -',
      'remote-action -',
      'workspace-action -',
      'local-action .github/actions/legacy',
      'local-action .github/actions/build',
    ]);
    // The running commit (or the pull request's head) is the working tree: typos there are still missing.
    expect(missing(project)).toEqual([
      { at: '20', target: '.github/actions/biuld' },
      { at: '25', target: '.github/actions/biuld', checkout: 'pr 21' },
    ]);
  });

  it('empties the workspace on a root checkout, and ignores a checkout outside the workspace (it fails)', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            strategy:
              matrix:
                x: [one, two]
            steps:
              - uses: actions/checkout@v5
                with:
                  path: \${{ matrix.x }}
              - uses: actions/checkout@v5
              - uses: ./toolz/ok
          b:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: \${{ github.workspace }}/../x
              - uses: ./.github/actions/biuld
              - uses: ./foo/bar
      `,
      'tools/ok/action.yml': PLAIN,
    });
    expect(missing(project)).toEqual([
      { at: '13', target: 'toolz/ok' },
      { at: '20', target: '.github/actions/biuld' },
      { at: '21', target: 'foo/bar' },
    ]);
    expect(unverified(project)).toEqual([]);
  });
});

describe('workspaceResolver: composite actions run in their callers’ workspaces', () => {
  it('resolves a composite action’s ./ paths in its callers’ workspaces, and lets its checkouts shape the caller’s', () => {
    const { project, index } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src/app
              - uses: ./src/app/.github/actions/outer
              - uses: ./src/app/.github/actions/checkout-tools
              - uses: ./tools/.github/actions/a
                with:
                  req: 1
      `,
      '.github/actions/outer/action.yml': yaml`
        name: outer
        description: d
        runs:
          using: composite
          steps:
            - uses: ./src/app/.github/actions/a
              with:
                req: 1
      `,
      // Its checkout changes the caller's workspace for the steps after it.
      '.github/actions/checkout-tools/action.yml': yaml`
        name: checkout-tools
        description: d
        runs:
          using: composite
          steps:
            - uses: actions/checkout@v5
              with:
                path: tools
      `,
      // No workflow here uses it: assume this repository at the root, so a missing action is still reported.
      '.github/actions/lonely/action.yml': yaml`
        name: lonely
        description: d
        runs:
          using: composite
          steps:
            - uses: ./.github/actions/gone
      `,
      [A]: ACTION,
    });
    expect(project.actions.get('.github/actions/outer')!.steps[0]!.uses!.target).toBe('.github/actions/a');
    expect(resolved(project)).toEqual([
      'remote-action -',
      'local-action .github/actions/outer',
      'local-action .github/actions/checkout-tools',
      'local-action .github/actions/a',
    ]);
    expect(missing(project)).toEqual([
      { at: '.github/actions/lonely/action.yml:6', target: '.github/actions/gone' },
    ]);
    expect(unverified(project)).toEqual([]);
    expect(index.usersOf('.github/actions/a').map((u) => u.unit.path)).toEqual([W, '.github/actions/outer']);
  });

  it('reports a composite action’s missing path for the caller it fails in, even when another caller finds it', () => {
    const { project, index } = load({
      [`${WF}/w1.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src
              - uses: ./src/.github/actions/outer
      `,
      [`${WF}/w2.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - uses: ./.github/actions/outer
      `,
      '.github/actions/outer/action.yml': yaml`
        name: outer
        description: d
        runs:
          using: composite
          steps:
            - uses: ./src/.github/actions/a
              with:
                req: x
      `,
      [A]: ACTION,
    });
    expect(missing(project)).toEqual([
      {
        at: '.github/actions/outer/action.yml:6',
        target: 'src/.github/actions/a',
        via: [`${WF}/w2.yml:7 .github/actions/outer`],
      },
    ]);
    expect(project.missing[0]!.via).toEqual([
      {
        from: `${WF}/w2.yml`,
        job: 'a',
        loc: expect.objectContaining({ line: 7 }),
        action: '.github/actions/outer',
      },
    ]);
    // The target is where the step resolves, so its interface is still checked and its users counted.
    expect(project.actions.get('.github/actions/outer')!.steps[0]!.uses!.target).toBe('.github/actions/a');
    expect(index.usersOf('.github/actions/a')).toHaveLength(1);
  });

  it('reports a path missing in several callers’ workspaces once, without a caller', () => {
    const { project } = load({
      [`${WF}/w1.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - uses: ./.github/actions/outer
      `,
      [`${WF}/w2.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src
              - uses: ./src/.github/actions/outer
      `,
      '.github/actions/outer/action.yml': yaml`
        name: outer
        description: d
        runs:
          using: composite
          steps:
            - uses: ./.github/actions/gone
      `,
    });
    expect(missing(project)).toEqual([
      { at: '.github/actions/outer/action.yml:6', target: '.github/actions/gone' },
    ]);
  });

  it('settles a composite action’s step once when its callers’ workspaces agree on it', () => {
    const { project, index } = load({
      [`${WF}/w1.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - uses: ./.github/actions/outer
      `,
      [`${WF}/w2.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            steps:
              - uses: ./.github/actions/outer
      `,
      '.github/actions/outer/action.yml': yaml`
        name: outer
        description: d
        runs:
          using: composite
          steps:
            - uses: ./.github/actions/a
              with:
                req: x
      `,
      [A]: ACTION,
    });
    expect(missing(project)).toEqual([]);
    expect(index.usersOf('.github/actions/outer')).toHaveLength(2);
    expect(index.usersOf('.github/actions/a').map((u) => u.unit.path)).toEqual(['.github/actions/outer']);
  });

  it('lets a composite action see the scripts its caller ran before it, and the caller see the action’s', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - run: cp -r tools/act ./dist/act
              - uses: ./.github/actions/outer
              - uses: ./dist/act
              - uses: ./.github/actions/stage
              - uses: ./staged/act
      `,
      '.github/actions/outer/action.yml': yaml`
        name: outer
        description: d
        runs:
          using: composite
          steps:
            - uses: ./dist/act
      `,
      '.github/actions/stage/action.yml': yaml`
        name: stage
        description: d
        runs:
          using: composite
          steps:
            - run: mkdir -p staged && cp -r tools/act staged/
              shell: bash
      `,
    });
    expect(missing(project)).toEqual([]);
    expect(unverified(project).map((u) => [u.at, u.reason, u.writer?.loc, u.writer?.path])).toEqual([
      ['.github/actions/outer/action.yml:6', 'created-at-runtime', '7', 'dist/act'],
      ['9', 'created-at-runtime', '7', 'dist/act'],
      ['11', 'created-at-runtime', '.github/actions/stage/action.yml:6', 'staged/act'],
    ]);
  });

  it('walks actions nothing here uses in the workspace of the unreached actions that use them', () => {
    const { project } = load({
      // Neither is used by a workflow; `inner` sorts first but runs where `outer` leaves the workspace.
      '.github/actions/inner/action.yml': yaml`
        name: inner
        description: d
        runs:
          using: composite
          steps:
            - uses: ./dist/act
      `,
      '.github/actions/outer/action.yml': yaml`
        name: outer
        description: d
        runs:
          using: composite
          steps:
            - run: cp -r tools/act dist/act
              shell: bash
            - uses: ./.github/actions/inner
      `,
    });
    expect(missing(project)).toEqual([]);
    expect(unverified(project).map((u) => [u.at, u.reason])).toEqual([
      ['.github/actions/inner/action.yml:6', 'created-at-runtime'],
    ]);
  });

  it('settles actions that use each other, or themselves, without looping', () => {
    const composite = (name: string, ...steps: string[]) =>
      `name: ${name}\ndescription: d\nruns:\n  using: composite\n  steps:\n${steps.map((s) => `    - uses: ${s}\n`).join('')}`;
    const { project, index } = load({
      '.github/actions/ping/action.yml': composite('ping', './.github/actions/pong'),
      '.github/actions/pong/action.yml': composite(
        'pong',
        './.github/actions/ping',
        './.github/actions/gone',
      ),
      '.github/actions/self/action.yml': composite('self', './.github/actions/self'),
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: ./.github/actions/self
              - uses: ./.github/actions/self
      `,
    });
    expect(missing(project)).toEqual([
      { at: '.github/actions/pong/action.yml:7', target: '.github/actions/gone' },
    ]);
    expect(index.usersOf('.github/actions/ping').map((u) => u.unit.path)).toEqual(['.github/actions/pong']);
    expect(
      index
        .usersOf('.github/actions/self')
        .map((u) => u.unit.path)
        .sort(),
    ).toEqual(['.github/actions/self', W, W]);
  });

  it('verifies `$/` and this repository’s `owner/repo/path@ref` against the repository, whatever the workspace holds', () => {
    const { project } = load({
      [W]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  repository: other/tools
              - uses: $/.github/actions/a
              - uses: $/.github/actions/gone
              - uses: acme/repo/.github/actions/a@main
              - uses: acme/repo/.github/actions/elsewhere@main
              - uses: $/../outside
      `,
      [A]: ACTION,
    });
    expect(resolved(project)).toEqual([
      'remote-action -',
      'local-action .github/actions/a',
      'local-action .github/actions/gone',
      'local-action .github/actions/a',
      'local-action .github/actions/elsewhere',
      'local-action ../outside',
    ]);
    // Missing from the working tree but maybe at that ref: not reported. A `$/` path leaving the repository is.
    expect(missing(project)).toEqual([
      { at: '10', target: '.github/actions/gone' },
      { at: '13', target: '../outside' },
    ]);
    expect(unverified(project)).toEqual([]);
  });
});
