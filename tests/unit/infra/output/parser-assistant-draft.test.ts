import { beforeEach, describe, expect, it } from "bun:test";
import { EMPTY_OUTPUT_CHANGE_BATCH } from "../../../../src/infra/output/output-block-delta";
import { OutputProjector } from "../../../../src/infra/output/output-projector";
import { RuntimeEventProjector } from "../../../../src/infra/output/runtime-event-projector";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import { makeAssistantEvent as assistantEvent } from "./_parser-fixtures";
import { handleStreamEvent, type AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result";
import { emitAgentStreamEvent } from "../../../../src/orchestration/agent-runtime/runner-stream-events";
import { createThinkingAccumulator, emitTurnAssistant } from "../../../../src/orchestration/agent-runtime/emit";
import { createTurnUsageTracker } from "../../../../src/orchestration/agent-runtime/turn-usage-tracker";
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types";
import { RequestToolMap } from "../../../helpers/request-tool-surface";

describe("RuntimeEventProjector — assistant draft reconciliation", () => {
  let projector: OutputProjector;
  let parser: RuntimeEventProjector;
  let turn: AssistantTurnResult;

  beforeEach(() => {
    projector = new OutputProjector({ executionCwd: "/workspace" });
    parser = new RuntimeEventProjector(projector);
    turn = {
      entryId: "entry", outcome: { kind: "ok", stopReason: "unknown" }, assistantContent: [], toolCalls: [],
      assistantMetadata: undefined, lastAssistantMetadata: undefined, usageAnchor: undefined,
      terminalEvent: undefined, transportContext: undefined,
    };
  });

  function makeAssistantEvent(content: Parameters<typeof assistantEvent>[0]): RuntimeEvent {
    const event = assistantEvent(content);
    if (event.type !== "model.assistant_message.recorded") throw new Error("expected assistant event");
    return { ...event, data: { ...event.data, entry_id: turn.entryId } };
  }

  function makeTextDelta(text: string, blockKey = "main"): RuntimeEvent {
    const publication = handleStreamEvent({ kind: "text_delta", text, blockKey }, turn);
    return {
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "text_delta", text }, block_key: publication.outputIdentity?.blockKey },
    };
  }

  function makeEstimatedTokensDelta(estimatedTokens: number, blockKey = "thinking"): RuntimeEvent {
    return {
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "thinking_delta", thinking: "", estimated_tokens: estimatedTokens }, block_key: blockKey },
    };
  }

  function makeTurnCompleted(): RuntimeEvent {
    return {
      type: "model.turn.completed",
      data: { type: "model.turn.completed" },
    };
  }

  /** Runs one provider response through the runner's reduction and emission,
   *  then records its assistant message, and returns the identities of the
   *  thought rows after each event and whether any change batch was a full
   *  resync, which is how a retraction reaches clients. */
  function respond(events: readonly ProviderStreamEvent[], recorded = (content: AssistantTurnResult["assistantContent"]) => content) {
    projector.onChange = () => {};
    projector.drainChanges();
    const context = {
      options: { onEvent: (event: RuntimeEvent) => parser.dispatch(event, 1000) },
      contextWindow: 200_000,
      costTracker: createTurnUsageTracker({ emit: () => {}, budgetStreamId: "draft" }),
      providerSessionKey: "draft",
      parentToolUseId: undefined,
      thinking: createThinkingAccumulator(),
      tools: new RequestToolMap(),
    };
    const thoughtIds: string[][] = [];
    let resynced = false;
    const observe = () => {
      thoughtIds.push(projector.getBlocks().flatMap((block) => block.kind === "thinking" ? [block.id] : []));
      resynced ||= projector.drainChanges().fullResync;
    };
    for (const event of events) {
      const published = handleStreamEvent(event, turn);
      if (published.kind === "done" || published.kind === "stream_retry" || published.kind === "stream_resample" || published.kind === "stream_attempt_start" || published.kind === "provider_status") continue;
      emitAgentStreamEvent(published, context);
      observe();
    }
    emitTurnAssistant(context.options.onEvent, recorded(turn.assistantContent), context.costTracker, undefined, "entry");
    observe();
    return { thoughtIds, resynced };
  }

  it("keeps one thought row from its first delta through settlement", () => {
    const { thoughtIds, resynced } = respond([
      { kind: "thinking_delta", text: "", blockKey: "run:0" },
      { kind: "thinking_delta", text: "Weigh the ", blockKey: "run:0" },
      { kind: "thinking_delta", text: "options.", blockKey: "run:0" },
      { kind: "thinking_complete", thinking: "Weigh the options.", signature: "c2lnbmVk", blockKey: "run:0" },
      { kind: "text_delta", text: "Done.", blockKey: "run:1" },
    ]);
    expect(thoughtIds).toEqual([[], ["entry:0"], ["entry:0"], ["entry:0"], ["entry:0"], ["entry:0"]]);
    expect(resynced).toBe(false);
    expect(projector.getBlocks()).toMatchObject([
      { kind: "thinking", id: "entry:0", content: "Weigh the options.", status: "completed" },
      { kind: "text", id: "entry:1", content: "Done." },
    ]);
  });

  it("corrects a reasoning summary that differs from its streamed draft in place", () => {
    const { thoughtIds, resynced } = respond([
      { kind: "thinking_delta", text: "Inspecting ", blockKey: "run:0" },
      { kind: "thinking_delta", text: "events\n\n", blockKey: "run:0" },
      { kind: "thinking_complete", thinking: "Inspecting events\n\n", blockKey: "run:0" },
      { kind: "reasoning", id: "rs_1", encryptedContent: "ENC", summary: [{ type: "summary_text", text: "Inspecting events" }], blockKey: "run:0" },
    ]);
    expect(new Set(thoughtIds.flat())).toEqual(new Set(["entry:0"]));
    expect(resynced).toBe(false);
    expect(projector.getBlocks()).toMatchObject([{ kind: "thinking", id: "entry:0", content: "Inspecting events" }]);
  });

  it("keeps a thought that no part claims beside the text that takes its coordinate until settlement", () => {
    const { thoughtIds } = respond([
      { kind: "thinking_delta", text: "Unsigned thought", blockKey: "run:thinking:0" },
      { kind: "thinking_complete", thinking: "Unsigned thought", blockKey: "run:thinking:0" },
      { kind: "text_delta", text: "Answer", blockKey: "run:1" },
    ]);
    expect(thoughtIds.slice(0, -1)).toEqual([["entry:0"], ["entry:0"], ["entry:0"]]);
    expect(thoughtIds.at(-1)).toEqual([]);
    expect(projector.getBlocks()).toMatchObject([{ kind: "text", id: "entry:0", content: "Answer" }]);
  });

  it("retracts streamed text whose coordinate moved when a dropped thought left the recorded message", () => {
    // A repetition trip records the partial without its looping thought, so
    // the text that streamed at the second coordinate settles at the first.
    respond([
      { kind: "thinking_delta", text: "loop loop", blockKey: "run:0" },
      { kind: "thinking_complete", thinking: "loop loop", signature: "c2lnbmVk", blockKey: "run:0" },
      { kind: "text_delta", text: "partial answer", blockKey: "run:1" },
    ], (content) => content.filter((part) => part.type !== "thinking"));
    expect(projector.getBlocks()).toEqual([expect.objectContaining({ kind: "text", id: "entry:0", content: "partial answer" })]);
    // The retracted run takes its characters with it; the dropped thought's
    // stay, as for any thought that no part claims.
    expect(projector.snapshot().streamingOutputChars).toBe("loop loop".length + "partial answer".length);
  });

  it("corrects terminal narration in place under its canonical public identity", () => {
    projector.onChange = () => {};
    parser.dispatch(makeTextDelta("draft answer", "entry:0"), 1000);
    projector.drainChanges();
    parser.dispatch({
      type: "model.text.reconciled",
      data: { content: "correct answer", block_key: "entry:0" },
    }, 1001);
    expect(projector.getBlocks()).toMatchObject([{ kind: "text", id: "entry:0", content: "correct answer" }]);
    const changes = projector.drainChanges();
    expect(changes.fullResync).toBe(false);
    expect(changes.changes).toEqual([
      { kind: "upsert", index: 0, block: expect.objectContaining({ id: "entry:0", content: "correct answer" }) },
    ]);
  });

  it("renders progress thinking as assistant text once without completing the turn", () => {
    const delta = (thinking: string): RuntimeEvent => ({
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "thinking_delta", thinking, presentation: "progress" }, block_key: "entry:0" },
    });
    parser.dispatch(delta("Found the cause. "), 1000);
    parser.dispatch(delta("Checking the fix."), 1001);
    expect(projector.getBlocks().filter((block) => block.kind === "text")).toMatchObject([
      { content: "Found the cause. Checking the fix." },
    ]);
    parser.dispatch(makeAssistantEvent([
      { type: "thinking", thinking: "Found the cause. Checking the fix.", presentation: "progress" },
    ]), 1002);
    expect(projector.getBlocks().filter((block) => block.kind === "text")).toHaveLength(1);
    expect(projector.getBlocks().filter((block) => block.kind === "thinking")).toHaveLength(0);
  });

  it("redacts progress thinking at the display boundary", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    parser.dispatch({
      type: "model.content.delta",
      data: {
        type: "model.content.delta",
        delta: { type: "thinking_delta", thinking: secret, presentation: "progress" },
        block_key: "entry:0",
      },
    }, 1000);
    parser.dispatch(makeAssistantEvent([
      { type: "thinking", thinking: secret, presentation: "progress" },
    ]), 1001);

    expect(projector.getBlocks().filter((block) => block.kind === "text")).toMatchObject([
      { content: "[redacted secret]" },
    ]);
  });

  // The runner publishes a response's terminal event only after its assistant
  // message settles, so completion ends a response whose rows are already settled.
  it("keeps the settled text row when turn completion follows the final assistant content", () => {
    parser.dispatch(makeTextDelta("FW_DRAFT_SMOKE", "main"), 1000);
    parser.dispatch(makeAssistantEvent([
      { type: "text", text: "FW_DRAFT_SMOKE" },
    ]), 1001);
    parser.dispatch(makeTurnCompleted(), 1002);

    const textBlocks = projector.getBlocks().filter((block) => block.kind === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({ kind: "text", content: "FW_DRAFT_SMOKE" });
  });

  it("does not duplicate final text when final block boundaries differ from streamed boundaries", () => {
    parser.dispatch(makeTextDelta("Hello world", "main"), 1000);

    parser.dispatch(makeAssistantEvent([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]), 1001);

    const textBlocks = projector.getBlocks().filter((block) => block.kind === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({ kind: "text", content: "Hello world" });
  });

  it("coalesces adjacent final text without crossing assistant content boundaries", () => {
    parser.dispatch(makeAssistantEvent([
      { type: "text", text: "first " },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "next thought" },
      { type: "text", text: "after thinking" },
      { type: "tool_use", id: "tool-1", name: "write", input: { path: "file.ts", content: "x" } },
      { type: "text", text: "after tool" },
    ]), 1000);

    expect(projector.getBlocks().map((block) => block.kind === "text" || block.kind === "thinking" ? `${block.kind}:${block.content}` : block.kind)).toEqual([
      "text:first answer",
      "thinking:next thought",
      "text:after thinking",
      "tool",
      "text:after tool",
    ]);
  });

  it("uses one canonical run for adjacent provider parts from their first public output", () => {
    projector.onChange = () => {};
    parser.dispatch(makeTextDelta("first ", "draft:1"), 1000);
    expect(projector.drainChanges().changes).toEqual([
      { kind: "insert", index: 0, block: expect.objectContaining({ kind: "text", content: "first " }) },
    ]);

    parser.dispatch(makeTextDelta("ans", "draft:2"), 1001);
    expect(projector.drainChanges().changes).toEqual([
      { kind: "append-content", index: 0, identity: { kind: "text", id: "entry:0" }, contentOffset: 6, text: "ans" },
    ]);

    parser.dispatch(makeAssistantEvent([
      { type: "text", text: "first " },
      { type: "text", text: "answer" },
    ]), 1002);

    expect(projector.getBlocks().filter((block) => block.kind === "text")).toEqual([
      expect.objectContaining({ kind: "text", id: "entry:0", content: "first answer" }),
    ]);
    expect(projector.drainChanges().changes).toEqual([
      { kind: "append-content", index: 0, identity: { kind: "text", id: "entry:0" }, contentOffset: 9, text: "wer" },
    ]);
    expect(projector.drainChanges()).toBe(EMPTY_OUTPUT_CHANGE_BATCH);
  });

  it("does not treat token-only thinking estimates as rendered final thinking", () => {
    parser.dispatch(makeEstimatedTokensDelta(100), 1000);

    parser.dispatch(makeAssistantEvent([
      { type: "thinking", thinking: "Reasoning redacted" },
      { type: "text", text: "Done" },
    ]), 1001);

    const blocks = projector.getBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "thinking", id: "entry:0", content: "Reasoning redacted" });
    expect(blocks[1]).toMatchObject({ kind: "text", id: "entry:1", content: "Done" });
  });

  function makeToolInputCompleted(id: string, blockKey: string): RuntimeEvent {
    return {
      type: "tool.input.completed",
      data: { type: "tool.input.completed", tool_use: { id, name: "bash", input: { command: "sleep 100" } }, block_key: blockKey },
    };
  }

  // Settlement arrives while the foreground tool still runs; only live stream
  // events may move the phase, or the status falls back to a stalled Waiting.
  it("settling the assistant message keeps a running foreground tool executing", () => {
    parser.dispatch(makeThinkingDelta("Let me run the gates.", "entry:0"), 1000);
    parser.dispatch(makeToolInputCompleted("tool-1", "entry:2"), 1001);
    expect(projector.streamPhase).toBe("tool_executing");

    parser.dispatch(makeAssistantEvent([
      { type: "thinking", thinking: "Let me run the gates." },
      { type: "text", text: "Running the gates." },
      { type: "tool_use", id: "tool-1", name: "bash", input: { command: "sleep 100" } },
    ]), 1002);

    expect(projector.streamPhase).toBe("tool_executing");
    expect(projector.getBlocks().filter((block) => block.kind === "text")).toMatchObject([{ id: "entry:1", content: "Running the gates." }]);
  });

  it.each([
    ["streamed live", true],
    ["never streamed", false],
  ])("renders settled thinking that %s without leaving tool execution", (_label, streamed) => {
    if (streamed) parser.dispatch(makeThinkingDelta("Plan the run.", "entry:0"), 999);
    parser.dispatch(makeToolInputCompleted("tool-1", "entry:1"), 1000);

    parser.dispatch(makeAssistantEvent([
      { type: "thinking", thinking: "Plan the run." },
      { type: "tool_use", id: "tool-1", name: "bash", input: { command: "sleep 100" } },
    ]), 1001);

    expect(projector.streamPhase).toBe("tool_executing");
    expect(projector.getBlocks().filter((block) => block.kind === "thinking")).toMatchObject([{ id: "entry:0", content: "Plan the run." }]);
  });

  it("settling signed thinking completes its block without ending the live thinking phase", () => {
    parser.dispatch({
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "thinking_complete", thinking: "Weigh the options.", provisional_block_key: "provisional" }, block_key: "entry:0" },
    }, 1000);
    expect(projector.streamPhase).toBe("thinking");

    parser.dispatch(makeAssistantEvent([{ type: "thinking", thinking: "Weigh the options.", signature: "c2lnbmVk" }]), 1001);

    expect(projector.streamPhase).toBe("thinking");
    expect(projector.getBlocks()).toMatchObject([{ kind: "thinking", id: "entry:0", content: "Weigh the options.", status: "completed" }]);
  });

  // tool_input_start publishes an entry-less assistant message as a live
  // preview of the call the model is writing.
  it("a live tool-input preview moves the phase to generating", () => {
    parser.dispatch(makeThinkingDelta("Plan the call.", "entry:0"), 1000);
    parser.dispatch({
      type: "model.assistant_message.recorded",
      data: { type: "model.assistant_message.recorded", message: { content: [{ type: "tool_use", id: "tool-1", name: "bash", input: {} }] } },
    }, 1001);

    expect(projector.streamPhase).toBe("generating");
  });

  function makeThinkingDelta(thinking: string, blockKey = "think:1"): RuntimeEvent {
    return {
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "thinking_delta", thinking }, block_key: blockKey },
    };
  }

  function makeStreamRetried(parentToolUseId?: string): RuntimeEvent {
    if (!parentToolUseId) {
      turn.assistantContent = [];
      turn.entryId = "retried";
    }
    return {
      type: "model.stream.retried",
      data: { attempt: 1, reason: "boom", ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}) },
    };
  }

  it("stream retry preserves emitted text but removes unfinished thinking", () => {
    // Attempt 1 streams partial thinking + text, then the stream fails.
    parser.dispatch(makeThinkingDelta("half a thought", "run1:think"), 1000);
    parser.dispatch(makeTextDelta("partial ans", "run1:text"), 1001);
    parser.dispatch(makeStreamRetried(), 1002);

    // Attempt 2 regenerates under fresh blockKeys (new runId).
    parser.dispatch(makeTextDelta("The full answer", "run2:text"), 1003);
    parser.dispatch(makeAssistantEvent([{ type: "text", text: "The full answer" }]), 1004);

    const blocks = projector.getBlocks();
    const textBlocks = blocks.filter((block) => block.kind === "text");
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks.map((block) => block.content)).toEqual(["partial ans", "The full answer"]);
    expect(blocks.filter((block) => block.kind === "thinking")).toEqual([]);
  });

  it("does not retract independent emitted text blocks", () => {
    projector.onChange = () => {};
    parser.dispatch(makeTextDelta("partial ", "run1:text:1"), 1000);
    parser.dispatch(makeTextDelta("answer", "run1:text:2"), 1001);
    expect(projector.getBlocks()).toHaveLength(1);
    projector.drainChanges();

    parser.dispatch(makeStreamRetried(), 1002);
    expect(projector.drainChanges()).toBe(EMPTY_OUTPUT_CHANGE_BATCH);
    parser.dispatch(makeStreamRetried(), 1003);
    expect(projector.drainChanges()).toBe(EMPTY_OUTPUT_CHANGE_BATCH);

    expect(projector.getBlocks().filter((block) => block.kind === "text").map((block) => block.content)).toEqual(["partial answer"]);
  });

  it("a subagent's stream retry does not retract the parent's draft", () => {
    parser.dispatch(makeTextDelta("parent text", "parent:text"), 1000);
    parser.dispatch(makeStreamRetried("tool-123"), 1001);

    const textBlocks = projector.getBlocks().filter((block) => block.kind === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toMatchObject({ kind: "text", content: "parent text" });
  });

  it("retraction keeps committed blocks from before the failed attempt", () => {
    // A committed assistant message from an earlier response.
    parser.dispatch(makeTextDelta("earlier turn", "run0:text"), 1000);
    parser.dispatch(makeAssistantEvent([{ type: "text", text: "earlier turn" }]), 1001);

    // New response begins (resets draft tracking), streams, and fails.
    parser.dispatch({ type: "agent.provider_response.started", data: {} }, 1002);
    turn.assistantContent = [];
    turn.entryId = "next";
    parser.dispatch(makeTextDelta("doomed draft", "run1:text"), 1003);
    parser.dispatch(makeStreamRetried(), 1004);

    const textBlocks = projector.getBlocks().filter((block) => block.kind === "text");
    expect(textBlocks.map((block) => block.content)).toEqual(["earlier turn", "doomed draft"]);
  });
});
