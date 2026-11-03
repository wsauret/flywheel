import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type EventStoreAppend, type StoredFact } from "../../../src/infra/event-store-types.js"
import { attachProjectionFoldCache, openProjectionFoldCache, type FoldSavePolicy, type ProjectionFoldCache } from "../../../src/infra/projection-fold-cache.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { createSessionMetadataProjection, createSessionPlacementProjection } from "../../../src/orchestration/session/session-metadata-projection.js"
import { sessionMessageSources } from "../../../src/orchestration/session/session-message-sources.js"
import { createBudgetProjection } from "../../../src/orchestration/session/budget-projection.js"
import { createToolExecutionProjection } from "../../../src/orchestration/session/tool-execution-projection.js"
import { loadAgentInputProjection } from "../../../src/orchestration/session/agent-input-projection.js"
import { loadSessionPendingFileMutations } from "../../../src/orchestration/session/file-mutation-recovery.js"
import { workflowMembershipReader } from "../../../src/orchestration/session/workflow-membership.js"
import { createSessionFactWriter } from "../../../src/orchestration/session/session-fact-writer.js"
import { createChildMeasureReader } from "../../../src/orchestration/modules/subagents/history/child-measures.js"
import { createWorkflowQueueProjection } from "../../../src/workflows/view/view-projection.js"
import { readTerminalHandoff } from "../../../src/workflows/output-contract/workflow-completion.js"
import { buildHandoffWrittenFact } from "../../../src/workflows/output-contract/facts.js"
import { initializedWorkflowFacts, initializedWorkflowRoot, recoveredWorkflowRoot } from "../../helpers/workflow-root-fixtures.js"
import { fileMutationCompletionFacts, type FileMutationPreparedFact } from "../../../src/orchestration/session/file-mutation-fact-writers.js"
import { contentEvidence } from "../../../src/infra/content-evidence.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { createStoredSession } from "../orchestration/session/_session-metadata-test-helpers.js"
import { minimalSession } from "../orchestration/session/_session-manager-fixtures.js"

const directory = temporaryDirectories()
const opened: { close(): void }[] = []
afterEach(() => {
  for (const owned of opened.splice(0).toReversed()) owned.close()
})

/** Saves every fold as soon as the folding task ends. */
const SAVE_AT_ONCE: FoldSavePolicy = { afterFacts: 1, quietMs: 0 }

type LocalSqliteEventStore = ReturnType<typeof createSqliteEventStore>

/** `cache`, and a wait until every fold that it was asked to save is written.
 *  The wait reads no projection: a save gives up for a read that waits on
 *  its projection and asks again later, so a read would race the save. */
function observedCache(cache: ProjectionFoldCache) {
  const unwritten = new Set<string>()
  return {
    cache: {
      ...cache,
      slot(role, key) {
        const slot = cache.slot(role, key)
        return {
          ...slot,
          folded(facts, foldMs, save) {
            unwritten.add(key)
            slot.folded(facts, foldMs, save)
          },
          async save(fold) {
            const written = await slot.save(fold)
            if (written) unwritten.delete(key)
            return written
          },
        }
      },
    } satisfies ProjectionFoldCache,
    async saved() {
      while (unwritten.size > 0) await Bun.sleep(1)
    },
  }
}

interface Family {
  readonly name: string
  /** Facts that the first process folds and saves. */
  readonly seed: (store: LocalSqliteEventStore, root: string) => Promise<void> | void
  /** Facts committed after the second process restored the fold. */
  readonly after?: (store: LocalSqliteEventStore, root: string) => Promise<StoredFact[]> | StoredFact[]
  /** What the family's owner reads. */
  readonly read: (reader: AsyncEventStateReadSurface, root: string) => Promise<object | null>
  /** Folds the facts that `after` committed as their writer pushes them, and reads. */
  readonly push?: (reader: AsyncEventStateReadSurface, facts: readonly StoredFact[]) => Promise<object>
}

let clock = 0
function sessionFact(sessionId: string, type: string, version: number, actor: string, payload: StoredFact["payload"]): EventStoreAppend {
  clock += 1
  return { aggregateId: `session:${sessionId}`, sessionId, type, version, actor, timestamp: clock, payload }
}
const usage = (cost: number) => sessionFact("chat", "model.usage.measured", 3, "provider",
  { totalCostUsd: cost, billedCostUsd: cost, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 })
