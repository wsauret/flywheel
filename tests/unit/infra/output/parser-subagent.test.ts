import { describe, it, expect, beforeEach } from "bun:test";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import { OutputToolProjector } from "../../../../src/infra/output/output-tool-projector";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder";
import { blockIdentity } from "../../../../src/protocol/block-identity";
import { applyOutputDelta, buildBlockIndex } from "../../../../src/protocol/client/transcript-delta";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import type { AgentGroupBlock, AnyBlock, ToolEntry } from "../../../../src/infra/output-blocks";
import {
  makeAssistantEvent,
  makeToolResultEvent,
  makeUserToolResultEvent,
} from "./_parser-fixtures";

function agentGroup(block: AnyBlock | undefined): AgentGroupBlock {
  if (block?.kind !== "agentGroup") throw new Error(`Expected agentGroup block, got ${block?.kind ?? "missing"}`);
  return block;
}

function toolRow(block: AnyBlock | undefined): ToolEntry {
  if (block?.kind !== "tool") throw new Error(`Expected tool row, got ${block?.kind ?? "missing"}`);
  return block;
}

describe("RuntimeEventProjector — subagent", () => {
  let projector: OutputProjector;
  let parser: RuntimeEventProjector;

  beforeEach(() => {
    projector = new OutputProjector({ executionCwd: "/workspace" });
    parser = new RuntimeEventProjector(projector);
  });

  describe("subagent spawn", () => {
    it("creates an AgentGroupBlock on Task tool_use", () => {
      const event = makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_1",
          name: "subagent",
          input: { description: "research files", persona: "Explore" },
        },
      ]);

      parser.dispatch(event, 1000);
      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.kind).toBe("agentGroup");
      const agent = agentGroup(blocks[0]);
      expect(agent.label).toBe("Explore");
      expect(agent.description).toBe("research files");
      expect(agent.status).toBe("pending");
    });

    it("creates an AgentGroupBlock on Agent tool_use", () => {
      const event = makeAssistantEvent([
        {
          type: "tool_use",
          id: "tool_2",
          name: "subagent",
          input: { description: "planning step" },
        },
      ]);

      parser.dispatch(event, 1000);
      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = agentGroup(blocks[0]);
      expect(agent.label).toBe("Subagent"); // no persona → falls back to display name
      expect(agent.description).toBe("planning step");
    });

    it("shows a neutral tool row when streamed input has not named an action", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_3", name: "subagent", input: {} },
      ]);

      parser.dispatch(event, 1000);
      const initialBlocks = projector.getBlocks();
      expect(initialBlocks).toHaveLength(1);
      const initial = toolRow(initialBlocks[0]);
      expect(initial.presentation).toEqual({ name: "Subagent", detail: "" });
      expect(initial.status).toBe("streaming");

      const complete = createRuntimeEvent("tool.input.completed", {
        type: "tool.input.completed",
        tool_use: { id: "tool_3", name: "subagent", input: {} },
      });
      parser.dispatch(complete, 1000);
      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(toolRow(blocks[0]).presentation).toEqual({ name: "Subagent", detail: "" });
    });

    it.each(["steer", "resume", "retry"] as const)("renders %s as an ordinary action row", (kind) => {
      projector.apply({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Review provider settings" }, timestamp: 900 });
      projector.apply({ type: "set-agent-link", toolUseId: "dispatch", linkUri: "flywheel://session/private-session-id" });
      parser.dispatch(makeAssistantEvent([{
        type: "tool_use",
        id: `tool_${kind}`,
        name: "subagent",
        input: { kind, session_id: "private-session-id", display_goal: "Invented name" },
      }]), 1000);

      const row = toolRow(projector.getBlocks()[1]);
      expect(row.presentation).toEqual({
        name: `Subagent ${kind}`,
        detail: "Review provider settings",
      });
      expect(row.presentation.detail).not.toContain("private-session-id");
    });

    it("names the child of a parent's process interrupt by its goal, never by its session id", () => {
      projector.apply({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: { description: "Review provider settings" }, timestamp: 900 });
      projector.apply({ type: "set-agent-link", toolUseId: "dispatch", linkUri: "flywheel://session/c0ffee000001" });
      parser.dispatch(makeAssistantEvent([{ type: "tool_use", id: "interrupt", name: "process", input: { action: "interrupt", process_id: "c0ffee000001" } }]), 1000);
      expect(toolRow(projector.getBlocks()[1]).presentation).toEqual({ name: "Interrupt", detail: "Review provider settings" });
    });

    it("names a workflow child of a process interrupt by its run title, live and from seeded history", () => {
      projector.apply({ type: "tool-use", toolUseId: "launch", name: "workflow", input: { source: { kind: "path", path: "scratch/workflows/unit-a-review.workflow.yaml" }, summary: "Unit G review" }, timestamp: 900 });
      projector.apply({ type: "set-agent-link", toolUseId: "launch", linkUri: "flywheel://session/c0ffee000002" });
      parser.dispatch(makeAssistantEvent([{ type: "tool_use", id: "interrupt", name: "process", input: { action: "interrupt", process_id: "c0ffee000002" } }]), 1000);
      expect(toolRow(projector.getBlocks()[1]).presentation).toEqual({ name: "Interrupt", detail: "Unit G review" });

      const builder = new StructuredOutputBuilder();
      const seeded = new OutputToolProjector(builder, { executionCwd: "/workspace" });
      seeded.seedAgentBlocks(projector.getBlocks().filter((block) => block.kind === "agentGroup"));
      seeded.handleToolUse({ type: "tool-use", toolUseId: "resume", name: "process", input: { action: "resume", process_id: "c0ffee000002" }, timestamp: 1100 });
      expect(toolRow(builder.getBlocks().at(-1)).presentation.detail).toBe("Unit G review");
    });

    it("ignores supplied goal for an unknown target", () => {
      projector.apply({ type: "tool-use", toolUseId: "steer", name: "subagent", input: { kind: "steer", session_id: "unknown", display_goal: "Invented name" }, timestamp: 1000 });
      expect(toolRow(projector.getBlocks()[0]).presentation).toEqual({ name: "Subagent steer", detail: "" });
    });

    it("refines a dispatch in place before its long prompt completes", () => {
      projector.onChange = () => {};
      projector.apply({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: {}, timestamp: 1000 });
      projector.apply({ type: "push-system-message", message: "Intervening content", timestamp: 1001 });
      const view = { blocks: [...projector.getBlocks()], streamingToolText: {} };
      const blockIndex = buildBlockIndex(view.blocks);
      const identity = blockIdentity(toolRow(view.blocks[0]));
      projector.drainChanges();
      projector.apply({ type: "tool-input-delta", toolUseId: "dispatch", partialJson: '{"kind":"dispatch","description":"Inspect files","prompt":"unfinished' });
      expect(agentGroup(projector.getBlocks()[0])).toMatchObject({ id: "dispatch", description: "Inspect files" });
      expect(blockIdentity(agentGroup(projector.getBlocks()[0]))).toBe(identity);
      const delta = projector.drainChanges();
      expect(delta.fullResync).toBe(false);
      expect(applyOutputDelta(view, { blocks: delta.changes.map(change => {
        if (change.kind === "append-content") throw new Error("Unexpected text append");
        return { ...change, blockId: blockIdentity(change.block) };
      }) }, blockIndex)).toBe(true);
      expect(view.blocks.map(block => block.kind)).toEqual(["agentGroup", "system"]);
      projector.apply({ type: "tool-input-delta", toolUseId: "dispatch", partialJson: " and more of the prompt" });
      expect(projector.drainChanges().changes).toEqual([]);
      projector.apply({ type: "tool-input-complete", toolUseId: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Inspect files", prompt: "finished" }, timestamp: 1002 });
      expect(projector.getBlocks().map(block => block.kind)).toEqual(["agentGroup", "system"]);
      expect(agentGroup(projector.getBlocks()[0]).id).toBe("dispatch");
    });

    it("preserves the streamed dispatch card and its activity until the actual child completes", () => {
      projector.apply({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: {}, timestamp: 1000 });
      const identity = blockIdentity(toolRow(projector.getBlocks()[0]));
      projector.apply({ type: "tool-input-delta", toolUseId: "dispatch", partialJson: '{"kind":"dispatch","description":"Inspect' });
      expect(agentGroup(projector.getBlocks()[0]).description).toBe("Inspect");
      projector.apply({ type: "tool-input-delta", toolUseId: "dispatch", partialJson: ' files","persona":"explorer","prompt":"Long prompt' });
      expect(agentGroup(projector.getBlocks()[0])).toMatchObject({ label: "Explorer", description: "Inspect files", agentType: "explorer", status: "pending" });
      expect(blockIdentity(agentGroup(projector.getBlocks()[0]))).toBe(identity);
      projector.apply({ type: "tool-input-complete", toolUseId: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Inspect files", persona: "explorer", prompt: "Long prompt completed" }, timestamp: 1001 });
      projector.apply({ type: "set-agent-link", toolUseId: "dispatch", linkUri: "flywheel://session/child" });
      projector.apply({ type: "set-subagent-model", toolUseId: "dispatch", model: "recorded-model" });
      projector.apply({ type: "agent-dispatched", toolUseId: "dispatch", timestamp: 1002 });
      projector.apply({ type: "tool-result-ack", toolUseId: "dispatch" });
      for (let i = 0; i < 5; i++) {
        projector.apply({ type: "tool-use", toolUseId: `read-${i}`, parentToolUseId: "dispatch", name: "read", input: { path: `/workspace/file-${i}.ts` }, timestamp: 1003 + i });
        projector.apply({ type: "tool-result", toolUseId: `read-${i}`, parentToolUseId: "dispatch", outcome: "ok", timestamp: 1004 + i });
      }
      projector.apply({ type: "end-turn", timestamp: 1010, finalStatus: "completed" });
      const active = agentGroup(projector.getBlocks()[0]);
      expect(active).toMatchObject({ id: "dispatch", status: "active", description: "Inspect files", linkUri: "flywheel://session/child", model: "recorded-model", totalToolCount: 5 });
      expect(active.children.slice(-4).map(child => child.id)).toEqual(["read-1", "read-2", "read-3", "read-4"]);
      projector.apply({ type: "tool-result", toolUseId: "dispatch", outcome: "ok", details: { totalTokens: 1234 }, timestamp: 1020 });
      expect(agentGroup(projector.getBlocks()[0])).toMatchObject({ id: "dispatch", status: "completed", totalTokens: 1234, linkUri: "flywheel://session/child", description: "Inspect files" });
      expect(agentGroup(projector.getBlocks()[0]).duration).toBeDefined();
    });

    it("retains the child's goal after its card leaves the capped live viewport", () => {
      const builder = new StructuredOutputBuilder(2);
      const tools = new OutputToolProjector(builder, { executionCwd: "/workspace" });
      tools.handleToolUse({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Inspect retained identity" }, timestamp: 0 });
      tools.setChildLink("dispatch", "flywheel://session/child");
      tools.resolveToolResult("dispatch", "ok", undefined, "render");
      for (let i = 0; i < 3; i++) builder.pushSystemMessage(`later ${i}`, i + 1);
      expect(builder.getBlocks().some(block => block.kind === "agentGroup")).toBe(false);
      tools.handleToolUse({ type: "tool-use", toolUseId: "steer", name: "subagent", input: { kind: "steer", session_id: "child" }, timestamp: 6 });
      expect(toolRow(builder.getBlocks().at(-1)).presentation.detail).toBe("Inspect retained identity");
    });

    it("settles accepted steering while the original child stays active", () => {
      projector.apply({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Trace terminal repaint regression" }, timestamp: 1000 });
      projector.apply({ type: "set-agent-link", toolUseId: "dispatch", linkUri: "flywheel://session/child" });
      projector.apply({ type: "agent-dispatched", toolUseId: "dispatch", timestamp: 1001 });
      const child = projector.getBlocks()[0];
      projector.apply({ type: "tool-use", toolUseId: "steer", name: "subagent", input: {}, timestamp: 1002 });
      projector.apply({ type: "tool-input-delta", toolUseId: "steer", partialJson: '{"kind":"steer","session_id":"child","message":"Focus on repaint"}' });
      expect(toolRow(projector.getBlocks()[1]).presentation).toEqual({ name: "Subagent steer", detail: "Trace terminal repaint regression" });
      projector.apply({ type: "tool-input-complete", toolUseId: "steer", name: "subagent", input: { kind: "steer", session_id: "child", message: "Focus on repaint" }, timestamp: 1003 });
      projector.apply({ type: "tool-result", toolUseId: "steer", outcome: "ok", content: [{ type: "text", text: '{"status":"accepted","parked":false}' }], timestamp: 1004 });
      expect(projector.getBlocks()[0]).toBe(child);
      expect(agentGroup(child).status).toBe("active");
      expect(toolRow(projector.getBlocks()[1])).toMatchObject({ status: "completed", presentation: { name: "Subagent steer", detail: "Trace terminal repaint regression" } });
    });

    it("keeps rejected steering separate from the completed child", () => {
      projector.apply({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Inspect files" }, timestamp: 1000 });
      projector.apply({ type: "set-agent-link", toolUseId: "dispatch", linkUri: "flywheel://session/child" });
      projector.apply({ type: "tool-result", toolUseId: "dispatch", outcome: "ok", timestamp: 1001 });
      const child = projector.getBlocks()[0];
      projector.apply({ type: "tool-use", toolUseId: "steer", name: "subagent", input: { kind: "steer", session_id: "child", display_goal: "Invented name" }, timestamp: 1002 });
      projector.apply({ type: "tool-result", toolUseId: "steer", outcome: "error", content: [{ type: "text", text: "Cannot steer this subagent because it has already settled." }], timestamp: 1003 });
      expect(projector.getBlocks()[0]).toBe(child);
      expect(toolRow(projector.getBlocks()[1])).toMatchObject({ presentation: { name: "Subagent steer", detail: "Inspect files" }, status: "error", errorMessage: "Cannot steer this subagent because it has already settled" });
    });

    it("keeps a retry linked and active after the parent's turn until terminal failure", () => {
      projector.apply({ type: "tool-use", toolUseId: "retry", name: "subagent", input: { kind: "retry", session_id: "child" }, timestamp: 1000 });
      projector.apply({ type: "set-agent-link", toolUseId: "retry", linkUri: "flywheel://session/child" });
      projector.apply({ type: "tool-result-ack", toolUseId: "retry" });
      projector.apply({ type: "end-turn", timestamp: 1001, finalStatus: "completed" });
      expect(toolRow(projector.getBlocks()[0])).toMatchObject({ status: "pending", linkUri: "flywheel://session/child" });
      projector.resetTracking();
      projector.apply({ type: "end-turn", timestamp: 1002, finalStatus: "completed" });
      expect(toolRow(projector.getBlocks()[0]).status).toBe("pending");
      const reopened = new OutputProjector({ executionCwd: "/workspace" });
      reopened.seedBlocks(projector.getBlocks());
      reopened.apply({ type: "tool-result", toolUseId: "retry", outcome: "error", content: [{ type: "text", text: "Provider failed" }], timestamp: 1002 });
      expect(toolRow(reopened.getBlocks()[0])).toMatchObject({ status: "error", errorMessage: "Provider failed", linkUri: "flywheel://session/child" });
    });

    it.each(["cancelled", "partial", "paused"] as const)("preserves retry %s meaning", (status) => {
      projector.apply({ type: "tool-use", toolUseId: "retry", name: "subagent", input: { kind: "retry", session_id: "child" }, timestamp: 1000 });
      projector.apply({ type: "set-agent-link", toolUseId: "retry", linkUri: "flywheel://session/child" });
      projector.apply({ type: "tool-result-ack", toolUseId: "retry" });
      if (status === "paused") projector.apply({ type: "agent-paused", toolUseId: "retry", pausedBy: "person", timestamp: 1001 });
      else projector.apply({ type: "tool-result", toolUseId: "retry", outcome: status === "cancelled" ? "cancelled" : "ok", details: { partial: status === "partial" }, timestamp: 1001 });
      expect(toolRow(projector.getBlocks()[0])).toMatchObject(status === "cancelled"
        ? { status: "error", errorMessage: "Canceled" }
        : { status: "blocked", statusMessage: status === "paused" ? "Interrupted" : "Partial" });
      if (status === "paused") {
        const reopened = new OutputProjector({ executionCwd: "/workspace" });
        reopened.seedBlocks(projector.getBlocks());
        reopened.apply({ type: "agent-dispatched", toolUseId: "retry", timestamp: 1002 });
        expect(toolRow(reopened.getBlocks()[0]).status).toBe("pending");
        reopened.apply({ type: "tool-result", toolUseId: "retry", outcome: "ok", timestamp: 1003 });
        expect(toolRow(reopened.getBlocks()[0]).status).toBe("completed");
      }
    });

  });

  // ── Subagent completion ──

  describe("parallel subagent spawns", () => {
    it("parallel agents each close only on their own tool_result", () => {
      // Spawn three agents
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_a", name: "subagent", input: { description: "A" } },
      ]), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_b", name: "subagent", input: { description: "B" } },
      ]), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "tool_c", name: "subagent", input: { description: "C" } },
      ]), 1000);

      // Complete only Agent B
      parser.dispatch(makeToolResultEvent("tool_b"), 1000);

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(3);
      expect((agentGroup(blocks[0])).status).toBe("pending");
      expect((agentGroup(blocks[1])).status).toBe("completed");
      expect((agentGroup(blocks[2])).status).toBe("pending");
    });

  });

  describe("multi-turn subagent text duplication", () => {
    function makeTextDelta(text: string, blockKey = "main"): RuntimeEvent {
      return {
        type: "model.content.delta",
        data: { type: "model.content.delta", delta: { type: "text_delta", text }, block_key: blockKey },
      };
    }

    it("does not duplicate text across turns with subagent spawns", () => {
      // Turn 1: text + 2 subagent spawns
      parser.dispatch(makeTextDelta("Turn 1 text.", "run-1:0"), 1000);
      // tool_input_start events (assistant with tool_use only)
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "sub_1", name: "subagent", input: { description: "explorer 1", persona: "explorer" } },
      ]), 1001);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "sub_2", name: "subagent", input: { description: "explorer 2", persona: "explorer" } },
      ]), 1002);
      // onTurnAssistantMessage (text only, no tool_use)
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Turn 1 text." },
      ], undefined, "run-1"), 1003);

      // Subagent tool results come back
      parser.dispatch(makeToolResultEvent("sub_1"), 2000);
      parser.dispatch(makeToolResultEvent("sub_2"), 2001);

      // Turn 2: new text + 2 more subagent spawns
      parser.dispatch(makeTextDelta("Turn 2 text.", "run-2:0"), 3000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "sub_3", name: "subagent", input: { description: "scout 1", persona: "explorer" } },
      ]), 3001);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "sub_4", name: "subagent", input: { description: "scout 2", persona: "explorer" } },
      ]), 3002);
      // onTurnAssistantMessage for Turn 2
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Turn 2 text." },
      ], undefined, "run-2"), 3003);

      const blocks = projector.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(2);
      if (textBlocks[0]!.kind === "text") expect(textBlocks[0]!.content).toBe("Turn 1 text.");
      if (textBlocks[1]!.kind === "text") expect(textBlocks[1]!.content).toBe("Turn 2 text.");
    });

    it("subagent text event between streaming and turn-end does not cause duplication", () => {
      // Streaming execution race: parent streams text, spawns a subagent,
      // subagent emits its own assistant text event (with parent_tool_use_id)
      // BEFORE the parent's onTurnAssistantMessage fires. The subagent's
      // text event must not complete the parent's assistant draft.
      parser.dispatch(makeTextDelta("Parent text.", "run-1:0"), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "sub_1", name: "subagent", input: { description: "explorer", persona: "explorer" } },
      ]), 1001);

      // Subagent text arrives mid-turn (streaming execution)
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Subagent searching files." },
      ], "sub_1"), 1002);

      // Parent's onTurnAssistantMessage fires with the same text
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Parent text." },
      ], undefined, "run-1"), 1003);

      const blocks = projector.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      if (textBlocks[0]!.kind === "text") {
        expect(textBlocks[0]!.content).toBe("Parent text.");
      }
    });
  });

  describe("subagent-child tool resolution", () => {
    it("sets errorMessage on agent child tool for error tool_result", () => {
      // Spawn agent
      const agentEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool", name: "subagent", input: { description: "work" } },
      ]);
      parser.dispatch(agentEvent, 1000);

      const childEvent = makeAssistantEvent(
        [{ type: "tool_use", id: "child_1", name: "Edit", input: { path: "test.ts", old_string: "a", new_string: "b" } }],
        "agent_tool",
      );
      parser.dispatch(childEvent, 1500);

      const userEvent = makeUserToolResultEvent([
        { tool_use_id: "child_1", is_error: true, content: "<tool_use_error>File not found: test.ts</tool_use_error>" },
      ]);
      parser.dispatch(userEvent, 2000);

      const blocks = projector.getBlocks();
      const agent = agentGroup(blocks[0]);
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0]).toMatchObject({ status: "error", errorMessage: "File not found: test.ts" });
    });

    it("routes deferred bash (no streaming start) into the agent block, not a top-level Ran group", () => {
      // Bash tool_input_start/delta events are deferred in the assistant turn
      // stream, so a subagent's bash arrives only as a tool_input_complete with
      // no prior pending entry. It must still group under its agent block via
      // parent_tool_use_id rather than falling back to a top-level exec group.
      const agentEvent = makeAssistantEvent([
        { type: "tool_use", id: "agent_tool_3", name: "subagent", input: { description: "work" } },
      ]);
      parser.dispatch(agentEvent, 1000);

      const bashComplete = createRuntimeEvent("tool.input.completed", {
        type: "tool.input.completed",
        tool_use: { id: "bash_1", name: "bash", input: { command: "bash tests/e2e/tui-chat.sh" } },
        parent_tool_use_id: "agent_tool_3",
      });
      parser.dispatch(bashComplete, 1500);

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      const agent = agentGroup(blocks[0]);
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0]?.name).toBe("bash");
    });
  });

});
