import { expect, spyOn, test } from "bun:test"
import { ManagedRuntime, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EventReaderService, EventStoreLive, EventStoreService, LocalEventStoreService } from "../../../../src/infra/event-store-effect"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { liveSessionControl, liveWorkflowControl, messageDisposition } from "../../../../src/orchestration/session/live-session-control"
import { deliverSessionInput } from "../../../../src/orchestration/session/session-input-delivery"
import { createWorkflowRunner } from "../../../../src/orchestration/workflow-host/runner"
import type { WorkflowWake } from "../../../../src/orchestration/workflow-host/runner-types"
import { EARLIER_AGENT_SESSION_REFUSAL, resolveWorkflowDeliveryAddress } from "../../../../src/orchestration/workflow-host/workflow-addressing"
import { holdAddressedWorkflowMessage, WHOLE_WORKFLOW } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema"
import { fixtureSkills, workflow } from "../../workflows/vm/host-test-support"
import { cleanupProjectRoots, createCapabilities, createDeps, makeWorkflowDeps, noConversationRecall } from "./_workflow-controller-fixtures"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller"
import { personCutRefusal } from "../../../../src/orchestration/session/child-continuation"
import { newTestRunner } from "../../../helpers/agent-runner"
import { refusingLauncher } from "../../../helpers/launcher-fake"
import { asModelClient } from "../agent-runtime/_model-client"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/publish"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store"
import { attemptIdOf, attemptNodeIdOf } from "../../../../src/workflows/vm/graph-types"
import { createWorkflowDurationReader } from "../../../../src/orchestration/modules/workflows/duration"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog"
import { frontendAttempts } from "../../../../src/orchestration/workflow-host/frontend-attempts"
import { workflowOutline } from "../../../../src/protocol/client/workflow-outline"
import { activeTimeMs } from "../../../../src/protocol/client/session-time"

