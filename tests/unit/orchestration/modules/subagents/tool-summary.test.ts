import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, type EventStore, type EventStoreAppend } from "../../../../../src/infra/event-store-types.js"
import type { DebugLogRecordInput } from "../../../../../src/infra/debug-log.js"
import { Log } from "../../../../../src/infra/log.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { composeFirstPartyModules, createSessionToolSummaryReader, installedWorkspaceMigrations } from "../../../../../src/orchestration/modules.js"
import { subagentsModule } from "../../../../../src/orchestration/modules/subagents.js"
import { TreeBlockProjection } from "../../../../../src/orchestration/session/conversation/conversation-block-projection.js"
import type { MessageEntry } from "../../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import { entriesVisited } from "../../../../helpers/entries-visited.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"
import type { ToolHistorySummary } from "../../../../../src/orchestration/module-seams.js"

let directory: string
let store: EventStore
const sessionId = "summary-session"

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "module-tool-summary-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(directory))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
function append(fact: Omit<EventStoreAppend, "aggregateId" | "sessionId" | "timestamp">): void {
  store.append({ ...fact, aggregateId: `session:${sessionId}`, sessionId, timestamp: 10 })
}
function created(id: string): void {
  append({ type: "child_run.created", version: 1, actor: "flywheel", payload: {
    childRunId: id, kind: "subagent", toolUseId: id, agentType: "explorer", description: "Read history",
    model: "test-model", effort: "medium", maxTurns: 3, tools: ["read"],
  } })
}
function appendV2Created(childSessionId: string, parentSessionId: string, run = { childRunId: "run-1", toolUseId: "toolu_v2" }, conversationId = "child-conversation"): void {
  store.append({
    aggregateId: `session:${childSessionId}`,
    sessionId: childSessionId,
    type: "child_run.created",
    version: 2,
    actor: "flywheel",
    timestamp: 10,
    payload: {
      childSessionId,
      childRunId: run.childRunId,
      conversationId,
      parentSessionId,
      parentConversationId: "parent-conversation",
      parentToolCallId: run.toolUseId,
      persona: { name: "explorer", kind: "persona" },
      capabilityGrant: {
        operation: "subagent",
        required: [],
        capabilities: [],
        moduleIds: [],
        requireWorkflowConfirmation: false,
        workflowsMode: "off",
        identity: "grant",
      },
      admittedModuleIds: [],
      skillsRevision: 1,
      model: "test-model",
      tools: ["read"],
      executionCwd: "/scratch",
      budget: { maxTurns: 3, maxTokens: 1000 },
      parentDepth: 0,
      description: "Read history",
    },
  })
}

function summaryReader(id = sessionId) {
  return createSessionToolSummaryReader(asAsyncEventReadSurface(store), id, [subagentsModule])
}
function appendReadCall(childSessionId: string, toolUseId: string): void {
  store.append({
    aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "tool.input.completed", version: 1, actor: "agent", timestamp: 10,
    payload: { toolUseId, toolName: "read", input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false },
  })
}
/** Links child `index` of `parent`, run by the call `toolu_<index>`, with one read call in its history. */
function linkMeasuredChild(parent: string, index: number): string {
  const childSessionId = `${parent}-child-${index}`
  store.append({
    aggregateId: `session:${parent}`, sessionId: parent, type: "session.child.linked", version: 1, actor: "flywheel", timestamp: 9,
    payload: { childSessionId, lastUpdated: "2026-01-01T00:00:00.000Z" },
  })
  appendV2Created(childSessionId, parent, { childRunId: `${parent}-run-${index}`, toolUseId: `toolu_${index}` }, `${childSessionId}-conversation`)
  appendReadCall(childSessionId, `${childSessionId}-read`)
  return childSessionId
}

