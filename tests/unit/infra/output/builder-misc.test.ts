import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder";
import type { AnyBlock } from "../../../../src/infra/output-blocks";

function isBlockOfKind<K extends AnyBlock["kind"]>(block: AnyBlock | undefined, kind: K): block is Extract<AnyBlock, { kind: K }> {
  return block?.kind === kind;
}

function blockOfKind<K extends AnyBlock["kind"]>(block: AnyBlock | undefined, kind: K): Extract<AnyBlock, { kind: K }> {
  if (!isBlockOfKind(block, kind)) throw new Error(`Expected ${kind} block, got ${block?.kind ?? "missing"}`);
  return block;
}

describe("StructuredOutputBuilder — misc", () => {
  let builder: StructuredOutputBuilder;

  beforeEach(() => {
    builder = new StructuredOutputBuilder();
  });

  describe("resetTracking", () => {
    it("clears agent tracking so new agents get fresh indices", () => {
      const now = Date.now();
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-agent-1");
      builder.pushText("agent output", now + 100, "text-1");
      builder.completeAgent("agent-1", 200);

      builder.resetTracking();

      // Starting a new agent with the same ID should create a new block,
      // not try to append to the old one
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching again" }, now + 300, "tu-agent-1");
      builder.pushText("new agent output", now + 400, "text-2");
      builder.completeAgent("agent-1", 200);

      const blocks = builder.getBlocks();
      const agentBlocks = blocks.filter((b) => b.kind === "agentGroup");
      expect(agentBlocks).toHaveLength(2);
    });

    it("new text after resetTracking creates a fresh keyed block", () => {
      const now = Date.now();
      builder.pushText("before reset\n", now, "text-1");
      builder.resetTracking();
      builder.pushText("after reset\n", now + 100, "text-2");

      const blocks = builder.getBlocks();
      const textBlocks = blocks.filter((b) => b.kind === "text");
      expect(textBlocks).toHaveLength(2);
      expect((blockOfKind(textBlocks[0], "text")).content).toContain("before reset");
      expect((blockOfKind(textBlocks[1], "text")).content).toContain("after reset");
    });
  });

  describe("getBlocks live array", () => {
    it("returns the same live array across reads and mutations", () => {
      builder.pushText("hello", Date.now(), "text-1");
      const blocks1 = builder.getBlocks();
      builder.pushText(" world", Date.now(), "text-1");
      const blocks2 = builder.getBlocks();
      expect(blocks2).toBe(blocks1);
      expect((blockOfKind(blocks2[0], "text")).content).toBe("hello world");
    });

    it("replaces element references on mutation so consumers diff by identity", () => {
      builder.pushText("hello", Date.now(), "text-1");
      const el1 = builder.getBlocks()[0];
      builder.pushText(" world", Date.now(), "text-1");
      const el2 = builder.getBlocks()[0];
      expect(el2).not.toBe(el1);
    });
  });

  describe("seedBlocks", () => {
    it("replaces an earlier startup seed instead of duplicating it", () => {
      const optimistic: AnyBlock = { kind: "userMessage", id: "optimistic", content: "hello", timestamp: 1, pending: false, injected: false };
      const durable: AnyBlock = { kind: "userMessage", id: "durable", content: "hello", timestamp: 1, pending: false, injected: false };

      builder.seedBlocks([optimistic]);
      builder.getBlocks();
      builder.seedBlocks([durable]);

      expect(builder.getBlocks()).toEqual([durable]);
    });
  });

  describe("block cap", () => {
    // The eviction wiring is cap-independent, so a small injected cap proves
    // it without paying for 40k pushes against the production 20k.
    it("caps blocks at the injected cap, dropping oldest on overflow", () => {
      const capped = new StructuredOutputBuilder(100);
      const now = Date.now();
      for (let i = 0; i < 60; i++) {
        // Alternate text and standalone tool to prevent merging/grouping
        capped.pushText(`text-${i}\n`, now + i * 2, `text-${i}`);
        capped.pushTool("Edit", { name: "Edit", detail: `detail-${i}` }, now + i * 2 + 1);
      }
      const blocks = capped.getBlocks();
      expect(blocks.length).toBeLessThanOrEqual(100);
      // Oldest evicted: the first text block is gone, the newest survives.
      expect(blocks.some((block) => block.kind === "text" && block.content.startsWith("text-0\n"))).toBe(false);
      expect(blocks.some((block) => block.kind === "text" && block.content.startsWith("text-59\n"))).toBe(true);
    });
  });

});
