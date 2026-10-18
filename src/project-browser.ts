import type { Project } from './graph';
import { type LoadProjectOptions, loadProjectWith, type ProjectHost, toPosix } from './project';

/** The loader in a browser: there is no disk, so `fs` (a `memoryFileSystem`) is required and paths are repository-relative. */

const browserHost: ProjectHost = {
  relativeTo: (_root, p) => toPosix(p).replace(/^\.\//, ''),
};

export function loadProject(opts: LoadProjectOptions): Project {
  return loadProjectWith(opts, browserHost);
}
