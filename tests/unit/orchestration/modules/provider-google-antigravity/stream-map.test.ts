import { describe, expect, spyOn, test } from "bun:test";
import { Option } from "effect";
import { Log } from "../../../../../src/infra/log.js";
import { classifyProviderFailure, ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { withStreamAttempt } from "../../../../../src/orchestration/agent-runtime/llm/stream-attempt.js";
import { STREAM_IDLE_TIMEOUT_FAST_MS, STREAM_TTFT_TIMEOUT_MS } from "../../../../../src/orchestration/agent-runtime/llm/stream-liveness.js";
import type { ProviderStreamEvent, StreamTelemetryObservation } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { decodeSessionNotification, type AcpPromptResult, type AcpSessionUpdate } from "../../../../../src/orchestration/modules/provider-google-antigravity/acp/schema.js";
import { createRequestStream, type McpToolCall, type RequestStream } from "../../../../../src/orchestration/modules/provider-google-antigravity/stream-map.js";
import { controlledClock } from "../../agent-runtime/llm/_stream-deadline-clock.js";

spyOn(Log.create({ service: "provider-google-antigravity" }), "warn").mockImplementation(() => {});

const SESSION = "d7274172-83fc-41f8-86f0-d6541a04c389";

/** The `update` member of one `session/update` as agy 1.5.14 wrote it. */
interface RecordedUpdate {
  readonly sessionUpdate: string;
  readonly [field: string]: unknown;
}

/** One recorded update, through the connection's decoder. */
function frame(update: RecordedUpdate): AcpSessionUpdate {
  const decoded = decodeSessionNotification({ sessionId: SESSION, update });
  if (Option.isNone(decoded)) throw new Error("frame does not decode");
  return decoded.value.update;
}

const noLiveness = { preStream() {}, frame() {}, begin() {}, append() {}, complete() {} };

function requestStream() {
  const occupancy: number[] = [];
  const stream = createRequestStream({ requestId: "r1", liveness: noLiveness, onOccupancy: (used) => occupancy.push(used) });
  return { stream, occupancy };
}

function feed(stream: RequestStream, updates: readonly RecordedUpdate[]): ProviderStreamEvent[] {
  return updates.flatMap((update) => stream.update(frame(update)));
}

function failureOf(run: () => readonly ProviderStreamEvent[]) {
  try {
    run();
  } catch (error) {
    return classifyProviderFailure(error);
  }
  throw new Error("expected a failure");
}

// Recorded frames (agy 1.5.14, fake Gemini host): a text answer, a cached prompt and a thought, and a tool call.
const IDLE_OCCUPANCY = { sessionUpdate: "usage_update", used: 0, size: 1048576 };
const MESSAGE = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "c" } };
const TEXT_ANSWER = [
  { sessionUpdate: "available_commands_update", availableCommands: [{ name: "plan", description: "Plan carefully before executing a task." }] },
  IDLE_OCCUPANCY,
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "THOUGHT_A1" } },
  MESSAGE,
  { sessionUpdate: "usage_update", used: 1007, size: 1048576 },
  { sessionUpdate: "session_info_update", title: "Aux Title" },
];
const TEXT_RESULT: AcpPromptResult = { stopReason: "end_turn", usage: { inputTokens: 200, outputTokens: 7, cachedReadTokens: 800, cachedWriteTokens: 0, thoughtTokens: 2, totalTokens: 1007 } };
const TOOL_CALL_ID = "2c2ad464-9ba1-43cd-b510-914bf52cea28";
const TOOL_CALL = {
  sessionUpdate: "tool_call", toolCallId: TOOL_CALL_ID, name: "mcp_runtime_read_file", args: { path: "/a", toolSummary: "Read" },
  status: "in_progress", kind: "other", title: "Run mcp_runtime_read_file", rawInput: { path: "/a", toolSummary: "Read" },
};
const MCP_CALL: McpToolCall = { name: "read_file", arguments: { path: "/a" } };
const CALL_EVENTS: ProviderStreamEvent[] = [
  { kind: "tool_input_start", toolUseId: TOOL_CALL_ID, name: "read_file" },
  { kind: "tool_input_delta", toolUseId: TOOL_CALL_ID, partialJson: "{\"path\":\"/a\"}" },
  { kind: "tool_use", toolCall: { id: TOOL_CALL_ID, name: "read_file", input: { path: "/a" } } },
  { kind: "done", stopReason: "tool_use" },
];
const RATE_LIMIT_NOTICE = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n⚠ agent executor error: generating and executing: Error 429, Message: scripted 429, Status: RESOURCE_EXHAUSTED, Details: []\n" } };

