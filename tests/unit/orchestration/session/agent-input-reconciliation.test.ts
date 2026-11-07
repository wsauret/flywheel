import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { InvariantViolation } from "../../../../src/infra/invariant.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { answeredAskUserResult } from "../../../../src/orchestration/agent-runtime/tools/ask-user.js"
import { ASK_USER_CANCELLED_RESULT } from "../../../../src/infra/tools/displays/ask-user.js"
import type { AgentInputAnswer, AgentInputAnswers } from "../../../../src/protocol/question-protocol-types.js"
import type { AgentInputDecision } from "../../../../src/orchestration/session/agent-input-facts.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input-projection.js"
import { reconcileAgentInput } from "../../../../src/orchestration/session/agent-input-reconciliation.js"
import { createSavePointContext, disposeSavePointContext, type SavePointTestContext, userMessage } from "./_save-point-fixtures.js"

let ctx: SavePointTestContext

beforeEach(async () => { ctx = await createSavePointContext() })
afterEach(async () => { await disposeSavePointContext(ctx) })

const questions = [{ question: "Continue?", choices: [{ kind: "option" as const, choiceId: "yes", label: "Yes" }], multiSelect: false }]
interface FactPayload {
  [key: string]: unknown
}

/** Append one durable interaction fact at the version the strict registry parses. */
function fact(type: "agent_input.requested" | "agent_input.answered" | "agent_input.cancelled", interactionId: string, payload: FactPayload, timestamp: number): void {
  ctx.store.append({
    aggregateId: `session:${ctx.sessionId}`,
    sessionId: ctx.sessionId,
    type,
    version: type === "agent_input.answered" || type === "agent_input.requested" ? 3 : 1,
    actor: type === "agent_input.requested" ? "agent" : "user",
    timestamp,
    payload: { interactionId, ...payload },
  })
}

/** The answer the dock records for the single option the fixture declares. */
const CONTINUE_ANSWER = { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } } as const

const WORKFLOW_QUESTION = "Launch the Debug workflow?"
const WORKFLOW_QUESTIONS = [{
  question: WORKFLOW_QUESTION,
  choices: [
    { kind: "option" as const, choiceId: "approve", label: "Start the Debug workflow" },
    { kind: "option" as const, choiceId: "inline", label: "Investigate, fix, verify inline" },
    { kind: "option" as const, choiceId: "direct", label: "Fix from current investigation" },
    { kind: "freeform" as const, label: "Other" },
  ],
  multiSelect: false,
}]
const WORKFLOW_DECISION: AgentInputDecision = {
  kind: "workflow_launch",
  source: { kind: "registered", definitionId: "debug" },
  question: WORKFLOW_QUESTION,
  approve: { choiceId: "approve", label: "Start the Debug workflow" },
  reject: { choiceId: "inline", label: "Investigate, fix, verify inline" },
}

function workflowAnswers(answer: AgentInputAnswer): AgentInputAnswers {
  return { [WORKFLOW_QUESTION]: answer }
}

function workflowRequest(toolUseId: string, timestamp = 1, decision: AgentInputDecision = WORKFLOW_DECISION): void {
  fact("agent_input.requested", toolUseId, {
    conversationId: ctx.conversationId,
    toolUseId,
    request: WORKFLOW_QUESTIONS,
    decision,
  }, timestamp)
}

function request(toolUseId: string, conversationId = ctx.conversationId, timestamp = 1): void {
  fact("agent_input.requested", toolUseId, { conversationId, toolUseId, request: questions }, timestamp)
}

function toolInput(toolUseId: string): void {
  ctx.store.append({
    aggregateId: `session:${ctx.sessionId}`,
    sessionId: ctx.sessionId,
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    timestamp: 1,
    payload: {
      toolUseId,
      toolName: "ask_user",
      input: {},
      inputBytes: 2,
      inputSha256: "input-sha",
      inputPreview: "{}",
      executionMode: "foreground",
      traceKind: "tool",
      childHasOwnViewport: false,
      modelRequestId: "request-1",
    },
  })
}

