import { afterEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../src/infra/event-store-types"
import { createBackgroundWorkRegistry, type BackgroundWorkRegistry } from "../src/orchestration/agent-runtime/background-work"
import { createMessageSessionTool } from "../src/orchestration/agent-runtime/tools/message-session"
import type { ToolContext } from "../src/orchestration/agent-runtime/tools/types"
import { dropQueuedUserInput, readUnreadMessages } from "../src/orchestration/session/conversation/queued-user-inputs"
import { registerLiveSessionControl, type LiveRecipientState } from "../src/orchestration/session/live-session-control"
import { createSessionManager } from "../src/orchestration/session/manager"
import { createSessionMessaging, type SessionMessaging } from "../src/orchestration/session/session-messaging"
import { openReplyWaitAddressees } from "../src/orchestration/session/reply-waits"
import { registerTestChildRun } from "../tests/helpers/live-child-run"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestSubagent } from "../tests/unit/orchestration/session/_session-manager-fixtures"

const unregisters: (() => void)[] = []

afterEach(async () => {
  for (const unregister of unregisters.splice(0)) unregister()
  await settle()
  cleanupTmpRoot()
})

function settle(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

function project() {
  const root = makeTmpDir()
  const { deps, store } = makeDepsWithStore(root)
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  const manager = createSessionManager({ ...deps, projectionReader: reader })
  const messaging: SessionMessaging = createSessionMessaging({ manager, projectionReader: reader, eventWriter: writer })
  return { root, store, reader, writer, manager, messaging }
}

type Project = ReturnType<typeof project>

interface LiveTestSession {
  state: LiveRecipientState
  readonly notices: { readonly text: string; readonly key?: string }[]
  readonly tasks: BackgroundWorkRegistry
}

function live(here: Project, sessionId: string, options: { readonly kind?: "chat" | "workflow" } = {}): LiveTestSession {
  const notices: LiveTestSession["notices"] = []
  const session: LiveTestSession = {
    state: "running",
    notices,
    tasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => { notices.push({ text, ...(key ? { key } : {}) }) } }),
  }
  unregisters.push(registerLiveSessionControl(here.reader, {
    sessionId,
    kind: options.kind ?? "chat",
    state: async () => session.state,
    deliver: async (_input, decide) => decide(session.state),
    notify: async () => true,
  }))
  return session
}

function context(sessionId: string, toolUseId: string): ToolContext {
  return {
    executionCwd: "/scratch",
    projectRoot: "/scratch",
    artifactScopeId: sessionId,
    retrievalSessionId: sessionId,
    sessionId,
    conversationId: `${sessionId}-conversation`,
    toolUseId,
  }
}

async function message(messaging: SessionMessaging, from: { readonly id: string; readonly tasks?: BackgroundWorkRegistry }, toolUseId: string, input: { readonly to: string; readonly text?: string; readonly wait?: boolean }) {
  const result = await createMessageSessionTool(messaging, from.tasks).execute({ ...input }, context(from.id, toolUseId))
  await settle()
  return result
}

async function read(here: Project, sessionId: string, senderSessionId: string, toolUseId: string): Promise<void> {
  await dropQueuedUserInput(here.writer, sessionId, `msg:${senderSessionId}:${toolUseId}`)
}

type RunWaits = Awaited<ReturnType<SessionMessaging["observeRun"]>>
type YieldInput = Parameters<RunWaits["yielded"]>[0]

/** The yield that a turn reports when it parks while its children still
 *  run. The runtime sends `parked: true` in that case; a release that no
 *  longer reads the field ignores it. */
function parkedOnChildren(lastText?: string): YieldInput {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the yield shape differs across releases
  return { ...(lastText ? { lastText } : {}), parked: true } as unknown as YieldInput
}

/** Whatever a release does when a parked turn takes input again. */
function resumed(run: RunWaits): void {
  (run as { resumed?: () => void }).resumed?.()
}