async function fixture(queuedSuccessor = false, opening?: "before" | "assembling", messageAtPublication = false) {
  const root = mkdtempSync(join(tmpdir(), "workflow-target-interrupt-"))
  const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(root)))
  const store = await runtime.runPromise(EventStoreService)
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    ...workflow,
    phases: [
      { phase: "both", agents: [{ agent: "a", brief: "Do the work.", name: "A", writes: [] }, { agent: "b", brief: "Do the work.", name: "B", writes: [] }] },
      // A later phase of parallel agents, so its agent `c` is an address
      // that waits while the first phase runs.
      ...(queuedSuccessor ? [{ phase: "next", agents: [{ agent: "c", brief: "Do the work.", name: "C", writes: [] }, { agent: "d", brief: "Do the work.", name: "D", writes: [] }] }] : []),
    ],
  })
  const manager = createSessionManager({ projectRoot: root, executionCwd: root, projectionReader: store, writer: store })
  await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
  const ready = Promise.withResolvers<void>()
  const counts = new Map<string, number>()
  const parks = new Map<string, PromiseWithResolvers<void>>()
  const resumed = new Map<string, PromiseWithResolvers<string>>()
  const finishes = new Map<string, PromiseWithResolvers<void>>()
  const completed = new Map<string, PromiseWithResolvers<void>>()
  const unsubscribe = runtime.runSync(LocalEventStoreService).onStored((facts) => {
    for (const fact of facts) if (fact.type === "attempt.succeeded") completed.get(String(fact.payload.attemptId))?.resolve()
  })
  const interrupted: string[] = []
  const aggregate: (string | undefined)[] = []
  const allInterrupted = Promise.withResolvers<void>()
  const base = makeWorkflowDeps()
  const capabilities = createCapabilities()
  let handBackEnabled = true
  const revision = { ...base.definitions.captureRevision(), skills: fixtureSkills }
  const prepared = await prepareWorkflowLaunch({ workflow: definition, description: "task", deps: base, authProfileId: "default", projectRoot: root, definitionRevision: revision })
  await manager.publishWorkflow({ id: "session", ...prepared, facts: prepared.workflowFacts, launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" } })
  let cutOpening = opening === "assembling"
  let assemblingCut: Promise<boolean> | undefined
  let earlyMessage = messageAtPublication
  // Runs while a member opens, before its input reads the attempt's durable turn end.
  let onAttach: ((memberSessionId: string) => Promise<void>) | undefined
  const makeRunner = (wake?: WorkflowWake, startMode: "launch" | "operator_resume" = "launch") => createWorkflowRunner({
    sessionId: "session", workflow: definition, startMode, wake, description: "task", projectRoot: root, executionCwd: root,
    runtime, projectionReader: store,
    manager,
    attachChildProjection: async ({ sessionId }) => {
      if (earlyMessage) {
        earlyMessage = false
        await deliverSessionInput({ manager, projectionReader: store, eventWriter: store }, sessionId, { text: "Continue this member during initialization." })
      }
      await onAttach?.(sessionId)
      return { onEvent() {}, queueUserMessage() {}, lifecycle: {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {}, dispose: async () => {} }
    },
    workflowDeps: {
      ...base,
      capabilityAccess: {
        available: () => true,
        admit: async (request) => handBackEnabled ? capabilities.admit(request)
          : { ok: false, missing: ["workflows"], reason: "Workflows are disabled" },
      },
      definitionRevision: revision,
      createAgent(options) {
        if (options.purpose.kind !== "workflow-agent") return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }) }
        const id = options.purpose.workflowAttemptId
        if (cutOpening) {
          cutOpening = false
          assemblingCut = runner.interrupt("person")
        }
        finishes.set(id, Promise.withResolvers<void>())
        return newTestRunner({ ...options, runtimeSurfaces: { ...options.runtimeSurfaces, launcher: refusingLauncher }, agentRegistry: new Map(), agentsMd: "",
          lifecycle: { ...options.lifecycle, async onTurnParked(ctx) {
            await options.lifecycle.onTurnParked?.(ctx)
            if (ctx.park !== "interrupted") return
            interrupted.push(id)
            if (!parks.has(id)) parks.set(id, Promise.withResolvers<void>())
            parks.get(id)?.resolve()
            if (new Set([...parks.keys(), ...counts.keys()]).size === 2) ready.resolve()
          } },
        }, async () => asModelClient({
          accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5.4", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools(request) {
            counts.set(id, (counts.get(id) ?? 0) + 1)
            if (new Set([...parks.keys(), ...counts.keys()]).size === 2) ready.resolve()
            if (counts.get(id)! > 1) resumed.get(id)?.resolve(JSON.stringify(request.messages))
            yield { kind: "text_delta", text: "working", blockKey: "text" }
            await Promise.race([finishes.get(id)!.promise, new Promise<void>((resolve) => {
              if (request.signal?.aborted) resolve()
              else request.signal?.addEventListener("abort", () => resolve(), { once: true })
            })])
            if (!request.signal?.aborted) {
              yield { kind: "tool_use", toolCall: { id: `handoff-${id}`, name: "handoff", input: { summary: "done", files_modified: [] } } }
              yield { kind: "done", stopReason: "tool_use" }
            }
          },
        }), undefined, base.captureProviderConnection)
      },
    },
    recall: noConversationRecall, onCoreCompleted: async () => ({ durable: true }),
    onInterruptionChanged: () => {
      aggregate.push(runner.interruption())
      if (runner.interruption() === "person") allInterrupted.resolve()
    },
  })
  let runner = makeRunner()
  expect(await runner.prepare()).toBeNull()
  let running = runner.run()
  if (opening === "before") expect(await runner.interrupt("person")).toBe(true)
  await Promise.race([ready.promise, running.then((result) => { throw new Error(`Workflow ended before both agents ran: ${JSON.stringify(result)}`) })])
  if (assemblingCut) expect(await assemblingCut).toBe(true)
  const address = async (key: string) => {
    const result = await resolveWorkflowDeliveryAddress(store, "session", [key])
    if (!result.ok) throw new Error(result.refusal)
    return result.address
  }
  const attempts = [...new Set([...counts.keys(), ...parks.keys()])]
  for (const id of attempts) { if (!parks.has(id)) parks.set(id, Promise.withResolvers<void>()); resumed.set(id, Promise.withResolvers<string>()); completed.set(id, Promise.withResolvers<void>()) }
  return {
    localStore: runtime.runSync(LocalEventStoreService), get runner() { return runner }, get running() { return running }, store, root, counts, interrupted, aggregate, address, attempts, parks, resumed, finishes, completed, allInterrupted: allInterrupted.promise,
    control: liveWorkflowControl(runtime.runSync(EventReaderService), "session")!,
    async member(attemptId: string) { return (await workflowMembershipReader(store).attempt("session", attemptId))! },
    async message(sessionId: string) { return deliverSessionInput({ manager, projectionReader: store, eventWriter: store }, sessionId, { text: "Continue this agent only." }) },
    setHandBackEnabled(enabled: boolean) { handBackEnabled = enabled },
    onAttach(hook: (memberSessionId: string) => Promise<void>) { onAttach = hook },
    async restart(wake: WorkflowWake, runtimeAttempts: readonly string[] = []) {
      await runner.abort("runtime")
      await running
      await runner.dispose()
      for (const id of attempts) { parks.set(id, Promise.withResolvers<void>()); resumed.set(id, Promise.withResolvers<string>()) }
      runner = makeRunner(wake, "operator_resume")
      expect(await runner.prepare()).toBeNull()
      running = runner.run()
      await Promise.all(attempts.map((id) => runtimeAttempts.includes(id) ? resumed.get(id)!.promise : parks.get(id)!.promise))
    },
    async dispose() {
      await runner.abort("runtime")
      await running
      await runner.dispose()
      unsubscribe()
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test("a person's private message during member initialization releases only that member's opening interrupt", async () => {
  const f = await fixture(false, "before", true)
  try {
    expect([...f.counts.values()]).toEqual([1])
    expect(f.interrupted).toHaveLength(1)
    const active = await f.member([...f.counts.keys()][0]!)
    expect(await liveSessionControl(f.store, active.sessionId)!.state()).toBe("running")
    const parked = await f.member(f.interrupted[0]!)
    expect(await liveSessionControl(f.store, parked.sessionId)!.state()).toBe("interrupted")
  } finally { await f.dispose() }
})

test("an agent view's attempt names its agent's address, and an attempt that a retry replaced names none", async () => {
  const f = await fixture()
  try {
    const labels: string[] = []
    for (const attemptId of f.attempts) {
      const resolved = await resolveWorkflowDeliveryAddress(f.store, "session", { attemptId })
      if (!resolved.ok) throw new Error(resolved.refusal)
      const definitionId = resolved.address.label.replace(/^agent /, "")
      expect(resolved.address).toEqual(await f.address(definitionId))
      labels.push(resolved.address.label)
    }
    expect(labels.toSorted()).toEqual(["agent a", "agent b"])
    const replaced = attemptIdOf(attemptNodeIdOf(f.attempts[0]!)!, 99)
    expect(await resolveWorkflowDeliveryAddress(f.store, "session", { attemptId: replaced })).toEqual({ ok: false, refusal: EARLIER_AGENT_SESSION_REFUSAL })
  } finally { await f.dispose() }
})

test("targeted Interrupt and Resume leave a streaming sibling untouched and require per-agent parent authority", async () => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    const queue = await f.runner.readQueue()
    const first = queue.attempts.find(({ definitionId }) => definitionId === "a")!.id
    const second = queue.attempts.find(({ definitionId }) => definitionId === "b")!.id
    expect(await f.runner.interrupt("person", a)).toBe(true)
    await f.parks.get(first!)!.promise
    expect(f.interrupted).toEqual([first!])
    expect(f.runner.interruption()).toBeUndefined()
    expect(f.aggregate).toEqual([])
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "person" })
    await f.runner.interrupt("agent", a)
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "person" })
    expect(await f.runner.interrupt("agent", b)).toBe(true)
    await f.parks.get(second!)!.promise
    expect(f.runner.interruption()).toBe("person")
    const producer = { kind: "session" as const, sessionId: "parent", conversationId: "parent-conversation", toolUseId: "message", hop: 0 }
    const decide = (state: Parameters<typeof messageDisposition>[0]["state"]) => messageDisposition({ state, origin: "session", hop: 0, self: false, relation: "parent" })
    expect(await f.control.deliver({ text: "do not wake person park", producer }, decide, a)).toEqual({ status: "held", reason: "interrupted" })
    expect(await f.control.deliver({ text: "whole stays held", producer }, decide, WHOLE_WORKFLOW)).toEqual({ status: "held", reason: "interrupted" })
    expect(await f.control.deliver({ text: "resume b only", producer }, decide, b)).toEqual({ status: "delivered", startsTurn: false })
    expect(await f.resumed.get(second!)!.promise).toContain("resume b only")
    expect(f.counts.get(first!)).toBe(1)
    expect(f.runner.interruption()).toBeUndefined()
    expect(await f.runner.handBack(b)).toEqual({ kind: "not_parked" })
    const member = await f.member(first)
    expect(await f.message(member.sessionId)).toMatchObject({ status: "delivered", startsTurn: true })
    await f.resumed.get(first!)!.promise
    expect(f.counts.get(first!)).toBe(2)
    expect(await f.runner.cut(a)).toBeUndefined()
    expect(await liveSessionControl(f.store, member.sessionId)!.state()).toBe("running")
    f.parks.set(first, Promise.withResolvers<void>())
    expect(await f.runner.interrupt("person", a)).toBe(true)
    await f.parks.get(first)!.promise
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "person" })
    f.resumed.set(first, Promise.withResolvers<string>())
    f.setHandBackEnabled(false)
    expect(await f.message(member.sessionId)).toMatchObject({ status: "held", reason: "interrupted" })
    await f.runner.continueHeldMessages()
    expect(f.counts.get(first)).toBe(2)
    f.setHandBackEnabled(true)
    await f.runner.continueHeldMessages()
    await f.resumed.get(first)!.promise
    expect(f.counts.get(first)).toBe(3)
    expect(f.counts.get(second)).toBe(2)
    expect(await f.runner.cut(a)).toBeUndefined()
  } finally { await f.dispose() }
})

