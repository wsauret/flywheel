import { buildMutationDiff, type MutationDiff } from "../../../../src/infra/mutation-diff.js";
import { parseSchema, safeParse } from "../../../helpers/schema-assertions.js";
import { describe, expect, it } from "bun:test";
import type { ContentBlock } from "../../../../src/orchestration/agent-runtime/llm/types";
import {
  CompactionEntrySchema,
  LabelEntrySchema,
  LeafEntrySchema,
  MessageEntrySchema,
  ConversationEntrySchema,
} from "../../../../src/orchestration/session/conversation/conversation-entry-schemas";

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

describe("LabelEntrySchema", () => {
  it("allows label to be undefined to clear a label", () => {
    const entry = parseSchema(LabelEntrySchema, {
      ...baseFields,
      kind: "label",
      targetId: "abc12345",
      label: undefined,
    });
    expect(entry.label).toBeUndefined();
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
