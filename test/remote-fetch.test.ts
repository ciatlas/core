/**
 * Reading remote sources through an injected `fetch` (ported from flowpact's `remotes-fetch.test.ts`, which tested the
 * same requests through its lockfile update), against a fake GitHub API.
 */
import { createHash } from 'node:crypto';
import {
  apiHost,
  createGitHubClient,
  type FetchLike,
  fetchRemoteSourceAt,
  isFullSha,
  memoryRemoteCache,
  parseRemoteRef,
  type RemoteFetchError,
  type RemoteFetchOptions,
  type RemoteKind,
  type RemoteSourceKey,
  remoteKey,
  remoteSourceFiles,
  resolveRemoteCommit,
} from '@ciatlas/core';
import { describe, expect, it } from 'vitest';

const SHA = (c: string) => c.repeat(40);
const DEPLOY = 'on:\n  workflow_call:\n    inputs:\n      env: { type: string, required: true }\njobs: {}\n';
const SETUP = 'name: setup\nruns:\n  using: node24\n  main: index.js\n';
const digestOf = (bytes: string | Uint8Array) =>
  `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

/** A fake GitHub API (owner and repository in any letter case): commits by `<owner>/<repo>@<ref>`, files by `<owner>/<repo>/<path>@<sha>`; records each request. */
function fakeApi(commits: Record<string, string>, files: Record<string, string | Uint8Array>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    seen.push({ url: url.href, headers: init.headers });
    const m = /^(?:\/api\/v3|\/api\/github)?\/repos\/([^/]+)\/([^/]+)\/(commits|contents)\/(.+)$/.exec(
      decodeURIComponent(url.pathname),
    );
    const key =
      m &&
      (m[3] === 'commits'
        ? `${m[1]}/${m[2]}@${m[4]}`.toLowerCase()
        : `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/${m[4]}@${url.searchParams.get('ref')}`);
    const body = key ? (m![3] === 'commits' ? commits[key] : files[key]) : undefined;
    return body === undefined ? new Response('', { status: 404 }) : new Response(body, { status: 200 });
  };
  return { fetch, seen, paths: () => seen.map((s) => new URL(s.url).pathname) };
}

const github = () =>
  fakeApi(
    { 'octo/ship@v1': SHA('a'), 'octo/setup@v2': SHA('b') },
    {
      [`octo/ship/.github/workflows/deploy.yml@${SHA('a')}`]: DEPLOY,
      [`octo/setup/action.yml@${SHA('b')}`]: SETUP,
    },
  );

const ref = (raw: string, kind: RemoteKind = 'action') => parseRemoteRef(raw, kind)!;

/** A reference's source, as a host reads one with no pin: its ref resolved, then its file read at that commit. */
async function fetchOne(raw: string, opts: RemoteFetchOptions, kind: RemoteKind = 'action') {
  const r = ref(raw, kind);
  return fetchRemoteSourceAt(r, await resolveRemoteCommit(r, opts), opts);
}

/** The error a read fails with. */
const failure = (read: Promise<unknown>) =>
  read.then(
    () => expect.fail('the read succeeded'),
    (e: RemoteFetchError) => e,
  );

describe('remote references', () => {
  it('splits owner, repository, path and ref, and refuses what is not a remote reference', () => {
    expect(parseRemoteRef(' octo/ship/.github/workflows/d.yml@v1', 'workflow')).toEqual({
      raw: 'octo/ship/.github/workflows/d.yml@v1',
      kind: 'workflow',
      owner: 'octo',
      repo: 'ship',
      path: '.github/workflows/d.yml',
      ref: 'v1',
    });
    expect(parseRemoteRef('octo/setup@v2', 'action')).toMatchObject({ path: '', ref: 'v2' });
    for (const bad of ['docker://alpine:3', 'octo/setup', './local', 'octo@v1', 'octo/setup@v1@v2'])
      expect(parseRemoteRef(bad, 'action')).toBeUndefined();
  });

  it('names the files a reference is read from, and tells a full commit SHA', () => {
    expect(remoteSourceFiles({ kind: 'workflow', path: '.github/workflows/d.yml' })).toEqual([
      '.github/workflows/d.yml',
    ]);
    expect(remoteSourceFiles({ kind: 'action', path: '' })).toEqual(['action.yml', 'action.yaml']);
    expect(remoteSourceFiles({ kind: 'action', path: 'sub' })).toEqual(['sub/action.yml', 'sub/action.yaml']);
    expect(isFullSha(SHA('a'))).toBe(true);
    expect(isFullSha(SHA('A'))).toBe(true);
    expect(isFullSha(SHA('a').slice(1))).toBe(false);
    expect(isFullSha(SHA('g'))).toBe(false);
  });

  it("keys a reference by its owner and repository in lower case, and a root action's ref too", () => {
    expect(remoteKey('Octo/Ship/.github/workflows/d.yml@V1')).toBe('octo/ship/.github/workflows/d.yml@V1');
    // A root action's ref is in the second segment: two tags that differ only in case have one key.
    expect(remoteKey('Actions/Cache@V4')).toBe('actions/cache@v4');
    expect(remoteKey('actions/cache@v4')).toBe(remoteKey('Actions/Cache@V4'));
  });
});

describe('reading a remote source', () => {
  it('resolves the ref to a commit and reads the file there, as served', async () => {
    const api = github();
    const wf = await fetchOne('octo/ship/.github/workflows/deploy.yml@v1', { fetch: api.fetch }, 'workflow');
    expect(wf).toMatchObject({
      sha: SHA('a'),
      file: '.github/workflows/deploy.yml',
      text: DEPLOY,
      host: 'github.com',
    });
    expect(new TextDecoder().decode(wf.bytes)).toBe(DEPLOY);
    expect(wf.digest).toBe(digestOf(DEPLOY));
    expect(api.paths()).toEqual([
      '/repos/octo/ship/commits/v1',
      '/repos/octo/ship/contents/.github/workflows/deploy.yml',
    ]);
    expect(new URL(api.seen[1]!.url).searchParams.get('ref')).toBe(SHA('a'));
    expect(api.seen.map((s) => s.headers.accept)).toEqual([
      'application/vnd.github.sha',
      'application/vnd.github.raw',
    ]);
  });

  it('reads action.yml before action.yaml', async () => {
    const api = fakeApi({ 'octo/setup@v2': SHA('b') }, { [`octo/setup/sub/action.yaml@${SHA('b')}`]: SETUP });
    const source = await fetchOne('octo/setup/sub@v2', { fetch: api.fetch });
    expect(source.file).toBe('sub/action.yaml');
    expect(api.paths()).toEqual([
      '/repos/octo/setup/commits/v2',
      '/repos/octo/setup/contents/sub/action.yml',
      '/repos/octo/setup/contents/sub/action.yaml',
    ]);
  });

  it('keeps the bytes as served and gives the parser text without a byte order mark', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(SETUP)]);
    const api = fakeApi({ 'octo/setup@v2': SHA('b') }, { [`octo/setup/action.yml@${SHA('b')}`]: bytes });
    const source = await fetchOne('octo/setup@v2', { fetch: api.fetch });
    expect(source.text).toBe(SETUP);
    expect(source.bytes).toEqual(bytes);
    expect(source.digest).toBe(digestOf(bytes));
  });

  it('sends the token to the API only, and a user agent only when given one', async () => {
    const api = github();
    await fetchOne('octo/setup@v2', {
      fetch: api.fetch,
      api: { apiUrl: 'https://api.github.com/', token: 't0k3n' },
    });
    expect(api.seen.map((s) => s.headers)).toEqual(
      Array(2).fill({
        accept: expect.any(String),
        authorization: 'Bearer t0k3n',
        'x-github-api-version': '2022-11-28',
      }),
    );
    expect(api.seen.every((s) => s.url.startsWith('https://api.github.com/repos/'))).toBe(true);
    const named = github();
    await fetchOne('octo/setup@v2', { fetch: named.fetch, userAgent: 'simulci' });
    expect(named.seen.every((s) => s.headers['user-agent'] === 'simulci' && !s.headers.authorization)).toBe(
      true,
    );
  });

  it('reads through a proxy, naming the host it serves', async () => {
    const api = github();
    const source = await fetchOne('octo/setup@v2', {
      fetch: api.fetch,
      api: { apiUrl: 'https://app.example/api/github', token: 'session', host: 'github.com' },
    });
    expect(source.host).toBe('github.com');
    expect(api.seen.map((s) => s.url.split('?')[0])).toEqual([
      'https://app.example/api/github/repos/octo/setup/commits/v2',
      'https://app.example/api/github/repos/octo/setup/contents/action.yml',
    ]);
    expect(api.seen.every((s) => s.headers.authorization === 'Bearer session')).toBe(true);
  });

  it('refuses a commit that is not a full SHA, and says which file a commit lacks', async () => {
    const api = github();
    const short = await failure(fetchRemoteSourceAt(ref('octo/setup@v2'), 'abc1234', { fetch: api.fetch }));
    expect(short).toMatchObject({ kind: 'other', message: 'abc1234 is not a full commit SHA' });
    expect(api.seen).toEqual([]);
    const opts = { fetch: api.fetch, retryDelayMs: 0 };
    const wf = await failure(
      fetchRemoteSourceAt(ref('octo/ship/.github/workflows/x.yml@v1', 'workflow'), SHA('a'), opts),
    );
    expect(wf).toMatchObject({ kind: 'not-found', message: `.github/workflows/x.yml not found at aaaaaaa` });
    const action = await failure(fetchRemoteSourceAt(ref('octo/setup@v2'), SHA('A'), opts));
    expect(action).toMatchObject({
      kind: 'not-found',
      message: 'no action.yml in the repository root at aaaaaaa',
    });
  });
});

describe('names that would leave the repository', () => {
  it('refuses a "." or ".." name before sending anything, and a client path made of one', async () => {
    const api = github();
    const opts = { fetch: api.fetch, api: { apiUrl: 'https://api.github.com', token: 't' } };
    for (const raw of ['octo/ship/../../../user@v1', '../..@v1', 'octo/setup@..', 'octo/./x@v1']) {
      const r = ref(raw, 'workflow');
      expect(await failure(resolveRemoteCommit(r, opts))).toMatchObject({ kind: 'other' });
      expect(await failure(fetchRemoteSourceAt(r, SHA('a'), opts))).toMatchObject({
        kind: 'other',
        message: `${raw} has a "." or ".." name, which no repository has`,
      });
    }
    const client = createGitHubClient(opts);
    for (const path of ['/repos/o/r/../../user', '/repos/%2E%2e/user', '/repos\\..\\user', '/repos/o/r/.'])
      await expect(client.json(path)).rejects.toThrow(TypeError);
    expect(api.seen).toEqual([]);
  });
});

describe('limits', () => {
  const big =
    (body: () => Response): FetchLike =>
    async (url) =>
      url.includes('/commits/') ? new Response(SHA('a')) : body();

  it('refuses a response over 1 MB, by what it holds or by its length header', async () => {
    const streamed = await failure(
      fetchOne('octo/big@v1', { fetch: big(() => new Response(`# ${'x'.repeat(1_000_001)}`)) }),
    );
    expect(streamed).toMatchObject({
      kind: 'too-large',
      message: 'a response over 1000000 bytes',
      status: 200,
    });
    const told = big(() => new Response('#', { headers: { 'content-length': '1000001' } }));
    expect(await failure(fetchOne('octo/big@v1', { fetch: told }))).toMatchObject({ kind: 'too-large' });
  });

  it('takes another limit when given one, and does not ask again for a response too large', async () => {
    let sent = 0;
    const counted: FetchLike = async (url, init) => {
      sent++;
      return big(() => new Response(`# ${'x'.repeat(50)}`))(url, init);
    };
    const e = await failure(fetchOne('octo/big@v1', { fetch: counted, maxFileBytes: 50 }));
    expect(e).toMatchObject({ kind: 'too-large', message: 'a response over 50 bytes' });
    expect(sent).toBe(2);
  });
});

