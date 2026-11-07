import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { environmentReminder } from "../../../../src/orchestration/agent-runtime/llm/claude-reminders";
import { ENGINE_INSTRUCTIONS } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text";
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/conversation-tree-context";
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types";
import { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage";
import { compaction, message, nextTimestamp, resetTimestamps } from "./_conversation-tree-entries";
import { SHELL_CAPABILITIES } from "../../../helpers/prompt-capabilities.js";

let baseDir: string;
let store: EventStore;
const sessionId = "s_tree_context";
const conversationId = "c_tree_context";
async function openTree(): Promise<ConversationTree> {
  const storage = await ConversationTreeStorage.create({ conversationId, sessionId, now: nextTimestamp, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) });
  return new ConversationTree(storage);
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-session-tree-ctx-"));
  resetTimestamps();
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
});

afterEach(() => {
  store.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe("ConversationTree.appendMessage", () => {
  it("persists incomplete only when an assistant message is marked incomplete, and every label of a user entry, also a model reminder's of an earlier build", async () => {
    const tree = await openTree();
    await tree.appendMessage({ kind: "user", content: "start" });
    const partialId = await tree.appendMessage({
      kind: "assistant",
      content: [{ type: "text", text: "partial" }],
      incomplete: true,
    });
    await tree.appendMessage({ kind: "user", content: "retry" });
    const completeId = await tree.appendMessage({ kind: "assistant", content: "done" });
    const nextId = await tree.appendMessage({ kind: "user", content: "next", origin: "system", replyRequired: true, runtimeNotice: true, framing: "claude" });

    const partial = await tree.getEntry(partialId);
    const complete = await tree.getEntry(completeId);
    const next = await tree.getEntry(nextId);
    if (partial?.kind !== "message" || complete?.kind !== "message" || next?.kind !== "message") throw new Error("expected message entries");
    expect(partial.message.kind).toBe("assistant");
    expect(complete.message.kind).toBe("assistant");
    if (partial.message.kind !== "assistant" || complete.message.kind !== "assistant") throw new Error("expected assistant messages");
    expect(partial.message.incomplete).toBe(true);
    expect(complete.message.incomplete).toBeUndefined();
    expect("incomplete" in next.message).toBe(false);
    expect(next.message).toMatchObject({ kind: "user", replyRequired: true, runtimeNotice: true, framing: "claude" });
    expect((await tree.buildContext()).messages.at(-1)).toMatchObject({ kind: "user", replyRequired: true, runtimeNotice: true, framing: "claude" });
    // A build before 2026-10-25 stored the Claude model reminder without framing; it reads as claude framing.
    const reminder = "<system-reminder>\nYou are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.\n</system-reminder>";
    await tree.appendMessage({ kind: "user", content: reminder, origin: "system" });
    expect((await tree.buildContext()).messages.slice(-2)).toEqual([{ kind: "user", content: "next", origin: "system", replyRequired: true, runtimeNotice: true, framing: "claude" }, { kind: "user", content: reminder, origin: "system", framing: "claude" }]);
    // A build before 2026-10-27 labeled the shared host's engine text `claude`, which reads as the host's; a model
    // reminder right before it keeps its Claude framing.
    await tree.appendMessage({ kind: "user", content: reminder, origin: "system", framing: "claude" });
    await tree.appendMessage({ kind: "user", content: ENGINE_INSTRUCTIONS, origin: "system", framing: "claude" });
    expect((await tree.buildContext()).messages.slice(-2)).toEqual([{ kind: "user", content: reminder, origin: "system", framing: "claude" }, { kind: "user", content: ENGINE_INSTRUCTIONS, origin: "system", framing: "agent-host" }]);
  });

  it("keeps the reminder label of an environment or date reminder, and gives it to one that a build before 2026-11-01 wrote without it", async () => {
    const tree = await openTree();
    const date = "<system-reminder>\nCurrent local date: 2026-10-30.\n</system-reminder>\n";
    const environment = environmentReminder({ kind: "environment", workingDirectory: "/work/two", isWorktree: false, isGitRepo: false, platform: "darwin", shell: "zsh", osVersion: "Darwin 25.3.0" }, SHELL_CAPABILITIES);
    const entries = [
      { kind: "user", content: "Start.", origin: "human" },
      { kind: "user", content: date, origin: "system", framing: "reminder" },
      // The shape that earlier builds wrote: the same reminders with no label.
      { kind: "user", content: date, origin: "system" },
      { kind: "user", content: environment, origin: "system" },
      // A person's text, and a background notification, with a reminder's bytes stay input.
      { kind: "user", content: date, origin: "human" },
      { kind: "user", content: date, origin: "system", replyRequired: true },
    ] as const;
    for (const entry of entries) await tree.appendMessage(entry);

    expect((await tree.buildContext()).messages).toEqual([
      { kind: "user", content: "Start.", origin: "human" },
      { kind: "user", content: date, origin: "system", framing: "reminder" },
      { kind: "user", content: date, origin: "system", framing: "reminder" },
      { kind: "user", content: environment, origin: "system", framing: "reminder" },
      { kind: "user", content: date, origin: "human" },
      { kind: "user", content: date, origin: "system", replyRequired: true },
    ]);
  });

  it("round-trips complete assistant provider metadata", async () => {
    const tree = await openTree();
    await tree.appendMessage({
      kind: "assistant",
      content: "done",
      accessProvider: "openai_api",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-6-luna",
      timestamp: 1_787_206_337_949,
      stopReason: "tool_use",
      responseId: "resp_123",
    });

    const context = await tree.buildContext({ allowAssistantTail: true });
    expect(context.messages).toEqual([{
      kind: "assistant",
      content: "done",
      accessProvider: "openai_api",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-6-luna",
      timestamp: 1_787_206_337_949,
      stopReason: "tool_use",
      responseId: "resp_123",
    }]);
  });

  it("round-trips the blocked wait-state marker on toolResult messages", async () => {
    const tree = await openTree();
    await tree.appendMessage({
      kind: "assistant",
      content: [{ type: "tool_use", id: "toolu_h", name: "handoff", input: { summary: "draft" } }],
    });
    const resultId = await tree.appendMessage({
      kind: "toolResult",
      toolUseId: "toolu_h",
      content: [{ type: "text", text: "Your handoff passed validation but was NOT recorded." }],
      isError: true,
      blocked: true,
    });

    const persisted = await tree.getEntry(resultId);
    if (persisted?.kind !== "message" || persisted.message.kind !== "toolResult") throw new Error("expected toolResult entry");
    expect(persisted.message.blocked).toBe(true);
    expect(persisted.message.isError).toBe(true);

    const context = await tree.buildContext();
    const result = context.messages.find((m) => m.kind === "toolResult");
    if (result?.kind !== "toolResult") throw new Error("expected toolResult message");
    expect(result.blocked).toBe(true);
    expect(result.isError).toBe(true);
  });

  it("preserves raw tool ownership across display-only notices and rejects an unrelated result", async () => {
    const tree = await openTree();
    await tree.appendMessage({ kind: "user", content: "inspect both" });
    await tree.appendMessage({
      kind: "assistant",
      content: [
        { type: "tool_use", id: "tool_a", name: "read", input: {} },
        { type: "tool_use", id: "tool_b", name: "read", input: {} },
      ],
    });
    await tree.appendMessage({ kind: "system", content: "returned words", displayOnly: true });
    await tree.appendMessage({ kind: "toolResult", toolUseId: "tool_a", content: [{ type: "text", text: "first" }] });
    expect(JSON.stringify(await tree.buildContext())).not.toContain("returned words");

    await expect(tree.appendMessage({
      kind: "toolResult",
      toolUseId: "tool_other",
      content: [{ type: "text", text: "wrong owner" }],
    })).rejects.toThrow(/tool_other.*tool_use/i);
  });

  it("rejects a later mismatched or duplicate result in one append batch", async () => {
    const tree = await openTree();
    await tree.appendMessage({ kind: "user", content: "inspect both" });
    const cases = [
      ["tool_other", "wrong owner"],
      ["tool_a", "duplicate result"],
    ] as const;

    for (const [toolUseId, text] of cases) {
      const outcome = await tree.appendMessages([
        {
          kind: "assistant",
          content: [
            { type: "tool_use", id: "tool_a", name: "read", input: {} },
            { type: "tool_use", id: "tool_b", name: "read", input: {} },
          ],
        },
        {
          kind: "toolResult",
          toolUseId: "tool_a",
          content: [{ type: "text", text: "first" }],
        },
        {
          kind: "toolResult",
          toolUseId,
          content: [{ type: "text", text }],
        },
      ]);

      expect(outcome.kind).toBe("notCommitted");
      expect((await tree.getBranch()).map((entry) => entry.kind === "message" ? entry.message.kind : entry.kind)).toEqual(["user"]);
    }
  });
});

describe("buildSessionContext", () => {
  it("walks only the active branch", async () => {
    const tree = await openTree();
    const m1 = await tree.appendMessage({ kind: "user", content: "first" });
    const m2 = await tree.appendMessage({ kind: "assistant", content: "second" });
    await tree.appendMessage({ kind: "user", content: "third" });

    // Move the leaf back to m1, then add an alternate branch.
    await tree.moveTo(m1);
    await tree.appendMessage({ kind: "user", content: "alt-branch" });

    const context = await tree.buildContext();
    const texts = context.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toContain("first");
    expect(texts).toContain("alt-branch");
    expect(texts).not.toContain("second");
    expect(texts).not.toContain("third");
    // ensure m2 still lives on disk despite being abandoned
    expect(await tree.getEntry(m2)).toBeDefined();
  });

  it("reconstructs retained messages, summary, source suffix, and post-compaction entries in order", () => {
    const old = message(null, "11111111", "user", "old dropped");
    const source: ConversationEntry = {
      kind: "message", id: "22222222", parentId: "11111111", timestamp: nextTimestamp(),
      message: { kind: "assistant", content: [{ type: "tool_use", id: "tool_a", name: "search", input: {} }] },
    };
    const orphanResult: ConversationEntry = {
      kind: "message", id: "33333333", parentId: "22222222", timestamp: nextTimestamp(),
      message: { kind: "toolResult", toolUseId: "tool_a", content: [{ type: "text", text: "model.turn.completed" }] },
    };
    const suffix = message("33333333", "44444444", "user", "source suffix");
    const compacted = compaction("44444444", "55555555", "22222222", [
      { kind: "user", content: "retained one" },
      { kind: "user", content: "retained two" },
    ]);
    const after = message("55555555", "66666666", "user", "after compaction");

    const ctx = buildSessionContext([old, source, orphanResult, suffix, compacted, after]);
    expect(ctx.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual([
      "retained one",
      "retained two",
      "compressed earlier turns",
      expect.stringContaining("model.turn.completed"),
      "source suffix",
      "after compaction",
    ]);
  });

  it("buildContext preserves compacted context when walking from the source boundary", async () => {
    const tree = await openTree();
    const old = message(null, "11111111", "user", "old dropped");
    const older = message("11111111", "22222222", "user", "older dropped");
    const source = message("22222222", "33333333", "user", "source summarized");
    const suffixOne = message("33333333", "44444444", "user", "source suffix one");
    const suffixTwo = message("44444444", "55555555", "user", "source suffix two");
    const compacted = compaction("55555555", "66666666", "33333333", [{ kind: "user", content: "retained one" }, { kind: "user", content: "retained two" }]);
    const afterOne = message("66666666", "77777777", "user", "after compaction one");
    const afterTwo = message("77777777", "88888888", "user", "after compaction two");
    const fullBranch = [old, older, source, suffixOne, suffixTwo, compacted, afterOne, afterTwo];

    await tree.getStorage().appendEntries(fullBranch);
    expect((await tree.getStorage().getContextPathToRoot("88888888")).map((entry) => entry.id)).toEqual(["33333333", "44444444", "55555555", "66666666", "77777777", "88888888"]);
    const messages = (await tree.buildContext()).messages;
    expect(messages).toEqual(buildSessionContext(fullBranch).messages);
    expect(messages.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual(["retained one", "retained two", "compressed earlier turns", "source suffix one", "source suffix two", "after compaction one", "after compaction two"]);
  });

  it("omits the source suffix when sourceLeafId is the compaction parent", () => {
    const source = message(null, "11111111", "user", "source summarized");
    const compacted = compaction("11111111", "22222222", "11111111", [{ kind: "user", content: "retained user" }]);
    const after = message("22222222", "33333333", "user", "after compaction");

    const ctx = buildSessionContext([source, compacted, after]);
    expect(ctx.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual(["retained user", "compressed earlier turns", "after compaction"]);
  });

  it("includes branch summaries that are on the active branch", () => {
    const m1 = message(null, "11111111", "user", "main-1");
    const branchSummary: ConversationEntry = {
      kind: "branch_summary",
      id: "22222222",
      parentId: "11111111",
      timestamp: nextTimestamp(),
      fromId: "abandoned",
      summary: "explored approach A",
    };
    const m2 = message("22222222", "33333333", "user", "main-2");
    const ctx = buildSessionContext([m1, branchSummary, m2]);
    const allText = ctx.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(allText).toContain("main-1");
    expect(allText).toContain("explored approach A");
    expect(ctx.messages[1]).toMatchObject({ kind: "user", origin: "system" });
    expect(allText).toContain("main-2");
  });

  it("returns no messages for an empty branch", () => {
    expect(buildSessionContext([])).toEqual({ messages: [] });
  });
});

describe("recovered tool history lowering", () => {
  it("lowers incomplete multi-tool evidence to one user-origin gap without invented results", () => {
    const ask = message(null, "11111111", "user", "start");
    const assistant: ConversationEntry = {
      kind: "message", id: "22222222", parentId: "11111111", timestamp: nextTimestamp(),
      message: { kind: "assistant", content: [
        { type: "tool_use", id: "tool_a", name: "search", input: { query: "kept" } },
        { type: "tool_use", id: "tool_b", name: "read", input: { path: "missing" } },
      ] },
    };
    const result: ConversationEntry = {
      kind: "message", id: "33333333", parentId: "22222222", timestamp: nextTimestamp(),
      message: { kind: "toolResult", toolUseId: "tool_a", content: [{ type: "text", text: "recoverable result" }] },
    };
    const next = message("33333333", "44444444", "user", "continue");

    const context = buildSessionContext([ask, assistant, result, next]);

    expect(context.messages.map((item) => item.kind)).toEqual(["user", "user", "user"]);
    const gap = context.messages[1];
    expect(gap?.kind).toBe("user");
    if (gap?.kind !== "user") throw new Error("expected recovered user-origin gap");
    expect(gap.origin).toBe("system");
    expect(gap.content).toBe(`<conversationHistoryGap reason="incomplete, duplicate, or mismatched tool exchange">${JSON.stringify([assistant.message, result.message])}</conversationHistoryGap>`);
  });

  it("retains orphan tool-result evidence in a user-origin gap", () => {
    const ask = message(null, "11111111", "user", "start");
    const orphan: ConversationEntry = {
      kind: "message", id: "22222222", parentId: "11111111", timestamp: nextTimestamp(),
      message: { kind: "toolResult", toolUseId: "orphan_tool", content: [{ type: "text", text: "orphan output" }] },
    };
    const next = message("22222222", "33333333", "user", "continue");

    const context = buildSessionContext([ask, orphan, next]);
    const gap = context.messages[1];
    expect(gap?.kind).toBe("user");
    if (gap?.kind !== "user") throw new Error("expected recovered user-origin gap");
    expect(gap.origin).toBe("system");
    expect(String(gap.content)).toContain("orphan_tool");
    expect(String(gap.content)).toContain("orphan output");
  });

  it("gives each unreadable entry of a batch one gap that holds only that entry", async () => {
    const tree = await openTree();
    await tree.appendMessage({ kind: "user", content: "start" });
    const k = 16;
    const padding = "x".repeat(1000);
    const newer = Array.from({ length: k }, (_, index) => ({ kind: "future", id: `newer${index}`, parentId: null, padding }));
    const unknownKinds = [{ kind: "future", id: "v1a", parentId: null }, { kind: "future", id: "v1b", parentId: "v1a" }];
    for (const [version, entries] of [[9, newer], [1, unknownKinds]] as const) {
      store.append({
        aggregateId: `conversation:${conversationId}`, sessionId, type: "chat.entries.appended",
        version, actor: "flywheel", timestamp: Date.now(), payload: { conversationId, entries },
      });
    }

    const gaps = (await tree.buildContext()).messages.slice(1).map((entry) => String(entry.content));
    expect(gaps).toHaveLength(k + unknownKinds.length);
    for (const [index, entry] of [...newer, ...unknownKinds].entries()) {
      expect(gaps[index]).toMatch(new RegExp(`^<conversationHistoryGap provenance="degraded" position="\\d+" version="${index < k ? 9 : 1}" type="chat.entries.appended" entry="${entry.id}">`));
      expect(gaps[index]).toEndWith(`>${JSON.stringify(entry)}</conversationHistoryGap>`);
    }
    // Linear in the batch: the k gaps together cost about one copy of the batch, not k copies.
    expect(gaps.slice(0, k).join("").length).toBeLessThan(2 * JSON.stringify(newer).length);
  });
});

describe("ConversationTree.moveTo and branch summary", () => {
  it("persists the moved leaf across storage reopen", async () => {
    const tree = await openTree();
    const m1 = await tree.appendMessage({ kind: "user", content: "alpha" });
    await tree.appendMessage({ kind: "user", content: "beta" });
    await tree.moveTo(m1);
    await tree.getStorage().dispose();

    const reopened = new ConversationTree(await ConversationTreeStorage.open({ conversationId, sessionId, store: asAsyncEventReadSurface(store) }));
    const ctx = await reopened.buildContext();
    const texts = ctx.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toEqual(["alpha"]);
    await reopened.getStorage().dispose();
  });

  it("keeps abandoned entries readable and reachable as branch siblings", async () => {
    const tree = await openTree();
    const m1 = await tree.appendMessage({ kind: "user", content: "alpha" });
    const abandoned = await tree.appendMessage({ kind: "user", content: "beta" });
    await tree.moveTo(m1);
    await tree.appendMessage({ kind: "user", content: "gamma" });

    // Abandoned branch entries are still indexed and resolvable.
    const branchFromAbandoned = await tree.getBranch(abandoned);
    const ids = branchFromAbandoned.map((e) => e.id);
    expect(ids).toEqual([m1, abandoned]);
  });


  it("omits the branch summary once the leaf moves off that branch", async () => {
    const tree = await openTree();
    const m1 = await tree.appendMessage({ kind: "user", content: "alpha" });
    await tree.appendMessage({ kind: "user", content: "beta" });
    await tree.moveTo(m1, { summary: "lessons from beta" });

    const onBranch = await tree.buildContext();
    const onBranchText = onBranch.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(onBranchText).toContain("lessons from beta");

    await tree.moveTo(m1);
    const offBranch = await tree.buildContext();
    const offBranchText = offBranch.messages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(offBranchText).not.toContain("lessons from beta");
  });
});

describe("context cache", () => {
  it("pins ordinary, degraded, and pending history across cooperative yields", async () => {
    const storage = (await openTree()).getStorage();
    await storage.appendEntries([message(null, "capture1", "user", "captured")]);
    const appendGap = () => store.append({
      aggregateId: `conversation:${conversationId}`, sessionId, type: "chat.entries.appended",
      version: 999, actor: "flywheel", timestamp: Date.now(), payload: { unreadable: true },
    });
    appendGap();
    const state = await storage.getState();
    const gap = state.degraded.materialize()[0];
    if (!gap) throw new Error("expected captured degraded record");
    storage.appendPending(message("capture1", "pending1", "user", "held before"));
    let clock = 0;
    let yielded = false;
    const tree = new ConversationTree(storage, {
      now: () => {
        clock += 8;
        return clock;
      },
      yieldToNextTask: async () => {
        if (yielded) return;
        yielded = true;
        // This gap is anchored to the captured old leaf, not the new suffix.
        appendGap();
        await storage.getState();
        await storage.appendEntries([message("capture1", "capture2", "user", "later")]);
        storage.appendPending(message("capture2", "pending2", "user", "held later"));
      },
    });
    const captured = await tree.buildContext();
    expect(yielded).toBe(true);
    // A fact with no entries array has no single entry to stand for: its gap holds the whole stored fact.
    expect(gap.raw).toMatchObject({ type: "chat.entries.appended", version: 999, payload: { unreadable: true }, position: gap.event.position });
    expect(captured.messages.map((entry) => entry.content)).toEqual([
      "captured", `<conversationHistoryGap provenance="degraded" position="${gap.event.position}" version="999" type="chat.entries.appended">${JSON.stringify(gap.raw)}</conversationHistoryGap>`, "held before",
    ]);
    const later = await tree.buildContext();
    expect(later).not.toBe(captured);
    expect(later.messages.map((entry) => entry.content)).toEqual([
      "captured", expect.stringContaining('provenance="degraded"'), expect.stringContaining('provenance="degraded"'),
      "later", "held later",
    ]);
    expect(await tree.buildContext()).toBe(later);
  });

  it("reuses a cached active-branch context until a mutation invalidates it", async () => {
    const tree = await openTree();
    await tree.appendMessage({ kind: "user", content: "alpha" });
    const first = await tree.buildContext();
    const cached = await tree.buildContext();
    expect(cached).toBe(first);

    await tree.appendMessage({ kind: "user", content: "beta" });
    const after = await tree.buildContext();
    expect(after).not.toBe(first);
    expect(after.messages.length).toBe(first.messages.length + 1);
    store.append({
      aggregateId: `conversation:${conversationId}`, sessionId, type: "chat.entries.appended",
      version: 999, actor: "flywheel", timestamp: Date.now(), payload: { unreadable: true },
    });
    const recovered = await tree.buildContext();
    expect(recovered).not.toBe(after);
    expect(recovered.messages.at(-1)?.content).toContain('provenance="degraded"');
  });

});

describe("display-only entries", () => {
  it("persists display-only entries but excludes them from model-visible context", () => {
    const m1 = message(null, "11111111", "user", "ask");
    const diagnostic: ConversationEntry = {
      kind: "message",
      id: "22222222",
      parentId: "11111111",
      timestamp: nextTimestamp(),
      message: { kind: "system", content: "internal error: provider timeout" },
      displayOnly: true,
    };
    const m3 = message("22222222", "33333333", "assistant", "reply");
    const m4 = message("33333333", "44444444", "user", "next");

    const ctx = buildSessionContext([m1, diagnostic, m3, m4]);
    const texts = ctx.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toContain("ask");
    expect(texts).toContain("reply");
    expect(texts).not.toContain("internal error: provider timeout");
  });
});

describe("review notice entries", () => {
  it("converts a persisted review notice to a content-only system message", () => {
    const ask = message(null, "11111111", "user", "ask");
    const notice: ConversationEntry = {
      kind: "message",
      id: "22222222",
      parentId: "11111111",
      timestamp: nextTimestamp(),
      message: {
        kind: "system",
        content: "Updated skill: `provider-quirks`.",
        reviewMutations: [{ name: "provider-quirks", action: "patched", reach: "project" }],
      },
    };
    const next = message("22222222", "33333333", "user", "next");

    const ctx = buildSessionContext([ask, notice, next]);

    // The evidence is durable and display-only: the provider sees the summary
    // text and nothing else.
    expect(ctx.messages).toEqual([
      { kind: "user", content: "ask" },
      { kind: "system", content: "Updated skill: `provider-quirks`." },
      { kind: "user", content: "next" },
    ]);
  });
});

describe("large tree reconstruction", () => {
  it("opens and walks a large tree without repeated full-file scans", async () => {
    const tree = await openTree();
    const batch: ConversationEntry[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 500; i += 1) {
      const id = `entry${String(i).padStart(4, "0")}`;
      batch.push({
        kind: "message",
        id,
        parentId: parent,
        timestamp: nextTimestamp(),
        message: { kind: "user", content: `m-${i}` },
      });
      parent = id;
    }
    await tree.getStorage().appendEntries(batch);
    const reopened = new ConversationTree(await ConversationTreeStorage.open({ conversationId, sessionId, store: asAsyncEventReadSurface(store) }));
    const branch = await reopened.getBranch();
    expect(branch.length).toBe(500);
    const cached = await reopened.buildContext();
    expect(await reopened.buildContext()).toBe(cached);
  });
});

describe("buildSessionContext — missing compaction source", () => {
  it("throws when the compaction's sourceLeafId is missing from the branch", () => {
    const m1 = message(null, "11111111", "user", "kept-but-spliced-out");
    expect(() => buildSessionContext([m1, compaction("11111111", "22222222", "99999999", [], "earlier turns")])).toThrow(/not in the active branch/i);
  });
});
