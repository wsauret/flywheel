import { describe, it, expect, beforeEach, mock } from "bun:test";
import { StructuredEventParser } from "../src/infra/output/structured-event-parser";
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder";
import type { NDJSONEvent } from "../src/infra/subprocess-types";
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

describe("StructuredEventParser", () => {
  let builder: StructuredOutputBuilder;
  let parser: StructuredEventParser;

  beforeEach(() => {
    builder = new StructuredOutputBuilder();
    parser = new StructuredEventParser(builder);
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

  // ── Blocking invariant: top-level events close agents ──

  describe("blocking invariant", () => {
    it("top-level text auto-completes an active agent", () => {
      // Spawn agent
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Agent", input: { description: "exploring", subagent_type: "Explore" } },
      ]);
      parser.dispatch(spawnEvent, "claude");

      // Top-level text arrives (no parent_tool_use_id) — agent must be done
      const textEvent = makeAssistantEvent([
        { type: "text", text: "Based on the exploration..." },
      ]);
      parser.dispatch(textEvent, "claude");

      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("completed");
    });

    it("top-level tool does NOT get captured into active agent", () => {
      // Spawn agent
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Agent", input: { description: "exploring" } },
      ]);
      parser.dispatch(spawnEvent, "claude");

      // Top-level tool arrives — should be its own block, not a child of the agent
      const toolEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_2", name: "task_complete", input: { result: "done" } },
      ]);
      parser.dispatch(toolEvent, "claude");

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).status).toBe("completed"); // auto-closed
      expect((blocks[0] as AgentBlock).children).toHaveLength(0); // no captured tools
      expect(blocks[1].kind).toBe("tool");
    });

    it("tool_result still works as the authoritative close signal", () => {
      // Spawn agent
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Task", input: { description: "work" } },
      ]);
      parser.dispatch(spawnEvent, "claude");

      // tool_result arrives before any top-level event
      const resultEvent = makeToolResultEvent("tool_1");
      parser.dispatch(resultEvent, "claude");

      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("completed");
    });
  });

  // ── Parallel subagent spawns ──

  describe("parallel subagent spawns", () => {
    it("three separate agent spawn events do NOT auto-complete siblings", () => {
      // Simulate three parallel agent spawns arriving as separate top-level events
      const spawn1 = makeAssistantEvent([
        { type: "tool_use", id: "tool_a", name: "Agent", input: { description: "explore A", subagent_type: "Explore" } },
      ]);
      const spawn2 = makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "Agent", input: { description: "explore B", subagent_type: "Explore" } },
      ]);
      const spawn3 = makeAssistantEvent([
        { type: "tool_use", id: "tool_c", name: "Agent", input: { description: "explore C", subagent_type: "Explore" } },
      ]);

      parser.dispatch(spawn1, "claude");
      parser.dispatch(spawn2, "claude");
      parser.dispatch(spawn3, "claude");

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      // ALL three agents should still be active
      expect((blocks[0] as AgentBlock).status).toBe("active");
      expect((blocks[1] as AgentBlock).status).toBe("active");
      expect((blocks[2] as AgentBlock).status).toBe("active");
    });

    it("parallel agents each close only on their own tool_result", () => {
      // Spawn three agents
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_a", name: "Agent", input: { description: "A" } },
      ]), "claude");
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "Agent", input: { description: "B" } },
      ]), "claude");
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_c", name: "Agent", input: { description: "C" } },
      ]), "claude");

      // Complete only Agent B
      parser.dispatch(makeToolResultEvent("tool_b"), "claude");

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect((blocks[0] as AgentBlock).status).toBe("active");
      expect((blocks[1] as AgentBlock).status).toBe("completed");
      expect((blocks[2] as AgentBlock).status).toBe("active");
    });

    it("top-level text AFTER all tool_results still closes stragglers", () => {
      // Spawn two agents
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_a", name: "Agent", input: { description: "A" } },
      ]), "claude");
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "Agent", input: { description: "B" } },
      ]), "claude");

      // Complete only Agent A via tool_result
      parser.dispatch(makeToolResultEvent("tool_a"), "claude");

      // Top-level text arrives — Agent B's tool_result was lost, should be auto-completed
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Here are the results..." },
      ]), "claude");

      const blocks = builder.getBlocks();
      expect((blocks[0] as AgentBlock).status).toBe("completed");
      expect((blocks[1] as AgentBlock).status).toBe("completed");
    });

    it("all three agents in one event stays correct", () => {
      // All three spawns in a single assistant event (single content array)
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_a", name: "Agent", input: { description: "A" } },
        { type: "tool_use", id: "tool_b", name: "Agent", input: { description: "B" } },
        { type: "tool_use", id: "tool_c", name: "Agent", input: { description: "C" } },
      ]);

      parser.dispatch(event, "claude");

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(3);
      expect((blocks[0] as AgentBlock).status).toBe("active");
      expect((blocks[1] as AgentBlock).status).toBe("active");
      expect((blocks[2] as AgentBlock).status).toBe("active");
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