describe('unreadable references', () => {
  it('takes a SHA that is no commit of the repository (422) as not found, and a server error as a failure', async () => {
    const api: FetchLike = async (url) =>
      url.includes('/repos/octo/odd/')
        ? new Response('', { status: 422 })
        : new Response('', { status: 502, statusText: 'Bad Gateway' });
    expect(await failure(fetchOne('octo/odd@0123', { fetch: api, retryDelayMs: 0 }))).toMatchObject({
      message: 'octo/odd@0123 not found, or not readable with this token',
      kind: 'not-found',
      host: 'github.com',
    });
    expect(await failure(fetchOne('octo/down@v1', { fetch: api, retryDelayMs: 0 }))).toMatchObject({
      message: '502 Bad Gateway from the GitHub API',
      kind: 'server',
      status: 502,
    });
  });
});

describe('a 404 the GitHub API answers now and then', () => {
  /** The fake API, answering 404 the first time each URL whose path matches `matches` is asked for. */
  function flaky(api: ReturnType<typeof fakeApi>, matches: RegExp): FetchLike {
    const asked = new Set<string>();
    return async (url, init) => {
      if (matches.test(new URL(url).pathname) && !asked.has(url)) {
        asked.add(url);
        return new Response('', { status: 404 });
      }
      return api.fetch(url, init);
    };
  }

  it('asks once more for a file or a commit, rather than taking the reference as unreadable', async () => {
    for (const matches of [/\/contents\//, /\/commits\//]) {
      const source = await fetchOne('octo/setup@v2', { fetch: flaky(github(), matches), retryDelayMs: 0 });
      expect(source.sha).toBe(SHA('b'));
    }
  });

  it('still finds a reference that is not there unreadable, after one more request', async () => {
    const api = fakeApi({}, {});
    expect(await failure(fetchOne('octo/setup@v2', { fetch: api.fetch, retryDelayMs: 0 }))).toMatchObject({
      kind: 'not-found',
    });
    expect(api.paths()).toEqual(['/repos/octo/setup/commits/v2', '/repos/octo/setup/commits/v2']);
  });
});

describe('failures that pass', () => {
  /** The fake API, after these answers to the first requests (an Error is the network's). */
  function first(answers: (Response | Error)[], api = github()) {
    let n = 0;
    const fetch: FetchLike = async (url, init) => {
      n++;
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? api.fetch(url, init);
    };
    return { fetch, sent: () => n };
  }
  const read = (fetch: FetchLike) => fetchOne('octo/setup@v2', { fetch, retryDelayMs: 0 });
  const status = (code: number, headers: Record<string, string> = {}) =>
    new Response('', { status: code, headers });

  it('sends a request again after a server error or no answer, three times at most', async () => {
    for (const fail of [status(502), status(503), new TypeError('fetch failed')]) {
      const api = first([fail]);
      expect((await read(api.fetch)).sha).toBe(SHA('b'));
      expect(api.sent()).toBe(3); // the failure, then the commit and the file
    }
    const down = first([status(503), status(503), status(503)]);
    expect(await failure(read(down.fetch))).toMatchObject({
      message: '503 from the GitHub API',
      kind: 'server',
    });
    expect(down.sent()).toBe(3);
  });

  it('waits as long as the secondary rate limit asks, up to a minute', async () => {
    const soon = first([status(403, { 'retry-after': '0' }), status(429)]);
    expect((await read(soon.fetch)).sha).toBe(SHA('b'));
    expect(soon.sent()).toBe(4);
    const later = first([status(429, { 'retry-after': '3600' })]);
    expect(await failure(read(later.fetch))).toMatchObject({
      message: 'the GitHub API asks to slow down (429): try again in 3600 s',
      kind: 'rate-limit',
      status: 429,
      retryAfterS: 3600,
    });
    expect(later.sent()).toBe(1);
  });

  it('does not send again what another try cannot change', async () => {
    const usedUp = status(403, { 'x-ratelimit-remaining': '0' });
    for (const [answer, error] of [
      [status(401), /asks for a token/],
      [status(403), /refused the request/],
      [usedUp, /rate limit is used up/],
      [status(429, { 'x-ratelimit-remaining': '0' }), /rate limit is used up/],
    ] as const) {
      const api = first([answer]);
      expect((await failure(read(api.fetch))).message).toMatch(error);
      expect(api.sent()).toBe(1);
    }
  });

  it('says how long until a used-up rate limit resets', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const api = first([status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset })]);
    const e = await failure(read(api.fetch));
    expect(e.retryAfterS).toBeGreaterThan(590);
    expect(e.retryAfterS).toBeLessThanOrEqual(601);
  });

  it('says why it sends a request again', async () => {
    const events: string[] = [];
    const api = first([
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
      new Response('', { status: 503, statusText: 'Service Unavailable' }),
    ]);
    await fetchOne('octo/setup@v2', {
      fetch: api.fetch,
      retryDelayMs: 0,
      onRetry: (r) => events.push(`${r.host}: ${r.why}, attempt ${r.attempt} of ${r.attempts}`),
    });
    expect(events).toEqual([
      'api.github.com: connection timed out, attempt 2 of 3',
      'api.github.com: 503 Service Unavailable, attempt 3 of 3',
    ]);
  });
});

