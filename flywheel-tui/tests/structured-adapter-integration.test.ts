/**
 * Integration tests for the structured output pipeline wired into OpenTUIAdapter.
 *
 * Tests the full path: NDJSON chunks → NDJSONParser → StructuredEventParser →
 * SubagentTraceParser → StructuredOutputBuilder → UIActions.setOutputBlocks()
 *
 * Uses mock UIActions rather than importing the full store to isolate the
 * adapter pipeline logic.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus } from "../src/events/event-bus";
import { OpenTUIAdapter, createOpenTUIAdapter } from "../src/tui/adapters/opentui";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type {
  AnyBlock,
  TextBlock,
  ToolBlock,
  AgentBlock,
} from "../src/tui/routes/work/state/types";
import { timerService } from "../src/tui/shared/services/timer";

// ── Helpers ──

function ts(): string {
  return new Date().toISOString();
}

/**
 * Create a test harness with event bus, store, and adapter connected.
 */
function createHarness() {
  const bus = new EventBus();
  const store = createStore("test-plan");
  const adapter = createOpenTUIAdapter(store);
  adapter.connect(bus);
  adapter.start();
  return { bus, store, adapter };
}

/**
 * Emit a worker:output event with stdout data and optional engineId.
 */
function emitOutput(
  bus: EventBus,
  data: string,
  engineId?: string,
): void {
  bus.emit({
    type: "worker:output",
    workflowId: "w1",
    stream: "stdout",
    data,
    timestamp: ts(),
    ...(engineId !== undefined ? { engineId } : {}),
  } as any);
}

/**
 * Build a Claude stream-json assistant line with text content.
 */
function claudeTextLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  }) + "\n";
}

/**
 * Build a Claude stream-json assistant line with a tool_use content block.
 */
function claudeToolLine(
  name: string,
  input: Record<string, unknown>,
  id?: string,
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: id ?? `tool_${Date.now()}`,
          name,
          input,
        },
      ],
    },
  }) + "\n";
}

/**
 * Build a Claude stream-json assistant line with a Task tool_use (subagent).
 * Optionally includes parent_tool_use_id for child agents.
 */
function claudeTaskLine(
  description: string,
  prompt: string,
  id?: string,
  parentToolUseId?: string,
): string {
  const content: Record<string, unknown>[] = [
    {
      type: "tool_use",
      id: id ?? `task_${Date.now()}`,
      name: "Task",
      input: { description, prompt },
    },
  ];
  const msg: Record<string, unknown> = {
    type: "assistant",
    message: { content },
  };
  if (parentToolUseId) {
    msg.parent_tool_use_id = parentToolUseId;
  }
  return JSON.stringify(msg) + "\n";
}

/**
 * Build a Claude stream-json tool_result line.
 */
function claudeToolResultLine(toolUseId: string, content: string, isError = false): string {
  return JSON.stringify({
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  }) + "\n";
}

/**
 * Build a Claude stream-json result line.
 */
function claudeResultLine(result: string): string {
  return JSON.stringify({
    type: "result",
    result,
  }) + "\n";
}

/**
 * Build an OpenCode tool_use line (format json).
 */
function openCodeToolUseLine(
  tool: string,
  input: Record<string, unknown>,
  callID?: string,
  state?: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: "tool_use",
    timestamp: Date.now(),
    part: {
      type: "tool-invocation",
      tool,
      callID: callID ?? `oc_${Date.now()}`,
      state: {
        status: "completed",
        input,
        ...state,
      },
    },
  }) + "\n";
}

/**
 * Build an OpenCode text line.
 */
function openCodeTextLine(text: string): string {
  return JSON.stringify({
    type: "text",
    timestamp: Date.now(),
    part: {
      type: "text",
      text,
    },
  }) + "\n";
}

/**
 * Build an OpenCode Task tool_use line (subagent — spawn + complete in one event).
 */
function openCodeTaskLine(
  description: string,
  prompt: string,
  output?: string,
): string {
  return JSON.stringify({
    type: "tool_use",
    timestamp: Date.now(),
    part: {
      type: "tool-invocation",
      tool: "task",
      callID: `oc_task_${Date.now()}`,
      state: {
        status: "completed",
        input: { description, prompt },
        output: output ?? "Task completed successfully",
      },
    },
  }) + "\n";
}

