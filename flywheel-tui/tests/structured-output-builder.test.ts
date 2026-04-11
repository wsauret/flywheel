import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder";
import type { AnyBlock, TextBlock, ToolBlock, AgentBlock, SystemBlock, TodoListBlock, UserMessageBlock } from "../src/tui/types";

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
      builder.pushTool("task_complete", "done", now + 100); // excluded from context grouping
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
    it("creates a standalone ToolBlock for excluded tools", () => {
      builder.pushTool("task_complete", "done", Date.now());
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("tool");
      const tool = blocks[0] as ToolBlock;
      expect(tool.name).toBe("task_complete");
      expect(tool.detail).toBe("done");
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

    it("tool routed via pushToolToAgent is added to AgentBlock.children", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.pushToolToAgent("agent-1", "Read", "file.ts", now + 100);
      builder.pushToolToAgent("agent-1", "Grep", "pattern", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as AgentBlock;
      expect(agent.children).toHaveLength(2);
      expect(agent.children[0].name).toBe("Read");
      expect(agent.children[1].name).toBe("Grep");
    });

    it("pushTool does NOT capture into active agent (explicit routing only)", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.pushTool("task_complete", "done", now + 100);

      const blocks = builder.getBlocks();
      // Agent block + standalone tool — pushTool never captures
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).children).toHaveLength(0);
      expect(blocks[1].kind).toBe("tool");
    });

    it("agent children are capped at 50", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Heavy search", now);
      for (let i = 0; i < 60; i++) {
        builder.pushToolToAgent("agent-1", `Tool${i}`, `detail-${i}`, now + i);
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
      builder.pushToolToAgent("agent-1", "Read", "file.ts", now);
      builder.pushToolToAgent("agent-1", "Grep", "pattern", now);
      builder.pushToolToAgent("agent-1", "Write", "out.ts", now);
      builder.completeAgent("agent-1", 1500);

      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.status).toBe("completed");
      expect(agent.duration).toBe(1500);
      expect(agent.children).toHaveLength(3);
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
      builder.pushToolToAgent("agent-1", "Read", "inside.ts", now + 100);
      builder.completeAgent("agent-1", 500);
      builder.pushTool("task_complete", "done", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect(blocks[1].kind).toBe("tool");
      expect((blocks[1] as ToolBlock).name).toBe("task_complete");
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
      builder.completeAgent("unknown-id", 100);
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
    it("first context tool creates a Tools AgentBlock immediately", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Tools");
      expect(agent.description).toBe("Using tools...");
      expect(agent.status).toBe("active");
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].name).toBe("Read");
      expect(agent.latestChild).toBe("Read: file1.ts");
    });

    it("consecutive tools accumulate in the same Tools AgentBlock", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Read", "file2.ts", now + 100);
      builder.pushTool("Glob", "**/*.ts", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Tools");
      expect(agent.children).toHaveLength(3);
      expect(agent.children[0].name).toBe("Read");
      expect(agent.children[1].name).toBe("Read");
      expect(agent.children[2].name).toBe("Glob");
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

    it("excluded tool breaks context grouping and completes the Tools agent", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTool("Grep", "pattern", now + 200);
      builder.pushTool("task_complete", "done", now + 300); // excluded tool breaks grouping

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Tools");
      expect(agent.status).toBe("completed");
      expect(agent.children).toHaveLength(3);
      expect(agent.duration).toBe(300);
      expect(blocks[1].kind).toBe("tool");
    });

    it("new tool after break starts a new Tools agent", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTool("task_complete", "done", now + 200); // break
      builder.pushTool("Read", "file5.ts", now + 300); // new context run

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect(blocks[1].kind).toBe("tool");
      expect(blocks[2].kind).toBe("agent");
      expect((blocks[2] as AgentBlock).status).toBe("active");
      expect((blocks[2] as AgentBlock).children).toHaveLength(1);
    });

    it("tool grouping is case-insensitive", () => {
      const now = Date.now();
      builder.pushTool("read", "file1.ts", now);
      builder.pushTool("GLOB", "**/*.ts", now + 100);
      builder.pushTool("grep", "pattern", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).agentLabel).toBe("Tools");
    });

    it("Bash and Edit are grouped alongside Read/Grep/Glob", () => {
      const now = Date.now();
      builder.pushTool("Read", "file.ts", now);
      builder.pushTool("Bash", "ls -la", now + 100);
      builder.pushTool("Edit", "file.ts", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Tools");
      expect(agent.children).toHaveLength(3);
    });

    it("context tools routed to a real agent are plain children, not grouped", () => {
      const now = Date.now();
      builder.startAgent("agent-1", "Explore", "Searching", now);
      builder.pushToolToAgent("agent-1", "Read", "file1.ts", now + 100);
      builder.pushToolToAgent("agent-1", "Glob", "**/*.ts", now + 200);
      builder.pushToolToAgent("agent-1", "Grep", "pattern", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
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

    it("starting a real agent breaks tool grouping run", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.startAgent("agent-1", "Explore", "Searching", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).agentLabel).toBe("Tools");
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
      builder.pushTool("task_complete", "done", now + 100);
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
      builder.completeAgent("agent-1", 200);

      builder.resetTracking();

      // Starting a new agent with the same ID should create a new block,
      // not try to append to the old one
      builder.startAgent("agent-1", "Explore", "Searching again", now + 300);
      builder.pushText("new agent output", now + 400);
      builder.completeAgent("agent-1", 200);

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
    it("caps blocks at 20000, dropping oldest on overflow", () => {
      const now = Date.now();
      for (let i = 0; i < 20_010; i++) {
        // Alternate text and excluded tool to prevent merging/grouping
        builder.pushText(`text-${i}\n`, now + i * 2);
        builder.pushTool("task_complete", `detail-${i}`, now + i * 2 + 1);
      }
      const blocks = builder.getBlocks();
      expect(blocks.length).toBeLessThanOrEqual(20_000);
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

    it("system message breaks tool grouping run", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushSystemMessage("step started\n", now + 200);
      builder.pushTool("Grep", "pattern", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).agentLabel).toBe("Tools");
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect((blocks[0] as AgentBlock).children).toHaveLength(2);
      expect(blocks[1].kind).toBe("system");
      expect(blocks[2].kind).toBe("agent");
      expect((blocks[2] as AgentBlock).agentLabel).toBe("Tools");
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
      builder.completeAgent("a1", 500);

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
      builder.pushToolToAgent("a1", "Read", "file.ts", Date.now());
      builder.pushToolToAgent("a1", "Grep", "pattern", Date.now());

      expect(activities).toEqual(["a1", "a1"]);
    });

    it("onAgentActivity fires for pushToolToAgent", () => {
      const activities: string[] = [];
      builder.onAgentActivity = (id) => activities.push(id);

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.completeAgent("a1", 100);
      builder.pushToolToAgent("a1", "Read", "file.ts", Date.now());

      expect(activities).toEqual(["a1"]);
    });

    it("callbacks are optional — no error when not set", () => {
      // No callbacks set — should not throw
      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.pushToolToAgent("a1", "Read", "file.ts", Date.now());
      builder.completeAgent("a1", 100);
      expect(builder.getBlocks()).toHaveLength(1);
    });
  });

  // ── Multiple agents ──

  describe("multiple agents", () => {
    it("pushToolToAgent routes tool to a specific agent by ID", () => {
      const now = Date.now();
      builder.startAgent("a1", "Explore", "First", now);
      builder.completeAgent("a1", 500);

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
      builder.pushToolToAgent("a1", "Read", "inside-a1.ts", now + 100);
      builder.completeAgent("a1", 500);

      builder.startAgent("a2", "Plan", "Second", now + 200);
      builder.pushToolToAgent("a2", "Grep", "inside-a2.ts", now + 300);

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

  // ── closeOpenSubagents (blocking invariant) ──

  describe("closeOpenSubagents", () => {
    it("auto-completes active agents", () => {
      const now = Date.now();
      builder.startAgent("a1", "Explore", "Searching", now);
      builder.closeOpenSubagents(now + 5000);

      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.status).toBe("completed");
      expect(agent.duration).toBe(5000);
    });

    it("does not affect context group agents", () => {
      const now = Date.now();
      // Create a context group by pushing context tools
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);

      builder.closeOpenSubagents(now + 200);

      // Context group should still be active (not auto-completed)
      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Tools");
      expect(agent.status).toBe("active");
    });

    it("does not affect already-completed agents", () => {
      const now = Date.now();
      builder.startAgent("a1", "Explore", "Searching", now);
      builder.completeAgent("a1", 1000);
      builder.closeOpenSubagents(now + 5000);

      const agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.status).toBe("completed");
      expect(agent.duration).toBe(1000); // original duration preserved
    });

    it("closes multiple active agents", () => {
      const now = Date.now();
      builder.startAgent("a1", "Explore", "First", now);
      builder.startAgent("a2", "Plan", "Second", now + 100);
      builder.closeOpenSubagents(now + 5000);

      const blocks = builder.getBlocks();
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect((blocks[1] as AgentBlock).status).toBe("completed");
    });
  });

  // ── Pinned zone (pending messages + todo) ──

  describe("pinned zone ordering", () => {
    it("pending messages stay pinned below new content", () => {
      const now = Date.now();
      builder.pushText("initial output", now);
      builder.pushUserMessage("follow-up", now + 100, true);
      // Agent keeps working — new content goes before the pending message
      builder.pushSystemMessage("step completed", now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("text");
      expect(blocks[1].kind).toBe("system");
      expect(blocks[2].kind).toBe("userMessage");
      expect((blocks[2] as UserMessageBlock).pending).toBe(true);
    });

    it("pending messages pin above todo, both below content", () => {
      const now = Date.now();
      builder.pushText("output", now);
      builder.pushTodoWrite([{ content: "Task", status: "in_progress" }], now + 100);
      builder.pushUserMessage("follow-up", now + 200, true);
      builder.pushSystemMessage("step done", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(4);
      expect(blocks[0].kind).toBe("text");
      expect(blocks[1].kind).toBe("system");
      expect(blocks[2].kind).toBe("userMessage");
      expect(blocks[3].kind).toBe("todoList");
    });

    it("multiple pending messages maintain order within pinned zone", () => {
      const now = Date.now();
      builder.pushText("output", now);
      builder.pushTodoWrite([{ content: "Task", status: "in_progress" }], now + 100);
      builder.pushUserMessage("first follow-up", now + 200, true);
      builder.pushUserMessage("second follow-up", now + 300, true);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(4);
      expect(blocks[0].kind).toBe("text");
      expect((blocks[1] as UserMessageBlock).content).toBe("first follow-up");
      expect((blocks[2] as UserMessageBlock).content).toBe("second follow-up");
      expect(blocks[3].kind).toBe("todoList");
    });

    it("resolvePendingMessages moves messages out of pinned zone into content", () => {
      const now = Date.now();
      builder.pushText("output", now);
      builder.pushTodoWrite([{ content: "Task", status: "in_progress" }], now + 100);
      builder.pushUserMessage("follow-up", now + 200, true);

      // Before resolve: [text, pending, todo]
      expect(builder.getBlocks()[1].kind).toBe("userMessage");
      expect((builder.getBlocks()[1] as UserMessageBlock).pending).toBe(true);

      builder.resolvePendingMessages();

      // After resolve: [text, resolved, todo] — resolved is content now
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("text");
      expect(blocks[1].kind).toBe("userMessage");
      expect((blocks[1] as UserMessageBlock).pending).toBe(false);
      expect(blocks[2].kind).toBe("todoList");

      // New content goes after the resolved message, before todo
      builder.pushSystemMessage("agent responds", now + 400);
      const after = builder.getBlocks();
      expect(after).toHaveLength(4);
      expect(after[2].kind).toBe("system");
      expect(after[3].kind).toBe("todoList");
    });

    it("agent blocks insert before pinned zone with correct index tracking", () => {
      const now = Date.now();
      builder.pushTodoWrite([{ content: "Task", status: "in_progress" }], now);
      builder.pushUserMessage("queued msg", now + 100, true);

      builder.startAgent("a1", "Worker", "Doing work", now + 200);
      builder.pushToolToAgent("a1", "Read", "file.ts", now + 300);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).children).toHaveLength(1);
      expect(blocks[1].kind).toBe("userMessage");
      expect(blocks[2].kind).toBe("todoList");
    });
  });

  // ── TodoWrite ──

  describe("pushTodoWrite", () => {
    it("creates a TodoListBlock on first call", () => {
      const now = Date.now();
      builder.pushTodoWrite([
        { content: "Run tests", status: "in_progress" },
        { content: "Fix bug", status: "pending" },
      ], now);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("todoList");
      const todo = blocks[0] as TodoListBlock;
      expect(todo.todos).toHaveLength(2);
      expect(todo.todos[0].content).toBe("Run tests");
      expect(todo.todos[0].status).toBe("in_progress");
      expect(todo.todos[1].content).toBe("Fix bug");
      expect(todo.todos[1].status).toBe("pending");
    });

    it("updates the existing TodoListBlock in place on subsequent calls", () => {
      const now = Date.now();
      builder.pushTodoWrite([
        { content: "Run tests", status: "in_progress" },
        { content: "Fix bug", status: "pending" },
      ], now);

      builder.pushTodoWrite([
        { content: "Run tests", status: "completed" },
        { content: "Fix bug", status: "in_progress" },
      ], now + 100);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const todo = blocks[0] as TodoListBlock;
      expect(todo.todos[0].status).toBe("completed");
      expect(todo.todos[1].status).toBe("in_progress");
    });

    it("removes the TodoListBlock when given an empty array", () => {
      const now = Date.now();
      builder.pushTodoWrite([
        { content: "Run tests", status: "in_progress" },
      ], now);
      expect(builder.getBlocks()).toHaveLength(1);

      builder.pushTodoWrite([], now + 100);
      expect(builder.getBlocks()).toHaveLength(0);
    });

    it("stays pinned at the end as new blocks are added", () => {
      const now = Date.now();
      builder.pushText("some output", now);
      builder.pushTodoWrite([
        { content: "Task A", status: "pending" },
      ], now + 100);
      builder.pushSystemMessage("step completed", now + 200);

      // New blocks insert before the todo — todo stays pinned last
      let blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[0].kind).toBe("text");
      expect(blocks[1].kind).toBe("system");
      expect(blocks[2].kind).toBe("todoList");

      // Update the todo in place — still pinned last
      builder.pushTodoWrite([
        { content: "Task A", status: "completed" },
      ], now + 300);

      blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect(blocks[2].kind).toBe("todoList");
      expect((blocks[2] as TodoListBlock).todos[0].status).toBe("completed");
    });

    it("breaks context tool grouping", () => {
      const now = Date.now();
      builder.pushTool("Read", "file1.ts", now);
      builder.pushTool("Glob", "**/*.ts", now + 100);
      builder.pushTodoWrite([
        { content: "Process files", status: "in_progress" },
      ], now + 200);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent"); // completed Tools group
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect(blocks[1].kind).toBe("todoList");
    });

    it("reset clears todo tracking", () => {
      const now = Date.now();
      builder.pushTodoWrite([
        { content: "Task", status: "pending" },
      ], now);
      builder.reset();

      // After reset, a new pushTodoWrite should create a fresh block
      builder.pushTodoWrite([
        { content: "New task", status: "in_progress" },
      ], now + 100);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect((blocks[0] as TodoListBlock).todos[0].content).toBe("New task");
    });

    it("resetTracking clears todo index", () => {
      const now = Date.now();
      builder.pushTodoWrite([
        { content: "Task", status: "pending" },
      ], now);
      builder.resetTracking();

      // After resetTracking, a new pushTodoWrite creates a second block
      // (old block is preserved but no longer tracked)
      builder.pushTodoWrite([
        { content: "New task", status: "in_progress" },
      ], now + 100);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("todoList");
      expect(blocks[1].kind).toBe("todoList");
    });
  });

});
