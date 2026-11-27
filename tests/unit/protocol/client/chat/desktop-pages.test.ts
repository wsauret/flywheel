import { describe, expect, test } from "bun:test"
import { createDesktopPages, stopNoticeLine, type DesktopNotice, type DesktopPageDecision } from "../../../../../src/protocol/client/chat/desktop-pages.js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../../src/protocol/runtime/app-service-types.js"
import { questionCursor, type PendingQuestionView } from "../../../../../src/protocol/session/question-protocol-types.js"
import { unreadChatsCursor, type StoppedChat } from "../../../../../src/protocol/session/unread-protocol-types.js"
import type { RuntimeSessionDetailView } from "../../../../../src/protocol/session/session-detail-protocol-types.js"
import { catalogRow } from "../../../../helpers/session-catalog.js"
import { runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { fakeLanes } from "../../../../helpers/fake-lanes.js"

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
  const decisions: DesktopPageDecision[] = []
  const reads: string[] = []
  let setReads = 0
  const readTitle = options.readTitle ?? (async (sessionId: string) => `Row ${sessionId}`)
  const listeners = new Set<(event: FrontendEvent) => void>()
  let position = 0
  const client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> = {
    query: runtimeQuery({
      sessionDetail: async (request) => {
        reads.push(request.sessionId)
        return { view: detailView(request.sessionId, await readTitle(request.sessionId)) }
      },
      unreadChatsSnapshot: async () => {
        setReads += 1
        return { stopped: [], unread: [], snapshotPosition: 0 }
      },
    }),
    subscribe: (listener: (event: FrontendEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onLane: fakeLanes().onLane,
  }
  const held = options.held ?? new Map<string, string>()
  const dispose = createDesktopPages({
    client,
    heldRow: (sessionId) => { const title = held.get(sessionId); return title === undefined ? undefined : { title } },
    show: (notice) => { shown.push(notice) },
    decided: (decision) => { decisions.push(decision) },
  })
  /** Broadcasts one live question patch: the question the session now waits
   *  on, or its removal. */
  function change(sessionId: string, asked: PendingQuestionView | null): void {
    position += 1
    const payload = asked === null ? { kind: "question.removed" as const } : { kind: "question.updated" as const, question: asked }
    for (const listener of listeners) listener({ type: "patch", patch: { cursor: questionCursor(sessionId), position, prevPosition: position - 1, payload } })
  }
  let unreadPosition = 0
  /** Publishes the project's set of stopped unread chats, as the account service does. */
  function publishStopped(stopped: readonly StoppedChat[], view: { readonly unread?: readonly string[]; readonly newStops?: readonly StoppedChat[] } = {}): void {
    unreadPosition += 1
    const payload = { kind: "unreadChats.changed" as const, stopped, unread: view.unread ?? [], newStops: view.newStops ?? [] }
    for (const listener of listeners) listener({ type: "patch", patch: { cursor: unreadChatsCursor(), position: unreadPosition, prevPosition: unreadPosition - 1, payload } })
  }
  return { change, publishStopped, dispose, shown, decisions, reads, setReads: () => setReads, listeners }
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
      { sessionId: "chat", key: "question:ask-1", title: "Flywheel has a question", body: "Plan the release" },
      { sessionId: "agent", key: "question:ask-2", title: "Flywheel has a question", body: "Row agent" },
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
    expect(shown.map((notice) => notice.key)).toEqual(["question:ask-1", "question:ask-2", "question:ask-3"])
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
      { sessionId: "unreadable", key: "question:ask-3", title: "Flywheel has a question", body: "A session waits for your answer" },
      { sessionId: "replaced", key: "question:ask-4", title: "Flywheel has a question", body: "replaced" },
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

const stop = (sessionId: string, stopKey: string, ending: StoppedChat["ending"] = { kind: "completed" }): StoppedChat => ({ sessionId, ending, stoppedAt: 0, stopKey })

describe("stop pages", () => {
  test("each stop that a patch announces pages once, with the words for finished or for an error, and a view that announces none pages no one", async () => {
    const { publishStopped, shown, reads, setReads } = pagesWith({ held: new Map([["chat", "Plan the release"]]) })
    await settle()
    // The set publishes nothing until something reads it.
    expect(setReads()).toBe(1)
    const finished = stop("chat", "answer-1")
    const failed = stop("closed", "stop:7", { kind: "failed", failure: "api_error" })
    publishStopped([finished], { newStops: [finished] })
    // The set lists the stop again, and with it a chat marked unread, a stop
    // recorded again for the same answer, and a working chat with unread messages.
    publishStopped([stop("earlier", "answer-0"), { ...finished, stoppedAt: 9 }], { unread: ["working"] })
    publishStopped([failed, finished], { newStops: [failed] })
    await settle()
    expect(shown).toEqual([
      { sessionId: "chat", key: "stop:chat:answer-1", title: "Flywheel", body: "Plan the release finished" },
      { sessionId: "closed", key: "stop:closed:stop:7", title: "Flywheel", body: "Row closed stopped on an error" },
    ])
    expect(reads).toEqual(["closed"])
  })

  test("a long title is shortened so that the outcome still shows", () => {
    const line = stopNoticeLine({ ending: { kind: "refused" } }, "x".repeat(300))
    expect(line.length).toBeLessThan(200)
    expect(line.endsWith("… stopped on an error")).toBe(true)
  })

  test("a stop read while its title is read pages nothing and records the suppression, and disposed pages hear no stop", async () => {
    let answer: (() => void) | undefined
    const { publishStopped, shown, decisions, dispose } = pagesWith({ readTitle: (sessionId) => new Promise<string>((resolve) => { answer = () => resolve(sessionId) }) })
    await settle()
    const first = stop("chat", "answer-1")
    publishStopped([first], { newStops: [first] })
    // Read, then marked unread: the view lists the same stop again before the title answers.
    publishStopped([])
    publishStopped([first])
    answer?.()
    await settle()
    expect(shown).toEqual([])
    expect(decisions).toEqual([{ decision: "suppressed", sessionId: "chat", kind: "stop" }])
    dispose()
    const second = stop("chat", "answer-2")
    publishStopped([second], { newStops: [second] })
    await settle()
    expect(shown).toEqual([])
  })
})
