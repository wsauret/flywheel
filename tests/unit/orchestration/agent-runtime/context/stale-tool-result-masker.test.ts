import { describe, expect, test } from "bun:test";
import {
  createStaleToolResultMasker,
  maskStaleForTurn,
  decideCutoff,
  maskStaleToolResults,
  maskToolResultsById,
} from "../../../../../src/orchestration/agent-runtime/compaction/stale-tool-result-masker";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types";
import { DELIVERY_CONFIRMATION } from "../../../../../src/infra/delivery-confirmation.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js";
import { ConversationTreeStorage } from "../../../../../src/orchestration/session/conversation/conversation-tree-storage.js";
import { readStaleMaskSeed } from "../../../../../src/orchestration/agent-runtime/active-request-context.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { countStateRequests } from "../../../../helpers/state-requests.js";

interface UnknownRecord {
  [key: string]: unknown;
}

const BIG = "x".repeat(500);
const temporaryDirectory = temporaryDirectories();

function toolTurn(
  id: string,
  name: string,
  input: UnknownRecord,
  resultText: string,
  extra?: { isError?: boolean },
): ConversationMessage[] {
  return [
    { kind: "assistant", content: [{ type: "tool_use", id, name, input }] },
    { kind: "toolResult", toolUseId: id, content: [{ type: "text", text: resultText }], ...(extra?.isError ? { isError: true } : {}) },
  ];
}

function conversation(turns: number): ConversationMessage[] {
  const messages: ConversationMessage[] = [{ kind: "user", content: "do the work" }];
  for (let i = 0; i < turns; i += 1) {
    messages.push(...toolTurn(`tu-${i}`, "bash", { command: `echo turn ${i}` }, `${BIG} turn ${i}`));
  }
  messages.push({ kind: "user", content: "keep going" });
  return messages;
}

describe("decideCutoff (static, frozen between zone advances)", () => {
  test("below all thresholds: no cutoff", () => {
    const decision = decideCutoff(100, 0.29, { previousCutoff: 0, zoneEntered: -1 });
    expect(decision.cutoffIndex).toBe(0);
    expect(decision.zoneAdvanced).toBe(false);
  });

  test("entering a zone freezes the cutoff at entry-length coverage", () => {
    const entered = decideCutoff(100, 0.31, { previousCutoff: 0, zoneEntered: -1 });
    expect(entered.zoneAdvanced).toBe(true);
    expect(entered.cutoffIndex).toBe(60);

    // Same zone, more messages: cutoff must NOT drift.
    const later = decideCutoff(180, 0.35, { previousCutoff: 60, zoneEntered: 0 });
    expect(later.zoneAdvanced).toBe(false);
    expect(later.cutoffIndex).toBe(60);
  });

  test("usage dropping never retreats the cutoff", () => {
    const decision = decideCutoff(150, 0.1, { previousCutoff: 60, zoneEntered: 0 });
    expect(decision.cutoffIndex).toBe(60);
  });

  test("a higher zone advances the cutoff once", () => {
    const decision = decideCutoff(200, 0.46, { previousCutoff: 60, zoneEntered: 0 });
    expect(decision.zoneAdvanced).toBe(true);
    expect(decision.cutoffIndex).toBe(160);
  });

  test("stale cutoff is clamped to the current message count", () => {
    const decision = decideCutoff(10, 0.1, { previousCutoff: 60, zoneEntered: 0 });
    expect(decision.cutoffIndex).toBe(10);
  });
});

