import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStoreReadSurface, type FactQuery } from "../../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store"
import { openProjectState, recoverProject, type ProjectStateInput } from "../../../../helpers/project-recovery"
import { buildDurableSubagentCreated, buildSubagentPrompted, buildSubagentResumed } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection"
import { createSessionManager } from "../../../../../src/orchestration/session/manager"
import { removeOwnerPid } from "../../../../../src/orchestration/session/pid-lock"
import { prepareSessionFactAppend } from "../../../../../src/orchestration/session/persistence/session-fact-writer"
import { testDirectories } from "../../../../helpers/directories"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function publishRunningChild() {
  const projectRoot = mkdtempSync(join(tmpdir(), "subagent-child-recovery-"))
  roots.push(projectRoot)
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  const writer = asAsyncEventWriter(store)
  const localReader: EventStoreReadSurface = {
    ...store,
    read(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("orphan recovery must not fold the full session metadata family")
      }
      return store.read(query)
    },
    readTolerant(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("orphan recovery must not fold the full session metadata family")
      }
      return store.readTolerant(query)
    },
  }
  const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, projectionReader: asAsyncEventReadSurface(localReader), writer })
  const reader = asAsyncEventReadSurface(localReader)
  await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "parent", initialState: "inactive" })
  const created = buildDurableSubagentCreated({
    childSessionId: "child",
    childRunId: "run",
    conversationId: "child-conversation",
    parentSessionId: "parent",
    parentConversationId: "parent-conversation",
    parentToolCallId: "parent-tool",
    persona: { name: "explorer", kind: "persona" },
    capabilityGrant: {
      operation: "subagent",
      required: [],
      capabilities: [],
      moduleIds: [],
      requireWorkflowConfirmation: false,
      workflowsMode: "off",
      identity: "test",
    },
    admittedModuleIds: [],
    skillsRevision: 7,
    model: "test/model",
    tools: ["read"],
    executionCwd: projectRoot,
    budget: { maxTurns: 10, maxTokens: 1000 },
    parentDepth: 0,
    description: "child",
  })
  await manager.publishSubagent({
    id: "child",
    conversationId: "child-conversation",
    description: "child",
    launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "parent-tool" },
    initialRoles: {},
    runBinding: prepareSessionFactAppend("child", created),
    assignment: "inspect",
    promptFact: prepareSessionFactAppend("child", buildSubagentPrompted({
      childRunId: "run",
      prompt: "inspect",
      task: "durable task",
      toolNames: ["read"],
    })),
  })
  expect(loadSubagentRunsFromEvents(store.read({
    aggregateId: "session:child",
    types: SUBAGENT_RUN_FACT_TYPES,
  }))).toEqual([
    expect.objectContaining({
      childRunId: "run",
      status: "created",
      prompt: "inspect",
      task: "durable task",
      promptToolNames: ["read"],
    }),
  ])
  return { projectRoot, store, reader, writer, manager }
}

/** The state Worker's deferred stale-session pass over a new composition:
 *  how many sessions it paused and child runs it settled. */
async function recoverStale(input: ProjectStateInput): Promise<number> {
  const result = await openProjectState(input).sessions.request({ kind: "session.recover-stale" })
  if (result.kind !== "session.recover-stale.result") throw new Error(`unexpected session result: ${result.kind}`)
  return result.value
}

