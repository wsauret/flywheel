import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type AsyncEventStateReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { contentEvidence } from "../../../../src/infra/content-evidence"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { parseConversationTreeFact, type ConversationTreeFact } from "../../../../src/orchestration/session/conversation/conversation-facts"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold"
import { addWorkflowChild, setupWorkflowParent, measuredReader, parentTools, reconcileChatLaunchedWorkflowCompletions, recordCompletionEntry, recordTerminalResult, replaceWorkflowState, terminalWorkflowFacts } from "./_child-session-reconciliation-fixtures"
import { recoveredWorkflowRoot } from "../../../helpers/workflow-root-fixtures"
import { parseCommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control"
import { SessionTranscriptProjection } from "../../../../src/orchestration/session/conversation/transcript-projection"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation"
import { recordChildWorkflowStop } from "../../../../src/orchestration/session/child-workflow-result"
import { PERSON_STOP_INSTRUCTION } from "../../../../src/infra/tool-outcome"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { convertWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions"
import { CHILD_RESULTS_NOTICE_SCOPE, routeChildResultNotices } from "../../../../src/orchestration/session/child-reconciliation-fault"

let tmpDir: string
let stores: LocalSqliteEventStore[]

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "child-workflow-reconciliation-"))
  stores = []
})

afterEach(() => {
  for (const store of stores) store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function setup(status: "completed" | "failed" | "paused" = "completed", suffix = "", options: Parameters<typeof setupWorkflowParent>[4] = {}) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
  stores.push(store)
  return setupWorkflowParent(store, tmpDir, status, suffix, options)
}

/** How the completion lists the fixture's one step, which hands off nothing. */
type AppendedEntry = Extract<ConversationTreeFact, { type: "chat.entries.appended" }>["payload"]["entries"][number]

/** Every entry the conversation's appended batches store, in commit order. */
function appendedEntries(store: LocalSqliteEventStore, conversationId: string): AppendedEntry[] {
  return store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] }).flatMap((event): readonly AppendedEntry[] => {
    const fact = parseConversationTreeFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    return fact.type === "chat.entries.appended" ? fact.payload.entries : []
  })
}

const WORK_STEP = "\n\nAgent results, in the order of the workflow:\n\n## work: completed, with no recorded handoff"

