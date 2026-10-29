/**
 * The remote references inside a unit: each row of the resolution table (a `uses:` in a local or an external unit, by
 * kind), the references a project names, and the closure of remote sources read through a fake GitHub API.
 */
import { createHash } from 'node:crypto';
import {
  type FetchLike,
  fetchRemoteClosure,
  memoryRemoteCache,
  type RemotePin,
  type RemoteRef,
  type RemoteSource,
  remoteKey,
  remoteRefOfUses,
  remoteRefsOf,
  type UnitDecl,
  type WorkflowDecl,
} from '@ciatlas/core';
import { describe, expect, it } from 'vitest';
import { load, WF, yaml } from './helpers';

const SHA = (c: string) => c.repeat(40);

/** A remote body: a reusable workflow whose jobs and steps use one of each kind of reference. */
const DEPLOY = yaml`
  on: workflow_call
  jobs:
    build:
      uses: ./.github/workflows/build.yml
    same:
      uses: octo/ship/.github/workflows/build.yml@v2
    self:
      uses: $/.github/workflows/build.yml
    selfRef:
      uses: $/.github/workflows/build.yml@v3
    notCallable:
      uses: ./ci/build.yml
    caller:
      uses: acme/repo/.github/workflows/reusable.yml@v1
    steps:
      runs-on: x
      steps:
        - uses: ./.github/actions/local
        - uses: octo/ship/.github/actions/x@v1
        - uses: octo/ship@v1
        - uses: $/.github/actions/x
        - uses: $/
        - uses: acme/repo/.github/actions/y@v1
        - uses: actions/cache@v4
        - uses: docker://alpine:3
`;

const CI = yaml`
  on: push
  jobs:
    deploy:
      uses: octo/ship/.github/workflows/deploy.yml@v1
    unpinned:
      uses: octo/ship/.github/workflows/deploy.yml@main
    local:
      uses: ./.github/workflows/reusable.yml
    same:
      uses: acme/repo/.github/workflows/reusable.yml@v1
    steps:
      runs-on: x
      steps:
        - uses: actions/cache@v4
        - uses: ./.github/actions/y
        - uses: acme/repo/.github/actions/y@v1
        - uses: docker://alpine:3
`;

const FILES = {
  [`${WF}/ci.yml`]: CI,
  [`${WF}/reusable.yml`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: echo }]\n',
  '.github/actions/y/action.yml': 'name: y\nruns:\n  using: composite\n  steps: []\n',
};

/** The project, with the remote body read at a commit (`sha`) or not (`undefined`), under the reference given. */
function loaded(sha: string | undefined, ref = 'Octo/Ship/.github/workflows/deploy.yml@v1') {
  const { project } = load(FILES, {
    remotes: [{ ref, kind: 'workflow', text: DEPLOY, ...(sha ? { sha } : {}) }],
  });
  const unit = project.external!.get(remoteKey(ref))! as WorkflowDecl;
  return { project, unit, ci: project.workflows.get(`${WF}/ci.yml`)! };
}

/** The `raw` of the remote reference a job's `uses:`, or its `step`th step's, names; undefined for none. */
function rawOf(unit: UnitDecl, job: string, step?: number): string | undefined {
  const j = (unit as WorkflowDecl).jobs[job]!;
  const uses = step === undefined ? j.uses! : j.steps[step]!.uses!;
  return remoteRefOfUses(unit, uses)?.raw;
}

describe('remoteRefOfUses in a local unit', () => {
  const { ci } = loaded(SHA('a'));

  it('names the remote reference a remote `uses:` names, as written', () => {
    expect(remoteRefOfUses(ci, ci.jobs.deploy!.uses!)).toEqual({
      raw: 'octo/ship/.github/workflows/deploy.yml@v1',
      kind: 'workflow',
      owner: 'octo',
      repo: 'ship',
      path: '.github/workflows/deploy.yml',
      ref: 'v1',
    });
    expect(remoteRefOfUses(ci, ci.jobs.steps!.steps[0]!.uses!)).toMatchObject({
      raw: 'actions/cache@v4',
      kind: 'action',
      path: '',
    });
  });

  it('names none for anything else: `./`, a same-repository reference, docker', () => {
    expect(rawOf(ci, 'local')).toBeUndefined();
    expect(rawOf(ci, 'same')).toBeUndefined();
    expect(rawOf(ci, 'steps', 1)).toBeUndefined();
    expect(rawOf(ci, 'steps', 2)).toBeUndefined();
    expect(rawOf(ci, 'steps', 3)).toBeUndefined();
  });
});

