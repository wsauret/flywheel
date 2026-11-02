/**
 * Deterministic large-store generator for the release performance tier.
 *
 * The store is generated at run time as one shared historical workload for
 * both the baseline and candidate binaries. Conversation appends and session
 * creations use the newest shape that both binaries understand. Workflow
 * publication uses a frozen previous-shape serializer; other facts keep the
 * current writer's exact output. The pattern follows
 * tests/fixtures/create-tolerant-reprojection-workspace.ts.
 *
 * Contents: many light chat sessions with lastUpdated values spread across
 * days so the picker's date grouping does real work, plus one giant session
 * whose conversation tree carries thousands of entries, including tool texts
 * above the inline cap so content-addressed references and read-side
 * hydration are exercised. Two parents launch workflows: a small one the
 * runner reconciliation scenario opens, and one whose tool history runs to
 * tens of thousands of facts, so a read of a workflow that replays its whole
 * parent history instead of its launch call delays startup measurably.
 * A scenario that measures learning review adds a skill-load history with
 * appendSkillLoadHistory; the shared fixture does not carry it.
 */
import { mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { canonicalDirectory, FLYWHEEL_DIR_NAME, type ProjectDirectories } from "../../../src/infra/directory-authorities.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type AsyncGuardedEventWriter, type EventStoreAppend } from "../../../src/infra/event-store-types.js"
import { resolveSessionSummaryDbFile } from "../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import type { ConversationMessage } from "../../../src/orchestration/agent-runtime/llm/types.js"
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../src/infra/runtime-fact-mapper.js"
import { parseConversationTreeFact } from "../../../src/orchestration/session/conversation/conversation-facts.js"
import { createConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { refreshSkillLoadStatsSnapshot } from "../../../src/orchestration/modules/learning/skill-load-stats.js"
import { acquireSessionSummaryIndex } from "../../../src/orchestration/session/session-summary-index.js"
import { createSessionFactWriter, prepareSessionFactAppend, type SessionFact } from "../../../src/orchestration/session/session-fact-writer.js"
import { SessionSchema } from "../../../src/orchestration/session/schemas.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { historicalWorkflowPublicationFacts } from "./historical-workflow-publication.js"

/** How much history the fixture writes. Every boundary in the writers is a
 *  fixed batch size, so a smaller workload exercises the same code paths. */
export interface FixtureWorkload {
  readonly lightSessions: number
  /** Entries in the giant transcript, the terminal annotation included. The
   *  transcript stops at the first turn that reaches this count, so the
   *  written count can be one or two entries higher. */
  readonly giantEntries: number
  /** Rich Markdown stresses layout and hit-grid traversal during scrolling. */
  readonly giantContent?: "rich"
  /** Completed bash calls on the history-heavy parent. Each call records an
   *  input and a result fact. */
  readonly historyHeavyToolCalls: number
}

/** The workload every release scenario measures. 15,000 calls record 30,000
 *  facts, so a workflow read that replays its whole parent history instead
 *  of its launch call delays startup measurably. */
export const RELEASE_WORKLOAD: FixtureWorkload = {
  lightSessions: 300,
  giantEntries: 4000,
  historyHeavyToolCalls: 15_000,
}
/** Matches the rich transcript used to expose the OpenTUI 0.6.8 scroll regression. */
export const SCROLL_WORKLOAD: FixtureWorkload = { lightSessions: 5, giantEntries: 3000, historyHeavyToolCalls: 0, giantContent: "rich" }
export const GIANT_SESSION_ID = "fixture-giant"
export const GIANT_SESSION_NAME = "Giant fixture session"
/** The chat that records a skill-load history (appendSkillLoadHistory). */
export const SKILL_HISTORY_SESSION_ID = "fixture-skill-history"
/** Every user turn in the giant transcript starts with this, so any rendered
 *  window of the transcript carries it; scenarios poll for it to know the
 *  transcript is on screen. */
export const GIANT_TURN_MARKER = "Giant turn"
export const LIGHT_SESSION_NAME_PREFIX = "Fixture chat"
export const RECONCILIATION_PARENT_NAME = "Runner reconciliation parent"
export const RECONCILIATION_PARENT_MARKER = "Runner reconciliation fixture"
export const RECONCILIATION_CHILD_COUNT = 8
const HISTORY_HEAVY_CHILD_COUNT = 4
/** Each call appends two facts, its input and its result. */
const TOOL_CALLS_PER_BATCH = 1000

const ENTRIES_PER_BATCH = 100
/** Above TOOL_CONTENT_INLINE_MAX_BYTES (2048), so these results become
 *  content-addressed rows that the binary must hydrate on read. */
const LARGE_TOOL_TEXT_BYTES = 4096

export interface FixtureSummary {
  storeBytes: number
  lightSessions: number
  giantEntries: number
  heavyParentToolFacts: number
}

/** Small deterministic generator; Math.random would make runs incomparable.
 *  The multiply stays exact in a double (2^32 * 1664525 < 2^53), so the modulo
 *  is a faithful 32-bit LCG step. */
function createRandom(seed: number): () => number {
  let state = Math.trunc(seed) % 0x100000000
  return () => {
    state = (state * 1664525 + 1013904223) % 0x100000000
    return state / 0xffffffff
  }
}

function filler(random: () => number, bytes: number): string {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]
  let text = ""
  while (text.length < bytes) text += `${words[Math.floor(random() * words.length)]} `
  return text.slice(0, bytes)
}

function historicalFixtureWriter(store: ReturnType<typeof createSqliteEventStore>): AsyncGuardedEventWriter {
  const writer = asAsyncEventWriter(store)
  const historicalAppend = <T extends EventStoreAppend>(event: T): T => {
    if (event.type === "chat.entries.appended") {
      parseConversationTreeFact({
        type: event.type,
        version: 2,
        actor: event.actor,
        payload: event.payload,
      })
      return { ...event, version: 2 }
    }
    if (event.type === "session.created" && event.version === 5) {
      const session = Schema.decodeUnknownSync(SessionSchema)(event.payload)
      if (!session.launchedFrom) return { ...event, version: 3, payload: session }
      // The catalog wire schema of the published state Worker has no
      // launchedFrom.conversationId, and the Worker stops the project when a
      // launch has one. The current reader treats the key as optional, so the
      // fixture drops it for every session kind.
      const { toolUseId, conversationId: _conversationId, ...launchedFrom } = session.launchedFrom
      return {
        ...event,
        version: 3,
        payload: {
          ...session,
          launchedFrom: { ...launchedFrom, ...(toolUseId !== undefined ? { toolCallId: toolUseId } : {}) },
        },
      }
    }
    return event
  }
  return {
    ...writer,
    append: (event) => writer.append(historicalAppend(event)),
    appendBatch: (events) => writer.appendBatch(events.map(historicalAppend)),
    appendGuarded: (event) => writer.appendGuarded(historicalAppend(event)),
    appendBatchGuarded: (events) => writer.appendBatchGuarded(events.map(historicalAppend)),
  }
}

/** One project's directories under an account home that the scenario
 *  launches the binary with as HOME. */
function fixtureDirectories(projectRoot: string, accountHome: string): ProjectDirectories {
  const canonicalHome = canonicalDirectory(accountHome, "release fixture account home")
  return {
    projectRoot: canonicalDirectory(projectRoot, "release fixture workspace"),
    accountHome: canonicalHome,
    userDataRoot: join(canonicalHome, FLYWHEEL_DIR_NAME),
  }
}

export async function generateFixtureWorkspace(workDir: string, workload: FixtureWorkload = RELEASE_WORKLOAD): Promise<FixtureSummary> {
  mkdirSync(workDir, { recursive: true })
  // The scenario launches the binary with HOME=workDir, so account state and
  // project state share one .flywheel directory, exactly as the e2e harness
  // isolates its runs.
  const directories = fixtureDirectories(workDir, workDir)
  const { projectRoot } = directories
  const preparation = prepareWorkspaceState(directories)
  const store = createSqliteEventStore(preparation.dbFile)
  const writer = historicalFixtureWriter(store)
  const random = createRandom(0x5eed)
  const giant = giantTranscript(workload.giantEntries, workload.giantContent)
  const sessionIds: string[] = []
  // Fixed base keeps every generated timestamp deterministic; only the offset
  // from "now" varies between runs, which the picker's grouping tolerates.
  const baseMs = Date.now()
  try {
    for (let i = 0; i < workload.lightSessions; i++) {
      const name = `${LIGHT_SESSION_NAME_PREFIX} ${String(i).padStart(3, "0")}`
      const sessionId = `fixture-light-${i}`
      // Spread across the past 60 days, a handful per day.
      const updatedMs = baseMs - (i + 1) * 4 * 60 * 60 * 1000
      await writeChatSession(store, writer, projectRoot, sessionId, name, updatedMs, lightMessages(random, i))
      sessionIds.push(sessionId)
    }
    const giantUpdatedMs = baseMs - 60 * 1000
    await writeChatSession(store, writer, projectRoot, GIANT_SESSION_ID, GIANT_SESSION_NAME, giantUpdatedMs, giant)
    sessionIds.push(GIANT_SESSION_ID)
    sessionIds.push(...await writeWorkflowFamily(store, writer, projectRoot, baseMs, {
      id: "fixture-reconciliation",
      parentName: RECONCILIATION_PARENT_NAME,
      parentMarker: RECONCILIATION_PARENT_MARKER,
      childDescription: "Reconciliation child",
      childCount: RECONCILIATION_CHILD_COUNT,
      historyToolCalls: 0,
    }))
    sessionIds.push(...await writeWorkflowFamily(store, writer, projectRoot, baseMs - 2 * 60 * 1000, {
      id: "fixture-history-heavy",
      parentName: "History-heavy parent",
      parentMarker: "History-heavy fixture",
      childDescription: "History-heavy child",
      childCount: HISTORY_HEAVY_CHILD_COUNT,
      historyToolCalls: workload.historyHeavyToolCalls,
    }))
    const summaryIndex = acquireSessionSummaryIndex(
      resolveSessionSummaryDbFile(projectRoot),
      asAsyncEventReadSurface(store),
      { shared: false },
    )
    try {
      const summaries = await summaryIndex.waitForTotals(sessionIds)
      if (summaries.status !== "ready") throw new Error("release fixture session summary index did not become ready")
    } finally {
      await summaryIndex.dispose()
    }
  } finally {
    store.close()
    preparation.generation.release()
  }
  return {
    storeBytes: statSync(preparation.dbFile).size,
    lightSessions: workload.lightSessions,
    giantEntries: giant.length,
    heavyParentToolFacts: 2 * workload.historyHeavyToolCalls + HISTORY_HEAVY_CHILD_COUNT,
  }
}

interface WorkflowFamily {
  /** Prefix of the parent and child session ids. */
  id: string
  parentName: string
  parentMarker: string
  /** Each child is described as this text followed by its index. */
  childDescription: string
  childCount: number
  /** Completed bash calls recorded on the parent before its workflow launches. */
  historyToolCalls: number
}

/** One chat parent that launched workflows, half of them finished. Each child
 *  points back at its launching tool call on the parent. */
async function writeWorkflowFamily(
  store: ReturnType<typeof createSqliteEventStore>,
  writer: AsyncGuardedEventWriter,
  projectRoot: string,
  updatedMs: number,
  family: WorkflowFamily,
): Promise<readonly string[]> {
  const parentSessionId = `${family.id}-parent`
  const sessionIds = [parentSessionId]
  await writeChatSession(
    store,
    writer,
    projectRoot,
    parentSessionId,
    family.parentName,
    updatedMs,
    [
      { kind: "user", content: family.parentMarker },
      { kind: "assistant", content: "The linked workflows are running in the background." },
    ],
  )
  appendToolHistory(store, parentSessionId, Array.from({ length: family.historyToolCalls }, (_, call) => ({
    toolUseId: `${parentSessionId}-history-${call}`,
    toolName: "bash",
    input: { command: `echo history-${call}` },
    output: `history-${call}`,
  })))
  for (let index = 0; index < family.childCount; index++) {
    const childSessionId = `${family.id}-child-${index}`
    sessionIds.push(childSessionId)
    const description = `${family.childDescription} ${index}`
    store.appendBatch(historicalWorkflowPublicationFacts({
      childSessionId,
      parentSessionId,
      description,
      projectRoot,
      timestamp: Date.now(),
      completed: index % 2 === 0,
    }))
  }
  return sessionIds
}

/** One completed foreground tool call recorded beside a conversation. */
interface HistoryToolCall {
  readonly toolUseId: string
  readonly toolName: string
  readonly input: { readonly [key: string]: string }
  readonly output: string
}

/** Records each call as an input fact and its result fact, in batches. The
 *  result keeps startup recovery from settling the call as interrupted. */
function appendToolHistory(store: ReturnType<typeof createSqliteEventStore>, sessionId: string, calls: readonly HistoryToolCall[]): void {
  for (let offset = 0; offset < calls.length; offset += TOOL_CALLS_PER_BATCH) {
    store.appendBatch(calls.slice(offset, offset + TOOL_CALLS_PER_BATCH).flatMap((call) => [
      prepareSessionFactAppend(sessionId, toolInputFact(call.toolUseId, call.toolName, call.input, { mode: "foreground", trace_kind: "tool", child_has_own_viewport: false })),
      prepareSessionFactAppend(sessionId, toolResultFact(call.toolUseId, call.output)),
    ]))
  }
}

/** How many times one skill was loaded. */
export interface SkillLoadCount {
  readonly skillId: string
  readonly loads: number
}

export interface SkillLoadHistory {
  /** Loads recorded first. With no tail, these are the whole history. */
  readonly prefix: readonly SkillLoadCount[]
  /** Loads recorded after the production writer snapshotted the prefix, so
   *  a reader folds the snapshot and then this unseen suffix. */
  readonly unseenTail?: readonly SkillLoadCount[]
}

/** Adds a skill-load history to one project's store: a small chat whose tool
 *  history holds every load as a `skill` call, the shape the runtime records
 *  for a model's skill load. The release fixture leaves this out, so startup
 *  scenarios do not pay for it; a scenario that measures learning-review
 *  preparation adds it. */
export async function appendSkillLoadHistory(projectRoot: string, accountHome: string, history: SkillLoadHistory): Promise<void> {
  const directories = fixtureDirectories(projectRoot, accountHome)
  const preparation = prepareWorkspaceState(directories)
  const store = createSqliteEventStore(preparation.dbFile)
  const writer = historicalFixtureWriter(store)
  try {
    await writeChatSession(store, writer, directories.projectRoot, SKILL_HISTORY_SESSION_ID, "Skill history chat", Date.now() - 3 * 60 * 1000, [
      { kind: "user", content: "Load the skills this project uses." },
      { kind: "assistant", content: "The skills are loaded." },
    ])
    appendToolHistory(store, SKILL_HISTORY_SESSION_ID, skillLoadCalls("prefix", history.prefix))
    if (history.unseenTail === undefined) return
    // The aggregate the production lifecycle maintenance snapshots into.
    const events = asAsyncEventWriter(store)
    const snapshots = createSessionFactWriter({ sessionId: "skill-pruner", writer: events })
    try {
      await refreshSkillLoadStatsSnapshot(asAsyncEventReadSurface(store), snapshots, events)
    } finally {
      snapshots.dispose()
    }
    appendToolHistory(store, SKILL_HISTORY_SESSION_ID, skillLoadCalls("tail", history.unseenTail))
  } finally {
    store.close()
    preparation.generation.release()
  }
}

function skillLoadCalls(part: string, counts: readonly SkillLoadCount[]): HistoryToolCall[] {
  return counts.flatMap(({ skillId, loads }) => Array.from({ length: loads }, (_, index) => ({
    toolUseId: `skill-load-${part}-${skillId}-${index}`,
    toolName: "skill",
    input: { action: "load", skill_id: skillId },
    output: `Loaded ${skillId}.`,
  })))
}

/** The fact the runtime records for one completed tool call, through the
 *  runtime's own mapper, so the fixture holds the current writer's shape. */
function toolInputFact(toolUseId: string, toolName: string, input: { readonly [key: string]: string }, execution: { readonly mode: "foreground" | "background"; readonly trace_kind: "tool" | "subagent"; readonly child_has_own_viewport: boolean }): SessionFact {
  const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.input.completed", {
    tool_use: { id: toolUseId, name: toolName, input, execution, provider_call_id: toolUseId, provider_tool_name: toolName, executable_tool_name: toolName },
    model_request_id: "release-performance-fixture",
  }))
  if (!fact) throw new Error("Release fixture tool input produced no fact")
  return fact
}