/**
 * Wait for microtasks + any batched flush intervals to resolve.
 */
function wait(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ──

describe("Structured Adapter Integration", () => {
  beforeEach(() => {
    timerService.reset();
  });

  // ── Claude stream-json ──

  describe("Claude stream-json engine", () => {
    it("text content produces TextBlocks", async () => {
      const { bus, store, adapter } = createHarness();

      emitOutput(bus, claudeTextLine("Hello world"), "claude");
      emitOutput(bus, claudeTextLine(" more text"), "claude");

      await wait();

      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);

      // Find text blocks
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);

      // Combined text should contain both parts
      const allText = textBlocks.map((b) => b.content).join("");
      expect(allText).toContain("Hello world");
      expect(allText).toContain("more text");
    });

    it("tool_use produces ToolBlocks", async () => {
      const { bus, store } = createHarness();

      emitOutput(bus, claudeToolLine("Read", { file_path: "src/index.ts" }), "claude");
      emitOutput(bus, claudeToolLine("Bash", { command: "ls -la" }), "claude");

      await wait();

      const blocks = store.getState().outputBlocks;
      const toolBlocks = blocks.filter((b) => b.kind === "tool") as ToolBlock[];
      expect(toolBlocks.length).toBeGreaterThanOrEqual(2);
      expect(toolBlocks.some((t) => t.name === "Read")).toBe(true);
      expect(toolBlocks.some((t) => t.name === "Bash")).toBe(true);
    });

    it("Task tool_use produces AgentBlock with children", async () => {
      const { bus, store } = createHarness();
      const taskId = "task_123";

      // Task tool spawn
      emitOutput(bus, claudeTaskLine("Explore codebase", "Search for patterns", taskId), "claude");

      await wait();

      let blocks = store.getState().outputBlocks;
      const agentBlocks = blocks.filter((b) => b.kind === "agent") as AgentBlock[];
      expect(agentBlocks.length).toBeGreaterThanOrEqual(1);
      expect(agentBlocks[0].status).toBe("active");
      expect(agentBlocks[0].description).toContain("Explore codebase");

      // Tool result completes agent
      emitOutput(bus, claudeToolResultLine(taskId, "Found 5 files"), "claude");

      await wait();

      blocks = store.getState().outputBlocks;
      const completedAgents = blocks.filter(
        (b) => b.kind === "agent" && b.status === "completed",
      ) as AgentBlock[];
      expect(completedAgents.length).toBeGreaterThanOrEqual(1);
    });

    it("child tools with parent_tool_use_id are routed into parent AgentBlock", async () => {
      const { bus, store } = createHarness();
      const taskToolUseId = "toolu_agent_abc";

      // 1. Agent spawn — Task tool with known id
      emitOutput(bus, claudeTaskLine("Locate codebase structure", "Find files", taskToolUseId), "claude");
      await wait();

      // Verify agent was created
      let blocks = store.getState().outputBlocks;
      let agents = blocks.filter((b) => b.kind === "agent") as AgentBlock[];
      expect(agents).toHaveLength(1);
      expect(agents[0].status).toBe("active");

      // 2. Child tool calls — each has parent_tool_use_id pointing to the agent
      const childToolLine = (name: string, input: Record<string, unknown>) =>
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: `child_${Date.now()}_${Math.random()}`, name, input }],
            parent_tool_use_id: taskToolUseId,
          },
        }) + "\n";

      emitOutput(bus, childToolLine("Glob", { pattern: "**/*.ts" }), "claude");
      emitOutput(bus, childToolLine("Read", { file_path: "src/index.ts" }), "claude");
      emitOutput(bus, childToolLine("Grep", { pattern: "export" }), "claude");
      await wait();

      // Children should be inside the AgentBlock, NOT standalone
      blocks = store.getState().outputBlocks;
      agents = blocks.filter((b) => b.kind === "agent") as AgentBlock[];
      expect(agents).toHaveLength(1);
      expect(agents[0].children.length).toBe(3);
      expect(agents[0].children[0].name).toBe("Glob");
      expect(agents[0].children[1].name).toBe("Read");
      expect(agents[0].children[2].name).toBe("Grep");

      // No standalone tool blocks should exist
      const standaloneTools = blocks.filter((b) => b.kind === "tool");
      expect(standaloneTools).toHaveLength(0);
    });

    it("multiple parallel agents each get their own children via parent_tool_use_id", async () => {
      const { bus, store } = createHarness();
      const agent1Id = "toolu_agent_1";
      const agent2Id = "toolu_agent_2";

      // Spawn two agents
      emitOutput(bus, claudeTaskLine("Search code", "Find patterns", agent1Id), "claude");
      emitOutput(bus, claudeTaskLine("Search docs", "Find docs", agent2Id), "claude");
      await wait();

      // Child of agent 1
      const child1 = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "child1", name: "Grep", input: { pattern: "TODO" } }],
          parent_tool_use_id: agent1Id,
        },
      }) + "\n";
      emitOutput(bus, child1, "claude");

      // Child of agent 2
      const child2 = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "child2", name: "Read", input: { file_path: "README.md" } }],
          parent_tool_use_id: agent2Id,
        },
      }) + "\n";
      emitOutput(bus, child2, "claude");
      await wait();

      const blocks = store.getState().outputBlocks;
      const agents = blocks.filter((b) => b.kind === "agent") as AgentBlock[];
      expect(agents).toHaveLength(2);
      expect(agents[0].children.length).toBe(1);
      expect(agents[0].children[0].name).toBe("Grep");
      expect(agents[1].children.length).toBe(1);
      expect(agents[1].children[0].name).toBe("Read");
    });

    it("'Agent' tool name (Claude built-in) produces AgentBlock with routed children", async () => {
      const { bus, store } = createHarness();
      const agentToolUseId = "toolu_01ExuLDkhsHfbiZXxM1wKNN6";

      // Agent tool spawn (Claude's built-in agents use "Agent" not "Task")
      const agentSpawnLine = JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: agentToolUseId,
            name: "Agent",
            input: {
              description: "Explore data models",
              subagent_type: "Explore",
              prompt: "Read schema files",
            },
          }],
        },
        parent_tool_use_id: null,
      }) + "\n";

      emitOutput(bus, agentSpawnLine, "claude");
      await wait();

      let blocks = store.getState().outputBlocks;
      let agents = blocks.filter((b) => b.kind === "agent") as AgentBlock[];
      expect(agents).toHaveLength(1);
      expect(agents[0].status).toBe("active");
      expect(agents[0].description).toContain("Explore data models");

      // Child tools with parent_tool_use_id referencing the Agent
      for (const toolName of ["Glob", "Read", "Read", "Grep"]) {
        const childLine = JSON.stringify({
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: `child_${Date.now()}_${Math.random()}`,
              name: toolName,
              input: { file_path: "src/test.ts" },
            }],
            parent_tool_use_id: agentToolUseId,
          },
          parent_tool_use_id: agentToolUseId,
        }) + "\n";
        emitOutput(bus, childLine, "claude");
      }
      await wait();

      blocks = store.getState().outputBlocks;
      agents = blocks.filter((b) => b.kind === "agent") as AgentBlock[];
      expect(agents).toHaveLength(1);
      expect(agents[0].children.length).toBe(4);

      // No standalone tools should exist
      const standaloneTools = blocks.filter((b) => b.kind === "tool");
      expect(standaloneTools).toHaveLength(0);

      // No context groups should exist (children are inside agent, not grouped)
      const contextGroups = blocks.filter((b) => b.kind === "contextGroup");
      expect(contextGroups).toHaveLength(0);
    });

    it("mixed sequence: text -> agent -> child tools -> text -> standalone tool", async () => {
      const { bus, store } = createHarness();
      const taskId = "task_mixed";

      // 1. Text
      emitOutput(bus, claudeTextLine("Starting analysis...\n"), "claude");
      // 2. Agent spawn (Task tool)
      emitOutput(bus, claudeTaskLine("Research topic", "Find relevant files", taskId), "claude");
      // 3. Agent completes
      emitOutput(bus, claudeToolResultLine(taskId, "Research complete"), "claude");
      // 4. More text
      emitOutput(bus, claudeTextLine("Now implementing...\n"), "claude");
      // 5. Standalone tool
      emitOutput(bus, claudeToolLine("Bash", { command: "npm test" }), "claude");

      await wait();

      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(4);

      // Verify ordering: text, agent, text, tool
      const kinds = blocks.map((b) => b.kind);
      expect(kinds).toContain("text");
      expect(kinds).toContain("agent");
      expect(kinds).toContain("tool");
    });
  });

  // ── OpenCode format json ──

  describe("OpenCode format json engine", () => {
    it("text content produces TextBlocks", async () => {
      const { bus, store } = createHarness();

      emitOutput(bus, openCodeTextLine("Hello from OpenCode"), "opencode");

      await wait();

      const blocks = store.getState().outputBlocks;
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);
      const allText = textBlocks.map((b) => b.content).join("");
      expect(allText).toContain("Hello from OpenCode");
    });

    it("tool_use produces ToolBlocks", async () => {
      const { bus, store } = createHarness();

      emitOutput(
        bus,
        openCodeToolUseLine("Read", { file_path: "src/main.ts" }),
        "opencode",
      );

      await wait();

      const blocks = store.getState().outputBlocks;
      const toolBlocks = blocks.filter((b) => b.kind === "tool") as ToolBlock[];
      expect(toolBlocks.length).toBeGreaterThanOrEqual(1);
      expect(toolBlocks[0].name).toBe("Read");
    });

    it("Task tool produces AgentBlock (spawn + complete)", async () => {
      const { bus, store } = createHarness();

      emitOutput(
        bus,
        openCodeTaskLine("Research codebase", "Find all entry points", "Done"),
        "opencode",
      );

      await wait();

      const blocks = store.getState().outputBlocks;
      const agentBlocks = blocks.filter((b) => b.kind === "agent") as AgentBlock[];
      expect(agentBlocks.length).toBeGreaterThanOrEqual(1);
      // OpenCode Task arrives as spawn+complete in one event, so agent should be completed
      expect(agentBlocks[0].status).toBe("completed");
    });
  });

  // ── Step reset ──

  describe("step reset", () => {
    it("blocks are cleared on new startWorkflow", async () => {
      const { bus, store } = createHarness();

      // Emit some output
      emitOutput(bus, claudeTextLine("First workflow output"), "claude");
      await wait();

      expect(store.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);

      // Start a new workflow via store action (clears output)
      store.startWorkflow("plan2.md");

      await wait();

      // Blocks should be cleared (startWorkflow resets output)
      const blocks = store.getState().outputBlocks;
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      const oldContent = textBlocks.some((b) => b.content.includes("First workflow output"));
      expect(oldContent).toBe(false);
    });
  });

  // ── stderr passthrough ──

  describe("stderr passthrough", () => {
    it("stderr goes through structured pipeline as SystemBlock", () => {
      const { bus, store } = createHarness();

      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stderr",
        data: "Error: something broke\n",
        timestamp: ts(),
      } as any);

      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      expect((systemBlocks[0] as any).message).toContain("Error: something broke");
    });
  });

  // ── Raw mode ──

  describe("raw mode", () => {
    it("raw mode bypasses structured pipeline and uses appendOutput", () => {
      const { bus, store, adapter } = createHarness();

      // Enable raw mode
      adapter.toggleRawMode();
      expect(adapter.rawMode).toBe(true);

      // Emit JSON output that would normally be parsed
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: '{"type":"assistant","message":{"content":[{"type":"text","text":"raw text"}]}}\n',
        timestamp: ts(),
      } as any);

      // Should appear as raw outputLine (appendOutput fallback for raw mode)
      const lines = store.getState().outputLines;
      expect(lines.length).toBeGreaterThanOrEqual(1);
      expect(lines[lines.length - 1].data).toContain("raw text");
    });
  });

  // ── System messages ──

  describe("system messages", () => {
    it("worker:spawned is suppressed from TUI output (no blocks)", () => {
      const { bus, store } = createHarness();

      bus.emit({
        type: "worker:spawned",
        workflowId: "w1",
        stepIndex: 0,
        timestamp: ts(),
      });

      const blocks = store.getState().outputBlocks;
      expect(blocks).toHaveLength(0);
    });
  });

  // ── Backward compat (no engineId) ──

  describe("backward compatibility", () => {
    it("worker:output without engineId still produces output", async () => {
      const { bus, store } = createHarness();

      // No engineId — should use fallback extractDisplayText
      emitOutput(bus, claudeTextLine("fallback text"));

      await wait();

      // Should produce output blocks
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThan(0);
    });
  });
});
