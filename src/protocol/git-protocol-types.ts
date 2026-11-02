import type { RuntimePosition } from "./runtime-ui-protocol-types.js"

/** Git metadata for one canonical execution directory. Detached HEADs have no branch. */
export interface GitDirectoryView {
  readonly branch?: string
  /** The linked worktree root, absent for ordinary repositories and submodules. */
  readonly worktreeRoot?: string
}

/** Git metadata keyed by canonical directory path. */
interface GitDirectories { readonly [directory: string]: GitDirectoryView }

/** The project root and the directories of the sessions clients hold. */
export interface GitView {
  readonly directories: GitDirectories
}

export interface RuntimeGitSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly git: GitView
}

/** One patch carries the whole view, so the newest supersedes any it overtook. */
export type GitPatchPayload = { readonly kind: "git.changed"; readonly git: GitView }

export function gitCursor() {
  return { scope: "workspace", domain: "git" } as const
}
