import { describe, it, expect, beforeEach } from "bun:test";
import { SubagentTraceParser } from "../src/tui/adapters/subagent-tracing/parser";
import {
  isOpenCodeTaskTool,
  openCodeTaskToClaudeMessages,
  parseOpenCodeJsonlLine,
} from "../src/tui/adapters/subagent-tracing/opencode-adapter";
import type {
  ClaudeJsonlMessage,
  SubagentEvent,
  SubagentSpawnEvent,
  SubagentCompleteEvent,
} from "../src/tui/adapters/subagent-tracing/types";

// ---------------------------------------------------------------------------
// Test fixtures: Claude-format messages
// ---------------------------------------------------------------------------

/** Simulates a Claude assistant message containing a Task tool_use block. */
function makeClaudeTaskSpawn(opts: {
  toolUseId: string;
  description?: string;
  prompt?: string;
  subagentType?: string;
}): ClaudeJsonlMessage {
  const input: Record<string, unknown> = {
    description: opts.description ?? "Explore the codebase",
    prompt: opts.prompt ?? "Find all TODO comments",
    subagent_type: opts.subagentType ?? "Explore",
  };

  return {
    type: "assistant",
    tool: { name: "Task", input },
    raw: {
      type: "assistant",
      content: [
        {
          type: "tool_use",
          id: opts.toolUseId,
          name: "Task",
          input,
        },
      ],
    },
  };
}