test("the parent's whole-run Interrupt after a person's targeted Interrupt leaves the person's agent beyond the parent's Resume", async () => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const queue = await f.runner.readQueue()
    const first = queue.attempts.find(({ definitionId }) => definitionId === "a")!.id
    const second = queue.attempts.find(({ definitionId }) => definitionId === "b")!.id
    expect(await f.runner.interrupt("person", a)).toBe(true)
    await f.parks.get(first)!.promise
    expect(await f.runner.interrupt("agent", WHOLE_WORKFLOW)).toBe(true)
    await f.parks.get(second)!.promise
    const workflowHosts = createMockWorkflowHosts()
    workflowHosts._runners.set("session", f.runner)
    const controller = createWorkflowController(createDeps({ workflowHosts, eventReader: f.store, projectionReader: f.store, eventWriter: f.store }))
    expect(await controller.resumeLaunch("session")).toEqual({ ok: false, error: personCutRefusal({ kind: "interrupt", by: "person" }) })
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "person" })
    expect(f.counts.get(first)).toBe(1)
    expect(f.counts.get(second)).toBe(1)
  } finally {
    await f.dispose()
    cleanupProjectRoots()
  }
})

test("a planned successor restores person and parent parks independently and targeted Resume leaves its sibling parked", async () => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    const queue = await f.runner.readQueue()
    const first = queue.attempts.find(({ definitionId }) => definitionId === "a")!.id
    const second = queue.attempts.find(({ definitionId }) => definitionId === "b")!.id
    await f.runner.interrupt("person", a)
    await f.runner.interrupt("agent", b)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    await f.restart("planned")
    expect(f.counts.get(first)).toBe(1)
    expect(f.counts.get(second)).toBe(1)
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "person" })
    expect(await f.runner.cut(b)).toEqual({ kind: "interrupt", by: "agent" })
    expect(await f.runner.cut()).toEqual({ kind: "interrupt", by: "person" })
    expect(await f.runner.handBack(b)).toEqual({ kind: "continued" })
    await f.resumed.get(second)!.promise
    expect(f.counts.get(first)).toBe(1)
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "person" })
    expect(await f.runner.cut(b)).toBeUndefined()
  } finally { await f.dispose() }
})

