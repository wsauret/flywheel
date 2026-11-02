import { afterEach, describe, it, expect, mock } from "bun:test"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller"
import type { WorkflowHosts } from "../../../../src/orchestration/workflow-host/host-collection"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures"
import { workflowRunOwner, workflowRunReader } from "../../../../src/orchestration/module-catalog"
import { workflowParentBinding } from "../../../helpers/workflow-parent"
import { parseWorkflowSessionFact, workflowRootControl } from "../../../../src/workflows/vm/session-facts"
import {
  cleanupProjectRoots,
  createDeps,
  createMockManager,
  createMockSessionStore,
  makeWorkflowDeps,
  modelLaunch,
  fixtureSource,
  seedWorkflowRequest,
  seedDamagedWorkflowRequest,
  seedWorkflowQueue,
} from "./_workflow-controller-fixtures"
import { readWorkflowQueuedUserInputs } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { readHeldAddressedMessages } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { WorkflowPreflightError } from "../../../../src/orchestration/workflow-host/runner-types"
import { registerLiveWorkflowControl } from "../../../../src/orchestration/session/live-session-control"
import type { ChatInput } from "../../../../src/infra/chat-input"
import { Database } from "bun:sqlite"
import { legacyWorkflowFixture } from "../../../helpers/workflow-agent-legacy-fixtures.js"
import { convertWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions.js"

afterEach(() => {
  cleanupProjectRoots()
})

 describe("WorkflowController", () => {
  describe("removed workflows", () => {
    it("preserves historical sessions but refuses resume without their definition", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      await manager.publishWorkflow({
        id: "legacy-workflow", workflowDefinitionId: "implement-and-review", description: "Legacy workflow", initialRoles: {}, facts: [],
        launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "implement-and-review" }),
      })
      const deps = createDeps({ workflowHosts, manager })
      const controller = createWorkflowController(deps)
      await expect(controller.resumeWorkflow("legacy-workflow")).resolves.toEqual({
        kind: "unavailable",
        message: "resuming the implement-and-review workflow is unavailable: the implement-and-review workflow is retired and no longer runs; its history stays viewable",
      })
      expect(await controller.sendWorkflow("legacy-workflow", "Continue")).toEqual({ kind: "resume_failed", sessionId: "legacy-workflow", message: "resuming the implement-and-review workflow is unavailable: the implement-and-review workflow is retired and no longer runs; its history stays viewable" })
      expect(await controller.resumeLaunch("legacy-workflow")).toEqual({ ok: false, error: "resuming the implement-and-review workflow is unavailable: the implement-and-review workflow is retired and no longer runs; its history stays viewable" })
      expect(await controller.restartWorkflow("legacy-workflow")).toEqual({ kind: "failed", message: "restarting the implement-and-review workflow is unavailable: the implement-and-review workflow is retired and no longer runs; its history stays viewable" })
      expect(workflowHosts._startCalls).toHaveLength(0)
      expect(await workflowRunReader(deps.projectionReader).read("legacy-workflow")).toMatchObject({ workflowDefinitionId: "implement-and-review" })
    })
  })

  describe("a person's message", () => {
    it("delivers a person's input to a running workflow under its durable cell, with the identity the sending client shows it under", async () => {
      const workflowHosts = createMockWorkflowHosts()
      workflowHosts.isRunning = id => id === "wf-active"
      const manager = createMockManager()
      const deps = createDeps({ workflowHosts, manager })
      await seedWorkflowRequest(deps, "wf-active", "Active workflow")
      const received: ChatInput[] = []
      const unregister = registerLiveWorkflowControl(deps.projectionReader, {
        kind: "workflow", handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined, notify: async () => false,
        workflowId: "wf-active",
        state: async () => "running",
        deliver: async (input, decide) => { received.push(input); return { ...decide("running"), confirmedSubmissionIds: input.submissionIds } },
      })
      try {
        const result = await createWorkflowController(deps).sendWorkflow("wf-active", { text: "continue", submissionIds: ["local-1"] })
        expect(result).toEqual({ kind: "delivered", sessionId: "wf-active", confirmedSubmissionIds: ["local-1"] })
      } finally {
        unregister()
      }

      // The message is durable before the step reads it, with the address of
      // the whole workflow: a crash between acceptance and drain leaves the
      // cell, which the next commit records for every later step.
      const held = await readHeldAddressedMessages(deps.projectionReader, "wf-active")
      expect(held.map(({ input: { text, submissionIds }, addressedTo }) => ({ text, submissionIds, addressedTo }))).toEqual([{ text: "continue", submissionIds: ["local-1"], addressedTo: [{ _tag: "workflow" }] }])
      expect(await readWorkflowQueuedUserInputs(deps.projectionReader, "wf-active")).toEqual([])
      expect(received).toEqual([{ text: "continue", submissionIds: ["local-1"], dispatchIds: [held[0]!.input.key] }])
      expect(workflowHosts._startCalls).toEqual([])
    })

    it("answers a copy of a message the workflow holds or recorded as a receipt, and holds nothing again", async () => {
      const workflowHosts = createMockWorkflowHosts()
      workflowHosts.isRunning = id => id === "wf-active"
      const deps = createDeps({ workflowHosts, manager: createMockManager() })
      await seedWorkflowRequest(deps, "wf-active", "Active workflow")
      const received: ChatInput[] = []
      const unregister = registerLiveWorkflowControl(deps.projectionReader, {
        kind: "workflow", handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined, notify: async () => false,
        workflowId: "wf-active",
        state: async () => "running",
        deliver: async (input, decide) => { received.push(input); return { ...decide("running"), confirmedSubmissionIds: input.submissionIds } },
      })
      const controller = createWorkflowController(deps)
      const message = { text: "continue", submissionIds: ["local-1"] }
      const receipt = { kind: "delivered", sessionId: "wf-active", confirmedSubmissionIds: ["local-1"] } as const
      try {
        await controller.sendWorkflow("wf-active", message)
        // The client lost the answer and sends the same submission again
        // while its cell waits for the next commit.
        expect(await controller.sendWorkflow("wf-active", message)).toEqual(receipt)
        const held = await readHeldAddressedMessages(deps.projectionReader, "wf-active")
        expect(held.map(({ input }) => input.key)).toEqual(["person:local-1"])

        // A commit records the message as an addendum and retires its cell.
        await deps.eventWriter.append({
          aggregateId: "workflow:wf-active", sessionId: "wf-active", timestamp: 3, type: "step_context.input.added", version: 4, actor: "flywheel",
          payload: { key: "person:local-1", source: { kind: "person" }, text: "continue", addressedTo: [{ _tag: "workflow" }] },
        })
        await deps.eventWriter.dropInFlight!("wf-active", "workflow.addressed_message", "person:local-1")
        expect(await controller.sendWorkflow("wf-active", message)).toEqual(receipt)
        expect(await readHeldAddressedMessages(deps.projectionReader, "wf-active")).toEqual([])
      } finally {
        unregister()
      }
      expect(received).toHaveLength(1)
    })

    it("asks for Restart and publishes no recovery when a message meets damaged saved progress", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const startCalls: string[] = []
      // The runner's preflight refuses control it cannot execute.
      workflowHosts.start = mock(async (opts) => {
        startCalls.push(opts.sessionId)
        throw new WorkflowPreflightError({ kind: "malformed_state", sessionId: opts.sessionId, message: "no control root" })
      })
      const deps = createDeps({
        workflowHosts,
        manager,
        prepareWorkflowDeps: async () => makeWorkflowDeps(),
      })
      await seedDamagedWorkflowRequest(deps, "wf-inactive", "Inactive workflow")
      const controller = createWorkflowController(deps)

      const result = await controller.sendWorkflow("wf-inactive", "please continue")

      expect(result).toEqual({ kind: "resume_failed", sessionId: "wf-inactive", message: "This workflow's saved progress has a record that this version of Flywheel cannot read. Restart runs it again from its recorded request." })
      expect(startCalls).toEqual(["wf-inactive"])
      expect(await readWorkflowQueuedUserInputs(deps.projectionReader, "wf-inactive")).toEqual([])
      expect((await deps.eventReader.readSlice({ aggregateId: "workflow:wf-inactive", types: ["workflow.control.recovered"] })).facts).toEqual([])
    })

    it("Restart repairs an unreadable companion from the original request after a rename", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const deps = createDeps({ workflowHosts, manager })
      await seedDamagedWorkflowRequest(deps, "wf-recovered", "Recovered workflow")
      await workflowRunOwner().writer(deps.projectionReader, manager.commitWorkflow).update("wf-recovered", current => ({ ...current, name: "A renamed workflow", label: "A renamed workflow", userNamed: true }))
      const original = (await deps.eventReader.readSlice({ aggregateId: "workflow:wf-recovered" }, true)).facts
      const controller = createWorkflowController(deps)

      const result = await controller.restartWorkflow("wf-recovered")

      expect(result).toEqual({ kind: "restarted", sessionId: "wf-recovered" })
      const workflowFacts = (await deps.eventReader.readSlice({ aggregateId: "workflow:wf-recovered" })).facts.map((fact) => {
        if (fact instanceof Error) throw fact
        return fact
      })
      expect(original).toEqual(workflowFacts.slice(0, original.length))
      expect(workflowFacts.slice(original.length).map(({ type }) => type)).toEqual(["workflow.control.recovered", "context.input.seeded", "queue.created", "queue.tree.changed"])
      const stored = workflowFacts[original.length]!
      const root = parseWorkflowSessionFact({ type: stored.type, version: stored.version, actor: stored.actor, payload: stored.payload })
      if (root.type !== "workflow.control.recovered") throw new Error("Missing recovered root")
      const recovered = workflowRootControl(root)
      expect(recovered.attempts.length).toBeGreaterThan(0)
      expect(recovered.attempts.every(({ conversationId }) => conversationId === null)).toBe(true)
      expect((await deps.eventReader.readSlice({ sessionId: "wf-recovered", types: ["chat.tree.created", "chat.entries.appended"] })).facts).toEqual([])
      expect(await readWorkflowQueuedUserInputs(deps.eventReader, "wf-recovered")).toEqual([])
      expect(workflowHosts._runners.has("wf-recovered")).toBe(true)
      expect(workflowHosts._startCalls[0]?.description).toBe("Recovered workflow")
    })

    it("Restart refuses a converted workflow without its original request and publishes no recovery", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const deps = createDeps({ workflowHosts })
      await seedWorkflowRequest(deps, "definition-source", "Other request")
      const f = legacyWorkflowFixture(deps.projectRoot)
      const definitions = await deps.eventReader.readSlice({ aggregateId: "workflow:definition-source", types: ["definition.loaded"] })
      for (const fact of definitions.facts) {
        if (fact instanceof Error) throw new Error(fact.message)
        f.store.append({ ...fact, aggregateId: "workflow:old", sessionId: "old" })
      }
      f.store.close()
      const db = new Database(f.dbFile)
      try {
        db.run("update event set version = 4, payload = json_set(json_remove(payload, '$.label'), '$.workflowDefinitionId', ?) where aggregate_id = 'session:old' and type = 'session.created'", [FIXTURE_WORKFLOW_ID])
        db.run("delete from event where aggregate_id = 'workflow:old' and type = 'context.input.seeded'")
      } finally { db.close() }
      expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)

      expect(await createWorkflowController(deps).restartWorkflow("old")).toEqual({
        kind: "failed",
        message: "This workflow's saved progress is missing its original request. The workflow remains paused because the original workflow request is unreadable, so Restart cannot run it again.",
      })
      expect((await deps.eventReader.readSlice({ aggregateId: "workflow:old", types: ["workflow.control.recovered"] })).facts).toEqual([])
      expect(workflowHosts._startCalls).toHaveLength(0)
    })

    it("Restart reports a configuration failure and publishes no recovery", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const deps = createDeps({
        workflowHosts,
        manager,
        prepareWorkflowDeps: async () => { throw new Error("no provider credentials") },
      })
      await seedDamagedWorkflowRequest(deps, "wf-broken", "Broken workflow")
      const controller = createWorkflowController(deps)

      const result = await controller.restartWorkflow("wf-broken")

      expect(result).toEqual({ kind: "failed", message: "Workflow restart configuration failed: no provider credentials" })
      expect((await deps.eventReader.readSlice({ aggregateId: "workflow:wf-broken", types: ["workflow.control.recovered"] })).facts).toEqual([])
    })

    it.each([
      { error: new Error("runtime stopped"), message: "Workflow runtime failed to start: runtime stopped" },
      { error: new WorkflowPreflightError({ kind: "attempt_refused", attemptId: "attempt-1", message: "Invocation budget exhausted (1/1)" }), message: "Invocation budget exhausted (1/1)" },
    ])("Restart reports a runtime start failure after recovery commits: $message", async ({ error, message }) => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      workflowHosts.start = mock(async () => { throw error })
      const deps = createDeps({ workflowHosts, manager })
      await seedDamagedWorkflowRequest(deps, "wf-start-failed", "Original task")
      const result = await createWorkflowController(deps).restartWorkflow("wf-start-failed")
      expect(result).toEqual({ kind: "failed", message })
    })

    it("reports a missing session with the resume not-found message", async () => {
      const sessionStore = createMockSessionStore()
      const controller = createWorkflowController(createDeps({ sessionStore }))

      const result = await controller.sendWorkflow("wf-missing", "continue")

      expect(result).toEqual({
        kind: "resume_failed",
        sessionId: "wf-missing",
        message: "Workflow session wf-missing was not found",
      })
    })

    it("reuses a live host and reports a refusal without a second delivery attempt or a kept cell", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const deps = createDeps({ workflowHosts, manager })
      await seedWorkflowRequest(deps, "wf-live", "Live workflow")
      const workflowDeps = makeWorkflowDeps()
      await workflowHosts.start({ sessionId: "wf-live", workflow: workflowIn(fixtureDefinitions().captureRevision(), FIXTURE_WORKFLOW_ID), startMode: "launch", description: "live", projectRoot: deps.projectRoot, executionCwd: deps.projectRoot, manager, workflowDeps: { ...workflowDeps, definitionRevision: workflowDeps.definitions.captureRevision() }, recall: deps.recall })
      let deliveries = 0
      const unregister = registerLiveWorkflowControl(deps.projectionReader, {
        kind: "workflow", handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined, notify: async () => false,
        workflowId: "wf-live",
        state: async () => "running",
        deliver: async () => { deliveries += 1; return { status: "refused", reason: "settled" } },
      })
      try {
        const result = await createWorkflowController(deps).sendWorkflow("wf-live", "new steering")
        expect(result).toEqual({ kind: "not_delivered", sessionId: "wf-live" })
      } finally {
        unregister()
      }

      expect(workflowHosts._startCalls).toHaveLength(1)
      expect(deliveries).toBe(1)
      expect(await readWorkflowQueuedUserInputs(deps.projectionReader, "wf-live")).toEqual([])
    })
  })

  describe("lifecycle callbacks", () => {
    it("resolves model completion when reconciliation confirms already-durable child evidence", async () => {
      const workflowHosts = createMockWorkflowHosts()
      let coreCompleted: Parameters<WorkflowHosts["start"]>[0]["onCoreCompleted"]
      workflowHosts.start = mock(async (opts) => {
        coreCompleted = opts.onCoreCompleted
        return opts.sessionId
      })
      const manager = createMockManager()
      await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", name: "Parent" })
      let workflowId = ""
      const reconcile = mock(async () => ({
        reconciledCount: 0,
        workflowAggregateReads: 0,
        durableTerminalChildSessionIds: [workflowId],
      }))
      const deps = createDeps({
        workflowHosts,
        manager,
        prepareWorkflowDeps: async () => makeWorkflowDeps(),
        reconcileChildSessionCompletions: reconcile,
      })
      const controller = createWorkflowController(deps)
      const launched = await controller.startWorkflow({
        source: fixtureSource(deps),
        description: "Create a file",
        origin: {
          kind: "model",
          chatSessionId: "parent-chat",
          conversationId: "parent-conversation",
          toolUseId: "workflow-tool",
          confirmation: { kind: "absent" }, authority: fullAuthority(),
        },
      })
      if ("error" in launched) throw new Error(launched.error)
      if (!coreCompleted) throw new Error("Core completion callback missing")
      workflowId = launched.workflowId
      await seedWorkflowQueue(deps, launched.workflowId)
      let resolved = false
      void launched.done.then(() => { resolved = true })

      await coreCompleted(launched.workflowId, {
        completed: true,
        attemptsCompleted: 1,
        attemptsTotal: 1,
        tokens: 10,
        cost: 0,
      })
      await Promise.resolve()

      expect(reconcile).toHaveBeenCalledTimes(1)
      expect(resolved).toBe(true)
    })

    it("resolves model failure when reconciliation confirms already-durable child evidence", async () => {
      const workflowHosts = createMockWorkflowHosts()
      let runnerError: Parameters<WorkflowHosts["start"]>[0]["onRunnerError"]
      workflowHosts.start = mock(async (opts) => {
        runnerError = opts.onRunnerError
        return opts.sessionId
      })
      const manager = createMockManager()
      await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", name: "Parent" })
      let workflowId = ""
      const deps = createDeps({
        workflowHosts,
        manager,
        prepareWorkflowDeps: async () => makeWorkflowDeps(),
        reconcileChildSessionCompletions: async () => ({
          reconciledCount: 0,
          workflowAggregateReads: 0,
          durableTerminalChildSessionIds: [workflowId],
        }),
      })
      const controller = createWorkflowController(deps)
      const launched = await controller.startWorkflow({
        source: fixtureSource(deps),
        description: "Create a file",
        origin: {
          kind: "model",
          chatSessionId: "parent-chat",
          conversationId: "parent-conversation",
          toolUseId: "workflow-tool",
          confirmation: { kind: "absent" }, authority: fullAuthority(),
        },
      })
      if ("error" in launched) throw new Error(launched.error)
      workflowId = launched.workflowId
      if (!runnerError) throw new Error("Runner error callback missing")
      let resolved = false
      void launched.done.then(() => { resolved = true })

      await runnerError(launched.workflowId, new Error("runner failed"))
      await Promise.resolve()

      expect(resolved).toBe(true)
    })

    it("keeps model completion pending when a runner error leaves workflow control nonterminal", async () => {
      const workflowHosts = createMockWorkflowHosts()
      let coreCompleted: Parameters<WorkflowHosts["start"]>[0]["onCoreCompleted"]
      let runnerError: Parameters<WorkflowHosts["start"]>[0]["onRunnerError"]
      workflowHosts.start = mock(async (opts) => {
        coreCompleted = opts.onCoreCompleted
        runnerError = opts.onRunnerError
        return opts.sessionId
      })
      const manager = createMockManager()
      await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", name: "Parent" })
      let terminal = false
      let workflowId = ""
      const reconcile = mock(async () => ({
        reconciledCount: 0,
        workflowAggregateReads: 0,
        durableTerminalChildSessionIds: terminal ? [workflowId] : [],
      }))
      const deps = createDeps({
        workflowHosts,
        manager,
        prepareWorkflowDeps: async () => makeWorkflowDeps(),
        reconcileChildSessionCompletions: reconcile,
      })
      const controller = createWorkflowController(deps)
      const launched = await controller.startWorkflow({
        source: fixtureSource(deps),
        description: "Create a file",
        origin: {
          kind: "model",
          chatSessionId: "parent-chat",
          conversationId: "parent-conversation",
          toolUseId: "workflow-tool",
          confirmation: { kind: "absent" }, authority: fullAuthority(),
        },
      })
      if ("error" in launched) throw new Error(launched.error)
      if (!runnerError || !coreCompleted) throw new Error("Workflow callbacks missing")
      workflowId = launched.workflowId
      await seedWorkflowQueue(deps, launched.workflowId)
      let resolved = false
      void launched.done.then(() => { resolved = true })

      await runnerError(launched.workflowId, new Error("Out of credits"))
      await Promise.resolve()
      expect(resolved).toBe(false)

      terminal = true
      await coreCompleted(launched.workflowId, {
        completed: true,
        attemptsCompleted: 1,
        attemptsTotal: 1,
        tokens: 10,
        cost: 0,
      })
      await Promise.resolve()
      expect(resolved).toBe(true)
      expect(reconcile).toHaveBeenCalledTimes(2)
    })

    for (const terminal of ["completed", "failed"] as const) {
      it(`reconciles a ${terminal} operator-resumed model child through its durable parent`, async () => {
        const workflowHosts = createMockWorkflowHosts()
        let coreCompleted: Parameters<WorkflowHosts["start"]>[0]["onCoreCompleted"]
        workflowHosts.start = mock(async (opts) => {
          coreCompleted = opts.onCoreCompleted
          return opts.sessionId
        })
        const manager = createMockManager()
        await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", name: "Parent" })
        const reconcile = mock(async () => ({
          reconciledCount: 1,
          durableTerminalChildSessionIds: ["resumed-child"],
          workflowAggregateReads: 1,
        }))
        const deps = createDeps({ workflowHosts, manager, reconcileChildSessionCompletions: reconcile })
        await seedWorkflowRequest(deps, "resumed-child", "Original request")
        expect(await createWorkflowController(deps).resumeWorkflow("resumed-child")).toEqual({ kind: "resumed", sessionId: "resumed-child" })

        if (!coreCompleted) throw new Error("Core completion callback missing")
        await coreCompleted("resumed-child", {
          completed: terminal === "completed",
          attemptsCompleted: terminal === "completed" ? 1 : 0,
          attemptsTotal: 1,
          tokens: 1,
          cost: 0,
          ...(terminal === "failed" ? { reason: "resumed failure" } : {}),
        })
        expect(reconcile).toHaveBeenCalledWith("parent-chat")
      })
    }

    it("awaits the runner-error callback, surfaces its failure, and settles the parent", async () => {
      const workflowHosts = createMockWorkflowHosts()
      const manager = createMockManager()
      const release = Promise.withResolvers<void>()
      const order: string[] = []
      const persistenceError = new Error("runner notification failed")
      const persistenceStarted = Promise.withResolvers<void>()
      const durableTerminalChildSessionIds: string[] = []
      await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", name: "Parent" })
      const onRunnerError = mock(async () => {
        order.push("notify:start")
        persistenceStarted.resolve()
        await release.promise
        order.push("notify:failed")
        throw persistenceError
      })
      let runnerError: Parameters<WorkflowHosts["start"]>[0]["onRunnerError"]
      workflowHosts.start = mock(async (opts) => {
        runnerError = opts.onRunnerError
        return opts.sessionId
      })
      const deps = createDeps({
        workflowHosts,
        manager,
        prepareWorkflowDeps: async () => makeWorkflowDeps(),
        onRunnerError,
        reconcileChildSessionCompletions: async () => ({
          reconciledCount: 1,
          workflowAggregateReads: 1,
          durableTerminalChildSessionIds,
        }),
      })
      const controller = createWorkflowController(deps)
      const launched = await controller.startWorkflow({ source: fixtureSource(deps), description: "Create a file", origin: await modelLaunch({ manager }) })
      if ("error" in launched) throw new Error(launched.error)
      if (!runnerError) throw new Error("Runner error callback missing")
      void launched.done.then(() => { order.push("done") })
      durableTerminalChildSessionIds.push(launched.workflowId)

      const settlement = runnerError(launched.workflowId, new Error("runner failed"))
      await persistenceStarted.promise
      expect(order).toEqual(["notify:start"])
      release.resolve()
      await expect(settlement).rejects.toBe(persistenceError)
      await launched.done
      expect(order).toEqual(["notify:start", "notify:failed", "done"])
      expect(onRunnerError).toHaveBeenCalledTimes(1)
    })
  })
})