describe("maskStaleToolResults", () => {
  test("masks eligible tool results before the cutoff with a recover handle", () => {
    const messages = conversation(5);
    const result = maskStaleToolResults(messages, messages.length);
    expect(result).not.toBeNull();
    expect(result!.masksApplied).toBe(5);
    expect(result!.bytesSaved).toBeGreaterThan(0);
    const masked = result!.messages[2];
    expect(masked).toEqual({
      kind: "toolResult",
      toolUseId: "tu-0",
      content: [{ type: "text", text: expect.stringContaining("[stale-masked bash] command=echo turn 0") }],
    });
  });

  test("never mutates the input messages", () => {
    const messages = conversation(3);
    const snapshot = structuredClone(messages);
    maskStaleToolResults(messages, messages.length);
    expect(messages).toEqual(snapshot);
  });

  test("placeholder bytes are identical across passes (cache-prefix invariant)", () => {
    const messages = conversation(4);
    const first = maskStaleToolResults(messages, 6);
    const second = maskStaleToolResults(messages, 6);
    expect(first!.messages).toEqual(second!.messages);
  });

  test("messages at or after the cutoff are untouched", () => {
    const messages = conversation(4);
    const result = maskStaleToolResults(messages, 3);
    expect(result!.maskedToolUseIds).toEqual(["tu-0"]);
    expect(result!.messages.slice(3)).toEqual(messages.slice(3));
  });

  test("reference reads, loaded skill instructions, and the person's answers are never masked", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "q" },
      ...toolTurn("tu-ref", "read", { path: "/repo/AGENTS.md" }, BIG),
      ...toolTurn("tu-arch", "read", { path: "docs/architecture-intent/context.md" }, BIG),
      ...toolTurn("tu-intent", "read", { path: "docs/product-intent/interaction.md" }, BIG),
      ...toolTurn("tu-guide", "read", { path: "docs/elegance.md" }, BIG),
      ...toolTurn("tu-terms", "read", { path: "docs/terminology.md" }, BIG),
      ...toolTurn("tu-skill", "skill", { action: "load", skill_id: "implementation" }, BIG),
      ...toolTurn("tu-answer", "ask_user", { question: "Which option?" }, BIG),
      ...toolTurn("tu-resource", "skill", { action: "resource", skill_id: "implementation", path: "references/a.md" }, BIG),
      ...toolTurn("tu-src", "read", { path: "src/index.ts" }, BIG),
    ];
    const result = maskStaleToolResults(messages, messages.length);
    expect(result!.maskedToolUseIds).toEqual(["tu-resource", "tu-src"]);
    const placeholder = result!.messages[18];
    expect(placeholder?.kind === "toolResult" && placeholder.content[0]?.type === "text" ? placeholder.content[0].text : "")
      .toContain("path=src/index.ts");
  });

  test("a delivery confirmation survives masking after the placeholder", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "q" },
      { kind: "assistant", content: [{ type: "text", text: "visible reply" }, { type: "tool_use", id: "tu-receipt", name: "bash", input: { command: "work" } }] },
      { kind: "toolResult", toolUseId: "tu-receipt", content: [{ type: "text", text: BIG }, { type: "text", text: DELIVERY_CONFIRMATION }] },
      ...toolTurn("tu-plain", "bash", { command: "more" }, BIG),
      { kind: "user", content: "keep going" },
    ];
    const result = maskStaleToolResults(messages, messages.length);
    expect(result!.maskedToolUseIds).toEqual(["tu-receipt", "tu-plain"]);
    const masked = result!.messages[2];
    expect(masked).toEqual({
      kind: "toolResult",
      toolUseId: "tu-receipt",
      content: [
        { type: "text", text: expect.stringContaining("[stale-masked bash]") },
        { type: "text", text: DELIVERY_CONFIRMATION },
      ],
    });
  });

  test("small results, errors, and orphan results are not masked", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "q" },
      ...toolTurn("tu-small", "bash", { command: "true" }, "ok"),
      ...toolTurn("tu-err", "bash", { command: "boom" }, BIG, { isError: true }),
      { kind: "toolResult", toolUseId: "tu-orphan", content: [{ type: "text", text: BIG }] },
    ];
    expect(maskStaleToolResults(messages, messages.length)).toBeNull();
  });

  test("image-bearing tool results are masked with the image count", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "q" },
      { kind: "assistant", content: [{ type: "tool_use", id: "tu-img", name: "read", input: { path: "shot.png" } }] },
      { kind: "toolResult", toolUseId: "tu-img", content: [{ type: "image", mediaType: "image/png", data: "a".repeat(4000) }] },
    ];
    const result = maskStaleToolResults(messages, messages.length);
    expect(result!.masksApplied).toBe(1);
    const masked = result!.messages[2];
    expect(masked?.kind === "toolResult" && masked.content[0]?.type === "text" ? masked.content[0].text : "")
      .toContain("1 images");
  });
});

describe("maskToolResultsById (audit reconstruction parity)", () => {
  test("replaying the recorded id set reproduces the masked messages byte-for-byte", () => {
    const messages = conversation(6);
    const live = maskStaleToolResults(messages, 9);
    const replayed = maskToolResultsById(messages, live!.maskedToolUseIds);
    expect(replayed).toEqual(live!.messages);
  });

  test("a recorded skill load or ask_user id still replays its original placeholder", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "q" },
      ...toolTurn("tu-skill", "skill", { action: "load", skill_id: "implementation" }, BIG),
      ...toolTurn("tu-answer", "ask_user", { question: "Which option?" }, BIG),
    ];
    const replayed = maskToolResultsById(messages, ["tu-skill", "tu-answer"]);
    const texts = replayed.flatMap((message) => message.kind === "toolResult" && message.content[0]?.type === "text" ? [message.content[0].text] : []);
    expect(texts).toEqual([
      "[stale-masked skill] (1 lines, 500B); result masked as stale, re-run the tool if needed",
      "[stale-masked ask_user] (1 lines, 500B); result masked as stale, re-run the tool if needed",
    ]);
  });

  test("an empty id set is a copy of the input", () => {
    const messages = conversation(2);
    expect(maskToolResultsById(messages, [])).toEqual(messages);
  });
});

