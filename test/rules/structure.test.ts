import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF, yaml } from '../helpers';

const call = (target: string) =>
  `on: workflow_call\njobs:\n  next:\n    uses: ./.github/workflows/${target}\n`;

describe('FP601 call-cycle', () => {
  it('reports each cycle once', () => {
    const r = lint({
      [`${WF}/a.yml`]: call('b.yml').replace('workflow_call', 'push'),
      [`${WF}/b.yml`]: call('c.yml'),
      [`${WF}/c.yml`]: call('b.yml'),
    });
    expect(byCode(r, 'FP601').map((f) => f.message)).toEqual([
      'Call cycle: .github/workflows/b.yml → .github/workflows/c.yml → .github/workflows/b.yml',
    ]);
  });
});

describe('FP602 nesting-depth', () => {
  const chain = (n: number) => {
    const files: Record<string, string> = {
      [`${WF}/w1.yml`]: call('w2.yml').replace('workflow_call', 'push'),
    };
    for (let i = 2; i < n; i++) files[`${WF}/w${i}.yml`] = call(`w${i + 1}.yml`);
    files[`${WF}/w${n}.yml`] = 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n';
    return files;
  };
  it('respects limits.nestingDepth', () => {
    expect(byCode(lint(chain(4), { config: { limits: { nestingDepth: 4 } } }), 'FP602')).toEqual([]);
    const [f] = byCode(lint(chain(5), { config: { limits: { nestingDepth: 4 } } }), 'FP602');
    expect(f?.message).toMatch(/^Call chain is 5 workflows deep \(limit 4\)/);
    expect(f?.related).toHaveLength(4);
  });
  it('defaults to 10', () => {
    expect(byCode(lint(chain(10)), 'FP602')).toEqual([]);
    expect(byCode(lint(chain(11)), 'FP602')).toHaveLength(1);
  });
});