test("a person's Resume that lands before a re-entered agent reads its durable cut continues that agent", async () => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    const queue = await f.runner.readQueue()
    const first = queue.attempts.find(({ definitionId }) => definitionId === "a")!.id
    const second = queue.attempts.find(({ definitionId }) => definitionId === "b")!.id
    await f.runner.interrupt("person", a)
    await f.runner.interrupt("agent", b)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    const member = await f.member(first)
    let answer: unknown
    f.onAttach(async (memberSessionId) => {
      if (memberSessionId !== member.sessionId) return
      answer = await f.runner.handBack(a)
      // An agent that opens interrupted parks instead, which also ends the restart's wait.
      void f.parks.get(first)!.promise.then(() => f.resumed.get(first)!.resolve("parked"))
    })
    await f.restart("planned", [first])
    expect(answer).toEqual({ kind: "continued" })
    expect(f.counts.get(first)).toBe(2)
    expect(await f.runner.cut(a)).toBeUndefined()
    expect(await f.runner.cut(b)).toEqual({ kind: "interrupt", by: "agent" })
    expect(f.counts.get(second)).toBe(1)
  } finally { await f.dispose() }
})

test.each(["whole", "automatic"] as const)("a %s hand-back with a held message releases only its authorized coverage", async (kind) => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    await f.runner.interrupt("person", WHOLE_WORKFLOW)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    expect(await holdAddressedWorkflowMessage(f.store, "session", "held-a", { text: "continue a" }, a)).toBe(true)
    if (kind === "whole") expect(await f.runner.handBack()).toEqual({ kind: "continued" })
    else await f.runner.continueHeldMessages()
    expect(await f.runner.cut(a)).toBeUndefined()
    expect(await f.runner.cut(b)).toEqual(kind === "whole" ? undefined : { kind: "interrupt", by: "person" })
  } finally { await f.dispose() }
})

