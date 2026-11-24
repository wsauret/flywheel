import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../../../../../src/infra/output/projector/structured-output-builder";
import type { AnyBlock, AgentGroupBlock } from "../../../../../src/infra/output-blocks";
import { OutputProjector } from "../../../../../src/infra/output/projector/output-projector";
import { projectFrontendOutputBlock } from "../../../../../src/orchestration/app-service/frontend-output-blocks";

function agentGroup(block: AnyBlock | undefined): AgentGroupBlock {
  if (block === undefined) throw new Error("Expected agentGroup block, got none");
  if (block.kind !== "agentGroup") throw new Error(`Expected agentGroup block, got ${block.kind}`);
  return block;
}

describe("StructuredOutputBuilder — agent lifecycle", () => {
  let builder: StructuredOutputBuilder;

  beforeEach(() => {
    builder = new StructuredOutputBuilder();
  });

  describe("agent lifecycle", () => {
    it("startAgent creates an AgentGroupBlock with active status", () => {
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching codebase", agentType: "explorer" }, Date.now(), "tu-agent-1");
      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.kind).toBe("agentGroup");
      const agent = agentGroup(blocks[0]);
      expect(agent.id).toBe("agent-1");
      expect(agent.label).toBe("Explore");
      expect(agent.description).toBe("Searching codebase");
      expect(agent.agentType).toBe("explorer");
      expect(agent.status).toBe("pending");
      expect(agent.children).toEqual([]);
    });

    it("pushTool does NOT capture into active agent (explicit routing only)", () => {
      const now = Date.now();
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-agent-1");
      builder.pushTool("Edit", { name: "Edit", detail: "file.ts" }, now + 100);

      const blocks = builder.getBlocks();
      // Agent block + standalone tool — pushTool never captures
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.kind).toBe("agentGroup");
      expect((agentGroup(blocks[0])).children).toHaveLength(0);
      expect(blocks[1]?.kind).toBe("tool");
    });

    it("completeAgent marks a budget-capped run partial", () => {
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, Date.now(), "tu-agent-1");
      builder.completeAgent("agent-1", 1500, { partial: true, totalTokens: 10 });
      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("partial");
      expect(agent.totalTokens).toBe(10);
    });

    it("errorAgent sets status to error with message", () => {
      const now = Date.now();
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-agent-1");
      builder.errorAgent("agent-1", "Timeout exceeded");

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("error");
      if (agent.status !== "error") return;
      expect(agent.failure.message).toBe("Timeout exceeded");
    });

    it("completeAgent is no-op for unknown agent id", () => {
      builder.pushText("some text", Date.now(), "text-1");
      builder.completeAgent("unknown-id", 100);
      // Should not throw, blocks unchanged
      expect(builder.getBlocks()).toHaveLength(1);
    });

  });

  describe("closePendingAgentBlocks", () => {
    it("auto-completes active agents", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.closePendingAgentBlocks(now + 5000);

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("completed");
      expect(agent.duration).toBe(5000);
    });

    it("does not affect already-completed agents", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.completeAgent("a1", 1000);
      builder.closePendingAgentBlocks(now + 5000);

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("completed");
      expect(agent.duration).toBe(1000); // original duration preserved
    });

  });

  describe("interruptOpenAgentBlocks (session teardown)", () => {
    it("pauses dispatched (active) agents, not just pending ones", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "First" }, now, "tu-a1");
      builder.dispatchAgent("a1");
      builder.interruptOpenAgentBlocks(now + 5000);

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("interrupted");
      expect(agent.duration).toBe(5000);
    });

    it("interrupting preserves the goal description; the interrupted status is the sole Interrupted label", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "General", description: "Run sleep command" }, now, "tu-a1");
      builder.dispatchAgent("a1");
      builder.interruptAgent("a1", 5000);

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("interrupted");
      expect(agent.description).toBe("Run sleep command");
    });

    it("interrupting drops the initializing placeholder instead of relabeling it", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "General", description: "Initializing…" }, now, "tu-a1");
      builder.dispatchAgent("a1");
      builder.interruptAgent("a1", 5000);

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("interrupted");
      expect(agent.description).toBe("");
    });

    it("turn-boundary sweeps leave dispatched agents running (their task settles them)", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "First" }, now, "tu-a1");
      builder.dispatchAgent("a1");
      builder.closePendingAgentBlocks(now + 5000);
      builder.interruptPendingAgentBlocks(now + 5000);

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("active");
    });
  });

  describe("agent reactivation", () => {
    it("a resumed paused agent is active again with its goal, claims no time it cannot know, and completes once", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.dispatchAgent("a1");
      builder.pauseAgent("a1", "person");
      // The wall time since launch is not the child's active time: only the child's own clock states it.
      expect(builder.getBlocks()[0]).toMatchObject({ kind: "agentGroup", status: "paused", pausedBy: "person" });
      expect(builder.getBlocks()[0]).not.toHaveProperty("duration");

      builder.dispatchAgent("a1");
      expect(builder.getBlocks()[0]).toMatchObject({ kind: "agentGroup", status: "active", description: "Searching" });
      expect(builder.getBlocks()[0]).not.toHaveProperty("pausedBy");

      builder.completeAgent("a1", 3000);
      expect(builder.getBlocks()[0]).toMatchObject({ kind: "agentGroup", status: "completed", duration: 3000 });
    });

    it("a pause over an interrupted block moves it to paused: the pause fact is the authority", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.dispatchAgent("a1");
      builder.interruptAgent("a1", 1000);
      builder.pauseAgent("a1", "person");
      expect(builder.getBlocks()[0]).toMatchObject({ kind: "agentGroup", status: "paused", pausedBy: "person", description: "Searching" });
      expect(builder.getBlocks()[0]).not.toHaveProperty("duration");
    });

    it("a resumed crash-interrupted agent is active again and completes once", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.dispatchAgent("a1");
      builder.interruptAgent("a1", 1000);
      expect(builder.getBlocks()[0]).toMatchObject({ kind: "agentGroup", status: "interrupted", duration: 1000 });

      builder.dispatchAgent("a1");
      expect(builder.getBlocks()[0]).toMatchObject({ kind: "agentGroup", status: "active", description: "Searching" });
      expect(builder.getBlocks()[0]).not.toHaveProperty("duration");

      builder.completeAgent("a1", 3000);
      expect(builder.getBlocks()[0]).toMatchObject({ kind: "agentGroup", status: "completed", duration: 3000 });
    });
  });

  describe("subagent and code-nested calls in the parent projector", () => {
    it("A subagent tool call in the parent produces one agent card whose activity comes from its own activity field", () => {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      projector.apply({ type: "tool-use", toolUseId: "dispatch", name: "subagent", input: { kind: "dispatch", description: "Explore" }, timestamp: 1 });
      // The subagent's own calls belong to its session; a nested event that
      // reaches the parent adds no row to the card.
      projector.apply({ type: "tool-use", toolUseId: "inner", parentToolUseId: "dispatch", name: "read", input: { path: "a.ts" }, timestamp: 2 });
      projector.apply({ type: "tool-result", toolUseId: "inner", parentToolUseId: "dispatch", outcome: "ok", content: [{ type: "text", text: "x" }], timestamp: 3 });

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      const card = agentGroup(blocks[0]);
      expect(card.toolUseId).toBe("dispatch");
      expect(card.children).toEqual([]);

      // The wire card states the activity its transcript projection selected,
      // never one derived from the rows it carries.
      const activity = { name: "Read", detail: "b.ts" };
      const hydrated = { ...card, activity, children: [{ kind: "tool" as const, id: "c", name: "grep", presentation: { name: "Grep", detail: "x" }, sentence: { name: "Searched", detail: "x" }, timestamp: 2, status: "completed" as const }] };
      const wire = projectFrontendOutputBlock(hydrated);
      expect(wire).toMatchObject({ kind: "agentGroup", activity, children: [] });
    });

    it("A code-nested fact is placed standalone with nestedInCode", () => {
      const projector = new OutputProjector({ executionCwd: "/workspace" });
      projector.apply({ type: "tool-use", toolUseId: "nested", parentToolUseId: "script", nestedInCode: true, name: "read", input: { path: "a.ts" }, timestamp: 1 });
      projector.apply({ type: "tool-result", toolUseId: "nested", parentToolUseId: "script", outcome: "ok", content: [{ type: "text", text: "x" }], timestamp: 2 });

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: "tool", id: "nested", name: "read", runCategoryOverride: "execute", status: "completed" });
    });
  });
});
