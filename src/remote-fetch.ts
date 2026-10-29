/**
 * Remote sources over the GitHub REST API: a remote reference's ref resolved to a commit, and its workflow file or
 * `action.yml` read at that commit. What it does I/O with is injected (`fetch`, the token, a cache), so it runs in Node
 * and in the browser; it imports `remote-ref.ts` only (`@ciatlas/core/remote-fetch` serves both without the parser).
 *
 * The token goes only into the `authorization` header of requests to its API's origin, and into no message: a fallback
 * API gets its own token or none. Messages state what failed and its status; advice is the host's, by `kind`.
 */
import { isFullSha, type RemoteRef, remoteSourceFiles } from './remote-ref';

export * from './remote-ref';

/** The `fetch` this module calls: Node's, the page's, or a test's. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

/** A GitHub REST API to read from, and the token to read it with. */
export interface GitHubApi {
  /** Absolute: `https://api.github.com`, `https://HOST/api/v3` on GHES, or a proxy's URL. */
  apiUrl: string;
  /** Sent only to `apiUrl`'s origin, in the `authorization` header; never in a message. */
  token?: string;
  /** The GitHub host the API serves, for a proxy whose URL does not tell it; by default `apiHost(apiUrl)`. */
  host?: string;
}

export const GITHUB_COM_API = 'https://api.github.com';

/**
 * The GitHub host an API serves: `github.com` for `https://api.github.com`, `acme.ghe.com` for
 * `https://api.acme.ghe.com`, and the server for `https://HOST/api/v3`, whose name is kept as it is (a GHES may be
 * called `api.corp.example`). `api.` is dropped only from an API at the root of its host.
 */
export function apiHost(apiUrl: string): string {
  const { hostname, pathname } = new URL(apiUrl);
  return hostname.startsWith('api.') && pathname.replace(/\/+$/, '') === '' ? hostname.slice(4) : hostname;
}

/**
 * Why a remote source could not be read, for what to check: `unreachable` (no connection to the API), `timeout` (no
 * answer in time), `token` (401: the API refused the token, or wants one), `access` (403: the token may not read it),
 * `rate-limit`, `server` (5xx), `not-found` (it does not exist, or the token cannot read it), `too-large` (over
 * `maxFileBytes`), `digest` (not the file `expectDigest` names), or `other`.
 */
export type RemoteFailureKind =
  | 'unreachable'
  | 'timeout'
  | 'token'
  | 'access'
  | 'rate-limit'
  | 'server'
  | 'not-found'
  | 'too-large'
  | 'digest'
  | 'other';

/** A failure to read from a GitHub API: its kind, the GitHub host asked (`GitHubApi.host`), and the HTTP status. */
export class RemoteFetchError extends Error {
  override readonly name = 'RemoteFetchError';

  constructor(
    message: string,
    readonly kind: RemoteFailureKind,
    readonly host: string,
    readonly status?: number,
    /** For a `rate-limit`: how long the API asks to wait, or how long until its limit resets. */
    readonly retryAfterS?: number,
    /** Short, for a retry's notice: `connection refused`, `no answer within 30 s`. */
    readonly brief = message,
  ) {
    super(message);
  }
}

/** A remote reference's file at a commit, as served, and where it was read. */
export interface RemoteSource {
  ref: RemoteRef;
  /** The commit, lower-case. */
  sha: string;
  /** Its path in the repository: the workflow file, or the `action.yml` or `action.yaml` found. */
  file: string;
  bytes: Uint8Array;
  /** `bytes` as UTF-8, without a byte order mark, for the parser. */
  text: string;
  /** `sha256-` and the base64 of the SHA-256 of `bytes`. */
  digest: string;
  /** The GitHub host of the API that served it (`GitHubApi.host`): the fallback's when it did. */
  host: string;
}

/** A remote source's address in a cache: `host`, `owner` and `repo` lower-case, `sha` a full lower-case commit SHA. */
export interface RemoteSourceKey {
  host: string;
  owner: string;
  repo: string;
  sha: string;
  file: string;
}

/**
 * Where remote sources are kept between reads. Content-addressed: a file at a commit never changes, so nothing in it goes
 * stale. Implementations never throw (a failure the fetcher catches is taken as a miss, or as not kept).
 */
export interface RemoteSourceCache {
  get(key: RemoteSourceKey): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  set(key: RemoteSourceKey, bytes: Uint8Array): void | Promise<void>;
}

