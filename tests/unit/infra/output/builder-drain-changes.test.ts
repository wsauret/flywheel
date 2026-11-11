import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder";
import { EMPTY_OUTPUT_CHANGE_BATCH } from "../../../../src/infra/output/output-block-delta";
import { askUserDisplay } from "../../../../src/infra/tools/displays/ask-user";
import { blockIdentity } from "../../../../src/protocol/block-identity";

describe("StructuredOutputBuilder — drainChanges (write-site delta minting)", () => {
  let builder: StructuredOutputBuilder;

  beforeEach(() => {
    builder = new StructuredOutputBuilder();
    // Every recording method short-circuits with no listener (same guard as
    // notifyChange), matching the one real production wiring (OutputProjector
    // always sets onChange before anything runs).
    builder.onChange = () => {};
  });

  it("stays empty with no listener wired, even after real mutations", () => {
    const unwired = new StructuredOutputBuilder();
    unwired.pushText("hello", Date.now(), "text-1");
    expect(unwired.drainChanges()).toBe(EMPTY_OUTPUT_CHANGE_BATCH);
  });

  it("a new text block mints one insert", () => {
    builder.pushText("hello", 1, "text-1");
    const batch = builder.drainChanges();
    expect(batch.fullResync).toBe(false);
    expect(batch.changes).toEqual([{ kind: "insert", index: 0, block: { kind: "text", id: "text-1", content: "hello", timestamp: 1 } }]);
  });

  it("appending to a tracked text block mints append-content with the correct offset", () => {
    builder.pushText("hello", 1, "text-1");
    builder.drainChanges();

    builder.pushText(" world", 2, "text-1");
    const batch = builder.drainChanges();
    expect(batch.changes).toEqual([{ kind: "append-content", index: 0, identity: { kind: "text", id: "text-1" }, contentOffset: 5, text: " world" }]);
  });

  it("drain clears the queue -- a second drain with no new activity is empty", () => {
    builder.pushText("hello", 1, "text-1");
    builder.drainChanges();
    expect(builder.drainChanges()).toBe(EMPTY_OUTPUT_CHANGE_BATCH);
  });

  it("agent lifecycle transitions mint an upsert at the agent's own index", () => {
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, 1, "tu-agent-1");
    builder.drainChanges();

    builder.completeAgent("agent-1", 100);
    const batch = builder.drainChanges();
    expect(batch.changes).toHaveLength(1);
    const change = batch.changes[0];
    expect(change).toMatchObject({ kind: "upsert", index: 0 });
    if (change?.kind !== "upsert") throw new Error(`Expected upsert change, got ${change?.kind ?? "missing"}`);
    expect(change.block).toMatchObject({ kind: "agentGroup", status: "completed" });
  });

  it("a child tool appended to an agent mints an upsert on the parent agent's index, not a child index", () => {
    builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, 1, "tu-agent-1");
    builder.drainChanges();

    builder.pushToolRowToAgent("agent-1", { kind: "tool", id: "t1", name: "Read", presentation: { name: "Read", detail: "file.ts" }, timestamp: 2, status: "completed" });
    const batch = builder.drainChanges();
    expect(batch.changes).toEqual([{ kind: "upsert", index: 0, block: expect.objectContaining({ kind: "agentGroup", id: "agent-1" }) }]);
  });

  it("retraction degrades to a full resync and drops any changes queued this batch", () => {
    builder.pushText("partial", 1, "text-1");
    builder.pushThinking("thinking...", 2, "think-1");
    builder.retractDrafts("thinking", ["think-1"]);

    const batch = builder.drainChanges();
    expect(batch.fullResync).toBe(true);
    expect(batch.changes).toEqual([]);
  });

  it("removing a stable tool preview resyncs and keeps later stable tool lookup correct", () => {
    builder.pushStandaloneToolEntry({ kind: "tool", id: "remove", name: "Read", presentation: { name: "Read", detail: "" }, timestamp: 1, status: "streaming" });
    builder.pushStandaloneToolEntry({ kind: "tool", id: "keep", name: "Read", presentation: { name: "Read", detail: "" }, timestamp: 2, status: "pending" });
    builder.drainChanges();

    builder.removeToolPreview("remove");
    expect(builder.drainChanges()).toMatchObject({ changes: [], fullResync: true });
    expect(builder.toolBlockIndex("keep")).toBe(0);
    builder.completeTool(0);
    expect(builder.getBlocks()[0]).toMatchObject({ id: "keep", status: "completed" });
  });

  it("withdrawing a queued message degrades to a full resync", () => {
    builder.pushUserMessage("queued while busy", 1, true, false, undefined, undefined, undefined, ["cell-1"]);
    builder.drainChanges();

    expect(builder.withdrawQueued(["cell-1"])).not.toBeNull();
    expect(builder.getBlocks()).toEqual([]);
    expect(builder.drainChanges().fullResync).toBe(true);
  });

  it("drain returns only the person's queued rows", () => {
    const from = { sessionId: "child-1", name: "Reviewer", relation: "child" as const };
    builder.pushUserMessage("from the child", 2, true, false, undefined, undefined, from);
    builder.pushUserMessage("person B", 3, true);
    expect(builder.drainQueued()).toEqual(["person B"]);
    expect(builder.getBlocks().every((block) => block.kind !== "userMessage" || !block.pending)).toBe(true);
  });

  it("draining queued messages mints an upsert per drained message, not a structural change", () => {
    builder.pushUserMessage("one", 1, true);
    builder.pushUserMessage("two", 2, true);
    builder.drainChanges();

    const drained = builder.drainQueued();
    expect(drained).toEqual(["one", "two"]);
    const batch = builder.drainChanges();
    expect(batch.fullResync).toBe(false);
    expect(batch.changes).toEqual([
      { kind: "upsert", index: 0, block: expect.objectContaining({ content: "one", pending: false }) },
      { kind: "upsert", index: 1, block: expect.objectContaining({ content: "two", pending: false }) },
    ]);
  });

  it("inserting before a queued message mints one insert; the shifted tail is not re-sent", () => {
    builder.pushUserMessage("queued while busy", 1, true);
    builder.drainChanges();

    // A tool block lands above the pinned pending tail. The insert itself
    // carries the displacement; an index-addressed client splices, so the
    // queued message shifts without being retransmitted.
    builder.pushTool("Bash", { name: "Bash", detail: "sleep 100" }, 2);
    const batch = builder.drainChanges();
    expect(batch.fullResync).toBe(false);
    expect(batch.changes).toEqual([
      { kind: "insert", index: 0, block: expect.objectContaining({ kind: "tool", name: "Bash" }) },
    ]);
  });

  it("starting an agent above a queued message mints one insert", () => {
    builder.pushUserMessage("queued while busy", 1, true);
    builder.drainChanges();

    builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, 2, "tu-agent-1");
    const batch = builder.drainChanges();
    expect(batch.fullResync).toBe(false);
    expect(batch.changes).toEqual([
      { kind: "insert", index: 0, block: expect.objectContaining({ kind: "agentGroup", id: "agent-1" }) },
    ]);
  });

  it("pushing a question above a queued message mints one insert", () => {
    builder.pushUserMessage("queued while busy", 1, true);
    builder.drainChanges();

    builder.pushQuestion("tool-1", [{ question: "Proceed?", multiSelect: false, choices: [{ kind: "option", label: "Yes" }] }], 2);
    const batch = builder.drainChanges();
    expect(batch.fullResync).toBe(false);
    expect(batch.changes).toEqual([
      { kind: "insert", index: 0, block: expect.objectContaining({ kind: "question", toolUseId: "tool-1" }) },
    ]);
  });

  it("replaces the provisional row in place with the question and mints an upsert at its index", () => {
    builder.pushText("lead-in", 50, "text-0");
    askUserDisplay.standaloneHandler?.({ question: "Continue?", options: ["Yes"] }, 100, builder, "tool_ctx");
    builder.drainChanges();

    const idx = builder.pushQuestion("tool_ctx", [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }], 200);

    expect(idx).toBe(1);
    const blocks = builder.getBlocks();
    expect(blocks).toHaveLength(2);
    const question = blocks[1];
    if (!question || question.kind !== "question") throw new Error("expected the question at the provisional index");
    expect(question.toolUseId).toBe("tool_ctx");
    expect(blockIdentity(question)).toBe("tool:tool_ctx");
    expect(builder.drainChanges().changes).toEqual([{ kind: "upsert", index: 1, block: question }]);
  });

  it("once fullResync fires, further changes in the same batch are dropped until the next drain", () => {
    builder.pushUserMessage("queued", 1, true, false, undefined, undefined, undefined, ["cell-1"]);
    builder.withdrawQueued(["cell-1"]) // structural: sets needsFullResync
    builder.pushText("more", 2, "text-1")

    const batch = builder.drainChanges();
    expect(batch.fullResync).toBe(true);
    expect(batch.changes).toEqual([]);

    // The next batch resumes normal incremental recording.
    builder.pushText(" text", 3, "text-1");
    const next = builder.drainChanges();
    expect(next.fullResync).toBe(false);
    expect(next.changes).toEqual([{ kind: "append-content", index: 0, identity: { kind: "text", id: "text-1" }, contentOffset: 4, text: " text" }]);
  });

  it("visible suffix counts inserts and delivery once while preserving nonmessages and appends", () => {
    builder.seedBlocks([{ kind: "text", id: "durable", content: "history", timestamp: 0 }]);
    expect(builder.visibleMessageCountSuffix).toBe(1);

    builder.pushText("answer", 1, "answer");
    builder.pushText(" continued", 2, "answer");
    builder.pushTool("Read", { name: "Read", detail: "file.ts" }, 3);
    builder.pushUserMessage("queued", 4, true);
    expect(builder.visibleMessageCountSuffix).toBe(2);

    expect(builder.drainQueued()).toEqual(["queued"]);
    expect(builder.visibleMessageCountSuffix).toBe(3);
    builder.drainQueued();
    expect(builder.visibleMessageCountSuffix).toBe(3);
  });

  it("visible suffix tracks seeded messages, retraction, and cap eviction", () => {
    const capped = new StructuredOutputBuilder(4);
    capped.onChange = () => {};
    capped.seedBlocks([{ kind: "text", id: "durable", content: "history", timestamp: 0 }]);
    capped.pushText("first", 1, "first");
    expect(capped.visibleMessageCountSuffix).toBe(2);

    capped.retractDrafts("text", ["first"]);
    expect(capped.visibleMessageCountSuffix).toBe(1);

    capped.pushText("second", 2, "second");
    capped.pushSystemMessage("evict", 3);
    expect(capped.visibleMessageCountSuffix).toBe(2);
    capped.pushSystemMessage("evict again", 4);
    expect(capped.visibleMessageCountSuffix).toBe(2);
    capped.pushSystemMessage("evict all", 5);
    expect(capped.visibleMessageCountSuffix).toBe(0);
  });

  it("counts assistant text inserted before a tool", () => {
    builder.seedBlocks([{
      kind: "tool",
      id: "tool-1",
      name: "Read",
      presentation: { name: "Read", detail: "file.ts" },
      timestamp: 0,
      status: "pending",
    }]);

    builder.insertTextBeforeTool("tool-1", "answer", 1, "answer");

    expect(builder.visibleMessageCountSuffix).toBe(1);
  });
});
