import { buildMutationDiff, type MutationDiff } from "../../../../src/infra/substrate/file-mutations/mutation-diff.js";
import { parseSchema, safeParse } from "../../../helpers/schema-assertions.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { describe, expect, it } from "bun:test";
import type { ContentBlock } from "../../../../src/orchestration/agent-runtime/llm/types";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/substrate/store/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/platform/files/paths";
import { createSqliteEventStore } from "../../../../src/infra/substrate/store/sqlite-event-store";
import {
  CompactionEntrySchema,
  LeafEntrySchema,
  MessageEntrySchema,
  ConversationEntrySchema,
} from "../../../../src/orchestration/session/conversation/conversation-entry-schemas";
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-storage";
import { forkConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-fork";
import { branchBlocks } from "../../../helpers/branch-blocks";
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-context";

const temporaryDirectory = temporaryDirectories();

const baseFields = {
  id: "abc12345",
  parentId: null,
  timestamp: "2026-05-21T00:00:00.000Z",
};

// A round trip through JSON is what the durable boundary actually stores.
const DIFF: MutationDiff = JSON.parse(JSON.stringify(buildMutationDiff([
  { path: "SKILL.md", before: { kind: "text", text: "old\n" }, after: { kind: "text", text: "new\n" } },
])));

describe("ConversationEntrySchema", () => {
  it("requires every entry to carry id, parentId, timestamp, and kind", () => {
    const result = safeParse(ConversationEntrySchema, {
      kind: "message",
      message: { kind: "user", content: "hi" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown entry kinds", () => {
    const result = safeParse(ConversationEntrySchema, {
      ...baseFields,
      kind: "not_a_real_kind",
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed entries even when they have the right kind", () => {
    const result = safeParse(ConversationEntrySchema, {
      ...baseFields,
      kind: "label",
      label: "ok",
      // missing targetId
    });
    expect(result.success).toBe(false);
  });
});

describe("MessageEntrySchema", () => {
  it("accepts toolResult messages with verbatim output parts", () => {
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: {
        kind: "toolResult",
        toolUseId: "toolu_1",
        content: [{ type: "text", text: "interrupted" }],
        isError: true,
        interrupted: true,
      },
    });

    if (entry.message.kind !== "toolResult") throw new Error("expected toolResult message");
    expect(entry.message.toolUseId).toBe("toolu_1");
    expect(entry.message.content).toEqual([{ type: "text", text: "interrupted" }]);
    expect(entry.message.isError).toBe(true);
    expect(entry.message.interrupted).toBe(true);
  });

  it("rejects toolResult messages with empty content", () => {
    const result = safeParse(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "toolResult", toolUseId: "toolu_1", content: [] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects toolResult messages without a toolUseId", () => {
    const result = safeParse(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "toolResult", content: [{ type: "text", text: "out" }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects legacy tool_result content blocks inside user messages", () => {
    const result = safeParse(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: {
        kind: "user",
        content: [{
          type: "tool.result.recorded",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "out" }],
        }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects block content on system and compactionSummary messages", () => {
    for (const kind of ["system", "compactionSummary"]) {
      const result = safeParse(MessageEntrySchema, {
        ...baseFields,
        kind: "message",
        message: { kind, content: [{ type: "text", text: "blocks not allowed" }] },
      });
      expect(result.success).toBe(false);
    }
  });

  it("parses existing assistant messages without incomplete as complete", () => {
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "assistant", content: "done" },
    });
    if (entry.message.kind !== "assistant") throw new Error("expected assistant message");
    expect(entry.message.incomplete).toBeUndefined();
  });

  it("rejects incomplete on non-assistant messages", () => {
    const result = safeParse(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "user", content: "hi", incomplete: true },
    });
    expect(result.success).toBe(false);
  });


  it("rejects incomplete false", () => {
    const result = safeParse(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "assistant", content: [{ type: "text", text: "done" }], incomplete: false },
    });
    expect(result.success).toBe(false);
  });

  it("persists thinking content blocks verbatim for provider replay", () => {
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "assistant", content: [{ type: "thinking", thinking: "chain", signature: "sig-1" }, { type: "text", text: "done" }] },
    });
    expect(entry.message.content).toEqual([{ type: "thinking", thinking: "chain", signature: "sig-1" }, { type: "text", text: "done" }]);
  });

  it("persists reasoning content blocks verbatim for provider replay", () => {
    const block: ContentBlock = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "ciphertext",
      summary: [{ type: "summary_text", text: "plan" }],
    };
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "assistant", content: [block, { type: "text", text: "done" }] },
    });
    expect(entry.message.content).toEqual([block, { type: "text", text: "done" }]);
  });

  it("drops the rawItem that builds before 2026-10-06 stored on a reasoning block", () => {
    const rawItem = JSON.stringify({ type: "reasoning", id: "rs_1", summary: [], content: [], encrypted_content: "ciphertext" });
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "assistant", content: [{ type: "reasoning", id: "rs_1", encrypted_content: "ciphertext", rawItem }] },
    });
    expect(entry.message.content).toEqual([{ type: "reasoning", id: "rs_1", encrypted_content: "ciphertext" }]);
  });

  it("persists assistant serving attribution for the replay gates", () => {
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: {
        kind: "assistant",
        content: "done",
        accessProvider: "github_copilot",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5-mini",
      },
    });
    expect(entry.message).toMatchObject({ accessProvider: "github_copilot", provider: "openai", api: "openai-responses", model: "gpt-5-mini" });
  });

});