/** A cache in memory, of `maxBytes` at most (32 MiB by default): over that, the least recently used go first. */
export function memoryRemoteCache(maxBytes = 32 * 1024 * 1024): RemoteSourceCache {
  const entries = new Map<string, Uint8Array>();
  let size = 0;
  // The file's path keeps its case: a repository may hold `Deploy.yml` and `deploy.yml`.
  const keyOf = (k: RemoteSourceKey) =>
    `${[k.host, k.owner, k.repo, k.sha].join('\n').toLowerCase()}\n${k.file}`;
  const drop = (key: string) => {
    size -= entries.get(key)?.byteLength ?? 0;
    entries.delete(key);
  };
  return {
    get(k) {
      const key = keyOf(k);
      const bytes = entries.get(key);
      if (bytes) {
        entries.delete(key);
        entries.set(key, bytes);
      }
      return bytes;
    },
    set(k, bytes) {
      if (bytes.byteLength > maxBytes) return;
      const key = keyOf(k);
      drop(key);
      entries.set(key, bytes.slice());
      size += bytes.byteLength;
      for (const oldest of entries.keys()) {
        if (size <= maxBytes) break;
        drop(oldest);
      }
    },
  };
}

export interface RemoteFetchOptions {
  /** The API to read from: `GITHUB_COM_API`, anonymously, by default. */
  api?: GitHubApi;
  /**
   * Where to look for what `api` does not have, as GHES's runner does through GitHub Connect: github.com's API, with its
   * own token (never `api.token`). Opt-in: it sends the names of what the enterprise server lacks to github.com.
   */
  fallback?: GitHubApi;
  /** By default `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Read before a file is requested, once its commit is known, and written after. */
  cache?: RemoteSourceCache;
  /** Cancels what is in flight and the waits between attempts; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** The `user-agent` header, sent only when set (a page leaves it to the browser). */
  userAgent?: string;
  /** Requests at a time, for the functions that read many references. Default 8. */
  concurrency?: number;
  /** How long a request may take, its body included. Default 30 s. */
  timeoutMs?: number;
  /**
   * The first wait before a request is sent again: after a 404 for a commit or file, which GitHub's API now and then
   * answers for one it has, and, growing exponentially, after a failure that passes. Default 300 ms.
   */
  retryDelayMs?: number;
  /** The largest response read; a larger one fails as `too-large`. Default 1,000,000 bytes. */
  maxFileBytes?: number;
  /**
   * The hosts that did not answer, shared by every request made with it: once a request found a host unreachable
   * (`unreachable` or `timeout`, after all its attempts), each later request to it fails the same way at once.
   */
  unreachableHosts?: Map<string, RemoteFetchError>;
  /** Called as each reference is done, by the functions that read many references. */
  onProgress?: (p: {
    done: number;
    total: number;
    ref: string;
    outcome: 'fetched' | 'cached' | 'failed';
  }) => void;
  /** Called before a request that failed in a way that passes is sent again: to which host, why, after how long. */
  onRetry?: (r: { host: string; attempt: number; attempts: number; why: string; waitMs: number }) => void;
}

/**
 * The commit a remote reference's ref points at now, lower-case, from `GET /repos/{owner}/{repo}/commits/{ref}`
 * (a full SHA is checked the same way). On `not-found`, `fallback` is asked when set.
 */
export async function resolveRemoteCommit(r: RemoteRef, opts: RemoteFetchOptions = {}): Promise<string> {
  checkNames(r, targetOf(opts.api));
  return withFallback(opts, async (at) => {
    const body = await onceMore(
      () => get(`${repoUrl(r, at)}/commits/${encodeURIComponent(r.ref)}`, 'application/vnd.github.sha', at),
      opts,
    );
    const sha = body && decode(body).trim();
    if (!sha || !isFullSha(sha)) throw notFound(`${r.owner}/${r.repo}@${r.ref}`, at);
    return sha.toLowerCase();
  });
}

/**
 * A remote reference's file at a commit: its workflow file, or its `action.yml` (else `action.yaml`), from the cache
 * when it has it, else from `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` (then kept in the cache). On
 * `not-found`, `fallback` is asked when set. With `expectDigest`, a file whose digest differs fails as `digest`.
 */
