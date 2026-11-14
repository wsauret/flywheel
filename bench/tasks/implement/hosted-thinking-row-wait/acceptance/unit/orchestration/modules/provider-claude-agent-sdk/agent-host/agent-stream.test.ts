import "../../../../../../tests/preload.ts";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { Redacted } from "effect";
import type { ModelInfo } from "../../../../../../src/infra/llm/models.js";
import { createAnthropicAdapter } from "../../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { LlmStreamError } from "../../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { ProviderAttemptFailure } from "../../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { stableSystemPrompt } from "../../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ThinkingStallError } from "../../../../../../src/orchestration/agent-runtime/llm/thinking-stall.js";
import type { ProviderStreamEvent } from "../../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { AgentRows, SignedBlock } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-file.js";
import { hostedStreamEvents, type HostedAnswer, type StepEvent } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-stream.js";
import type { HostStepItem } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-gate.js";

afterEach(() => { setSystemTime(); });

const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const STOP: HostStepItem = { kind: "stop", stopReason: "end_turn", usage: USAGE };

/** An engine that writes the rows of the response's signed blocks only when its stop chunk is read, as engine 2.1.321
 *  does. Each read that finds no new row moves the clock by four seconds, so a wait that a clock bounds runs out
 *  after a few reads. */
function deferredRows(blocks: readonly SignedBlock[], writes: boolean) {
  const written: SignedBlock[] = [];
  let seen = 0;
  const rows: AgentRows = {
    read: () => {
      if (written.length === seen) setSystemTime(new Date(Date.now() + 4_000));
      seen = written.length;
      return written;
    },
  };
  /** The step's events. `before(item)` runs as the step hands `item` on.
   *  @yields {StepEvent} Each item, then the step's end. */
  async function* events(items: readonly HostStepItem[], before: (item: HostStepItem) => void = () => {}): AsyncGenerator<StepEvent> {
    for (const item of items) {
      before(item);
      if (item.kind === "stop" && writes) written.push(...blocks);
      yield { kind: "item", item };
    }
    yield { kind: "done" };
  }
  return { rows, events };
}

/** Moves the clock by eleven seconds as the step hands on each item that is not the first block's. */
function slowAfterFirstBlock(item: HostStepItem): void {
  if (item.kind === "stop" || item.index > 0) setSystemTime(new Date(Date.now() + 11_000));
}

async function streamed(stream: AsyncGenerator<Anthropic.RawMessageStreamEvent>, sink: Anthropic.RawMessageStreamEvent[]): Promise<void> {
  for await (const event of stream) sink.push(event);
}

const THINKING: SignedBlock = { type: "thinking", thinking: "Let me think. More.", signature: "sig-1" };

describe("a hosted response whose engine writes its signed rows at the response's end", () => {
  const ITEMS: readonly HostStepItem[] = [
    { kind: "thinking", index: 0, text: "Let me " },
    { kind: "thinking", index: 0, text: "think." },
    { kind: "text", index: 1, text: "Do" },
    { kind: "text", index: 1, text: "ne." },
    STOP,
  ];

  test("streams the whole response in order, also when it generates for more than ten seconds after its thinking", async () => {
    setSystemTime(new Date("2026-11-11T00:00:00Z"));
    const { rows, events } = deferredRows([THINKING], true);
    const answers: HostedAnswer[] = [];
    const yielded: Anthropic.RawMessageStreamEvent[] = [];
    await streamed(hostedStreamEvents(events(ITEMS, slowAfterFirstBlock), rows, 0, "claude-haiku", async () => new Error("unused"), (answer) => { answers.push(answer); }, () => {}), yielded);

    expect(yielded[0]?.type).toBe("message_start");
    expect(yielded.slice(1)).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think." } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " More." } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: null } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Do" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ne." } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null, container: null }, usage: { ...USAGE, output_tokens_details: null, server_tool_use: null } },
      { type: "message_stop" },
    ]);
    expect(answers).toEqual([{ message: { role: "assistant", content: [THINKING, { type: "text", text: "Done." }] }, stopReason: "end_turn" }]);
  });

  test("fails transient once the bound passes after the stop chunk without the row", async () => {
    setSystemTime(new Date("2026-11-11T00:00:00Z"));
    const { rows, events } = deferredRows([THINKING], false);
    let stopRead = false;
    const yielded: Anthropic.RawMessageStreamEvent[] = [];
    const failed = await streamed(hostedStreamEvents(events(ITEMS, (item) => { slowAfterFirstBlock(item); if (item.kind === "stop") stopRead = true; }), rows, 0, "claude-haiku", async () => new Error("unused"), () => {}, () => {}), yielded).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(LlmStreamError);
    expect(failed).toMatchObject({ kind: "transient", message: expect.stringContaining("wrote no row") });
    // The bound started only once the step's stream ended with its stop chunk.
    expect(stopRead).toBe(true);
    expect(yielded.map((event) => event.type)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_delta"]);
  });

  test("fails with the service's answer when the step ends without a stop chunk while a row is missing", async () => {
    const { rows, events } = deferredRows([THINKING], false);
    const serviceFailure = new Error("overloaded");
    const failed = await streamed(hostedStreamEvents(events(ITEMS.slice(0, -1)), rows, 0, "claude-haiku", async () => serviceFailure, () => {}, () => {}), []).catch((error: unknown) => error);

    expect(failed).toBe(serviceFailure);
  });
});

