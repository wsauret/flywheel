import { createOutputPersistence } from "./session/output-persistence.js"
import { createQueuePersistence } from "../workflows/queue/persistence.js"
import { readSession } from "./session/persistence.js"
import { fromSnapshot } from "./session/output-schemas.js"
import { isResumable } from "./session/types.js"
import type { Session } from "./session/schemas.js"
import type { Queue } from "../workflows/queue/types.js"
import type { SessionManager, SessionSummary } from "./session/manager.js"
import type { AnyBlock } from "../infra/output-blocks.js"

export interface SessionActionDeps {
  manager: SessionManager
  activeSessionId: () => string | undefined
}

interface ResumeData {
  session: Session
  outputBlocks: AnyBlock[]
  queue: Queue
}

export async function loadSessionOutput(sessionId: string, projectCwd?: string): Promise<AnyBlock[]> {
  const cwd = projectCwd ?? process.cwd()
  const persistence = createOutputPersistence({ sessionId, baseDir: cwd })
  return (await persistence.load()) as AnyBlock[]
}

export async function loadResumeData(
  sessionId: string,
  baseDir = process.cwd(),
): Promise<ResumeData | null> {
  const projectCwd = baseDir

  // 1. Read session from disk
  const session = readSession(sessionId, projectCwd)
  if (!session) return null

  // 2. Load and validate output snapshots
  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  const rawSnapshots = await outputPersistence.load()
  const outputBlocks = fromSnapshot(rawSnapshots) as AnyBlock[]

  // 3. Load queue state (required for resume)
  let queue: Queue | null = null
  try {
    const queuePersistence = createQueuePersistence({ sessionId, baseDir: projectCwd })
    queue = await queuePersistence.load()
  } catch {
    // Queue file missing or corrupt
  }
  if (!queue) return null

  return { session, outputBlocks, queue }
}

export function findResumableSession(deps: SessionActionDeps): SessionSummary | null {
  const { sessions } = deps.manager.list()
  const resumable = sessions
    .filter(s => isResumable(s.state))
    .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
  return resumable[0] ?? null
}