export async function fetchRemoteSourceAt(
  r: RemoteRef,
  sha: string,
  opts: RemoteFetchOptions & { expectDigest?: string } = {},
): Promise<RemoteSource> {
  const targets = [targetOf(opts.api), ...(opts.fallback ? [targetOf(opts.fallback)] : [])];
  checkNames(r, targets[0]!);
  if (!isFullSha(sha))
    throw new RemoteFetchError(`${sha} is not a full commit SHA`, 'other', targets[0]!.host);
  const commit = sha.toLowerCase();
  for (const t of targets) {
    const cached = await fromCache(r, commit, t, opts);
    if (cached) return cached;
  }
  return withFallback(opts, async (at) => {
    const found = await onceMore(() => firstSource(r, commit, at), opts);
    if (!found) {
      const what =
        r.kind === 'workflow' ? `${r.path} not found` : `no action.yml in ${r.path || 'the repository root'}`;
      throw new RemoteFetchError(`${what} at ${commit.slice(0, 7)}`, 'not-found', at.t.host);
    }
    const source = await sourceOf(r, commit, found.file, found.bytes, at.t.host);
    if (opts.expectDigest !== undefined && source.digest !== opts.expectDigest)
      throw new RemoteFetchError(
        `the digest of ${r.owner}/${r.repo}/${found.file} at ${commit.slice(0, 7)} is ${source.digest}, not ${opts.expectDigest}`,
        'digest',
        at.t.host,
      );
    try {
      await opts.cache?.set(keyOf(r, commit, found.file, at.t), source.bytes);
    } catch {
      // Not kept: the next read asks the API again.
    }
    return source;
  });
}

/** Reads of a GitHub API with the fetcher's retries and failure kinds, for what else a host reads (trees, files). */
export interface GitHubClient {
  /** `GET apiUrl + path` (a path from `/`) as JSON; undefined on 404 or 422. */
  json<T>(path: string): Promise<{ body: T; headers: Headers } | undefined>;
  /** `GET apiUrl + path` with `accept`, as served; undefined on 404 or 422. */
  bytes(path: string, accept: string): Promise<Uint8Array | undefined>;
  /** The rate limit the last response reported (`resetAt` in milliseconds since the epoch), as far as it said. */
  rateLimit(): { limit?: number; remaining?: number; resetAt?: number };
}