const toolCall = (toolUseId: string) => [
  sessionFact("chat", "tool.input.completed", 1, "agent", { toolUseId, toolName: "read", modelRequestId: "request", input: { path: "a" }, inputBytes: 12, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false }),
  sessionFact("chat", "tool.execution_output.recorded", 1, "flywheel", { toolUseId, output: "tail", modelRequestId: "request" }),
  sessionFact("chat", "tool.result.recorded", 1, "flywheel", { toolUseId, modelRequestId: "request", outcome: "ok" }),
]
const question = (interactionId: string) => sessionFact("chat", "agent_input.requested", 3, "agent", {
  interactionId, conversationId: "conversation", toolUseId: interactionId,
  request: [{ question: "Proceed?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
})
const answer = (interactionId: string) => sessionFact("chat", "agent_input.answered", 3, "user", {
  interactionId, answers: { "Proceed?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "" } },
})
const member = (sessionId: string) => sessionFact(sessionId, "session.created", 6, "flywheel", {
  label: sessionId, lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive", createdAt: "2026-01-01T00:00:00.000Z",
  launchedFrom: { parentSessionId: "parent", conversationId: "conversation-parent", toolUseId: `tool-${sessionId}` },
  conversationId: `agent-${sessionId}`, kind: "workflow-agent", command: "workflow-agent",
  workflowMembership: { kind: "attempt", workflowId: "wf", attemptId: `attempt-${sessionId}` },
  importedResources: { workflowId: "wf", conversationId: `agent-${sessionId}` },
})
function workflowFact(draft: { readonly type: string; readonly version: number; readonly actor: string; readonly payload: StoredFact["payload"] }): EventStoreAppend {
  clock += 1
  return { aggregateId: "workflow:wf", sessionId: "wf", type: draft.type, version: draft.version, actor: draft.actor, timestamp: clock, payload: draft.payload }
}
/** A mutation of `name` that the session prepared and, when `applied`, settled. */
async function mutateFile(store: LocalSqliteEventStore, root: string, name: string, applied: boolean): Promise<void> {
  const writer = createSessionFactWriter({ sessionId: "chat", writer: asAsyncEventWriter(store) })
  try {
    const path = join(root, name)
    const prepared: FileMutationPreparedFact = {
      type: "file.mutation.prepared", version: 1, actor: "flywheel",
      payload: { mutationId: name, path, displayPath: path, changeKind: "modified", toolUseId: "tool", before: contentEvidence("before"), after: contentEvidence("after") },
    }
    await writer.record(prepared)
    if (!applied) return
    for (const completion of fileMutationCompletionFacts(prepared, "applied", null)) await writer.record(completion)
    await writer.record({ type: "file.mutation.settled", version: 1, actor: "flywheel", payload: { mutationId: name, outcome: "applied" } })
  } finally {
    writer.dispose()
  }
}
const appended = (store: LocalSqliteEventStore, facts: readonly EventStoreAppend[]): StoredFact[] => store.appendBatch(facts)

// Every family that the cache admits, folded from facts that their writers
// commit. A family whose state holds a value the encoding cannot restore,
// such as a class instance, is refused and never restored.
const families: Family[] = [
  {
    name: "session placement (Effect HashMap)",
    seed: async (store, root) => { await createStoredSession(minimalSession({ label: "chat" }), root, undefined, store) },
    after: async (store, root) => { await createStoredSession(minimalSession({ label: "later chat" }), root, undefined, store); return [] },
    read: (reader) => createSessionPlacementProjection(reader).replay(),
  },
  { name: "session metadata", seed: () => {}, read: (reader) => createSessionMetadataProjection(reader).replay() },
  { name: "session message sources (Map and Set)", seed: () => {}, read: (reader) => sessionMessageSources(reader).replay() },
  {
    // Enough members that the fold spans several encoded slices.
    name: "workflow membership",
    seed: (store) => { appended(store, Array.from({ length: 2_000 }, (_, index) => member(`m${index}`))) },
    after: (store) => appended(store, [member("m3")]),
    read: (reader) => workflowMembershipReader(reader).list("wf"),
  },
  {
    name: "budget, with pushed facts folded on a draft",
    seed: (store) => { appended(store, [usage(1), usage(2)]) },
    after: (store) => appended(store, [usage(3), usage(4)]),
    read: (reader) => createBudgetProjection(reader, "chat").replay(),
    async push(reader, facts) {
      const projection = createBudgetProjection(reader, "chat")
      for (const pushed of facts) await projection.apply(pushed)
      return projection.getState()
    },
  },
  {
    name: "tool execution",
    seed: (store) => { appended(store, [...toolCall("t1"), ...toolCall("t2")]) },
    after: (store) => appended(store, toolCall("t3")),
    read: (reader) => createToolExecutionProjection(reader, "chat").replay(),
  },
  {
    name: "subagent measure",
    seed: () => {},
    after: (store) => appended(store, [...toolCall("t4"), usage(5)]),
    read: (reader) => createChildMeasureReader(reader).read("chat", undefined),
  },
  {
    name: "agent input",
    seed: (store) => { appended(store, [question("q1"), answer("q1")]) },
    after: (store) => appended(store, [question("q2")]),
    read: (reader) => loadAgentInputProjection(reader, "chat"),
  },
  {
    name: "file mutation history",
    seed: async (store, root) => {
      await mutateFile(store, root, "settled.txt", true)
      await mutateFile(store, root, "pending.txt", false)
    },
    after: async (store, root) => { await mutateFile(store, root, "later.txt", true); return [] },
    read: (reader) => loadSessionPendingFileMutations(reader, "chat"),
  },
  {
    name: "workflow queue view, across a reset boundary",
    seed: (store) => { appended(store, initializedWorkflowFacts("request").map(workflowFact)) },
    after: (store) => appended(store, [workflowFact(recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, store.aggregateSeq("workflow:wf") + 1))]),
    read: (reader) => createWorkflowQueueProjection(reader, "wf").replay(),
  },
  {
    name: "terminal handoff, whose content is agent JSON",
    seed: (store) => {
      const content: { readonly [key: string]: unknown } = JSON.parse('{"summary":"done","__proto__":{"polluted":true}}')
      appended(store, [workflowFact(buildHandoffWrittenFact({ attemptId: "a1", agentName: "A", definitionId: "work", workflowDefinitionId: "workflow", content }))])
    },
    read: (reader) => readTerminalHandoff(reader, "wf"),
  },
]

test("each cached family, restored and caught up, equals a full rebuild and reads no history", async () => {
  const root = directory("fold-cache-families-")
  const store = createSqliteEventStore(join(root, ".flywheel", "flywheel.sqlite"))
  opened.push(store)
  for (const family of families) await family.seed(store, root)
  const cachePath = join(root, "folds.sqlite")
  const historyReads: string[] = []
  const processReader = () => {
    const local = asAsyncEventReadSurface(store)
    const reader: AsyncEventStateReadSurface = { ...local, readPage: (...args) => { if (args[2] === 0) historyReads.push(JSON.stringify(args[0])); return local.readPage(...args) } }
    const { cache, saved } = observedCache(openProjectionFoldCache(cachePath, "build-a", SAVE_AT_ONCE))
    opened.push(cache)
    attachProjectionFoldCache([reader], cache, "executor")
    return { reader, saved }
  }
  const { reader: first, saved } = processReader()
  for (const family of families) await family.read(first, root)
  await saved()

  historyReads.splice(0)
  const { reader: second } = processReader()
  for (const family of families) {
    await family.read(second, root)
    expect({ family: family.name, historyReads }).toEqual({ family: family.name, historyReads: [] })
    const facts = await family.after?.(store, root) ?? []
    const restored = family.push ? await family.push(second, facts) : await family.read(second, root)
    expect({ family: family.name, state: restored }).toEqual({ family: family.name, state: await family.read(asAsyncEventReadSurface(store), root) })
  }
  const handoff = await readTerminalHandoff(second, "wf")
  expect(handoff?.content && Object.getOwnPropertyDescriptor(handoff.content, "__proto__")?.value).toEqual({ polluted: true })
})
