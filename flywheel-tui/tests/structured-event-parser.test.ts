import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredEventParser } from "../src/infra/output/structured-event-parser";
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";
import type { ToolGroupBlock, ToolEntry, QuestionBlock, TodoListBlock } from "../src/infra/output-blocks";

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
    it("creates an ToolGroupBlock on Task tool_use", () => {
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
      expect(blocks[0].kind).toBe("toolGroup");
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.label).toBe("Explore");
      expect(agent.description).toBe("research files");
      expect(agent.status).toBe("active");
    });

    it("creates an ToolGroupBlock on Agent tool_use", () => {
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
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.label).toBe("Agent"); // no subagent_type → falls back to tool name
      expect(agent.description).toBe("planning step");
    });

    it("uses tool name as description fallback when no description in input", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_3", name: "Task", input: {} },
      ]);

      parser.dispatch(event, 1000);
      const blocks = builder.getBlocks();
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.description).toBe("Task");
    });

    it("creates an ToolGroupBlock on dispatch_agent tool_use", () => {
      const event = makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_da",
          name: "dispatch_agent",
          input: { description: "dispatched work", subagent_type: "Worker" },
        },
      ]);

      parser.dispatch(event, 1000);
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.label).toBe("Worker");
      expect(agent.description).toBe("dispatched work");
      expect(agent.status).toBe("active");
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
      const agent = blocks[0] as ToolGroupBlock;
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
      const agent = blocks[0] as ToolGroupBlock;
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
      expect(blocks[0].kind).toBe("toolGroup");
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.label).toBe("Tools");
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
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.label).toBe("Tools");
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
      let agent = blocks[0] as ToolGroupBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].name).toBe("Bash");
      expect(agent.children[0].completed).toBeUndefined();

      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "child_tool" }]), 2000);

      blocks = builder.getBlocks();
      agent = blocks[0] as ToolGroupBlock;
      expect(agent.children[0].completed).toBe(true);
    });
  });


  // ── Agent lifecycle: only tool_result closes agents ──

  describe("agent lifecycle", () => {
    it("agents stay active when unrelated assistant messages arrive", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Agent", input: { description: "exploring", subagent_type: "Explore" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      const textEvent = makeAssistantEvent([
        { type: "text", text: "Based on the exploration..." },
      ]);
      parser.dispatch(textEvent, 1000);

      const blocks = builder.getBlocks();
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.status).toBe("active");
    });

    it("unrelated assistant tools do NOT close an active agent", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Agent", input: { description: "exploring" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      const toolEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_2", name: "Bash", input: { command: "ls" } },
      ]);
      parser.dispatch(toolEvent, 1000);

      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_2" }]), 2000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("toolGroup");
      expect((blocks[0] as ToolGroupBlock).status).toBe("active");
      expect((blocks[0] as ToolGroupBlock).children).toHaveLength(0);
      expect(blocks[1].kind).toBe("toolGroup");
      expect((blocks[1] as ToolGroupBlock).label).toBe("Tools");
    });

    it("tool_result is the authoritative close signal", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Task", input: { description: "work" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      const resultEvent = makeToolResultEvent("tool_1");
      parser.dispatch(resultEvent, 1000);

      const blocks = builder.getBlocks();
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.status).toBe("completed");
    });

    it("agent stays active through interleaved messages until tool_result", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "Agent", input: { description: "research" } },
      ]), 1000);

      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Intermediate update..." },
      ]), 2000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_2", name: "Bash", input: { command: "echo hi" } },
      ]), 3000);

      expect((builder.getBlocks()[0] as ToolGroupBlock).status).toBe("active");

      parser.dispatch(makeToolResultEvent("tool_1"), 4000);

      expect((builder.getBlocks()[0] as ToolGroupBlock).status).toBe("completed");
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
      expect((blocks[0] as ToolGroupBlock).status).toBe("active");
      expect((blocks[1] as ToolGroupBlock).status).toBe("active");
      expect((blocks[2] as ToolGroupBlock).status).toBe("active");
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
      expect((blocks[0] as ToolGroupBlock).status).toBe("active");
      expect((blocks[1] as ToolGroupBlock).status).toBe("completed");
      expect((blocks[2] as ToolGroupBlock).status).toBe("active");
    });

    it("agent without tool_result stays active even after sibling completes", () => {
      // Spawn two agents
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_a", name: "Agent", input: { description: "A" } },
      ]), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "Agent", input: { description: "B" } },
      ]), 1000);

      // Complete only Agent A via tool_result
      parser.dispatch(makeToolResultEvent("tool_a"), 1000);

      // Top-level text arrives — Agent B stays active until its own tool_result or lifecycle cleanup
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Here are the results..." },
      ]), 1000);

      const blocks = builder.getBlocks();
      expect((blocks[0] as ToolGroupBlock).status).toBe("completed");
      expect((blocks[1] as ToolGroupBlock).status).toBe("active");
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
      expect((blocks[0] as ToolGroupBlock).status).toBe("active");
      expect((blocks[1] as ToolGroupBlock).status).toBe("active");
      expect((blocks[2] as ToolGroupBlock).status).toBe("active");
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
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.status).toBe("active");
    });

    it("clears row location tracking so subsequent tool_results no-op", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_row", name: "Bash", input: { command: "ls" } },
      ]);
      parser.dispatch(event, 1000);

      // Row exists immediately as pending.
      let agent = builder.getBlocks()[0] as ToolGroupBlock;
      expect(agent.children[0].completed).toBeUndefined();

      parser.reset();
      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_row" }]), 2000);

      // Without its location in the map, the tool_result can't update the row;
      // it remains pending.
      agent = builder.getBlocks()[0] as ToolGroupBlock;
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
      expect(blocks[1].kind).toBe("toolGroup");
      const toolsAgent = blocks[1] as ToolGroupBlock;
      expect(toolsAgent.label).toBe("Tools");
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
      const agent = blocks[0] as ToolGroupBlock;
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
      const agent = blocks[0] as ToolGroupBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].completed).toBe(true);
      expect(agent.children[0].errorMessage).toBeUndefined();
    });
  });

  // ── AskUserQuestion routing ──

  describe("AskUserQuestion", () => {
    const questionInput = {
      questions: [{
        question: "Which library should we use?",
        header: "Library",
        options: [
          { label: "Option A", description: "First choice" },
          { label: "Option B", description: "Second choice" },
        ],
      }],
    };

    it("top-level AskUserQuestion creates a QuestionBlock preserving the questions array", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_q1", name: "AskUserQuestion", input: questionInput },
      ]);
      parser.dispatch(event, 1000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("question");
      const q = blocks[0] as QuestionBlock;
      expect(q.toolUseId).toBe("tool_q1");
      expect(q.questions).toHaveLength(1);
      expect(q.questions[0].question).toBe("Which library should we use?");
      expect(q.questions[0].options).toHaveLength(2);
      expect(q.questions[0].options[0].label).toBe("Option A");
      expect(q.answers).toBeUndefined();
    });

    it("multi-question input creates block with all questions and multiSelect", () => {
      const multiInput = {
        questions: [
          { question: "Framework?", options: [{ label: "React" }, { label: "Vue" }] },
          { question: "Features?", options: [{ label: "Dark" }, { label: "Auto-save" }], multiSelect: true },
        ],
      };
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_q_multi", name: "AskUserQuestion", input: multiInput },
      ]), 1000);

      const q = builder.getBlocks()[0] as QuestionBlock;
      expect(q.questions).toHaveLength(2);
      expect(q.questions[1].multiSelect).toBe(true);
    });

    it("tool_result is a defensive no-op when answers already set locally", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_q2", name: "AskUserQuestion", input: questionInput },
      ]), 1000);

      // Simulate the dock having set answers before the tool_result arrives.
      builder.answerQuestion("tool_q2", { "Which library should we use?": "Option A" });

      const answerContent = JSON.stringify({
        answers: { "Which library should we use?": "Ignored-echo" },
      });
      parser.dispatch(makeUserToolResultEvent([
        { tool_use_id: "tool_q2", is_error: false, content: answerContent },
      ]), 2000);

      const q = builder.getBlocks()[0] as QuestionBlock;
      expect(q.answers).toEqual({ "Which library should we use?": "Option A" });
      expect(q.cancelled).toBeUndefined();
    });

    it("error tool_result cancels question block", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_q3", name: "AskUserQuestion", input: questionInput },
      ]), 1000);

      parser.dispatch(makeUserToolResultEvent([
        { tool_use_id: "tool_q3", is_error: true, content: "User cancelled" },
      ]), 2000);

      const q = builder.getBlocks()[0] as QuestionBlock;
      expect(q.cancelled).toBe(true);
      expect(q.answers).toBeUndefined();
    });

    it("subagent AskUserQuestion creates top-level question block AND agent child row", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "doing work" } },
      ]), 1000);

      parser.dispatch(makeAssistantEvent(
        [{ type: "tool_use", id: "child_q1", name: "AskUserQuestion", input: questionInput }],
        "agent_tool",
      ), 1500);

      const blocks = builder.getBlocks();
      const q = blocks.find(b => b.kind === "question") as QuestionBlock;
      expect(q.questions[0].question).toBe("Which library should we use?");

      const agent = blocks.find(b => b.kind === "toolGroup") as ToolGroupBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0].name).toBe("AskUserQuestion");
      expect(agent.children[0].detail).toContain("Awaiting user answer");
    });

    it("subagent question success completes agent child (answers set by dock)", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "doing work" } },
      ]), 1000);

      parser.dispatch(makeAssistantEvent(
        [{ type: "tool_use", id: "child_q2", name: "AskUserQuestion", input: questionInput }],
        "agent_tool",
      ), 1500);

      builder.answerQuestion("child_q2", { "Which library should we use?": "Option B" });

      parser.dispatch(makeUserToolResultEvent([
        { tool_use_id: "child_q2", is_error: false, content: "echo" },
      ]), 2000);

      const blocks = builder.getBlocks();
      const q = blocks.find(b => b.kind === "question") as QuestionBlock;
      expect(q.answers).toEqual({ "Which library should we use?": "Option B" });

      const agent = blocks.find(b => b.kind === "toolGroup") as ToolGroupBlock;
      expect(agent.children[0].completed).toBe(true);
    });

    it("subagent question error cancels question and errors agent child", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "Task", input: { description: "doing work" } },
      ]), 1000);

      parser.dispatch(makeAssistantEvent(
        [{ type: "tool_use", id: "child_q3", name: "AskUserQuestion", input: questionInput }],
        "agent_tool",
      ), 1500);

      parser.dispatch(makeUserToolResultEvent([
        { tool_use_id: "child_q3", is_error: true, content: "Cancelled" },
      ]), 2000);

      const blocks = builder.getBlocks();
      const q = blocks.find(b => b.kind === "question") as QuestionBlock;
      expect(q.cancelled).toBe(true);

      const agent = blocks.find(b => b.kind === "toolGroup") as ToolGroupBlock;
      expect(agent.children[0].errorMessage).toBe("Cancelled");
    });

    it("handles AskUserQuestion with no questions gracefully", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_q_empty", name: "AskUserQuestion", input: { questions: [] } },
      ]), 1000);

      expect(builder.getBlocks().filter(b => b.kind === "question")).toHaveLength(0);
    });
  });

  // ── todo_list (harness engine) ──

  describe("todo_list standalone tool", () => {
    it("creates a todoList block for todo_list write operations", () => {
      parser.dispatch(makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_todo_1",
          name: "todo_list",
          input: {
            operation: "write",
            todos: [
              { content: "Set up project", status: "completed" },
              { content: "Write tests", status: "in_progress" },
              { content: "Deploy", status: "pending" },
            ],
          },
        },
      ]), 1000);

      const blocks = builder.getBlocks();
      const todo = blocks.find(b => b.kind === "todoList") as TodoListBlock;
      expect(todo).toBeDefined();
      expect(todo.todos).toHaveLength(3);
      expect(todo.todos[0]!.content).toBe("Set up project");
      expect(todo.todos[1]!.status).toBe("in_progress");
    });

    it("ignores todo_list read operations", () => {
      parser.dispatch(makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_todo_read",
          name: "todo_list",
          input: { operation: "read" },
        },
      ]), 1000);

      const blocks = builder.getBlocks();
      expect(blocks.filter(b => b.kind === "todoList")).toHaveLength(0);
      expect(blocks.filter(b => b.kind === "tool")).toHaveLength(0);
    });
  });

  // ── Optimistic tools (case-insensitive) ──

  describe("optimistic tools", () => {
    it("marks lowercase read as completed (harness engine)", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_read_1", name: "read", input: { file_path: "/tmp/foo.ts" } },
      ]), 1000);

      const agent = builder.getBlocks()[0] as ToolGroupBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0]!.completed).toBe(true);
    });

    it("marks PascalCase Read as completed (claude engine)", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_Read_1", name: "Read", input: { file_path: "/tmp/foo.ts" } },
      ]), 1000);

      const agent = builder.getBlocks()[0] as ToolGroupBlock;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0]!.completed).toBe(true);
    });
  });

  // ── Streaming text deltas ──

  describe("streaming text deltas", () => {
    function makeTextDelta(text: string): NDJSONEvent {
      return {
        type: "content_block_delta",
        data: { type: "content_block_delta", delta: { type: "text_delta", text } },
        raw: "",
      };
    }

    function makeThinkingDelta(thinking: string): NDJSONEvent {
      return {
        type: "content_block_delta",
        data: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
        raw: "",
      };
    }

    it("pushes text blocks incrementally from text_delta events", () => {
      parser.dispatch(makeTextDelta("Hello "), 1000);
      parser.dispatch(makeTextDelta("world"), 1001);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.kind).toBe("text");
      if (blocks[0]!.kind === "text") {
        expect(blocks[0]!.content).toBe("Hello world");
      }
    });

    it("skips duplicate text in assistant event after streaming deltas", () => {
      parser.dispatch(makeTextDelta("Hello "), 1000);
      parser.dispatch(makeTextDelta("world"), 1001);

      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Hello world" },
      ]), 1002);

      const blocks = builder.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      if (textBlocks[0]!.kind === "text") {
        expect(textBlocks[0]!.content).toBe("Hello world");
      }
    });

    it("still processes text in assistant event when no deltas were streamed", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "No deltas here" },
      ]), 1000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      if (blocks[0]!.kind === "text") {
        expect(blocks[0]!.content).toBe("No deltas here");
      }
    });

    it("processes tool_use blocks from assistant event even when text was streamed", () => {
      parser.dispatch(makeTextDelta("Response text"), 1000);

      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Response text" },
        { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } },
      ]), 1001);

      const blocks = builder.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      const toolGroups = blocks.filter(b => b.kind === "toolGroup");
      expect(toolGroups.length).toBeGreaterThanOrEqual(1);
    });

    it("resets streaming flag between turns", () => {
      parser.dispatch(makeTextDelta("Turn 1"), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Turn 1" },
        { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } },
      ]), 1001);

      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Turn 2 without deltas" },
      ]), 1002);

      const blocks = builder.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(2);
      if (textBlocks[0]!.kind === "text") expect(textBlocks[0]!.content).toBe("Turn 1");
      if (textBlocks[1]!.kind === "text") expect(textBlocks[1]!.content).toBe("Turn 2 without deltas");
    });

    it("thinking alone creates standalone thinking block (not a Tools group)", () => {
      parser.dispatch(makeThinkingDelta("Deep thought"), 1000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("thinking");
      expect(builder.modelActivity).toBe("thinking");
    });

    it("thinking joins existing Tools group when tools arrive first", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "test.ts" } },
      ]), 1000);

      parser.dispatch(makeThinkingDelta("reasoning..."), 1001);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("toolGroup");
      const group = blocks[0] as ToolGroupBlock;
      expect(group.children).toHaveLength(2);
      expect(group.children[0].name).toBe("Read");
      expect(group.children[1].name).toBe("Thinking");
    });

    it("thinking in assistant message joins tool context created by tools in same message", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "thinking", thinking: "Full thinking" },
        { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "test" } },
      ]), 1000);

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      const group = blocks[0] as ToolGroupBlock;
      expect(group.children).toHaveLength(2);
      // Tools processed first, then thinking added
      expect(group.children[0].name).toBe("Grep");
      expect(group.children[1].name).toBe("Thinking");
    });

    it("thinking without tools creates standalone block", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "thinking", thinking: "Just thinking" },
        { type: "text", text: "Response without tools" },
      ]), 1000);

      const blocks = builder.getBlocks();
      // Thinking block + text block
      expect(blocks).toHaveLength(2);
      expect(blocks[0].kind).toBe("thinking");
      expect(blocks[1].kind).toBe("text");
    });
  });
});
