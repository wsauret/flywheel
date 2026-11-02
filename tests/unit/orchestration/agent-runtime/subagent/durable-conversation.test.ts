import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import { acquireConversationSearchIndex } from "../../../../../src/infra/conversation-fts.js"
import { resolveConversationSearchDbFile, resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js"
import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js"
import { createSubagentSessionAuthority } from "../../../../../src/orchestration/modules/subagents/execution/session-authority.js"
import { createSessionManager } from "../../../../../src/orchestration/session/manager.js"
import { liveChildRun } from "../../../../../src/orchestration/session/live-session-control.js"
import { readConversationBackgroundNotifications } from "../../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { readConversationQueuedUserInputs } from "../../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { readSubagentRuns } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import type { Agent, AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import type { ChildSessionConversation } from "../../../../../src/orchestration/module-seams.js"
import { createConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer.js"
import { createConversationRecall } from "../../../../../src/orchestration/session/conversation-recall.js"
import { childTask, makeContext, makeDeps, TEST_RATIONALE } from "./_fixtures.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createDurableHarness() {
  const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-subagent-durable-"))
  roots.push(projectRoot)
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  const sessionId = "durable-subagent-session"
  const writer = asAsyncEventWriter(store)
  const index = acquireConversationSearchIndex(resolveConversationSearchDbFile(projectRoot), asAsyncEventReadSurface(store))
  const createChildConversation = (childRunId: string): ChildSessionConversation =>
    createConversationTreeWriterController({
      conversationId: childRunId,
      sessionId,
      projectRoot,
      store: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      writer,
      recall: createConversationRecall({ conversationId: childRunId, store: asAsyncEventReadSurface(store), index }),
    })
  return {
    projectRoot,
    store,
    sessionId,
    createChildConversation,
    async close() {
      await index.dispose()
      store.close()
    },
  }
}

function notificationRegistry() {
  const notifications: string[] = []
  const next = Promise.withResolvers<string>()
  return {
    notifications,
    next: next.promise,
    backgroundTasks: createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => {
        notifications.push(text)
        next.resolve(text)
      },
    }),
  }
}

function completed(): AgentRunResult {
  return { servedRequests: 0, durationMs: 1, providerSessionKey: "fake-provider-session", terminal: { kind: "completed" } }
}

function childId(acknowledgement: { content: string }): string {
  const parsed: unknown = JSON.parse(acknowledgement.content)
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) throw new Error("expected child id")
  return String(parsed.id)
}