function toolResultFact(toolUseId: string, output: string): SessionFact {
  const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.result.recorded", {
    tool_use_id: toolUseId,
    content: [{ type: "text", text: output }],
    outcome: "ok",
  }))
  if (!fact) throw new Error("Release fixture tool result produced no fact")
  return fact
}

async function writeChatSession(
  store: ReturnType<typeof createSqliteEventStore>,
  writer: AsyncEventWriter,
  executionCwd: string,
  sessionId: string,
  name: string,
  updatedMs: number,
  messages: readonly ConversationMessage[],
): Promise<void> {
  const conversationId = `${sessionId}-conversation`
  const lastUpdated = new Date(updatedMs).toISOString()
  store.append({
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "session.created",
    version: 3,
    actor: "flywheel",
    timestamp: updatedMs,
    payload: {
      kind: "chat",
      command: "chat",
      conversationId,
      label: name,
      name,
      createdAt: lastUpdated,
      lastUpdated,
      lifecycleState: "inactive",
      executionCwd,
    },
  })
  const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer })
  try {
    for (let offset = 0; offset < messages.length; offset += ENTRIES_PER_BATCH) {
      const outcome = await tree.appendMessages(messages.slice(offset, offset + ENTRIES_PER_BATCH))
      if (outcome.kind === "notCommitted") {
        throw new Error(`Release fixture failed to append messages for ${sessionId}`, { cause: outcome.cause })
      }
    }
  } finally {
    tree.getStorage().dispose()
  }
}

