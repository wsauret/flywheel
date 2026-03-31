import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../src/tui/adapters/structured-output-builder";
import type { AnyBlock, TextBlock, ToolBlock, AgentBlock, SystemBlock } from "../src/tui/types";

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
      builder.pushTool("Bash", "ls -la", now + 100); // non-context tool stays as ToolBlock
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

  // ── Context grouping (as synthetic AgentBlock) ──

  describe("context grouping", () => {
    it("first context tool creates a Context AgentBlock immediately", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Context");
      expect(agent.description).toBe("Gathering context...");
      expect(agent.status).toBe("active");
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].name).toBe("Read");
      expect(agent.latestChild).toBe("Read: file1.ts");
    });

    it("consecutive context tools accumulate in the same Context AgentBlock", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Read", "file2.ts", now + 100);
      builder.pushTool("Glob", "**/*.ts", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Context");
      expect(agent.children).toHaveLength(3);
      expect(agent.children[0].name).toBe("Read");
      expect(agent.children[1].name).toBe("Read");
      expect(agent.children[2].name).toBe("Glob");
      // latestChild shows the most recent tool
      expect(agent.latestChild).toBe("Glob: **/*.ts");
    });

    it("context group grows with additional context tools", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTool("Grep", "pattern", now + 200);
      builder.pushTool("Read", "file4.ts", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as AgentBlock;
      expect(agent.children).toHaveLength(4);
    });

    it("non-context tool breaks context grouping and completes the Context agent", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTool("Grep", "pattern", now + 200);
      builder.pushTool("Bash", "ls", now + 300); // non-context tool breaks grouping

      const blocks = builder.getBlocks();
      // Context AgentBlock (completed) + Tool(Bash)
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Context");
      expect(agent.status).toBe("completed");
      expect(agent.toolCount).toBe(3);
      expect(agent.duration).toBe(300); // 300 - 0 = 300ms
      expect(blocks[1].kind).toBe("tool");
    });

    it("new context tool after break starts a new Context agent", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTool("Bash", "ls", now + 200); // break
      builder.pushTool("Read", "file5.ts", now + 300); // new context run

      const blocks = builder.getBlocks();
      // Context AgentBlock (completed) + Tool(Bash) + Context AgentBlock (active)
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect(blocks[1].kind).toBe("tool");
      expect(blocks[2].kind).toBe("agent");
      expect((blocks[2] as AgentBlock).status).toBe("active");
      expect((blocks[2] as AgentBlock).children).toHaveLength(1);
    });

    it("context grouping is case-insensitive", () => {
      const now = Date.now();
      builder.pushTool("read", "file1.ts", now);
      builder.pushTool("GLOB", "**/*.ts", now + 100);
      builder.pushTool("grep", "pattern", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).agentLabel).toBe("Context");
    });

    it("WebSearch and WebFetch are treated as context tools for grouping", () => {
      const now = Date.now();
      builder.pushTool("WebSearch", "query 1", now);
      builder.pushTool("WebFetch", "https://example.com", now + 100);
      builder.pushTool("Glob", "**/*.md", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Context");
      expect(agent.children).toHaveLength(3);
    });

    it("context tools inside a real agent are NOT grouped as Context agent", () => {
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
      expect(agent.agentLabel).toBe("Explore");
      expect(agent.children).toHaveLength(3);
      expect(agent.children[0].name).toBe("Read");
    });

    it("text breaks context run and completes Context agent", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushText("some output", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect(blocks[1].kind).toBe("text");
    });

    it("system message breaks context run and completes Context agent", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushSystemMessage("step started\n", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect(blocks[1].kind).toBe("system");
    });

    it("starting a real agent breaks context run", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.startAgent("agent-1", "Explore", "Searching", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).agentLabel).toBe("Context");
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect(blocks[1].kind).toBe("agent");
      expect((blocks[1] as AgentBlock).agentLabel).toBe("Explore");
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

  // ── resetTracking ──

  describe("resetTracking", () => {
    it("preserves accumulated blocks", () => {
      const now = Date.now();
      builder.pushText("line 1", now);
      builder.pushTool("Bash", "ls", now + 100);
      builder.getBlocks(); // clear dirty flag

      builder.resetTracking();

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("text");
      expect(blocks[1].kind).toBe("tool");
    });

    it("marks builder as dirty after resetTracking", () => {
      const now = Date.now();
      builder.pushText("hello", now);
      builder.getBlocks(); // clear dirty flag
      expect(builder.hasChanged()).toBe(false);

      builder.resetTracking();

      expect(builder.hasChanged()).toBe(true);
    });

    it("clears agent tracking so new agents get fresh indices", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.pushText("agent output", now + 100);
      builder.completeAgent("agent-1", 200, 1);

      builder.resetTracking();

      // Starting a new agent with the same ID should create a new block,
      // not try to append to the old one
      builder.startAgent("agent-1", "Explore", "Searching again", now + 300);
      builder.pushText("new agent output", now + 400);
      builder.completeAgent("agent-1", 200, 1);

      const blocks = builder.getBlocks();
      const agentBlocks = blocks.filter((b) => b.kind === "agent");
      expect(agentBlocks).toHaveLength(2);
    });

    it("new text after resetTracking appends to existing blocks", () => {
      const now = Date.now();
      builder.pushText("before reset\n", now);
      builder.resetTracking();
      builder.pushText("after reset\n", now + 100);

      const blocks = builder.getBlocks();
      // Text should merge into the existing text block (consecutive text merges)
      const textBlocks = blocks.filter((b) => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      expect((textBlocks[0] as TextBlock).content).toContain("before reset");
      expect((textBlocks[0] as TextBlock).content).toContain("after reset");
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

  // ── System messages ──

  describe("pushSystemMessage", () => {
    it("creates a SystemBlock", () => {
      const now = Date.now();
      builder.pushSystemMessage("▸ Step 0: Run tests\n", now);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("system");
      const sys = blocks[0] as SystemBlock;
      expect(sys.message).toBe("▸ Step 0: Run tests\n");
      expect(sys.timestamp).toBe(now);
    });

    it("consecutive system messages create separate SystemBlocks (no merging)", () => {
      const now = Date.now();
      builder.pushSystemMessage("first\n", now);
      builder.pushSystemMessage("second\n", now + 100);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("system");
      expect(blocks[1].kind).toBe("system");
    });

    it("system message breaks context run", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushSystemMessage("step started\n", now + 200);
      builder.pushTool("Grep", "pattern", now + 300);

      const blocks = builder.getBlocks();
      // Context AgentBlock (completed, 2 tools), SystemBlock, Context AgentBlock (active, 1 tool)
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).agentLabel).toBe("Context");
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect((blocks[0] as AgentBlock).children).toHaveLength(2);
      expect(blocks[1].kind).toBe("system");
      expect(blocks[2].kind).toBe("agent");
      expect((blocks[2] as AgentBlock).agentLabel).toBe("Context");
      expect((blocks[2] as AgentBlock).status).toBe("active");
    });

    it("system message after text creates separate block", () => {
      const now = Date.now();
      builder.pushText("some output\n", now);
      builder.pushSystemMessage("system event\n", now + 100);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("text");
      expect(blocks[1].kind).toBe("system");
    });

    it("text after system message creates new TextBlock", () => {
      const now = Date.now();
      builder.pushSystemMessage("system event\n", now);
      builder.pushText("output\n", now + 100);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("system");
      expect(blocks[1].kind).toBe("text");
    });
  });

  // ── Lifecycle callbacks ──

  describe("lifecycle callbacks", () => {
    it("onAgentLifecycle fires 'start' when agent is started", () => {
      const events: Array<{ type: string; id: string }> = [];
      builder.onAgentLifecycle = (type, id) => events.push({ type, id });

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "start", id: "a1" });
    });

    it("onAgentLifecycle fires 'complete' when agent is completed", () => {
      const events: Array<{ type: string; id: string }> = [];
      builder.onAgentLifecycle = (type, id) => events.push({ type, id });

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.completeAgent("a1", 500, 2);

      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({ type: "complete", id: "a1" });
    });

    it("onAgentLifecycle fires 'error' when agent errors", () => {
      const events: Array<{ type: string; id: string }> = [];
      builder.onAgentLifecycle = (type, id) => events.push({ type, id });

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.errorAgent("a1", "timeout");

      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({ type: "error", id: "a1" });
    });

    it("onAgentActivity fires when tool is added to agent", () => {
      const activities: string[] = [];
      builder.onAgentActivity = (id) => activities.push(id);

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.pushTool("Read", "file.ts", Date.now());
      builder.pushTool("Grep", "pattern", Date.now());

      expect(activities).toEqual(["a1", "a1"]);
    });

    it("onAgentActivity fires for pushToolToAgent", () => {
      const activities: string[] = [];
      builder.onAgentActivity = (id) => activities.push(id);

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.completeAgent("a1", 100, 0);
      builder.pushToolToAgent("a1", "Read", "file.ts", Date.now());

      expect(activities).toEqual(["a1"]);
    });

    it("callbacks are optional — no error when not set", () => {
      // No callbacks set — should not throw
      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.pushTool("Read", "file.ts", Date.now());
      builder.completeAgent("a1", 100, 1);
      expect(builder.getBlocks()).toHaveLength(1);
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