describe('FP603 / FP606 / FP608', () => {
  const r = lint({
    [`${WF}/w.yml`]: [
      'on: push',
      'jobs:',
      '  remote:',
      '    uses: other/repo/.github/workflows/x.yml@v1',
      '  same-repo:',
      '    uses: acme/repo/.github/workflows/lib.yml@main',
      '  gone:',
      '    uses: ./.github/workflows/gone.yml',
      '  j:',
      '    needs: [remote, ghost]',
      '    runs-on: x',
      '    steps:',
      '      - uses: ./.github/actions/missing',
      '',
    ].join('\n'),
    [`${WF}/lib.yml`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
  });
  it('reports remote calls as unverified, but resolves same-repo references', () => {
    expect(byCode(r, 'FP603').map((f) => f.symbol)).toEqual(['remote:other/repo/.github/workflows/x.yml@v1']);
    expect(r.index.callSites.map((c) => c.callee.path)).toEqual([`${WF}/lib.yml`]);
  });
  it('reports missing local workflows and actions', () => {
    expect(byCode(r, 'FP606').map((f) => f.message)).toEqual([
      'Workflow ".github/workflows/gone.yml" does not exist',
      'Action ".github/actions/missing" does not exist',
    ]);
  });
  it('reports needs on unknown jobs', () => {
    expect(byCode(r, 'FP608')[0]?.message).toBe(
      'jobs.j needs "ghost", which is not a job in .github/workflows/w.yml (jobs: remote, same-repo, gone, j)',
    );
  });
});

describe('FP604 needs-without-data (opt-in)', () => {
  const files = {
    [`${WF}/w.yml`]:
      'on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: x }]\n  b:\n    needs: a\n    runs-on: x\n    steps: [{ run: x }]\n',
  };
  it('is off by default', () => expect(codes(lint(files))).not.toContain('FP604'));
  it('reports ordering-only dependencies when enabled', () => {
    expect(
      byCode(lint(files, { config: { rules: { 'needs-without-data': 'info' } } }), 'FP604'),
    ).toHaveLength(1);
  });
});

describe('FP605 large-interface / FP607 unreferenced-reusable-workflow', () => {
  const inputs = Array.from({ length: 4 }, (_, i) => `      i${i}: { type: string, default: x }`).join('\n');
  const reads = Array.from({ length: 4 }, (_, i) => `\${{ inputs.i${i} }}`).join(' ');
  const r = lint(
    {
      [`${WF}/big.yml`]: `on:\n  workflow_call:\n    inputs:\n${inputs}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${reads}\n`,
    },
    { config: { limits: { maxInputs: 3 } } },
  );
  it('flags interfaces above limits.maxInputs', () => {
    expect(byCode(r, 'FP605')[0]?.message).toBe(
      '.github/workflows/big.yml declares 4 workflow_call inputs (limit 3)',
    );
  });
  it('flags call-only workflows without callers', () => {
    expect(byCode(r, 'FP607')).toHaveLength(1);
  });
});

/** A composite action with one required input and one output. */
const ACTION = yaml`
  name: a
  description: d
  inputs:
    req: { required: true, description: r }
  outputs:
    out: { description: o, value: x }
  runs:
    using: composite
    steps:
      - run: echo \${{ inputs.req }}
        shell: bash
`;
const A = '.github/actions/a/action.yml';
const messages = (r: ReturnType<typeof lint>, code: string) => byCode(r, code).map((f) => f.message);

describe('FP606 / FP610: a step’s ./ path is relative to the workspace', () => {
  it('maps ./path through a checkout of this repository at `path:`', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
                  nope: 2
              - uses: ./src/app/.github/actions/gone
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP102')).toEqual(['.github/actions/a has no input "nope"']);
    expect(messages(r, 'FP606')).toEqual([
      'Action ".github/actions/gone" does not exist (./src/app/.github/actions/gone is in the checkout of this repository at "src/app")',
    ]);
    expect(byCode(r, 'FP606')[0]!.related.map((x) => [x.loc.line, x.message])).toEqual([
      [6, 'checks this repository out at "src/app"'],
    ]);
    expect(codes(r)).not.toContain('FP610');
  });

  it('still reports actions missing from this repository (root checkout, or `repository:` naming it)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(messages(r, 'FP606')).toEqual([
      'Action ".github/actions/gone" does not exist',
      'Action ".github/actions/gone-too" does not exist (./copy/.github/actions/gone-too is in the checkout of this repository at "copy")',
    ]);
  });

  it('does not verify actions in another repository’s checkout (FP610)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(messages(r, 'FP610')).toEqual([
      '"./shared/setup" is in the checkout of acme/shared-actions at "shared"; its interface is not verified',
      '"./.github/actions/a" is in the checkout of other/tools at "."; its interface is not verified',
    ]);
    expect(byCode(r, 'FP610').map((f) => f.severity)).toEqual(['info', 'info']);
    expect(byCode(r, 'FP610')[0]!.related.map((x) => x.message)).toEqual([
      'checks out acme/shared-actions at "shared"',
    ]);
    expect(codes(r).filter((c) => /^FP(10[12]|606)$/.test(c))).toEqual([]);
    expect(r.project.workflows.get(`${WF}/w.yml`)!.jobs.j!.steps[1]!.uses?.kind).toBe('workspace-action');
  });

  it('treats a pull request’s fork as this repository', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(messages(r, 'FP101')).toHaveLength(1);
    expect(codes(r)).not.toContain('FP610');
  });

  it('never reads paths outside the workspace', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(messages(r, 'FP610')).toEqual([
      '"./../trusted/a" points outside the workspace, so it only exists at runtime; it is not verified',
    ]);
    expect(codes(r)).not.toContain('FP606');
    expect([...r.project.actions.keys()]).toEqual(['.github/actions/a']);
  });

  it('does not verify paths outside this repository’s directories that no checkout of it covers, or that an earlier step writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(messages(r, 'FP610')).toEqual([
      '"./tools/lint" is not in this repository, and no checkout of this repository covers it; it is not verified',
      '"./dist/action" is not in this repository; an earlier step writes there (`cp`), so it is not verified',
    ]);
    expect(byCode(r, 'FP610')[1]!.related.map((x) => [x.loc.line, x.message])).toEqual([
      [15, '`cp` here writes to "dist/action"'],
    ]);
    // A path in this repository is verified as the best guess, and reported: GitHub looks for it in the workspace.
    expect(messages(r, 'FP101')).toHaveLength(1);
    expect(messages(r, 'FP606')).toEqual([
      'Action ".github/actions/a" is not in the workspace (this repository is checked out at "src/app", not at the workspace root)',
    ]);
  });

  it('does not report paths a checkout to a runtime-computed path may hold, but keeps typos in this repository’s directories', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(messages(r, 'FP610')).toEqual([
      '"./a/setup" is not in this repository and may be in the checkout at "${{ matrix.plugin }}", a path computed at runtime; it is not verified',
    ]);
    expect(messages(r, 'FP606')).toEqual(['Action ".github/actions/typo" does not exist']);
  });

  it('resolves a composite action’s ./ paths in its callers’ workspaces', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
                nope: 1
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
    expect(messages(r, 'FP102')).toEqual(['.github/actions/a has no input "nope"']);
    expect(byCode(r, 'FP102')[0]!.loc.file).toBe('.github/actions/outer/action.yml');
    expect(messages(r, 'FP606')).toEqual(['Action ".github/actions/gone" does not exist']);
    expect(codes(r)).not.toContain('FP610');
  });
});

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
const lines = (r: ReturnType<typeof lint>, code: string) =>
  byCode(r, code).map((f) => `${f.loc.file}:${f.loc.line} ${f.message}`);

