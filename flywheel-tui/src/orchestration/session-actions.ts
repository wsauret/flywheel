/**
 * Session Actions
 *
 * Handles session lifecycle operations triggered from the modal:
 * view, resume, delete. Pure functions with injected dependencies.
 */

import { createOutputPersistence } from "./session/output-persistence"
import { createQueuePersistence } from "../workflows/queue/persistence"
import { readSession } from "./session/persistence"
import { fromSnapshot } from "./session/output-schemas"
import { isResumable } from "./session/state-machine"
import { createSessionOrchestrator } from "./session-orchestrator"
import type { Session } from "./session/schemas"
import type { Queue } from "../workflows/queue/types"
import type { SessionManager, SessionSummary } from "./session/manager"
import type { AnyBlock } from "../infra/output-blocks"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionActionDeps {
  manager: SessionManager
  refreshList: () => void
  activeSessionId: () => string | undefined
  projectCwd?: string
}

export interface ResumeData {
  session: Session
  outputBlocks: AnyBlock[]
  queue: Queue
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Load a session's persisted output blocks for viewing. */
export async function loadSessionOutput(sessionId: string, projectCwd?: string): Promise<AnyBlock[]> {
  const cwd = projectCwd ?? process.cwd()
  const persistence = createOutputPersistence({ sessionId, baseDir: cwd })
  return (await persistence.load()) as AnyBlock[]
}

/** Load session + output + queue for resume. Returns null if data is missing. */
export async function loadResumeData(
  sessionId: string,
  deps: SessionActionDeps,
): Promise<ResumeData | null> {
  const projectCwd = deps.projectCwd ?? process.cwd()
  const orchestrator = createSessionOrchestrator({
    readSession: (id) => readSession(id, projectCwd),
    createOutputPersistence: (id) => createOutputPersistence({ sessionId: id, baseDir: projectCwd }),
    createQueuePersistence: (id) => createQueuePersistence({ sessionId: id, baseDir: projectCwd }),
    fromSnapshot,
    manager: deps.manager,
    refreshList: deps.refreshList,
  })
  const result = await orchestrator.handleResumeSession(sessionId)
  if (!result) return null

  return {
    session: result.session,
    outputBlocks: result.outputBlocks as AnyBlock[],
    queue: result.queue,
  }
}

/** Find the most recent resumable session. */
export function findResumableSession(deps: SessionActionDeps): SessionSummary | null {
  const { sessions } = deps.manager.list()
  const resumable = sessions
    .filter(s => isResumable(s.state))
    .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
  return resumable[0] ?? null
}

/** Delete a session: remove files, cleanup, refresh list. */
export function deleteSession(sessionId: string, deps: SessionActionDeps): void {
  deps.manager.delete(sessionId)
  deps.refreshList()
}