function askBatch(...uses: ReadonlyArray<readonly [id: string, name: string]>): ConversationMessage {
  return { kind: "assistant", content: uses.map(([id, name]) => ({ type: "tool_use" as const, id, name, input: {} })) }
}

function messages(entries: readonly SessionEntry[]) {
  return entries.flatMap((entry) => entry.kind === "message" ? [entry.message] : [])
}

function inputFacts() {
  return ctx.store.read({ aggregateId: `session:${ctx.sessionId}` }).filter((event) => event.type.startsWith("agent_input."))
}

type SessionEntry = Awaited<ReturnType<SavePointTestContext["tree"]["getBranch"]>>[number]

function reconcile() {
  return reconcileAgentInput({
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    store: asAsyncEventReadSurface(ctx.store),
    projectionReader: asAsyncEventReadSurface(ctx.store),
    writer: asAsyncEventWriter(ctx.store),
  })
}

describe("agent input projection", () => {
  test("orphan terminal facts reject with InvariantViolation", async () => {
    fact("agent_input.requested", "unrelated-damage", { request: 5 }, 0)
    fact("agent_input.answered", "orphan", { answers: {} }, 1)
    await expect(loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), ctx.sessionId)).rejects.toThrow(InvariantViolation)
  })

  test("duplicate terminal facts reject with InvariantViolation", async () => {
    fact("agent_input.requested", "unrelated-damage", { request: 5 }, 0)
    request("duplicate")
    fact("agent_input.answered", "duplicate", { answers: CONTINUE_ANSWER }, 2)
    fact("agent_input.cancelled", "duplicate", { reason: "user_cancelled" }, 3)
    await expect(loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), ctx.sessionId)).rejects.toThrow(InvariantViolation)
  })
})