describe("review notice mutations on a system message", () => {
  it("keeps every reported write, including a repeated action on one skill", () => {
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: {
        kind: "system",
        content: "Updated skill: `provider-quirks`.",
        reviewMutations: [
          { name: "provider-quirks", action: "patched", reach: "project", mutation: DIFF },
          { name: "provider-quirks", action: "support_file", reach: "project", mutation: DIFF },
        ],
      },
    });

    if (entry.message.kind !== "system" || "contentRepair" in entry.message) throw new Error("expected system notice message");
    expect(entry.message.reviewMutations).toEqual([
      { name: "provider-quirks", action: "patched", reach: "project", mutation: DIFF },
      { name: "provider-quirks", action: "support_file", reach: "project", mutation: DIFF },
    ]);
  });

  it("accepts a write that published no artifact", () => {
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: {
        kind: "system",
        content: "Created skill: `new-package`.",
        reviewMutations: [{ name: "new-package", action: "created", reach: "global" }],
      },
    });

    if (entry.message.kind !== "system" || "contentRepair" in entry.message) throw new Error("expected system notice message");
    expect(entry.message.reviewMutations?.[0]?.mutation).toBeUndefined();
  });

  it("reads a legacy system message with no review mutations", () => {
    const entry = parseSchema(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: { kind: "system", content: "runner restarted" },
    });

    if (entry.message.kind !== "system" || "contentRepair" in entry.message) throw new Error("expected system notice message");
    expect(entry.message.reviewMutations).toBeUndefined();
  });

  it("rejects review mutations on a compactionSummary message", () => {
    const result = safeParse(MessageEntrySchema, {
      ...baseFields,
      kind: "message",
      message: {
        kind: "compactionSummary",
        content: "earlier turns compressed",
        reviewMutations: [{ name: "x", action: "patched", reach: "project" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed review mutation record", () => {
    const malformed = [
      { name: "", action: "patched", reach: "project" },
      { name: "x", action: "patched", reach: "workspace" },
      { name: "x", action: "patched", reach: "project", surface: "skill" },
      { name: "x", action: "patched", reach: "project", mutation: { version: 2, files: [], omissions: [] } },
      { name: "x", action: "patched", reach: "project", mutation: { files: [], omissions: [] } },
    ];

    for (const record of malformed) {
      const result = safeParse(MessageEntrySchema, {
        ...baseFields,
        kind: "message",
        message: { kind: "system", content: "notice", reviewMutations: [record] },
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("CompactionEntrySchema", () => {
  it("captures summary, retainedMessages, sourceLeafId, and token counts", () => {
    const entry = parseSchema(CompactionEntrySchema, {
      ...baseFields,
      kind: "compaction",
      summary: "earlier work",
      retainedMessages: [{ kind: "user", content: "keep this" }],
      sourceLeafId: "deadbeef",
      tokensBefore: 1234,
      tokensAfter: 210,
    });
    if (entry.mode === "reset") throw new Error("expected summary");
    expect(entry.retainedMessages).toEqual([{ kind: "user", content: "keep this" }]);
    expect(entry.sourceLeafId).toBe("deadbeef");
    expect(entry.tokensBefore).toBe(1234);
    expect(entry.tokensAfter).toBe(210);
  });

  it("requires retainedMessages and sourceLeafId", () => {
    const result = safeParse(CompactionEntrySchema, {
      ...baseFields,
      kind: "compaction",
      summary: "earlier work",
      tokensBefore: 1234,
      tokensAfter: 210,
    });
    expect(result.success).toBe(false);
  });

  it("persists only non-empty user text retained messages", () => {
    const invalidMessages = [
      { kind: "assistant", content: "no assistants" },
      { kind: "user", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }] },
      { kind: "toolResult", toolUseId: "toolu_1", content: [{ type: "text", text: "out" }] },
      { kind: "user", content: [{ type: "image", mediaType: "image/png", data: "base64" }] },
      { kind: "user", content: "" },
    ];

    for (const message of invalidMessages) {
      const result = safeParse(CompactionEntrySchema, {
        ...baseFields,
        kind: "compaction",
        summary: "earlier work",
        retainedMessages: [message],
        sourceLeafId: "deadbeef",
        tokensBefore: 1234,
        tokensAfter: 210,
      });
      expect(result.success).toBe(false);
    }
  });

  it("does not accept firstKeptEntryId", () => {
    const result = safeParse(CompactionEntrySchema, {
      ...baseFields,
      kind: "compaction",
      summary: "earlier work",
      retainedMessages: [],
      sourceLeafId: "deadbeef",
      firstKeptEntryId: "old-anchor",
      tokensBefore: 1234,
      tokensAfter: 210,
    });
    expect(result.success).toBe(false);
  });
});

describe("entry shapes that no current build writes", () => {
  it("The current schema refuses a new label entry", () => {
    const result = safeParse(ConversationEntrySchema, {
      ...baseFields,
      kind: "label",
      targetId: "abc00000",
      label: "saved",
    });
    expect(result.success).toBe(false);
  });

  it("A stored history with a label entry, a session_info entry, a summary compaction with retainedMessages, and an entry with followUpRequestSequence recovers with the same parentage, the same transcript blocks, and the same provider context as before", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(temporaryDirectory("historical-entry-shapes-")));
    const conversationId = "historical-conversation";
    const sessionId = "historical-session";
    const at = (second: number) => new Date(Date.UTC(2026, 5, 1, 0, 0, second)).toISOString();
    const append = (type: string, payload: { [key: string]: unknown }) => store.append({
      aggregateId: `conversation:${conversationId}`, sessionId, type, version: 1, actor: "flywheel", timestamp: 1, payload: { conversationId, ...payload },
    });
    append("chat.tree.created", { createdAt: at(0) });
    append("chat.entries.appended", { entries: [
      { kind: "message", id: "ask", parentId: null, timestamp: at(1), message: { kind: "user", content: "first question" } },
      { kind: "message", id: "answer", parentId: "ask", timestamp: at(2), message: { kind: "assistant", content: "first answer" } },
      { kind: "compaction", id: "compact", parentId: "answer", timestamp: at(3), sourceLeafId: "answer", summary: "earlier work", retainedMessages: [{ kind: "user", content: "first question" }], tokensBefore: 100, tokensAfter: 10, details: { reason: "hook" }, fromHook: true },
      { kind: "label", id: "label", parentId: "compact", timestamp: at(4), targetId: "answer", label: "saved" },
      { kind: "session_info", id: "info", parentId: "label", timestamp: at(5), name: "renamed" },
      { kind: "message", id: "follow-up", parentId: "info", timestamp: at(6), message: { kind: "user", content: "follow-up question" }, followUpRequestSequence: 1 },
    ] });
    append("chat.follow_up_turn.completed", { requestSequence: 1 });
    // A repeated marker of an earlier build reads as well: no reader needs it.
    append("chat.follow_up_turn.completed", { requestSequence: 1 });

    const storage = await ConversationTreeStorage.open({ conversationId, sessionId, store: asAsyncEventReadSurface(store) });
    try {
      const branch = await storage.getPathToRoot(await storage.getLeafId());
      expect(branch.map((entry) => [entry.id, entry.parentId])).toEqual([
        ["ask", null], ["answer", "ask"], ["compact", "answer"], ["label", "compact"], ["info", "label"], ["follow-up", "info"],
      ]);
      expect(branch.slice(2, 4)).toEqual([
        { kind: "compaction", id: "compact", parentId: "answer", timestamp: at(3), sourceLeafId: "answer", summary: "earlier work", retainedMessages: [{ kind: "user", content: "first question" }], tokensBefore: 100, tokensAfter: 10 },
        { kind: "session_info", id: "label", parentId: "compact", timestamp: at(4) },
      ]);
      expect(branch.every((entry) => !("followUpRequestSequence" in entry) && !("name" in entry))).toBe(true);

      expect(branchBlocks(branch, { executionCwd: "/workspace" }).map((block) => [block.kind, "id" in block ? block.id : undefined])).toEqual([
        ["userMessage", "ask"], ["text", "answer"], ["system", "compact"], ["userMessage", "follow-up"],
      ]);
      expect(buildSessionContext(branch).messages).toEqual([
        { kind: "user", content: "first question" },
        { kind: "compactionSummary", content: "earlier work" },
        { kind: "user", content: "follow-up question" },
      ]);

      // A fork copies the recovered branch through the current writer.
      const capture = await storage.captureCommittedActiveBranch();
      await forkConversationTree({ source: capture, destinationConversationId: "fork", destinationSessionId: "fork-session", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), now: () => at(9) });
      const copied = await ConversationTreeStorage.open({ conversationId: "fork", sessionId: "fork-session", store: asAsyncEventReadSurface(store) });
      expect((await copied.getPathToRoot(await copied.getLeafId())).map((entry) => entry.kind)).toEqual(["message", "message", "compaction", "session_info", "session_info", "message"]);
      copied.dispose();
    } finally {
      storage.dispose();
      store.close();
    }
  });
});

describe("LeafEntrySchema", () => {
  it("accepts a null target so the tree can move back to the root", () => {
    const entry = parseSchema(LeafEntrySchema, {
      ...baseFields,
      kind: "leaf",
      targetId: null,
    });
    expect(entry.targetId).toBeNull();
  });
});