describe('FP606 / FP610: review cases', () => {
  it('reports typos under this repository’s directories when it is not checked out at the workspace root', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(lines(r, 'FP606')).toEqual([
      `${WF}/w.yml:9 Action ".github/actions/build" is not in the workspace (this repository is checked out at "src", not at the workspace root)`,
      `${WF}/w.yml:10 Action ".github/actions/biuld" does not exist (this repository is checked out at "src", not at the workspace root)`,
      `${WF}/w.yml:18 Action ".github/actions/biuld" does not exist (no step checks this repository out at the workspace root)`,
    ]);
    const [found, typo, other] = byCode(r, 'FP606');
    expect(typo!.related.map((x) => [x.loc.line, x.message])).toEqual([
      [6, 'checks this repository out at "src"'],
    ]);
    expect(typo!.fix).toBe(
      'A step’s ./path is relative to the workspace, where this repository is at "src": a path in it starts with ./src/. Or use $/.github/actions/biuld, which always means this repository.',
    );
    expect(found!.related).toHaveLength(1);
    expect(other!.related).toEqual([]);
    expect(other!.fix).toContain('no step puts this repository at its root');
    // Outside this repository's top-level directories, the path may be what some other step puts there.
    expect(lines(r, 'FP610')).toEqual([
      `${WF}/w.yml:19 "./lint/setup" is not in this repository, and no checkout of this repository covers it; it is not verified`,
    ]);
  });

  it('only excuses a missing path that an earlier script writes to, not one it merely mentions', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(lines(r, 'FP606')).toEqual([`${WF}/w.yml:10 Action ".github/actions/biuld" does not exist`]);
    expect(byCode(r, 'FP610').map((f) => [f.message, f.related.map((x) => x.message)])).toEqual([
      [
        '"./vendor/tools/setup" is not in this repository; an earlier step writes there (`git clone`), so it is not verified',
        ['`git clone` here writes to "vendor/tools"'],
      ],
      [
        '"./vendor/unpacked/act" is not in this repository; an earlier step writes there (`tar`), so it is not verified',
        ['`tar` here writes to "vendor/unpacked"'],
      ],
      [
        '"./gen/act" is not in this repository; an earlier step writes there (`>`), so it is not verified',
        ['`>` here writes to "gen/act/action.yml"'],
      ],
    ]);
  });

  it('reports a composite action’s missing path for the caller it fails in, even when another caller finds it', () => {
    const r = lint({
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
    expect(lines(r, 'FP606')).toEqual([
      `.github/actions/outer/action.yml:6 Action "src/.github/actions/a" does not exist when .github/actions/outer runs in job "a" of ${WF}/w2.yml`,
    ]);
    expect(byCode(r, 'FP606')[0]!.related.map((x) => `${x.loc.file}:${x.loc.line} ${x.message}`)).toEqual([
      `${WF}/w2.yml:7 uses .github/actions/outer here`,
    ]);
    // The target is where the step resolves, so its interface is still checked and its users counted.
    expect(codes(r)).not.toContain('FP101');
    expect(r.index.usersOf('.github/actions/a')).toHaveLength(1);
  });

  it('lets a composite action see the scripts its caller ran before it, and the caller see the action’s', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(codes(r)).not.toContain('FP606');
    expect(lines(r, 'FP610')).toEqual([
      `.github/actions/outer/action.yml:6 "./dist/act" is not in this repository; an earlier step writes there (\`cp\`), so it is not verified`,
      `${WF}/w.yml:9 "./dist/act" is not in this repository; an earlier step writes there (\`cp\`), so it is not verified`,
      `${WF}/w.yml:11 "./staged/act" is not in this repository; an earlier step writes there (\`cp\`), so it is not verified`,
    ]);
    expect(byCode(r, 'FP610')[0]!.related.map((x) => `${x.loc.file}:${x.loc.line}`)).toEqual([
      `${WF}/w.yml:7`,
    ]);
  });

  it('does not report a path missing from a checkout of this repository at another ref', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(lines(r, 'FP610')).toEqual([
      `${WF}/w.yml:11 "./old/.github/actions/legacy" is not in this repository’s working tree, but may be at "release-1.0", the ref checked out at "old"; it is not verified`,
    ]);
    expect(byCode(r, 'FP610')[0]!.related.map((x) => x.message)).toEqual([
      'checks out ref "release-1.0" of this repository at "old"',
    ]);
    // The running commit (or the pull request's head) is the working tree: typos there are still errors.
    expect(lines(r, 'FP606')).toEqual([
      `${WF}/w.yml:20 Action ".github/actions/biuld" does not exist`,
      `${WF}/w.yml:25 Action ".github/actions/biuld" does not exist (./pr/.github/actions/biuld is in the checkout of this repository at "pr")`,
    ]);
  });

  it('empties the workspace on a root checkout, and ignores a checkout outside the workspace (it fails)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
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
    expect(lines(r, 'FP606')).toEqual([
      `${WF}/w.yml:13 Action "toolz/ok" does not exist`,
      `${WF}/w.yml:20 Action ".github/actions/biuld" does not exist`,
      `${WF}/w.yml:21 Action "foo/bar" does not exist`,
    ]);
    expect(codes(r)).not.toContain('FP610');
  });
});

