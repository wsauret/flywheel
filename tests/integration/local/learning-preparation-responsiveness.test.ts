import { expect, it } from "bun:test";
import { join } from "node:path";
import { temporaryDirectories } from "../../helpers/directories.js";
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types.js";
import { collectSkillLoadStats, refreshSkillLoadStatsSnapshot } from "../../../src/orchestration/modules/learning/skill-load-stats.js";
import { createSessionFactWriter } from "../../../src/orchestration/session/session-fact-writer.js";
import { createLearningReview, digestConversation } from "../../../src/orchestration/modules/learning/learning-review.js";
import type { ConversationMessage } from "../../../src/orchestration/agent-runtime/llm/types.js";
import { createConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle.js";
import { capabilityAccessFor } from "../../../src/orchestration/agent-runtime/tools/types.js";
import { composeRealmModuleSnapshot } from "../../../src/orchestration/modules.js";

const directories = temporaryDirectories();

/** The EXS-4 ceiling: no host timer interval, including the one still open when the work settles, exceeds 50 ms. */
async function withinTimerBudget<T>(work: () => Promise<T>): Promise<T> {
  let previous = performance.now();
  let maximumGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maximumGap = Math.max(maximumGap, now - previous);
    previous = now;
  }, 1);
  try {
    const result = await work();
    maximumGap = Math.max(maximumGap, performance.now() - previous);
    expect(maximumGap).toBeLessThanOrEqual(50);
    return result;
  } finally {
    clearInterval(timer);
  }
}

/** A conversation like the release fixture's giant transcript: block-content
 *  assistant turns, and a tool round trip with a 4 KiB result on every fifth turn. */
function releaseFixtureConversation(messageCount: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (let turn = 0; messages.length < messageCount; turn += 1) {
    if (turn % 5 === 4) {
      const toolUseId = `tool-${turn}`;
      messages.push(
        { kind: "user", content: `Run step ${turn}` },
        {
          kind: "assistant",
          content: [
            { type: "text", text: `Running step ${turn}.` },
            { type: "tool_use", id: toolUseId, name: "bash", input: { command: `echo step-${turn}` } },
          ],
        },
        { kind: "toolResult", toolUseId, content: [{ type: "text", text: "x".repeat(4096) }] },
      );
    } else {
      messages.push(
        { kind: "user", content: `Turn ${turn}: ${"question ".repeat(12)}` },
        { kind: "assistant", content: [{ type: "text", text: `Answer ${turn}: ${"answer ".repeat(60)}` }] },
      );
    }
  }
  return messages;
}

it("prepares a learning review from populated history without starving host timers", async () => {
  const store = createSqliteEventStore(join(directories("learning-preparation-"), "events.sqlite"));
  const reader = asAsyncEventReadSurface(store);
  const events = asAsyncEventWriter(store);
  const writer = createSessionFactWriter({ sessionId: "skill-pruner", writer: events });
  const appendLoads = (start: number, count: number) => {
    store.appendBatch(Array.from({ length: count }, (_, offset) => ({
      aggregateId: "session:review-parent",
      type: "tool.input.completed",
      version: 1,
      timestamp: start + offset + 1,
      actor: "agent",
      sessionId: "review-parent",
      payload: { toolUseId: `load-${start + offset}`, toolName: "skill", input: { action: "load", skill_id: "planning" } },
    })));
  };
  const tree = await createConversationTree({ conversationId: "review-parent-chat", sessionId: "review-parent", store: reader, writer: events });
  try {
    appendLoads(0, 20_000);
    await withinTimerBudget(() => collectSkillLoadStats(reader));
    await refreshSkillLoadStatsSnapshot(reader, writer, events);
    appendLoads(20_000, 2_000);
    expect((await withinTimerBudget(() => collectSkillLoadStats(reader))).get("planning")?.loads).toBe(22_000);

    const history = releaseFixtureConversation(20_000);
    // Named ids, because random eight-character ids can collide inside one large batch.
    const ids = history.map((_, index) => `entry-${index}`);
    for (let offset = 0; offset < history.length; offset += 1_000) {
      const outcome = await tree.appendMessages(history.slice(offset, offset + 1_000), ids.slice(offset, offset + 1_000));
      if (outcome.kind === "notCommitted") throw new Error("release-shaped history was not committed", { cause: outcome.cause });
    }
    const context = await withinTimerBudget(() => tree.buildContext({ allowAssistantTail: true }));
    expect(context.messages).toHaveLength(history.length);
    await withinTimerBudget(() => digestConversation(context.messages));

    const state = {
      moduleIds: ["skills", "learning"] as const,
      capabilities: ["skills", "learning"] as const,
      requireWorkflowConfirmation: true,
      workflowsMode: "off" as const,
      identity: "skills+learning",
    };
    const review = createLearningReview({
      sessionId: "review-parent",
      capabilities: capabilityAccessFor({
        state: () => state,
        admit: async (request) => ({ ok: true, grant: { ...state, operation: request.operation, required: request.required } }),
      }),
      moduleSelection: () => composeRealmModuleSnapshot({ moduleIds: state.moduleIds }),
      config: { memoryIntervalTurns: 0, skillIntervalIterations: 0, notifications: "off" },
      spawnReview: async () => ({ done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }), model: "test-model", recordSystemMessage: async () => {} }),
    });
    await withinTimerBudget(() => review.replay(context.messages));
  } finally {
    tree.getStorage().dispose();
    writer.dispose();
    store.close();
  }
}, 30_000);