/** Simulates a Claude tool_result message referencing a previous tool_use. */
function makeClaudeToolResult(opts: {
  toolUseId: string;
  content?: string;
  isError?: boolean;
}): ClaudeJsonlMessage {
  return {
    type: "result",
    result: opts.content ?? "Done",
    raw: {
      type: "tool_result",
      tool_use_id: opts.toolUseId,
      content: opts.content ?? "Done",
      is_error: opts.isError ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures: OpenCode-format messages
// ---------------------------------------------------------------------------

/** Simulates an OpenCode tool_use JSONL line for a Task tool. */
function makeOpenCodeTaskLine(opts: {
  callId?: string;
  description?: string;
  prompt?: string;
  output?: string;
  status?: string;
  subagentType?: string;
}): string {
  const obj = {
    type: "tool_use",
    timestamp: Date.now(),
    sessionID: "session-abc",
    part: {
      id: "part-1",
      type: "tool-invocation",
      tool: "task",
      callID: opts.callId ?? "call-1",
      state: {
        status: opts.status ?? "completed",
        input: {
          description: opts.description ?? "Research topic",
          prompt: opts.prompt ?? "Look into X",
          subagent_type: opts.subagentType ?? "Explore",
        },
        output: opts.output ?? "Found results",
        title: "Task",
      },
    },
  };
  return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// SubagentTraceParser — Claude format
// ---------------------------------------------------------------------------

describe("SubagentTraceParser", () => {
  let parser: SubagentTraceParser;
  let emittedEvents: SubagentEvent[];

  beforeEach(() => {
    emittedEvents = [];
    parser = new SubagentTraceParser({
      onEvent: (event) => emittedEvents.push(event),
    });
  });

  // -----------------------------------------------------------------------
  // Spawn detection
  // -----------------------------------------------------------------------

  describe("spawn detection", () => {
    it("detects a Claude Task tool_use as a spawn event", () => {
      const msg = makeClaudeTaskSpawn({
        toolUseId: "tu-1",
        description: "Search files",
        prompt: "grep for errors",
        subagentType: "Explore",
      });

      const events = parser.processMessage(msg);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("spawn");

      const spawn = events[0] as SubagentSpawnEvent;
      expect(spawn.agentType).toBe("Explore");
      expect(spawn.description).toBe("Search files");
      expect(spawn.prompt).toBe("grep for errors");
      expect(spawn.parentId).toBeUndefined();
    });

    it("detects Task tool via message.tool shorthand", () => {
      const msg: ClaudeJsonlMessage = {
        type: "assistant",
        tool: {
          name: "Task",
          input: {
            description: "Quick task",
            prompt: "Do something",
            subagent_type: "Plan",
          },
        },
        raw: { type: "assistant" },
      };

      const events = parser.processMessage(msg);

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("spawn");
    });

    it("is case-insensitive on tool name", () => {
      const msg: ClaudeJsonlMessage = {
        type: "assistant",
        tool: {
          name: "task",
          input: {
            description: "lowercase task",
            prompt: "do it",
            subagent_type: "Explore",
          },
        },
        raw: { type: "assistant" },
      };

      const events = parser.processMessage(msg);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("spawn");
    });

    it("detects 'Agent' tool name as a spawn event (Claude Code built-in agents)", () => {
      const msg: ClaudeJsonlMessage = {
        type: "assistant",
        tool: {
          name: "Agent",
          input: {
            description: "Explore data models",
            prompt: "Read schema files",
            subagent_type: "Explore",
          },
        },
        raw: {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_agent_test",
                name: "Agent",
                input: {
                  description: "Explore data models",
                  prompt: "Read schema files",
                  subagent_type: "Explore",
                },
              },
            ],
          },
        },
      };

      const events = parser.processMessage(msg);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("spawn");
      const spawn = events[0] as SubagentSpawnEvent;
      expect(spawn.description).toBe("Explore data models");
    });

    it("tracks active subagents after spawn", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );

      const active = parser.getActiveSubagents();
      expect(active).toHaveLength(1);
      expect(active[0]!.status).toBe("running");
    });
  });

  // -----------------------------------------------------------------------
  // Completion detection
  // -----------------------------------------------------------------------

  describe("completion detection", () => {
    it("detects tool_result as a complete event", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );

      const events = parser.processMessage(
        makeClaudeToolResult({ toolUseId: "tu-1", content: "All done" })
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("complete");

      const complete = events[0] as SubagentCompleteEvent;
      expect(complete.exitStatus).toBe("success");
      expect(complete.result).toBe("All done");
      expect(complete.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("marks subagent as completed after tool_result", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );
      parser.processMessage(
        makeClaudeToolResult({ toolUseId: "tu-1" })
      );

      expect(parser.getActiveSubagents()).toHaveLength(0);

      const all = parser.getAllSubagents();
      expect(all).toHaveLength(1);
      expect(all[0]!.status).toBe("completed");
    });

    it("detects error tool_result as error event", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );

      const events = parser.processMessage(
        makeClaudeToolResult({
          toolUseId: "tu-1",
          content: "Something failed",
          isError: true,
        })
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("error");
    });
  });

  // -----------------------------------------------------------------------
  // Nested hierarchy
  // -----------------------------------------------------------------------

  describe("nested hierarchy", () => {
    it("assigns parentId for nested Task inside Task", () => {
      // Spawn parent
      const parentEvents = parser.processMessage(
        makeClaudeTaskSpawn({
          toolUseId: "tu-parent",
          description: "Parent task",
          subagentType: "Plan",
        })
      );
      const parentId = parentEvents[0]!.id;

      // Spawn child while parent is active
      const childEvents = parser.processMessage(
        makeClaudeTaskSpawn({
          toolUseId: "tu-child",
          description: "Child task",
          subagentType: "Explore",
        })
      );

      expect(childEvents).toHaveLength(1);
      const childSpawn = childEvents[0] as SubagentSpawnEvent;
      expect(childSpawn.parentId).toBe(parentId);
    });

    it("tracks two levels of active subagents", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-2" })
      );

      expect(parser.getActiveSubagents()).toHaveLength(2);
      expect(parser.getCurrentDepth()).toBe(2);
    });

    it("completing child does not complete parent", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-parent" })
      );
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-child" })
      );

      // Complete child
      parser.processMessage(
        makeClaudeToolResult({ toolUseId: "tu-child" })
      );

      const active = parser.getActiveSubagents();
      expect(active).toHaveLength(1);
      expect(active[0]!.agentType).toBeTruthy();
    });

    it("records childIds on parent state", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-parent" })
      );
      const childEvents = parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-child" })
      );
      const childId = childEvents[0]!.id;

      const all = parser.getAllSubagents();
      const parent = all.find((s) => !s.parentId);
      expect(parent).toBeDefined();
      expect(parent!.childIds).toContain(childId);
    });
  });

  // -----------------------------------------------------------------------
  // processMessages (batch)
  // -----------------------------------------------------------------------

  describe("processMessages", () => {
    it("processes multiple messages and returns all events", () => {
      const messages = [
        makeClaudeTaskSpawn({ toolUseId: "tu-1" }),
        makeClaudeToolResult({ toolUseId: "tu-1", content: "Done" }),
      ];

      const events = parser.processMessages(messages);

      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("spawn");
      expect(events[1]!.type).toBe("complete");
    });
  });

  // -----------------------------------------------------------------------
  // getSummary
  // -----------------------------------------------------------------------

  describe("getSummary", () => {
    it("returns correct counts for mixed state", () => {
      // Spawn three agents
      parser.processMessage(
        makeClaudeTaskSpawn({
          toolUseId: "tu-1",
          subagentType: "Explore",
        })
      );
      parser.processMessage(
        makeClaudeTaskSpawn({
          toolUseId: "tu-2",
          subagentType: "Plan",
        })
      );
      // Complete first one
      parser.processMessage(
        makeClaudeToolResult({ toolUseId: "tu-1" })
      );

      const summary = parser.getSummary();

      expect(summary.totalSpawned).toBe(2);
      expect(summary.completed).toBe(1);
      expect(summary.running).toBe(1);
      expect(summary.errored).toBe(0);
      expect(summary.byAgentType["Explore"]).toBe(1);
      expect(summary.byAgentType["Plan"]).toBe(1);
    });

    it("returns zero counts when empty", () => {
      const summary = parser.getSummary();

      expect(summary.totalSpawned).toBe(0);
      expect(summary.completed).toBe(0);
      expect(summary.running).toBe(0);
      expect(summary.errored).toBe(0);
      expect(summary.maxDepth).toBe(0);
    });

    it("computes maxDepth for nested subagents", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-2" })
      );

      const summary = parser.getSummary();
      expect(summary.maxDepth).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Event callback
  // -----------------------------------------------------------------------

  describe("event callback", () => {
    it("fires onEvent for each detected event", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );
      parser.processMessage(
        makeClaudeToolResult({ toolUseId: "tu-1" })
      );

      expect(emittedEvents).toHaveLength(2);
      expect(emittedEvents[0]!.type).toBe("spawn");
      expect(emittedEvents[1]!.type).toBe("complete");
    });

    it("stores all events retrievable via getEvents()", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );

      const events = parser.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("spawn");
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("clears all state", () => {
      parser.processMessage(
        makeClaudeTaskSpawn({ toolUseId: "tu-1" })
      );

      parser.reset();

      expect(parser.getActiveSubagents()).toHaveLength(0);
      expect(parser.getAllSubagents()).toHaveLength(0);
      expect(parser.getEvents()).toHaveLength(0);
      expect(parser.getCurrentDepth()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCode adapter — parseOpenCodeJsonlLine
// ---------------------------------------------------------------------------

describe("parseOpenCodeJsonlLine", () => {
  it("parses a valid OpenCode JSONL line", () => {
    const line = JSON.stringify({
      type: "tool_use",
      timestamp: 1234567890,
      sessionID: "sess-1",
      part: { tool: "task" },
    });

    const result = parseOpenCodeJsonlLine(line);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message.source).toBe("opencode");
      expect(result.message.type).toBe("tool_use");
      expect(result.message.sessionID).toBe("sess-1");
    }
  });

  it("returns failure for empty line", () => {
    const result = parseOpenCodeJsonlLine("");
    expect(result.success).toBe(false);
  });

  it("returns failure for invalid JSON", () => {
    const result = parseOpenCodeJsonlLine("not json at all");
    expect(result.success).toBe(false);
  });

  it("strips ANSI escape codes before parsing", () => {
    const json = JSON.stringify({ type: "text", timestamp: 1 });
    const line = `\x1b[32m${json}\x1b[0m`;

    const result = parseOpenCodeJsonlLine(line);
    expect(result.success).toBe(true);
  });

  it("extracts JSON from garbage prefix", () => {
    const json = JSON.stringify({ type: "step_start", timestamp: 1 });
    const line = `2024-01-01 INFO: ${json}`;

    const result = parseOpenCodeJsonlLine(line);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message.type).toBe("step_start");
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCode adapter — isOpenCodeTaskTool
// ---------------------------------------------------------------------------

describe("isOpenCodeTaskTool", () => {
  it("returns true for task tool_use", () => {
    const result = parseOpenCodeJsonlLine(
      JSON.stringify({
        type: "tool_use",
        part: { tool: "task" },
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(isOpenCodeTaskTool(result.message)).toBe(true);
    }
  });

  it("returns false for non-task tool_use", () => {
    const result = parseOpenCodeJsonlLine(
      JSON.stringify({
        type: "tool_use",
        part: { tool: "bash" },
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(isOpenCodeTaskTool(result.message)).toBe(false);
    }
  });

  it("returns false for non-tool_use message type", () => {
    const result = parseOpenCodeJsonlLine(
      JSON.stringify({
        type: "text",
        part: { tool: "task" },
      })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(isOpenCodeTaskTool(result.message)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCode adapter — openCodeTaskToClaudeMessages
// ---------------------------------------------------------------------------

describe("openCodeTaskToClaudeMessages", () => {
  it("converts a completed OpenCode Task into spawn + complete pair", () => {
    const line = makeOpenCodeTaskLine({
      callId: "call-42",
      description: "Research codebase",
      prompt: "Find patterns",
      output: "Found 3 patterns",
      status: "completed",
    });

    const parseResult = parseOpenCodeJsonlLine(line);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const messages = openCodeTaskToClaudeMessages(parseResult.message);

    expect(messages).toHaveLength(2);

    // First message: spawn (assistant with tool_use)
    expect(messages[0]!.type).toBe("assistant");
    expect(messages[0]!.tool?.name).toBe("Task");
    expect(messages[0]!.tool?.input?.description).toBe("Research codebase");

    // Second message: completion (tool_result)
    expect(messages[1]!.type).toBe("result");
    expect(messages[1]!.result).toBe("Found 3 patterns");
  });

  it("returns empty for non-task tool", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "bash", state: { input: {} } },
    });

    const parseResult = parseOpenCodeJsonlLine(line);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const messages = openCodeTaskToClaudeMessages(parseResult.message);
    expect(messages).toHaveLength(0);
  });

  it("returns empty when input is missing", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { tool: "task", state: {} },
    });

    const parseResult = parseOpenCodeJsonlLine(line);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const messages = openCodeTaskToClaudeMessages(parseResult.message);
    expect(messages).toHaveLength(0);
  });

  it("integrates with SubagentTraceParser end-to-end", () => {
    const parser = new SubagentTraceParser();
    const line = makeOpenCodeTaskLine({
      callId: "call-99",
      output: "Task completed",
    });

    const parseResult = parseOpenCodeJsonlLine(line);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const claudeMsgs = openCodeTaskToClaudeMessages(parseResult.message);
    const events = parser.processMessages(claudeMsgs);

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("spawn");
    expect(events[1]!.type).toBe("complete");

    const summary = parser.getSummary();
    expect(summary.totalSpawned).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.running).toBe(0);
  });
});
