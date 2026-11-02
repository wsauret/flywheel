import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime } from "effect"
import { EventReaderService, EventStoreLive, EventStoreService, LocalEventStoreService } from "../../../../src/infra/event-store-effect"
import { liveWorkflowControl } from "../../../../src/orchestration/session/live-session-control"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createWorkflowRunner } from "../../../../src/orchestration/workflow-host/runner"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND, readWorkflowQueuedUserInputs } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { workflowParentBinding } from "../../../helpers/workflow-parent"
import { workflowRunOwner } from "../../../../src/orchestration/module-catalog"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import { initialFacts, testHost, fixtureSkills, workflow } from "../../workflows/vm/host-test-support"
import { makeWorkflowDeps, noConversationRecall } from "./_workflow-controller-fixtures"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).toReversed()) await cleanup() })

test("a completed workflow runner returns to its parent and refuses new conversation input", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-read-only-"))
  const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(root)))
  const store = await runtime.runPromise(EventStoreService)
  const base = makeWorkflowDeps()
  const definitionRevision = {
    ...base.definitions.captureRevision(),
    skills: fixtureSkills,
    // The launch facts compile against no personas, so Resume reads the same empty registry.
    personas: new Map(),
  }
  const manager = createSessionManager({ projectRoot: root, executionCwd: root, projectionReader: store, writer: store })
  await manager.publishWorkflow({
    id: "session", workflowDefinitionId: workflow.id, description: "task", executionCwd: root,
    launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: workflow.id }),
    facts: initialFacts().map(({ type, version, actor, payload }) => parseWorkflowSessionFact({ type, version, actor, payload })),
    initialRoles: {
        chat: { model: "gpt-5.5", effort: "medium" },
        "workflow-agent": { model: "gpt-5.4", effort: "medium" },
        "title-generation": { model: "gpt-6-luna", effort: "low" },
    },
  })
  await workflowRunOwner().writer(store, manager.commitWorkflow).update("session", current => ({
    ...current, roleAssignments: {
      ...current.roleAssignments, overrides: { "title-generation": { model: "gpt-5.5", effort: "high", providerOptions: { openai: { service_tier: "priority" } } } },
    },
  }))
  const seedHost = testHost(await runtime.runPromise(LocalEventStoreService), {
    definitionRevision,
    commitBatch: events => manager.commitWorkflow({ workflowId: "session", events }),
    attemptRunner: {
      run: async (input, active) => ({
        kind: "success" as const,
        attemptId: input.attemptId,
        conversationId: active.conversationId,
        handoff: { summary: "done" },
        reassessment: null,
      }),
    },
  })
  expect((await seedHost.run()).kind).toBe("completed")
  await store.putInFlight?.("session", QUEUED_USER_INPUT_IN_FLIGHT_KIND, "retained", {
    target: "workflow",
    text: "continue here",
    origin: "human",
  })

  const titleAttempt = Promise.withResolvers<AgentOptions>()
  const runner = createWorkflowRunner({
    sessionId: "session",
    workflow,
    description: "task",
    startMode: "operator_resume",
    projectRoot: root,
    executionCwd: root,
    runtime,
    manager,
    projectionReader: store,
    workflowDeps: {
      ...base,
      definitionRevision,
      createAgent: (options) => {
        if (options.purpose.kind === "session-title") titleAttempt.resolve(options)
        return base.createAgent(options)
      },
    },
    recall: noConversationRecall,
  })
  cleanups.push(async () => {
    await runner.dispose()
    await seedHost.dispose()
    await runtime.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  expect(await runner.prepare()).toBeNull()
  const titleOptions = await titleAttempt.promise
  expect(titleOptions).toMatchObject({
    model: "gpt-5.5",
    effort: "high",
    providerOptions: { openai: { service_tier: "priority" } },
  })

  await expect(runner.run()).resolves.toMatchObject({ completed: true })
  expect((await readWorkflowQueuedUserInputs(store, "session")).map(({ key }) => key)).toEqual(["retained"])
  // A completed run takes no live message: its control ended with the run.
  expect(liveWorkflowControl(runtime.runSync(EventReaderService), "session")).toBeUndefined()
  expect(await runner.readQueue()).toMatchObject({ status: "completed" })
})