describe('remoteRefOfUses in an external unit', () => {
  const { unit } = loaded(SHA('a'));

  it('names the remote reference a remote `uses:` names, as written', () => {
    expect(rawOf(unit, 'steps', 6)).toBe('actions/cache@v4');
  });

  it("keeps the caller's own repository remote inside a remote", () => {
    expect(rawOf(unit, 'caller')).toBe('acme/repo/.github/workflows/reusable.yml@v1');
    expect(remoteRefOfUses(unit, unit.jobs.caller!.uses!)?.kind).toBe('workflow');
    expect(rawOf(unit, 'steps', 5)).toBe('acme/repo/.github/actions/y@v1');
  });

  it("reads a job's `./` in the remote's repository at the remote's commit", () => {
    expect(remoteRefOfUses(unit, unit.jobs.build!.uses!)).toEqual({
      raw: `Octo/Ship/.github/workflows/build.yml@${SHA('a')}`,
      kind: 'workflow',
      owner: 'Octo',
      repo: 'Ship',
      path: '.github/workflows/build.yml',
      ref: SHA('a'),
    });
  });

  it("reads a job's `./` at the remote's ref when its commit is not known", () => {
    expect(rawOf(loaded(undefined).unit, 'build')).toBe('Octo/Ship/.github/workflows/build.yml@v1');
  });

  it('names a same-repository reference as written, never the working copy', () => {
    expect(rawOf(unit, 'same')).toBe('octo/ship/.github/workflows/build.yml@v2');
    expect(rawOf(unit, 'steps', 1)).toBe('octo/ship/.github/actions/x@v1');
    expect(remoteRefOfUses(unit, unit.jobs.steps!.steps[2]!.uses!)).toMatchObject({
      raw: 'octo/ship@v1',
      kind: 'action',
      path: '',
    });
  });

  it("names none for a step's `./`: the runner's workspace, not the remote's repository", () => {
    expect(rawOf(unit, 'steps', 0)).toBeUndefined();
  });

  it("reads a `$/path` in the remote's repository at the remote's commit", () => {
    expect(rawOf(unit, 'self')).toBe(`Octo/Ship/.github/workflows/build.yml@${SHA('a')}`);
    expect(rawOf(unit, 'steps', 3)).toBe(`Octo/Ship/.github/actions/x@${SHA('a')}`);
    expect(rawOf(unit, 'steps', 4)).toBe(`Octo/Ship@${SHA('a')}`);
  });

  it('names none for what GitHub would not run: `$/path@ref`, a job outside .github/workflows, docker', () => {
    expect(rawOf(unit, 'selfRef')).toBeUndefined();
    expect(rawOf(unit, 'notCallable')).toBeUndefined();
    expect(rawOf(unit, 'steps', 7)).toBeUndefined();
  });

  it('names none for a local reference in a unit whose reference names no repository and ref', () => {
    const { unit: malformed } = loaded(SHA('a'), 'octo/ship');
    expect(malformed.origin).toBeUndefined();
    expect(rawOf(malformed, 'build')).toBeUndefined();
    expect(rawOf(malformed, 'self')).toBeUndefined();
    expect(rawOf(malformed, 'steps', 0)).toBeUndefined();
    // With no repository of its own, its same-repository references stay remote, as written.
    expect(rawOf(malformed, 'steps', 1)).toBe('octo/ship/.github/actions/x@v1');
    expect(rawOf(malformed, 'steps', 6)).toBe('actions/cache@v4');
  });
});

describe('remoteRefsOf', () => {
  const { project, ci } = loaded(SHA('a'));

  it("names each reference of the project's units and external units once, sorted by key", () => {
    expect(remoteRefsOf(project).map((r) => r.raw)).toEqual([
      'acme/repo/.github/actions/y@v1',
      'acme/repo/.github/workflows/reusable.yml@v1',
      'actions/cache@v4',
      `Octo/Ship/.github/actions/x@${SHA('a')}`,
      'octo/ship/.github/actions/x@v1',
      `Octo/Ship/.github/workflows/build.yml@${SHA('a')}`,
      'octo/ship/.github/workflows/build.yml@v2',
      'octo/ship/.github/workflows/deploy.yml@main',
      'octo/ship/.github/workflows/deploy.yml@v1',
      `Octo/Ship@${SHA('a')}`,
      'octo/ship@v1',
    ]);
  });

  it('names only the references of the units given', () => {
    expect(remoteRefsOf(project, [ci]).map((r) => r.raw)).toEqual([
      'actions/cache@v4',
      'octo/ship/.github/workflows/deploy.yml@main',
      'octo/ship/.github/workflows/deploy.yml@v1',
    ]);
    expect(remoteRefsOf(project, [])).toEqual([]);
  });
});

