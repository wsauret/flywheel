import { describe, expect, test } from "bun:test"

import { asAsyncEventAppender, asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { createCommandInvokeService } from "../../../../src/orchestration/app-service/command-invoke-service.js"
import type { RuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { buildPapercutDrain } from "../../../../src/orchestration/modules/papercuts/drain.js"
import { testDirectories } from "../../../helpers/directories.js"
import { testCapabilityModules } from "../../../helpers/request-tool-surface.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorWithRunner, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

/** `/papercuts` as a client invokes it: through the runtime command service
 *  over a real supervisor, so the module handler's prompt and system line
 *  reach the session by the kernel primitives alone. */
function papercutsCommand(ctx: SupervisorTestContext, supervisor: RuntimeSupervisor, sessionId: string, argument?: string) {
  const { invoke } = createCommandInvokeService({
    catalog: { snapshot: () => ({ revision: 1, builtInCommands: [], offCommands: [] }) },
    availability: { snapshot: () => { throw new Error("/papercuts starts no method") } },
    moduleSelection: testCapabilityModules,
    manager: ctx.manager,
    sessionStore: ctx.sessionStore,
    supervisor,
    projectionReader: asAsyncEventReadSurface(ctx.store),
    eventWriter: ctx.runtime.runSync(EventStoreWriterService),
    directories: testDirectories(ctx.baseDir),
    authDirectory: () => ctx.baseDir,
  })
  return invoke({ type: "command.invoke", id: "papercuts", revision: 1, sessionId, ...(argument === undefined ? {} : { argument }) })
}

const allOn = async () => () => true

function recorded(sessionId: string, observation: string, parentToolUseId?: string) {
  return {
    aggregateId: `session:${sessionId}`,
    type: "papercut.recorded",
    version: 1,
    timestamp: Date.now(),
    actor: "agent",
    sessionId,
    payload: {
      observation,
      category: "defect",
      conversationId: `conversation-${sessionId}`,
      modelRequestId: `request-${sessionId}`,
      toolUseId: `tool-${sessionId}`,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    },
  }
}

describe("papercut drain command", () => {
  test("refreshes through the current store position and serializes complete attribution", async () => {
    const ctx = createSupervisorTestContext()
    try {
      const first = await ctx.store.append(recorded("owner-1", "First observation", "parent-1"))
      const beforeSecondConnection = await buildPapercutDrain(asAsyncEventReadSurface(ctx.store), "drain-session", allOn)
      expect(beforeSecondConnection.kind).toBe("ready")

      await asAsyncEventAppender(ctx.store).append(recorded("owner-2", "Second observation"))
      const refreshed = await buildPapercutDrain(asAsyncEventReadSurface(ctx.store), "drain-session", allOn)
      expect(refreshed.kind).toBe("ready")
      if (refreshed.kind !== "ready") throw new Error("expected ready drain")
      expect(refreshed.context).toContain(`"id":"${first.id}"`)
      expect(refreshed.context).toContain('"source":{"session":"owner-1","conversation":"conversation-owner-1","request":"request-owner-1","tool":"tool-owner-1","parent":"parent-1"}')
      expect(refreshed.context).toContain("Second observation")
      expect(refreshed.context).toContain("The user invoked /papercuts")
      expect(refreshed.context).toContain("Vet every record against current repository evidence")
      expect(refreshed.context).toContain("Judge the underlying pain")
      expect(refreshed.context).toContain("Delegate bounded investigations")
      expect(refreshed.context).toContain("Immediately dispose")
      expect(refreshed.context).toContain("fixed when current evidence shows the pain is gone")
      expect(refreshed.context).toContain("Judge whether each valid record is worth fixing")
      expect(refreshed.context).toContain("the guidance is the defect to fix")
      expect(refreshed.context).toContain("dismissed when the record is stale, duplicate, invalid, irrelevant, outside scope, or not worth fixing")
      expect(refreshed.context).toContain("Group the remaining records by root cause")
      expect(refreshed.context).toContain("Present one ordered campaign map")
      expect(refreshed.context).toContain("present the complete design for the highest-priority unit")
      expect(refreshed.context).toContain("Do not create plan Markdown files")
      expect(refreshed.context).toContain("Never use the promoted disposition")
      expect(refreshed.context).toContain("Continue through one approved unit at a time")
    } finally {
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("zero and only-disposed backlogs produce a visible no-live outcome without a turn", async () => {
    const ctx = createSupervisorTestContext()
    try {
      expect(await buildPapercutDrain(asAsyncEventReadSurface(ctx.store), "drain-session", allOn)).toEqual({ kind: "no-live", message: "No live project papercuts to drain." })
      const item = await ctx.store.append(recorded("owner", "Disposed observation"))
      await ctx.store.append({ aggregateId: "project:papercuts", type: "papercut.disposed", version: 1, timestamp: Date.now(), actor: "agent", sessionId: "drain-session", payload: { recordedFactId: item.id, disposition: "dismissed", disposingSessionId: "drain-session" } })
      expect((await buildPapercutDrain(asAsyncEventReadSurface(ctx.store), "drain-session", allOn)).kind).toBe("no-live")
    } finally {
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("rejects the complete survey when the selected attempt has no capacity and never truncates", async () => {
    const ctx = createSupervisorTestContext()
    try {
      await ctx.store.append(recorded("owner", "x".repeat(8_000)))
      await ctx.store.append({ aggregateId: "session:drain-session", type: "model.context.measured", version: 1, timestamp: Date.now(), actor: "provider", sessionId: "drain-session", payload: { promptTokens: 90, contextWindow: 100 } })
      const result = await buildPapercutDrain(asAsyncEventReadSurface(ctx.store), "drain-session", allOn)
      expect(result.kind).toBe("over-capacity")
      if (result.kind !== "over-capacity") throw new Error("expected capacity outcome")
      expect(result.message).toContain("fresh chat")
    } finally {
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("dispatches a durable invocation with one ordered request-only backlog", async () => {
    const ctx = createSupervisorTestContext()
    const requests: unknown[][] = []
    const supervisor = supervisorWithRunner(ctx, async ({ sessionId }) => mockRunner(sessionId, { requestWithContext: (...args: unknown[]) => { requests.push(args); return true } }))
    try {
      const sessionId = await supervisor.openSessionRuntime()
      await ctx.store.append(recorded("owner", "Live observation"))
      expect(await papercutsCommand(ctx, supervisor, sessionId)).toEqual({ kind: "none" })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.[0]).toEqual({ text: "Run the project papercut campaign.", invocation: { label: "/papercuts" } })
      expect(requests[0]?.[1]).toContain("Live observation")
      expect(requests[0]?.[1]).toContain("Delegate bounded investigations")
    } finally {
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })

  // The survey goes to the chat's own next request, so it offers delegation
  // only when that request can call the subagent or workflow tool.
  test.each([
    [["subagent", "workflow"], false],
    [["subagent"], true],
    [["workflow"], true],
  ] as const)("with %p off, the survey offers delegation: %p", async (off, delegates) => {
    const ctx = createSupervisorTestContext()
    const requests: unknown[][] = []
    const supervisor = supervisorWithRunner(ctx, async ({ sessionId }) => mockRunner(sessionId, {
      capabilities: async () => (term) => !off.some((refused) => refused === term),
      requestWithContext: (...args: unknown[]) => { requests.push(args); return true },
    }))
    try {
      const sessionId = await supervisor.openSessionRuntime()
      await ctx.store.append(recorded("owner", "Live observation"))
      expect(await papercutsCommand(ctx, supervisor, sessionId)).toEqual({ kind: "none" })
      const context = String(requests[0]?.[1])
      expect(context).toContain("Inspect the repository and relevant executable evidence.")
      expect(context.includes("Delegate bounded investigations")).toBe(delegates)
    } finally {
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("text after the command is shown as the invocation's message and reaches the model", async () => {
    const ctx = createSupervisorTestContext()
    const requests: unknown[][] = []
    const supervisor = supervisorWithRunner(ctx, async ({ sessionId }) => mockRunner(sessionId, { requestWithContext: (...args: unknown[]) => { requests.push(args); return true } }))
    try {
      const sessionId = await supervisor.openSessionRuntime()
      await ctx.store.append(recorded("owner", "Live observation"))
      expect(await papercutsCommand(ctx, supervisor, sessionId, "  only the TUI ones  ")).toEqual({ kind: "none" })
      expect(requests[0]?.[0]).toEqual({ text: "Run the project papercut campaign.\n\nonly the TUI ones", invocation: { label: "/papercuts", args: "only the TUI ones" } })
    } finally {
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("an empty backlog answers as one transcript line and starts no turn", async () => {
    const ctx = createSupervisorTestContext()
    const requests: unknown[][] = []
    const supervisor = supervisorWithRunner(ctx, async ({ sessionId }) => mockRunner(sessionId, { requestWithContext: (...args: unknown[]) => { requests.push(args); return true } }))
    try {
      const sessionId = await supervisor.openSessionRuntime()
      expect(await papercutsCommand(ctx, supervisor, sessionId)).toEqual({ kind: "none" })
      expect(requests).toEqual([])
      const entry = ctx.sessionStore.get(sessionId)
      expect(entry?.kind === "chat" ? entry.outputBlocks().map((block) => block.kind === "system" ? block.message : block.kind) : []).toEqual(["No live project papercuts to drain."])
    } finally {
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })
})
