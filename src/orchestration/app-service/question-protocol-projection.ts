import type { AsyncEventReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { createBackgroundLane } from "../../infra/ordered-lane.js"
import { AGENT_INPUT_FACT_TYPES } from "../session/agent-input-facts.js"
import { loadAgentInputProjection } from "../session/agent-input-projection.js"
import type { SessionStore } from "../session-store/types.js"
import { questionCursor, type PendingQuestionView } from "../../protocol/question-protocol-types.js"
import { createSessionViewPublisher } from "./session-view-projection.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"

const log = Log.create({ service: "question-protocol-projection" })

export interface QuestionProtocolProjection {
  snapshot(sessionId: string): Promise<PendingQuestionView | null>
  dispose(): void
}

export interface QuestionProtocolProjectionDeps {
  readonly sessionStore: SessionStore
  readonly reader: AsyncEventReadSurface
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch
}

const EVENT_TYPES = new Set<string>(AGENT_INPUT_FACT_TYPES)

/** Pending questions are a fold over durable agent-input facts, not over the
 *  session store: a question outlives runner liveness, so this projection is
 *  push-driven by committed facts and never sweeps on store departure. It
 *  shares the store-driven siblings' publish half (equality gate, microtask
 *  batch, updated/removed payloads) through the session-view publisher. */
export async function createQuestionProtocolProjection(deps: QuestionProtocolProjectionDeps): Promise<QuestionProtocolProjection> {
  const publisher = createSessionViewPublisher<PendingQuestionView>({
    publish: deps.publish,
    cursor: questionCursor,
    payloads: {
      updated: (question) => ({ kind: "question.updated", question }),
      removed: () => ({ kind: "question.removed" }),
    },
    same: sameQuestion,
  })

  /** The dock serves pending questions in the order the agent asked them, so
   *  an answer goes to the first one the transcript shows. The projection
   *  keeps its entries in the commit order of their requests. */
  async function read(sessionId: string): Promise<PendingQuestionView | null> {
    const entries = await loadAgentInputProjection(deps.reader, sessionId)
    for (const entry of entries.values()) {
      if (entry.kind === "pending") return { kind: "question", toolUseId: entry.toolUseId, questions: [...entry.request], timestamp: entry.openedAt }
    }
    return null
  }

  let disposed = false
  // Pushes resolve in commit order. A failed push is recorded, and each
  // session it touched is read again at its next agent-input fact.
  const lane = createBackgroundLane(log, "question-protocol")
  let initialized = false
  const pending: Array<readonly StoredFact[]> = []

  async function applyStored(events: readonly StoredFact[]): Promise<void> {
    if (disposed) return
    const touched = new Set<string>()
    for (const event of events) {
      if (!EVENT_TYPES.has(event.type)) continue
      touched.add(event.sessionId)
    }
    for (const sessionId of touched) publisher.set(sessionId, await read(sessionId))
  }

  const unsubscribeStored = deps.onStored((events) => {
    if (!initialized) {
      pending.push(events)
      return
    }
    lane.runInBackground("question push", () => applyStored(events))
  })
  try {
    await Promise.all(deps.sessionStore.allIds().map(async (sessionId) => {
      publisher.prime(sessionId, await read(sessionId))
    }))
    while (pending.length > 0) await applyStored(pending.shift() ?? [])
  } catch (error) {
    unsubscribeStored()
    publisher.dispose()
    throw error
  }
  initialized = true
  return {
    async snapshot(sessionId) {
      await lane.settled()
      const question = await read(sessionId)
      publisher.prime(sessionId, question)
      return question
    },
    dispose() {
      disposed = true
      unsubscribeStored()
      publisher.dispose()
    },
  }
}

function sameQuestion(a: PendingQuestionView, b: PendingQuestionView): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