function lightMessages(random: () => number, index: number): ConversationMessage[] {
  const turns = 2 + Math.floor(random() * 3)
  const messages: ConversationMessage[] = []
  for (let t = 0; t < turns; t++) {
    messages.push({ kind: "user", content: `Question ${t} in fixture chat ${index}: ${filler(random, 80)}` })
    messages.push({ kind: "assistant", content: `Answer ${t} in fixture chat ${index}: ${filler(random, 200)}` })
  }
  return messages
}

/** The giant session's transcript. It draws from its own seed, so a scenario
 *  can rebuild the exact text the store holds and check what a reader of the
 *  store returned. */
export function giantTranscript(entryCount: number = RELEASE_WORKLOAD.giantEntries, content?: "rich"): ConversationMessage[] {
  const random = createRandom(0x61a47)
  const messages: ConversationMessage[] = []
  let turn = 0
  while (messages.length < entryCount - 1) {
    if (turn % 5 === 4) {
      // Every fifth turn is a tool round trip with an oversized result, so the
      // giant transcript exercises tool rendering and content hydration.
      const toolUseId = `giant-tool-${turn}`
      messages.push({ kind: "user", content: `Run step ${turn}: ${filler(random, 60)}` })
      messages.push({
        kind: "assistant",
        content: [
          { type: "text", text: `Running step ${turn}.` },
          { type: "tool_use", id: toolUseId, name: "bash", input: { command: `echo step-${turn}` } },
        ],
      })
      messages.push({ kind: "toolResult", toolUseId, content: [{ type: "text", text: filler(random, LARGE_TOOL_TEXT_BYTES) }] })
    } else {
      messages.push({ kind: "user", content: `Giant turn ${turn}: ${filler(random, 100)}` })
      messages.push({ kind: "assistant", content: content === "rich" ? richAnswer(random, turn) : `Giant answer ${turn}: ${filler(random, 300 + Math.floor(random() * 400))}` })
    }
    turn++
  }
  messages.push({ kind: "system", content: "End of giant fixture transcript." })
  return messages
}

