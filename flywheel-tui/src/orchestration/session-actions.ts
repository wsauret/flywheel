import { createOutputPersistence } from "./session/output-persistence.js"
import { createQueuePersistence } from "../workflows/queue/persistence.js"
import { readSession } from "./session/persistence.js"
import { fromSnapshot } from "./session/output-schemas.js"
import { isResumable } from "./session/types.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import type { Session } from "./session/schemas.js"
import type { Queue } from "../workflows/queue/types.js"
import type { SessionManager, SessionSummary } from "./session/manager.js"
import type { AnyBlock } from "../infra/output-blocks.js"

const log = Log.create({ service: "session-actions" })

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
  return await persistence.load()
}

export async function loadResumeData(
  sessionId: string,
  baseDir = process.cwd(),
): Promise<ResumeData | null> {
  const projectCwd = baseDir

  const session = readSession(sessionId, projectCwd)
  if (!session) return null

  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  const rawSnapshots = await outputPersistence.load()
  const outputBlocks = fromSnapshot(rawSnapshots)

  let queue: Queue | null = null
  try {
    const queuePersistence = createQueuePersistence({ sessionId, baseDir: projectCwd })
    queue = await queuePersistence.load()
  } catch (err) {
    log.warn("queue load failed for resume", { sessionId, error: errorMessage(err) })
  }
  if (!queue) return null

  return { session, outputBlocks, queue }
}

const CHAT_CONTEXT_MAX_CHARS = 2000

/**
 * Extract recent conversation context from output blocks.
 * Returns a character-bounded summary of user/assistant exchanges
 * suitable for passing to the dispatcher as chat context.
 */
export function extractChatContext(blocks: readonly AnyBlock[]): string | undefined {
  const lines: string[] = []
  let chars = 0
  for (let i = blocks.length - 1; i >= 0 && chars < CHAT_CONTEXT_MAX_CHARS; i--) {
    const block = blocks[i]!
    if (block.kind === "userMessage" && !block.injected) {
      lines.unshift(`User: ${block.content}`)
      chars += block.content.length + 6
    } else if (block.kind === "text") {
      lines.unshift(`Assistant: ${block.content}`)
      chars += block.content.length + 11
    }
  }
  if (lines.length === 0) return undefined
  let result = lines.join("\n")
  if (result.length > CHAT_CONTEXT_MAX_CHARS) {
    result = result.slice(result.length - CHAT_CONTEXT_MAX_CHARS)
    const firstNewline = result.indexOf("\n")
    if (firstNewline > 0) result = result.slice(firstNewline + 1)
  }
  return result
}

export function findResumableSession(deps: SessionActionDeps): SessionSummary | null {
  const { sessions } = deps.manager.list()
  const resumable = sessions
    .filter(s => isResumable(s.state))
    .sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime())
  return resumable[0] ?? null
}