describe("request stream", () => {
  test("a text answer streams keyed deltas, then usage with reasoning in the output, then done", () => {
    const { stream, occupancy } = requestStream();
    const events = [...feed(stream, TEXT_ANSWER), ...stream.promptEnded(TEXT_RESULT)];
    expect(events).toEqual([
      { kind: "provider_response_started" },
      { kind: "thinking_delta", text: "THOUGHT_A1", blockKey: "r1:thinking:0" },
      { kind: "thinking_complete", thinking: "THOUGHT_A1", blockKey: "r1:thinking:0" },
      { kind: "text_delta", text: "c", blockKey: "r1:text:1" },
      { kind: "text_complete", blockKey: "r1:text:1" },
      { kind: "usage", final: true, inputTokens: 200, outputTokens: 7, cacheReadTokens: 800, cacheCreateTokens: 0, reasoningTokens: 2 },
      { kind: "done", stopReason: "end_turn" },
    ]);
    expect(stream.usageReported).toBe(true);
    expect(occupancy).toEqual([0, 1007]);
  });

  const orders: ReadonlyArray<readonly [string, (stream: RequestStream) => ProviderStreamEvent[]]> = [
    ["the ACP frame comes first", (stream) => [...feed(stream, [TOOL_CALL]), ...stream.toolCall(MCP_CALL)]],
    ["the MCP call comes first", (stream) => [...stream.toolCall(MCP_CALL), ...feed(stream, [TOOL_CALL])]],
  ];
  test.each(orders)("a call settles the request at one tool_use with the MCP arguments when %s", (_order, run) => {
    const { stream } = requestStream();
    expect(run(stream)).toEqual([{ kind: "provider_response_started" }, ...CALL_EVENTS]);
    expect(stream.usageReported).toBe(false);
    // The prompt stays open; its end belongs to the request that delivers the result.
    expect(stream.promptEnded(TEXT_RESULT)).toEqual([]);
  });

  test("a call that agy runs itself does not settle the request", () => {
    const { stream } = requestStream();
    const own = { ...TOOL_CALL, name: "manage_task" };
    const events = [
      ...feed(stream, [own, { ...own, sessionUpdate: "tool_call_update", status: "completed" }, MESSAGE]),
      ...stream.toolCall(MCP_CALL),
      ...stream.promptEnded(TEXT_RESULT),
    ];
    expect(events.map((event) => event.kind)).toEqual(["provider_response_started", "text_delta", "text_complete", "usage", "done"]);
  });

  test("a failure notice then end_turn without usage throws the typed failure and never starts the response", () => {
    let frames = 0;
    const stream = createRequestStream({ requestId: "r1", liveness: { ...noLiveness, frame() { frames += 1; } }, onOccupancy: () => {} });
    expect(feed(stream, [RATE_LIMIT_NOTICE])).toEqual([]);
    expect(failureOf(() => stream.promptEnded({ stopReason: "end_turn" }))._tag).toBe("RateLimitFailure");
    expect(frames).toBe(0);
    // A refused prompt was not served, so an engine stop leaves the route unavailable.
    expect(classifyProviderFailure(stream.connectionEnded({ kind: "ended" }))._tag).toBe("RouteUnavailableFailure");
  });

  test("a final chunk of the notice form in a prompt that reports usage is the model's answer", () => {
    const { stream } = requestStream();
    expect(feed(stream, [RATE_LIMIT_NOTICE])).toEqual([]);
    expect(stream.promptEnded(TEXT_RESULT)).toEqual([
      { kind: "provider_response_started" },
      { kind: "text_delta", text: RATE_LIMIT_NOTICE.content.text, blockKey: "r1:text:0" },
      { kind: "text_complete", blockKey: "r1:text:0" },
      { kind: "usage", final: true, inputTokens: 200, outputTokens: 7, cacheReadTokens: 800, cacheCreateTokens: 0, reasoningTokens: 2 },
      { kind: "done", stopReason: "end_turn" },
    ]);
  });

  test("an unknown notice fails as a provider failure", () => {
    const { stream } = requestStream();
    feed(stream, [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n⚠ something new went wrong\n" } }]);
    expect(failureOf(() => stream.promptEnded({ stopReason: "end_turn" }))._tag).toBe("UnknownProviderFailure");
  });

  test("text of the notice form that the model continues is model text", () => {
    const { stream } = requestStream();
    const events = [...feed(stream, [RATE_LIMIT_NOTICE, MESSAGE]), ...stream.promptEnded(TEXT_RESULT)];
    expect(events.filter((event) => event.kind === "text_delta").map((event) => event.kind === "text_delta" && event.text)).toEqual([RATE_LIMIT_NOTICE.content.text, "c"]);
    expect(events.at(-1)).toEqual({ kind: "done", stopReason: "end_turn" });
  });

  test("occupancy reports alone emit no usage", () => {
    const { stream, occupancy } = requestStream();
    expect(feed(stream, [{ sessionUpdate: "usage_update", used: 1277, size: 1048576 }, { sessionUpdate: "usage_update", used: 1385, size: 1048576 }])).toEqual([]);
    expect(occupancy).toEqual([1277, 1385]);
  });

  test("a silent main step times out once although agy keeps sending chatter", async () => {
    const time = controlledClock();
    const observed: StreamTelemetryObservation[] = [];
    let dispatched = 0;
    let signal: AbortSignal | undefined;
    const attempt = withStreamAttempt<ProviderStreamEvent>(async function* (streamAttempt) {
      signal = streamAttempt.signal;
      const liveness = streamAttempt.armLiveness({ label: "test", provider: "Google Antigravity", telemetry: { observe: (observation) => { observed.push(observation); } }, clock: time.clock });
      const stream = createRequestStream({ requestId: "r1", liveness, onDispatch: () => { dispatched += 1; }, onOccupancy: () => {} });
      expect(dispatched).toBe(0);
      await stream.released();
      expect(dispatched).toBe(1);
      const chatter = [
        { sessionUpdate: "usage_update", used: 1277, size: 1048576 },
        { sessionUpdate: "session_info_update", title: "Aux Title" },
        { sessionUpdate: "available_commands_update", availableCommands: [{ name: "plan" }] },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } },
        { ...TOOL_CALL, sessionUpdate: "tool_call_update", status: "completed" },
      ];
      // Each gap is shorter than the idle deadline that a model frame arms, so only a step that chatter does not
      // keep alive reaches the first-frame deadline.
      const gapMs = STREAM_IDLE_TIMEOUT_FAST_MS / 2;
      for (let tick = 0; tick * gapMs <= STREAM_TTFT_TIMEOUT_MS; tick += 1) {
        const update = chatter[tick % chatter.length];
        if (update !== undefined) yield* stream.update(frame(update));
        await time.advance(gapMs);
      }
    }, {});
    const failure = await (async () => {
      try {
        for await (const _event of attempt) { /* drain */ }
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    expect(failure instanceof ProviderAttemptFailure && failure.failure._tag).toBe("TransientNetworkFailure");
    expect(observed.filter((observation) => observation.source === "watchdog" && observation.kind === "timeout")).toHaveLength(1);
    // The aborted attempt signal is the bridge's cue to cancel the session.
    expect(signal?.aborted).toBe(true);
  });

  test("an engine that stops before the first model frame leaves the route unavailable", () => {
    const { stream } = requestStream();
    feed(stream, [IDLE_OCCUPANCY]);
    expect(classifyProviderFailure(stream.connectionEnded({ kind: "ended" }))._tag).toBe("RouteUnavailableFailure");
    const { stream: answering } = requestStream();
    feed(answering, [MESSAGE]);
    expect(classifyProviderFailure(answering.connectionEnded({ kind: "ended" }))._tag).toBe("TransientNetworkFailure");
  });
});