function richAnswer(random: () => number, turn: number): string {
  const parts = [`Giant answer ${turn}: ${filler(random, 120)}`, `## Section ${turn}`,
    `Some **bold** text, some *italic* text, and \`inline code ${turn}\` within a paragraph. ${filler(random, 160)}`]
  const kind = turn % 4
  if (kind === 0 || kind === 2) {
    parts.push("| Column | Value | Status | Notes |", "|---|---:|:---:|---|")
    for (let row = 0; row < 6; row++) parts.push(`| item-${turn}-${row} | ${Math.floor(random() * 10000)} | ${random() > 0.5 ? "ok" : "warn"} | ${filler(random, 30).trim()} |`)
  }
  if (kind === 1 || kind === 2) {
    parts.push("```ts", `export function step${turn}(input: number[]): number {`, "  let total = 0", "  for (const value of input) {",
      "    if (value % 2 === 0) total += value * 2", "    else total -= value", "  }", `  // ${filler(random, 40).trim()}`,
      "  return Math.max(0, total)", "}", "", `const result = step${turn}([1, 2, 3, 4, 5])`, `console.log(\`result: \${result}\`)`, "```")
  }
  if (kind === 3) {
    parts.push(`- first point: ${filler(random, 50)}`, `- second point with \`code\`: ${filler(random, 50)}`, `  - nested point: ${filler(random, 40)}`,
      "1. ordered one", "2. ordered two", "", `> A quoted remark: ${filler(random, 90)}`)
  }
  parts.push(filler(random, 100 + Math.floor(random() * 200)))
  return parts.join("\n\n").replaceAll("\n\n|", "\n|").replaceAll("\n\n  ", "\n  ")
}
