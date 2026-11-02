import { describe, expect, test } from "bun:test"
import { createQuestionPages, type DesktopNotice } from "../../../../src/protocol/client/question-pages.js"
import type { FrontendEvent, RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { questionCursor, type PendingQuestionView } from "../../../../src/protocol/question-protocol-types.js"
import type { RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { catalogRow } from "../../../helpers/session-catalog.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const settle = () => new Promise<void>((resolve) => { setImmediate(resolve) })
const question = (toolUseId: string, timestamp = 0): PendingQuestionView => ({ kind: "question", toolUseId, questions: [], timestamp })

const detailView = (sessionId: string, title: string): RuntimeSessionDetailView => ({
  id: sessionId, source: "durable", kind: "chat", conversationId: "conv", budget: null, row: catalogRow(sessionId, title),
  status: {
    activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected",
    activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
    waitingOnBackgroundWork: false, startedAt: 0,
    streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
  },
})

function pagesWith(options: {
  readonly held?: ReadonlyMap<string, string>
  /** The title the session detail read answers with. */
  readonly readTitle?: (sessionId: string) => Promise<string>
} = {}) {
  const shown: DesktopNotice[] = []
  const reads: string[] = []
  const readTitle = options.readTitle ?? (async (sessionId: string) => `Row ${sessionId}`)
  const listeners = new Set<(event: FrontendEvent) => void>()
  let position = 0
  const client: Pick<RuntimeClient, "query" | "subscribe"> = {
    query: runtimeQuery({ sessionDetail: async (request) => {
      reads.push(request.sessionId)
      return { view: detailView(request.sessionId, await readTitle(request.sessionId)) }
    } }),
    subscribe: (listener: (event: FrontendEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const held = options.held ?? new Map<string, string>()
  const dispose = createQuestionPages({
    client,
    heldRow: (sessionId) => { const title = held.get(sessionId); return title === undefined ? undefined : { title } },
    show: (notice) => { shown.push(notice) },
  })
  /** Broadcasts one live question patch: the question the session now waits
   *  on, or its removal. */
  function change(sessionId: string, asked: PendingQuestionView | null): void {
    position += 1
    const payload = asked === null ? { kind: "question.removed" as const } : { kind: "question.updated" as const, question: asked }
    for (const listener of listeners) listener({ type: "patch", patch: { cursor: questionCursor(sessionId), position, prevPosition: position - 1, payload } })
  }
  return { change, dispose, shown, reads, listeners }
}

describe("question pages", () => {
  test("a live question pages once, named by the row the client holds, and reads a row only for a session it holds none for", async () => {
    const { change, shown, reads } = pagesWith({ held: new Map([["chat", "Plan the release"]]) })
    change("chat", question("ask-1"))
    change("agent", question("ask-2"))
    change("chat", question("ask-1"))
    change("agent", question("ask-2"))
    await settle()
    expect(shown).toEqual([
      { sessionId: "chat", questionId: "ask-1", title: "Flywheel has a question", body: "Plan the release" },
      { sessionId: "agent", questionId: "ask-2", title: "Flywheel has a question", body: "Row agent" },
    ])
    expect(reads).toEqual(["agent"])
  })

  test("each new question of one session pages again, after an answer or in place of the last, and the runtime's clock decides nothing", async () => {
    const { change, shown } = pagesWith({ held: new Map([["chat", "Chat"]]) })
    // A question stamped long before, or long after, this client's clock pages all the same.
    change("chat", question("ask-1", 1))
    change("chat", null)
    change("chat", question("ask-2", Number.MAX_SAFE_INTEGER))
    change("chat", question("ask-3", 2))
    // The same question with a new stamp is not a new question.
    change("chat", question("ask-3", 3))
    await settle()
    expect(shown.map((notice) => notice.questionId)).toEqual(["ask-1", "ask-2", "ask-3"])
  })

  test("a question answered or replaced while its title is read pages nothing for it, and a row that cannot be read still pages", async () => {
    const answers: (() => void)[] = []
    const { change, shown } = pagesWith({
      readTitle: (sessionId) => sessionId === "unreadable"
        ? Promise.reject(new Error("lane lost"))
        : new Promise<string>((resolve) => { answers.push(() => resolve(sessionId)) }),
    })
    change("answered", question("ask-1"))
    change("replaced", question("ask-2"))
    change("unreadable", question("ask-3"))
    change("answered", null)
    change("replaced", question("ask-4"))
    for (const answer of answers) answer()
    await settle()
    expect(shown).toEqual([
      { sessionId: "unreadable", questionId: "ask-3", title: "Flywheel has a question", body: "A session waits for your answer" },
      { sessionId: "replaced", questionId: "ask-4", title: "Flywheel has a question", body: "replaced" },
    ])
  })

  test("disposed pages show nothing, even for a title read already under way, and stop hearing patches", async () => {
    const { change, dispose, shown, listeners } = pagesWith()
    change("agent", question("ask-1"))
    dispose()
    change("agent", question("ask-2"))
    await settle()
    expect(shown).toEqual([])
    expect(listeners.size).toBe(0)
  })
})