test("a person's addressed hand-back that starts its turn before the cut is cleared leaves the agent parked by the next whole Interrupt", async () => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const first = (await f.runner.readQueue()).attempts.find(({ definitionId }) => definitionId === "a")!.id
    expect(await f.runner.interrupt("person")).toBe(true)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    // A durable append as slow as a live store's: the record that clears the
    // cut lands only after the woken agent started its hand-back turn.
    const append = f.localStore.append.bind(f.localStore)
    const handBackTurn = f.resumed.get(first)!.promise
    let clearedCuts = 0
    f.localStore.append = async (event) => {
      if (event.type === "workflow.run.cut.updated" && event.payload.cut === null) {
        clearedCuts += 1
        await handBackTurn
      }
      return append(event)
    }
    const person = (state: Parameters<typeof messageDisposition>[0]["state"]) => messageDisposition({ state, origin: "human", hop: 0, self: false })
    expect(await holdAddressedWorkflowMessage(f.store, "session", "agent-view-a", { text: "Continue agent a." }, a)).toBe(true)
    await f.control.deliver({ text: "Continue agent a.", dispatchIds: ["agent-view-a"] }, person, a)
    await handBackTurn
    expect(clearedCuts).toBe(1)
    f.resumed.set(first, Promise.withResolvers<string>())
    f.parks.set(first, Promise.withResolvers<void>())
    expect(await f.runner.interrupt("person")).toBe(true)
    await f.parks.get(first)!.promise
    expect(f.counts.get(first)).toBe(2)
    expect(await f.runner.cut()).toEqual({ kind: "interrupt", by: "person" })
    const member = await f.member(first)
    expect(await liveSessionControl(f.store, member.sessionId)!.state()).toBe("interrupted")
    // The park takes a Resume left in its queue before the person's next
    // message, so the request after the park shows whether one was left.
    expect(await f.message(member.sessionId)).toMatchObject({ status: "delivered", startsTurn: true })
    const next: readonly { kind: string; content: unknown }[] = JSON.parse(await f.resumed.get(first)!.promise)
    expect(next.findLast(({ kind }) => kind === "user")?.content).toBe("Continue this agent only.")
  } finally { await f.dispose() }
})

