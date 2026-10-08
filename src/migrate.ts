import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CONFIG_DIR, CONFIG_FILES, LEGACY_CONFIG_DIR, LEGACY_CONFIG_FILES } from './config';
import { CONTRACTS_DIR, normalizeContractText } from './contracts';
import { insideRepository } from './project';

/** One file moved from wfc's pre-0.2.0 location to flowpact's, with its content rewritten. */
export interface MigrationMove {
  from: string;
  to: string;
  /** What changed in the content (empty when the file is only moved). */
  changes: string[];
}

export interface MigrationPlan {
  moves: MigrationMove[];
  /** Destinations that already exist; nothing is migrated while there are conflicts. */
  conflicts: string[];
  /** Files in the old directory that are not moved (unknown files, symlinks), with the reason. */
  leftovers: { file: string; reason: string }[];
}

const toPosix = (p: string) => p.split('\\').join('/');
const OLD_SCHEMA_BASE = 'https://rumankazi.github.io/wfc/';
const NEW_SCHEMA_BASE = 'https://rumankazi.github.io/flowpact/';

/** Files below `dir`, with symlinks listed separately (they are never followed or moved). */
function walk(root: string, dir: string): { files: string[]; links: string[] } {
  const abs = join(root, dir);
  const out = { files: [] as string[], links: [] as string[] };
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs).sort()) {
    const rel = toPosix(join(dir, name));
    const st = lstatSync(join(root, rel));
    if (st.isSymbolicLink()) out.links.push(rel);
    else if (st.isDirectory()) {
      const sub = walk(root, rel);
      out.files.push(...sub.files);
      out.links.push(...sub.links);
    } else out.files.push(rel);
  }
  return out;
}

/** The rewritten config: `WFC` rule codes become `FP`, schema URLs point at flowpact. */
export function migrateConfigText(text: string): { text: string; changes: string[] } {
  const changes: string[] = [];
  // wfc accepted codes in any case (`wfc104`).
  let out = text.replace(/\bWFC(\d{3})\b/gi, (_, n: string) => {
    changes.push(`WFC${n} → FP${n}`);
    return `FP${n}`;
  });
  // Plain text replacement (not URL validation): every occurrence of the old schema base moves to the new one.
  const moved = out.split(OLD_SCHEMA_BASE).join(NEW_SCHEMA_BASE);
  if (moved !== out) {
    out = moved;
    changes.push('schema URL');
  }
  return { text: out, changes: [...new Set(changes)] };
}

/** The rewritten contract: flowpact's header and `$schema` line (nothing else), so `flowpact check` sees it as up to date. */
export function migrateContractText(text: string): { text: string; changes: string[] } {
  const out = normalizeContractText(text);
  const changes: string[] = [];
  if (out.split('\n', 2).join('\n') !== text.replace(/\r\n/g, '\n').split('\n', 2).join('\n'))
    changes.push('header');
  if (/^\$schema: .*\/wfc\//m.test(text)) changes.push('schema URL');
  return { text: out, changes };
}

/** What `flowpact migrate` would do in `root`. */
export function planMigration(root: string): MigrationPlan {
  const legacy = join(root, LEGACY_CONFIG_DIR);
  if (existsSync(legacy) && lstatSync(legacy).isSymbolicLink()) {
    throw new Error(`${LEGACY_CONFIG_DIR} is a symlink; move its files to ${CONFIG_DIR} by hand`);
  }
  const moves: MigrationMove[] = [];
  const found = walk(root, LEGACY_CONFIG_DIR);
  const leftovers = found.links.map((file) => ({ file, reason: 'is a symlink; move it by hand' }));
  for (const file of found.files) {
    const name = file.slice(LEGACY_CONFIG_DIR.length + 1);
    const configIndex = (LEGACY_CONFIG_FILES as readonly string[]).indexOf(name);
    const text = readFileSync(join(root, file), 'utf8');
    if (configIndex >= 0) {
      const { changes } = migrateConfigText(text);
      moves.push({ from: file, to: `${CONFIG_DIR}/${CONFIG_FILES[configIndex]}`, changes });
    } else if (/^(workflows|actions)\/.+\.contract\.yml$/.test(name)) {
      const { changes } = migrateContractText(text);
      moves.push({ from: file, to: `${CONTRACTS_DIR}/${name}`, changes });
    } else {
      leftovers.push({ file, reason: 'is not a flowpact file and stays where it is' });
    }
  }
  const conflicts = moves.map((m) => m.to).filter((to) => existsSync(join(root, to)));
  return { moves, conflicts, leftovers };
}

/** Moves the files of a plan without conflicts and removes the old directory when it is empty. */
export function applyMigration(root: string, plan: MigrationPlan): void {
  if (plan.conflicts.length) throw new Error(`Already exists: ${plan.conflicts.join(', ')}`);
  for (const m of plan.moves) {
    const from = join(root, m.from);
    const to = join(root, m.to);
    if (!insideRepository(root, from) || !insideRepository(root, to)) {
      throw new Error(`${m.from} → ${m.to} leaves the repository`);
    }
    const text = readFileSync(from, 'utf8');
    const migrated = m.to.endsWith('.contract.yml') ? migrateContractText(text) : migrateConfigText(text);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, migrated.text);
    rmSync(from);
  }
  // Remove directories the move emptied, deepest first; anything left behind (leftovers) keeps its directory.
  const dirs = [...new Set(plan.moves.map((m) => dirname(join(root, m.from))))].sort(
    (a, b) => b.length - a.length,
  );
  for (const d of [...dirs, join(root, LEGACY_CONFIG_DIR)]) {
    if (
      existsSync(d) &&
      readdirSync(d).length === 0 &&
      toPosix(relative(root, d)).startsWith(LEGACY_CONFIG_DIR)
    ) {
      rmdirSync(d);
    }
  }
}