describe("createStaleToolResultMasker (per-conversation state)", () => {
  test("startup restores a durable decision but ignores it after a compaction even when history grows past its old length", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(temporaryDirectory("mask-restart-")));
    try {
      const reader = asAsyncEventReadSurface(store);
      const tree = await ConversationTreeStorage.create({
        store: reader, writer: asAsyncEventWriter(store), sessionId: "session-mask", conversationId: "conversation-mask",
      });
      const timestamp = new Date().toISOString();
      await tree.appendEntries([{
        kind: "message", id: "before", parentId: null, timestamp,
        message: { kind: "user", content: "original" },
      }]);
      const recorded = { cutoffIndex: 8, masksApplied: 3, bytesSaved: 900, maskedToolUseIds: ["tu-0"], maskedToolUseInputIds: [] };
      store.append({
        aggregateId: "session:session-mask", sessionId: "session-mask", type: "prompt.assembled", version: 5,
        actor: "flywheel", timestamp: Date.now(),
        payload: {
          requestId: "request-mask", identity: { providerSessionKey: "provider-mask", conversationId: "conversation-mask" },
          turn: 1, promptKind: "chat", systemPromptHash: "a".repeat(64), toolSurfaceHash: "b".repeat(64),
          promptSha256: "c".repeat(64), messageCount: 22, estimatedContextTokens: 400, attemptStaticTokens: 100,
          contextWindow: 1000, treeLeafEntryId: "before", staleMasking: recorded,
        },
      });
      // The loop reads the tree that its storage holds and folds no second copy of the conversation.
      const counter = countStateRequests(reader);
      const input = { reader: counter.reader, tree: () => tree.getState(), sessionId: "session-mask", conversationId: "conversation-mask", messageCount: 24 };
      const seed = await readStaleMaskSeed(input);
      expect(seed).toEqual(recorded);
      expect(counter.take().map(({ aggregateId, query }) => aggregateId ?? query?.aggregateId)).toEqual(["session:session-mask"]);
      expect(createStaleToolResultMasker(seed).mask(conversation(10), 0.5)!.cutoffIndex).toBe(8);
      await tree.appendEntries([
        { kind: "compaction", mode: "reset", id: "reset", parentId: "before", sourceLeafId: "before", timestamp, tokensBefore: 400, tokensAfter: 1 },
        { kind: "message", id: "after", parentId: "reset", timestamp, message: { kind: "user", content: "fresh" } },
      ]);
      expect(await readStaleMaskSeed(input)).toBeUndefined();
      tree.dispose();
    } finally {
      store.close();
    }
  });

  test("a recorded decision preserves the replacement request prefix despite history growth and estimated pressure", () => {
    const messages = conversation(10);
    const original = createStaleToolResultMasker();
    original.mask(messages, 0.32);
    messages.push(...toolTurn("late", "bash", { command: "late" }, BIG));
    const recorded = maskStaleForTurn({ masker: original, messages, estimatedContextTokens: 40, contextLimit: 100 }).staleMasking!;
    const expected = original.mask(messages, 0.4)!;
    const restored = createStaleToolResultMasker(recorded);
    restored.mask(messages, 0);
    expect(restored.mask(messages, 0.5)!.messages).toEqual(expected.messages);
    expect(createStaleToolResultMasker().mask(messages, 0.5)!.messages).not.toEqual(expected.messages);
    expect(restored.mask(messages, 0.5)!.cutoffIndex).toBe(Math.floor(messages.length * 0.8));
  });

  test.each([8, 20])("an old decision without a zone uses the first request pressure without changing cutoff %s", (cutoffIndex) => {
    const messages = conversation(10);
    const restored = createStaleToolResultMasker({ cutoffIndex });
    restored.mask(messages, 0);
    const first = restored.mask(messages, 0.5)!;
    expect(first.cutoffIndex).toBe(cutoffIndex);
    expect(first.zone).toBe(1);
    messages.push(...toolTurn("late", "bash", { command: "late" }, BIG));
    expect(restored.mask(messages, 0.5)!.cutoffIndex).toBe(cutoffIndex);
    const advanced = restored.mask(messages, 0.65)!;
    expect(advanced.cutoffIndex).toBeGreaterThanOrEqual(cutoffIndex);
    expect(advanced.zone).toBe(2);
  });

  test("cutoff freezes across turns within a zone and advances on the next zone", () => {
    const masker = createStaleToolResultMasker();
    const messages = conversation(10); // 22 messages

    const first = masker.mask(messages, 0.32);
    expect(first!.cutoffIndex).toBe(Math.floor(messages.length * 0.6));

    // Conversation grows in place; usage stays in zone 0: cutoff frozen.
    messages.push(...toolTurn("tu-late", "bash", { command: "late" }, BIG));
    const second = masker.mask(messages, 0.4);
    expect(second!.cutoffIndex).toBe(first!.cutoffIndex);
    expect(second!.messages[2]).toBe(first!.messages[2]);
    expect(second).toMatchObject(maskStaleToolResults(messages, first!.cutoffIndex)!);
    expect(first!.messages).toHaveLength(22);
    expect(second!.messages).toHaveLength(24);

    // Zone 1 entered: cutoff advances against the current length.
    const third = masker.mask(messages, 0.5);
    expect(third!.cutoffIndex).toBe(Math.floor(messages.length * 0.8));
  });

  test("below all zones nothing is masked", () => {
    const masker = createStaleToolResultMasker();
    expect(masker.mask(conversation(5), 0.1)).toBeNull();
  });

  test("a history rewrite (new array identity) resets the cutoff state", () => {
    const masker = createStaleToolResultMasker();
    const before = conversation(10);
    expect(masker.mask(before, 0.65)!.cutoffIndex).toBe(Math.floor(before.length * 0.95));

    // Compaction replaced the array; usage fell back below every zone.
    const after = conversation(2);
    expect(masker.mask(after, 0.1)).toBeNull();
  });
});