test.each(["grouped", "individual"] as const)("a %s Resume releases whole-cut authority over the agents it continues", async (kind) => {
  const f = await fixture(true)
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    const c = await f.address("c")
    await f.runner.interrupt("person", WHOLE_WORKFLOW)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    if (kind === "grouped") {
      const both = await resolveWorkflowDeliveryAddress(f.store, "session", ["a", "b"])
      if (!both.ok) throw new Error(both.refusal)
      expect(await f.runner.handBack(both.address)).toEqual({ kind: "continued" })
    } else {
      expect(await f.runner.handBack(a)).toEqual({ kind: "continued" })
      expect(await f.runner.handBack(b)).toEqual({ kind: "continued" })
    }
    await Promise.all([...f.resumed.values()].map(({ promise }) => promise))
    expect(await f.runner.cut(a)).toBeUndefined()
    expect(await f.runner.cut(b)).toBeUndefined()
    expect(await f.runner.cut(c)).toBeUndefined()
    expect(await f.runner.cut()).toBeUndefined()
    expect(await f.runner.handBack()).toEqual({ kind: "not_parked" })
    const producer = { kind: "session" as const, sessionId: "parent", conversationId: "parent-conversation", toolUseId: "message", hop: 0 }
    const decide = (state: Parameters<typeof messageDisposition>[0]["state"]) => messageDisposition({ state, origin: "session", hop: 0, self: false, relation: "parent" })
    expect(await f.control.deliver({ text: "continue the running agents", producer }, decide, WHOLE_WORKFLOW)).toEqual({ status: "delivered", startsTurn: false })
  } finally { await f.dispose() }
})

test("a queued target refuses Interrupt without changing the running agents' authority", async () => {
  const f = await fixture(true)
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    const c = await f.address("c")
    expect(await f.runner.interrupt("person", c)).toBe(false)
    expect(await f.runner.interrupt("person", { addressedTo: [...a.addressedTo, ...c.addressedTo], label: "a and c" })).toBe(false)
    expect(await f.runner.cut(a)).toBeUndefined()
    await f.runner.interrupt("agent", a)
    await f.runner.interrupt("agent", b)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    expect(await f.runner.cut(c)).toBeUndefined()
    expect(await f.runner.cut()).toEqual({ kind: "interrupt", by: "agent" })
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "agent" })
    expect(await f.runner.cut(b)).toEqual({ kind: "interrupt", by: "agent" })
  } finally { await f.dispose() }
})

test.each(["before", "assembling", "running"] as const)("a whole person Interrupt %s generation survives a planned restart without cutting queued successors", async (when) => {
  const f = await fixture(true, when === "running" ? undefined : when)
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    const c = await f.address("c")
    if (when === "running") expect(await f.runner.interrupt("person")).toBe(true)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    await f.runner.interruptForReplacement()
    await f.restart("planned")
    expect([...f.counts.values()]).toEqual(when === "running" ? [1, 1] : [])
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by: "person" })
    expect(await f.runner.cut(b)).toEqual({ kind: "interrupt", by: "person" })
    expect(await f.runner.cut(c)).toBeUndefined()
  } finally { await f.dispose() }
})

