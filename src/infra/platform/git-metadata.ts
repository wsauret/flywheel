import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Decode a .git file relative to the directory containing the entry.
 * Malformed pointers have no directory. No filesystem access occurs here. */
export function decodeGitDirectory(gitEntry: string, text: string): string | undefined {
  const pointer = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return pointer ? resolve(dirname(gitEntry), pointer) : undefined;
}

/** Decode commondir relative to the per-worktree Git directory. An absent
 * or empty entry means that the Git directory is itself the common one. */
function decodeGitCommonDirectory(gitDir: string, text?: string): string {
  return text?.trim() ? resolve(gitDir, text.trim()) : gitDir;
}

/** Read one .git entry and its common directory without starting Git.
 * Missing entries return undefined. Other filesystem errors propagate. */
export function readGitMetadata(gitEntry: string): { readonly gitDir: string; readonly commonDir: string } | undefined {
  if (!existsSync(gitEntry)) return undefined;
  const stats = statSync(gitEntry);
  const gitDir = stats.isDirectory() ? gitEntry : stats.isFile() ? decodeGitDirectory(gitEntry, readFileSync(gitEntry, "utf8")) : undefined;
  if (!gitDir) return undefined;
  const commonFile = join(gitDir, "commondir");
  return { gitDir, commonDir: decodeGitCommonDirectory(gitDir, existsSync(commonFile) ? readFileSync(commonFile, "utf8") : undefined) };
}
