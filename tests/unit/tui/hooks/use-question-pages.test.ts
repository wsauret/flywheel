import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { useQuestionPages } from "../../../../src/tui/hooks/use-question-pages.js"
import { createQuestionCache } from "../../../../src/tui/hooks/create-question-cache.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { questionCursor, type PendingQuestionView } from "../../../../src/protocol/question-protocol-types.js"
import { statusCursor } from "../../../../src/protocol/status-protocol-types.js"
import type { RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { catalogRow } from "../../../helpers/session-catalog.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const settle = () => new Promise<void>((resolve) => { setImmediate(resolve) })
const question = (toolUseId: string): PendingQuestionView => ({ kind: "question", toolUseId, questions: [], timestamp: 0 })
const detailView = (sessionId: string): RuntimeSessionDetailView => ({
  id: sessionId, source: "durable", kind: "chat", conversationId: "conv", budget: null, row: catalogRow(sessionId, `Session ${sessionId}`),
  status: {
    activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected",
    activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
    waitingOnBackgroundWork: false, startedAt: 0,
    streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
  },
})

/** A runtime that answers question reads from `waiting` and the session
 *  detail read with the session's title, and broadcasts live patches. */
function fakeRuntime(waiting: ReadonlyMap<string, PendingQuestionView>) {
  let sequencer = createRuntimeUiPatchSequencer()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const detailReads: string[] = []
  const query = runtimeQuery({
    questionSnapshot: async (request) => ({ views: request.sessionIds.map((sessionId) => ({ sessionId, view: waiting.get(sessionId) ?? null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["question"] }) }),
    sessionDetail: async (request) => {
      detailReads.push(request.sessionId)
      return { view: detailView(request.sessionId) }
    },
  })
  const emit = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  // Before a client attaches, the runtime publishes to no one.
  const publish = (patch: Parameters<typeof sequencer.publish>[0]) => { emit({ type: "patch", patch: sequencer.publish(patch) }) }
  const client = {
    query,
    subscribe: (listener: (event: FrontendEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  return {
    client, detailReads,
    ask(sessionId: string, toolUseId: string) { publish({ cursor: questionCursor(sessionId), payload: { kind: "question.updated", question: question(toolUseId) } }) },
    answer(sessionId: string) { publish({ cursor: questionCursor(sessionId), payload: { kind: "question.removed" } }) },
    unrelated(sessionId: string) { publish({ cursor: statusCursor(sessionId), payload: { kind: "status.removed" } }) },
    reconnect() { lanes.end(); emit(LANE_BREAK); lanes.open() },
    /** The runtime restarts, and its positions start again. */
    restart() { lanes.end(); emit(LANE_BREAK); sequencer = createRuntimeUiPatchSequencer(); lanes.open() },
  }
}

/** Mounts the terminal's question cache and its pages on one client, as the
 *  shell does, so a cache read and a page share the client's lane. */
function mount(runtime: ReturnType<typeof fakeRuntime>, enabledAtStart = true) {
  return createRoot((dispose) => {
    const questions = createQuestionCache({ appService: runtime.client })
    const [enabled, setEnabled] = createSignal(enabledAtStart)
    const calls: string[] = []
    let rowReads = 0
    useQuestionPages({
      client: runtime.client, enabled,
      row: (sessionId) => { rowReads += 1; return sessionId === "chat" ? { title: "Plan the release" } : undefined },
      notify: (title, body) => { calls.push(`${title}: ${body}`) },
    })
    return { questions, calls, setEnabled, dispose, rowReads: () => rowReads }
  })
}

const CHAT_PAGE = "Flywheel has a question: Plan the release"
const AGENT_PAGE = "Flywheel has a question: Session workflow-agent"

describe("terminal question pages", () => {
  test("a question that waits at attach pages no one; each live question from a chat or an unopened workflow agent pages once, and a new question of the same session pages again", async () => {
    const runtime = fakeRuntime(new Map([["chat", question("waiting")]]))
    const page = mount(runtime)
    try {
      page.questions.ensureMany(["chat"])
      await settle()
      expect(page.questions.view("chat")?.toolUseId).toBe("waiting")
      expect(page.calls).toEqual([])
      runtime.answer("chat")
      runtime.ask("chat", "ask-1")
      runtime.ask("workflow-agent", "ask-2")
      runtime.ask("workflow-agent", "ask-2")
      await settle()
      expect(page.calls).toEqual([CHAT_PAGE, AGENT_PAGE])
      expect(runtime.detailReads).toEqual(["workflow-agent"])
      runtime.answer("workflow-agent")
      runtime.ask("chat", "ask-3")
      runtime.ask("workflow-agent", "ask-4")
      await settle()
      expect(page.calls.slice(2)).toEqual([CHAT_PAGE, AGENT_PAGE])
    } finally { page.dispose() }
  })

  test("an unrelated patch reads no row and pages no one", async () => {
    const runtime = fakeRuntime(new Map())
    const page = mount(runtime)
    try {
      runtime.unrelated("chat")
      await settle()
      expect(page.rowReads()).toBe(0)
      expect(runtime.detailReads).toEqual([])
      expect(page.calls).toEqual([])
    } finally { page.dispose() }
  })

  test("after a reconnect to the same runtime, or after it restarts, an unopened agent's next question pages", async () => {
    const runtime = fakeRuntime(new Map())
    const page = mount(runtime)
    try {
      runtime.ask("workflow-agent", "ask-1")
      await settle()
      runtime.answer("workflow-agent")
      runtime.reconnect()
      await settle()
      runtime.ask("workflow-agent", "ask-2")
      await settle()
      runtime.answer("workflow-agent")
      runtime.restart()
      runtime.ask("workflow-agent", "ask-3")
      await settle()
      expect(page.calls).toEqual([AGENT_PAGE, AGENT_PAGE, AGENT_PAGE])
    } finally { page.dispose() }
  })

  test("after a cold attach to a runtime whose agent asked and was answered before, the agent's next question pages", async () => {
    const runtime = fakeRuntime(new Map())
    runtime.ask("workflow-agent", "ask-1")
    runtime.answer("workflow-agent")
    const page = mount(runtime)
    try {
      runtime.ask("workflow-agent", "ask-2")
      await settle()
      expect(page.calls).toEqual([AGENT_PAGE])
    } finally { page.dispose() }
  })

  test("pages no one while paging is off, and a question asked then stays a baseline once it turns on", async () => {
    const runtime = fakeRuntime(new Map())
    const page = mount(runtime, false)
    try {
      runtime.ask("chat", "ask-1")
      await settle()
      page.setEnabled(true)
      await settle()
      expect(page.calls).toEqual([])
      runtime.ask("chat", "ask-2")
      await settle()
      expect(page.calls).toEqual([CHAT_PAGE])
    } finally { page.dispose() }
  })
})
