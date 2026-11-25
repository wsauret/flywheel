import { afterEach, describe, expect, test } from "bun:test"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work/background-work"
import type { AsyncEventStateReadSurface } from "../../../../src/infra/substrate/store/event-store-types"
import { notifyLiveWorkChanged, registerLiveSessionControl, registerLiveWorkflowControl } from "../../../../src/orchestration/session/control/live-session-control"
import type { LiveRecipientState } from "../../../../src/orchestration/session/message-disposition"
import { observeSessionYield, openReplyWait, type ReplyWaitDeps } from "../../../../src/orchestration/session/control/messaging/reply-waits"
import { registerTestChildRun } from "../../../helpers/live-child-run"
import { countStateRequests } from "../../../helpers/state-requests"
import { publishTestSubagent } from "./_session-manager-fixtures"
import { unregisters, settle, project, live, runChild, message, read, cleanupReplyWaitTest, childWorkflow } from "./_reply-wait-fixtures"

afterEach(cleanupReplyWaitTest)

/** One live agent of `workflowId`, registered as its run registers it. */
function registerMember(reader: AsyncEventStateReadSurface, sessionId: string, workflowId: string): () => void {
  return registerLiveSessionControl(reader, {
    sessionId, state: async () => "interrupted",
    member: {
      workflowId, modules: async () => undefined, backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }),
      compact: async () => false, interrupt: () => false, releaseForegroundBash: () => false, transferForegroundForReplacement: async () => {}, terminateBackgroundWork: () => {},
    },
    deliver: async (_input, decide) => decide("interrupted"),
    notify: async () => false,
  })
}

/** What the parked workflow's live control reports: whether runnable work
 *  remains, and its members. */
interface WorkflowProgress {
  readonly runnable: boolean
  readonly members: readonly { sessionId: string; state: LiveRecipientState; tasks?: ReturnType<typeof createBackgroundWorkRegistry> }[]
}

/** A workflow agent asks the chat that launched its workflow, and the chat
 *  reads the question and parks on the workflow with the wait open. */
async function parkOnWorkflow(here: ReturnType<typeof project>, progress: () => WorkflowProgress) {
  const parent = await here.manager.createChat({ name: "Root" })
  const agent = await childWorkflow(here, parent, "Review")
  const identity = await here.messaging.identity(agent)
  if (!identity?.workflowMembership) throw new Error("Expected workflow membership")
  const workflowId = identity.workflowMembership.workflowId
  const p = live(here, parent)
  live(here, agent).state = "waiting_on_work"
  const agentTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} })
  p.tasks.track({ done: new Promise(() => {}), meta: { id: workflowId, type: "workflow", description: "Review" } })
  unregisters.push(registerLiveWorkflowControl(here.reader, {
    workflowId, kind: "workflow",
    handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
    state: async () => "waiting_on_work",
    workProgress: async () => {
      const { runnable, members } = progress()
      return { runnable, members: [{ sessionId: agent, conversationId: identity.conversationId, state: "waiting_on_work", tasks: agentTasks }, ...members.map((member) => ({ ...member, conversationId: `${member.sessionId}-conversation` }))] }
    },
    deliver: async (_input, decide) => decide("waiting_on_work"),
    notify: async () => false,
  }))
  await message(here.messaging, { id: agent, tasks: agentTasks }, "ask-parent", { to: parent, text: "Keep the API?", wait: true })
  await read(here, parent, agent, "ask-parent")
  await (await here.messaging.observeRun({ sessionId: parent, tasks: p.tasks })).yielded({ lastText: "I wait for the workflow.", waitRequested: true })
  await settle()
  expect(agentTasks.holdsWait("ask-parent")).toBe(true)
  return { workflowId, agent, agentTasks }
}