/** A client of `opts.api` (its `fallback` is not used). */
export function createGitHubClient(opts: RemoteFetchOptions = {}): GitHubClient {
  const limits: ReturnType<GitHubClient['rateLimit']> = {};
  const header = (res: Response, name: string) => {
    const value = Number(res.headers.get(name) ?? Number.NaN);
    return Number.isFinite(value) ? value : undefined;
  };
  const at: At = {
    t: targetOf(opts.api),
    opts,
    seen: (res) => {
      const reset = header(res, 'x-ratelimit-reset');
      limits.limit = header(res, 'x-ratelimit-limit') ?? limits.limit;
      limits.remaining = header(res, 'x-ratelimit-remaining') ?? limits.remaining;
      limits.resetAt = reset === undefined ? limits.resetAt : reset * 1000;
    },
  };
  const urlOf = (path: string) => {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new TypeError(`a GitHub API path starts with one "/": ${path}`);
    const segments = path.split(/[?#]/)[0]!.split('/');
    if (segments.some((s) => /^(?:\.|%2e){1,2}$/i.test(s) || s.includes('\\')))
      throw new TypeError(`a GitHub API path has no "." or ".." segment, nor a "\\": ${path}`);
    return at.t.base + path;
  };
  return {
    async json<T>(path: string) {
      const reply = await getReply(urlOf(path), 'application/vnd.github+json', at);
      if (!reply) return undefined;
      try {
        return { body: JSON.parse(decode(reply.bytes)) as T, headers: reply.res.headers };
      } catch {
        throw new RemoteFetchError(
          `the GitHub API answered ${path} with what is not JSON`,
          'other',
          at.t.host,
        );
      }
    },
    bytes: async (path, accept) => (await getReply(urlOf(path), accept, at))?.bytes,
    rateLimit: () => ({ ...limits }),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** An API as requests use it: its URL without a trailing `/` (nor credentials, query or fragment), origin and token. */
interface Target {
  base: string;
  origin: string;
  host: string;
  token?: string;
}

function targetOf(api: GitHubApi = { apiUrl: GITHUB_COM_API }): Target {
  const url = new URL(api.apiUrl);
  return {
    base: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    origin: url.origin,
    host: api.host ?? apiHost(api.apiUrl),
    ...(api.token ? { token: api.token } : {}),
  };
}

/** One API and the options of a read; `seen` hears of every response. */
interface At {
  t: Target;
  opts: RemoteFetchOptions;
  seen?: (res: Response) => void;
}

/** A response, and its body when it is a success. */
interface Reply {
  res: Response;
  bytes: Uint8Array;
}

/**
 * `work` against `opts.api`, then, when that finds nothing (`not-found`) and `opts.fallback` is set, against the
 * fallback, whose own failure is reported when it fails too. The fallback has its own `Target`: it never sees
 * `api.token`.
 */
async function withFallback<T>(opts: RemoteFetchOptions, work: (at: At) => Promise<T>): Promise<T> {
  try {
    return await work({ t: targetOf(opts.api), opts });
  } catch (e) {
    if (!opts.fallback || !(e instanceof RemoteFetchError && e.kind === 'not-found')) throw e;
    return work({ t: targetOf(opts.fallback), opts });
  }
}

/**
 * Refuses a reference with a `.` or `..` name (owner, repository, ref or path segment), which GitHub has none of: the
 * URL parser would resolve it, and send the request, and the token, to another endpoint of the API.
 */
function checkNames(r: RemoteRef, t: Target): void {
  const names = [r.owner, r.repo, r.ref, ...r.path.split('/')];
  if (names.some((n) => n === '.' || n === '..'))
    throw new RemoteFetchError(`${r.raw} has a "." or ".." name, which no repository has`, 'other', t.host);
}

const repoUrl = (r: RemoteRef, at: At) =>
  `${at.t.base}/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;

const keyOf = (r: RemoteRef, sha: string, file: string, t: Target): RemoteSourceKey => ({
  host: t.host.toLowerCase(),
  owner: r.owner.toLowerCase(),
  repo: r.repo.toLowerCase(),
  sha,
  file,
});

/** The first of a reference's files in the cache under `t`'s host, unless its digest is not the one expected. */
async function fromCache(
  r: RemoteRef,
  sha: string,
  t: Target,
  opts: RemoteFetchOptions & { expectDigest?: string },
): Promise<RemoteSource | undefined> {
  if (!opts.cache) return undefined;
  for (const file of remoteSourceFiles(r)) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await opts.cache.get(keyOf(r, sha, file, t));
    } catch {
      bytes = undefined;
    }
    if (!bytes) continue;
    const source = await sourceOf(r, sha, file, bytes, t.host);
    return opts.expectDigest === undefined || source.digest === opts.expectDigest ? source : undefined;
  }
  return undefined;
}

/** The first of a reference's files (`remoteSourceFiles`) the repository has at `sha`, as served. */
async function firstSource(
  r: RemoteRef,
  sha: string,
  at: At,
): Promise<{ file: string; bytes: Uint8Array } | undefined> {
  for (const file of remoteSourceFiles(r)) {
    const path = file.split('/').map(encodeURIComponent).join('/');
    const bytes = await get(
      `${repoUrl(r, at)}/contents/${path}?ref=${sha}`,
      'application/vnd.github.raw',
      at,
    );
    if (bytes !== undefined) return { file, bytes };
  }
  return undefined;
}

async function sourceOf(
  r: RemoteRef,
  sha: string,
  file: string,
  bytes: Uint8Array,
  host: string,
): Promise<RemoteSource> {
  const hash = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  );
  const digest = `sha256-${btoa(String.fromCharCode(...hash))}`;
  return { ref: r, sha, file, bytes, text: decode(bytes), digest, host };
}

/** UTF-8, without a byte order mark (`TextDecoder` drops one). */
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const notFound = (what: string, at: At) =>
  new RemoteFetchError(`${what} not found, or not readable with this token`, 'not-found', at.t.host);

/**
 * `read`, and once more after a pause when it finds nothing: GitHub's API answers 404 now and then for a commit or a
 * file it has, and one such answer would make the reference unreadable.
 */
async function onceMore<T>(
  read: () => Promise<T | undefined>,
  opts: RemoteFetchOptions,
): Promise<T | undefined> {
  const first = await read();
  if (first !== undefined) return first;
  await pause(opts.retryDelayMs ?? RETRY_DELAY_MS, opts.signal);
  return read();
}

const RETRY_DELAY_MS = 300;

/** A GET's body; undefined on 404, and on 422 (a SHA that is no commit of the repository). */
const get = async (url: string, accept: string, at: At) => (await getReply(url, accept, at))?.bytes;

async function getReply(url: string, accept: string, at: At): Promise<Reply | undefined> {
  const reply = await withRetries(url, accept, at);
  if (reply.res.status === 404 || reply.res.status === 422) return undefined;
  if (!reply.res.ok) throw httpError(reply.res, at.t);
  return reply;
}

/** How many times a request is sent at most: once, and twice more after a failure that passes. */
const ATTEMPTS = 3;

/** The longest `Retry-After` waited for; after a longer one the request fails, saying when to try again. */
const MAX_RETRY_AFTER_S = 60;

/** A request, sent again while it fails in a way that passes, at most `ATTEMPTS` times in all. */
async function withRetries(url: string, accept: string, at: At): Promise<Reply> {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    at.opts.signal?.throwIfAborted();
    // Another request found the host unreachable: this one would wait as long, to fail the same way.
    const down = at.opts.unreachableHosts?.get(host);
    if (down) throw down;
    const answer = await attemptOf(url, accept, at);
    const wait = attempt < ATTEMPTS ? retryWait(answer, attempt, at.opts) : undefined;
    if (wait === undefined) return lastAnswer(answer, host, at.opts);
    at.opts.onRetry?.({
      host,
      attempt: attempt + 1,
      attempts: ATTEMPTS,
      why: answer instanceof RemoteFetchError ? answer.brief : redact(statusOf(answer.res), at.t.token),
      waitMs: Math.round(wait),
    });
    await pause(wait, at.opts.signal);
  }
}

/** The answer a request ends with: its reply, or its error, thrown; a host that did not answer is kept as unreachable. */
function lastAnswer(answer: Reply | RemoteFetchError, host: string, opts: RemoteFetchOptions): Reply {
  if (!(answer instanceof RemoteFetchError)) return answer;
  if (answer.kind === 'unreachable' || answer.kind === 'timeout') opts.unreachableHosts?.set(host, answer);
  throw answer;
}

/** A request's headers: the token only for its API's origin. */
function headersOf(url: string, accept: string, at: At): Record<string, string> {
  const headers: Record<string, string> = { accept, 'x-github-api-version': '2022-11-28' };
  if (at.opts.userAgent) headers['user-agent'] = at.opts.userAgent;
  // `url` is built on `t.base`; the origin check keeps the token on its API whatever a caller passes.
  if (at.t.token && new URL(url).origin === at.t.origin) headers.authorization = `Bearer ${at.t.token}`;
  return headers;
}

/** The request's signal: the caller's, and its timeout. */
function signalOf(opts: RemoteFetchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  return opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
}

/** One request and, for a success, its body; or why there is no answer. A cancelled read rejects as `signal` says. */
async function attemptOf(url: string, accept: string, at: At): Promise<Reply | RemoteFetchError> {
  // Called unbound: a page's `window.fetch` throws when called as a method of another object.
  const fetchOf = at.opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchOf(url, { headers: headersOf(url, accept, at), signal: signalOf(at.opts) });
  } catch (e) {
    return networkError(e, at);
  }
  at.seen?.(res);
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    return { res, bytes: new Uint8Array() };
  }
  try {
    return { res, bytes: await bodyOf(res, at) };
  } catch (e) {
    return e instanceof RemoteFetchError ? e : networkError(e, at);
  }
}

/**
 * How long to wait before sending a request again, or undefined when another try would not help. Retried: no answer
 * (the network, a timeout), a server error (5xx), and the secondary rate limit (429, or 403 with `Retry-After`) for as
 * long as it asks, up to `MAX_RETRY_AFTER_S`. Not retried: what another try cannot change (401, 403 without
 * `Retry-After`, 404 and 422, which the lookups ask once more for themselves, a response too large) and a used-up
 * primary rate limit. Waits grow exponentially, with jitter so that requests made together do not come back together.
 */
function retryWait(
  answer: Reply | RemoteFetchError,
  attempt: number,
  opts: RemoteFetchOptions,
): number | undefined {
  if (answer instanceof RemoteFetchError)
    return answer.kind === 'unreachable' || answer.kind === 'timeout' ? backoffMs(attempt, opts) : undefined;
  if (!passes(answer.res)) return undefined;
  const after = retryAfterOf(answer.res);
  if (after === undefined) return backoffMs(attempt, opts);
  return after <= MAX_RETRY_AFTER_S ? after * 1000 : undefined;
}

/** The wait before the next attempt: doubling from `retryDelayMs`, with as much again at random at most. */
function backoffMs(attempt: number, opts: RemoteFetchOptions): number {
  const base = opts.retryDelayMs ?? RETRY_DELAY_MS;
  return base * 2 ** (attempt - 1) + Math.random() * base;
}

/** A wait that `signal` cuts short, rejecting with its reason. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((done, fail) => {
    const stop = () => {
      clearTimeout(timer);
      fail(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      done();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** The secondary rate limit: GitHub asks to slow down, and says when to try again (`Retry-After`, in seconds). */
function retryAfterOf(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** The primary rate limit is used up: it resets within the hour, too long to wait. */
const rateLimitUsedUp = (res: Response) =>
  (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';

/** Whether an answer reports a failure that passes: a server error, or the secondary rate limit. */
const passes = (res: Response) => res.status >= 500 || (slowDown(res) && !rateLimitUsedUp(res));

/** GitHub asks to slow down: 429, or 403 with `Retry-After` (its secondary rate limit). */
const slowDown = (res: Response) =>
  res.status === 429 || (res.status === 403 && retryAfterOf(res) !== undefined);

/** Seconds until the primary rate limit resets (`x-ratelimit-reset`, in seconds since the epoch), when it says. */
function resetInS(res: Response): number | undefined {
  const reset = Number(res.headers.get('x-ratelimit-reset') ?? Number.NaN);
  return Number.isFinite(reset) ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : undefined;
}

const TIMEOUT_MS = 30_000;

/**
 * Why a request got no answer. Node's fetch only says `fetch failed`, with the reason in `cause.code`. A cancelled
 * read rethrows the signal's reason.
 */
function networkError(e: unknown, at: At): RemoteFetchError {
  const { opts, t } = at;
  if (opts.signal?.aborted) throw opts.signal.reason;
  const error = Object(e) as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (error.name === 'TimeoutError') return timeoutError(at);
  // A `fetch` may say anything, the request's headers included: the token is cut out of what it says.
  const why = redact(String(error.cause?.code ?? error.cause?.message ?? error.message), t.token);
  return new RemoteFetchError(
    `could not reach ${t.origin} (${why})`,
    'unreachable',
    t.host,
    undefined,
    undefined,
    NETWORK_CODES[why] ?? `could not connect (${why})`,
  );
}

function timeoutError({ opts, t }: At): RemoteFetchError {
  const seconds = (opts.timeoutMs ?? TIMEOUT_MS) / 1000;
  const brief = `no answer within ${seconds} s`;
  return new RemoteFetchError(
    `no answer from ${t.origin} within ${seconds} s`,
    'timeout',
    t.host,
    undefined,
    undefined,
    brief,
  );
}

const redact = (text: string, token: string | undefined) => (token ? text.split(token).join('***') : text);

/** The network's error codes a retry's notice puts in words. */
const NETWORK_CODES: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  ETIMEDOUT: 'connection timed out',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host name lookup failed',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
};

/** A response's status, as `503 Service Unavailable`. */
const statusOf = (res: Response) => `${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;

/** Why the GitHub API refused a request. */
function httpError(res: Response, t: Target): RemoteFetchError {
  const status = redact(statusOf(res), t.token);
  const fail = (message: string, kind: RemoteFailureKind, retryAfterS?: number) =>
    new RemoteFetchError(message, kind, t.host, res.status, retryAfterS);
  if (res.status === 401)
    return fail(
      t.token
        ? `the GitHub API rejected the token (${status})`
        : `the GitHub API asks for a token (${status})`,
      'token',
    );
  if (rateLimitUsedUp(res))
    return fail(`the GitHub API rate limit is used up (${status})`, 'rate-limit', resetInS(res));
  if (slowDown(res)) {
    const after = retryAfterOf(res);
    const when = after === undefined ? ' later' : ` in ${after} s`;
    return fail(`the GitHub API asks to slow down (${status}): try again${when}`, 'rate-limit', after);
  }
  if (res.status === 403) return fail(`the GitHub API refused the request (${status})`, 'access');
  return fail(`${status} from the GitHub API`, res.status >= 500 ? 'server' : 'other');
}

/** A response's body, refused over `maxFileBytes` by its length header or by what it holds, read as it comes. */
async function bodyOf(res: Response, at: At): Promise<Uint8Array> {
  const max = at.opts.maxFileBytes ?? MAX_FILE_BYTES;
  const tooLarge = () =>
    new RemoteFetchError(`a response over ${max} bytes`, 'too-large', at.t.host, res.status);
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Workflow and action files are small; a larger response is refused rather than parsed. */
const MAX_FILE_BYTES = 1_000_000;