test("a sibling's completion leaves only the parked agent interrupted and Resume finishes the workflow", async () => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const queue = await f.runner.readQueue()
    const first = queue.attempts.find(({ definitionId }) => definitionId === "a")!.id
    const second = queue.attempts.find(({ definitionId }) => definitionId === "b")!.id
    await f.runner.interrupt("person", a)
    await f.parks.get(first)!.promise
    f.finishes.get(second)!.resolve()
    await Promise.race([f.completed.get(second)!.promise, f.running.then((result) => { throw new Error(`Workflow ended before sibling completed: ${JSON.stringify(result)}`) })])
    expect((await loadQueueSnapshotFromReader(f.store, "session"))?.attempts.find(({ id }) => id === second)?.status).toBe("completed")
    await f.allInterrupted
    expect(f.runner.interruption()).toBe("person")
    expect(await f.runner.handBack(a)).toEqual({ kind: "continued" })
    await f.resumed.get(first)!.promise
    f.finishes.get(first)!.resolve()
    expect(await f.running).toMatchObject({ completed: true, attemptsCompleted: 2 })
  } finally { await f.dispose() }
})

test.each(["person", "agent"] as const)("a restart preserves a %s park and starts only its runtime-cut sibling", async (by) => {
  const f = await fixture()
  try {
    const a = await f.address("a")
    const b = await f.address("b")
    const queue = await f.runner.readQueue()
    const first = queue.attempts.find(({ definitionId }) => definitionId === "a")!.id
    const second = queue.attempts.find(({ definitionId }) => definitionId === "b")!.id
    await f.runner.interrupt(by, a)
    await f.parks.get(first)!.promise
    expect(await f.runner.interruptForReplacement()).toBe(true)
    await f.restart("planned", [second])
    expect(f.counts.get(first)).toBe(1)
    expect(f.counts.get(second)).toBe(2)
    expect(await f.runner.cut(a)).toEqual({ kind: "interrupt", by })
    expect(await f.runner.cut(b)).toBeUndefined()
    expect(f.runner.interruption()).toBeUndefined()
  } finally { await f.dispose() }
})

/** The run's time and its first phase's time at `now`, as every client
 *  counts them from the runtime's duration reader. */
async function times(f: Awaited<ReturnType<typeof fixture>>, now: number) {
  const run = await createWorkflowDurationReader(f.store)("session", true)
  const queue = await loadQueueSnapshotFromReader(f.store, "session")
  if (queue === null) throw new Error("expected the run's queue")
  const [phase] = workflowOutline({ attempts: frontendAttempts(queue), tree: queue.tree }, undefined, undefined, run).phases
  return {
    run: activeTimeMs(run.durationMs, run.streamingStartedAt, now),
    phase: activeTimeMs(phase?.activeMs ?? 0, phase?.activeStartedAt, now),
    ticking: run.streamingStartedAt !== null && phase?.activeStartedAt !== undefined,
  }
}

const HOUR = 3_600_000

test.each(["Resume", "hand-back"] as const)("a whole-run Interrupt stops the run's and its phase's time for an hour-long wait, and a %s continues them", async (release) => {
  const realNow = Date.now
  let offset = 0
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset)
  const f = await fixture()
  try {
    expect((await times(f, Date.now())).ticking).toBe(true)
    expect(await f.runner.interrupt("person")).toBe(true)
    await Promise.all([...f.parks.values()].map(({ promise }) => promise))
    const interrupted = await times(f, Date.now())
    expect(interrupted.ticking).toBe(false)
    expect((await workflowRunReader(f.store).readCut("session"))?.by).toBe("person")
    offset += HOUR
    expect(await times(f, Date.now())).toEqual(interrupted)
    const [first] = f.attempts
    if (release === "Resume") {
      expect(await f.runner.resume()).toBe(true)
    } else {
      // A person's message to one agent continues it as a Resume does.
      expect(await f.message((await f.member(first!)).sessionId)).toMatchObject({ status: "delivered", startsTurn: true })
    }
    await f.resumed.get(first!)!.promise
    expect(await workflowRunReader(f.store).readCut("session")).toBeNull()
    const resumed = await times(f, Date.now())
    expect(resumed.ticking).toBe(true)
    // The times go on from where the Interrupt stopped them, with none of the hour.
    expect(resumed.run - interrupted.run).toBeLessThan(60_000)
    expect(resumed.phase - interrupted.phase).toBeLessThan(60_000)
    expect(resumed.phase).toBeGreaterThanOrEqual(interrupted.phase)
  } finally {
    await f.dispose()
    clock.mockRestore()
  }
})
