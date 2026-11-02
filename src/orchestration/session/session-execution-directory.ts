import { canonicalDirectory, directoryExists } from "../../infra/directory-authorities.js"
import type { SessionManager } from "./manager.js"
import type { ReplayedSession } from "./schemas.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { workflowRunReader } from "../module-catalog.js"

/** The directory an owner's paths mean (ARCH-DIRECTORIES-007): the execution
 *  directory its metadata records, else the project root (a legacy row, or a
 *  session with no metadata). History reads it as recorded, whether or not it
 *  still exists, so a removed worktree never changes what a recorded relative
 *  path means. Pure: it reads no file system. */
export function recordedExecutionCwd(owner: Pick<ReplayedSession, "executionCwd"> | null, projectRoot: string): string {
  return owner?.executionCwd ?? projectRoot
}

/** The directory that agent work of an owner starts or resumes in: its
 *  recorded directory, canonicalized. Throws when the owner has no metadata,
 *  and when the recorded directory no longer exists, because work never moves
 *  to a directory its owner did not record. */
export function executionCwdFromSession(
  owner: Pick<ReplayedSession, "executionCwd"> | null,
  ownerId: string,
  projectRoot: string,
): string {
  if (!owner) throw new Error(`session execution directory is unknown: session ${ownerId} has no durable metadata`)
  const recorded = recordedExecutionCwd(owner, projectRoot)
  if (!directoryExists(recorded)) throw new Error(`session execution directory does not exist: ${recorded}. Restore the directory to continue.`)
  return canonicalDirectory(recorded, "session execution directory")
}

/** The durable metadata that owns a session's directory. An agent of a
 *  workflow records none: it runs in its workflow's directory, which it reads
 *  through its immutable membership. */
async function readDirectoryOwner(session: ReplayedSession | null, reader?: AsyncEventStateReadSurface): Promise<Pick<ReplayedSession, "executionCwd"> | null> {
  if (session?.kind !== "workflow-agent") return session
  if (!reader) throw new Error("Workflow execution directory authority is unavailable")
  return workflowRunReader(reader).read(session.workflowMembership.workflowId)
}

/** The recorded directory (`recordedExecutionCwd`) of a session whose
 *  metadata the caller already read, or `null` for a session with none. */
export async function readRecordedExecutionCwd(session: ReplayedSession | null, projectRoot: string, reader: AsyncEventStateReadSurface): Promise<string> {
  return recordedExecutionCwd(await readDirectoryOwner(session, reader), projectRoot)
}

/** Reads the directory that a session's agent work starts in (`executionCwdFromSession`) without writing facts. */
export async function requireSessionExecutionCwd(manager: Pick<SessionManager, "read">, sessionId: string, projectRoot: string, reader?: AsyncEventStateReadSurface): Promise<string> {
  const session = await manager.read(sessionId)
  const ownerId = session?.kind === "workflow-agent" ? session.workflowMembership.workflowId : sessionId
  return executionCwdFromSession(await readDirectoryOwner(session, reader), ownerId, projectRoot)
}
