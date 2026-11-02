import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { reconcileWorkflowAgentInput } from "../../../../src/orchestration/workflow-host/agent-input-recovery.js"
import { createSavePointContext, disposeSavePointContext, type SavePointTestContext, userMessage } from "../session/_save-point-fixtures.js"

let ctx: SavePointTestContext

beforeEach(async () => { ctx = await createSavePointContext() })
afterEach(async () => { await disposeSavePointContext(ctx) })

const QUESTIONS = [{ question: "Continue?", choices: [{ kind: "option" as const, choiceId: "yes", label: "Yes" }], multiSelect: false }]

interface InputFactPayload {
  [key: string]: unknown
}

function inputFact(type: "agent_input.requested" | "agent_input.answered", interactionId: string, payload: InputFactPayload, timestamp: number): void {
  ctx.store.append({
    aggregateId: `session:${ctx.sessionId}`,
    sessionId: ctx.sessionId,
    type,
    version: 3,
    actor: type === "agent_input.requested" ? "agent" : "user",
    timestamp,
    payload: { interactionId, ...payload },
  })
}

describe("reconcileWorkflowAgentInput", () => {
  // Steps no longer ask the person (PI-AGENT-024). A question an older build
  // left open withdraws at resume, and its call result tells the step to
  // message its parent, so the agent continues instead of waiting forever.
  test("withdraws a question an older build left open and tells the step to message its parent", async () => {
    inputFact("agent_input.requested", "ask-1", { conversationId: ctx.conversationId, toolUseId: "ask-1", request: QUESTIONS }, 1)
    await ctx.tree.appendMessage(userMessage("start"))
    await ctx.tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] })

    const run = () => reconcileWorkflowAgentInput({
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      conversationIds: [ctx.conversationId],
    })
    const outcome = await run()
    await run()

    expect(outcome.protectedToolUseIds.size).toBe(0)
    const withdrawn = ctx.store.read({ aggregateId: `session:${ctx.sessionId}` }).filter((event) => event.type === "agent_input.withdrawn")
    expect(withdrawn.map(({ version, payload }) => ({ version, payload }))).toEqual([{ version: 2, payload: { interactionId: "ask-1", reason: "child_question_retired" } }])
    const results = (await ctx.tree.getBranch()).flatMap((entry) => entry.kind === "message" && entry.message.kind === "toolResult" ? [entry.message] : [])
    expect(results).toHaveLength(1)
    expect(results[0]?.toolUseId).toBe("ask-1")
    expect(JSON.stringify(results[0]?.content)).toContain("message_session")
  })

  test("an answered-while-dead question folds exactly once across repeated resumes", async () => {
    inputFact("agent_input.requested", "ask-2", { conversationId: ctx.conversationId, toolUseId: "ask-2", request: QUESTIONS }, 1)
    await ctx.tree.appendMessage(userMessage("start"))
    await ctx.tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "ask-2", name: "ask_user", input: {} }] })
    inputFact("agent_input.answered", "ask-2", { answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } } }, 2)

    const run = () => reconcileWorkflowAgentInput({
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      conversationIds: [ctx.conversationId, ctx.conversationId],
    })
    await run()
    await run()

    const branch = await ctx.tree.getBranch()
    const results = branch.filter((entry) => entry.kind === "message" && entry.message.kind === "toolResult")
    expect(results).toHaveLength(1)
    const cancelled = ctx.store.read({ aggregateId: `session:${ctx.sessionId}` }).filter((event) => event.type === "agent_input.cancelled")
    expect(cancelled).toHaveLength(0)
  })

  test("a missing conversation tree is tolerated", async () => {
    const outcome = await reconcileWorkflowAgentInput({
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      conversationIds: ["conv-missing"],
    })
    expect(outcome.protectedToolUseIds.size).toBe(0)
  })
})
