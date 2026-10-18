/**
 * POSIX path arithmetic for repository-relative paths, with Node's `path.posix` semantics for what the parser and the
 * loader need, so the browser entry carries no `node:path`.
 */

export const posixIsAbsolute = (path: string): boolean => path.startsWith('/');

/** `a/./b/../c` → `a/c`, `` → `.`, `/..` → `/`; a trailing slash is kept, as `path.posix.normalize` keeps it. */
export function posixNormalize(path: string): string {
  if (path === '') return '.';
  const absolute = path.startsWith('/');
  const trailing = path.endsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) step(out, segment, absolute);
  if (out.length === 0) return absolute ? '/' : trailing ? './' : '.';
  return `${absolute ? '/' : ''}${out.join('/')}${trailing ? '/' : ''}`;
}

/** One segment onto the normalized path: `.` and empty ones vanish, `..` pops (or stays, when relative and nothing is above). */
function step(out: string[], segment: string, absolute: boolean): void {
  if (segment === '' || segment === '.') return;
  if (segment !== '..') {
    out.push(segment);
    return;
  }
  if (out.length && out.at(-1) !== '..') out.pop();
  else if (!absolute) out.push('..');
}

/** The non-empty parts joined and normalized; `.` when there is nothing. */
export function posixJoin(...parts: string[]): string {
  const joined = parts.filter((p) => p !== '').join('/');
  return joined === '' ? '.' : posixNormalize(joined);
}

/** The last segment, trailing slashes ignored; `` for `/` and ``. */
export function posixBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}