describe("parks wake by changed key", () => {
  test("live-work changes of unrelated sessions issue no reads and re-evaluate no park, for 2 and for 200 parks", async () => {
    for (const parks of [2, 200]) {
      const here = project()
      const counter = countStateRequests(here.reader)
      // The waits read no sessions, so each park costs only its own wait cell.
      const deps: ReplyWaitDeps = { projectionReader: counter.reader, eventWriter: here.writer, addresseeState: async () => "running", lineage: async (sessionId) => [sessionId] }
      const waiter = { sessionId: "waiter", tasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }) }
      for (let index = 0; index < parks; index++) {
        const parked = `parked-${index}`
        const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
        // Each parked session waits on a child of its own, which its park walk reads.
        runChild(tasks, `child-${index}`)
        await (await openReplyWait(deps, { waiter, addressee: { sessionId: parked, name: parked }, toolUseId: `wait-${index}` })).accepted()
        await observeSessionYield(counter.reader, { sessionId: parked, tasks }, { waitRequested: true })
      }
      await settle()
      expect(waiter.tasks.activeTaskCount()).toBe(parks)

      counter.take()
      for (let change = 0; change < 10; change++) {
        notifyLiveWorkChanged(counter.reader, `session:unrelated-${change}`)
        notifyLiveWorkChanged(counter.reader, `workflow:unrelated-${change}`)
        registerMember(counter.reader, `unrelated-member-${change}`, `unrelated-workflow-${change}`)()
      }
      await settle()
      expect(counter.take()).toEqual([])
      expect(waiter.tasks.activeTaskCount()).toBe(parks)
    }
  })

  test("a change of the awaited child wakes its park once and the reply is delivered", async () => {
    // The waits read through a counted reader, which every live control of the test registers on.
    const plain = project()
    const counter = countStateRequests(plain.reader)
    const here = { ...plain, reader: counter.reader, messaging: plain.runtime(counter.reader) }
    const parent = await here.manager.createChat({ name: "Root" })
    const child = await childWorkflow(here, parent, "Child")
    const grandchild = await publishTestSubagent(here.manager, here.root, "grandchild", child)
    const p = live(here, parent)
    const c = live(here, child)
    const stopGrandchild = registerTestChildRun(here.reader, { sessionId: grandchild, runId: "grandchild-run", parentSessionId: child, parentConversationId: `${child}-conversation`, parentToolCallId: "grandchild-tool" })
    runChild(c.tasks, grandchild)
    await message(here.messaging, { id: parent, tasks: p.tasks }, "wait-1", { to: child, wait: true })
    const childRun = await here.messaging.observeRun({ sessionId: child, tasks: c.tasks })
    counter.take()
    await childRun.yielded({ waitRequested: true })
    await settle()
    const evaluation = counter.take().map(({ method, aggregateId }) => ({ method, aggregateId }))
    expect(evaluation.length).toBeGreaterThan(0)
    expect(p.tasks.holdsWait("wait-1")).toBe(true)

    // The grandchild's run leaves this process.
    stopGrandchild()
    await settle()
    expect(counter.take().map(({ method, aggregateId }) => ({ method, aggregateId }))).toEqual(evaluation)
    expect(p.tasks.holdsWait("wait-1")).toBe(true)

    await message(here.messaging, { id: child }, "answer-1", { to: parent, text: "Done." })
    expect(p.tasks.holdsWait("wait-1")).toBe(false)
    expect(p.notices).toEqual([])
    expect(p.received.map((input) => input.text)).toEqual(["Done."])
  })

  test("a workflow member session that stops running wakes the park of a wait on that workflow", async () => {
    const here = project()
    let siblingState: LiveRecipientState = "running"
    const { workflowId, agentTasks } = await parkOnWorkflow(here, () => ({ runnable: false, members: [{ sessionId: "sibling-member", state: siblingState }] }))
    const stopSibling = registerMember(here.reader, "sibling-member", workflowId)
    await settle()
    expect(agentTasks.holdsWait("ask-parent")).toBe(true)

    siblingState = "interrupted"
    stopSibling()
    await settle()
    expect(agentTasks.holdsWait("ask-parent")).toBe(false)
  })

  test("a running member that starts to wait on another agent of its workflow wakes the park of a wait on that workflow", async () => {
    const here = project()
    const siblingTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} })
    // The running sibling is the only work that can wake the parked chat.
    const { agent, agentTasks } = await parkOnWorkflow(here, () => ({ runnable: false, members: [{ sessionId: "sibling-member", state: "running", tasks: siblingTasks }] }))

    // The sibling stays registered and running, and waits on the agent that waits on the chat.
    const deps: ReplyWaitDeps = { projectionReader: here.reader, eventWriter: here.writer, addresseeState: async () => "running", lineage: async (sessionId) => [sessionId] }
    await openReplyWait(deps, { waiter: { sessionId: "sibling-member", tasks: siblingTasks }, addressee: { sessionId: agent, name: "Review" }, toolUseId: "sibling-wait" })
    await settle()
    expect(agentTasks.holdsWait("ask-parent")).toBe(false)
  })

  test("a session registered under a visited workflow after the walk wakes the park", async () => {
    const here = project()
    let progress: WorkflowProgress = { runnable: true, members: [] }
    const { workflowId, agentTasks } = await parkOnWorkflow(here, () => progress)

    // The runnable work became an agent, which a person interrupted at once.
    progress = { runnable: false, members: [{ sessionId: "next-member", state: "interrupted" }] }
    unregisters.push(registerMember(here.reader, "next-member", workflowId))
    await settle()
    expect(agentTasks.holdsWait("ask-parent")).toBe(false)
  })
})