describe("a child that waits on its parent", () => {
  test("a wait with no text on a parent parked on its running children opens, and the parent's later reply ends it once", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    live(here, parent)
    unregisters.push(registerTestChildRun(here.reader, { sessionId: child, runId: "child-run", parentSessionId: parent, parentConversationId: `${parent}-conversation`, parentToolCallId: "child-tool" }))
    const notices: string[] = []
    const tasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: (text) => { notices.push(text) } })
    // The parent asked the person in prose and parked on its running child.
    await (await here.messaging.observeRun({ sessionId: parent })).yielded(parkedOnChildren())

    const waited = await message(here.messaging, { id: child, tasks }, "wait-1", { to: parent, wait: true })
    expect(waited.outcome).not.toBe("error")
    expect(waited.content).toStartWith(`Waiting on ${parent}`)
    expect(tasks.holdsWait("wait-1")).toBe(true)
    expect(openReplyWaitAddressees(here.reader, child)).toHaveLength(1)

    await message(here.messaging, { id: parent }, "answer-1", { to: child, text: "Keep it." })
    expect(tasks.holdsWait("wait-1")).toBe(false)
    expect(tasks.activeTaskCount()).toBe(0)
    expect(notices).toEqual([])
    expect(openReplyWaitAddressees(here.reader, child)).toEqual([])
  })

  test("the prose-question case with a running child: the child waits again with no text, and the later reply ends that wait", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    const p = live(here, parent)
    const c = live(here, child, { kind: "workflow" })
    const parentRun = await here.messaging.observeRun({ sessionId: parent })

    await message(here.messaging, { id: child, tasks: c.tasks }, "ask-1", { to: parent, text: "Keep the old API?", wait: true })
    await read(here, parent, child, "ask-1")
    // The parent asks the person in prose and ends its turn while the child still runs.
    p.state = "idle"
    await parentRun.yielded(parkedOnChildren("Do you want to keep the old API? I will tell the child."))
    await settle()
    expect(c.tasks.holdsWait("ask-1")).toBe(false)
    expect(c.notices[0]?.text).toContain("I will tell the child.")

    const again = await message(here.messaging, { id: child, tasks: c.tasks }, "wait-2", { to: parent, wait: true })
    expect(again.content).toStartWith(`Waiting on ${parent}`)
    // Nothing was sent: the wait holds no message for the parent to read.
    expect(await readUnreadMessages(here.reader, parent)).toEqual([])
    resumed(parentRun)
    p.state = "running"
    await message(here.messaging, { id: parent }, "answer-1", { to: child, text: "Keep it." })
    expect(c.tasks.holdsWait("wait-2")).toBe(false)
    expect(c.notices).toHaveLength(1)
  })

  test("a parent that reads the question and then parks on its children still ends the child's wait", async () => {
    const here = project()
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(here.manager, here.root, "child", parent)
    live(here, parent)
    const c = live(here, child, { kind: "workflow" })
    const parentRun = await here.messaging.observeRun({ sessionId: parent })

    await message(here.messaging, { id: child, tasks: c.tasks }, "ask-1", { to: parent, text: "Keep the old API?", wait: true })
    await read(here, parent, child, "ask-1")
    await parentRun.yielded(parkedOnChildren("Checking with the reviewer child first."))
    await settle()
    expect(c.tasks.holdsWait("ask-1")).toBe(false)
    expect(c.notices[0]?.text).toContain("Checking with the reviewer child first.")
  })
})

describe("the cycle check", () => {
  test("a wait with no text on a session that waits on the waiter for a reply is refused", async () => {
    const here = project()
    const [a, b] = await Promise.all(["A", "B"].map((name) => here.manager.createChat({ name })))
    const sa = { id: a!, ...live(here, a!) }
    const sb = { id: b!, ...live(here, b!) }
    await message(here.messaging, sa, "a-waits", { to: b!, text: "need B", wait: true })

    const closing = await message(here.messaging, sb, "b-waits", { to: a!, wait: true })
    expect(closing.content).toContain("it already waits on you")
    expect(sb.tasks.activeTaskCount()).toBe(0)
  })

  test("a three-session cycle of waits cannot form", async () => {
    const here = project()
    const [a, b, c] = await Promise.all(["A", "B", "C"].map((name) => here.manager.createChat({ name })))
    const [sa, sb, sc] = [a!, b!, c!].map((id) => ({ id, ...live(here, id) }))
    await message(here.messaging, sa!, "a-waits", { to: b!, text: "need B", wait: true })
    await message(here.messaging, sb!, "b-waits", { to: c!, text: "need C", wait: true })

    const closing = await message(here.messaging, sc!, "c-waits", { to: a!, wait: true })
    expect(closing.content).toContain("it already waits on you")
    expect(sc!.tasks.activeTaskCount()).toBe(0)
  })
})
