import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../src/tui/adapters/structured-output-builder";
import type { AnyBlock, TextBlock, ToolBlock, AgentBlock, ContextGroupBlock } from "../src/tui/routes/work/state/types";

describe("StructuredOutputBuilder", () => {
  let builder: StructuredOutputBuilder;

  beforeEach(() => {
    builder = new StructuredOutputBuilder();
  });

  // ── Text accumulation ──

  describe("pushText", () => {
    it("creates a TextBlock for the first text push", () => {
      builder.pushText("hello world", Date.now());
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("text");
      expect((blocks[0] as TextBlock).content).toBe("hello world");
    });

    it("consecutive text pushes merge into a single TextBlock", () => {
      const now = Date.now();
      builder.pushText("line 1\n", now);
      builder.pushText("line 2\n", now + 100);
      builder.pushText("line 3\n", now + 200);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as TextBlock).content).toBe("line 1\nline 2\nline 3\n");
    });

    it("text after a tool creates a new TextBlock", () => {
      const now = Date.now();
      builder.pushText("before", now);
      builder.pushTool("Read", "file.ts", now + 100);
      builder.pushText("after", now + 200);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("text");
      expect(blocks[1].kind).toBe("tool");
      expect(blocks[2].kind).toBe("text");
    });
  });

  // ── Tool outside agent ──

  describe("pushTool", () => {
    it("creates a standalone ToolBlock when not inside an agent", () => {
      builder.pushTool("Bash", "ls -la", Date.now());
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("tool");
      const tool = blocks[0] as ToolBlock;
      expect(tool.name).toBe("Bash");
      expect(tool.detail).toBe("ls -la");
    });
  });

  // ── Agent lifecycle ──

  describe("agent lifecycle", () => {
    it("startAgent creates an AgentBlock with active status", () => {
      builder.startAgent("agent-1", "Explore", "Searching codebase", Date.now());
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.id).toBe("agent-1");
      expect(agent.agentLabel).toBe("Explore");
      expect(agent.description).toBe("Searching codebase");
      expect(agent.status).toBe("active");
      expect(agent.children).toEqual([]);
    });

    it("tool inside agent is added to AgentBlock.children", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.pushTool("Read", "file.ts", now + 100);
      builder.pushTool("Grep", "pattern", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as AgentBlock;
      expect(agent.children).toHaveLength(2);
      expect(agent.children[0].name).toBe("Read");
      expect(agent.children[1].name).toBe("Grep");
    });

    it("agent children are capped at 50", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Heavy search", now);
      for (let i = 0; i < 60; i++) {
        builder.pushTool(`Tool${i}`, `detail-${i}`, now + i);
      }
      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.children).toHaveLength(50);
      // Should keep the most recent 50
      expect(agent.children[0].name).toBe("Tool10");
      expect(agent.children[49].name).toBe("Tool59");
    });

    it("completeAgent sets status to completed with duration", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.completeAgent("agent-1", 1500, 3);

      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.status).toBe("completed");
      expect(agent.duration).toBe(1500);
      expect(agent.toolCount).toBe(3);
    });

    it("errorAgent sets status to error with message", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.errorAgent("agent-1", "Timeout exceeded");

      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.status).toBe("error");
      expect(agent.errorMessage).toBe("Timeout exceeded");
    });

    it("tools after agent completion go to top-level", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.pushTool("Read", "inside.ts", now + 100);
      builder.completeAgent("agent-1", 500, 1);
      builder.pushTool("Bash", "outside command", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect(blocks[1].kind).toBe("tool");
      expect((blocks[1] as ToolBlock).name).toBe("Bash");
    });

    it("updateAgentLatestChild sets latestChild string", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.updateAgentLatestChild("agent-1", "Reading src/index.ts");

      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.latestChild).toBe("Reading src/index.ts");
    });

    it("completeAgent is no-op for unknown agent id", () => {
      builder.pushText("some text", Date.now());
      builder.completeAgent("unknown-id", 100, 0);
      // Should not throw, blocks unchanged
      expect(builder.getBlocks()).toHaveLength(1);
    });

    it("errorAgent is no-op for unknown agent id", () => {
      builder.pushText("some text", Date.now());
      builder.errorAgent("unknown-id", "error");
      expect(builder.getBlocks()).toHaveLength(1);
    });
  });

  // ── Context grouping ──

  describe("context grouping", () => {
    it("3 consecutive context tools are grouped into a ContextGroupBlock", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Read", "file2.ts", now + 100);
      builder.pushTool("Glob", "**/*.ts", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("contextGroup");
      const group = blocks[0] as ContextGroupBlock;
      expect(group.tools).toHaveLength(3);
      expect(group.tools[0].name).toBe("Read");
      expect(group.tools[1].name).toBe("Read");
      expect(group.tools[2].name).toBe("Glob");
    });

    it("2 consecutive context tools remain as standalone ToolBlocks", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Grep", "pattern", now + 100);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("tool");
      expect(blocks[1].kind).toBe("tool");
    });

    it("context group grows with additional context tools", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTool("Grep", "pattern", now + 200);
      builder.pushTool("Read", "file4.ts", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const group = blocks[0] as ContextGroupBlock;
      expect(group.tools).toHaveLength(4);
    });

    it("non-context tool breaks context grouping", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTool("Grep", "pattern", now + 200);
      builder.pushTool("Bash", "ls", now + 300); // non-context tool breaks grouping
      builder.pushTool("Read", "file5.ts", now + 400);

      const blocks = builder.getBlocks();
      // ContextGroup(3), Tool(Bash), Tool(Read) — single Read can't form a group
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("contextGroup");
      expect(blocks[1].kind).toBe("tool");
      expect(blocks[2].kind).toBe("tool");
    });

    it("context grouping is case-insensitive", () => {
      const now = Date.now();
      builder.pushTool("read", "file1.ts", now);
      builder.pushTool("GLOB", "**/*.ts", now + 100);
      builder.pushTool("grep", "pattern", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("contextGroup");
    });

    it("WebSearch and WebFetch are treated as context tools for grouping", () => {
      const now = Date.now();
      builder.pushTool("WebSearch", "query 1", now);
      builder.pushTool("WebFetch", "https://example.com", now + 100);
      builder.pushTool("Glob", "**/*.md", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("contextGroup");
      const group = blocks[0] as ContextGroupBlock;
      expect(group.tools).toHaveLength(3);
    });

    it("context tools inside an agent are NOT grouped at top level", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.pushTool("Read", "file1.ts", now + 100);
      builder.pushTool("Glob", "**/*.ts", now + 200);
      builder.pushTool("Grep", "pattern", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      // Children are plain ToolBlocks, not grouped
      const agent = blocks[0] as AgentBlock;
      expect(agent.children).toHaveLength(3);
      expect(agent.children[0].name).toBe("Read");
    });
  });

  // ── Reset ──

  describe("reset", () => {
    it("clears all state", () => {
      const now = Date.now();
      builder.pushText("hello", now);
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.reset();

      expect(builder.getBlocks()).toEqual([]);
      expect(builder.hasChanged()).toBe(false);
    });

    it("reset allows fresh accumulation", () => {
      builder.pushText("old", Date.now());
      builder.reset();
      builder.pushText("new", Date.now());

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as TextBlock).content).toBe("new");
    });
  });

  // ── Dirty flag / hasChanged ──

  describe("hasChanged / getBlocks", () => {
    it("hasChanged returns false initially", () => {
      expect(builder.hasChanged()).toBe(false);
    });

    it("hasChanged returns true after a push", () => {
      builder.pushText("hello", Date.now());
      expect(builder.hasChanged()).toBe(true);
    });

    it("getBlocks clears the dirty flag", () => {
      builder.pushText("hello", Date.now());
      expect(builder.hasChanged()).toBe(true);
      builder.getBlocks();
      expect(builder.hasChanged()).toBe(false);
    });

    it("getBlocks returns new array reference when dirty", () => {
      builder.pushText("hello", Date.now());
      const blocks1 = builder.getBlocks();
      builder.pushText(" world", Date.now());
      const blocks2 = builder.getBlocks();
      expect(blocks1).not.toBe(blocks2);
    });

    it("getBlocks returns same reference when not dirty", () => {
      builder.pushText("hello", Date.now());
      const blocks1 = builder.getBlocks();
      const blocks2 = builder.getBlocks();
      expect(blocks1).toBe(blocks2);
    });
  });

  // ── Block cap ──

  describe("block cap", () => {
    it("caps blocks at 5000, dropping oldest on overflow", () => {
      const now = Date.now();
      for (let i = 0; i < 5010; i++) {
        // Alternate text and tool to prevent text merging
        builder.pushTool(`Tool${i}`, `detail-${i}`, now + i);
      }
      const blocks = builder.getBlocks();
      expect(blocks.length).toBeLessThanOrEqual(5000);
      // Oldest blocks should have been dropped
      const firstTool = blocks[0] as ToolBlock;
      expect(firstTool.name).toBe("Tool10");
    });
  });

  // ── Multiple agents ──

  describe("multiple agents", () => {
    it("pushToolToAgent routes tool to a specific agent by ID", () => {
      const now = Date.now();
      builder.startAgent("a1", "Explore", "First", now);
      builder.completeAgent("a1", 500, 0);

      builder.startAgent("a2", "Plan", "Second", now + 100);
      // Route a tool explicitly to the completed agent a1
      const routed = builder.pushToolToAgent("a1", "Read", "file.ts", now + 200);
      expect(routed).toBe(true);

      const blocks = builder.getBlocks();
      const agent1 = blocks[0] as AgentBlock;
      const agent2 = blocks[1] as AgentBlock;
      expect(agent1.children).toHaveLength(1);
      expect(agent1.children[0].name).toBe("Read");
      expect(agent2.children).toHaveLength(0);
    });

    it("pushToolToAgent returns false for unknown agent ID", () => {
      const routed = builder.pushToolToAgent("unknown", "Read", "file.ts", Date.now());
      expect(routed).toBe(false);
    });

    it("second agent gets its own tools", () => {
      const now = Date.now();
      builder.startAgent("a1", "Explore", "First", now);
      builder.pushTool("Read", "inside-a1.ts", now + 100);
      builder.completeAgent("a1", 500, 1);

      builder.startAgent("a2", "Plan", "Second", now + 200);
      builder.pushTool("Grep", "inside-a2.ts", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      const agent1 = blocks[0] as AgentBlock;
      const agent2 = blocks[1] as AgentBlock;
      expect(agent1.children).toHaveLength(1);
      expect(agent1.children[0].name).toBe("Read");
      expect(agent2.children).toHaveLength(1);
      expect(agent2.children[0].name).toBe("Grep");
    });
  });
});
