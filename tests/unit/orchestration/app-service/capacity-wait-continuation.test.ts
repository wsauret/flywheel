import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { continueCapacityWaits } from "../../../../src/orchestration/app-service/capacity-wait-continuation.js"
import { capacityWaitAuthority, registerCapacityWaits } from "../../../../src/orchestration/session/capacity-wait.js"
import { authorizePlannedSessionContinuation, readPlannedSessionContinuationAsync, type PlannedContinuationTarget } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, resumeDispatch, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

/** A continue time that has come. */
const AT = Date.parse("2026-10-28T02:00:00.000Z")

/** The sessions of a fixture project by id, as the continuation reads them. */
function sessions(rows: ReadonlyMap<string, { readonly kind: "chat" } | { readonly kind: "workflow-agent"; readonly workflowId: string } | { readonly kind: "subagent"; readonly parent: string }>) {
  return {
    read: async (id: string) => {
      const row = rows.get(id)
      if (!row) return null
      if (row.kind === "workflow-agent") return { kind: row.kind, conversationId: `${id}-conversation`, workflowMembership: { workflowId: row.workflowId } }
      if (row.kind === "subagent") return { kind: row.kind, launchedFrom: { parentSessionId: row.parent } }
      return row
    },
  }
}

describe("capacity waits", () => {
  let ctx: SupervisorTestContext
  beforeEach(() => { ctx = createSupervisorTestContext() })
  afterEach(async () => { await disposeSupervisorTestContext(ctx) })

  const reader = () => asAsyncEventReadSurface(ctx.store)
  const writer = () => ctx.runtime.runSync(EventStoreWriterService)
  const row = (sessionId: string) => readPlannedSessionContinuationAsync(reader(), sessionId)
  const owe = (target: PlannedContinuationTarget, extra: { readonly runId?: string; readonly continuesAt?: number } = {}) =>
    authorizePlannedSessionContinuation({ reader: reader(), writer: writer(), continuation: { target, continuesAt: AT, ...extra } })

  test("tell the account the earliest owed time before the row is written, write no row when the account refuses it, and leave every row an executor's stop ends for the next executor", async () => {
    const steps: string[] = []
    let refuse = false
    const waits = registerCapacityWaits(reader(), {
      reader: reader(), writer: writer(),
      recordWake: async (at) => {
        steps.push(`wake ${at === null ? "none" : at - AT} row ${(await row("chat-1"))?.continuesAt === undefined ? "absent" : "present"}`)
        if (refuse) throw new Error("the account store refused the wake")
      },
    })
    const chat = capacityWaitAuthority(reader(), { target: { kind: "chat", sessionId: "chat-1" } })
    const agent = capacityWaitAuthority(reader(), { target: { kind: "workflow-agent", sessionId: "agent-1" } })
    await chat?.arm(AT + 60_000)
    await agent?.arm(AT)
    expect(await row("chat-1")).toMatchObject({ continuesAt: AT + 60_000 })
    expect(await row("agent-1")).toMatchObject({ target: { kind: "workflow-agent", sessionId: "agent-1" }, continuesAt: AT })
    expect(await waits.wakeAt()).toBe(AT)
    await agent?.withdraw("continued")
    await Bun.sleep(0)
    expect(await row("agent-1")).toBeNull()
    expect(steps).toEqual(["wake 60000 row absent", "wake 0 row present", "wake 60000 row present"])

    await chat?.withdraw("message")
    refuse = true
    await expect(chat?.arm(AT) ?? Promise.resolve()).rejects.toThrow("the account store refused the wake")
    expect(await row("chat-1")).toBeNull()
    expect(await waits.wakeAt()).toBeNull()

    refuse = false
    await chat?.arm(AT)
    waits.close()
    await chat?.withdraw("cancelled")
    expect((await row("chat-1"))?.continuesAt).toBe(AT)
    waits.dispose()
  })

  test("leave a planned replacement's row of the session as it is", async () => {
    registerCapacityWaits(reader(), { reader: reader(), writer: writer() })
    await authorizePlannedSessionContinuation({ reader: reader(), writer: writer(), continuation: { target: { kind: "chat", sessionId: "chat-1" }, handoffId: "handoff" } })
    const wait = capacityWaitAuthority(reader(), { target: { kind: "chat", sessionId: "chat-1" } })
    await wait?.arm(AT)
    expect(await row("chat-1")).toMatchObject({ handoffId: "handoff" })
  })

  test("read the project's rows once, so a change to one wait costs the same however many waits the project holds", async () => {
    const costs: number[] = []
    for (const waiting of [3, 30]) {
      await disposeSupervisorTestContext(ctx)
      ctx = createSupervisorTestContext()
      for (let index = 0; index < waiting; index += 1) await owe({ kind: "chat", sessionId: `chat-${index}` })
      const counter = countStateRequests(reader())
      const waits = registerCapacityWaits(reader(), { reader: counter.reader, writer: writer(), recordWake: async () => {} })
      await waits.wakeAt()
      counter.take()
      const wait = capacityWaitAuthority(reader(), { target: { kind: "chat", sessionId: "new" } })
      await wait?.arm(AT + 1)
      await wait?.withdraw("continued")
      expect(await waits.wakeAt()).toBe(AT)
      costs.push(counter.take().length)
    }
    expect(costs[1]).toBe(costs[0])
  })

  test("continue each owed wait through its owning host: a chat by its Resume, the waiting agents of a workflow by one resume that names them, and a child after its parent's host; a wait whose time has not come is left for the account's wake at its time", async () => {
    const waits = registerCapacityWaits(reader(), { reader: reader(), writer: writer() })
    await owe({ kind: "chat", sessionId: "chat-ok" })
    await owe({ kind: "chat", sessionId: "chat-refused" })
    await owe({ kind: "chat", sessionId: "chat-failed" })
    await owe({ kind: "workflow-agent", sessionId: "agent-a" })
    await owe({ kind: "workflow-agent", sessionId: "agent-b" })
    await owe({ kind: "subagent", sessionId: "child-of-agent" }, { runId: "run-1" })
    await owe({ kind: "subagent", sessionId: "grandchild" }, { runId: "run-2" })
    await owe({ kind: "subagent", sessionId: "child-of-stopped" }, { runId: "run-3" })
    const later = Date.now() + 3_600_000
    await owe({ kind: "chat", sessionId: "chat-later" }, { continuesAt: later })
    await owe({ kind: "chat", sessionId: "chat-latest" }, { continuesAt: later + 60_000 })
    const live = capacityWaitAuthority(reader(), { target: { kind: "chat", sessionId: "chat-live" } })
    await live?.arm(AT)

    const steps: string[] = []
    const continued = await continueCapacityWaits({
      projectionReader: reader(), liveStore: reader(), ledger: waits, lanes: ctx.continuationLanes,
      manager: sessions(new Map([
        ["chat-ok", { kind: "chat" }], ["chat-later", { kind: "chat" }], ["chat-latest", { kind: "chat" }], ["chat-refused", { kind: "chat" }], ["chat-failed", { kind: "chat" }],
        ["agent-a", { kind: "workflow-agent", workflowId: "workflow-1" }], ["agent-b", { kind: "workflow-agent", workflowId: "workflow-1" }],
        ["agent-parent", { kind: "workflow-agent", workflowId: "workflow-2" }],
        ["child-of-agent", { kind: "subagent", parent: "agent-parent" }],
        ["middle", { kind: "subagent", parent: "chat-ok" }],
        ["grandchild", { kind: "subagent", parent: "middle" }],
        ["stopped-parent", { kind: "workflow-agent", workflowId: "workflow-stopped" }],
        ["child-of-stopped", { kind: "subagent", parent: "stopped-parent" }],
      ] as const)),
      dispatch: resumeDispatch(async (mutation) => {
        const sessionId = mutation.sessionId
        steps.push(`${mutation.type} ${sessionId}`)
        if (sessionId === "chat-failed") throw new Error("the executor could not open the chat")
        return sessionId === "chat-refused" ? { ok: false, error: "the runner refused the resume" } : { ok: true }
      }),
      workflows: {
        resumeWorkflow: async (workflowId, _address, continuation) => {
          const wake = continuation?.wake
          steps.push(`workflow ${workflowId} ${typeof wake === "object" ? [...wake.capacity].sort().join(" ") : String(wake)}`)
          return workflowId === "workflow-stopped" ? { kind: "unavailable", message: "the workflow's modules are off" } : { kind: "resumed", sessionId: workflowId }
        },
      },
      settled: () => {},
    })

    expect(steps.sort()).toEqual([
      "chat.resume chat-failed", "chat.resume chat-ok", "chat.resume chat-refused",
      "subagent.resume child-of-agent", "subagent.resume grandchild", "subagent.resume middle",
      "workflow workflow-1 agent-a-conversation agent-b-conversation",
      "workflow workflow-2 agent-parent-conversation",
      "workflow workflow-stopped stopped-parent-conversation",
    ])
    expect(continued).toEqual({ pending: 2, next: later })
    // A continuation that started keeps its row for its run, which withdraws it as it ends.
    for (const id of ["chat-ok", "agent-a", "agent-b", "child-of-agent", "grandchild"]) expect(waits.held(id)).toBe(true)
    expect(await row("chat-ok")).toMatchObject({ continuesAt: AT })
    expect(await row("chat-refused")).toBeNull()
    expect((await row("chat-later"))?.continuesAt).toBe(later)
    expect(waits.held("chat-later")).toBe(false)
    expect((await row("chat-failed"))?.continuesAt).toBe(AT)
    expect((await row("child-of-stopped"))?.continuesAt).toBe(AT)
    expect(waits.held("child-of-stopped")).toBe(false)
    expect((await row("chat-live"))?.continuesAt).toBe(AT)
  })

  test("keep owed an agent a live workflow did not continue and an agent whose session could not be read, and continue no wait a person withdrew before its lane opened", async () => {
    const waits = registerCapacityWaits(reader(), { reader: reader(), writer: writer() })
    await owe({ kind: "workflow-agent", sessionId: "agent-a" })
    await owe({ kind: "workflow-agent", sessionId: "agent-b" })
    await owe({ kind: "workflow-agent", sessionId: "agent-unread" })
    await owe({ kind: "chat", sessionId: "chat-withdrawn" })
    // A person's interrupt of the chat holds its lane while it withdraws the wait.
    const interrupt = Promise.withResolvers<void>()
    const interrupting = ctx.continuationLanes.run("chat-withdrawn", () => interrupt.promise)

    const steps: string[] = []
    const continuing = continueCapacityWaits({
      projectionReader: reader(), liveStore: reader(), ledger: waits, lanes: ctx.continuationLanes,
      manager: {
        read: async (id) => {
          if (id === "agent-unread") {
            // The continuation read the rows already: the person's interrupt withdraws the chat's wait, then leaves the lane.
            await waits.retire("chat-withdrawn", "message")
            interrupt.resolve()
            throw new Error("the session store is busy")
          }
          return sessions(new Map([["agent-a", { kind: "workflow-agent", workflowId: "workflow-1" }], ["agent-b", { kind: "workflow-agent", workflowId: "workflow-1" }], ["chat-withdrawn", { kind: "chat" }]] as const)).read(id)
        },
      },
      dispatch: resumeDispatch(async (mutation) => {
        steps.push(`${mutation.type} ${mutation.sessionId}`)
        return { ok: true }
      }),
      workflows: {
        // The live run continues only the agent whose attempt is open.
        resumeWorkflow: async (workflowId) => ({ kind: "resumed", sessionId: workflowId, continued: new Set(["agent-a-conversation"]) }),
      },
      settled: () => {},
    })
    await interrupting

    expect(await continuing).toEqual({ pending: 2, next: null })
    expect(steps).toEqual([])
    expect(waits.held("agent-a")).toBe(true)
    for (const id of ["agent-b", "agent-unread"]) {
      expect(waits.held(id)).toBe(false)
      expect((await row(id))?.continuesAt).toBe(AT)
    }
    expect(await row("chat-withdrawn")).toBeNull()
  })
})
