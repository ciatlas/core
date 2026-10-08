import { posix } from 'node:path';
import { normalizeRelative } from './parse';

/** A workspace path an inline script creates or writes into, as far as a shallow reading of its commands shows. */
export interface ScriptWrite {
  /** Normalized workspace path (`.` is the workspace root). */
  path: string;
  /** What writes it: a command name (`cp`, `git clone`) or `>` for a redirection. */
  command: string;
}

const escapes = (path: string) => path === '..' || path.startsWith('../');

/** `cmd` or `sudo -E cmd`: words that run the next word as the command. */
const PREFIXES = new Set([
  'sudo',
  'command',
  'builtin',
  'exec',
  'nohup',
  'time',
  'env',
  'if',
  'while',
  'until',
  'then',
  'do',
  'else',
  '!',
  '{',
]);
/** The last operand is the destination; the others are copied into it (or to it). */
const COPIES = new Set([
  'cp',
  'mv',
  'ln',
  'rsync',
  'install',
  'scp',
  'copy-item',
  'move-item',
  'copy',
  'xcopy',
  'move',
]);
/** Every operand is created. */
const CREATES = new Set(['mkdir', 'md', 'touch', 'tee', 'new-item']);
/** Options naming where a command writes, whatever the command. */
const OUTPUT_OPTIONS = new Set([
  '-o',
  '--output',
  '--output-dir',
  '--output-directory',
  '--out-dir',
  '--outdir',
  '--out',
  '--dest',
  '--destination',
  '-destination',
]);
/** Options naming where one command writes. */
const COMMAND_OUTPUT_OPTIONS: Record<string, string[]> = {
  tar: ['-C', '--directory'],
  unzip: ['-d'],
  wget: ['-O', '-P', '--output-document', '--directory-prefix'],
  gh: ['-D', '--dir', '-O'],
  cp: ['-t', '--target-directory'],
  mv: ['-t', '--target-directory'],
  ln: ['-t', '--target-directory'],
  install: ['-t', '--target-directory'],
};
/** `git clone` options that take a value, so the value is not mistaken for the repository or the directory. */
const CLONE_VALUE_OPTIONS = new Set([
  '-b',
  '--branch',
  '--depth',
  '-o',
  '--origin',
  '--reference',
  '--reference-if-able',
  '--filter',
  '-c',
  '--config',
  '-j',
  '--jobs',
  '--shallow-since',
  '--shallow-exclude',
  '--separate-git-dir',
  '-u',
  '--upload-pack',
  '--template',
  '--server-option',
  '--bundle-uri',
  '--name',
]);

type Token = { op: string } | { word: string };

/**
 * Whether `line[i]` is a backslash escaping the next character (`\ `, `\"`, `\$`). Before a name it is more likely
 * a Windows path separator (`tools\act`), kept as part of the word.
 */
const escaped = (line: string, i: number) => line[i] === '\\' && !/[\w.-]/.test(line[i + 1] ?? '');

/** Splits one line of shell into words and operators. Quotes are removed; `$` expansions are kept verbatim. */
function tokenize(line: string): { tokens: Token[]; heredocs: string[] } {
  const tokens: Token[] = [];
  const heredocs: string[] = [];
  let word: string | undefined;
  const end = () => {
    if (word !== undefined) tokens.push({ word });
    word = undefined;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      end();
    } else if (c === '#' && word === undefined) {
      break;
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1);
      word = (word ?? '') + line.slice(i + 1, close < 0 ? line.length : close);
      i = close < 0 ? line.length : close;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      for (; j < line.length && line[j] !== '"'; j++) text += escaped(line, j) ? (line[++j] ?? '') : line[j];
      word = (word ?? '') + text;
      i = j;
    } else if (escaped(line, i)) {
      word = (word ?? '') + (line[++i] ?? '');
    } else if (c === '<') {
      const here = /^<<(?!<)-?\s*(['"]?)([\w.-]+)\1/.exec(line.slice(i));
      if (here) heredocs.push(here[2]!);
      end();
      tokens.push({ op: '<' });
      i += here ? here[0].length - 1 : line[i + 1] === '<' ? (line[i + 2] === '<' ? 2 : 1) : 0;
    } else if (c === '>') {
      // `2>file` and `&>file` redirect too; `>&2` duplicates a descriptor.
      if (word !== undefined && /^\d+$/.test(word)) word = undefined;
      end();
      let j = i + 1;
      if (line[j] === '>' || line[j] === '|') j++;
      if (line[j] === '&') {
        tokens.push({ op: '>&' });
        j++;
      } else tokens.push({ op: '>' });
      i = j - 1;
    } else if (c === '&' && line[i + 1] === '>') {
      end();
    } else if (';&|()'.includes(c)) {
      end();
      tokens.push({ op: c });
      if ((c === '&' || c === '|') && line[i + 1] === c) i++;
    } else {
      word = (word ?? '') + c;
    }
  }
  end();
  return { tokens, heredocs };
}