test("disabled Subagents retains its historical reader and ordered migration", async () => {
  const catalog = [subagentsModule]
  expect(composeFirstPartyModules(catalog, ["subagents"]).enabledModuleIds).not.toContain("subagents")
  created("child")
  const reader = createSessionToolSummaryReader(asAsyncEventReadSurface(store), sessionId, catalog)
  const first = await reader.replay()
  expect(first.summaries.get("child")).toEqual({
    toolUseId: "child", status: "active", ownsSettlement: true, totalToolCount: 0, agentType: "explorer", model: "test-model medium", description: "Read history",
  })
  append({ type: "subagent.completed", version: 1, actor: "flywheel", payload: {
    childRunId: "child", status: "completed", isError: false, durationMs: 25, totalTokens: 30, toolUses: 2,
    resultBytes: 4, resultSha256: "sha", resultPreview: "done",
  } })
  const completed = await reader.replay()
  expect(completed.position).toBeGreaterThan(first.position)
  expect(completed.summaries.get("child")).toEqual({
    toolUseId: "child", status: "completed", ownsSettlement: true, totalToolCount: 2,
    duration: 25, totalTokens: 30, agentType: "explorer", model: "test-model medium", description: "Read history",
  })
  expect((await reader.replay()).summaries.get("child")).toBe(completed.summaries.get("child"))
  expect(installedWorkspaceMigrations("stored-facts", false, catalog).map(({ order, label }) => ({ order, label })))
    .toEqual([{ order: 90, label: "subagent prompts" }])
})

test.each([
  ["failed", "error", false],
  ["cancelled", "cancelled", true],
  ["interrupted", "interrupted", true],
] as const)("retained %s facts preserve %s status and result settlement ownership", async (status, expected, ownsSettlement) => {
  created("child")
  if (status === "interrupted") append({ type: "subagent.interrupted", version: 1, actor: "flywheel", payload: {
    childRunId: "child", reason: "runtime_restarted", recoveryId: "recovery",
  } })
  else append({ type: "subagent.completed", version: 1, actor: "flywheel", payload: {
    childRunId: "child", status, isError: status === "failed", durationMs: 25,
    resultBytes: 16, resultSha256: "sha", resultPreview: "Provider refused",
  } })
  const summary = (await summaryReader().replay()).summaries.get("child")
  expect(summary).toMatchObject({ status: expected, ownsSettlement })
  if (status === "failed") expect(summary?.status === "error" ? summary.failure : undefined).toBeDefined()
})

test("a replay after nothing was appended reads no facts, and the next append is read", async () => {
  // One subagent card per transcript block replays the reader; with the
  // store behind the state Worker, each fact read is a round trip.
  created("child")
  const local = asAsyncEventReadSurface(store)
  let pages = 0
  const counted = { ...local, readPage: (...args: Parameters<typeof local.readPage>) => { pages += 1; return local.readPage(...args) } }
  const reader = createSessionToolSummaryReader(counted, sessionId, [subagentsModule])
  await reader.replay()
  const afterFirst = pages
  for (let block = 0; block < 5; block += 1) await reader.replay()
  expect(pages).toBe(afterFirst)

  append({ type: "subagent.completed", version: 4, actor: "flywheel", payload: {
    childRunId: "child", status: "completed", isError: false, durationMs: 25, totalTokens: 30, toolUses: 2,
    result: "done", resultBytes: 4, resultSha256: "sha", resultPreview: "done",
  } })
  expect((await reader.replay()).summaries.get("child")).toMatchObject({ status: "completed" })
})

