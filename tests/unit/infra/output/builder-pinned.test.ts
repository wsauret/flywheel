import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder";
import type { ToolEntry, AnyBlock } from "../../../../src/infra/output-blocks";

function resolvedTool(name: string, detail: string, timestamp: number): ToolEntry {
  return { kind: "tool", id: `tool-${detail}`, name, presentation: { name, detail }, timestamp, status: "completed" };
}

function isBlockOfKind<K extends AnyBlock["kind"]>(block: AnyBlock | undefined, kind: K): block is Extract<AnyBlock, { kind: K }> {
  return block?.kind === kind;
}

function blockOfKind<K extends AnyBlock["kind"]>(blocks: readonly AnyBlock[], index: number, kind: K): Extract<AnyBlock, { kind: K }> {
  const block = blocks[index];
  if (!isBlockOfKind(block, kind)) throw new Error(`Expected ${kind} block, got ${block?.kind ?? "missing"}`);
  return block;
}

describe("StructuredOutputBuilder — pinned zone", () => {
  let builder: StructuredOutputBuilder;

  beforeEach(() => {
    builder = new StructuredOutputBuilder();
  });

  describe("pending message ordering", () => {
    it("first-appearance ordering keeps a queued message after an open keyed text block", () => {
      const now = Date.now();
      builder.pushText("Hello", now, "text-1");
      builder.pushUserMessage("follow-up", now + 50, true);
      builder.pushText(" world", now + 100, "text-1");

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.kind).toBe("text");
      expect(blockOfKind(blocks, 0, "text").content).toBe("Hello world");
      expect(blocks[1]?.kind).toBe("userMessage");
      expect(blockOfKind(blocks, 1, "userMessage").pending).toBe(true);
      expect(builder.hasQueued()).toBe(true);
    });

    it("multiple pending messages preserve send order in the pinned tail", () => {
      const now = Date.now();
      builder.pushText("output", now, "text-1");
      builder.pushUserMessage("first follow-up", now + 200, true);
      builder.pushUserMessage("second follow-up", now + 300, true);

      builder.pushSystemMessage("step done", now + 400);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(4);
      expect(blocks[0]?.kind).toBe("text");
      expect(blocks[1]?.kind).toBe("system");
      expect((blockOfKind(blocks, 2, "userMessage")).content).toBe("first follow-up");
      expect(blockOfKind(blocks, 3, "userMessage").content).toBe("second follow-up");
    });

    it("top-level tools after drainQueued land below the delivered message", () => {
      const now = Date.now();
      builder.pushStandaloneToolEntry(resolvedTool("Read", "a.ts", now));
      builder.pushUserMessage("follow-up", now + 50, true);
      builder.pushStandaloneToolEntry(resolvedTool("Read", "b.ts", now + 100));

      expect(builder.drainQueued()).toEqual(["follow-up"]);
      builder.pushStandaloneToolEntry(resolvedTool("Read", "c.ts", now + 200));

      const blocks = builder.getBlocks();
      expect(blocks.map((b) => b.kind)).toEqual(["tool", "tool", "userMessage", "tool"]);
      expect(blockOfKind(blocks, 0, "tool").presentation.detail).toBe("a.ts");
      expect(blockOfKind(blocks, 1, "tool").presentation.detail).toBe("b.ts");
      expect(blockOfKind(blocks, 2, "userMessage").pending).toBe(false);
      expect(blockOfKind(blocks, 3, "tool").presentation.detail).toBe("c.ts");
    });
  });

});
