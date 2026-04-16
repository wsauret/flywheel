import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredEventParser } from "../src/infra/output/structured-event-parser";
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";
import type { AgentBlock, ToolEntry } from "../src/infra/output-blocks";

// ── Helpers ──

function makeAssistantEvent(content: Record<string, unknown>[], parentToolUseId?: string): NDJSONEvent {
  return {
    type: "assistant",
    data: {
      type: "assistant",
      message: { content, ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}) },
    },
    raw: "",
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
    raw: "",
  };
}

function makeUserToolResultEvent(toolResults: Array<{
  tool_use_id: string;
  is_error?: boolean;
  content?: string;
}>): NDJSONEvent {
  return {
    type: "user",
    data: {
      type: "user",
      message: {
        content: toolResults.map(r => ({
          type: "tool_result" as const,
          tool_use_id: r.tool_use_id,
          is_error: r.is_error ?? false,
          content: r.content ?? "done",
        })),
      },
    },
    raw: "",
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

      parser.dispatch(event, 1000);
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

      parser.dispatch(event, 1000);
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

      parser.dispatch(event, 1000);
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
      parser.dispatch(spawnEvent, 1000);

      // Complete
      const resultEvent = makeToolResultEvent("tool_1");
      parser.dispatch(resultEvent, 1000);

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
      parser.dispatch(spawnEvent, 1000);

      // Error result
      const resultEvent = makeToolResultEvent("tool_err", { is_error: true, content: "something broke" });
      parser.dispatch(resultEvent, 1000);

      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("error");
    });

    it("ignores tool_result for unknown tool_use_id", () => {
      const resultEvent = makeToolResultEvent("unknown_id");
      parser.dispatch(resultEvent, 1000);
      // Should not throw, no blocks created
      expect(builder.getBlocks()).toHaveLength(0);
    });
  });

  // ── Regular tool rendering (pending → resolved) ──

  describe("regular tool rendering", () => {
    it("renders a pending Tools group row immediately on tool_use", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_r", name: "Bash", input: { command: "ls" } },
      ]);

      parser.dispatch(event, 1000);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("agent");
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Tools");
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].name).toBe("Bash");
      // Pending: no completed or errorMessage
      expect(agent.children[0].completed).toBeUndefined();
      expect(agent.children[0].errorMessage).toBeUndefined();
    });

    it("updates the Tools group row to completed on tool_result", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_r", name: "Bash", input: { command: "ls" } },
      ]);
      parser.dispatch(spawnEvent, 1000);
      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_r" }]), 2000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as AgentBlock;
      expect(agent.agentLabel).toBe("Tools");
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].completed).toBe(true);
    });

    it("routes child tools to parent agent via parent_tool_use_id as pending rows", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "agent work" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      const childEvent = makeAssistantEvent(
        [{ type: "tool_use", id: "child_tool", name: "Bash", input: { command: "ls" } }],
        "agent_tool",
      );
      parser.dispatch(childEvent, 1000);

      // Child appears immediately as pending in the subagent's children.
      let blocks = builder.getBlocks();
      let agent = blocks[0] as AgentBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].name).toBe("Bash");
      expect(agent.children[0].completed).toBeUndefined();

      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "child_tool" }]), 2000);

      blocks = builder.getBlocks();
      agent = blocks[0] as AgentBlock;
      expect(agent.children[0].completed).toBe(true);
    });
  });

  // ── Blocking invariant: top-level events close agents ──

  describe("blocking invariant", () => {
    it("top-level text auto-completes an active agent", () => {
      // Spawn agent
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Agent", input: { description: "exploring", subagent_type: "Explore" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      // Top-level text arrives (no parent_tool_use_id) — agent must be done
      const textEvent = makeAssistantEvent([
        { type: "text", text: "Based on the exploration..." },
      ]);
      parser.dispatch(textEvent, 1000);

      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("completed");
    });

    it("top-level staged tool does NOT get captured into active agent", () => {
      // Spawn agent
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Agent", input: { description: "exploring" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      // Top-level tool arrives — stages. Agent auto-closes because this message
      // is not inside the subagent and does not spawn a new subagent.
      const toolEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_2", name: "Bash", input: { command: "ls" } },
      ]);
      parser.dispatch(toolEvent, 1000);

      // Resolve the tool
      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_2" }]), 2000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("agent");
      expect((blocks[0] as AgentBlock).status).toBe("completed"); // auto-closed
      expect((blocks[0] as AgentBlock).children).toHaveLength(0); // no captured tools
      expect(blocks[1].kind).toBe("agent");
      expect((blocks[1] as AgentBlock).agentLabel).toBe("Tools");
    });

    it("tool_result still works as the authoritative close signal", () => {
      // Spawn agent
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Task", input: { description: "work" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      // tool_result arrives before any top-level event
      const resultEvent = makeToolResultEvent("tool_1");
      parser.dispatch(resultEvent, 1000);

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

      parser.dispatch(spawn1, 1000);
      parser.dispatch(spawn2, 1000);
      parser.dispatch(spawn3, 1000);

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
      ]), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "Agent", input: { description: "B" } },
      ]), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_c", name: "Agent", input: { description: "C" } },
      ]), 1000);

      // Complete only Agent B
      parser.dispatch(makeToolResultEvent("tool_b"), 1000);

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
      ]), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "Agent", input: { description: "B" } },
      ]), 1000);

      // Complete only Agent A via tool_result
      parser.dispatch(makeToolResultEvent("tool_a"), 1000);

      // Top-level text arrives — Agent B's tool_result was lost, should be auto-completed
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Here are the results..." },
      ]), 1000);

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

      parser.dispatch(event, 1000);

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
      parser.dispatch(spawnEvent, 1000);
      parser.reset();

      // tool_result after reset should not find the agent
      const resultEvent = makeToolResultEvent("tool_reset");
      parser.dispatch(resultEvent, 1000);

      // Agent should still be running (not completed) since reset cleared tracking
      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.status).toBe("active");
    });

    it("clears row location tracking so subsequent tool_results no-op", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_row", name: "Bash", input: { command: "ls" } },
      ]);
      parser.dispatch(event, 1000);

      // Row exists immediately as pending.
      let agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.children[0].completed).toBeUndefined();

      parser.reset();
      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_row" }]), 2000);

      // Without its location in the map, the tool_result can't update the row;
      // it remains pending.
      agent = builder.getBlocks()[0] as AgentBlock;
      expect(agent.children[0].completed).toBeUndefined();
    });
  });

  // ── Fallback engine ──

  describe("fallback engine", () => {
    it("handles assistant events for unknown engines", () => {
      const event = makeAssistantEvent([
        { type: "text", text: "hello from unknown engine" },
      ]);

      parser.dispatch(event, 2000);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("text");
    });
  });

  // ── Standalone Edit/Write with in-place status update ──

  describe("standalone Edit/Write", () => {
    function spawnStandaloneToolEntry(toolUseId: string, name = "Edit"): void {
      const event = makeAssistantEvent([
        { type: "tool_use", id: toolUseId, name, input: { file_path: "test.ts", old_string: "a", new_string: "b" } },
      ]);
      parser.dispatch(event, 1000);
    }

    it("pushes standalone ToolEntry immediately for Edit", () => {
      spawnStandaloneToolEntry("tool_now", "Edit");
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("tool");
    });

    it("sets errorMessage on tool block for error tool_result", () => {
      spawnStandaloneToolEntry("tool_1", "Edit");
      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "tool_1", is_error: true, content: "<tool_use_error>Permission denied</tool_use_error>" },
      ]);
      parser.dispatch(userEvent, 2000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const tool = blocks[0] as ToolEntry;
      expect(tool.errorMessage).toBeDefined();
      expect(tool.errorMessage).toContain("Edit failed");
    });

    it("sets completed on tool block for non-error tool_result", () => {
      spawnStandaloneToolEntry("tool_2");
      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "tool_2", is_error: false, content: "success" },
      ]);
      parser.dispatch(userEvent, 2000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const tool = blocks[0] as ToolEntry;
      expect(tool.completed).toBe(true);
      expect(tool.errorMessage).toBeUndefined();
    });

    it("does nothing for user event with no tool_results", () => {
      spawnStandaloneToolEntry("tool_3");
      const userEvent: NDJSONEvent = {
        type: "user",
        data: {
          type: "user",
          message: { content: [{ type: "text", text: "hello" }] },
        },
        raw: "",
      };
      parser.dispatch(userEvent, 2000);

      const blocks = builder.getBlocks();
      const tool = blocks[0] as ToolEntry;
      expect(tool.completed).toBeUndefined();
      expect(tool.errorMessage).toBeUndefined();
    });

    it("handles multiple tool_results (mix of error and non-error) across standalone + staged", () => {
      spawnStandaloneToolEntry("tool_a", "Edit");
      // Bash is a regular (staged) tool.
      const event2 = makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "Bash", input: { command: "echo done" } },
      ]);
      parser.dispatch(event2, 1000);

      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "tool_a", is_error: true, content: "<tool_use_error>File not found</tool_use_error>" },
        { tool_use_id: "tool_b", is_error: false, content: "done" },
      ]);
      parser.dispatch(userEvent, 2000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      // Edit (standalone) carries its error message in place
      const editTool = blocks[0] as ToolEntry;
      expect(editTool.errorMessage).toBeDefined();
      expect(editTool.errorMessage).toContain("Edit failed");
      // Bash resolved into the Tools group
      expect(blocks[1].kind).toBe("agent");
      const toolsAgent = blocks[1] as AgentBlock;
      expect(toolsAgent.agentLabel).toBe("Tools");
      expect(toolsAgent.children).toHaveLength(1);
      expect(toolsAgent.children[0].name).toBe("Bash");
      expect(toolsAgent.children[0].completed).toBe(true);
    });

    it("ignores tool_result for unknown tool_use_id without crashing", () => {
      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "nonexistent_id", is_error: true, content: "boom" },
      ]);
      parser.dispatch(userEvent, 2000);
      expect(builder.getBlocks()).toHaveLength(0);
    });
  });

  // ── Subagent-child tool resolution ──

  describe("subagent-child tool resolution", () => {
    it("sets errorMessage on agent child tool for error tool_result", () => {
      // Spawn agent
      const agentEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "work" } },
      ]);
      parser.dispatch(agentEvent, 1000);

      const childEvent = makeAssistantEvent(
        [{ type: "tool_use", id: "child_1", name: "Edit", input: { file_path: "test.ts", old_string: "a", new_string: "b" } }],
        "agent_tool",
      );
      parser.dispatch(childEvent, 1500);

      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "child_1", is_error: true, content: "<tool_use_error>File not found: test.ts</tool_use_error>" },
      ]);
      parser.dispatch(userEvent, 2000);

      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].errorMessage).toBe("Edit failed — File not found: test.ts");
    });

    it("sets completed on agent child tool for non-error tool_result", () => {
      // Spawn agent
      const agentEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool_2", name: "Task", input: { description: "work" } },
      ]);
      parser.dispatch(agentEvent, 1000);

      const childEvent = makeAssistantEvent(
        [{ type: "tool_use", id: "child_2", name: "Bash", input: { command: "echo hi" } }],
        "agent_tool_2",
      );
      parser.dispatch(childEvent, 1500);

      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "child_2", is_error: false, content: "hi" },
      ]);
      parser.dispatch(userEvent, 2000);

      const blocks = builder.getBlocks();
      const agent = blocks[0] as AgentBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].completed).toBe(true);
      expect(agent.children[0].errorMessage).toBeUndefined();
    });
  });
});