const digestOf = (text: string) => `sha256-${createHash('sha256').update(text).digest('base64')}`;

/** A fake GitHub API: commits by `<owner>/<repo>@<ref>`, files by `<owner>/<repo>/<path>@<sha>`; counts each request. */
function fakeApi(commits: Record<string, string>, files: Record<string, string>) {
  const seen: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(input);
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(commits|contents)\/(.+)$/.exec(decodeURIComponent(url.pathname))!;
    const [owner, repo] = [m[1]!.toLowerCase(), m[2]!.toLowerCase()];
    const key =
      m[3] === 'commits'
        ? `${owner}/${repo}@${m[4]}`
        : `${owner}/${repo}/${m[4]}@${url.searchParams.get('ref')}`;
    seen.push(key);
    const body = m[3] === 'commits' ? commits[key] : files[key];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
  };
  return { fetch, seen };
}

/** A remote repository `octo/ship` whose deploy.yml calls its own build.yml (`./`), which calls deploy.yml back. */
const SHIP = {
  deploy: yaml`
    on: workflow_call
    jobs:
      build:
        uses: ./.github/workflows/build.yml
      steps:
        runs-on: x
        steps:
          - uses: octo/setup@v2
          - uses: ./.github/actions/workspace
  `,
  build: yaml`
    on: workflow_call
    jobs:
      back:
        uses: octo/ship/.github/workflows/deploy.yml@v1
  `,
  setup: 'name: setup\nruns:\n  using: composite\n  steps:\n    - uses: octo/deep@v1\n',
  deep: 'name: deep\nruns:\n  using: node24\n  main: i.js\n',
};

const ROOT = {
  [`${WF}/ci.yml`]: yaml`
    on: push
    jobs:
      deploy:
        uses: octo/ship/.github/workflows/deploy.yml@v1
      gone:
        uses: octo/gone/.github/workflows/x.yml@v1
      steps:
        runs-on: x
        steps:
          - uses: actions/cache@${SHA('c')}
  `,
};

function shipApi() {
  return fakeApi(
    { 'octo/ship@v1': SHA('a'), 'octo/setup@v2': SHA('b'), 'octo/deep@v1': SHA('d') },
    {
      [`octo/ship/.github/workflows/deploy.yml@${SHA('a')}`]: SHIP.deploy,
      [`octo/ship/.github/workflows/build.yml@${SHA('a')}`]: SHIP.build,
      [`octo/setup/action.yml@${SHA('b')}`]: SHIP.setup,
      [`octo/deep/action.yml@${SHA('d')}`]: SHIP.deep,
      [`actions/cache/action.yml@${SHA('c')}`]: SHIP.deep,
    },
  );
}

const keysOf = (sources: RemoteSource[]) => sources.map((s) => `${s.ref.raw} ${s.sha[0]}`);