test("a replay reads no child's history, and each measured child's history is read once per reader", async () => {
  // A chat with hundreds of subagents asks for its cards on every transcript
  // read. With the store behind the state Worker, each read is a round trip,
  // so only the cards a reader states are measured, and a child's measure is
  // a held fold that a later reader advances instead of reading again.
  const parent = "parent"
  const children = 12
  for (let index = 0; index < children; index += 1) {
    const childSessionId = linkMeasuredChild(parent, index)
    store.append({
      aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "subagent.completed", version: 4, actor: "flywheel", timestamp: 11,
      payload: { childRunId: `${parent}-run-${index}`, status: "completed", isError: false, durationMs: 10, totalTokens: 20, toolUses: 2, result: "r", resultBytes: 1, resultSha256: "sha", resultPreview: "r" },
    })
  }
  const counter = countStateRequests(asAsyncEventReadSurface(store))
  /** The facts each child's history reads returned, by child aggregate id. */
  const historyFacts = () => counter.take()
    .filter((request) => request.method === "readPage" && request.query?.types?.includes("tool.input.completed"))
    .map((request) => [request.aggregateId ?? request.query?.aggregateIds?.join(",") ?? "", request.facts] as const)
    .filter(([aggregateIds]) => aggregateIds.includes(`${parent}-child-`))
    .sort(([left], [right]) => left.localeCompare(right))
  const snapshot = await createSessionToolSummaryReader(counter.reader, parent, [subagentsModule]).replay()
  expect(snapshot.summaries.size).toBe(children)
  expect(snapshot.summaries.get("toolu_0")).toMatchObject({ status: "completed", totalToolCount: 2, totalTokens: 20 })
  expect(historyFacts()).toEqual([])

  const askedIds = ["toolu_3", "toolu_7"]
  const asked = askedIds.map((id) => snapshot.summaries.get(id)).filter((summary) => summary !== undefined)
  const measured = await Promise.all(asked.map((summary) => snapshot.measure(summary)))
  expect(measured).toEqual(asked.map((summary) => ({ ...summary, totalToolCount: 1 })))
  // Each child reads its own measured history, a tool input and a completion.
  expect(historyFacts()).toEqual([[`session:${parent}-child-3`, 2], [`session:${parent}-child-7`, 2]])
  // A summary measured again is the same measured summary, read once.
  for (const summary of asked) expect(measured).toContain(await snapshot.measure(summary))
  expect(historyFacts()).toEqual([])

  // Another reader of the same store, such as the next transcript of the
  // parent, advances the held folds: an unchanged child reads no fact, and a
  // child that worked reads only its new fact.
  appendReadCall(`${parent}-child-3`, `${parent}-child-3-late`)
  const next = await createSessionToolSummaryReader(counter.reader, parent, [subagentsModule]).replay()
  counter.take()
  const remeasured = await Promise.all(askedIds.flatMap((id) => next.summaries.get(id) ?? []).map((summary) => next.measure(summary)))
  // The late call follows the completion, so the card still states the work before it.
  expect(remeasured.map((summary) => summary.totalToolCount)).toEqual([1, 1])
  expect(historyFacts()).toEqual([[`session:${parent}-child-3`, 1], [`session:${parent}-child-7`, 0]])
})