describe("agent input reconciliation", () => {
  test("unreadable answers never become cancellation or replace a committed result", async () => {
    await ctx.tree.appendMessage(askBatch(["bad", "ask_user"], ["committed", "ask_user"], ["good", "ask_user"]))
    await ctx.tree.appendMessage({ kind: "toolResult", toolUseId: "committed", content: [{ type: "text", text: "original result" }] })
    for (const id of ["bad", "committed", "good"]) request(id)
    for (const id of ["bad", "committed", "orphan"]) fact("agent_input.answered", id, { answers: { Q: 5 } }, 2)
    toolInput("good")
    fact("agent_input.answered", "good", { answers: CONTINUE_ANSWER }, 3)
    const before = inputFacts()
    const outcome = await reconcile()
    const results = messages(outcome.entries ?? []).filter((message) => message.kind === "toolResult")
    expect(outcome.pendingToolUseIds).toEqual([])
    expect(outcome.completedLeaf).toBe(true)
    expect(results.filter((message) => message.toolUseId === "committed")).toEqual([
      { kind: "toolResult", toolUseId: "committed", content: [{ type: "text", text: "original result" }] },
    ])
    const badResult = results.find((message) => message.toolUseId === "bad")
    expect(badResult).toMatchObject({ isError: true })
    expect(JSON.stringify(badResult)).toContain("interrupted")
    expect(JSON.stringify(results)).not.toContain(ASK_USER_CANCELLED_RESULT)
    expect(ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] }).map((event) => event.payload.toolUseId)).toEqual(["good"])
    expect(inputFacts()).toEqual(before)
  })

  test("answered recovery appends the canonical result exactly once and reruns idempotently", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-1", "ask_user"]))
    toolInput("ask-1")
    request("ask-1")
    fact("agent_input.answered", "ask-1", { answers: CONTINUE_ANSWER }, 2)

    const first = await reconcile()
    const second = await reconcile()
    const results = messages(second.entries ?? []).filter((message) => message.kind === "toolResult")

    expect(first.completedLeaf).toBe(true)
    expect(second.completedLeaf).toBe(true)
    expect(results).toEqual([{ kind: "toolResult", toolUseId: "ask-1", content: [{ type: "text", text: "User answered:\n- Continue?: Yes" }] }])
    const toolResults = ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] })
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]?.payload).toMatchObject({ toolUseId: "ask-1", outcome: "ok", modelRequestId: "request-1" })
  })

  test("answered recovery reads stored version-2 tool results through the hydration seam", async () => {
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`,
      sessionId: ctx.sessionId,
      type: "tool.result.recorded",
      version: 2,
      actor: "flywheel",
      timestamp: 1,
      payload: { toolUseId: "read-1", outcome: "ok", contentBytes: 4096, contentSha256: "a".repeat(64), contentPreview: "large read" },
    })
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-1", "ask_user"]))
    toolInput("ask-1")
    request("ask-1")
    fact("agent_input.answered", "ask-1", { answers: CONTINUE_ANSWER }, 2)

    const outcome = await reconcile()

    expect(outcome.completedLeaf).toBe(true)
    const toolResults = ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] })
    expect(toolResults.map((event) => event.payload.toolUseId)).toEqual(["read-1", "ask-1"])
  })

  test("derives a settled answer while another question remains pending", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-answered", "ask_user"], ["ask-pending", "ask_user"]))
    toolInput("ask-answered")
    toolInput("ask-pending")
    request("ask-answered")
    request("ask-pending", ctx.conversationId, 2)
    fact("agent_input.answered", "ask-answered", { answers: CONTINUE_ANSWER }, 3)

    const outcome = await reconcile()
    const results = messages(outcome.entries ?? []).filter((message) => message.kind === "toolResult")

    expect(outcome.pendingToolUseIds).toEqual(["ask-pending"])
    expect(results.map((result) => result.kind === "toolResult" ? result.toolUseId : "")).toEqual(["ask-answered"])
    const toolResults = ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] })
    expect(toolResults.map((event) => event.payload.toolUseId)).toEqual(["ask-answered"])
  })

  test.each(["path", "registered"] as const)("approved workflow recovery settles the recorded %s source decision", async (kind) => {
    const decision: AgentInputDecision = kind === "registered" ? WORKFLOW_DECISION : { ...WORKFLOW_DECISION, source: { kind: "path", path: "/scratch/debug.workflow.yaml", definitionSha256: "a".repeat(64) } }
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-approve", "ask_user"]))
    workflowRequest("ask-approve", 1, decision)
    const answers = workflowAnswers({ kind: "choice", selections: [{ choiceId: "approve" }], text: "Start the Debug workflow" })
    fact("agent_input.answered", "ask-approve", { answers }, 2)

    const result = await reconcile()
    const leaf = messages(result.entries ?? []).at(-1)
    const settled = answeredAskUserResult(WORKFLOW_QUESTIONS, answers, decision, "ask-approve")

    expect(settled.outcome).toBe(kind === "registered" ? "cancelled" : "ok")
    if (kind === "registered") {
      expect(settled.content).toContain("The debug workflow is retired. Flywheel no longer launches it.")
      expect(settled.content).not.toContain("Confirmation id")
    } else expect(settled.content).toContain("Confirmation id for this decision: ask-approve")
    expect(leaf).toEqual({ kind: "toolResult", toolUseId: "ask-approve", content: [{ type: "text", text: settled.content }], ...(kind === "registered" ? { isError: true } : {}) })
  })

  test.each(["path", "registered"] as const)("workflow recovery for a %s source denies every non-approval answer without an id", async (kind) => {
    const decision: AgentInputDecision = kind === "registered" ? WORKFLOW_DECISION : { ...WORKFLOW_DECISION, source: { kind: "path", path: "/scratch/debug.workflow.yaml", definitionSha256: "a".repeat(64) } }
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(
      ["ask-inline", "ask_user"],
      ["ask-direct", "ask_user"],
      ["ask-other", "ask_user"],
    ))
    const denials: ReadonlyArray<readonly [string, AgentInputAnswers]> = [
      ["ask-inline", workflowAnswers({ kind: "choice", selections: [{ choiceId: "inline" }], text: "Investigate, fix, verify inline" })],
      ["ask-direct", workflowAnswers({ kind: "choice", selections: [{ choiceId: "direct" }], text: "Fix from current investigation" })],
      ["ask-other", workflowAnswers({ kind: "freeform", text: "Use another route" })],
    ]
    for (const [index, [toolUseId, answers]] of denials.entries()) {
      workflowRequest(toolUseId, index * 2 + 1, decision)
      fact("agent_input.answered", toolUseId, { answers }, index * 2 + 2)
    }

    const result = await reconcile()
    const toolResults = messages(result.entries ?? []).filter((message) => message.kind === "toolResult")

    expect(toolResults).toHaveLength(3)
    for (const toolResult of toolResults) {
      if (toolResult.kind !== "toolResult") continue
      const text = toolResult.content[0]?.type === "text" ? toolResult.content[0].text : ""
      expect(toolResult.isError).toBe(true)
      expect(text).toContain(kind === "registered" ? "The debug workflow is retired." : "did not approve")
      expect(text).not.toContain("Confirmation id")
    }
  })

  // An earlier build asked to launch a workflow by name. Nobody answered it
  // before the upgrade, and no answer can grant that launch now.
  test("an unanswered named workflow approval is withdrawn and settles with the retired workflow", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-launch", "ask_user"]))
    toolInput("ask-launch")
    workflowRequest("ask-launch")

    const outcome = await reconcile()
    const again = await reconcile()

    expect(outcome.protectedPending).toBe(false)
    expect(outcome.pendingToolUseIds).toEqual([])
    expect(outcome.completedLeaf).toBe(true)
    expect((await loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), ctx.sessionId)).get("ask-launch"))
      .toMatchObject({ kind: "withdrawn", reason: "workflow_launch_retired", decision: WORKFLOW_DECISION })
    const text = "The debug workflow is retired. Flywheel no longer launches it."
    expect(messages(again.entries ?? []).filter((message) => message.kind === "toolResult"))
      .toEqual([{ kind: "toolResult", toolUseId: "ask-launch", content: [{ type: "text", text }], isError: true }])
    expect(inputFacts().filter((event) => event.type === "agent_input.withdrawn")).toHaveLength(1)
    expect(ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] }).map((event) => event.payload))
      .toEqual([expect.objectContaining({ toolUseId: "ask-launch", outcome: "cancelled" })])
  })

  test("cancelled recovery emits an error result", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-1", "ask_user"]))
    request("ask-1")
    fact("agent_input.cancelled", "ask-1", { reason: "user_cancelled" }, 2)

    const result = await reconcile()
    const leaf = messages(result.entries ?? []).at(-1)

    expect(leaf).toEqual({ kind: "toolResult", toolUseId: "ask-1", content: [{ type: "text", text: ASK_USER_CANCELLED_RESULT }], isError: true })
  })

  // Version 1 is the withdrawal an earlier build wrote when a planned
  // replacement cut a waiting turn. It still reads as an interrupted ask, not
  // as the retired step question of version 2.
  test("a version-1 runtime withdrawal still reads as an interrupted ask", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-1", "ask_user"]))
    request("ask-1")
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "agent_input.withdrawn", version: 1, actor: "flywheel", timestamp: 2,
      payload: { interactionId: "ask-1", reason: "runtime_interrupted" },
    })

    expect((await loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), ctx.sessionId)).get("ask-1")).toMatchObject({ kind: "withdrawn", reason: "runtime_interrupted" })
    const result = messages((await reconcile()).entries ?? []).find((message) => message.kind === "toolResult" && message.toolUseId === "ask-1")
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain("interrupted")
    expect(JSON.stringify(result)).not.toContain("message_session")
  })

  test("a durable interruption marker after committed answers suppresses resume", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-1", "ask_user"]))
    request("ask-1")
    fact("agent_input.answered", "ask-1", { answers: CONTINUE_ANSWER }, 2)

    // First pass appends the answer results; the leaf is the answer batch, so
    // a crash-shaped branch resumes.
    const resumedReconciliation = await reconcile()
    expect(resumedReconciliation.completedLeaf).toBe(true)

    // The user interrupt appends its displayOnly marker after the answers.
    // The branch no longer looks like a crash, so reactivation must not
    // auto-resume the killed turn.
    await ctx.tree.appendMessage({ kind: "system", content: "Interrupted by user.", displayOnly: true })
    const interrupted = await reconcile()
    expect(interrupted.completedLeaf).toBe(false)

    // The marker persists at the entry level but never re-enters the model
    // context.
    const leaf = (await ctx.tree.getBranch()).at(-1)
    expect(leaf?.kind === "message" && leaf.displayOnly).toBe(true)
    const context = await ctx.tree.buildContext({ allowAssistantTail: true })
    expect(context.messages.some((message) => message.kind === "system" && message.content === "Interrupted by user.")).toBe(false)
  })

  test("parallel batches wait for a pending ask then emit ordered answer and interrupted siblings", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["search-1", "search"], ["ask-1", "ask_user"], ["search-2", "search"]))
    request("ask-1")

    const pending = await reconcile()
    expect(pending.protectedPending).toBe(true)
    expect(messages(pending.entries ?? []).flatMap((message) => message.kind === "toolResult" ? [message.toolUseId] : [])).toEqual(["search-1", "search-2"])

    fact("agent_input.answered", "ask-1", { answers: CONTINUE_ANSWER }, 2)
    const settled = await reconcile()
    const results = messages(settled.entries ?? []).filter((message) => message.kind === "toolResult")
    expect(results.map((message) => message.kind === "toolResult" ? message.toolUseId : "")).toEqual(["search-1", "search-2", "ask-1"])
    expect(results.map((message) => message.kind === "toolResult" ? message.isError === true : false)).toEqual([true, true, false])
  })

  test("wrong conversation ID throws before mutating the tree", async () => {
    await ctx.tree.appendMessage(userMessage("ask"))
    await ctx.tree.appendMessage(askBatch(["ask-1", "ask_user"]))
    request("ask-1", "wrong-conversation")

    await expect(reconcile()).rejects.toThrow(InvariantViolation)
    expect(await ctx.tree.getBranch()).toHaveLength(2)
  })
})

describe("conversation-scoped reconciliation", () => {
  test('scope "conversation" ignores interactions from other conversations instead of throwing', async () => {
    request("ask-here")
    request("ask-elsewhere", "conv-other", 2)
    await ctx.tree.appendMessage(userMessage("start"))
    await ctx.tree.appendMessage(askBatch(["ask-here", "ask_user"]))
    fact("agent_input.answered", "ask-here", { answers: CONTINUE_ANSWER }, 3)

    const outcome = await reconcileAgentInput({
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      interactionScope: "conversation",
    })

    expect(outcome.completedLeaf).toBe(true)
    const tail = messages(outcome.entries ?? []).at(-1)
    expect(tail?.kind).toBe("toolResult")
  })

  test("a pending question reports its toolUseId for tombstone protection", async () => {
    request("ask-pending")
    await ctx.tree.appendMessage(userMessage("start"))
    await ctx.tree.appendMessage(askBatch(["ask-pending", "ask_user"]))

    const outcome = await reconcile()

    expect(outcome.protectedPending).toBe(true)
    expect(outcome.pendingToolUseIds).toEqual(["ask-pending"])
  })
})
