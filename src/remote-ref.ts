/**
 * References to other repositories' reusable workflows and actions (`owner/repo/path@ref`): what they name, and the
 * files they are read from. No imports, so the browser's remote fetcher (`remote-fetch.ts`) can take it alone.
 */

export type RemoteKind = 'workflow' | 'action';

/** A remote reference: `owner/repo/path@ref`, its path in that repository (none for a root action) and its ref. */
export interface RemoteRef {
  raw: string;
  kind: RemoteKind;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

/** A `uses:` value of another repository, or undefined for one that is not (`docker://…`, `./…`, a malformed one). */
export function parseRemoteRef(raw: string, kind: RemoteKind): RemoteRef | undefined {
  const m = /^([^/@\s]+)\/([^/@\s]+)((?:\/[^@\s]+)?)@([^@\s]+)$/.exec(raw.trim());
  if (!m) return undefined;
  return { raw: raw.trim(), kind, owner: m[1]!, repo: m[2]!, path: m[3]!.replace(/^\//, ''), ref: m[4]! };
}

/** Whether a ref is a full commit SHA (40 hexadecimal digits, in any letter case). */
export const isFullSha = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);

/**
 * The files a remote reference is read from, in order: its workflow file, or its action's `action.yml`, then
 * `action.yaml`.
 */
export const remoteSourceFiles = (r: Pick<RemoteRef, 'kind' | 'path'>): string[] =>
  r.kind === 'workflow'
    ? [r.path]
    : ['action.yml', 'action.yaml'].map((n) => (r.path ? `${r.path}/${n}` : n));

/**
 * The key of a remote `uses:` reference (`owner/repo/path@ref`): GitHub matches the owner and repository in any letter
 * case, and the path and ref as written.
 *
 * It lower-cases the first two `/` segments, so a root action's ref, which sits in the second, is lower-cased too:
 * `Actions/Cache@V4` and `actions/cache@v4` have one key, while `octo/ship/x.yml@V1` and `…@v1` have two.
 */
export function remoteKey(raw: string): string {
  const [owner = '', repo = '', ...rest] = raw.trim().split('/');
  return [owner.toLowerCase(), repo.toLowerCase(), ...rest].join('/');
}
