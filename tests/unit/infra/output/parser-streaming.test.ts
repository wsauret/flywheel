import { describe, it, expect, beforeEach } from "bun:test";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import { makeAssistantEvent } from "./_parser-fixtures";

describe("RuntimeEventProjector — streaming text deltas", () => {
  let projector: OutputProjector;
  let parser: RuntimeEventProjector;

  beforeEach(() => {
    projector = new OutputProjector({ executionCwd: "/workspace" });
    parser = new RuntimeEventProjector(projector);
  });

  describe("streaming text deltas", () => {
    function makeTextDelta(text: string, blockKey = "main:0"): RuntimeEvent {
      return {
        type: "model.content.delta",
        data: { type: "model.content.delta", delta: { type: "text_delta", text }, block_key: blockKey },
      };
    }

    function makeUserEvent(): RuntimeEvent {
      return {
        type: "model.user_message.recorded",
        data: { type: "model.user_message.recorded", message: { content: "continue" } },
      };
    }

    function makeTextComplete(blockKey = "main"): RuntimeEvent {
      return {
        type: "model.text.completed",
        data: { type: "model.text.completed", block_key: blockKey },
      };
    }

    it("keeps two streamed messages with different block keys as separate blocks", () => {
      parser.dispatch(makeTextDelta("First synthesizing the chosen shape.", "run-1:0"), 1000);
      parser.dispatch(makeTextComplete("run-1:0"), 1001);
      parser.dispatch(makeTextDelta("I completed the plan.", "run-2:0"), 1002);

      const blocks = projector.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(2);
      if (textBlocks[0]!.kind === "text") expect(textBlocks[0]!.content).toBe("First synthesizing the chosen shape.");
      if (textBlocks[1]!.kind === "text") expect(textBlocks[1]!.content).toBe("I completed the plan.");
    });

    it("keeps a keyed text block intact across another key's lifecycle event", () => {
      parser.dispatch(makeTextDelta("All required reviewers were", "main"), 1000);
      parser.dispatch(makeTextComplete("sub"), 1001);
      parser.dispatch(makeTextDelta(" dispatched already…", "main"), 1002);

      const textBlocks = projector.getBlocks().filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      if (textBlocks[0]?.kind === "text") {
        expect(textBlocks[0].id).toBe("main");
        expect(textBlocks[0].content).toBe("All required reviewers were dispatched already…");
      }
    });

    it("treats empty text deltas as no-ops and appends leading spaces verbatim", () => {
      parser.dispatch(makeTextDelta("", "main"), 1000);
      expect(projector.getBlocks().filter(b => b.kind === "text")).toHaveLength(0);

      parser.dispatch(makeTextDelta("All required reviewers were", "main"), 1001);
      parser.dispatch(makeTextDelta("", "main"), 1002);
      parser.dispatch(makeTextDelta(" dispatched already…", "main"), 1003);

      const textBlocks = projector.getBlocks().filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      if (textBlocks[0]?.kind === "text") expect(textBlocks[0].content).toBe("All required reviewers were dispatched already…");
    });
    it("skips duplicate text in assistant event after streaming deltas", () => {
      parser.dispatch(makeTextDelta("Hello "), 1000);
      parser.dispatch(makeTextDelta("world"), 1001);

      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Hello world" },
      ], undefined, "main"), 1002);

      const blocks = projector.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      if (textBlocks[0]!.kind === "text") {
        expect(textBlocks[0]!.content).toBe("Hello world");
      }
    });

    it("keeps separate assistant messages as separate text blocks", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "First assistant turn." },
      ]), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Second assistant turn." },
      ]), 1001);

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.kind).toBe("text");
      expect(blocks[1]?.kind).toBe("text");
      if (blocks[0]?.kind === "text" && blocks[1]?.kind === "text") {
        expect(blocks[0].content).toBe("First assistant turn.");
        expect(blocks[1].content).toBe("Second assistant turn.");
      }
    });

    it("keeps streamed text after a user event separate from prior assistant text", () => {
      parser.dispatch(makeTextDelta("First streamed response.", "run-1:0"), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "First streamed response." },
      ], undefined, "run-1"), 1001);
      parser.dispatch(makeUserEvent(), 1002);
      parser.dispatch(makeTextDelta("Second streamed response.", "run-2:0"), 1003);
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Second streamed response." },
      ], undefined, "run-2"), 1004);

      const blocks = projector.getBlocks();
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.kind).toBe("text");
      expect(blocks[1]?.kind).toBe("text");
      if (blocks[0]?.kind === "text" && blocks[1]?.kind === "text") {
        expect(blocks[0].content).toBe("First streamed response.");
        expect(blocks[1].content).toBe("Second streamed response.");
      }
    });

    it("processes tool_use blocks from assistant event even when text was streamed", () => {
      parser.dispatch(makeTextDelta("Response text"), 1000);

      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Response text" },
        { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } },
      ], undefined, "main"), 1001);

      const blocks = projector.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      const tools = blocks.filter(b => b.kind === "tool");
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ kind: "tool", name: "bash" });
    });

    it("skips duplicate text when tool_input_start assistant events arrive between streaming and turn-end", () => {
      // Reproduces the bug: text_delta → tool_input_start (assistant with tool_use only)
      // → onTurnAssistantMessage (assistant with text). The intermediate tool_input_start
      // assistant event must not complete the assistant draft.
      parser.dispatch(makeTextDelta("Dispatching all 4 explorers in parallel."), 1000);

      // tool_input_start emits assistant events with only tool_use blocks
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "sub_1", name: "subagent", input: { description: "explorer 1", persona: "explorer" } },
      ]), 1001);
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "sub_2", name: "subagent", input: { description: "explorer 2", persona: "explorer" } },
      ]), 1002);

      // onTurnAssistantMessage fires with the full content including text
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Dispatching all 4 explorers in parallel." },
      ], undefined, "main"), 1003);

      const blocks = projector.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(1);
      if (textBlocks[0]!.kind === "text") {
        expect(textBlocks[0]!.content).toBe("Dispatching all 4 explorers in parallel.");
      }
    });

    it("keeps non-streamed text after streamed tool-use text in a separate block", () => {
      parser.dispatch(makeTextDelta("Turn 1", "run-1:0"), 1000);
      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Turn 1" },
        { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } },
      ], undefined, "run-1"), 1001);

      parser.dispatch(makeAssistantEvent([
        { type: "text", text: "Turn 2 without deltas" },
      ]), 1002);

      const blocks = projector.getBlocks();
      const textBlocks = blocks.filter(b => b.kind === "text");
      expect(textBlocks).toHaveLength(2);
      if (textBlocks[0]!.kind === "text") expect(textBlocks[0]!.content).toBe("Turn 1");
      if (textBlocks[1]!.kind === "text") expect(textBlocks[1]!.content).toBe("Turn 2 without deltas");
    });

    it("thinking in assistant messages preserves provider order before tool calls", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "thinking", thinking: "Full thinking" },
        { type: "tool_use", id: "t1", name: "search", input: { pattern: "test" } },
      ]), 1000);

      const blocks = projector.getBlocks();
      expect(blocks.map((block) => block.kind)).toEqual(["thinking", "tool"]);
      expect(blocks[0]).toMatchObject({ kind: "thinking", content: "Full thinking" });
      expect(blocks[1]).toMatchObject({ kind: "tool", name: "search" });
    });

  });

  describe("streaming-token accounting during thinking", () => {
    function makeEstimatedTokensDelta(estimatedTokens: number, blockKey = "thinking"): RuntimeEvent {
      return {
        type: "model.content.delta",
        data: { type: "model.content.delta", delta: { type: "thinking_delta", thinking: "", estimated_tokens: estimatedTokens }, block_key: blockKey },
      };
    }

    function makeThinkingDelta(thinking: string, blockKey = "thinking", parentToolUseId?: string): RuntimeEvent {
      return {
        type: "model.content.delta",
        data: {
          type: "model.content.delta",
          delta: { type: "thinking_delta", thinking },
          block_key: blockKey,
          ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
        },
      };
    }

    it("counts standalone thinking text into streamingOutputChars", () => {
      parser.dispatch(makeThinkingDelta("deep thought"), 1000);

      expect(projector.snapshot().streamingOutputChars).toBe("deep thought".length);
    });

    it("counts foreground mid-turn thinking without attaching it to tool output", () => {
      parser.dispatch(makeAssistantEvent([
        { type: "tool_use", id: "t1", name: "Read", input: { path: "test.ts" } },
      ]), 1000);

      parser.dispatch(makeThinkingDelta("reasoning between tools"), 1001);

      const blocks = projector.getBlocks();
      expect(blocks.map((block) => block.kind)).toEqual(["tool", "thinking"]);
      expect(blocks[1]).toMatchObject({ kind: "thinking", content: "reasoning between tools" });
      expect(projector.snapshot().streamingOutputChars).toBe("reasoning between tools".length);
    });

    it("counts redacted-thinking token estimates as tokens*4 chars and flips phase to thinking", () => {
      parser.dispatch(makeEstimatedTokensDelta(100), 1000);
      parser.dispatch(makeEstimatedTokensDelta(28), 1001);

      expect(projector.streamPhase).toBe("thinking");
      expect(projector.snapshot().streamingOutputChars).toBe((100 + 28) * 4);
    });

    it("does not count subagent thinking toward the foreground stream", () => {
      parser.dispatch(makeThinkingDelta("subagent reasoning", "sub:0", "parent-tool-1"), 1000);

      expect(projector.snapshot().streamingOutputChars).toBe(0);
    });
  });
});