test("a change costs the same requests, facts, aggregate ids, and members whatever the child count and history length", async () => {
  // A transcript replays the reader and measures its cards on every store
  // change. A read per paused child, a query that names every known child, a
  // scan of every run, or a reread of a child's whole history made each
  // change cost more as a chat's subagents grew and worked.
  const local = asAsyncEventReadSurface(store)
  const childFact = (childSessionId: string, type: string, payload: EventStoreAppend["payload"], actor = "flywheel") => store.append({
    aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type, version: 1, actor, timestamp: 10, payload,
  })
  async function changeCost(children: number, history: number) {
    const parent = `parent-${children}-${history}`
    for (let index = 0; index < children; index += 1) {
      const childSessionId = linkMeasuredChild(parent, index)
      for (let call = 1; call < history; call += 1) appendReadCall(childSessionId, `${childSessionId}-read-${call}`)
      childFact(childSessionId, "subagent.paused", { childRunId: `${parent}-run-${index}`, pausedBy: "person" })
    }
    const counter = countStateRequests(local)
    const reader = createSessionToolSummaryReader(counter.reader, parent, [subagentsModule])
    // A transcript measures the cards that a replay changed.
    const measureChanged = async () => {
      const snapshot = await reader.replay()
      return Promise.all([...snapshot.changedToolUseIds].flatMap((toolUseId) => {
        const summary = snapshot.summaries.get(toolUseId)
        return summary ? [snapshot.measure(summary)] : []
      }))
    }
    expect(await measureChanged()).toHaveLength(children)
    counter.take()
    // The paused child works and its conversation moves, which changes its card.
    const changed = `${parent}-child-0`
    appendReadCall(changed, `${changed}-read-${history}`)
    store.append({
      aggregateId: `conversation:${changed}-conversation`, sessionId: changed, type: "chat.entries.appended", version: 1, actor: "flywheel", timestamp: 11,
      payload: { conversationId: `${changed}-conversation`, entries: [{ kind: "message", id: "u-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { kind: "user", content: "continue" } }] },
    })
    let measured: ToolHistorySummary[] = []
    const members = await entriesVisited(async () => { measured = await measureChanged() })
    expect(measured).toMatchObject([{ toolUseId: "toolu_0", totalToolCount: history + 1 }])
    const requests = counter.take()
    // The run cursor's own read of its linked children's run facts is outside this reader.
    const aggregateIds = requests.reduce((total, request) => total + (request.query?.types?.includes("child_run.created") ? 0 : request.query?.aggregateIds?.length ?? 0), 0)
    return { requests: requests.length, facts: factsRead(requests), aggregateIds, members }
  }
  const base = await changeCost(1, 2)
  expect(await changeCost(50, 2)).toEqual(base)
  // Past the bound of held measures, the first child measured is the least
  // recently used, and its card still advances only by its new fact.
  expect(await changeCost(300, 2)).toEqual(base)
  expect(await changeCost(1, 40)).toEqual(base)

  // A parent resumes its failed child again and again: each attempt is a new
  // run of the same child session under the same card, which states every
  // attempt with the session's work through it.
  async function resumeCost(attempts: number) {
    const parent = `resume-parent-${attempts}`
    const childSessionId = `${parent}-child`
    const parentFact = (type: string, payload: EventStoreAppend["payload"], actor = "flywheel") => store.append({
      aggregateId: `session:${parent}`, sessionId: parent, type, version: 1, actor, timestamp: 10, payload,
    })
    parentFact("session.child.linked", { childSessionId, lastUpdated: "2026-01-01T00:00:00.000Z" })
    const attempt = (index: number) => {
      const childRunId = `${parent}-run-${index}`
      const resume = `resume-${index}`
      if (index > 0) parentFact("tool.input.completed", {
        toolUseId: resume, toolName: "process", input: { action: "resume", process_id: childSessionId }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}",
        executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      }, "agent")
      appendV2Created(childSessionId, parent, { childRunId, toolUseId: "dispatch" }, `${childSessionId}-conversation`)
      if (index > 0) parentFact("tool.result.recorded", { toolUseId: resume, outcome: "ok", contentPreview: JSON.stringify({ status: "resumed", session_id: childSessionId, id: childRunId }) })
      childFact(childSessionId, "subagent.completed", { childRunId, status: "failed", isError: true, durationMs: 10, totalTokens: 20, toolUses: 1, resultBytes: 1, resultSha256: "sha", resultPreview: "r" })
    }
    for (let index = 0; index < attempts; index += 1) attempt(index)
    const counter = countStateRequests(local)
    const reader = createSessionToolSummaryReader(counter.reader, parent, [subagentsModule])
    await reader.replay()
    counter.take()
    attempt(attempts)
    let card: ToolHistorySummary | undefined
    const members = await entriesVisited(async () => { card = (await reader.replay()).summaries.get("dispatch") }, { lookups: true })
    expect(card).toMatchObject({ status: "error", totalToolCount: attempts + 1, totalTokens: 20 * (attempts + 1), duration: 10 * (attempts + 1) })
    expect(card?.attempts).toHaveLength(attempts + 1)
    const requests = counter.take()
    return { requests: requests.length, facts: factsRead(requests), members }
  }
  expect(await resumeCost(64)).toEqual(await resumeCost(4))
})

test("a disposed reader lets the measures it held be dropped, so a later measure reads the child's history again", async () => {
  // A transcript resident keeps its children's measures while it lives. Once
  // its owner drops it, other parents' children take their place.
  const linkMeasuredChildren = (parent: string, count: number) => {
    for (let index = 0; index < count; index += 1) linkMeasuredChild(parent, index)
  }
  const counter = countStateRequests(asAsyncEventReadSurface(store))
  /** The facts that measured histories read, for the first child of `parent`. */
  const firstChildFacts = (parent: string) => factsRead(counter.take().filter((request) => request.method === "readPage" && request.query?.types?.includes("tool.input.completed")
    && (request.aggregateId ?? request.query?.aggregateIds?.join(",") ?? "") === `session:${parent}-child-0`))
  const measureAll = async (parent: string) => {
    const reader = createSessionToolSummaryReader(counter.reader, parent, [subagentsModule])
    const snapshot = await reader.replay()
    await Promise.all([...snapshot.summaries.values()].map((summary) => snapshot.measure(summary)))
    return reader
  }
  const measureFirst = async (parent: string) => {
    const reader = createSessionToolSummaryReader(counter.reader, parent, [subagentsModule])
    const snapshot = await reader.replay()
    const first = snapshot.summaries.get("toolu_0")
    if (first) await snapshot.measure(first)
    reader.dispose()
  }
  // Together past the bound of held measures, so that without its pins the
  // first parent's oldest children are the ones another parent pushes out.
  linkMeasuredChildren("held", 200)
  linkMeasuredChildren("other", 100)

  const held = await measureAll("held")
  const fullHistory = firstChildFacts("held")
  expect(fullHistory).toBeGreaterThan(0)
  // While its reader lives, another parent's children never push its measures out.
  const other = await measureAll("other")
  counter.take()
  await measureFirst("held")
  expect(firstChildFacts("held")).toBe(0)

  held.dispose()
  other.dispose()
  // Every measure held so far is now unpinned, so as many new ones push them all out.
  linkMeasuredChildren("later", 300)
  const later = await measureAll("later")
  later.dispose()
  counter.take()
  await measureFirst("held")
  expect(firstChildFacts("held")).toBe(fullHistory)
})

test("a v4 partial run keeps its partial status on the summary and owns settlement", async () => {
  created("child")
  append({ type: "subagent.completed", version: 4, actor: "flywheel", payload: {
    childRunId: "child", status: "partial", isError: false, durationMs: 25, totalTokens: 30, toolUses: 2,
    result: "half done", resultBytes: 9, resultSha256: "sha", resultPreview: "half done",
  } })
  const summary = (await summaryReader().replay()).summaries.get("child")
  expect(summary).toMatchObject({ status: "partial", ownsSettlement: true, totalToolCount: 2 })
})

test("a v5 stopped run reads as stopped by a person on the summary, terminal and never resumable", async () => {
  created("child")
  append({ type: "subagent.completed", version: 5, actor: "flywheel", payload: {
    childRunId: "child", status: "stopped", isError: true, durationMs: 25,
    result: "stopped", resultBytes: 7, resultSha256: "sha", resultPreview: "stopped",
  } })
  const summary = (await summaryReader().replay()).summaries.get("child")
  expect(summary).toMatchObject({ status: "stopped", ownsSettlement: true })
})

test("a v4 completed fact, the shape before stopped existed, still reads as written", async () => {
  // Conversion note: v4 rows stay readable as written; remove this shape test
  // together with the v4 reader no earlier than 2027-03-22.
  created("child")
  append({ type: "subagent.completed", version: 4, actor: "flywheel", payload: {
    childRunId: "child", status: "cancelled", isError: false, durationMs: 25,
    result: "canceled", resultBytes: 8, resultSha256: "sha", resultPreview: "canceled",
  } })
  const summary = (await summaryReader().replay()).summaries.get("child")
  expect(summary).toMatchObject({ status: "cancelled", ownsSettlement: true })
})

test("a v3 completed fact, the shape before partial existed, still reads as completed", async () => {
  // Conversion note: v3 rows stay readable as written; remove this shape test
  // together with the v3 reader no earlier than 2027-03-21.
  created("child")
  append({ type: "subagent.completed", version: 3, actor: "flywheel", payload: {
    childRunId: "child", status: "completed", isError: false, durationMs: 25, totalTokens: 30, toolUses: 2,
    result: "done", resultBytes: 4, resultSha256: "sha", resultPreview: "done",
  } })
  const summary = (await summaryReader().replay()).summaries.get("child")
  expect(summary).toMatchObject({ status: "completed", ownsSettlement: true })
})

test("a v2 child-owned run decorates the exact parent tool card with its child session", async () => {
  const childSessionId = "child-session"
  store.append({
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "session.child.linked",
    version: 1,
    actor: "flywheel",
    timestamp: 9,
    payload: { childSessionId, lastUpdated: "2026-01-01T00:00:00.000Z" },
  })
  appendV2Created(childSessionId, sessionId)

  expect((await summaryReader().replay()).summaries.get("toolu_v2")).toMatchObject({
    toolUseId: "toolu_v2",
    linkUri: `flywheel://session/${childSessionId}`,
  })
})

test.each(["toolu_retry", "toolu_first"])("an attempt under %s states the child's work across attempts and counts each run once", async (nextToolUseId) => {
  const childSessionId = "child-session"
  store.append({
    aggregateId: `session:${sessionId}`, sessionId, type: "session.child.linked", version: 1, actor: "flywheel", timestamp: 9,
    payload: { childSessionId, lastUpdated: "2026-01-01T00:00:00.000Z" },
  })
  const settle = (childRunId: string, status: "failed" | "completed", stats: { durationMs: number, totalTokens: number, toolUses: number }) => store.append({
    aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "subagent.completed", version: 4, actor: "flywheel", timestamp: 11,
    payload: { childRunId, status, isError: status === "failed", ...stats, result: "r", resultBytes: 1, resultSha256: "sha", resultPreview: "r" },
  })
  appendV2Created(childSessionId, sessionId, { childRunId: "run-1", toolUseId: "toolu_first" })
  settle("run-1", "failed", { durationMs: 10, totalTokens: 100, toolUses: 2 })
  appendV2Created(childSessionId, sessionId, { childRunId: "run-2", toolUseId: nextToolUseId })

  const running = (await summaryReader().replay()).summaries
  expect(running.get("toolu_first")).toMatchObject({ totalToolCount: 2, totalTokens: 100, duration: 10 })
  expect(running.get(nextToolUseId)).toMatchObject({ status: "active", totalToolCount: 2, totalTokens: 100, duration: 10 })

  settle("run-2", "completed", { durationMs: 20, totalTokens: 50, toolUses: 3 })
  const settled = (await summaryReader().replay()).summaries
  if (nextToolUseId !== "toolu_first") expect(settled.get("toolu_first")).toMatchObject({ totalToolCount: 2, totalTokens: 100, duration: 10 })
  expect(settled.get(nextToolUseId)).toMatchObject({ status: "completed", totalToolCount: 5, totalTokens: 150, duration: 30 })
})

// A parent resumes its child with `process`. The `subagent` shape is the
// previous call shape, which recorded calls keep: remove it after 2027-04-08.
test.each((["process", "subagent"] as const).flatMap((callTool) => [...(["model", "person"] as const).flatMap((origin) =>
  (["stopped", "cancelled", "failed", "partial"] as const).map((status) => [origin, status, callTool] as const),
), ["person-then-model", "stopped", callTool] as const, ["delayed-model", "stopped", callTool] as const, ["delayed-legacy", "stopped", callTool] as const]))("a %s Resume from %s by a %s call preserves settled cards and states the latest attempt's own failure", async (origin, firstStatus, callTool) => {
  const childSessionId = "child-session"
  append({ type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId, lastUpdated: "2026-01-01T00:00:00.000Z" } })
  const entries: MessageEntry[] = []
  const message = (value: MessageEntry["message"]) => entries.push({
    kind: "message", id: `entry-${entries.length}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: value,
  })
  const call = (toolUseId: string, kind: "dispatch" | "resume") => {
    const toolName = kind === "resume" && callTool === "process" ? "process" : "subagent"
    const input = kind === "dispatch" ? { persona: "explorer", description: "Read history" }
      : callTool === "process" ? { action: "resume", process_id: childSessionId } : { kind, session_id: childSessionId }
    append({ type: "tool.input.completed", version: 1, actor: "agent", payload: {
      toolUseId, toolName, input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    } })
    message({ kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: toolName, input }] })
  }
  const acknowledge = (toolUseId: string, childRunId?: string) => {
    // Legacy accepted Resume acknowledgements have no attempt id.
    const text = JSON.stringify({ status: "resumed", session_id: childSessionId, ...(childRunId ? { id: childRunId } : {}) })
    append({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId, outcome: "ok", contentPreview: text } })
    message({ kind: "toolResult", toolUseId, content: [{ type: "text", text }] })
  }
  const settle = (childRunId: string, status: "stopped" | "cancelled" | "partial" | "failed" | "completed", result: string) => store.append({
    aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "subagent.completed", version: 5, actor: "flywheel", timestamp: 10,
    payload: { childRunId, status, isError: status === "failed" || status === "stopped" || status === "cancelled", durationMs: 1, result, resultBytes: result.length, resultSha256: "sha", resultPreview: result },
  })
  const reader = summaryReader()
  const project = async () => {
    const snapshot = await reader.replay()
    const projection = new TreeBlockProjection({ executionCwd: "/scratch", toolSummaries: snapshot.summaries })
    for (const item of entries) projection.add(item)
    return { projection, blocks: projection.snapshot() }
  }
  call("dispatch", "dispatch")
  appendV2Created(childSessionId, sessionId, { childRunId: "run-1", toolUseId: "dispatch" })
  settle("run-1", firstStatus, "First attempt ended")
  message({ kind: "toolResult", toolUseId: "dispatch", isError: firstStatus !== "partial", content: [{ type: "text", text: "First attempt ended" }] })
  let original = { id: "dispatch", status: firstStatus === "failed" ? "error" : firstStatus, ...(firstStatus === "failed" ? { failure: { message: "First attempt ended" } } : {}) }
  expect((await project()).blocks).toMatchObject([original])
  const model = origin !== "person"
  const delayed = origin === "delayed-model" || origin === "delayed-legacy"
  if (model && origin !== "person-then-model") call("resume-1", "resume")
  appendV2Created(childSessionId, sessionId, { childRunId: "run-2", toolUseId: "dispatch" })
  if (origin === "person-then-model") {
    store.append({ aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "subagent.paused", version: 1, actor: "flywheel", timestamp: 10, payload: { childRunId: "run-2", pausedBy: "person" } })
    call("resume-1", "resume")
    store.append({ aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "subagent.resumed", version: 1, actor: "flywheel", timestamp: 10, payload: { childRunId: "run-2", authorizationId: "explicit:dispatch", continuation: 1 } })
    original = { id: "dispatch", status: "interrupted" }
  }
  if (model && !delayed) acknowledge("resume-1")
  settle("run-2", "failed", "Second attempt provider refused")
  let latestFailure = "Second attempt provider refused"
  if (delayed) {
    appendV2Created(childSessionId, sessionId, { childRunId: "operator-run", toolUseId: "dispatch" })
    acknowledge("resume-1", origin === "delayed-model" ? "run-2" : undefined)
    settle("operator-run", "failed", "Operator attempt provider refused")
    latestFailure = "Operator attempt provider refused"
  }
  const failed = await project()
  expect(failed.blocks).toMatchObject(origin === "delayed-legacy"
    ? [{ id: "dispatch", status: "error", failure: { message: latestFailure } }, { id: "resume-1", kind: "tool", status: "completed" }]
    : model
      ? [original, { id: "resume-1", status: "error", failure: { message: latestFailure } }]
      : [{ id: "dispatch", status: "error", failure: { message: latestFailure } }])
  for (const block of failed.blocks) {
    if (block.kind === "agentGroup") expect(failed.projection.toolBlockReader(block).read(undefined)).toMatchObject(block)
  }
  if (model) call("resume-2", "resume")
  appendV2Created(childSessionId, sessionId, { childRunId: "run-3", toolUseId: "dispatch" })
  if (model) acknowledge("resume-2", "run-3")
  settle("run-3", "completed", "Third attempt finished")
  const completed = await project()
  expect(completed.blocks).toMatchObject(origin === "delayed-legacy"
    ? [{ id: "dispatch", status: "error", failure: { message: latestFailure } }, { id: "resume-1", kind: "tool", status: "completed" }, { id: "resume-2", status: "completed" }]
    : model
      ? [original, { id: "resume-1", status: "error", failure: { message: latestFailure } }, { id: "resume-2", status: "completed" }]
      : [{ id: "dispatch", status: "completed" }])
  for (const block of completed.blocks) {
    if (block.kind === "agentGroup") expect(completed.projection.toolBlockReader(block).read(undefined)).toMatchObject(block)
  }
})

test("a child transcript omits its own durable run from nested tool summaries", async () => {
  const childSessionId = "child-session"
  appendV2Created(childSessionId, "parent-session")
  store.append({
    aggregateId: `session:${childSessionId}`,
    sessionId: childSessionId,
    type: "subagent.prompted",
    version: 3,
    actor: "flywheel",
    timestamp: 11,
    payload: {
      childRunId: "run-1",
      prompt: "Read history",
      task: "You are an explorer",
      toolNames: ["read"],
    },
  })

  expect((await summaryReader(childSessionId).replay()).summaries.size).toBe(0)
})

test("one unreadable child timeline degrades only that run across replays", async () => {
  const badSessionId = "child-bad"
  const healthySessionId = "child-healthy"
  const pausedSessionId = "child-paused"
  for (const childSessionId of [badSessionId, healthySessionId, pausedSessionId]) {
    append({
      type: "session.child.linked",
      version: 1,
      actor: "flywheel",
      payload: { childSessionId, lastUpdated: "2026-01-01T00:00:00.000Z" },
    })
  }
  appendV2Created(badSessionId, sessionId, { childRunId: "run-bad", toolUseId: "toolu_bad" })
  store.append({
    aggregateId: `session:${badSessionId}`,
    sessionId: badSessionId,
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    timestamp: 11,
    payload: {
      toolUseId: "child-tool",
      toolName: "read",
      modelRequestId: "request-a",
      input: { path: "src/main.ts" },
      inputBytes: 22,
      inputSha256: "input-hash",
      inputPreview: "{\"path\":\"src/main.ts\"}",
      executionMode: "foreground",
      traceKind: "tool",
      childHasOwnViewport: false,
    },
  })
  store.append({
    aggregateId: `session:${badSessionId}`,
    sessionId: badSessionId,
    type: "tool.execution_output.recorded",
    version: 1,
    actor: "flywheel",
    timestamp: 12,
    payload: { toolUseId: "child-tool", output: "tail", modelRequestId: "request-b" },
  })
  store.append({
    aggregateId: `session:${badSessionId}`,
    sessionId: badSessionId,
    type: "subagent.completed",
    version: 4,
    actor: "flywheel",
    timestamp: 13,
    payload: {
      childRunId: "run-bad",
      status: "completed",
      isError: false,
      durationMs: 25,
      totalTokens: 30,
      toolUses: 7,
      result: "done",
      resultBytes: 4,
      resultSha256: "sha",
      resultPreview: "done",
    },
  })
  appendV2Created(healthySessionId, sessionId, { childRunId: "run-healthy", toolUseId: "toolu_healthy" })
  store.append({
    aggregateId: `session:${healthySessionId}`,
    sessionId: healthySessionId,
    type: "subagent.completed",
    version: 4,
    actor: "flywheel",
    timestamp: 14,
    payload: {
      childRunId: "run-healthy",
      status: "completed",
      isError: false,
      durationMs: 10,
      totalTokens: 20,
      toolUses: 2,
      result: "done",
      resultBytes: 4,
      resultSha256: "sha",
      resultPreview: "done",
    },
  })
  appendV2Created(pausedSessionId, sessionId, { childRunId: "run-paused", toolUseId: "toolu_paused" })
  store.append({
    aggregateId: `session:${pausedSessionId}`,
    sessionId: pausedSessionId,
    type: "subagent.paused",
    version: 1,
    actor: "flywheel",
    timestamp: 15,
    payload: { childRunId: "run-paused", pausedBy: "person" },
  })

  const records: DebugLogRecordInput[] = []
  await Log.init({ forward: (record) => { records.push(record) } })
  try {
    const reader = summaryReader()
    for (const replay of [await reader.replay(), await reader.replay()]) {
      const measure = async (id: string) => {
        const summary = replay.summaries.get(id)
        return summary && await replay.measure(summary)
      }
      expect(await measure("toolu_bad")).toMatchObject({
        status: "completed",
        linkUri: `flywheel://session/${badSessionId}`,
        totalToolCount: 7,
      })
      expect(await measure("toolu_healthy")).toMatchObject({
        status: "completed",
        linkUri: `flywheel://session/${healthySessionId}`,
        totalToolCount: 2,
      })
      expect(await measure("toolu_paused")).toMatchObject({
        status: "paused",
        linkUri: `flywheel://session/${pausedSessionId}`,
      })
    }
    expect(records.filter((record) => record.type === "log.warn")).toEqual([{
      type: "log.warn",
      payload: {
        service: "subagent-tool-summary",
        message: "subagent run history is unreadable; using recorded tool count",
        childRunId: "run-bad",
        failureKind: "tool_execution_timeline",
      },
    }])
  } finally {
    await Log.closeGlobal()
  }
})