describe("durable subagent child recovery", () => {
  test("reconstructs the same run as crash-paused without executing it", async () => {
    const { projectRoot, store, reader, writer, manager } = await publishRunningChild()
    removeOwnerPid("child", projectRoot)

    await recoverProject({ directories: testDirectories(projectRoot), reader, writer }, "closed-generation")

    const run = loadSubagentRunsFromEvents(store.read({ aggregateId: "session:child", types: SUBAGENT_RUN_FACT_TYPES })).at(-1)
    expect(run).toMatchObject({
      childRunId: "run",
      status: "interrupted",
      interruptionReason: "runtime_restarted",
      skillsRevision: 7,
      maxTurns: 10,
      maxTokens: 1000,
      promptToolNames: ["read"],
    })
    expect(await manager.read("child")).toMatchObject({ lifecycleState: "inactive" })
    store.close()
  })

  test("settles a run an earlier process left open on an inactive child, and only once", async () => {
    const { projectRoot, store, reader, writer, manager } = await publishRunningChild()
    removeOwnerPid("child", projectRoot)
    // An earlier build deactivated the child without settling its run.
    await manager.updateLifecycleState("child", "inactive")
    await recoverProject({ directories: testDirectories(projectRoot), reader, writer }, "ownerless")
    expect(loadSubagentRunsFromEvents(store.read({ aggregateId: "session:child", types: SUBAGENT_RUN_FACT_TYPES })).at(-1)).toMatchObject({ status: "created" })

    expect(await recoverStale({ directories: testDirectories(projectRoot), reader, writer })).toBe(1)
    expect(loadSubagentRunsFromEvents(store.read({ aggregateId: "session:child", types: SUBAGENT_RUN_FACT_TYPES })).at(-1)).toMatchObject({
      childRunId: "run", status: "interrupted", interruptionReason: "runtime_restarted",
    })
    expect(await recoverStale({ directories: testDirectories(projectRoot), reader, writer })).toBe(0)
    await writer.append(prepareSessionFactAppend("child", buildSubagentResumed({
      childRunId: "run",
      authorizationId: "explicit:parent-tool",
      continuation: 1,
    })))
    expect(await recoverStale({ directories: testDirectories(projectRoot), reader, writer })).toBe(1)
    expect(loadSubagentRunsFromEvents(store.read({ aggregateId: "session:child", types: SUBAGENT_RUN_FACT_TYPES })).at(-1)).toMatchObject({
      childRunId: "run", status: "interrupted", interruptionReason: "runtime_restarted", continuationCount: 1,
    })
    store.close()
  })

  test("settles an open run beside a session whose run history it cannot read", async () => {
    const { projectRoot, store, reader, writer, manager } = await publishRunningChild()
    // A newer build recorded a run in a shape this build cannot read.
    store.append({ aggregateId: "session:unreadable", sessionId: "unreadable", timestamp: Date.now(), type: "child_run.created", version: 99, actor: "flywheel", payload: {} })
    removeOwnerPid("child", projectRoot)
    await manager.updateLifecycleState("child", "inactive")

    expect(await recoverStale({ directories: testDirectories(projectRoot), reader, writer })).toBe(1)
    expect(loadSubagentRunsFromEvents(store.read({ aggregateId: "session:child", types: SUBAGENT_RUN_FACT_TYPES })).at(-1)).toMatchObject({ status: "interrupted" })
    store.close()
  })

  test("leaves an open run alone while its owner is alive, and settles it after the pass pauses its session", async () => {
    const { projectRoot, store, reader, writer, manager } = await publishRunningChild()
    expect(await recoverStale({ directories: testDirectories(projectRoot), reader, writer })).toBe(0)
    expect(loadSubagentRunsFromEvents(store.read({ aggregateId: "session:child", types: SUBAGENT_RUN_FACT_TYPES })).at(-1)).toMatchObject({ status: "created" })
    removeOwnerPid("child", projectRoot)
    expect(await manager.read("child")).toMatchObject({ lifecycleState: "active" })
    // An active session's run is never settled while the session is active:
    // the pass pauses the session first, then settles its run.
    expect(await recoverStale({ directories: testDirectories(projectRoot), reader, writer })).toBe(2)
    expect(await manager.read("child")).toMatchObject({ lifecycleState: "inactive" })
    expect(loadSubagentRunsFromEvents(store.read({ aggregateId: "session:child", types: SUBAGENT_RUN_FACT_TYPES })).at(-1)).toMatchObject({ status: "interrupted" })
    store.close()
  })
})