describe("tool-use input masking (mutation payloads)", () => {
  function writeTurn(id: string, path: string): ConversationMessage[] {
    return toolTurn(id, "write", { path, content: BIG }, `wrote ${path}`);
  }

  test("a stale write payload masks while its live sibling stays intact", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "write files" },
      ...writeTurn("w-1", "src/a.ts"),
      ...writeTurn("w-2", "src/b.ts"),
    ];
    const result = maskStaleToolResults(messages, 3);
    expect(result).not.toBeNull();
    expect(result!.maskedToolUseInputIds).toEqual(["w-1"]);

    const staleAssistant = result!.messages[1];
    if (staleAssistant?.kind !== "assistant" || !Array.isArray(staleAssistant.content)) throw new Error("expected assistant");
    const staleBlock = staleAssistant.content[0];
    if (staleBlock?.type !== "tool_use") throw new Error("expected tool_use");
    expect(staleBlock.input.content).toContain("[stale-masked write.content]");
    // The recover handle survives: the path is untouched.
    expect(staleBlock.input.path).toBe("src/a.ts");

    const liveAssistant = result!.messages[3];
    if (liveAssistant?.kind !== "assistant" || !Array.isArray(liveAssistant.content)) throw new Error("expected assistant");
    const liveBlock = liveAssistant.content[0];
    if (liveBlock?.type !== "tool_use") throw new Error("expected tool_use");
    expect(liveBlock.input.content).toBe(BIG);
  });

  test("edit payloads of every input shape mask and reconstruct while small and reference writes stay intact", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "edit files" },
      ...toolTurn("e-1", "edit", { path: "src/a.ts", old_string: BIG, new_string: BIG }, "edited"),
      ...toolTurn("e-2", "edit", { path: "src/b.ts", edits: [{ old_string: "small", new_string: BIG }, { old_string: BIG, new_string: "small" }] }, "edited"),
      ...toolTurn("e-3", "edit", { path: "src/b.ts", edits: JSON.stringify([{ old_string: "small", new_string: BIG }, { old_string: BIG, new_string: "small" }]) }, "edited"),
      ...toolTurn("e-4", "edit", { path: "src/b.ts", edits: [{ old_string: "small", new_string: BIG }, { old_string: BIG, new_string: "small" }].map((entry) => JSON.stringify(entry)) }, "edited"),
      ...toolTurn("e-5", "edit", { path: "src/b.ts", edits: { old_string: "small", new_string: BIG } }, "edited"),
      ...toolTurn("p-1", "apply_patch", { input: BIG }, "patched"),
      ...toolTurn("s-1", "write", { path: "src/tiny.ts", content: "short" }, "wrote"),
      ...toolTurn("ref-1", "write", { path: "AGENTS.md", content: BIG }, "wrote"),
    ];
    const result = maskStaleToolResults(messages, messages.length);
    expect(result).not.toBeNull();
    expect(result!.maskedToolUseInputIds).toEqual(["e-1", "e-2", "e-3", "e-4", "e-5", "p-1"]);

    const editAssistant = result!.messages[1];
    if (editAssistant?.kind !== "assistant" || !Array.isArray(editAssistant.content)) throw new Error("expected edit assistant");
    const editBlock = editAssistant.content[0];
    if (editBlock?.type !== "tool_use") throw new Error("expected edit tool_use");
    expect(editBlock.input.old_string).toContain("[stale-masked edit.old_string]");
    expect(editBlock.input.new_string).toContain("[stale-masked edit.new_string]");
    expect(editBlock.input.path).toBe("src/a.ts");

    const batchAssistant = result!.messages[3];
    if (batchAssistant?.kind !== "assistant" || !Array.isArray(batchAssistant.content)) throw new Error("expected edit assistant");
    const batchBlock = batchAssistant.content[0];
    if (batchBlock?.type !== "tool_use") throw new Error("expected edit tool_use");
    expect(batchBlock.input.edits).toEqual([
      { old_string: "small", new_string: expect.stringContaining("[stale-masked edit.edits.0.new_string]") },
      { old_string: expect.stringContaining("[stale-masked edit.edits.1.old_string]"), new_string: "small" },
    ]);
    expect(batchBlock.input.path).toBe("src/b.ts");
    // An edits list sent as JSON text masks as the list that dispatch read from it.
    const textAssistant = result!.messages[5];
    if (textAssistant?.kind !== "assistant" || !Array.isArray(textAssistant.content)) throw new Error("expected edit assistant");
    expect(textAssistant.content[0]).toEqual({ ...batchBlock, id: "e-3" });
    const entriesAssistant = result!.messages[7];
    if (entriesAssistant?.kind !== "assistant" || !Array.isArray(entriesAssistant.content)) throw new Error("expected edit assistant");
    expect(entriesAssistant.content[0]).toEqual({ ...batchBlock, id: "e-4" });
    const bareAssistant = result!.messages[9];
    if (bareAssistant?.kind !== "assistant" || !Array.isArray(bareAssistant.content)) throw new Error("expected edit assistant");
    const bareBlock = bareAssistant.content[0];
    if (bareBlock?.type !== "tool_use") throw new Error("expected edit tool_use");
    expect(bareBlock.input.edits).toEqual([{ old_string: "small", new_string: expect.stringContaining("[stale-masked edit.edits.0.new_string]") }]);

    const patchAssistant = result!.messages[11];
    if (patchAssistant?.kind !== "assistant" || !Array.isArray(patchAssistant.content)) throw new Error("expected patch assistant");
    const patchBlock = patchAssistant.content[0];
    if (patchBlock?.type !== "tool_use") throw new Error("expected apply_patch tool_use");
    expect(patchBlock.input.input).toContain("[stale-masked apply_patch.input]");

    const replayed = maskToolResultsById(messages, result!.maskedToolUseIds, result!.maskedToolUseInputIds);
    expect(replayed).toEqual(result!.messages);
  });

  test("masked bytes are deterministic across calls", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "go" },
      ...writeTurn("w-1", "src/a.ts"),
      { kind: "user", content: "more" },
    ];
    const first = maskStaleToolResults(messages, messages.length);
    const second = maskStaleToolResults(messages, messages.length);
    expect(second).toEqual(first);
  });

  test("replay reproduces a mask whose cutoff splits a tool_use from its result", () => {
    const messages: ConversationMessage[] = [
      { kind: "user", content: "go" },
      ...writeTurn("w-1", "src/a.ts"),
      ...toolTurn("b-1", "bash", { command: "make" }, BIG),
    ];
    // Cutoff at index 2: the write's tool_use (index 1) is stale, its result
    // (index 2) is not; the bash turn is live.
    const live = maskStaleToolResults(messages, 2);
    expect(live).not.toBeNull();
    expect(live!.maskedToolUseInputIds).toEqual(["w-1"]);
    expect(live!.maskedToolUseIds).toEqual([]);
    const replayed = maskToolResultsById(messages, live!.maskedToolUseIds, live!.maskedToolUseInputIds);
    expect(replayed).toEqual(live!.messages);
  });
});
