import type { ProjectDirectories } from "../../src/infra/directory-authorities.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../src/infra/event-store-types.js"
import { projectStateComposition } from "../../src/orchestration/app-service/project-state-recovery.js"

type ProjectState = ReturnType<typeof openProjectState>
type ProjectRecoveryScope = Parameters<ProjectState["claim"]>[0]

export interface ProjectStateInput {
  readonly directories: ProjectDirectories
  /** The store's raw async reader, below the Worker's one projection reader. */
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly predecessorPids?: readonly number[]
}

/** The state Worker's session composition over `reader`, in the Worker's two
 *  steps: the one projection reader, then the owners and gate over it. */
export function openProjectState(input: ProjectStateInput) {
  const composition = projectStateComposition({
    directories: input.directories,
    executionCwd: input.directories.projectRoot,
    predecessorPids: input.predecessorPids,
  })
  const projectionReader = composition.readSurface(input.reader, input.writer)
  return { ...composition.open(projectionReader, input.writer), projectionReader }
}

/** One whole recovery pass over a new Worker composition: see `recoverOwedSessions`. */
export async function recoverProject(input: ProjectStateInput, scope: ProjectRecoveryScope, interruptedSessionIds: readonly string[] = []) {
  return recoverOwedSessions(openProjectState(input), scope, interruptedSessionIds)
}

/** The claim `scope` makes, then the recovery of each owed session at once,
 *  which the Worker runs lazily. Answers the sessions claimed and each session
 *  that degraded, with its error. */
export async function recoverOwedSessions(state: Pick<ProjectState, "claim" | "recover">, scope: ProjectRecoveryScope, interruptedSessionIds: readonly string[] = []) {
  const { owed, degraded } = await state.claim(scope, interruptedSessionIds)
  const failed = [...degraded]
  for (const entry of owed) {
    const error = await state.recover(entry)
    if (error !== null) failed.push({ sessionId: entry.sessionId, error })
  }
  return { sessionIds: owed.map(({ sessionId }) => sessionId), degraded: failed }
}