describe('a host that cannot be reached', () => {
  const refs = Array.from({ length: 12 }, (_, i) => `octo/a${i}@v1`);
  /** A fetch that always fails as `fail` says, counting the requests to each host. */
  function always(fail: () => Response | Error) {
    const sent = new Map<string, number>();
    const fetch: FetchLike = async (url) => {
      const { host } = new URL(url);
      sent.set(host, (sent.get(host) ?? 0) + 1);
      const answer = fail();
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { fetch, sent: (host = 'api.github.com') => sent.get(host) ?? 0 };
  }
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const readAll = async (opts: RemoteFetchOptions, raws = refs) => {
    const errors: RemoteFetchError[] = [];
    for (const raw of raws) errors.push(await failure(fetchOne(raw, { retryDelayMs: 0, ...opts })));
    return errors;
  };

  it('fails the references after the first that could not reach it at once, without sending them', async () => {
    const api = always(refused);
    const errors = await readAll({ fetch: api.fetch, unreachableHosts: new Map() });
    expect(new Set(errors.map((e) => `${e.kind}: ${e.message}`))).toEqual(
      new Set(['unreachable: could not reach https://api.github.com (ECONNREFUSED)']),
    );
    expect(api.sent()).toBe(3);
    // A timeout counts as well.
    const slow = always(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await readAll({ fetch: slow.fetch, unreachableHosts: new Map() });
    expect(slow.sent()).toBe(3);
  });

  it('still sends each request to a host that answers, with errors', async () => {
    const api = always(() => new Response('', { status: 503 }));
    const errors = await readAll({ fetch: api.fetch, unreachableHosts: new Map() });
    expect(errors.map((e) => e.kind)).toEqual(Array(12).fill('server'));
    expect(api.sent()).toBe(36);
  });

  it('is remembered by whoever is given the same map, host by host', async () => {
    const unreachableHosts = new Map<string, RemoteFetchError>();
    await readAll({ fetch: always(refused).fetch, unreachableHosts }, refs.slice(0, 1));
    expect([...unreachableHosts.keys()]).toEqual(['api.github.com']);
    const again = always(refused);
    const errors = await readAll({ fetch: again.fetch, unreachableHosts });
    expect(errors.map((e) => e.kind)).toEqual(Array(12).fill('unreachable'));
    expect(again.sent()).toBe(0);
    // Another host is asked as usual.
    const elsewhere = always(refused);
    await readAll(
      { fetch: elsewhere.fetch, unreachableHosts, api: { apiUrl: 'https://gh.corp.example/api/v3' } },
      refs.slice(0, 1),
    );
    expect(elsewhere.sent('gh.corp.example')).toBe(3);
  });
});

describe('failures state what failed and its kind', () => {
  const failing =
    (fail: () => Response): FetchLike =>
    async () =>
      fail();
  const error = (fail: () => Response, token?: string) =>
    failure(
      fetchOne('octo/setup@v2', {
        fetch: failing(fail),
        retryDelayMs: 0,
        ...(token ? { api: { apiUrl: 'https://api.github.com', token } } : {}),
      }),
    );
  const offline = (code: string) => () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code } });
  };
  const slow = () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  };

  it('names the network error behind `fetch failed`, and a timeout', async () => {
    expect(await error(offline('ENOTFOUND'))).toMatchObject({
      message: 'could not reach https://api.github.com (ENOTFOUND)',
      brief: 'host not found',
    });
    expect(await error(slow)).toMatchObject({
      message: 'no answer from https://api.github.com within 30 s',
      brief: 'no answer within 30 s',
    });
  });

  it('tells a rejected token from a missing one, a used-up rate limit and a refused request', async () => {
    expect((await error(() => new Response('', { status: 401 }), 't')).message).toBe(
      'the GitHub API rejected the token (401)',
    );
    expect((await error(() => new Response('', { status: 401 }))).message).toBe(
      'the GitHub API asks for a token (401)',
    );
    const limited = () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    expect((await error(limited)).message).toBe('the GitHub API rate limit is used up (403)');
    expect((await error(() => new Response('', { status: 403 }), 't')).message).toBe(
      'the GitHub API refused the request (403)',
    );
  });

  it('tells the kind of each failure, for what to check', async () => {
    const kind = async (fail: () => Response, token?: string) => (await error(fail, token)).kind;
    expect(await kind(offline('ECONNREFUSED'))).toBe('unreachable');
    expect(await kind(slow)).toBe('timeout');
    expect(await kind(() => new Response('', { status: 401 }), 't')).toBe('token');
    expect(await kind(() => new Response('', { status: 403 }), 't')).toBe('access');
    expect(
      await kind(() => new Response('', { status: 429, headers: { 'x-ratelimit-remaining': '0' } })),
    ).toBe('rate-limit');
    expect(await kind(() => new Response('', { status: 500 }))).toBe('server');
    expect(await kind(() => new Response('', { status: 418 }))).toBe('other');
  });

  it('never says the token, whatever the fetch or the server says', async () => {
    const token = 'ghp_s3cr3t';
    const echoes = [
      () => {
        throw new TypeError(`bad header: authorization: Bearer ${token}`);
      },
      () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { message: `refused Bearer ${token}` } });
      },
      () => new Response('', { status: 400, statusText: `Bad token ${token}` }),
      () => new Response('', { status: 401, statusText: token }),
      () => new Response('', { status: 503, statusText: token }),
    ];
    for (const echo of echoes) {
      const e = await error(echo, token);
      expect(`${e.message} ${e.brief} ${e.stack}`).not.toContain(token);
      expect(e.message).toContain('***');
    }
    // Nor does a retry's notice.
    const why: string[] = [];
    await failure(
      fetchOne('octo/setup@v2', {
        fetch: failing(echoes[4]!),
        retryDelayMs: 0,
        api: { apiUrl: 'https://api.github.com', token },
        onRetry: (r) => why.push(r.why),
      }),
    );
    expect(why).toEqual(['503 ***', '503 ***']);
  });

  it('times out after `timeoutMs`', async () => {
    const hang: FetchLike = (_, init) =>
      new Promise((_, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)));
    expect(
      await failure(fetchOne('octo/setup@v2', { fetch: hang, timeoutMs: 20, retryDelayMs: 0 })),
    ).toMatchObject({
      kind: 'timeout',
      message: 'no answer from https://api.github.com within 0.02 s',
    });
  });
});

