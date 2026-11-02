import { describe, it, expect, beforeEach } from "bun:test";
import { StructuredOutputBuilder } from "../../../../src/infra/output/structured-output-builder";
import type { AnyBlock, ToolEntry, AgentGroupBlock } from "../../../../src/infra/output-blocks";

function resolvedTool(name: string, detail: string, timestamp: number): ToolEntry {
  return { kind: "tool", id: `${name}-${timestamp}`, name, presentation: { name, detail }, timestamp, status: "completed" };
}

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

    it("agent children grow without eviction so tracked indices stay valid", () => {
      const now = Date.now();
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Heavy search" }, now, "tu-agent-1");
      for (let i = 0; i < 60; i++) {
        builder.pushToolRowToAgent("agent-1", resolvedTool(`Tool${i}`, `detail-${i}`, now + i));
      }
      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.children).toHaveLength(60);
      // The first child's stored index (0) must still point to the first tool —
      // otherwise a tool_result patch arriving later for that child would land
      // on the wrong slot and leave it stuck "pending".
      expect(agent.children[0]?.name).toBe("Tool0");
      expect(agent.children[59]?.name).toBe("Tool59");
      expect(agent.totalToolCount).toBe(60);
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

    it("updateAgentLatestChild sets latestChild string", () => {
      const now = Date.now();
      builder.startAgent("agent-1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-agent-1");
      builder.updateAgentLatestChild("agent-1", "Reading src/index.ts");

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.latestChild).toBe("Reading src/index.ts");
    });

    it("completeAgent is no-op for unknown agent id", () => {
      builder.pushText("some text", Date.now(), "text-1");
      builder.completeAgent("unknown-id", 100);
      // Should not throw, blocks unchanged
      expect(builder.getBlocks()).toHaveLength(1);
    });

  });

  describe("multiple agents", () => {
    it("pushToolRowToAgent returns -1 for unknown agent ID", () => {
      const routed = builder.pushToolRowToAgent("unknown", resolvedTool("Read", "file.ts", Date.now()));
      expect(routed).toBe(-1);
    });

    it("second agent gets its own tools", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "First" }, now, "tu-a1");
      builder.pushToolRowToAgent("a1", resolvedTool("Read", "inside-a1.ts", now + 100));
      builder.completeAgent("a1", 500);

      builder.startAgent("a2", { containerKind: "subagent", label: "Plan", description: "Second" }, now + 200, "tu-a2");
      builder.pushToolRowToAgent("a2", resolvedTool("Grep", "inside-a2.ts", now + 300));

      const blocks = builder.getBlocks();
      expect(blocks).toHaveLength(2);
      const agent1 = agentGroup(blocks[0]);
      const agent2 = agentGroup(blocks[1]);
      expect(agent1.children).toHaveLength(1);
      expect(agent1.children[0]?.name).toBe("Read");
      expect(agent2.children).toHaveLength(1);
      expect(agent2.children[0]?.name).toBe("Grep");
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

    it("reactivates a completed agent when new children arrive", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.completeAgent("a1", 1000);

      const agent1 = agentGroup(builder.getBlocks()[0]);
      expect(agent1.status).toBe("completed");
      expect(agent1.duration).toBe(1000);

      // New child arrives — agent should reactivate
      builder.pushToolRowToAgent("a1", resolvedTool("Read", "file.ts", now + 2000));

      const agent2 = agentGroup(builder.getBlocks()[0]);
      expect(agent2.status).toBe("active");
      expect(agent2.duration).toBeUndefined();
      expect(agent2.children).toHaveLength(1);
    });

    it("does not reactivate an errored agent", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.errorAgent("a1", "something broke");

      builder.pushToolRowToAgent("a1", resolvedTool("Read", "file.ts", now + 2000));

      const agent = agentGroup(builder.getBlocks()[0]);
      expect(agent.status).toBe("error");
    });

    it("reactivated agent can be completed again with correct duration", () => {
      const now = Date.now();
      builder.startAgent("a1", { containerKind: "subagent", label: "Explore", description: "Searching" }, now, "tu-a1");
      builder.completeAgent("a1", 500);

      builder.pushToolRowToAgent("a1", resolvedTool("Read", "file.ts", now + 1000));

      const active = agentGroup(builder.getBlocks()[0]);
      expect(active.status).toBe("active");

      builder.completeAgent("a1", 3000);

      const done = agentGroup(builder.getBlocks()[0]);
      expect(done.status).toBe("completed");
      expect(done.duration).toBe(3000);
    });
  });

});