describe("child workflow completion reconciliation", () => {
  test("a Stop between prefetched child publications keeps one terminal result per call", async () => {
    const { store, writer, parentSessionId, toolUseId } = await setup("completed")
    await addWorkflowChild(store, tmpDir, parentSessionId, "child-2", "workflow-tool-2", "Second change")
    const reader = asAsyncEventReadSurface(store)
    let notifications = 0
    await reconcileChildSessionCompletions({
      parentSessionId, reader, writer,
      deliverNotification: async () => {
        notifications += 1
        if (notifications === 1) {
          expect(await recordChildWorkflowStop({
            parentSessionId, reader, writer, childSessionId: "child-2",
            toolUseId: "workflow-tool-2", workflowDefinitionId: "workflow", stoppedBy: "person",
          })).toBe(true)
        }
        return true
      },
    })
    const results = store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })
    expect(results.map((fact) => fact.payload.toolUseId)).toEqual([toolUseId, "workflow-tool-2"])
    expect(parentTools(store).map((tool) => tool.resultOutcome)).toEqual(["ok", "stopped"])
    expect(notifications).toBe(2)
  })

  test.each([false, true])("completion during a pending Stop read preserves terminal evidence (correctPriorResult: %s)", async (correctPriorResult) => {
    const { store, writer, parentSessionId, toolUseId } = await setup("completed")
    const reader = asAsyncEventReadSurface(store)
    let completionPublished = false
    const stopReader: AsyncEventStateReadSurface = {
      ...reader,
      async readSlice(query) {
        const slice = await reader.readSlice(query)
        if (query.aggregateId === `session:${parentSessionId}` && query.toolUseIds?.includes(toolUseId) && !completionPublished) {
          completionPublished = true
          await reconcileChildSessionCompletions({ parentSessionId, reader, writer })
        }
        return slice
      },
    }
    expect(await recordChildWorkflowStop({
      parentSessionId, reader: stopReader, writer, childSessionId: "child",
      toolUseId, workflowDefinitionId: "workflow", stoppedBy: "person", correctPriorResult,
    })).toBe(correctPriorResult)
    expect(completionPublished).toBe(true)
    const results = store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })
    expect(results.map((fact) => fact.payload.outcome)).toEqual(["ok"])
    const corrections = store.read({ aggregateId: `session:${parentSessionId}`, types: ["workflow.tool_result.corrected"] })
    expect(corrections).toHaveLength(correctPriorResult ? 1 : 0)
    if (correctPriorResult) expect(corrections[0]?.payload.priorResultEventId).toBe(results[0]?.id)
    expect(parentTools(store).map((tool) => tool.resultOutcome)).toEqual([correctPriorResult ? "stopped" : "ok"])
  })

  test("reconciles a parent whose creation row predates the current session.created version", async () => {
    const { store, writer, parentSessionId, toolUseId } = await setup("completed", "", { historicalParent: true })

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toMatchObject({
      reconciledCount: 1,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.status).toBe("completed")
  })

  test("validates and folds unchanged parent prefixes once for multiple converged children", async () => {
    const { store, writer, parentSessionId, conversationId } = await setup("completed")
    await addWorkflowChild(store, tmpDir, parentSessionId, "child-2", "workflow-tool-2", "Implement the second reviewed change")
    expect((await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).reconciledCount).toBe(2)

    const parentToolFacts = store.read({
      aggregateId: `session:${parentSessionId}`,
      types: ["tool.input.completed", "tool.result.recorded", "workflow.tool_result.corrected", "tool.execution_output.recorded", "tool.result.acknowledged", "tool.validation.failed"],
    }).length
    const conversationFacts = store.read({ aggregateId: `conversation:${conversationId}` }).length
    const measured = measuredReader(store, parentSessionId, conversationId)
    const local = asAsyncEventReadSurface(measured.reader)
    let workflowReads = 0
    let concurrentWorkflowReads = 0
    const projectionReader: AsyncEventStateReadSurface = {
      ...local,
      async readSlice(query) {
        if (!query.aggregateId?.startsWith("workflow:")) return local.readSlice(query)
        workflowReads += 1
        concurrentWorkflowReads = Math.max(concurrentWorkflowReads, workflowReads)
        await Promise.resolve()
        try { return await local.readSlice(query) }
        finally { workflowReads -= 1 }
      },
    }
    const parentSequence = store.aggregateSeq(`session:${parentSessionId}`)
    const conversationSequence = store.aggregateSeq(`conversation:${conversationId}`)

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: measured.reader, projectionReader, writer })).toEqual({
      reconciledCount: 0,
      workflowAggregateReads: 0,
      durableTerminalChildSessionIds: ["child", "child-2"],
    })
    expect(concurrentWorkflowReads).toBe(2)
    // Each session reaches reconciliation through its held aggregate projection.
    // No workspace-wide metadata fold is allowed on this activation path.
    expect(measured.rows).toEqual({
      metadataAggregates: ["session:parent"],
      parentTools: parentToolFacts,
      conversation: conversationFacts,
      contentResolves: 0,
    })
    expect(store.aggregateSeq(`session:${parentSessionId}`)).toBe(parentSequence)
    expect(store.aggregateSeq(`conversation:${conversationId}`)).toBe(conversationSequence)
  })

  test("atomically reconstructs one completed result and hidden system-origin entry, then converges", async () => {
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup("completed")
    const localReader = asAsyncEventReadSurface(store)
    let notificationCellsRead = 0
    let sequenceTokensRead = 0
    const projectionReader: AsyncEventStateReadSurface = {
      ...localReader,
      async readInFlight(sessionId, kind) {
        await Promise.resolve()
        notificationCellsRead += 1
        return localReader.readInFlight(sessionId, kind)
      },
      async aggregateSeq(aggregateId) {
        await Promise.resolve()
        sequenceTokensRead += 1
        return localReader.aggregateSeq(aggregateId)
      },
    }

    const concurrent = await Promise.all([
      reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, projectionReader, writer }),
      reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, projectionReader, writer }),
    ])
    expect(concurrent.map(({ reconciledCount }) => reconciledCount).sort()).toEqual([0, 1])
    expect(concurrent.every(({ durableTerminalChildSessionIds }) => durableTerminalChildSessionIds?.includes("child"))).toBe(true)
    expect(notificationCellsRead).toBeGreaterThan(0)
    expect(sequenceTokensRead).toBeGreaterThan(0)
    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toEqual({
      reconciledCount: 0,
      workflowAggregateReads: 0,
      durableTerminalChildSessionIds: ["child"],
    })

    const expected = `Workflow completed: "Reviewed change" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`
    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)).toMatchObject({
      status: "completed",
      resultOutcome: "ok",
      contentPreview: expected,
    })
    const tree = await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()
    const entry = tree.entriesById[`workflow-completion:child`]
    expect(entry).toMatchObject({
      kind: "message",
      message: { kind: "user", content: expected, origin: "system", replyRequired: true },
    })
    expect(tree.leafId).toBe("workflow-completion:child")
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })).toHaveLength(1)
    expect(appendedEntries(store, conversationId)).toHaveLength(1)
  })

  // The call settles ok in both cases: its result delivers the completion.
  // The card states the run, so a failed run stays failed and resumable.
  test.each([["completed", "completed"], ["failed", "error"]] as const)("reopens one settled runtime-origin %s card with one result and one notification", async (status, cardStatus) => {
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup(status, "-runtime", {
      runtimeOrigin: true,
    })

    expect((await reconcileChatLaunchedWorkflowCompletions({
      parentSessionId,
      reader: store,
      writer,
    })).reconciledCount).toBe(1)
    expect((await reconcileChatLaunchedWorkflowCompletions({
      parentSessionId,
      reader: store,
      writer,
    })).reconciledCount).toBe(0)

    const projection = new SessionTranscriptProjection({
      sessionId: parentSessionId,
      conversationId,
      store: asAsyncEventReadSurface(store),
      executionCwd: tmpDir,
    })
    const history = await projection.read()
    const cards = history
      ? (await Promise.all(Array.from({ length: history.blockCount }, (_, index) => history.readBlock(index))))
        .filter((block) => block.kind === "agentGroup")
      : []
    expect(cards).toEqual([
      expect.objectContaining({
        id: toolUseId,
        containerKind: "workflow",
        label: "Reviewed change",
        status: cardStatus,
        linkUri: "flywheel://workflow/child-runtime",
      }),
    ])
    expect(store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
    const entries = appendedEntries(store, conversationId)
    expect(entries.filter((entry) => entry.id === `workflow-command-runtime`)).toHaveLength(1)
    expect(entries.filter((entry) => entry.id === "workflow-completion:child-runtime")).toHaveLength(1)
    expect(entries.some((entry) => entry.kind === "message" && entry.message.kind === "assistant")).toBe(false)
    expect(entries.some((entry) => entry.kind === "message" && entry.message.kind === "toolResult")).toBe(false)
    await projection.dispose()
  })

  test.each(["completed", "failed"] as const)("carries each step's handoff and its recorded checks into the %s result and entry", async (status) => {
    const refusal = status === "failed" ? 'Workflow control "then" rejected insert_after: max queue length (1)' : undefined
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup(status, "", refusal ? { refusal: true } : {})
    const handoff = {
      summary: "Landed the reviewed change with focused tests.",
      commands_run: [{ toolUseId: "call-1", exitCode: 0, observation: "12 pass, 0 fail", command: "bun test tests/unit/store.test.ts" }],
      decisions: ["Kept the store as the single owner instead of the planned adapter field"],
      contract_result: { directives: [{ id: "d1", status: "deviated", evidence: "tests/unit/store.test.ts covers the owner", reason: "The adapter field would have been a second source of truth", risk: "low" }] },
    }
    const work = loadQueueFromEvents(store.read({ aggregateId: "workflow:child" }))?.attempts[0]
    if (!work) throw new Error("the fixture workflow has no step")
    const evidence = contentEvidence(JSON.stringify(handoff))
    store.append({
      aggregateId: "workflow:child",
      sessionId: "child",
      timestamp: Date.now(),
      type: "handoff.written",
      version: 1,
      actor: "worker",
      payload: { stepId: work.id, stepName: "Work", definitionId: "work", workflowDefinitionId: "workflow", handoffType: "work-handoff", content: handoff, ...evidence },
    })

    expect((await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).reconciledCount).toBe(1)

    const entry = (await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()).entriesById["workflow-completion:child"]
    if (entry?.kind !== "message" || entry.message.kind !== "user") throw new Error("completion entry missing")
    const content = entry.message.content
    if (typeof content !== "string") throw new Error("completion entry content is not text")
    const reason = refusal ? ` Reason: ${refusal}.` : ""
    const count = refusal ? "2/2" : "1/1"
    expect(content.startsWith(`Workflow ${status}: "Reviewed change" (workflow child). ${count} agents finished.${reason} Review the agent results and continue the original request.`)).toBe(true)
    expect(content).toContain([
      refusal ? "## work, iteration 1: completed" : "## work: completed",
      "### Summary\nLanded the reviewed change with focused tests.",
      "### Commands Run\n- `bun test tests/unit/store.test.ts` (exit 0): 12 pass, 0 fail",
      "### Decisions\n- Kept the store as the single owner instead of the planned adapter field",
      `### Contract Result\n\`\`\`json\n${JSON.stringify(handoff.contract_result, null, 2)}\n\`\`\``,
    ].join("\n\n"))
    if (refusal) expect(content).toContain(`## work, iteration 2: skipped (${refusal})`)
    const tool = parentTools(store).find((candidate) => candidate.toolUseId === toolUseId)
    expect(tool).toMatchObject({ status: "completed", resultOutcome: "ok", contentSha256: contentEvidence(content).sha256 })
    expect((await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).reconciledCount).toBe(0)
  })

  test("names a survey's incomplete coverage in the parent's completion result", async () => {
    const survey = [{ id: "a", priority: "required", report: "surveyed" }, { id: "b", priority: "required", report: "inaccessible" }] as const
    const { store, writer, parentSessionId, toolUseId } = await setup("completed", "", { survey })

    await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })

    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.contentPreview).toStartWith(
      "Workflow completed: \"Reviewed change\" (workflow child). 6/6 agents finished. The survey reports coverage required 1 of 2, 1 unsurveyed. Review the agent results",
    )
  })

  test("uses the short summary without copying a long workflow description", async () => {
    const description = `Implement the reviewed change\n\n${"Detailed acceptance criterion. ".repeat(300)}`
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup("completed", "", {
      description,
      taskInput: { summary: "Wake known projects" },
    })

    await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })

    const expected = `Workflow completed: "Wake known projects" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`
    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.contentPreview).toBe(expected)
    expect((await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()).entriesById["workflow-completion:child"]).toMatchObject({
      kind: "message",
      message: { kind: "user", content: expected, origin: "system" },
    })
    expect(expected).not.toContain(description)
  })

  test("uses the historical task_summary when summary is absent", async () => {
    const { store, writer, parentSessionId, toolUseId } = await setup("completed", "", {
      taskInput: { task_summary: "Historical summary" },
    })

    await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })

    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.contentPreview).toBe(
      `Workflow completed: "Historical summary" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`,
    )
  })

  test("uses the workflow definition id when no short summary exists", async () => {
    const { store, writer, parentSessionId, toolUseId } = await setup("completed", "", { taskInput: {} })

    await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })

    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.contentPreview).toBe(
      `Workflow completed: "workflow" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`,
    )
  })

  test("repairs a missing keyed entry without replacing an existing real terminal result", async () => {
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup("completed")
    const expected = `Workflow completed: "Reviewed change" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`
    await recordTerminalResult(store, parentSessionId, toolUseId, expected)

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toEqual({
      reconciledCount: 1,
      workflowAggregateReads: 1,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })).toHaveLength(1)
    expect((await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()).entriesById["workflow-completion:child"]).toBeDefined()
  })

  test("repairs a missing result without replacing an existing keyed entry", async () => {
    const { store, writer, parentSessionId, conversationId } = await setup("completed")
    const expected = `Workflow completed: "Reviewed change" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`
    await recordCompletionEntry(store, writer, parentSessionId, conversationId, "child", expected, {
      replyRequired: true,
    })

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toEqual({
      reconciledCount: 1,
      workflowAggregateReads: 1,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })).toHaveLength(1)
    expect(store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })).toHaveLength(1)
  })

  test("keeps an unchanged completion written before background replies were enforced", async () => {
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup("completed")
    const expected = `Workflow completed: "Reviewed change" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`
    await recordTerminalResult(store, parentSessionId, toolUseId, expected)
    await recordCompletionEntry(store, writer, parentSessionId, conversationId, "child", expected)

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toMatchObject({
      reconciledCount: 0,
      durableTerminalChildSessionIds: ["child"],
    })
    const tree = await createConversationTreeProjection(asAsyncEventReadSurface(store), conversationId).replay()
    expect(tree.entriesById[tree.leafId ?? ""]).toMatchObject({
      kind: "message",
      message: { kind: "user", content: expected, origin: "system" },
    })
  })

  // A build before 2026-10-11 recorded the terminal handoff only. Its
  // result is history, so an unchanged run is not corrected or announced
  // again in the words that list every step.
  test("keeps a result and entry in the terminal-only words of an unchanged run, with no correction and no second completion", async () => {
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup("completed", "", { historicalWorkflow: true })
    const terminalOnly = "Workflow completed: \"Reviewed change\" (session child). 1/1 steps finished. Review the terminal result and continue the original request."
    await recordTerminalResult(store, parentSessionId, toolUseId, terminalOnly)
    await recordCompletionEntry(store, writer, parentSessionId, conversationId, "child", terminalOnly, { replyRequired: true })
    const entriesBefore = store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] }).length
    expect(convertWorkflowAgentSessions(resolveEventStoreDbFile(tmpDir)).converted).toBe(1)

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toEqual({
      reconciledCount: 0,
      workflowAggregateReads: 0,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(store.read({ aggregateId: `session:${parentSessionId}`, types: ["workflow.tool_result.corrected"] })).toHaveLength(0)
    expect(store.read({ aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"] })).toHaveLength(entriesBefore)
    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.contentPreview).toBe(terminalOnly)
  })

  test.each([
    { outcome: "stopped" as const, content: `Workflow stopped: "Reviewed change" (session child). The user stopped it before it finished; it will not resume. ${PERSON_STOP_INSTRUCTION}` },
    { outcome: "error" as const, content: 'Workflow failed to start: "Reviewed change" (session child). Its runtime stopped before the first step. The workflow is paused, and the user can resume it from its session.' },
  ])("delivers held previous $outcome notices and leaves committed ones unchanged", async ({ outcome, content }) => {
    for (const held of [true, false]) {
      const suffix = held ? "-held" : "-committed"
      const f = await setup("paused", suffix)
      const previous = content.replace("(session child)", `(session child${suffix})`)
      const evidence = contentEvidence(previous)
      const facts = createSessionFactWriter({ sessionId: f.parentSessionId, writer: f.writer })
      await facts.record({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: {
        toolUseId: f.toolUseId, outcome, contentBytes: evidence.bytes, contentSha256: evidence.sha256, contentPreview: evidence.preview,
      } })
      facts.dispose()
      if (held) f.store.putInFlight(f.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, `workflow-completion:child${suffix}`, { conversationId: f.conversationId, text: previous })
      else await recordCompletionEntry(f.store, f.writer, f.parentSessionId, f.conversationId, `child${suffix}`, previous, { replyRequired: true })
      const before = f.store.read().at(-1)!.position
      expect((await reconcileChatLaunchedWorkflowCompletions({ parentSessionId: f.parentSessionId, reader: f.store, writer: f.writer })).reconciledCount).toBe(0)
      expect(f.store.read({ afterPosition: before })).toHaveLength(held ? 1 : 0)
      expect(f.store.readInFlight(f.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
      const committed = f.store.currentPosition()
      await reconcileChatLaunchedWorkflowCompletions({ parentSessionId: f.parentSessionId, reader: f.store, writer: f.writer })
      expect(f.store.read({ afterPosition: committed })).toEqual([])
    }
  })

  test("does not correct or announce an unchanged previous-shape run when its rejected continuation gains a skipped result", async () => {
    const { store, writer, parentSessionId, conversationId, toolUseId } = await setup("completed", "", { rejectedContinuation: true })
    const previous = 'Workflow completed: "Reviewed change" (session child). 1/1 steps finished. Review the step results and continue the original request.\n\nStep results, in the order of the workflow:\n\n## work: completed\n\n### Summary\n'
    await recordTerminalResult(store, parentSessionId, toolUseId, previous)
    await recordCompletionEntry(store, writer, parentSessionId, conversationId, "child", previous, { replyRequired: true })
    const before = store.read().at(-1)!.position
    expect((await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).reconciledCount).toBe(0)
    expect(store.read({ afterPosition: before })).toEqual([])
    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.contentPreview).toBe(previous)
  })

  test("resolves failed workflow control normally and replaces an interrupted parent guess", async () => {
    const { store, writer, parentSessionId, toolUseId } = await setup("failed")
    const interrupted = contentEvidence("interrupted")
    const factWriter = createSessionFactWriter({ sessionId: parentSessionId, writer: asAsyncEventWriter(store) })
    await factWriter.record({
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId,
        outcome: "interrupted",
        contentBytes: interrupted.bytes,
        contentSha256: interrupted.sha256,
        contentPreview: interrupted.preview,
      },
    })
    factWriter.dispose()

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toEqual({
      reconciledCount: 1,
      workflowAggregateReads: 1,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(parentTools(store).find((tool) => tool.toolUseId === toolUseId)).toMatchObject({
      status: "completed",
      resultOutcome: "ok",
      contentPreview: `Workflow failed: "Reviewed change" (workflow child). 0/1 agents finished. Review the agent results and continue the original request.${WORK_STEP.replace("completed, with no recorded handoff", "failed")}`,
    })
  })

  test("does not attribute a pre-recovery insertion refusal to the recovered failure", async () => {
    const { store, writer, parentSessionId, description, toolUseId } = await setup("failed", "", { refusal: true })
    const facts = terminalWorkflowFacts(description, "failed")
    const root = facts.find((fact) => fact.type === "workflow.control.initialized")
    if (root?.type !== "workflow.control.initialized") throw new Error("missing root")
    const aggregateSeq = store.aggregateSeq("workflow:child") + 1 + facts.length
    const recovered = recoveredWorkflowRoot(parseCommittedWorkflowControl(root.payload.control), aggregateSeq)
    store.appendBatch(facts.map((fact) => ({
      ...(fact.type === "workflow.control.initialized"
        ? { ...recovered, payload: { ...recovered.payload, control: { ...root.payload.control, aggregateSeq } } }
        : fact),
      aggregateId: "workflow:child", sessionId: "child", timestamp: Date.now(),
    })))
    expect((await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).reconciledCount).toBe(1)
    const content = parentTools(store).find((tool) => tool.toolUseId === toolUseId)?.contentPreview
    expect(content).toStartWith('Workflow failed: "Reviewed change" (workflow child). 0/1 agents finished. Review the agent results and continue the original request.')
    expect(content).not.toContain("max queue length")
  })

  test("protects paused workflows without writing", async () => {
    const paused = await setup("paused")
    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId: paused.parentSessionId, reader: paused.store, writer: paused.writer })).toEqual({
      reconciledCount: 0,
      workflowAggregateReads: 1,
      durableTerminalChildSessionIds: [],
      linkedNonterminalWorkflowToolUseIds: ["workflow-tool"],
    })
    expect(paused.store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })).toHaveLength(0)
  })

  test("accepts a child renamed after launch", async () => {
    const { store, writer, parentSessionId } = await setup("completed")
    const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store })
    await manager.updateLabel("child", { label: "Renamed child", shortLabel: "Renamed" }, "user")

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })).toMatchObject({
      reconciledCount: 1,
      durableTerminalChildSessionIds: ["child"],
    })
  })

  // The correction and the reconciliation read the call's source through the
  // one reader of recorded call input, for the earlier shape and both kinds
  // of the current one. A path call names its file, so only the request pairs it.
  test.each([["the earlier top-level id", { workflow_definition_id: "workflow" }], ["a registered source", { source: { kind: "registered", definition_id: "workflow" } }], ["a path source", { source: { kind: "path", path: "scratch/workflows/review.workflow.yaml" } }]])("corrects a failed workflow result when the same durable child later completes, for a call with %s", async (_form, callSource) => {
    const failed = await setup("failed", "", { callSource })
    await reconcileChatLaunchedWorkflowCompletions({ parentSessionId: failed.parentSessionId, reader: failed.store, writer: failed.writer })
    await replaceWorkflowState(failed.store, "child", failed.description, "completed")

    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId: failed.parentSessionId, reader: failed.store, writer: failed.writer })).toMatchObject({
      reconciledCount: 1,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId: failed.parentSessionId, reader: failed.store, writer: failed.writer })).toMatchObject({
      reconciledCount: 0,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(parentTools(failed.store).find((tool) => tool.toolUseId === failed.toolUseId)).toMatchObject({
      status: "completed",
      resultOutcome: "ok",
      contentPreview: `Workflow completed: "Reviewed change" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`,
    })
    const tree = await createConversationTreeProjection(asAsyncEventReadSurface(failed.store), failed.conversationId).replay()
    const entry = tree.entriesById[tree.leafId ?? ""]
    expect(entry).toMatchObject({
      kind: "message",
      message: {
        kind: "user",
        content: `Workflow completed: "Reviewed change" (workflow child). 1/1 agents finished. Review the agent results and continue the original request.${WORK_STEP}`,
        origin: "system",
      },
    })
  })

  test("keeps old-format base and correction entries when the workflow did not change", async () => {
    const completed = await setup("completed")
    const oldMessage = `Workflow "${completed.description}" completed. 1/1 steps finished.`
    const terminalSeq = replayWorkflowControl(completed.store.read({ aggregateId: "workflow:child" })).aggregateSeq
    await recordTerminalResult(completed.store, completed.parentSessionId, completed.toolUseId, oldMessage)
    await recordCompletionEntry(
      completed.store,
      completed.writer,
      completed.parentSessionId,
      completed.conversationId,
      "child",
      oldMessage,
    )
    await recordCompletionEntry(
      completed.store,
      completed.writer,
      completed.parentSessionId,
      completed.conversationId,
      "child",
      oldMessage,
      { entryId: `workflow-completion:child:${terminalSeq}` },
    )

    expect(await reconcileChatLaunchedWorkflowCompletions({
      parentSessionId: completed.parentSessionId,
      reader: completed.store,
      writer: completed.writer,
    })).toMatchObject({
      reconciledCount: 0,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(parentTools(completed.store).find((tool) => tool.toolUseId === completed.toolUseId)?.contentPreview).toBe(oldMessage)
    expect(completed.store.read({ aggregateId: "session:parent", types: ["workflow.tool_result.corrected"] })).toHaveLength(0)
    expect(completed.store.read({ aggregateId: `conversation:${completed.conversationId}`, types: ["chat.entries.appended"] })).toHaveLength(2)
    expect(await reconcileChatLaunchedWorkflowCompletions({
      parentSessionId: completed.parentSessionId,
      reader: completed.store,
      writer: completed.writer,
    })).toMatchObject({
      reconciledCount: 0,
      durableTerminalChildSessionIds: ["child"],
    })
  })

  test("skips a child whose workflow facts it cannot read and still settles its sibling", async () => {
    const { store, writer, parentSessionId } = await setup("completed")
    await addWorkflowChild(store, tmpDir, parentSessionId, "child-2", "workflow-tool-2", "Implement the second reviewed change")
    store.append({ aggregateId: "workflow:child", sessionId: "child", timestamp: Date.now(), type: "workflow.control.recovered", version: 3, actor: "flywheel", payload: {} })

    // The parent still activates, and the readable child settles.
    const reconciled = await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })
    expect(reconciled).toMatchObject({ reconciledCount: 1, durableTerminalChildSessionIds: ["child-2"] })
  })

  test("retries three parent sequence conflicts and rejects unrelated conflicts", async () => {
    const { store, writer, parentSessionId } = await setup("completed")
    let attempts = 0
    const retrying: AsyncGuardedEventWriter = {
      ...writer,
      appendBatchGuarded: async (events) => {
        attempts += 1
        if (attempts <= 3) return { kind: "conflict", conflict: { aggregateId: "session:parent", expectedSeq: 1, actualSeq: 2 } }
        return writer.appendBatchGuarded(events)
      },
    }
    expect(await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer: retrying })).toEqual({
      reconciledCount: 1,
      workflowAggregateReads: 4,
      durableTerminalChildSessionIds: ["child"],
    })
    expect(attempts).toBe(4)

    const second = await setup("completed", "-other")
    let unrelatedAttempts = 0
    const unrelated: AsyncGuardedEventWriter = {
      ...second.writer,
      appendBatchGuarded: async () => {
        unrelatedAttempts += 1
        return { kind: "conflict", conflict: { aggregateId: "workflow:other", expectedSeq: 1, actualSeq: 2 } }
      },
    }
    await expect(reconcileChatLaunchedWorkflowCompletions({ parentSessionId: second.parentSessionId, reader: second.store, writer: unrelated })).rejects.toThrow("stayed contended")
    expect(unrelatedAttempts).toBe(1)
  })

  test("a failed publication shows on the parent and leaves the child's completion for the next sweep, which clears it", async () => {
    const { store, writer, parentSessionId, description } = await setup("paused")
    const notices: unknown[] = []
    routeChildResultNotices(asAsyncEventReadSurface(store), (sessionId, operation) => { notices.push({ sessionId, ...operation }) })
    const reconcile = (target: AsyncGuardedEventWriter) => reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer: target })
    expect(await reconcile(writer)).toMatchObject({ reconciledCount: 0 })
    await replaceWorkflowState(store, "child", description, "completed")
    await expect(reconcile({ ...writer, appendBatchGuarded: async () => { throw new Error("injected publication failure") } })).rejects.toThrow("injected publication failure")
    await addWorkflowChild(store, tmpDir, parentSessionId, "child-2", "workflow-tool-2", "Implement the second reviewed change")

    expect((await reconcile(writer)).durableTerminalChildSessionIds).toContain("child")
    expect(notices).toEqual([
      { sessionId: parentSessionId, type: "upsert", notice: expect.objectContaining({ scope: CHILD_RESULTS_NOTICE_SCOPE, presentation: "session.child_results_blocked", message: expect.stringContaining("Cause: injected publication failure.") }) },
      { sessionId: parentSessionId, type: "resolve", id: CHILD_RESULTS_NOTICE_SCOPE }])
  })

})
