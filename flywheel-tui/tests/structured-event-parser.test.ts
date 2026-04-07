import { describe, it, expect, beforeEach, mock } from "bun:test";
import { StructuredEventParser, isSubagentToolName } from "../src/infra/output/structured-event-parser";
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder";
import type { NDJSONEvent } from "../src/orchestration/engines/subprocess/ndjson-parser";
import type { AgentBlock, ToolBlock } from "../src/tui/types";

// ── Helpers ──

function makeAssistantEvent(content: Record<string, unknown>[]): NDJSONEvent {
  return {
    type: "assistant",
    data: {
      type: "assistant",
      message: { content },
    },
  };
}

function makeToolResultEvent(toolUseId: string, opts?: { is_error?: boolean; content?: string }): NDJSONEvent {
  return {
    type: "tool_result",
    data: {
      type: "tool_result",
      tool_use_id: toolUseId,
      is_error: opts?.is_error ?? false,
      content: opts?.content ?? "done",
    },
  };
}

// ── Tests ──

describe("isSubagentToolName", () => {
  it("recognizes Task and Agent (case-insensitive)", () => {
    expect(isSubagentToolName("Task")).toBe(true);
    expect(isSubagentToolName("task")).toBe(true);
    expect(isSubagentToolName("Agent")).toBe(true);
    expect(isSubagentToolName("agent")).toBe(true);
    expect(isSubagentToolName("AGENT")).toBe(true);
  });

  it("rejects other tool names", () => {
    expect(isSubagentToolName("Bash")).toBe(false);
    expect(isSubagentToolName("Read")).toBe(false);
    expect(isSubagentToolName("")).toBe(false);
  });
});

describe("StructuredEventParser", () => {
  let builder: StructuredOutputBuilder;
  let parser: StructuredEventParser;

  beforeEach(() => {
    builder = new StructuredOutputBuilder();
    parser = new StructuredEventParser({ builder });
  });

  // ── Subagent spawn ──

  describe("subagent spawn", () => {
    it("creates an AgentBlock on Task tool_use", () => {
      const event = makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_1",
          name: "Task",
          input: { description: "research files", subagent_type: "Explore" },
        },
      ]);

      parser.dispatch(event, "claude");
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Explore");
      expect(agent.description).toBe("research files");
      expect(agent.status).toBe("active");
    });

    it("creates an AgentBlock on Agent tool_use", () => {
      const event = makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_2",
          name: "Agent",
          input: { description: "planning step" },
        },
      ]);

      parser.dispatch(event, "claude");
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Agent"); // no subagent_type → falls back to tool name
      expect(agent.description).toBe("planning step");
    });

    it("uses tool name as description fallback when no description in input", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_3", name: "Task", input: {} },
      ]);

      parser.dispatch(event, "claude");
      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.description).toBe("Task");
    });
  });

  // ── Subagent completion ──

  describe("subagent completion", () => {
    it("completes an agent on tool_result", () => {
      // Spawn
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Task", input: { description: "do stuff" } },
      ]);
      parser.dispatch(spawnEvent, "claude");

      // Complete
      const resultEvent = makeToolResultEvent("tool_1");
      parser.dispatch(resultEvent, "claude");

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("completed");
    });

    it("marks agent as error on tool_result with is_error=true", () => {
      // Spawn
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_err", name: "Task", input: { description: "will fail" } },
      ]);
      parser.dispatch(spawnEvent, "claude");

      // Error result
      const resultEvent = makeToolResultEvent("tool_err", { is_error: true, content: "something broke" });
      parser.dispatch(resultEvent, "claude");

      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("error");
    });

    it("ignores tool_result for unknown tool_use_id", () => {
      const resultEvent = makeToolResultEvent("unknown_id");
      parser.dispatch(resultEvent, "claude");
      // Should not throw, no blocks created
      expect(builder.getBlocks()).toHaveLength(0);
    });
  });

  // ── Regular tool routing ──

  describe("regular tool use", () => {
    it("creates a ToolBlock for non-subagent tools", () => {
      // Use task_complete which is a non-context tool, so it renders as a standalone ToolBlock
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_r", name: "task_complete", input: { result: "done" } },
      ]);

      parser.dispatch(event, "claude");
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("tool");
    });

    it("routes child tools to parent agent via parent_tool_use_id", () => {
      // Spawn agent
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "agent work" } },
      ]);
      parser.dispatch(spawnEvent, "claude");

      // Child tool with parent_tool_use_id
      const childEvent: NDJSONEvent = {
        type: "assistant",
        data: {
          type: "assistant",
          message: {
            parent_tool_use_id: "agent_tool",
            content: [
              { type: "tool_use", id: "child_tool", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
      };
      parser.dispatch(childEvent, "claude");

      const blocks = builder.getBlocks();
      // Should have 1 agent block with the child tool nested inside
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as AgentBlock;
      expect(agent.kind).toBe("agent");
      expect(agent.children.length).toBe(1);
      expect(agent.children[0].name).toBe("Bash");
    });
  });

  // ── Reset ──

  describe("reset", () => {
    it("clears tracked subagents so subsequent tool_results are ignored", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_reset", name: "Task", input: { description: "test" } },
      ]);
      parser.dispatch(spawnEvent, "claude");
      parser.reset();

      // tool_result after reset should not find the agent
      const resultEvent = makeToolResultEvent("tool_reset");
      parser.dispatch(resultEvent, "claude");

      // Agent should still be running (not completed) since reset cleared tracking
      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("active");
    });
  });

  // ── Fallback engine ──

  describe("fallback engine", () => {
    it("handles assistant events for unknown engines", () => {
      const event = makeAssistantEvent([
        { type: "text", text: "hello from unknown engine" },
      ]);

      parser.dispatch(event, "some-other-engine");
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("text");
    });
  });
});
