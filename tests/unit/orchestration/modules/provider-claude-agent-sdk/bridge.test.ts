import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaRefusalStopDetails } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { ContextLengthExceededError, LlmStreamError, ModelAccessRefusedError, ProviderRequestValidationError, QuotaCoordinationError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { classifyProviderFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import {
  A1, A2, admittedStart, answers, apiErrorLine, assistantError, callHandler, cliInit, ENVELOPE, event, extendedWindowRefused, forwardDiagnostics, includedReport, init, logLines, messageStart, messageStop, MODEL_REQUEST_LINE, parked,
  modelRequest, payloads, ping, R1, rateLimitReport, records, refused, request, responseBlock, send, settle, STEP, stopReason, text, toolUse, turnDone, turnResult, U1, U1_WITH_ENVIRONMENT, U2, until, withBridge, type FakeQuery, originsOf,
} from "./_bridge-harness.js";

forwardDiagnostics();
const temporaryDirectory = temporaryDirectories();

/** The turn result of a hook that refused the request's own step without asking the gate: the CLI ends its completed
 *  turn with no request and no stop reason (CLI 2.1.295, on the fake host). */
const GATE_UNREACHABLE = turnResult({ is_error: true, api_error_status: null, terminal_reason: "completed", result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null" });

describe("the bridge request machine", () => {
  test("a first request starts a fresh query, pushes one user message, and ends at the first stop reason", () => withBridge(async ({ ops, queries }) => {
    // The shared adapter merges the user's extra-body fields, which the SDK's request type does not declare.
    const first = await send(ops, Object.assign(request([U1]), { top_k: 5 }));
    const query = queries[0];
    expect(query?.launch).toMatchObject({
      systemPrompt: ["Flywheel system prompt"], cwd: "/work", session: { kind: "fresh" }, wireModelId: "claude-sonnet-5-5", effort: "medium", promptCaching: false,
      tools: [{ name: "read", description: "Reads a file." }], thinking: { type: "adaptive" }, extraBody: { top_k: 5, max_tokens: 32_000 }, eagerInputStreaming: true,
    });
    await until(() => query?.pushed.length === 1);
    expect(query?.pushed).toEqual([{ type: "user", uuid: expect.any(String), message: { role: "user", content: [{ type: "text", text: "Read a." }] }, parent_tool_use_id: null }]);

    // No SDK message_stop yet: the stop reason alone ends the request, and pings never reach the adapter.
    query?.emit(init, ...admittedStart(), ping, ...text(0, "Reading."), ...toolUse(1, "toolu_1"), ping, stopReason("tool_use"));
    expect(await first.read).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    query?.emit(messageStop);
    await settle();
    expect(queries).toHaveLength(1);
  }));

  test("a parked query takes the tool results through its waiting handler and serves the next request", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const handler = callHandler(query, "toolu_1");
    await settle();

    const second = await send(harness.ops, request([U1, A1, R1]));
    expect(await handler).toEqual({ content: [{ type: "text", text: "file a" }] });
    query.emit(...answers("Done."));
    expect(await second.read).toContain("message_stop");
    expect(harness.queries).toHaveLength(1);
    expect(harness.log).toEqual(["push"]);
    expect(query.steps).toEqual([true, true]);
  }));

  test("a call by a declared tool's bare name parks the query, which the CLI routes by alias, and the next request rotates from canonical history", () => withBridge(async (harness) => {
    const first = await send(harness.ops, request([U1]));
    const [query] = harness.queries;
    // Flywheel's own text names each tool by its bare name, and the model can call it that way.
    query?.emit(init, ...admittedStart(), ...text(0, "Reading."),
      event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } }),
      event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
      event({ type: "content_block_stop", index: 1 }), stopReason("tool_use"), messageStop);
    expect(await first.read).toContain("message_stop");
    await settle();
    expect(harness.log).toEqual(["push"]);

    // Canonical history names the call by its MCP name, so the CLI's copy is no prefix of the request.
    const second = await send(harness.ops, request([U1, A1, R1]));
    harness.queries[1]?.emit(init, ...answers("Done."));
    expect(await second.error).toBeUndefined();
    expect(harness.log).toEqual(["push", "interrupt", "close", "push"]);
    expect(payloads("provider.claude_sdk.query.started")).toMatchObject([{ trigger: "first-request" }, { trigger: "history", historyMessages: 2 }]);
    expect(records.filter(({ type }) => type === "provider.claude_sdk.query.stopped").map(({ payload }) => payload)).toMatchObject([{ reason: "rotation", rule: "history", phase: "parked" }]);
    expect(records.filter(({ type }) => type === "provider.claude_sdk.request.hidden")).toEqual([]);
  }));

  test("an idle query takes the next user message by a push, and its owed turn result is no failure", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const second = await send(harness.ops, request([U1, A1, R1]));
    query.emit(...answers("Done."));
    await second.read;

    const third = await send(harness.ops, request([U1, A1, R1, A2, U2]));
    query.emit(turnDone, ...answers("Next done."));
    expect(await third.error).toBeUndefined();
    expect(harness.log).toEqual(["push", "push"]);
    expect(query.pushed.at(-1)?.message.content).toEqual([{ type: "text", text: "Next." }]);
    expect(harness.queries).toHaveLength(1);
  }));

  test("a request cancelled before the bridge admits it takes no reservation and launches no engine, and the next request takes the reservation", () => withBridge(async ({ ops, queries }) => {
    expect(await ops.anticipate?.(request([U1]), { origins: originsOf(request([U1])), sharedHost: false })).toBeDefined();
    const caller = new AbortController();
    const cancelled = ops.createStream(request([U1]), { origins: originsOf(request([U1])), sharedHost: true, signal: caller.signal, headers: {} });
    caller.abort(new Error("the person stopped the turn"));
    await expect(cancelled).rejects.toThrow("the person stopped the turn");
    await settle();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.pushed).toEqual([]);
    expect(payloads("provider.claude_sdk.query.started")).toEqual([]);

    const next = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."));
    expect(await next.error).toBeUndefined();
    expect(queries).toHaveLength(1);
    expect(payloads("provider.claude_sdk.query.started")).toEqual([expect.objectContaining({ engine: "reserved" })]);
  }));

  test("a request cancelled while it waits for the previous response's usage report delivers nothing to the parked query, which serves the next request", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const handler = callHandler(query, "toolu_1");
    let answered = false;
    void handler.then(() => { answered = true; });
    const caller = new AbortController();
    const cancelled = harness.ops.createStream(request([U1, A1, R1]), { origins: originsOf(request([U1, A1, R1])), sharedHost: true, signal: caller.signal, headers: {} }).then(() => undefined, (error: unknown) => error);
    await settle();
    caller.abort(new Error("the person stopped the turn"));
    query.emit(includedReport);
    expect(await cancelled).toMatchObject({ message: "the person stopped the turn" });
    await settle();
    expect(answered).toBe(false);
    expect(payloads("provider.claude_sdk.query.stopped")).toEqual([]);

    const next = await send(harness.ops, request([U1, A1, R1]));
    expect(await handler).toEqual({ content: [{ type: "text", text: "file a" }] });
    query.emit(...answers("Done."));
    expect(await next.error).toBeUndefined();
    expect(harness.queries).toHaveLength(1);
  }, { reports: "manual" }));

  // On a per-turn-effort model the engine copies the effort of each earlier turn into the conversation, so a query
  // whose turns ran at another effort cannot send what native sends (withPerTurnEffort).
  test("a new effort starts a new query at that effort, which resumes from a transcript", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const second = await send(harness.ops, request([U1, A1, R1]));
    query.emit(...answers("Done."));
    await second.read;

    const third = await send(harness.ops, request([U1, A1, R1, A2, U2], { output_config: { effort: "high" } }));
    harness.queries[1]?.emit(init, ...answers("Next done."));
    expect(await third.error).toBeUndefined();
    expect(harness.log).toEqual(["push", "close", "push"]);
    expect(harness.queries.map(({ launch }) => launch.effort)).toEqual(["medium", "high"]);
    expect(payloads("provider.claude_sdk.query.started")).toMatchObject([{ trigger: "first-request" }, { trigger: "identity", field: "effort", historyMessages: 4 }]);
  }));

  test("a changed system prompt rotates: the idle CLI closes without an interrupt and the new query resumes from a transcript", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const second = await send(harness.ops, request([U1, A1, R1]));
    query.emit(...answers("Done."), turnDone);
    await second.read;
    await settle();

    const third = await send(harness.ops, request([U1_WITH_ENVIRONMENT, A1, R1, A2, U2], { system: [{ type: "text", text: "A changed prompt" }] }));
    await until(() => harness.log.length === 3);
    expect(harness.log).toEqual(["push", "close", "push"]);
    const next = harness.queries[1];
    const [path, transcript] = [...harness.files.entries()][0] ?? [];
    expect(next?.launch.session).toEqual({ kind: "resume", id: query.launch.session.id, at: JSON.parse(transcript?.trim().split("\n").at(-1) ?? "{}").uuid });
    expect(transcript).toContain('"session_context"');
    expect(next?.pushed[0]?.message.content).toEqual([{ type: "text", text: "Next." }]);

    next?.emit(init);
    await until(() => !harness.files.has(path ?? ""));
    next?.emit(...answers("Rotated."));
    expect(await third.error).toBeUndefined();
    expect(payloads("provider.claude_sdk.query.started")).toMatchObject([{ trigger: "first-request", historyMessages: 0 }, { trigger: "identity", field: "systemPrompt", historyMessages: 4 }]);
    expect(payloads("provider.claude_sdk.query.stopped")[0]).toMatchObject({ reason: "rotation", rule: "identity", phase: "idle", evidence: { field: "systemPrompt" } });
  }, { email: "person@example.com" }));

  test("a new bridge's first rotation transcript already holds the login's account email, so the CLI keeps its reminder at the first user message", () => withBridge(async (harness) => {
    const first = send(harness.ops, request([U1_WITH_ENVIRONMENT, A1, R1, A2, U2]));
    await until(() => harness.files.size === 1);
    const [transcript] = [...harness.files.values()];
    const rows = (transcript ?? "").trim().split("\n").map((line) => JSON.parse(line));
    const firstUser = rows.findIndex((row) => row.type === "user");
    expect(rows.slice(firstUser + 1).find((row) => row.type === "attachment" && row.attachment.type === "session_context")?.attachment).toEqual({
      type: "session_context", context: { userEmail: expect.stringContaining("person@example.com") },
    });
    harness.queries[0]?.emit(init, ...answers("Done."));
    expect(await (await first).error).toBeUndefined();
  }, { email: "person@example.com" }));

  test("a message_start that Flywheel did not admit interrupts the CLI, and the next request starts a new query", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const second = await send(harness.ops, request([U1, A1, R1]));
    query.emit(...answers("Done."), turnDone, messageStart());
    await second.read;
    await until(() => harness.log.includes("close"));

    expect(harness.log).toEqual(["push", "interrupt", "close"]);
    expect(records.find(({ type }) => type === "provider.claude_sdk.request.hidden")?.payload).toMatchObject({
      tag: "message_start", phase: "idle", inputTokens: 10, announcedBy: "message_start", afterStopReason: true, lastStopReason: "end_turn",
    });
    expect(records.find(({ type }) => type === "provider.claude_sdk.query.stopped")?.payload).toMatchObject({ reason: "hidden-request", rule: "unadmitted-message-start", phase: "idle" });
    const third = await send(harness.ops, request([U1, A1, R1, A2, U2]));
    expect(harness.queries).toHaveLength(2);
    expect(records.at(-1)?.payload).toMatchObject({ trigger: "poisoned" });
    // The request it sent by itself reaches the audit on the next request's record, with what its stream stated.
    harness.queries[1]?.emit(init, ...answers("Done."));
    await third.read;
    expect(third.contexts.map(({ hiddenRequests }) => hiddenRequests)).toEqual([[{ source: "message_start", status: 200, inputTokens: 10 }]]);
  }));

  test("an empty end_turn ends the request normally and stops the CLI, and the gate refuses the CLI's nudge step", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init, ...admittedStart(), ...text(0, "  "), stopReason("end_turn"), messageStop);
    expect(await first.read).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    await until(() => log.includes("close"));
    expect(log).toEqual(["push", "interrupt", "close"]);
    // The CLI decides its nudge when the stream ends and asks the gate before it sends it.
    query?.emit(STEP);
    await until(() => payloads("provider.claude_sdk.step.refused").length > 0);
    expect(query?.steps).toEqual([true, false]);
    expect(payloads("provider.claude_sdk.step.refused")).toEqual([{ sessionId: query?.launch.session.id, index: 1, messageCount: 1, phase: "stopped" }]);
  }));

  test("a step that the gate refuses while the query is live makes the next request start a new query", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    // The CLI holds whatever it added before the refused step, so its copy is no longer Flywheel's.
    queries[0]?.emit(STEP);
    await until(() => payloads("provider.claude_sdk.step.refused").length > 0);
    expect(payloads("provider.claude_sdk.step.refused")).toMatchObject([{ index: 1, phase: "idle" }]);

    await send(ops, request([U1, A2, U2]));
    expect(queries).toHaveLength(2);
    expect(payloads("provider.claude_sdk.query.started")).toMatchObject([{ trigger: "first-request" }, { trigger: "poisoned", historyMessages: 2 }]);
  }));

  test("a step that the CLI starts by itself while a pushed request waits is refused, and the request's own step takes the admission", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init, ...answers("Done."));
    await first.read;

    const second = await send(ops, request([U1, A2, U2]));
    // The CLI continues its earlier turn by itself before it takes the pushed message.
    query?.emit(STEP, ...answers("Next."));
    expect(await second.read).toContain("message_stop");
    expect(query?.steps).toEqual([true, false, true]);
    expect(payloads("provider.claude_sdk.step.refused")).toMatchObject([{ index: 1, phase: "awaiting" }]);
  }));

  test("a hook that cannot reach the gate refuses the request's own step, and the same request gets one fresh engine, which serves it", () => {
    return withBridge(async ({ ops, queries, log }) => {
      const first = await send(ops, request([U1]));
      queries[0]?.emit(init, GATE_UNREACHABLE);
      await until(() => queries[1]?.pushed.length === 1);
      expect(queries[0]?.exited).toBe(true);
      expect(queries[1]?.pushed[0]).toMatchObject({ message: { role: "user", content: U1.content } });
      queries[1]?.emit(init, ...answers("Recovered."));
      expect(await first.read).toContain("message_stop");
      expect(log).toEqual(["push", "close", "push"]);
      expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{
        reason: "step-gate", rule: "gate-unreachable", evidence: { retry: "fresh-engine", asks: 0, rejected: 0, socketPathBytes: expect.any(Number) },
      }]);
    });
  });

  test("a hook that cannot reach the gate on the request's fresh engine too fails the request closed instead of as a transient cut", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, GATE_UNREACHABLE);
    await until(() => queries.length === 2);
    queries[1]?.emit(init, GATE_UNREACHABLE);
    const error = await first.error;
    expect(error).toBeInstanceOf(ProviderRequestValidationError);
    expect(String(error)).toContain("could not reach Flywheel's step gate");
    await settle();
    expect(queries).toHaveLength(2);
    const stops = payloads("provider.claude_sdk.query.stopped");
    expect(stops).toMatchObject([{ rule: "gate-unreachable", evidence: { retry: "fresh-engine" } }, { reason: "step-gate", rule: "gate-unreachable", evidence: { asks: 0, rejected: 0 } }]);
    expect(stops[1]).not.toHaveProperty("evidence.retry");
  }));

  test("a pushed tail writes each tool result in the CLI's own key order, as a transcript row and a replay frame do", () => withBridge(async ({ ops, queries }) => {
    const tail: MessageParam = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "file a" }] }, { type: "text", text: "And this." }] };
    const first = await send(ops, request([U1, A1, tail]));
    queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    expect(JSON.stringify(queries[0]?.pushed[0]?.message.content)).toBe('[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":"file a"}]},{"type":"text","text":"And this."}]');
  }));

  test("a turn that the CLI refuses locally before its first step keeps the failure that native Flywheel gets", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, turnResult({ is_error: true, api_error_status: null, terminal_reason: "image_error", result: "image exceeds 5 MB maximum" }));
    const error = await first.error;
    expect(error).toBeInstanceOf(Anthropic.BadRequestError);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "cli-error", rule: "turn-result-during-request" }]);
  }));

  test.each([
    ["did not load the step gate plugin", [cliInit({ plugins: [] })], "plugin-not-loaded", "did not load Flywheel's step-gate plugin"],
    ["streams a request without asking the step gate", [init, messageStart(), ...text(0, "Hi."), stopReason("end_turn")], "step-not-asked", "without asking Flywheel's step-gate plugin"],
  ])("a CLI that %s fails the request closed with the reason and stops", (_case, output, rule, reason) => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(...output);
    const error = await first.error;
    expect(error).toBeInstanceOf(ProviderRequestValidationError);
    expect(String(error)).toContain(reason);
    expect(first.types).toEqual([]);
    await until(() => log.includes("close"));
    expect(log).toEqual(["push", "interrupt", "close"]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "step-gate", rule, phase: "awaiting" }]);
  }));

  test("a model request that the CLI announces after the stop is recorded as hidden, once, and an admitted one is not", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init, ...admittedStart(), ...text(0, "  "), stopReason("end_turn"), messageStop);
    await first.read;
    await until(() => log.includes("close"));
    // The CLI sent its nudge before the interrupt reached it; its stream shows nothing of that request.
    query?.launch.onStderrLine(MODEL_REQUEST_LINE);
    query?.launch.onStderrLine("2026-10-07T12:00:00.000Z [DEBUG] [API REQUEST] /v1/messages/count_tokens source=sdk");
    await settle();

    expect(records.filter(({ type }) => type === "provider.claude_sdk.request.hidden").map(({ payload }) => payload)).toEqual([{
      sessionId: expect.any(String), tag: "api-request", phase: "stopped", announcedBy: "api-request-line", source: "sdk", arrivedIn: "stopped",
      afterStopReason: true, lastStopReason: "end_turn",
    }]);
    expect(records.find(({ type }) => type === "provider.claude_sdk.query.stopped")?.payload).toMatchObject({
      reason: "settlement", rule: "blank-answer", phase: "idle", requestLines: { sdk: 1 }, unadmittedLines: 0,
      evidence: { stopReason: "end_turn", blocks: { text: 1, visibleText: 0, toolUse: 0 } },
    });
    // The late line arrived after the first request's admission; the next request's record carries its hidden row, which
    // states neither a status nor usage.
    expect(first.contexts.map(({ hiddenRequests }) => hiddenRequests)).toEqual([[]]);
    const second = await send(ops, request([U1, { role: "assistant", content: [{ type: "text", text: "  " }] }, U2]));
    queries[1]?.emit(init, ...answers("Done."));
    await second.read;
    expect(second.contexts.map(({ hiddenRequests }) => hiddenRequests)).toEqual([[{ source: "api-request-line:sdk" }]]);
  }));

  test("a CLI version whose debug output announced none of the admitted requests serves no later request, on this query or another bridge's", async () => {
    const silent = new Set<string>();
    await withBridge(async ({ ops, queries, log }) => {
      const first = await send(ops, request([U1]));
      const query = queries[0];
      if (query !== undefined) query.announces = false;
      query?.emit(init, ...answers("Done."));
      expect(await first.error).toBeUndefined();

      const refusal = await send(ops, request([U1, A2, U2])).then(() => undefined, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(ProviderRequestValidationError);
      expect(String(refusal)).toContain("The Claude engine 2.1.295 wrote debug output that does not account for the model requests");
      await until(() => log.includes("close"));
      // The refused request never reaches the CLI.
      expect(log).toEqual(["push", "close"]);
      expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([{ sessionId: query?.launch.session.id, cliVersion: "2.1.295", requests: 1 }]);
      expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "debug-output", rule: "requests-unannounced", requests: 1 }]);
    }, { silentCliVersions: silent });

    await withBridge(async ({ ops, queries }) => {
      const first = await send(ops, request([U1]));
      queries[0]?.emit(init);
      const error = await first.error;
      expect(error).toBeInstanceOf(ProviderRequestValidationError);
      expect(String(error)).toContain("The Claude engine 2.1.295 wrote debug output that does not account for the model requests");
      await until(() => payloads("provider.claude_sdk.query.stopped").length === 2);
      expect(payloads("provider.claude_sdk.query.stopped")[1]).toMatchObject({ reason: "debug-output", rule: "requests-unannounced", phase: "awaiting", requests: 0 });
      expect(payloads("provider.claude_sdk.debug_output.silent")).toHaveLength(1);
    }, { silentCliVersions: silent });
  });

  test("a query whose debug output announces its admitted requests marks no version", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    const second = await send(ops, request([U1, A2, U2]));
    queries[0]?.emit(...answers("Next."));
    expect(await second.read).toContain("message_stop");
    expect(log).toEqual(["push", "push"]);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([]);
  }));

  test("a cut inside a tool call's input fails the request without the block stop that the CLI adds, so the adapter commits no broken call", () => withBridge(async ({ ops, queries, advance }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...admittedStart(), ...text(0, "Reading."),
      event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__runtime__read", input: {} } }),
      event({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pat' } }),
      // The CLI closes the open block and the message when the connection drops.
      event({ type: "content_block_stop", index: 1 }), messageStop);
    await settle();
    await advance(2_000);

    expect(await first.error).toMatchObject({ kind: "transient", message: "The Claude CLI ended the request without a stop reason" });
    expect(first.types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta"]);
  }));

  test("a settlement stop names its rule and evidence, and a CLI request announced before the stop reason is recorded with that order", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init, ...admittedStart(),
      event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__runtime__read", input: {} } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a\nb"}' } }),
      event({ type: "content_block_stop", index: 0 }));
    await settle();
    // The CLI answers the call by itself and announces its next request before its stop reason reaches the bridge.
    query?.launch.onStderrLine(MODEL_REQUEST_LINE);
    await settle();
    query?.emit(stopReason("tool_use"), messageStop);
    // The stop of a block whose input does not parse waits for the stop reason, which shows that the service sent it.
    expect(await first.read).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    await until(() => log.includes("close"));

    expect(records.find(({ type }) => type === "provider.claude_sdk.query.stopped")?.payload).toMatchObject({
      reason: "settlement", rule: "tool-input-not-json", poisoned: true, requests: 1, requestLines: { sdk: 2 }, unadmittedLines: 1,
      evidence: { stopReason: "tool_use", toolUses: { declared: 1, undeclared: 0, objectInput: 0, inputNotJson: 1, inputRepairable: 1 } },
    });
    expect(records.filter(({ type }) => type === "provider.claude_sdk.request.hidden").map(({ payload }) => payload)).toEqual([{
      sessionId: expect.any(String), tag: "api-request", phase: "stopped", announcedBy: "api-request-line", source: "sdk", arrivedIn: "streaming", afterStopReason: false,
    }]);
  }));

  test("a cut request fails after the two-second error hold, and a reported error fails at the turn result", () => withBridge(async ({ ops, queries, log, advance }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...admittedStart(), ...text(0, "partial"), messageStop);
    await settle();
    await advance(1_999);
    expect(log).toEqual(["push"]);
    await advance(1);
    const cut = await first.error;
    expect(cut).toBeInstanceOf(LlmStreamError);
    expect(cut).toMatchObject({ kind: "transient", message: "The Claude CLI ended the request without a stop reason" });
    expect(log).toEqual(["push", "interrupt", "close"]);

    // The gate refuses the CLI's resume after the cut, and the CLI then ends its turn as a success that holds the
    // partial text. The stream decides the class: the request still fails as a cut.
    const resumed = await send(ops, request([U1]));
    queries[1]?.emit(init, ...admittedStart(), ...text(0, "Prompt is too long"), messageStop, STEP, turnResult({ is_error: false, api_error_status: null, terminal_reason: "completed", result: "Prompt is too long" }));
    const cutThenSuccess = await resumed.error;
    expect(cutThenSuccess).toBeInstanceOf(LlmStreamError);
    expect(cutThenSuccess).toMatchObject({ kind: "transient", message: "The Claude CLI ended the request without a stop reason" });
    expect(queries[1]?.steps).toEqual([true, false]);
    expect(log.slice(3)).toEqual(["push", "close"]);

    const second = await send(ops, request([U1]));
    queries[2]?.emit(init, ...admittedStart(), assistantError("overloaded", "API Error: 529 Overloaded"),
      turnResult({ is_error: true, api_error_status: 529, terminal_reason: "api_error", result: "API Error: 529 Overloaded" }));
    const overloaded = await second.error;
    expect(overloaded).toBeInstanceOf(Anthropic.APIError);
    expect(overloaded).toMatchObject({ status: 529 });
    // The turn had ended, so the stop closes the CLI without an interrupt that would never settle.
    expect(log.slice(5)).toEqual(["push", "close"]);
    expect(records.filter(({ type }) => type === "provider.claude_sdk.query.stopped").map(({ payload }) => payload)).toMatchObject([
      { reason: "cli-error", rule: "error-hold-expired", phase: "failing", evidence: { report: "none" } },
      { reason: "cli-error", rule: "turn-result-during-request", phase: "failing", evidence: { report: "none", terminalReason: "completed" } },
      { reason: "cli-error", rule: "turn-result-during-request", phase: "failing", turnEnded: true, evidence: { report: "overloaded", status: 529, terminalReason: "api_error" } },
    ]);
  }));

  test("a model refusal ends the request at the service's refusal stop reason, as on native, and the CLI's error report of it is no failure", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    const stopDetails: BetaRefusalStopDetails = { type: "refusal", category: "cyber", explanation: "This request was flagged.", fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null };
    // CLI 2.1.295 announces the refusal and reports it as an API error before it forwards the stream's stop reason.
    queries[0]?.emit(init, ...admittedStart(), ...text(0, "I can"), { type: "system", subtype: "model_refusal_no_fallback", original_model: "claude-haiku-5-5", request_id: null, content: "", ...ENVELOPE },
      assistantError("invalid_request", "API Error: Haiku 5.5's safeguards flagged this message."),
      event({ type: "message_delta", context_management: null, delta: { stop_reason: "refusal", stop_sequence: null, container: null, stop_details: stopDetails },
        usage: { output_tokens: 5, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, iterations: null, fallback_credit: null, output_tokens_details: null, server_tool_use: null } }), messageStop,
      turnResult({ is_error: true, api_error_status: null, terminal_reason: "api_error", stop_reason: "refusal", result: "API Error: Haiku 5.5's safeguards flagged this message." }));

    expect(await first.error).toBeUndefined();
    expect(first.types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "settlement", rule: "other-stop-reason", evidence: { stopReason: "refusal" } }]);
  }));

  test("a refused extended window resends the open request once at the standard window and records that window", () => withBridge(async ({ ops, queries, refusals }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...extendedWindowRefused);
    await until(() => queries.length === 2);
    expect(queries.map(({ launch }) => launch.contextLimit)).toEqual([1_000_000, 200_000]);
    await until(() => queries[1]?.pushed.length === 1);
    queries[1]?.emit(init, ...answers("ok"));
    expect(await first.read).toContain("message_stop");
    expect(refusals).toEqual([{ kind: "extended-context", contextLimit: 200_000 }]);
    expect(payloads("provider.claude_sdk.query.started")).toMatchObject([{ trigger: "first-request", contextLimit: 1_000_000 }, { trigger: "poisoned", contextLimit: 200_000 }]);

    // The bridge keeps the standard window, so a second refusal at it fails the request with the model-access class,
    // and the provider walk, not the bridge, records it.
    const second = await send(ops, request([U1, { role: "assistant", content: [{ type: "text", text: "ok" }] }, U2]));
    queries[1]?.emit(...extendedWindowRefused);
    expect(await second.error).toBeInstanceOf(ModelAccessRefusedError);
    expect(queries).toHaveLength(2);
    expect(refusals).toHaveLength(1);
  }));

  test("a refused extended window after the adapter read the request fails it, and the next query asks for the standard window", () => withBridge(async ({ ops, queries, refusals }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...admittedStart(), ...extendedWindowRefused);
    expect(await first.error).toMatchObject({ refusal: { kind: "extended-context", contextLimit: 200_000 } });
    expect(queries).toHaveLength(1);
    expect(refusals).toEqual([]);

    const second = await send(ops, request([U1]));
    await until(() => queries.length === 2);
    expect(queries[1]?.launch.contextLimit).toBe(200_000);
    queries[1]?.emit(init, ...answers("ok"));
    expect(await second.read).toContain("message_stop");
  }));

  test("a resend whose query cannot start fails the open request with the launch failure", () => withBridge(async ({ ops, queries, refusals }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...extendedWindowRefused);
    expect(await first.error).toMatchObject({ message: "the CLI did not start" });
    expect(refusals).toEqual([{ kind: "extended-context", contextLimit: 200_000 }]);
  }, { launchesBeforeFailure: 1 }));

  test("a rotation transcript that a failed engine start cannot delete keeps its session locked after the bridge closes, and the request fails with the launch failure", async () => {
    const configDir = temporaryDirectory("bridge-login-");
    let lock: string | undefined;
    await withBridge(async ({ ops, files }) => {
      await expect(send(ops, request([U1, A1, U2]))).rejects.toMatchObject({ message: "the CLI did not start" });
      const [transcript] = files.keys();
      const sessionId = transcript?.match(/([^/\\]+)\.jsonl$/u)?.[1];
      if (sessionId === undefined) throw new Error("the failed start wrote no transcript");
      lock = join(configDir, "session-locks", `${sessionId}.lock`);
    }, { configDir, launchesBeforeFailure: 0, transcriptRemovalFails: true });
    // The held lock names this process as the transcript's owner, so a later sweep removes the transcript only once it ended.
    expect(lock !== undefined && existsSync(lock)).toBe(true);
  });

  test("a model the login refuses fails the request once with the model-access class for the walk to record", () => withBridge(async ({ ops, queries, refusals }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...refused("model_not_found", 404, "There's an issue with the selected model (claude-sonnet-5-5). It may not exist or you may not have access to it."));
    expect(await first.error).toMatchObject({ refusal: { kind: "model" } });
    expect(refusals).toEqual([]);
    expect(queries).toHaveLength(1);
  }));

  test("a spent allowance marks the account until the reset that the query's rejected rate-limit event named, and the error carries that mark for the walk", () => withBridge(async ({ ops, queries, quotaMarks }) => {
    const limited = refused("rate_limit", 429, "You've hit your session limit · resets 10:59pm");
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init);
    await settle();
    // The response's unified headers name the account's spent allowance, so the engine's own report of it decides.
    logLines(queries[0], [
      ...modelRequest(), ...responseBlock("error", 429, { "anthropic-ratelimit-unified-status": "rejected", "request-id": "req_1" }),
      apiErrorLine(429, '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}'),
    ]);
    await settle();
    queries[0]?.emit(rateLimitReport({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_791_525_709 }), ...limited);
    const error = await first.error;
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error).toMatchObject({ message: "You've hit your session limit · resets 10:59pm", quotaObservation: { reportedResetAtMs: 1_791_525_709_000 } });
    expect(quotaMarks).toEqual([1_791_525_709_000]);

    // A query whose CLI reported no rejected window marks the account with no reset, so the safe recheck bounds it.
    const second = await send(ops, request([U1]));
    queries[1]?.emit(init, rateLimitReport({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.95, resetsAt: 1_791_900_000 }), ...limited);
    expect(await second.error).toMatchObject({ quotaObservation: { reportedResetAtMs: undefined } });
    expect(quotaMarks).toEqual([1_791_525_709_000, undefined]);

    // A spent window of one model holds the whole account only until the safe recheck: the account key carries no
    // model, and the account still serves its other models.
    for (const [index, rateLimitType] of (["seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"] as const).entries()) {
      const modelOnly = await send(ops, request([U1]));
      queries[index + 2]?.emit(init, rateLimitReport({ status: "rejected", rateLimitType, resetsAt: 1_791_530_128 }),
        ...refused("rate_limit", 429, "You've hit your Opus limit · resets 12:15am"));
      expect(await modelOnly.error).toMatchObject({ quotaObservation: { reportedResetAtMs: undefined } });
    }
    expect(quotaMarks).toEqual([1_791_525_709_000, undefined, undefined, undefined, undefined]);
  }));

  test("a spent allowance whose mark the account's row does not take fails the request with the coordination error, as native", () => withBridge(async ({ ops, queries, quotaMarks }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, rateLimitReport({ status: "rejected", rateLimitType: "seven_day", resetsAt: 1_791_900_000 }),
      ...refused("rate_limit", 429, "You've hit your weekly limit · resets Oct 12, 9am"));
    expect(await first.error).toBeInstanceOf(QuotaCoordinationError);
    expect(quotaMarks).toEqual([1_791_900_000_000]);
  }, { quotaRowRefused: true }));

  test("a turn result before any message_start is the CLI's local refusal and fails the request", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, turnResult({ is_error: true, api_error_status: null, terminal_reason: "blocking_limit", result: "Prompt is too long" }));
    expect(await first.error).toBeInstanceOf(ContextLengthExceededError);
  }));

  test("a resend that the CLI announces on stderr fails the open request as the HTTP 400 it answered", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...admittedStart());
    await settle();
    queries[0]?.launch.onStderrLine("2026-10-07T10:00:00.000Z [WARN] [server-fallback] 400 attributed to the request, retrying without it");
    const error = await first.error;
    expect(error).toBeInstanceOf(Anthropic.BadRequestError);
    expect(String(error)).toContain("(server-fallback)");

    await until(() => log.includes("close"));
    expect(log).toEqual(["push", "interrupt", "close"]);
    expect(records.find(({ type }) => type === "provider.claude_sdk.request.hidden")?.payload).toMatchObject({ tag: "server-fallback", phase: "streaming", announcedBy: "retry-line", afterStopReason: false });
    expect(records.find(({ type }) => type === "provider.claude_sdk.query.stopped")?.payload).toMatchObject({ reason: "hidden-request", rule: "retry-line", phase: "streaming" });
    // The resend is no request of Flywheel's, so the next admitted request's record carries it. The engine never
    // states its answer, and the failed request's record holds no hidden row.
    const second = await send(ops, request([U1]));
    queries[1]?.emit(init, ...answers("Done."));
    await second.read;
    expect([first.contexts, second.contexts].map((contexts) => contexts.map(({ hiddenRequests }) => hiddenRequests))).toEqual([[[]], [[{ source: "retry-line:server-fallback" }]]]);
  }));

  test("a tail with an image that the CLI would rewrite goes into the transcript, and the query takes an empty push", () => withBridge(async ({ ops, queries, files }) => {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.write("IHDR", 12, "latin1");
    header.writeUInt32BE(3_000, 16);
    header.writeUInt32BE(3_000, 20);
    const shot: MessageParam = { role: "user", content: [{ type: "text", text: "See this." }, { type: "image", source: { type: "base64", media_type: "image/png", data: header.toString("base64") } }] };
    const first = await send(ops, request([shot]));
    const query = queries[0];
    await until(() => query?.pushed.length === 1);
    const transcript = [...files.values()][0] ?? "";
    const rows = transcript.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map(({ type }) => type)).toEqual(["user"]);
    expect(rows[0].message.content).toEqual(shot.content);
    expect(query?.launch.session).toMatchObject({ kind: "resume", at: rows[0].uuid });
    expect(query?.pushed[0]?.message.content).toEqual([]);
    expect(records.find(({ type }) => type === "provider.claude_sdk.query.started")?.payload).toMatchObject({ trigger: "first-request", delivery: "row", historyMessages: 1 });

    query?.emit(init, ...answers("A screenshot."), turnDone);
    await first.read;
    await send(ops, request([shot, { role: "assistant", content: [{ type: "text", text: "A screenshot." }] }, U2]));
    await until(() => query?.pushed.length === 2);
    expect(query?.pushed[1]?.message.content).toEqual([{ type: "text", text: "Next." }]);
    expect(queries).toHaveLength(1);
  }));

  test("an engine that ends during a request fails it by how it ended and records that for the login: an exit as transient, and an engine that cannot start as an unavailable route that names the remedy", async () => {
    const cases = [
      { end: (query: FakeQuery) => { query.emit(init, ...admittedStart()); query.end(); }, failure: "TransientNetworkFailure", message: expect.any(String), outcome: "program-exited", stop: { rule: "sdk-stream-ended", phase: "streaming" } },
      { end: (query: FakeQuery) => { query.failStart(new Error("engine process exited with code 127")); }, failure: "RouteUnavailableFailure", message: expect.stringContaining("Reinstall Flywheel"), outcome: "program-cannot-start", stop: { rule: "engine-not-started", phase: "awaiting" } },
    ];
    for (const { end, failure, message, outcome, stop } of cases) {
      records.length = 0;
      await withBridge(async ({ ops, queries, outcomes }) => {
        const first = await send(ops, request([U1]));
        if (queries[0] !== undefined) end(queries[0]);
        const error = await first.error;
        await until(() => payloads("provider.claude_sdk.query.stopped").length === 1);
        await settle();
        // Neither end starts a fresh engine: the walk takes the failure at once.
        expect({ failure: classifyProviderFailure(error)._tag, message: String(error), outcomes, stop: payloads("provider.claude_sdk.query.stopped")[0], queries: queries.length })
          .toMatchObject({ failure, message, outcomes: [outcome], stop: { reason: "cli-exited", ...stop }, queries: 1 });
      });
    }
  });

  test("a request that ends with an assistant message is refused without a query", () => withBridge(async ({ ops, queries }) => {
    await expect(ops.createStream(request([U1, A2]), { origins: originsOf(request([U1, A2])), sharedHost: true, signal: new AbortController().signal, headers: {} })).rejects.toBeInstanceOf(ProviderRequestValidationError);
    expect(queries).toHaveLength(0);
  }));

  test("a rate limit event that is not allowed reaches the diagnostics", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, rateLimitReport({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.85, resetsAt: 1 }), ...answers("Done."));
    await first.read;
    expect(records.find(({ type }) => type === "provider.claude_sdk.rate_limit")?.payload).toMatchObject({ status: "allowed_warning", utilization: 0.85 });
  }));
});