describe('cancelling a read', () => {
  it('rejects with the signal’s reason, sending nothing once it is aborted', async () => {
    const api = github();
    const stop = new AbortController();
    stop.abort();
    const e = await failure(fetchOne('octo/setup@v2', { fetch: api.fetch, signal: stop.signal }));
    expect((e as Error).name).toBe('AbortError');
    expect(api.seen).toEqual([]);
  });

  it('stops a request in flight and a wait between attempts, without marking the host unreachable', async () => {
    const unreachableHosts = new Map<string, RemoteFetchError>();
    const stop = new AbortController();
    const hang: FetchLike = (_, init) => {
      setTimeout(() => stop.abort(), 1);
      return new Promise((_, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason)));
    };
    const inFlight = await failure(
      fetchOne('octo/setup@v2', { fetch: hang, signal: stop.signal, unreachableHosts }),
    );
    expect((inFlight as Error).name).toBe('AbortError');
    const waiting = new AbortController();
    let sent = 0;
    const down: FetchLike = async () => {
      sent++;
      setTimeout(() => waiting.abort(), 1);
      return new Response('', { status: 503 });
    };
    const started = Date.now();
    const e = await failure(
      fetchOne('octo/setup@v2', {
        fetch: down,
        signal: waiting.signal,
        retryDelayMs: 60_000,
        unreachableHosts,
      }),
    );
    expect((e as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(sent).toBe(1);
    expect(unreachableHosts.size).toBe(0);
  });
});

describe('GitHub Enterprise Server and github.com through GitHub Connect', () => {
  const GHES = 'https://ghes.example/api/v3';
  const ROUTES: Record<string, string> = {
    'ghes.example/repos/corp/internal/commits/v1': SHA('c'),
    'ghes.example/repos/corp/internal/contents/action.yml': SETUP,
    'api.github.com/repos/octo/setup/commits/v2': SHA('b'),
    'api.github.com/repos/octo/setup/contents/action.yml': SETUP,
  };
  /** The enterprise server has corp/internal; github.com has octo/setup. Records every request with its host and token. */
  function twoHosts() {
    const seen: { host: string; auth: string | undefined }[] = [];
    const fetch: FetchLike = async (input, init) => {
      const url = new URL(input);
      seen.push({ host: url.host, auth: init.headers.authorization });
      const path = decodeURIComponent(url.pathname).replace(/^\/api\/v3/, '');
      const body = ROUTES[`${url.host}${path}`];
      return body === undefined ? new Response('', { status: 404 }) : new Response(body);
    };
    return { fetch, seen };
  }

  it('asks only the enterprise server unless told to look on github.com', async () => {
    const api = twoHosts();
    const opts = { fetch: api.fetch, api: { apiUrl: GHES, token: 'ghes' }, retryDelayMs: 0 };
    expect(await fetchOne('corp/internal@v1', opts)).toMatchObject({ sha: SHA('c'), host: 'ghes.example' });
    expect(await failure(fetchOne('octo/setup@v2', opts))).toMatchObject({
      kind: 'not-found',
      host: 'ghes.example',
    });
    expect(api.seen.every((r) => r.host === 'ghes.example' && r.auth === 'Bearer ghes')).toBe(true);
  });

  it('looks on github.com for what the enterprise server lacks, with its own token, never the enterprise one', async () => {
    const api = twoHosts();
    const cache = memoryRemoteCache();
    const opts: RemoteFetchOptions = {
      fetch: api.fetch,
      api: { apiUrl: GHES, token: 'ghes' },
      fallback: { apiUrl: 'https://api.github.com', token: 'dotcom' },
      cache,
      retryDelayMs: 0,
    };
    expect(await fetchOne('corp/internal@v1', opts)).toMatchObject({ host: 'ghes.example' });
    expect(await fetchOne('octo/setup@v2', opts)).toMatchObject({ sha: SHA('b'), host: 'github.com' });
    expect(api.seen.filter((r) => r.host === 'api.github.com').every((r) => r.auth === 'Bearer dotcom')).toBe(
      true,
    );
    expect(api.seen.filter((r) => r.host === 'ghes.example').every((r) => r.auth === 'Bearer ghes')).toBe(
      true,
    );
    // The file read on github.com is kept under github.com.
    const key = { owner: 'octo', repo: 'setup', sha: SHA('b'), file: 'action.yml' };
    expect(cache.get({ host: 'github.com', ...key })).toBeDefined();
    expect(cache.get({ host: 'ghes.example', ...key })).toBeUndefined();
    // Without a github.com token, it asks github.com without one.
    const anon = twoHosts();
    await fetchOne('octo/setup@v2', {
      ...opts,
      fetch: anon.fetch,
      fallback: { apiUrl: 'https://api.github.com' },
      cache: memoryRemoteCache(),
    });
    expect(anon.seen.filter((r) => r.host === 'api.github.com').map((r) => r.auth)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('reports the fallback’s failure when neither has the reference', async () => {
    const api = twoHosts();
    const e = await failure(
      fetchOne('octo/gone@v1', {
        fetch: api.fetch,
        api: { apiUrl: GHES, token: 'ghes' },
        fallback: { apiUrl: 'https://api.github.com' },
        retryDelayMs: 0,
      }),
    );
    expect(e).toMatchObject({ kind: 'not-found', host: 'github.com' });
  });

  it('names the host an API serves', () => {
    expect(apiHost('https://api.github.com')).toBe('github.com');
    expect(apiHost('https://api.github.com/')).toBe('github.com');
    expect(apiHost('https://ghes.example/api/v3')).toBe('ghes.example');
    expect(apiHost('https://api.acme.ghe.com')).toBe('acme.ghe.com');
    // A GHES whose name starts with `api.` keeps it.
    expect(apiHost('https://api.corp.example/api/v3')).toBe('api.corp.example');
  });
});

describe('the cache', () => {
  const key = (file = 'action.yml'): RemoteSourceKey => ({
    host: 'github.com',
    owner: 'octo',
    repo: 'setup',
    sha: SHA('b'),
    file,
  });

  it('is read once the commit is known, and written after the API answers', async () => {
    const cache = memoryRemoteCache();
    const api = github();
    await fetchOne('Octo/Setup@v2', { fetch: api.fetch, cache });
    expect(new TextDecoder().decode(await cache.get(key()))).toBe(SETUP);
    const again = github();
    const source = await fetchOne('octo/setup@v2', { fetch: again.fetch, cache });
    expect(source).toMatchObject({
      text: SETUP,
      file: 'action.yml',
      digest: digestOf(SETUP),
      host: 'github.com',
    });
    // The ref is not a cache entry: it is resolved again.
    expect(again.paths()).toEqual(['/repos/octo/setup/commits/v2']);
  });

  it('finds action.yaml there when the commit has no action.yml', async () => {
    const cache = memoryRemoteCache();
    cache.set(key('action.yaml'), new TextEncoder().encode(SETUP));
    const api = github();
    const source = await fetchRemoteSourceAt(ref('octo/setup@v2'), SHA('b'), { fetch: api.fetch, cache });
    expect(source.file).toBe('action.yaml');
    expect(api.seen).toEqual([]);
  });

  it('checks a pinned digest, reading again what the cache holds under another', async () => {
    const r = ref('octo/setup@v2');
    const cache = memoryRemoteCache();
    cache.set(key(), new TextEncoder().encode('tampered'));
    const api = github();
    const source = await fetchRemoteSourceAt(r, SHA('b'), {
      fetch: api.fetch,
      cache,
      expectDigest: digestOf(SETUP),
    });
    expect(source.text).toBe(SETUP);
    expect(api.paths()).toEqual(['/repos/octo/setup/contents/action.yml']);
    expect(new TextDecoder().decode(await cache.get(key()))).toBe(SETUP);
    const fresh = memoryRemoteCache();
    const e = await failure(
      fetchRemoteSourceAt(r, SHA('b'), { fetch: api.fetch, cache: fresh, expectDigest: digestOf('other') }),
    );
    expect(e).toMatchObject({ kind: 'digest' });
    expect(e.message).toBe(
      `the digest of octo/setup/action.yml at bbbbbbb is ${digestOf(SETUP)}, not ${digestOf('other')}`,
    );
    expect(fresh.get(key())).toBeUndefined();
  });

  it('is a miss, or not written, when it throws', async () => {
    const broken = {
      get: () => {
        throw new Error('disk');
      },
      set: async () => {
        throw new Error('disk');
      },
    };
    expect((await fetchOne('octo/setup@v2', { fetch: github().fetch, cache: broken })).text).toBe(SETUP);
  });

  it('keeps what fits in memory, dropping the least recently used', () => {
    const cache = memoryRemoteCache(10);
    const bytes = (n: number) => new Uint8Array(n);
    cache.set(key('a'), bytes(4));
    cache.set(key('b'), bytes(4));
    cache.get(key('a'));
    cache.set(key('c'), bytes(4));
    const sizes = ['a', 'b', 'c'].map((f) => (cache.get(key(f)) as Uint8Array | undefined)?.length);
    expect(sizes).toEqual([4, undefined, 4]);
    cache.set(key('d'), bytes(11));
    expect(cache.get(key('d'))).toBeUndefined();
    // It keeps a copy, and one key in any letter case.
    const mine = bytes(2);
    cache.set({ ...key('e'), owner: 'OCTO' }, mine);
    mine[0] = 7;
    expect(cache.get(key('e'))).toEqual(bytes(2));
    // A file's path keeps its case.
    expect(cache.get(key('E'))).toBeUndefined();
  });
});

describe('a client of the GitHub API', () => {
  const headers = {
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': '57',
    'x-ratelimit-reset': '1700000000',
  };
  function api() {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, headers: init.headers });
      if (url.endsWith('/repos/octo/ship')) return Response.json({ private: false }, { headers });
      if (url.endsWith('/raw')) return new Response('bytes');
      if (url.endsWith('/odd')) return new Response('{');
      return new Response('', { status: 404 });
    };
    return { fetch, seen };
  }

  it('reads JSON and bytes with the token, and reports the rate limit', async () => {
    const a = api();
    const client = createGitHubClient({
      fetch: a.fetch,
      api: { apiUrl: 'https://ghes.example/api/v3/', token: 't' },
    });
    expect(client.rateLimit()).toEqual({});
    const repo = await client.json<{ private: boolean }>('/repos/octo/ship');
    expect(repo?.body).toEqual({ private: false });
    expect(repo?.headers.get('x-ratelimit-remaining')).toBe('57');
    expect(client.rateLimit()).toEqual({ limit: 60, remaining: 57, resetAt: 1_700_000_000_000 });
    expect(new TextDecoder().decode(await client.bytes('/raw', 'application/vnd.github.raw'))).toBe('bytes');
    expect(await client.json('/repos/octo/gone')).toBeUndefined();
    expect(a.seen.map((s) => s.url)).toEqual([
      'https://ghes.example/api/v3/repos/octo/ship',
      'https://ghes.example/api/v3/raw',
      'https://ghes.example/api/v3/repos/octo/gone',
    ]);
    expect(a.seen.map((s) => [s.headers.accept, s.headers.authorization])).toEqual([
      ['application/vnd.github+json', 'Bearer t'],
      ['application/vnd.github.raw', 'Bearer t'],
      ['application/vnd.github+json', 'Bearer t'],
    ]);
    expect(await failure(client.json('/odd'))).toMatchObject({ kind: 'other' });
  });

  it('refuses a path that is not one of its API', async () => {
    const a = api();
    const client = createGitHubClient({
      fetch: a.fetch,
      api: { apiUrl: 'https://api.github.com', token: 't' },
    });
    for (const path of ['https://evil.example/x', '//evil.example/x', 'repos/octo/ship', '@evil.example/x'])
      await expect(client.json(path)).rejects.toThrow(TypeError);
    expect(a.seen).toEqual([]);
  });
});
