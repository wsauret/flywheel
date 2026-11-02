import { describe, it, expect, beforeEach } from "bun:test";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import type { AgentGroupBlock, AnyBlock } from "../../../../src/infra/output-blocks";
import {
  makeAgentDispatchedEvent,
  makeAssistantEvent,
  makeToolResultEvent,
  makeToolResultAckEvent,
  makeUserToolResultEvent,
} from "./_parser-fixtures";

function agentGroup(block: AnyBlock | undefined): AgentGroupBlock {
  if (block?.kind !== "agentGroup") throw new Error(`Expected agentGroup block, got ${block?.kind ?? "missing"}`);
  return block;
}

describe("RuntimeEventProjector — agent lifecycle", () => {
  let projector: OutputProjector;
  let parser: RuntimeEventProjector;

  beforeEach(() => {
    projector = new OutputProjector({ executionCwd: "/workspace" });
    parser = new RuntimeEventProjector(projector);
  });

  describe("agent lifecycle", () => {
    it("unrelated assistant tools do NOT close an active agent", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_1", name: "subagent", input: { description: "exploring" } },
      ]);
      parser.dispatch(spawnEvent, 1000);

      const toolEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_2", name: "Bash", input: { command: "ls" } },
      ]);
      parser.dispatch(toolEvent, 1000);

      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_2" }]), 2000);

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.kind).toBe("agentGroup");
      expect((agentGroup(blocks[0])).status).toBe("pending");
      expect((agentGroup(blocks[0])).children).toHaveLength(0);
      expect(blocks[1]).toMatchObject({ kind: "tool", name: "bash", status: "completed" });
    });

    it("deferred subagent ignores internal user ack result until final render result", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "agent_1", name: "subagent", input: { persona: "explorer", description: "map files" } },
      ]), 1000);

      parser.dispatch(makeToolResultAckEvent("agent_1"), 1010);
      parser.dispatch(makeAgentDispatchedEvent("agent_1"), 1015);
      parser.dispatch(makeUserToolResultEvent([
        { tool_use_id: "agent_1", content: "Subagent dispatched (running in background)." },
      ]), 1020);

      let blocks = projector.getBlocks();
      let agent = agentGroup(blocks[0]);
      expect(agent.status).toBe("active");
      expect(agent.children).toHaveLength(0);

      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "child_1", name: "bash", input: { command: "rg models src/tui" } },
      ], "agent_1"), 1030);
      parser.dispatch(makeToolResultEvent("child_1"), 1040);

      blocks = projector.getBlocks();
      expect(blocks).toHaveLength(1);
      agent = agentGroup(blocks[0]);
      expect(agent.status).toBe("active");
      expect(agent.children).toHaveLength(1);
      expect(agent.children[0]?.name).toBe("bash");
      expect(agent.children[0]?.status).toBe("completed");

      parser.dispatch(makeToolResultEvent("agent_1", { content: "done" }), 1050);

      blocks = projector.getBlocks();
      agent = agentGroup(blocks[0]);
      expect(agent.status).toBe("completed");
      expect(agent.children).toHaveLength(1);
    });

  });

  describe("reset", () => {
    it("clears tracked subagents so subsequent tool_results are ignored", () => {
      const spawnEvent = makeAssistantEvent([
        { type: "tool_use", id: "tool_reset", name: "subagent", input: { description: "test" } },
      ]);
      parser.dispatch(spawnEvent, 1000);
      parser.reset();

      // tool_result after reset should not find the agent
      const resultEvent = makeToolResultEvent("tool_reset");
      parser.dispatch(resultEvent, 1000);

      // Agent should still be running (not completed) since reset cleared tracking
      const blocks = projector.getBlocks();
      const agent = agentGroup(blocks[0]);
      expect(agent.status).toBe("pending");
    });

    it("clears row location tracking so subsequent tool_results no-op", () => {
      const event = makeAssistantEvent([
        { type: "tool_use", id: "tool_row", name: "Bash", input: { command: "ls" } },
      ]);
      parser.dispatch(event, 1000);

      expect(projector.getBlocks()[0]).toMatchObject({ kind: "tool", name: "bash", status: "pending" });

      parser.reset();
      parser.dispatch(makeUserToolResultEvent([{ tool_use_id: "tool_row" }]), 2000);

      // Without its location in the map, the tool_result can't update the row;
      // it remains pending.
      expect(projector.getBlocks()[0]).toMatchObject({ kind: "tool", name: "bash", status: "pending" });
    });
  });

});
