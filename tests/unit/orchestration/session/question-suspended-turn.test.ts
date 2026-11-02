import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { reconcileAgentInput } from "../../../../src/orchestration/session/agent-input-reconciliation";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer";
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import { chatTurnEndOf } from "../../../../src/orchestration/session/conversation/turn-end-record";
import {
  checkpointFinalizedToolResult,
  recoverFinalizedToolResultCheckpoints,
} from "../../../../src/orchestration/session/finalized-tool-result-checkpoint";
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer";
import {
  attachingProcess,
  createSavePointContext,
  disposeSavePointContext,
  userMessage,
  type SavePointTestContext,
} from "./_save-point-fixtures";

// A stop while a turn waits on a person's question suspends the turn rather
// than interrupting it: the question stays the open exchange, and nothing in
// the conversation reads the turn as ended or crashed.

let ctx: SavePointTestContext;
let tree: ConversationTree;

beforeEach(async () => {
  ctx = await createSavePointContext();
  tree = ctx.tree;
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

type ResultLanding = "loop" | "checkpoint";

describe.each<ResultLanding>(["loop", "checkpoint"])("a turn suspended on a question at session end, its other result landing by %s", (resultLands) => {
  const questions = [{ question: "Continue?", choices: [{ kind: "option" as const, choiceId: "yes", label: "Yes" }], multiSelect: false }];

  function recordQuestion(toolUseId: string): void {
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`,
      sessionId: ctx.sessionId,
      type: "agent_input.requested",
      version: 3,
      timestamp: Date.now(),
      actor: "agent",
      payload: { interactionId: toolUseId, conversationId: ctx.conversationId, toolUseId, request: questions },
    });
  }

  function recordAgentToolInput(toolUseId: string, toolName: string): void {
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`,
      sessionId: ctx.sessionId,
      type: "tool.input.completed",
      version: 1,
      timestamp: Date.now(),
      actor: "agent",
      payload: { toolUseId, toolName, input: {}, inputBytes: 2, inputSha256: "input-sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, modelRequestId: "request-1" },
    });
  }

  function reconcile() {
    return reconcileAgentInput({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) });
  }

  /** A turn that asked beside a search whose result finished, stopped by
   *  the session's end while the question waits. The search's result lands
   *  either through the aborted loop's own save point after the stop
   *  suspended the turn, or only as its finalized checkpoint, which the
   *  stop recovers. */
  async function stopWhileAsking(): Promise<void> {
    const writer = createConversationTreeWriter({
      tree,
      recoverFinalizedToolResults: () => recoverFinalizedToolResultCheckpoints({
        conversationId: ctx.conversationId,
        sessionId: ctx.sessionId,
        store: asAsyncEventReadSurface(ctx.store),
        writer: asAsyncEventWriter(ctx.store),
        tree,
      }),
    });
    await writer.commitUserTurn(userMessage("look, then ask"));
    recordAgentToolInput("ask-1", "ask_user");
    recordAgentToolInput("read-1", "search");
    writer.beginTurn();
    await writer.enqueueMessage({ kind: "assistant", content: [
      { type: "tool_use", id: "ask-1", name: "ask_user", input: {} },
      { type: "tool_use", id: "read-1", name: "search", input: {} },
    ] });
    await writer.flushSavePoint(new Set(["ask-1", "read-1"]));
    recordQuestion("ask-1");
    if (resultLands === "loop") {
      writer.suspendPending();
      await writer.enqueueMessage({ kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "found it" }] });
      await writer.flushSavePoint();
      await writer.settleSuspendedTurn();
      return;
    }
    const checkpointWriter = createSessionFactWriter({ sessionId: ctx.sessionId, writer: asAsyncEventWriter(ctx.store) });
    try {
      await checkpointFinalizedToolResult(checkpointWriter, {
        conversationId: ctx.conversationId,
        toolUseId: "read-1",
        toolName: "search",
        budgetExempt: true, turnBudgetChars: 200_000,
        registrationOrdinal: 1,
        content: [{ type: "text", text: "found it" }],
        outcome: "ok",
      });
    } finally {
      checkpointWriter.dispose();
    }

    writer.suspendPending();
    await writer.settleSuspendedTurn();
  }

  it("keeps its question open behind the results its other calls finished, and its answer continues the turn", async () => {
    await stopWhileAsking();

    const reopened = await reconcile();
    expect(reopened.pendingToolUseIds).toEqual(["ask-1"]);
    const text = JSON.stringify(await tree.getBranch());
    expect(text).toContain("found it");
    expect(text).not.toContain("The user ended the session");

    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`,
      sessionId: ctx.sessionId,
      type: "agent_input.answered",
      version: 3,
      timestamp: Date.now(),
      actor: "user",
      payload: { interactionId: "ask-1", answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } } },
    });
    const answered = await reconcile();
    expect(answered.pendingToolUseIds).toEqual([]);
    expect(answered.completedLeaf).toBe(true);
  });

  it("reads as waiting, not crashed, to the next activation and to recovery over its process", async () => {
    await stopWhileAsking();

    expect(chatTurnEndOf(await tree.getBranch())).toBeUndefined();
    const resumed = await attachingProcess(ctx);
    await resumed.recordInterruptedTurn("crash", { ownerDead: true });
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("one more thing"));
    expect(JSON.stringify(await resumed.getBranch())).not.toContain("exited before the turn finished");
  });

  it("records no interruption when the person skips it after the reopen and writes before the turn continues", async () => {
    await stopWhileAsking();
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`,
      sessionId: ctx.sessionId,
      type: "agent_input.cancelled",
      version: 1,
      timestamp: Date.now(),
      actor: "user",
      payload: { interactionId: "ask-1", reason: "user_cancelled" },
    });
    expect((await reconcile()).completedLeaf).toBe(true);

    const resumed = await attachingProcess(ctx);
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("never mind, do this"));
    expect(JSON.stringify(await resumed.getBranch())).not.toContain("exited before the turn finished");
  });
});
