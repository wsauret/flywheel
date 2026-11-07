import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteEventStore } from "../src/infra/sqlite-event-store.js";
import { asAsyncEventReadSurface } from "../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../src/infra/paths.js";
import { tryOpenConversationTree } from "../src/orchestration/session/conversation/conversation-tree-handle.js";
import { anthropicHistoryTarget, convertMessages } from "../src/orchestration/agent-runtime/llm/anthropic-adapter-helpers.js";

const anthropicMeta = { api: "anthropic-messages" as const, provider: "anthropic" as const, model: "claude", timestamp: 1 };

type Request = ReturnType<typeof convertMessages>;
type RequestBlock = Record<string, unknown> & { type: string };
type ToolResultBlock = RequestBlock & { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean };
type RecordedMessage = Record<string, unknown> & { kind: string };

let baseDir: string;
let store: ReturnType<typeof createSqliteEventStore>;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "acceptance-blank-error-history-"));
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
});

afterEach(() => {
  store.close();
  rmSync(baseDir, { recursive: true, force: true });
});

/** Writes the facts the base build records for a session (the current
 *  `chat.entries.appended` version at the base), then opens the recorded
 *  conversation the way a restarted runtime does and builds the next
 *  Anthropic request from its context through `convertMessages`, the
 *  adapter entry point that `prepareAnthropicRequest` calls for every real
 *  Anthropic request. A repair in the fact decoder, the recovery boundary,
 *  `buildSessionContext`, `healConversation`, the converter, or
 *  `convertMessages` itself reaches this request. */
async function requestFromRecordedSession(conversationId: string, recorded: RecordedMessage[]): Promise<Request> {
  const aggregateId = `conversation:${conversationId}`;
  const createdAt = new Date(0).toISOString();
  const entries = recorded.map((message, index) => ({
    id: `${conversationId}-entry-${index}`,
    parentId: index === 0 ? null : `${conversationId}-entry-${index - 1}`,
    timestamp: new Date(index + 1).toISOString(),
    kind: "message",
    message,
  }));
  store.appendBatch([
    { aggregateId, sessionId: conversationId, type: "chat.tree.created", version: 1, actor: "flywheel", timestamp: 1, payload: { conversationId, createdAt } },
    { aggregateId, sessionId: conversationId, type: "chat.entries.appended", version: 3, actor: "flywheel", timestamp: 2, payload: { conversationId, entries } },
  ]);

  const tree = await tryOpenConversationTree({ conversationId, sessionId: conversationId, store: asAsyncEventReadSurface(store) });
  if (!tree) throw new Error("expected the recorded conversation to open");
  return convertMessages({ messages: (await tree.buildContext()).messages, target: anthropicHistoryTarget("anthropic_api", "claude", false) });
}

function blocksOf(request: Request): RequestBlock[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the test reads SDK blocks as plain records
  return request.messages.flatMap((message) => (typeof message.content === "string" ? [] : (message.content as unknown as RequestBlock[])));
}

function toolResultsOf(request: Request): ToolResultBlock[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the type field discriminates the block
  return blocksOf(request).flatMap((block) => (block.type === "tool_result" ? [block as ToolResultBlock] : []));
}

function wireText(result: ToolResultBlock): string {
  const content: unknown = result.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text ?? "" : "")).join("");
}

describe("a recorded session with a blank error tool result", () => {
  test.each(["", "  \n"])("a session that already holds a blank interrupted question sends its next message with a non-empty error result for that question (%j)", async (blank) => {
    const request = await requestFromRecordedSession(`conv-interrupted-${blank.length}`, [
      { kind: "user", content: "Help me pick a name.", origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call_1", name: "ask_user", input: {} }], ...anthropicMeta },
      { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: blank }], isError: true, interrupted: true },
      { kind: "user", content: "Use the second option.", origin: "human" },
    ]);

    const results = toolResultsOf(request);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (!result) throw new Error("expected a tool_result");
    const toolUses = blocksOf(request).filter((block) => block.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(result.tool_use_id).toBe((toolUses[0] as { id: string }).id);
    expect(result.is_error).toBe(true);
    expect(wireText(result).trim().length).toBeGreaterThan(0);
    expect(JSON.stringify(request.messages.at(-1))).toContain("Use the second option.");
  });

  // Engineering care beyond the interrupt: the message names the rule that
  // Anthropic enforces, an error tool_result with empty content. A recorded
  // session that holds such a result for any reason must also send again.
  test("a session that holds any blank error result sends its next message with non-empty error content", async () => {
    const request = await requestFromRecordedSession("conv-blank-error", [
      { kind: "user", content: "Check the file.", origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "blank", name: "read", input: {} }], ...anthropicMeta },
      { kind: "toolResult", toolUseId: "blank", content: [{ type: "text", text: "" }], isError: true },
      { kind: "user", content: "Try again.", origin: "human" },
    ]);

    const results = toolResultsOf(request);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (!result) throw new Error("expected a tool_result");
    expect(result.is_error).toBe(true);
    expect(wireText(result).trim().length).toBeGreaterThan(0);
    expect(JSON.stringify(request.messages.at(-1))).toContain("Try again.");
  });

  // Regression guard: this passes on the base. A fix must not rewrite an
  // error result that already carries text.
  test("a recorded non-blank error result reaches Anthropic as written", async () => {
    const request = await requestFromRecordedSession("conv-written-error", [
      { kind: "user", content: "Read the file.", origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call_2", name: "read", input: {} }], ...anthropicMeta },
      { kind: "toolResult", toolUseId: "call_2", content: [{ type: "text", text: "file not found" }], isError: true },
      { kind: "user", content: "Try another path.", origin: "human" },
    ]);

    const results = toolResultsOf(request);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (!result) throw new Error("expected a tool_result");
    expect(result.is_error).toBe(true);
    expect(wireText(result)).toBe("file not found");
  });

  // Regression guard: this passes on the base. A repair keys on the error
  // flag. It must not turn a blank successful result into an error, because
  // the model then reads a tool that worked as a tool that failed.
  test("a recorded blank successful result is not turned into an error", async () => {
    const request = await requestFromRecordedSession("conv-blank-success", [
      { kind: "user", content: "Create the file.", origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "call_3", name: "write", input: {} }], ...anthropicMeta },
      { kind: "toolResult", toolUseId: "call_3", content: [{ type: "text", text: "" }], isError: false },
      { kind: "user", content: "Now read it back.", origin: "human" },
    ]);

    const results = toolResultsOf(request);
    expect(results).toHaveLength(1);
    const result = results[0];
    if (!result) throw new Error("expected a tool_result");
    const toolUses = blocksOf(request).filter((block) => block.type === "tool_use");
    expect(toolUses).toHaveLength(1);
    expect(result.tool_use_id).toBe((toolUses[0] as { id: string }).id);
    expect(result.is_error === true).toBe(false);
    expect(JSON.stringify(request.messages.at(-1))).toContain("Now read it back.");
  });
});