describe('fetchRemoteClosure', () => {
  const { project } = load(ROOT);
  const opts = { retryDelayMs: 0 };

  it('reads every remote a project reaches, breadth first, each `./` at its parent commit, and stops at cycles', async () => {
    const api = shipApi();
    const asked: string[] = [];
    const pin = (r: RemoteRef, parent?: RemoteSource): RemotePin | undefined => {
      asked.push(`${r.raw} < ${parent ? parent.ref.raw : 'project'}`);
      return undefined;
    };
    const closure = await fetchRemoteClosure(project, pin, {
      ...opts,
      fetch: api.fetch,
      resolveUnpinned: true,
    });
    expect(keysOf(closure.sources)).toEqual([
      `actions/cache@${SHA('c')} c`,
      `octo/deep@v1 d`,
      `octo/setup@v2 b`,
      `octo/ship/.github/workflows/build.yml@${SHA('a')} a`,
      'octo/ship/.github/workflows/deploy.yml@v1 a',
    ]);
    expect(closure.failed).toEqual([
      {
        ref: 'octo/gone/.github/workflows/x.yml@v1',
        kind: 'not-found',
        error: expect.stringContaining('octo/gone@v1 not found'),
      },
    ]);
    expect(closure.limited).toEqual([]);
    expect(asked).toEqual([
      `actions/cache@${SHA('c')} < project`,
      'octo/gone/.github/workflows/x.yml@v1 < project',
      'octo/ship/.github/workflows/deploy.yml@v1 < project',
      'octo/setup@v2 < octo/ship/.github/workflows/deploy.yml@v1',
      `octo/ship/.github/workflows/build.yml@${SHA('a')} < octo/ship/.github/workflows/deploy.yml@v1`,
      `octo/deep@v1 < octo/setup@v2`,
      `octo/ship/.github/workflows/deploy.yml@v1 < octo/ship/.github/workflows/build.yml@${SHA('a')}`,
    ]);
    // The tag is resolved once, though two bodies name it; nothing is read twice.
    expect(api.seen.filter((k) => k === 'octo/ship@v1')).toHaveLength(1);
    expect(new Set(api.seen.filter((k) => k.includes('/.github/'))).size).toBe(
      api.seen.filter((k) => k.includes('/.github/')).length,
    );
  });

  it('reads at the pin, checks its digest, and reads nothing unpinned unless asked to resolve it', async () => {
    const api = shipApi();
    const pins: Record<string, RemotePin> = {
      'octo/ship/.github/workflows/deploy.yml@v1': { sha: SHA('a'), digest: digestOf(SHIP.deploy) },
      'octo/setup@v2': { sha: SHA('b'), digest: 'sha256-wrong' },
    };
    const closure = await fetchRemoteClosure(project, (r) => pins[r.raw], {
      ...opts,
      fetch: api.fetch,
      resolveUnpinned: false,
    });
    expect(keysOf(closure.sources)).toEqual([
      `actions/cache@${SHA('c')} c`,
      `octo/ship/.github/workflows/build.yml@${SHA('a')} a`,
      'octo/ship/.github/workflows/deploy.yml@v1 a',
    ]);
    expect(closure.failed).toEqual([
      { ref: 'octo/setup@v2', kind: 'digest', error: expect.stringContaining('not sha256-wrong') },
    ]);
    // No commit was asked for: `owner/repo@ref` has one `/`.
    expect(api.seen.filter((k) => k.split('/').length === 2)).toEqual([]);
  });

  it('limits the depth and the number of sources read, and reports what it left', async () => {
    const pin = () => undefined;
    const shallow = await fetchRemoteClosure(project, pin, {
      ...opts,
      fetch: shipApi().fetch,
      resolveUnpinned: true,
      maxDepth: 2,
    });
    expect(shallow.limited).toEqual(['octo/deep@v1']);
    expect(keysOf(shallow.sources)).not.toContain('octo/deep@v1 d');
    const few = await fetchRemoteClosure(project, pin, {
      ...opts,
      fetch: shipApi().fetch,
      resolveUnpinned: true,
      maxUnits: 2,
    });
    expect(keysOf(few.sources)).toEqual([
      `actions/cache@${SHA('c')} c`,
      'octo/ship/.github/workflows/deploy.yml@v1 a',
    ]);
    expect(few.limited).toEqual(['octo/setup@v2', `octo/ship/.github/workflows/build.yml@${SHA('a')}`]);
  });

  it('reports progress, and what came from the cache', async () => {
    const cache = memoryRemoteCache();
    const run = async () => {
      const seen: { done: number; total: number; ref: string; outcome: string }[] = [];
      await fetchRemoteClosure(project, () => undefined, {
        ...opts,
        fetch: shipApi().fetch,
        cache,
        resolveUnpinned: true,
        maxDepth: 1,
        onProgress: (p) => seen.push(p),
      });
      expect(seen.map((p) => `${p.done}/${p.total}`).at(-1)).toBe('3/3');
      return Object.fromEntries(seen.map((p) => [p.ref, p.outcome]));
    };
    const outcomes = (deploy: string, cached: string) => ({
      [`actions/cache@${SHA('c')}`]: cached,
      'octo/gone/.github/workflows/x.yml@v1': 'failed',
      'octo/ship/.github/workflows/deploy.yml@v1': deploy,
    });
    expect(await run()).toEqual(outcomes('fetched', 'fetched'));
    expect(await run()).toEqual(outcomes('cached', 'cached'));
  });

  it('rejects with what is not a fetch failure', async () => {
    const pin = () => {
      throw new Error('the host failed');
    };
    await expect(fetchRemoteClosure(project, pin, { ...opts, resolveUnpinned: false })).rejects.toThrow(
      'the host failed',
    );
  });
});