describe("the adapter's stream deadline while the stream holds a response's later chunks back for a missing row", () => {
  const MODEL: ModelInfo = {
    provider: "claude-agent-sdk", family: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", reasoning: true, toolCall: true, attachment: false, temperature: true, openWeights: false,
    cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" }, modalities: { input: ["text"], output: ["text"] }, contextLimit: 200_000, outputLimit: 64_000,
  };
  /** The reasoning deadline of these tests, far below the time that the response generates after its thinking. */
  const REASONING_DEADLINE_MS = 30;

  /** Serves one response through the shared Anthropic adapter. The step hands on `later` after its thinking chunk, one
   *  every `gapMs`, and ends with its stop chunk only when `stalls` is false; a stalled step ends when the request is
   *  aborted, as the bridge's step does. */
  async function served(later: readonly HostStepItem[], stalls: boolean, gapMs = 5): Promise<{ events: ProviderStreamEvent[]; error: unknown }> {
    const { rows, events } = deferredRows([THINKING], true);
    const previous = process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
    process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS = String(REASONING_DEADLINE_MS);
    const client = await createAnthropicAdapter(Redacted.make("unused"), MODEL.id, MODEL, {
      operations: {
        isBadRequestError: () => false,
        createStream: async (_params, options) => {
          async function* step(): AsyncGenerator<StepEvent> {
            yield { kind: "item", item: { kind: "thinking", index: 0, text: "Let me think." } };
            for (const item of later) {
              await Bun.sleep(gapMs);
              yield { kind: "item", item };
            }
            if (stalls) await new Promise((_, reject) => { options.signal.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true }); });
            yield* events([STOP]);
          }
          const data = hostedStreamEvents(step(), rows, 0, MODEL.id, async () => new Error("unused"), () => {}, () => { options.onProgress?.(); });
          return { data: Object.assign(data, { controller: new AbortController() }), response: new Response(null) };
        },
      },
    });
    const yielded: ProviderStreamEvent[] = [];
    try {
      for await (const event of client.streamWithTools({ messages: [{ kind: "user", content: "hi" }], systemPrompt: stableSystemPrompt("system"), tools: [] })) yielded.push(event);
      return { events: yielded, error: undefined };
    } catch (error) {
      return { events: yielded, error };
    } finally {
      if (previous === undefined) delete process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS;
      else process.env.FLYWHEEL_STREAM_THINKING_STALL_TIMEOUT_MS = previous;
    }
  }

  const TEXT: readonly HostStepItem[] = Array.from({ length: 12 }, (_, chunk) => ({ kind: "text", index: 1, text: `part ${chunk} ` }));

  test("counts the chunks that it holds back as progress, so a response that generates past the deadline completes", async () => {
    const { events, error } = await served(TEXT, false);

    expect(error).toBeUndefined();
    expect(events.filter((event) => event.kind === "text_delta").length).toBe(TEXT.length);
  });

  test("counts the chunk that ends the thinking block, so chunks that each arrive in time outlast the deadline together", async () => {
    // Each chunk comes two thirds of the deadline after the one before it, and the first of them closes the thinking
    // block while its row is missing.
    const { events, error } = await served(TEXT.slice(0, 2), false, REASONING_DEADLINE_MS * 2 / 3);

    expect(error).toBeUndefined();
    expect(events.filter((event) => event.kind === "text_delta").length).toBe(2);
  });

  test("still fails a response that stops sending chunks as a thinking stall", async () => {
    const { error } = await served(TEXT.slice(0, 1), true);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error instanceof ProviderAttemptFailure && error.cause).toBeInstanceOf(ThinkingStallError);
  });
});

test("a redacted thinking block whose row the engine writes at the response's end streams before the next block", async () => {
  setSystemTime(new Date("2026-11-11T00:00:00Z"));
  const REDACTED: SignedBlock = { type: "redacted_thinking", data: "opaque==" };
  const { rows, events } = deferredRows([REDACTED], true);
  const answers: HostedAnswer[] = [];
  const yielded: Anthropic.RawMessageStreamEvent[] = [];
  const items: readonly HostStepItem[] = [
    { kind: "tool", index: 1, id: "toolu_1", name: "lookup" },
    { kind: "input", index: 1, json: "{\"key\":" },
    { kind: "input", index: 1, json: "\"a\"}" },
    { ...STOP, stopReason: "tool_use" },
  ];
  // The clock moves past the old bound as the step hands on its later chunks.
  await streamed(hostedStreamEvents(events(items, (item) => { if (item.kind !== "tool") setSystemTime(new Date(Date.now() + 11_000)); }), rows, 0, "claude-haiku", async () => new Error("unused"), (answer) => { answers.push(answer); }, () => {}), yielded);

  expect(yielded.slice(1)).toEqual([
    { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque==" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {}, caller: { type: "direct" } } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"key\":" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"a\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null, container: null }, usage: { ...USAGE, output_tokens_details: null, server_tool_use: null } },
    { type: "message_stop" },
  ]);
  expect(answers).toEqual([{ message: { role: "assistant", content: [REDACTED, { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "a" } }] }, stopReason: "tool_use" }]);
});
