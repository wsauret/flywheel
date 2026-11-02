import { describe, it, expect, beforeEach } from "bun:test";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import type { AgentGroupBlock } from "../../../../src/infra/output-blocks";
import {
  makeAgentDispatchedEvent,
  makeAssistantEvent,
  makeToolResultAckEvent,
  makeUserToolResultEvent,
} from "./_parser-fixtures";

describe("RuntimeEventProjector — tool rendering", () => {
  let projector: OutputProjector;
  let parser: RuntimeEventProjector;

  beforeEach(() => {
    projector = new OutputProjector({ executionCwd: "/workspace" });
    parser = new RuntimeEventProjector(projector);
  });

  describe("regular tool rendering", () => {
    it("retains the addressed session, message, and outcome whether the input streamed or arrived whole", () => {
      projector.apply({ type: "tool-use", toolUseId: "whole", name: "message_session", input: { to: "3f2a-parent", text: "done" }, timestamp: 1000 });
      projector.apply({ type: "tool-use", toolUseId: "streamed", name: "message_session", input: {}, timestamp: 1001 });
      projector.apply({ type: "tool-input-complete", toolUseId: "streamed", name: "message_session", input: { to: "3f2a-parent", text: "done" }, timestamp: 1002 });

      // The transcript projection names the row by this session's title now.
      expect(projector.getBlocks()).toMatchObject([
        { kind: "tool", id: "whole", targetSessionId: "3f2a-parent", invocationBody: { content: "done", presentation: "disclosure" } },
        { kind: "tool", id: "streamed", targetSessionId: "3f2a-parent", invocationBody: { content: "done", presentation: "disclosure" } },
      ]);
      for (const toolUseId of ["whole", "streamed"]) {
        projector.apply({ type: "tool-result", toolUseId, outcome: "ok", content: [{ type: "text", text: "Delivered" }], source: "render", timestamp: 1003 });
      }
      expect(projector.getBlocks()).toMatchObject([
        { id: "whole", status: "completed", content: "Delivered" },
        { id: "streamed", status: "completed", content: "Delivered" },
      ]);
    });

    it("does not render current process management calls or results", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "process_1", name: "process", input: { action: "list" } },
      ]), 1000);
      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "process_1", content: "Managed processes" }]), 2000);

      expect(projector.getBlocks()).toEqual([]);
    });

    it("marks interrupted tool_result rows as interrupted, not error", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_abort", name: "Bash", input: { command: "bun run test" } },
      ]);
      parser.dispatch(spawnEvent, 1000);
      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_abort", is_error: true, interrupted: true, content: "The bash invocation was aborted by the user" }]), 2000);

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: "tool", name: "bash", status: "interrupted" });
    });

    it("renders workflow with workflow name and short run summary", () => {
      const event = makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_workflow",
          name: "workflow",
          input: {
            workflow_definition_id: "plan-implement-review",
            workflow_display_name: "Plan, Implement, Review",
            summary: "Activate On View refactor",
            description: "## Goal\nRefactor the full session modal behavior.",
          },
        },
      ]);

      parser.dispatch(event, 1000);

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = blocks[0];
      if (agent?.kind !== "agentGroup") throw new Error("expected agent group block");
      expect(agent.kind).toBe("agentGroup");
      expect(agent.containerKind).toBe("workflow");
      expect(agent.label).toBe("Activate On View refactor");
      expect(agent.description).toBe("");
      expect(agent.status).toBe("pending");
    });

    it("titles a streaming workflow by its summary alone, never by a reused file's name", () => {
      projector.apply({ type: "tool-use", toolUseId: "path", name: "workflow", input: {}, timestamp: 1000 });
      projector.apply({ type: "tool-input-delta", toolUseId: "path", partialJson: '{"source":{"kind":"path","path":"scratch/workflows/unit-a-review.workflow.yaml"},' });

      expect(projector.getBlocks()[0]).toMatchObject({ kind: "agentGroup", containerKind: "workflow", label: "Workflow" });

      projector.apply({ type: "tool-input-delta", toolUseId: "path", partialJson: '"summary":"Unit G review' });

      expect(projector.getBlocks()[0]).toMatchObject({ kind: "agentGroup", label: "Unit G review", description: "" });
    });

    it("keeps workflow active through the deferred initiation ack", () => {
      parser.dispatch(makeAssistantEvent([
        {
          type: "tool_use",
          id: "workflow_1",
          name: "workflow",
          input: {
            workflow_definition_id: "plan-implement-review",
            workflow_display_name: "Plan, Implement, Review",
            summary: "Activate On View refactor",
            description: "## Goal\nRefactor the full session modal behavior.",
          },
        },
      ]), 1000);

      parser.dispatch(makeToolResultAckEvent("workflow_1"), 1010);
      parser.dispatch(makeAgentDispatchedEvent("workflow_1"), 1015);
      parser.dispatch(createRuntimeEvent("agent.workflow_link.published", {
        type: "agent.workflow_link.published",
        tool_use_id: "workflow_1",
        link_uri: "flywheel://session/workflow-session",
      }), 1016);
      parser.dispatch(makeUserToolResultEvent([
        { tool_use_id: "workflow_1", content: "Workflow started." },
      ]), 1020);

      const blocks = projector.getBlocks();
      const agent = blocks[0];
      if (agent?.kind !== "agentGroup") throw new Error("expected agent group block");
      expect(agent.status).toBe("active");
      expect(agent.containerKind).toBe("workflow");
      expect(agent.linkUri).toBe("flywheel://session/workflow-session");
      expect(agent.label).toBe("Activate On View refactor");
      expect(agent.description).toBe("");
    });

    it("routes child tools to parent agent via parent_tool_use_id as pending rows", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "subagent", input: { description: "agent work" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      const childEvent = makeAssistantEvent(
        [{ type: "tool_use", id: "child_tool", name: "Bash", input: { command: "ls" } }],
        "agent_tool",
      );
      parser.dispatch(childEvent, 1000);

      // Child appears immediately as pending in the subagent's children.
      let blocks = projector.getBlocks();
      let agent = blocks[0];
      if (agent?.kind !== "agentGroup") throw new Error("expected agent group block");
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0]?.name).toBe("bash");
      expect(agent.children[0]?.status).toBe("pending");

      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "child_tool" }]), 2000);

      blocks = projector.getBlocks();
      agent = blocks[0];
      if (agent?.kind !== "agentGroup") throw new Error("expected agent group block");
      expect(agent.children[0]?.status).toBe("completed");
    });

    it("does not surface subagent thinking in output blocks", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "subagent", input: { description: "research" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      const turnEvent = makeAssistantEvent(
        [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "tool_use", id: "child_tool", name: "search", input: { pattern: "foo" } },
        ],
        "agent_tool",
      );
      parser.dispatch(turnEvent, 1500);

      const blocks = projector.getBlocks();
      const agent = blocks.find((block): block is AgentGroupBlock => block.kind === "agentGroup")!;
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0]?.name).toBe("search");
      expect(blocks.some((block) => block.kind === "thinking")).toBe(false);
    });

  });

  describe("standalone Edit/Write", () => {
    function spawnStandaloneToolEntry(toolUseId: string, name = "Edit"): void {
      const event = makeAssistantEvent([
        { type: "tool_use", id: toolUseId, name, input: { path: "test.ts", old_string: "a", new_string: "b" } },
      ]);
      parser.dispatch(event, 1000);
    }

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

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(2);
      // Edit (standalone) carries its error message in place
      expect(blocks[0]).toMatchObject({ kind: "tool", status: "error", errorMessage: expect.stringContaining("File not found") });
      expect(blocks[1]).toMatchObject({ kind: "tool", name: "bash", status: "completed" });
    });

    it("ignores tool_result for unknown tool_use_id without crashing", () => {
      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "nonexistent_id", is_error: true, content: "boom" },
      ]);
      parser.dispatch(userEvent, 2000);
      expect(projector.getBlocks()).toHaveLength(0);
    });
  });

  describe("optimistic tools", () => {
    it("marks PascalCase Read as completed (provider-style event)", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_Read_1", name: "Read", input: { path: "/scratch/foo.ts" } },
      ]), 1000);

      expect(projector.getBlocks()[0]).toMatchObject({ kind: "tool", name: "read", status: "completed" });
    });

    it("marks search and list as completed", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_search_1", name: "search", input: { pattern: "TODO", path: "." } },
        { type: "tool_use", id: "tool_list_1", name: "list", input: { pattern: "**/*.ts", path: "." } },
      ]), 1000);

      expect(projector.getBlocks()).toMatchObject([
        { kind: "tool", name: "search", status: "completed" },
        { kind: "tool", name: "list", status: "completed" },
      ]);
    });
  });

});
