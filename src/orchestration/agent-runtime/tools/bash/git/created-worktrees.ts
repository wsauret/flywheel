import { existsSync, realpathSync } from "node:fs";
import { registeredWorktreeRoots } from "../policy/bash-write-roots.js";

/** A command that can create a worktree, as plain text, so that variables,
 *  redirects, pipes, and `bash -c` all count. Only such a command pays for the
 *  registry reads of `track`. */
const WORKTREE_ADD = /\bworktree\s+add\b/;

/** One recorded worktree, and whether a reminder named it. */
export interface CreatedWorktree {
  readonly path: string;
  readonly reminded: boolean;
}

/** The Git worktrees that a session's commands created, for the runtime's
 *  worktree reminder (ARCH-TOOLS-060). A planned replacement carries the
 *  record to the next build through `entries` and `adopt`. */
export interface CreatedWorktrees {
  /** Starts watching one command that runs in `cwd`: it reads the worktree
   *  registry of the repository of `cwd` now, and the returned settle, called
   *  when the command exits, records each worktree that the registry gained.
   *  A command that cannot add a worktree is not watched. */
  track(command: string, cwd: string): (() => void) | undefined;
  /** The recorded worktrees that Git still registers and that no earlier call
   *  named. Each one returned is not returned again; a removed one is
   *  forgotten. Reads nothing while every recorded worktree was named. */
  unreminded(): readonly string[];
  /** The record, for a planned replacement to hand over. */
  entries(): readonly CreatedWorktree[];
  /** Takes over the record that a previous build handed over. */
  adopt(entries: readonly CreatedWorktree[]): void;
}

export function createCreatedWorktrees(): CreatedWorktrees {
  // Each recorded path, and whether a reminder named it.
  const recorded = new Map<string, boolean>();
  return {
    track(command, cwd) {
      if (!WORKTREE_ADD.test(command)) return undefined;
      // Creation is what the run proves, not what the command text predicts:
      // a skipped or failed add, or an add of a path that exists, gains
      // nothing. An add that another session makes in the same repository
      // while this command runs also counts, which costs one extra reminder.
      const before = new Set(registeredRoots(cwd));
      return () => {
        for (const root of registeredRoots(cwd)) if (!before.has(root)) recorded.set(root, false);
      };
    },
    unreminded() {
      const named: string[] = [];
      for (const [path, reminded] of recorded) {
        if (reminded) continue;
        if (!isRegisteredWorktree(path)) recorded.delete(path);
        else {
          named.push(path);
          recorded.set(path, true);
        }
      }
      return named;
    },
    entries: () => [...recorded].map(([path, reminded]) => ({ path, reminded })),
    adopt(entries) {
      for (const { path, reminded } of entries) recorded.set(path, reminded || recorded.get(path) === true);
    },
  };
}

/** The resolved roots that the worktree registry of the repository of
 *  `directory` lists, read without starting Git, as the write guard reads
 *  them. Git records the resolved path, which a symlinked parent, such as a
 *  macOS temporary directory, changes. Metadata that cannot be read lists
 *  nothing, so the reminder names no worktree that the agent cannot remove. */
function registeredRoots(directory: string): readonly string[] {
  try {
    return registeredWorktreeRoots(directory).flatMap((root) => existsSync(root) ? [realpathSync(root)] : []);
  } catch {
    return [];
  }
}

function isRegisteredWorktree(path: string): boolean {
  return existsSync(path) && registeredRoots(path).includes(path);
}