describe('$/ self-repository references', () => {
  const files = {
    [`${WF}/w.yml`]: yaml`
      on: push
      jobs:
        a:
          runs-on: x
          steps:
            - uses: actions/checkout@v5
              with:
                repository: other/tools
            - id: s
              uses: $/.github/actions/a
              with:
                nope: 1
            - run: echo \${{ steps.s.outputs.missing }}
            - uses: $/.github/actions/gone
            - uses: $/.github/actions/a@v1
        b:
          uses: $/.github/workflows/lib.yml
          with:
            need: x
            bogus: 1
        c:
          needs: b
          runs-on: x
          steps:
            - run: echo \${{ needs.b.outputs.result }}
        d:
          uses: $/.github/workflows/lib.yml@main
    `,
    [`${WF}/lib.yml`]: yaml`
      on:
        workflow_call:
          inputs:
            need: { type: string, required: true }
            unread: { type: string }
          outputs:
            result: { value: x }
            ignored: { value: y }
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo \${{ inputs.need }}
    `,
    [A]: ACTION,
  };
  const r = lint(files);

  it('verifies $/ steps and calls like local ones, whatever the workspace holds', () => {
    expect(messages(r, 'FP101')).toEqual([
      'Step s uses .github/actions/a without required input "req" — GitHub will run it with an empty value',
    ]);
    expect(messages(r, 'FP102')).toEqual([
      '.github/actions/a has no input "nope"',
      '.github/workflows/lib.yml has no input "bogus"',
    ]);
    expect(messages(r, 'FP301')).toEqual(['.github/actions/a has no output "missing"']);
    expect(codes(r)).not.toContain('FP603');
    expect(codes(r)).not.toContain('FP610');
  });

  it('reports missing targets and the @ref GitHub rejects', () => {
    expect(messages(r, 'FP606')).toEqual([
      'Action ".github/actions/gone" does not exist',
      '"$/.github/actions/a@v1" has an @ref, which GitHub rejects: `$/` always runs this repository at the running commit',
      '"$/.github/workflows/lib.yml@main" has an @ref, which GitHub rejects: `$/` always runs this repository at the running commit',
    ]);
    expect(byCode(r, 'FP606')[1]!.fix).toBe(
      'Write `$/.github/actions/a` without @v1, or reference another commit as owner/repo/path@ref.',
    );
  });

  it('counts $/ callers and users wherever callers count', () => {
    expect(codes(r)).not.toContain('FP607');
    expect(messages(r, 'FP104')).toEqual(['Input "unread" of .github/workflows/lib.yml is never read']);
    expect(messages(r, 'FP303')).toEqual([
      'Output "out" of .github/actions/a is not read by any of its 1 user',
    ]);
    // lib.yml is a published reusable workflow, so FP303 leaves its outputs alone unless it is declared internal.
    expect(messages(lint(files, { config: { impact: { publish: [] } } }), 'FP303')).toContain(
      'Workflow output "ignored" of .github/workflows/lib.yml is not read by any of its 1 caller',
    );
    expect(r.index.callersOf(`${WF}/lib.yml`).map((c) => c.job.id)).toEqual(['b']);
    expect(r.index.usersOf('.github/actions/a').map((u) => u.step.id)).toEqual(['s']);
  });
});