describe("subagent durable conversation", () => {
  it.each([false, true])("retains a held completion across pause and commits it once after Resume (held-read failure: %s)", async (injectFailure) => {
    const harness = createDurableHarness()
    const reader = asAsyncEventReadSurface(harness.store)
    const writer = asAsyncEventWriter(harness.store)
    const manager = createSessionManager({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, projectionReader: reader, writer })
    await manager.createChat({ id: "root", conversationId: "root-conversation", name: "Root" })
    let failHeldRead = false
    const faultReader = {
      ...reader,
      readInFlight: async (...args: Parameters<typeof reader.readInFlight>) => {
        if (failHeldRead && args[1] === "chat.queued_user_input") {
          failHeldRead = false
          throw new Error("injected held-input read failure")
        }
        return reader.readInFlight(...args)
      },
    }
    const authority = createSubagentSessionAuthority({ manager, eventStore: reader, projectionReader: faultReader, eventWriter: writer, projectRoot: harness.projectRoot, recall: async () => ({ hits: [] }) })
    const attempts: AgentOptions[] = []
    const notification = notificationRegistry()
    const tool = createSubagentDispatch(makeDeps({
      sessionId: "root", sessionDir: harness.projectRoot, sessionEventStore: reader,
      subagentSessions: authority, backgroundTasks: notification.backgroundTasks,
      createRunner: (options) => {
        attempts.push(options)
        const done = Promise.withResolvers<AgentRunResult>()
        return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise }
      },
    }))
    const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: "root-conversation" })
    try {
      const launched = JSON.parse((await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "inspect" }, context)).content)
      const run = (await readSubagentRuns(reader, launched.session_id))[0]!
      if (!run.conversationId) throw new Error("expected a saved child conversation")
      const held = createConversationTreeWriterController({ sessionId: launched.session_id, conversationId: run.conversationId, projectRoot: harness.projectRoot, store: reader, projectionReader: reader, writer, recall: async () => ({ hits: [] }) })
      await held.holdBackgroundNotification("held completion marker", "subagent-completions:grandchild")
      await held.holdBackgroundNotification("second held marker", "subagent-completions:second")
      await held.dispose()
      const first = liveChildRun(reader, launched.session_id)!
      await first.child.interrupt("runtime")
      expect(attempts).toHaveLength(1)
      // The parent hears of the interrupt; no held completion reaches it.
      expect(notification.notifications).toHaveLength(1)
      expect(notification.notifications[0]).toContain("The runtime interrupted this child.")
      expect(await readConversationBackgroundNotifications(reader, launched.session_id, run.conversationId)).toHaveLength(2)
      let failedRun: Awaited<ReturnType<typeof readSubagentRuns>>[number] | undefined
      if (injectFailure) {
        const steering = createConversationTreeWriterController({ sessionId: launched.session_id, conversationId: run.conversationId, projectRoot: harness.projectRoot, store: reader, projectionReader: reader, writer, recall: async () => ({ hits: [] }) })
        await steering.holdQueuedUserInput("saved steering marker")
        await steering.dispose()
        const heldInputs = await readConversationQueuedUserInputs(reader, launched.session_id, run.conversationId)
        expect(heldInputs).toHaveLength(1)
        failHeldRead = true
        const refused = await tool.resume(launched.session_id, context)
        expect(refused.outcome).toBe("error")
        expect(refused.content).toContain("injected held-input read failure")
        expect(notification.backgroundTasks.activeSubagentCount()).toBe(0)
        expect(liveChildRun(reader, launched.session_id)).toBeUndefined()
        expect((await manager.read(launched.session_id))?.lifecycleState).toBe("inactive")
        failedRun = (await readSubagentRuns(reader, launched.session_id))[0]!
        expect(failedRun.status).toBe("failed")
        expect(await readConversationQueuedUserInputs(reader, launched.session_id, run.conversationId)).toEqual(heldInputs)
        expect(await readConversationBackgroundNotifications(reader, launched.session_id, run.conversationId)).toHaveLength(2)
      }
      await tool.resume(launched.session_id, context)
      const resumed = attempts[1]!
      expect(resumed.conversation.kind).toBe("durable-tree")
      if (resumed.conversation.kind !== "durable-tree") throw new Error("expected durable context")
      const saved = JSON.stringify(resumed.conversation.priorMessages)
      const interruption = saved.indexOf("The runtime interrupted this turn")
      expect(interruption).toBeGreaterThanOrEqual(0)
      expect(interruption).toBeLessThan(saved.indexOf("held completion marker"))
      expect(saved.match(/held completion marker/g)).toHaveLength(1)
      expect(saved.match(/second held marker/g)).toHaveLength(1)
      expect(saved.indexOf("held completion marker")).toBeLessThan(saved.indexOf("second held marker"))
      expect(await readConversationBackgroundNotifications(reader, launched.session_id, run.conversationId)).toEqual([])
      await liveChildRun(reader, launched.session_id)!.child.interrupt("person")
      if (failedRun) expect((await readSubagentRuns(reader, launched.session_id))[0]).toEqual(failedRun)
    } finally {
      await authority.settleReconciliation()
      await harness.close()
    }
  })
  // A build before 2026-10-14 held the child's task in the system prompt, so
  // its tree has only the assignment. Remove with the restatement after
  // 2027-04-13.
  it("restates the task once when a child that an earlier build started resumes", async () => {
    const harness = createDurableHarness()
    const reader = asAsyncEventReadSurface(harness.store)
    const writer = asAsyncEventWriter(harness.store)
    const manager = createSessionManager({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, projectionReader: reader, writer })
    await manager.createChat({ id: "root", conversationId: "root-conversation", name: "Root" })
    const authority = createSubagentSessionAuthority({ manager, eventStore: reader, projectionReader: reader, eventWriter: writer, projectRoot: harness.projectRoot, recall: async () => ({ hits: [] }) })
    const earlierBuild = {
      ...authority,
      async publish(publication: Parameters<typeof authority.publish>[0]) {
        const published = await authority.publish(publication)
        return { ...published, conversation: { ...published.conversation, commitSystemTurn: async () => null } }
      },
    }
    const attempts: AgentOptions[] = []
    const notification = notificationRegistry()
    const createRunner = (options: AgentOptions): Agent => {
      attempts.push(options)
      const done = Promise.withResolvers<AgentRunResult>()
      return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise }
    }
    const shared = { sessionId: "root", sessionDir: harness.projectRoot, sessionEventStore: reader, backgroundTasks: notification.backgroundTasks, createRunner }
    const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: "root-conversation" })
    const tool = createSubagentDispatch(makeDeps({ ...shared, subagentSessions: authority }))
    try {
      const launched = JSON.parse((await createSubagentDispatch(makeDeps({ ...shared, subagentSessions: earlierBuild })).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "inspect" }, context)).content)
      const opening = attempts[0]!
      if (opening.conversation.kind !== "durable-tree") throw new Error("expected durable context")
      expect(opening.conversation.priorMessages).toEqual([expect.objectContaining({ kind: "user", content: "inspect" })])
      for (const _resume of [1, 2]) {
        await liveChildRun(reader, launched.session_id)!.child.interrupt("person")
        expect((await tool.resume(launched.session_id, context)).outcome).toBe("ok")
      }
      const resumed = attempts.at(-1)!
      if (resumed.conversation.kind !== "durable-tree") throw new Error("expected durable context")
      const restatements = resumed.conversation.priorMessages.filter((message) => message.kind === "user" && message.origin === "system" && typeof message.content === "string" && message.content.startsWith("Your task follows."))
      expect(restatements).toEqual([{ kind: "user", origin: "system", content: expect.stringContaining("# Delegated Subtask") }])
      await liveChildRun(reader, launched.session_id)!.child.interrupt("person")
    } finally {
      await authority.settleReconciliation()
      await harness.close()
    }
  })
  it("records the dispatch prompt in the empty child tree so the first turn has a message to send", async () => {
    const harness = createDurableHarness()
    const notifications = notificationRegistry()
    const attempts: AgentOptions[] = []
    const factory = (options: AgentOptions): Agent => {
      attempts.push(options)
      const done = Promise.withResolvers<AgentRunResult>()
      return {
        send(): void { done.resolve(completed()) },
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
        done: done.promise,
      }
    }
    const tool = createSubagentDispatch(makeDeps({
      sessionDir: join(harness.projectRoot, ".flywheel", "sessions", harness.sessionId),
      sessionId: harness.sessionId,
      createChildConversation: harness.createChildConversation,
      createRunner: factory,
      backgroundTasks: notifications.backgroundTasks,
    }))

    const acknowledgement = await tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "Trace the compaction trigger" },
      makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot }),
    )
    await notifications.next

    expect(attempts).toHaveLength(1)
    const conversation = attempts[0]!.conversation
    if (conversation.kind !== "durable-tree") throw new Error("expected a durable child conversation")
    expect(conversation.conversationId).not.toBe(childId(acknowledgement))
    // The parent's assignment opens the tree, and the child's task follows it.
    expect(conversation.priorMessages).toEqual([{ kind: "user", content: "Trace the compaction trigger" }, { kind: "user", content: childTask(attempts[0]!), origin: "system" }])
    // The same history comes back from the tree itself: the prompt is durable, not a one-life seed.
    const reopened = harness.createChildConversation(conversation.conversationId)
    expect((await reopened.buildContext()).messages).toEqual([...conversation.priorMessages])
    await reopened.dispose()

    await harness.close()
  })

  it("forks the canonical committed parent history when the live loop missed an external notification", async () => {
    const harness = createDurableHarness()
    const parent = createConversationTreeWriterController({
      conversationId: "parent-conversation",
      sessionId: harness.sessionId,
      projectRoot: harness.projectRoot,
      store: asAsyncEventReadSurface(harness.store),
      projectionReader: asAsyncEventReadSurface(harness.store),
      writer: asAsyncEventWriter(harness.store),
    })
    await parent.buildContext()
    parent.beginTurn()
    parent.recordCanonicalMessage({ kind: "user", content: "launch the workflow" })
    parent.recordCanonicalMessage({ kind: "assistant", content: [{ type: "text", text: "workflow started" }] })
    await parent.endTurn()
    const external = createConversationTreeWriterController({
      conversationId: "parent-conversation",
      sessionId: harness.sessionId,
      projectRoot: harness.projectRoot,
      store: asAsyncEventReadSurface(harness.store),
      projectionReader: asAsyncEventReadSurface(harness.store),
      writer: asAsyncEventWriter(harness.store),
    })
    await external.commitSystemTurn("workflow finished", "workflow-completion:child")
    await external.dispose()
    expect(await parent.captureCommittedForkMessages()).toContainEqual({
      kind: "user",
      content: "workflow finished",
      origin: "system",
    })
    parent.beginTurn()
    parent.recordCanonicalMessage({ kind: "assistant", content: [{ type: "text", text: "workflow completed" }] })
    await parent.endTurn()
    parent.beginTurn()
    parent.recordCanonicalMessage({
      kind: "assistant",
      content: [{
        type: "tool_use",
        id: "fork-call",
        name: "subagent",
        input: { persona: "explorer", prompt: "finish the cutover", fork: true },
      }, {
        type: "tool_use",
        id: "finished-sibling",
        name: "read",
        input: { path: "README.md" },
      }],
    })
    parent.recordCanonicalMessage({
      kind: "toolResult",
      toolUseId: "finished-sibling",
      content: [{ type: "text", text: "finished sibling result" }],
    })
    await parent.flushSavePoint(new Set(["fork-call"]))

    const notifications = notificationRegistry()
    const attempts: AgentOptions[] = []
    const factory = (options: AgentOptions): Agent => {
      attempts.push(options)
      const done = Promise.withResolvers<AgentRunResult>()
      return {
        send(): void { done.resolve(completed()) },
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
        done: done.promise,
      }
    }
    const tool = createSubagentDispatch(makeDeps({
      sessionDir: join(harness.projectRoot, ".flywheel", "sessions", harness.sessionId),
      sessionId: harness.sessionId,
      createChildConversation: harness.createChildConversation,
      createRunner: factory,
      backgroundTasks: notifications.backgroundTasks,
    }))

    const launch = await tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "finish the cutover", fork: true },
      makeContext({
        projectRoot: harness.projectRoot,
        executionCwd: harness.projectRoot,
        snapshotConversation: () => parent.captureCommittedForkMessages(),
      }),
    )
    expect(launch.outcome).toBe("ok")
    await notifications.next

    expect(attempts).toHaveLength(1)
    const conversation = attempts[0]!.conversation
    if (conversation.kind !== "durable-tree") throw new Error("expected durable child conversation")
    expect(conversation.priorMessages.slice(0, 4)).toEqual([
      { kind: "user", content: "launch the workflow" },
      { kind: "assistant", content: [{ type: "text", text: "workflow started" }] },
      { kind: "user", content: "workflow finished", origin: "system" },
      { kind: "assistant", content: [{ type: "text", text: "workflow completed" }] },
    ])
    await parent.dispose()
    await harness.close()
  })

  it("persists a fork seed and the child's checkpoint in one conversation", async () => {
    const harness = createDurableHarness()
    const notifications = notificationRegistry()
    const attempts: AgentOptions[] = []
    const factory = (options: AgentOptions): Agent => {
      attempts.push(options)
      const done = Promise.withResolvers<AgentRunResult>()
      return {
        send(): void {
          void (async () => {
            if (options.conversation.kind !== "durable-tree") throw new Error("expected durable child conversation")
            options.conversation.append({ kind: "user", content: "durable retry checkpoint" })
            await options.conversation.flush?.()
            done.resolve(completed())
          })().catch(done.reject)
        },
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
        done: done.promise,
      }
    }
    const tool = createSubagentDispatch(makeDeps({
      sessionDir: join(harness.projectRoot, ".flywheel", "sessions", harness.sessionId),
      sessionId: harness.sessionId,
      createChildConversation: harness.createChildConversation,
      createRunner: factory,
      backgroundTasks: notifications.backgroundTasks,
    }))

    const acknowledgement = await tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "continue", fork: true },
      makeContext({
        projectRoot: harness.projectRoot,
        executionCwd: harness.projectRoot,
        snapshotConversation: async () => [{ kind: "user", content: "parent fork seed" }],
      }),
    )
    await notifications.next

    expect(attempts).toHaveLength(1)
    const first = attempts[0]!.conversation
    if (first.kind !== "durable-tree") throw new Error("expected durable child conversation")
    expect(first.conversationId).not.toBe(childId(acknowledgement))
    expect(first.priorMessages).toHaveLength(3)
    expect(first.priorMessages[0]).toEqual({ kind: "user", content: "parent fork seed" })
    expect(first.priorMessages[1]).toMatchObject({ kind: "user" })
    expect(first.priorMessages[1]?.content).toContain("continue")
    const reopened = harness.createChildConversation(first.conversationId)
    expect((await reopened.buildContext()).messages).toEqual([...first.priorMessages, { kind: "user", content: "durable retry checkpoint" }])
    await reopened.dispose()

    await harness.close()
  })

  it("recalls precompaction fork and tool context in a retained child", async () => {
    const harness = createDurableHarness()
    const parent = harness.createChildConversation("parent-conversation")
    await parent.buildContext()
    parent.beginTurn()
    parent.recordCanonicalMessage({ kind: "user", content: "parent-only cedar marker" })
    await parent.flushSavePoint()
    await parent.dispose()
    const sibling = harness.createChildConversation("sibling-conversation")
    await sibling.buildContext()
    sibling.beginTurn()
    sibling.recordCanonicalMessage({ kind: "user", content: "sibling-only birch marker" })
    await sibling.flushSavePoint()
    await sibling.dispose()

    const notifications = notificationRegistry()
    const attempts: AgentOptions[] = []
    let recallEntryId = ""
    const failures: unknown[] = []
    const toolResultText = "tool result contains obsidian-recall marker and complete diagnostic output"
    const factory = (options: AgentOptions): Agent => {
      attempts.push(options)
      const done = Promise.withResolvers<AgentRunResult>()
      return {
        send(): void {
          void (async () => {
            if (options.conversation.kind !== "durable-tree") throw new Error("expected durable child conversation")
            const recall = options.runtimeSurfaces?.recall
            if (!recall) throw new Error("expected child-local recall")
              options.conversation.append({
                kind: "assistant",
                content: [{
                  type: "tool_use",
                  id: "tool_precompaction",
                  name: "search",
                  input: { pattern: "obsidian-recall" },
                }],
              })
              options.conversation.append({
                kind: "toolResult",
                toolUseId: "tool_precompaction",
                content: [{ type: "text", text: toolResultText }],
              })
              await options.conversation.flush?.()
              const hit = (await recall({ scope: "lineage", query: "obsidian-recall" })).hits.find(
                (candidate) => candidate.role === "tool_result",
              )
              if (!hit) throw new Error("expected durable tool-result recall hit")
              recallEntryId = hit.entryId
              const compacted = await options.conversation.recordCompaction?.({
                tokensBefore: 10_000,
                additions: [],
                after: "continue",
                measureTokensAfter: () => 1,
              })
              if (!compacted) throw new Error("expected compaction result")
            expect(compacted).toEqual([])
            const toolSearch = await recall({ scope: "lineage", query: "obsidian-recall" })
            expect(toolSearch.hits.some((entry) => entry.entryId === recallEntryId)).toBe(true)
            expect((await recall({ scope: "lineage", query: "willow" })).hits).toHaveLength(1)
            expect((await recall({ scope: "all", query: "cedar" })).hits).toHaveLength(0)
            expect((await recall({ scope: "all", query: "birch" })).hits).toHaveLength(0)
            const expanded = await recall({ scope: "lineage", expand: [recallEntryId], offset: 0, limit: 8_000 })
            expect(expanded.invalidExpand).toBeUndefined()
            expect(expanded.hits[0]).toMatchObject({ entryId: recallEntryId, text: expect.stringContaining(toolResultText) })
            done.resolve(completed())
          })().catch((error: unknown) => {
            failures.push(error)
            done.reject(error)
          })
        },
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
        done: done.promise,
      }
    }
    const tool = createSubagentDispatch(makeDeps({
      sessionDir: join(harness.projectRoot, ".flywheel", "sessions", harness.sessionId),
      sessionId: harness.sessionId,
      createChildConversation: harness.createChildConversation,
      createRunner: factory,
      backgroundTasks: notifications.backgroundTasks,
    }))

    await tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "inspect the marker", fork: true },
      makeContext({
        projectRoot: harness.projectRoot,
        executionCwd: harness.projectRoot,
        snapshotConversation: async () => [{ kind: "user", content: "fork seed willow marker" }],
      }),
    )
    await notifications.next

    expect(attempts).toHaveLength(1)
    expect(failures).toEqual([])
    expect(recallEntryId).not.toBe("")
    await harness.close()
  })

  it("binds recall to each child conversation", async () => {
    const harness = createDurableHarness()
    const observedHits: number[] = []
    let dispatch = 0
    const runDispatch = async (marker: string, query: string): Promise<void> => {
      const notifications = notificationRegistry()
      const factory = (options: AgentOptions): Agent => {
        const done = Promise.withResolvers<AgentRunResult>()
        return {
          send(): void {
            void (async () => {
              if (options.conversation.kind !== "durable-tree") throw new Error("expected durable child conversation")
              const recall = options.runtimeSurfaces?.recall
              if (!recall) throw new Error("expected child-local recall")
              options.conversation.append({ kind: "user", content: marker })
              await options.conversation.flush?.()
              observedHits.push((await recall({ scope: "lineage", query })).hits.length)
              done.resolve(completed())
            })().catch(done.reject)
          },
          end() {},
          abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
          done: done.promise,
        }
      }
      const tool = createSubagentDispatch(makeDeps({
        sessionDir: join(harness.projectRoot, ".flywheel", "sessions", harness.sessionId),
        sessionId: harness.sessionId,
        createChildConversation: harness.createChildConversation,
        createRunner: factory,
        backgroundTasks: notifications.backgroundTasks,
      }))
      await tool.execute(
        { persona: "explorer", rationale: TEST_RATIONALE, prompt: `dispatch ${dispatch++}` },
        makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot }),
      )
      await notifications.next
    }

    await runDispatch("first child zebrafinch marker", "zebrafinch")
    await runDispatch("second child own marker", "zebrafinch")

    expect(observedHits).toEqual([1, 0])
    await harness.close()
  })

  it("flushes and disposes a cancelled child without closing the shared store", async () => {
    const harness = createDurableHarness()
    const notifications = notificationRegistry()
    const started = Promise.withResolvers<void>()
    let disposeCount = 0
    let durableConversationId = ""
    const createChildConversation = (id: string): ChildSessionConversation => {
      const controller = harness.createChildConversation(id)
      return {
        ...controller,
        async dispose() {
          disposeCount += 1
          await controller.dispose()
        },
      }
    }
    const factory = (options: AgentOptions): Agent => {
      const done = Promise.withResolvers<AgentRunResult>()
      return {
        send(): void {
          if (options.conversation.kind !== "durable-tree") throw new Error("expected durable child conversation")
          durableConversationId = options.conversation.conversationId
          options.conversation.append({ kind: "user", content: "pending cancellation marker" })
          started.resolve()
        },
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
        done: done.promise,
      }
    }
    const tool = createSubagentDispatch(makeDeps({
      sessionDir: join(harness.projectRoot, ".flywheel", "sessions", harness.sessionId),
      sessionId: harness.sessionId,
      createChildConversation,
      createRunner: factory,
      backgroundTasks: notifications.backgroundTasks,
    }))

    const acknowledgement = await tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "wait" },
      makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, toolUseId: "tc_cancel_durable" }),
    )
    await started.promise
    notifications.backgroundTasks.terminate("tc_cancel_durable")
    await notifications.next

    expect(disposeCount).toBe(1)
    expect(durableConversationId).not.toBe(childId(acknowledgement))
    const reopened = harness.createChildConversation(durableConversationId)
    const messages: ReadonlyArray<ConversationMessage> = (await reopened.buildContext()).messages
    expect(messages.map((message) => message.kind === "user" && typeof message.content === "string" ? message.content : "")).toEqual(["wait", expect.stringContaining("# Delegated Subtask"), "pending cancellation marker"])
    await reopened.dispose()
    expect(harness.store.read({}).length).toBeGreaterThan(0)

    await harness.close()
  })
})
