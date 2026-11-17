// oxlint-disable anti-slop/no-known-value-widening -- vendored upstream source keeps its own style; see UPSTREAM.md
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { messageOf } from './jev.ts';
import type { ResolvedOptions } from './types.ts';

/** Changed line numbers of one file, or `'all'` for an untracked file. */
export type ChangedLines = ReadonlySet<number> | 'all';

interface RepoChanges {
  readonly root: string;
  readonly files: Map<string, ChangedLines>;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Parses `git diff -U0` output into the new-side line numbers each file changed. */
export function parseDiff(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = null;
      if (target.startsWith('b/')) {
        current = files.get(target.slice(2)) ?? new Set();
        files.set(target.slice(2), current);
      }
      continue;
    }
    const hunk = current === null ? null : HUNK.exec(line);
    if (hunk === null || current === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A pure deletion has no new lines, so the lines on either side of the gap count as changed.
    if (count === 0) {
      current.add(start);
      current.add(start + 1);
    }
    for (let offset = 0; offset < count; offset++) current.add(start + offset);
  }
  return files;
}

const repoByDir = new Map<string, RepoChanges | null>();
const changesByRoot = new Map<string, RepoChanges | null>();

function repoChanges(
  dir: string,
  base: string,
  warn: (message: string) => void,
): RepoChanges | null {
  const dirKey = `${base}\0${dir}`;
  if (repoByDir.has(dirKey)) return repoByDir.get(dirKey) ?? null;
  let changes: RepoChanges | null = null;
  try {
    const root = realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim());
    const rootKey = `${base}\0${root}`;
    if (changesByRoot.has(rootKey)) {
      changes = changesByRoot.get(rootKey) ?? null;
    } else {
      // Diffing the working tree against the base covers staged and unstaged edits together.
      const diff = git(root, [
        'diff',
        '-U0',
        '--no-color',
        '--no-ext-diff',
        '--no-renames',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        base,
        '--',
      ]);
      const files = new Map<string, ChangedLines>(parseDiff(diff));
      const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
      for (const file of untracked.split('\0').filter(Boolean)) files.set(file, 'all');
      changes = { root, files };
      changesByRoot.set(rootKey, changes);
    }
  } catch (error) {
    warn(
      `changedOnly could not diff against ${base} in ${dir}, checking every line: ${messageOf(error)}`,
    );
  }
  repoByDir.set(dirKey, changes);
  return changes;
}

const flag = (name: string): boolean | undefined => {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  return undefined;
};

/** Whether changed-lines mode is on, and the ref it diffs against. Env vars override options. */
export function changedMode(options: ResolvedOptions): { on: boolean; base: string } {
  return {
    on: flag('JEV_CHANGED_ONLY') ?? options.changedOnly,
    base: (process.env.JEV_CHANGED_BASE ?? '').trim() || options.changedBase,
  };
}

/**
 * The lines of a file changed against `base`, computed once per repository per process. An empty
 * set means the file is unchanged. When git cannot answer, every line counts as changed, so a
 * broken diff never silently turns checks off.
 */
export function changedLines(
  filename: string,
  base: string,
  warn: (message: string) => void,
): ChangedLines {
  let file: string;
  try {
    file = realpathSync(filename);
  } catch {
    return 'all';
  }
  const changes = repoChanges(path.dirname(file), base, warn);
  if (changes === null) return 'all';
  const relative = path.relative(changes.root, file).split(path.sep).join('/');
  return changes.files.get(relative) ?? new Set();
}

export function overlaps(lines: ChangedLines, start: number, end: number): boolean {
  if (lines === 'all') return true;
  for (let line = start; line <= end; line++) if (lines.has(line)) return true;
  return false;
}