/** The workspace path a word names, relative to `cwd`; `undefined` when it is computed, absolute or outside. */
function resolveWord(word: string, cwd: string | undefined): string | undefined {
  let base = cwd;
  let w = word.replaceAll('\\', '/');
  const ws = /^\$(?:GITHUB_WORKSPACE|\{GITHUB_WORKSPACE\})(?=\/|$)/.exec(w);
  if (ws) {
    base = '.';
    w = w.slice(ws[0].length).replace(/^\//, '') || '.';
  }
  if (base === undefined || w === '' || /[$`*?[\]{}~]/.test(w) || w.startsWith('/')) return undefined;
  if (/^[A-Za-z][\w+.-]*:/.test(w)) return undefined; // a URL, `C:/...`, `git@host:...`
  const path = normalizeRelative(posix.join(base, w));
  return escapes(path) ? undefined : path;
}

const basename = (word: string) => posix.basename(word.replaceAll('\\', '/').replace(/\/+$/, ''));

/**
 * Paths an inline script writes to: destinations of copies, moves, links and `mkdir`, clones and worktrees,
 * extractions (`tar -C`, `unzip -d`), downloads (`-o`, `--output`) and redirections. Variables other than
 * `$GITHUB_WORKSPACE` make a path unknown; `cd` is followed.
 */
export function scriptWrites(script: string): ScriptWrite[] {
  const writes: ScriptWrite[] = [];
  const text = script
    .replace(/\$\{\{\s*github\.workspace\s*\}\}/g, '$GITHUB_WORKSPACE')
    .replace(/\$\{\{[\s\S]*?\}\}/g, '$EXPR')
    .replace(/\\\r?\n/g, ' ');
  let cwd: string | undefined = '.';
  const dirs: (string | undefined)[] = [];
  const write = (word: string | undefined, command: string, at = cwd) => {
    const path = word === undefined ? undefined : resolveWord(word, at);
    if (path !== undefined) writes.push({ path, command });
  };

  const command = (words: string[]) => {
    let i = 0;
    for (; i < words.length; i++) {
      const w = words[i]!;
      if (/^[A-Za-z_]\w*=/.test(w)) continue;
      if (!PREFIXES.has(w)) break;
      while (words[i + 1]?.startsWith('-')) i++;
    }
    let name = words[i]?.replaceAll('\\', '/').split('/').pop()?.toLowerCase();
    if (name === undefined) return;
    let args = words.slice(i + 1);
    if (name === 'xargs') {
      // `xargs -I {} cp {} dist/`: the command is after xargs's own options.
      let j = 0;
      while (args[j]?.startsWith('-')) j += /^-[IinPLdEs]$/.test(args[j]!) ? 2 : 1;
      name = args[j]?.split('/').pop()?.toLowerCase();
      if (name === undefined) return;
      args = args.slice(j + 1);
    }
    if (name === 'git') {
      gitWrites(args);
      return;
    }
    const options = new Set([...OUTPUT_OPTIONS, ...(COMMAND_OUTPUT_OPTIONS[name] ?? [])]);
    const operands: string[] = [];
    let target: string | undefined;
    for (let j = 0; j < args.length; j++) {
      const a = args[j]!;
      const eq = /^(--?[\w-]+)=(.*)$/.exec(a);
      const opt = eq ? eq[1]! : a;
      const value = eq ? eq[2] : args[j + 1];
      // PowerShell parameters are case-insensitive (`-Destination`); short options are not (`tar -C`, `-c`).
      if (options.has(opt) || (opt.length > 2 && options.has(opt.toLowerCase()))) {
        if (/^(?:-t|--target-directory)$/.test(opt)) target = value;
        else write(value, name);
        if (!eq) j++;
      } else if (name === '7z' || name === '7za') {
        if (a.startsWith('-o')) write(a.slice(2), name);
      } else if (a.startsWith('-') && a !== '-') {
        // PowerShell's named parameters: `Copy-Item -Path x -Destination y`, `New-Item -Path x`.
        if (/^-(?:path|literalpath|itemtype|name|value)$/i.test(a)) {
          if (/^-(?:path|literalpath)$/i.test(a) && args[j + 1] !== undefined) operands.push(args[j + 1]!);
          j++;
        }
      } else operands.push(a);
    }

    if (name === 'cd' || name === 'pushd') {
      if (name === 'pushd') dirs.push(cwd);
      cwd = operands[0] === undefined ? '.' : operands[0] === '-' ? undefined : resolveWord(operands[0], cwd);
    } else if (name === 'popd') {
      cwd = dirs.pop();
    } else if (COPIES.has(name) || name === 'robocopy') {
      const dest =
        target ?? (name === 'robocopy' ? operands[1] : operands.length > 1 ? operands.at(-1) : undefined);
      const sources = target !== undefined ? operands : name === 'robocopy' ? [] : operands.slice(0, -1);
      if (dest === undefined) return;
      write(dest, name);
      for (const s of sources) if (!/[$`*?[\]{}]/.test(basename(s))) write(`${dest}/${basename(s)}`, name);
    } else if (CREATES.has(name)) {
      for (const o of operands) write(o, name);
    }
  };

  const gitWrites = (args: string[]) => {
    // `git -C dir clone url sub`: the directory is relative to `-C`.
    let at = cwd;
    let j = 0;
    for (; j < args.length && args[j]!.startsWith('-'); j++)
      if (args[j] === '-C') at = resolveWord(args[++j] ?? '', at);
      else if (args[j] === '-c') j++;
    const sub = args[j];
    const rest = args.slice(j + 1);
    const positional: string[] = [];
    for (let k = 0; k < rest.length; k++) {
      if (CLONE_VALUE_OPTIONS.has(rest[k]!) || /^-[bB]$|^--reason$/.test(rest[k]!)) k++;
      else if (!rest[k]!.startsWith('-')) positional.push(rest[k]!);
    }
    const repoDir = (url: string) => basename(url).replace(/\.git$/, '');
    if (sub === 'clone' && positional[0] !== undefined)
      write(positional[1] ?? repoDir(positional[0]), 'git clone', at);
    else if (sub === 'worktree' && positional[0] === 'add') write(positional[1], 'git worktree add', at);
    else if (sub === 'submodule' && positional[0] === 'add' && positional[1] !== undefined)
      write(positional[2] ?? repoDir(positional[1]), 'git submodule add', at);
  };

  const lines = text.split(/\r?\n/);
  const pending: string[] = [];
  for (const line of lines) {
    if (pending.length) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    const { tokens, heredocs } = tokenize(line);
    pending.push(...heredocs);
    let words: string[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      if ('word' in t) {
        words.push(t.word);
      } else if (t.op === '>' || t.op === '<' || t.op === '>&') {
        const next = tokens[k + 1];
        if (next && 'word' in next) {
          if (t.op === '>') write(next.word, '>');
          k++;
        }
      } else {
        command(words);
        words = [];
      }
    }
    command(words);
  }
  return writes;
}

/**
 * Whether a write puts something at a workspace path: it is the path, lies inside it, or is a directory the path lies
 * in. A directory of the repository itself (`cp x .github/`) only counts for what it receives by name (`.github/x`),
 * so it does not excuse a misspelled path inside it.
 */
export function writesTo(write: ScriptWrite, path: string, isRepoDir: (dir: string) => boolean): boolean {
  if (path === '.') return false;
  if (write.path === path || write.path.startsWith(`${path}/`)) return true;
  return write.path !== '.' && path.startsWith(`${write.path}/`) && !isRepoDir(write.path);
}
