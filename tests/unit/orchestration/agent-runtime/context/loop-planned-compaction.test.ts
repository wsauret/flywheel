import { describe, expect, spyOn, test } from "bun:test";

import { Log } from "../../../../../src/infra/log.js";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { compactInput, messageInput, type AgentLoopInput, type TurnParkedContext } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import type { ConversationMessage, ProviderStreamEvent, StreamEvent, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { renderCompactionOpening } from "../../../../../src/orchestration/agent-runtime/agent-loop-compaction-state.js";
import { emptyConversationCheckpoint } from "../../../../../src/orchestration/session/conversation-checkpoint.js";
import type { ConversationCheckpoint } from "../../../../../src/orchestration/session/conversation-checkpoint-facts.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { budgetCaptureSurface, makeCaptureClient, withSessionNotes } from "./_loop-fixtures.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { OutputLengthExceededError, ProviderRequestValidationError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { promptCapabilities } from "../../../../helpers/prompt-capabilities.js";

const text = (value: string, blockKey: string): ProviderStreamEvent => ({ kind: "text_delta", text: value, blockKey });
const done = (stopReason: "end_turn" | "tool_use"): ProviderStreamEvent => ({ kind: "done", stopReason });

describe("planned agent-loop compaction", () => {
  test.each(["saved", "failed", "interrupted", "idle-off", "automatic-off"] as const)("idle checkpoint only resets after a successful enabled note mutation: %s", async (outcome) => {
    const saved = outcome === "saved";
    const abort = new AbortController();
    const notes = withSessionNotes();
    let enabled = true;
    const resolve = notes.tools.resolve.bind(notes.tools);
    notes.tools.resolve = async () => {
      const surface = await resolve();
      return { ...surface, runtimeConfig: { ...surface.runtimeConfig,
        idleCompaction: outcome === "idle-off" ? enabled : true,
        proactiveCompactionThreshold: outcome === "automatic-off" && !enabled ? 0 : surface.runtimeConfig.proactiveCompactionThreshold,
      } };
    };
    notes.tools.set("checkpoint_replace", {
      ...notes.tools.get("checkpoint_replace")!,
      execute: async () => {
        if (outcome === "interrupted") abort.abort();
        enabled = false;
        return { content: "checkpoint result", outcome: outcome === "failed" ? "error" : "ok", terminate: false };
      },
    });
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("Finished.", "initial"), done("end_turn")] },
      { events: [{ kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "intent" } } }, done("tool_use")] },
    ]);
    let compactions = 0;
    let parks = 0;
    const notices: string[] = [];
    const result = await runAgentLoop({
      client, ...notes, systemPrompt: stableSystemPrompt("test"), instruction: "original request",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "idle-checkpoint", retrievalSessionId: "idle-checkpoint",
      providerSessionKey: "idle-checkpoint", promptCacheKey: "idle-checkpoint",
      seed: { kind: "fresh" }, onEvent: (event) => { if (event.kind === "compaction_done" && event.success) compactions++; }, signal: abort.signal,
      onSystemMessage: (notice) => { notices.push(notice); },
      persistence: { history: { append: () => {} } },
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => parks++ === 0 ? { ...compactInput(), source: "idle" as const } : null,
          cancel: async () => {},
        }),
      },
    });
    expect(result.kind).toBe(outcome === "interrupted" ? "aborted" : "input_closed");
    expect(compactions).toBe(saved ? 1 : 0);
    expect(capturedMessages).toHaveLength(2);
    expect(parks).toBe(outcome === "interrupted" ? 1 : 2);
    if (outcome === "interrupted") expect(notices).not.toContain("Idle checkpoint did not save session notes. Context has been kept.");
  });

  test("an idle checkpoint read followed by output overflow parks without a reset or another request", async () => {
    const notes = withSessionNotes();
    notes.tools.set("checkpoint_read", { ...notes.tools.get("checkpoint_read")!, execute: async () => ({ content: "intent", outcome: "ok" }) });
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("Finished.", "initial"), done("end_turn")] },
      { events: [{ kind: "tool_use", toolCall: { id: "read", name: "checkpoint_read", input: {} } }, done("tool_use")] },
      { events: [] },
      { events: [{ kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "intent" } } }, done("tool_use")] },
    ], { onRequest: () => { if (capturedMessages.length === 3) throw normalizeProviderAttemptFailure(new OutputLengthExceededError()); } });
    let compactions = 0;
    let parks = 0;
    const result = await runAgentLoop({
      client, ...notes, systemPrompt: stableSystemPrompt("test"), instruction: "original request",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "idle-overflow", retrievalSessionId: "idle-overflow", providerSessionKey: "idle-overflow", promptCacheKey: "idle-overflow",
      seed: { kind: "fresh" }, onEvent: (event) => { if (event.kind === "compaction_done" && event.success) compactions++; },
      persistence: { history: { append: () => {} } },
      inputSource: { drainPending: () => null, prepareWaitForInput: () => ({
        commit: async () => parks++ === 0 ? { ...compactInput(), source: "idle" as const } : null, cancel: async () => {},
      }) },
    });
    expect(result.kind).toBe("input_closed");
    expect(compactions).toBe(0);
    expect(capturedMessages).toHaveLength(3);
    expect(parks).toBe(2);
  });

  test.each([
    { observed: true, changePolicy: false },
    { observed: false, changePolicy: false },
    { observed: true, changePolicy: true },
  ])("park cache evidence requires observed retention under the current policy: %j", async ({ observed, changePolicy }) => {
    let retention: "1h" | "5m" = "1h";
    const notes = withSessionNotes();
    const resolve = notes.tools.resolve.bind(notes.tools);
    notes.tools.resolve = async () => {
      const surface = await resolve();
      return { ...surface, runtimeConfig: { ...surface.runtimeConfig, cacheRetentionPolicies: { anthropic_api: retention } } };
    };
    const requested: Array<string | undefined> = [];
    const usage = (write: boolean): ProviderStreamEvent => ({
      kind: "usage", final: true, inputTokens: 1_000, outputTokens: 10, cacheReadTokens: write ? 0 : 200_000,
      cacheCreateTokens: write ? 200_000 : 0, reasoningTokens: 0,
      ...(write && observed ? { cacheRetentionMs: 3_600_000 } : {}),
    });
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("Done.", "first"), usage(true), done("end_turn")] },
      { events: [text("Done again.", "second"), usage(false), done("end_turn")] },
    ], { contextLimit: 1_000_000, onRequest: (options) => { requested.push(options.cacheRetention); } });
    const parks: TurnParkedContext[] = [];
    let inputs = 0;
    await runAgentLoop({
      client, ...notes, systemPrompt: stableSystemPrompt("test"), instruction: "original request",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "cache-evidence", retrievalSessionId: "cache-evidence",
      providerSessionKey: "cache-evidence", promptCacheKey: "cache-evidence",
      seed: { kind: "fresh" }, onEvent: () => {}, cacheRetention: "1h",
      persistence: { history: { append: () => {} } },
      lifecycle: { onTurnParked: (context) => { parks.push(context); } },
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => {
            if (inputs++ > 0) return null;
            if (changePolicy) retention = "5m";
            return messageInput("next task");
          },
          cancel: async () => {},
        }),
      },
    });
    expect(capturedMessages).toHaveLength(2);
    expect(requested).toEqual(["1h", changePolicy ? "5m" : "1h"]);
    expect(parks).toHaveLength(2);
    for (const [index, park] of parks.entries()) {
      if (observed && (!changePolicy || index === 0)) expect(park.idleCache).toMatchObject({ ttlMs: 3_600_000, observedAt: expect.any(Number) });
      else expect(park.idleCache).toBeUndefined();
    }
  });

  test("a serving route change cannot inherit the previous route's one-hour cache evidence", async () => {
    const notes = withSessionNotes();
    const usage: ProviderStreamEvent = { kind: "usage", final: true, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 100, cacheRetentionMs: 3_600_000, reasoningTokens: 0 };
    const f = await budgetCaptureSurface(() => notes.tools, [
      [{ events: [text("First.", "first"), usage, done("end_turn")] }],
      [{ events: [text("Second.", "second"), { ...usage, cacheCreateTokens: 0, cacheRetentionMs: undefined, cacheReadTokens: 100 }, done("end_turn")] }],
    ]);
    const parks: TurnParkedContext[] = [];
    let inputs = 0;
    await runAgentLoop({
      client: f.client, tools: f.surface, checkpoint: notes.checkpoint,
      systemPrompt: stableSystemPrompt("test"), instruction: "original request",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "route-change", retrievalSessionId: "route-change",
      providerSessionKey: "route-change", promptCacheKey: "route-change",
      seed: { kind: "fresh" }, onEvent: () => {},
      persistence: { history: { append: () => {} } },
      lifecycle: { onTurnParked: (context) => { parks.push(context); } },
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => {
            if (inputs++ > 0) return null;
            f.advance();
            return messageInput("new route");
          },
          cancel: async () => {},
        }),
      },
    });
    expect(parks[0]?.idleCache?.ttlMs).toBe(3_600_000);
    expect(parks[1]?.idleCache).toBeUndefined();
  });

  test("a response that reports unknown retention revokes a prior cache window", async () => {
    const usage: ProviderStreamEvent = { kind: "usage", final: true, inputTokens: 100, outputTokens: 10, cacheReadTokens: 200_000, cacheCreateTokens: 0, cacheRetentionMs: 86_400_000, reasoningTokens: 0 };
    const { client } = makeCaptureClient([
      { events: [text("First.", "first"), usage, done("end_turn")] },
      { events: [text("Second.", "second"), { ...usage, cacheRetentionMs: null }, done("end_turn")] },
    ], { contextLimit: 1_000_000 });
    const parks: TurnParkedContext[] = [];
    let inputs = 0;
    await runAgentLoop({
      client, ...withSessionNotes(), systemPrompt: stableSystemPrompt("test"), instruction: "original request",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "unknown-retention", retrievalSessionId: "unknown-retention",
      providerSessionKey: "unknown-retention", promptCacheKey: "unknown-retention",
      seed: { kind: "fresh" }, onEvent: () => {},
      persistence: { history: { append: () => {} } },
      lifecycle: { onTurnParked: (context) => { parks.push(context); } },
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({ commit: async () => inputs++ === 0 ? messageInput("next task") : null, cancel: async () => {} }),
      },
    });
    expect(parks[0]?.idleCache?.ttlMs).toBe(86_400_000);
    expect(parks[1]?.idleCache).toBeUndefined();
  });

  test("checkpoint recovery reads the checkpoint, then saves in the next response", async () => {
    const notes = withSessionNotes();
    const calls: string[] = [];
    for (const name of ["checkpoint_read", "checkpoint_replace"]) {
      const tool = notes.tools.get(name)!;
      notes.tools.set(name, {
        ...tool,
        execute: async () => {
          calls.push(name);
          return { content: "Approved intent: preserve the original request", outcome: "ok", terminate: false };
        },
      });
    }
    const toolRound = (name: string, id: string) => ({
      events: [{ kind: "tool_use" as const, toolCall: { id, name, input: name === "checkpoint_replace" ? { section: "currentState", value: "preserved intent" } : {} } }, done("tool_use")],
    });
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("Ready.", "ready"), done("end_turn")] },
      toolRound("checkpoint_read", "read-first"),
      toolRound("checkpoint_replace", "second"),
    ]);
    const waits: AgentLoopInput[] = [compactInput()];
    const result = await runAgentLoop({
      client,
      ...notes,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do it",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "checkpoint-recovery", promptCacheKey: "checkpoint-recovery",
      artifactScopeId: "checkpoint-recovery",
      retrievalSessionId: "checkpoint-recovery",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => waits.shift() ?? null,
          cancel: async () => {},
        }),
      },
    });
    expect(result.kind).toBe("input_closed");
    expect(calls).toEqual(["checkpoint_read", "checkpoint_replace"]);
    expect(capturedMessages).toHaveLength(3);
    expect(JSON.stringify(capturedMessages[2])).toContain("Approved intent: preserve the original request");
  });

  // A reset after an unsaved round opens with no record of the latest work, so a response that saves nothing is
  // asked again, and the round resets unsaved only at its bound of four responses. An empty round answers in text
  // only; a "fail" round is a failed provider response.
  const probe = { id: "probe", name: "probe", input: {} };
  const read = { id: "read", name: "checkpoint_read", input: {} };
  const save = { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "saved state" } };
  const refusedSave = { id: "refused", name: "checkpoint_replace", input: { section: "noSuchSection", value: "saved state" } };
  const SAVED = "Continue the task from the checkpoint above.";
  const UNSAVED = "This reset came before a checkpoint save, so the checkpoint above may not include the latest work. Then continue the task.";
  test.each([
    ["saves", [[probe, save]], 0, SAVED],
    ["reads twice, then saves", [[read], [read], [save]], 1, SAVED],
    ["has its write refused, then saves", [[refusedSave], [save]], 1, SAVED],
    ["answers in text only, then saves", [[], [save]], 1, SAVED],
    ["reads, answers in text only, then saves", [[read], [], [save]], 1, SAVED],
    ["fails, then saves", ["fail", [save]], 1, SAVED],
    ["writes nothing", [[probe], [], [read], [probe]], 3, UNSAVED],
    ["is cut off three times, then answers in text only", ["cut", "cut", "cut", []], 3, UNSAVED],
  ] as const)("a save round that %s runs only the checkpoint tools and opens the reset with its save state", async (_case, rounds, notices, recovery) => {
    let stored: ConversationCheckpoint | undefined = { ...emptyConversationCheckpoint(), currentState: "earlier state" };
    const notes = withSessionNotes(new RequestToolMap([["probe", {
      name: "probe", description: "Probes", action: "file_read", isConcurrencySafe: true, inputSchema: { type: "object", properties: {} },
      execute: async () => { probes++; return { content: "probed", outcome: "ok", terminate: false }; },
    }]]), {
      read: async () => stored,
      replace: async (section, value) => { stored = { ...stored ?? emptyConversationCheckpoint(), [section]: value }; return stored; },
      decide: async () => stored ?? emptyConversationCheckpoint(),
    });
    let probes = 0;
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("Ready.", "ready"), done("end_turn")] },
      ...rounds.flatMap((calls) => typeof calls === "string" ? [] : [{ events: calls.length === 0 ? [text("Checkpoint saved.", "saved"), done("end_turn")]
        : [...calls.map((toolCall) => ({ kind: "tool_use" as const, toolCall })), done("tool_use")] }]),
    ], { onRequest: () => {
      const round = rounds[capturedMessages.length - 2];
      if (round === "fail") throw normalizeProviderAttemptFailure(new ProviderRequestValidationError("Anthropic", "refused"));
      if (round === "cut") throw normalizeProviderAttemptFailure(new OutputLengthExceededError());
    } });
    const history: ConversationMessage[] = [];
    const waits: AgentLoopInput[] = [compactInput()];
    const info = spyOn(Log.create({ service: "agent-loop" }), "info");
    const infoCalls = info.mock.calls;
    const result = await runAgentLoop({
      client, ...notes, systemPrompt: stableSystemPrompt("test"), instruction: "do it",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "save-round", promptCacheKey: "save-round", artifactScopeId: "save-round", retrievalSessionId: "save-round",
      standingBrief: async () => "The recorded brief.",
      persistence: { history: { append: (message) => { history.push(message); } } },
      seed: { kind: "fresh" }, onEvent: () => {},
      inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => waits.shift() ?? null, cancel: async () => {} }) },
    }).finally(() => info.mockRestore());

    expect(result.kind).toBe("input_closed");
    // One request before the compaction, then one per save-round response.
    expect(capturedMessages).toHaveLength(1 + rounds.length);
    const unsavedResets = infoCalls.filter(([message]) => message === "context reset without a checkpoint save");
    expect(unsavedResets).toEqual(recovery === UNSAVED ? [["context reset without a checkpoint save", { sessionId: "save-round", kind: "manual", requests: 4 }]] : []);
    expect(probes).toBe(0);
    if (typeof rounds[0] !== "string" && rounds[0].some((call) => call.name === "probe")) expect(JSON.stringify(history)).toContain("Tool 'probe' denied: this context window is exhausted");
    expect(JSON.stringify(history).split("The checkpoint was not saved").length - 1).toBe(notices);
    // A cut-off save response is asked again with the save notice, not the generic output-limit resume.
    expect(JSON.stringify(history)).not.toContain("output-length limit");
    const opening = history.at(-1);
    if (opening?.kind !== "user" || typeof opening.content !== "string") throw new Error("expected the reset opening");
    expect(opening.content).toContain(stored?.currentState ?? "");
    expect(opening.content).toContain("# Brief\n\nThe recorded brief.");
    expect(opening.content).toEndWith(recovery);
  });

  // The test model counts 4 characters per token: the brief is 300k tokens,
  // above the default 270k trigger and below 85% of a 1M window (850k).
  const BRIEF = "b".repeat(1_200_000);
  const deferred = (freshTokens: number) => `Automatic compaction is deferred: a fresh context would start at about ${freshTokens.toLocaleString("en-US")} tokens, which is not below its trigger of 270,000 tokens. It now runs at 850,000 tokens, near the model's context window.`;
  const deferral = (sessionId: string, freshContextTokens: number) => ({ sessionId, freshContextTokens, triggerTokens: 270_000, effectiveTriggerTokens: 850_000, contextLimit: 1_000_000 });
  async function runAboveTrigger(name: string, prior: ConversationMessage[], responses: ProviderStreamEvent[][]) {
    let stored: ConversationCheckpoint = { ...emptyConversationCheckpoint(), currentState: "state" };
    let checkpointReads = 0;
    let briefReads = 0;
    const notes = withSessionNotes(new RequestToolMap([["probe", {
      name: "probe", description: "Probes", action: "file_read", isConcurrencySafe: true, inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "probed", outcome: "ok", terminate: false }),
    }]]), {
      read: async () => { checkpointReads++; return stored; },
      replace: async (section, value) => { stored = { ...stored, [section]: value }; return stored; },
      decide: async () => stored,
    });
    const { client, capturedMessages } = makeCaptureClient(responses.map((events) => ({ events })), { contextLimit: 1_000_000 });
    const history: ConversationMessage[] = [];
    const notices: string[] = [];
    const resets: StreamEvent[] = [];
    const deferrals: unknown[] = [];
    const freshTokens: number[] = [];
    const publishedTriggers: (number | undefined)[] = [];
    const record = spyOn(DebugLog, "record").mockImplementation((entry) => {
      if (entry.type !== "agent.compaction.deferred") return;
      deferrals.push(entry.payload);
      if (typeof entry.payload === "object" && entry.payload !== null && "freshContextTokens" in entry.payload) freshTokens.push(Number(entry.payload.freshContextTokens));
    });
    const result = await runAgentLoop({
      client, ...notes, systemPrompt: stableSystemPrompt("test"), instruction: null,
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: name, promptCacheKey: name, artifactScopeId: name, retrievalSessionId: name,
      standingBrief: async () => { briefReads++; return BRIEF; },
      persistence: { history: { append: (message) => { history.push(message); } } },
      seed: { kind: "resume", priorMessages: prior },
      onEvent: (event) => {
        if (event.kind === "compaction_done" && event.success) resets.push(event);
        if (event.kind === "context_update") publishedTriggers.push(event.compactionTriggerTokens);
      },
      onSystemMessage: (notice) => { notices.push(notice); },
    }).finally(() => record.mockRestore());
    return { result, requests: capturedMessages.length, history, notices, resets, deferrals, freshTokens, publishedTriggers, checkpointReads, briefReads };
  }
  const probeCall = (id: string): ProviderStreamEvent[] => [{ kind: "tool_use", toolCall: { id, name: "probe", input: {} } }, done("tool_use")];

  test("a brief above the trigger defers the automatic reset and measures its fresh context once across later requests", async () => {
    const run = await runAboveTrigger("brief-above-trigger", [{ kind: "user", content: BRIEF }], [
      probeCall("p1"), probeCall("p2"), probeCall("p3"), [text("Task work done.", "done"), done("end_turn")],
    ]);
    expect(run.result.kind).toBe("completed");
    expect(run.resets).toHaveLength(0);
    // Every request is task work; none asks for a checkpoint save.
    expect(run.requests).toBe(4);
    expect(JSON.stringify(run.history)).not.toContain("context_window_reminder");
    // One measurement of the fresh context serves all four requests.
    expect(run.briefReads).toBe(1);
    expect(run.checkpointReads).toBe(1);
    const [freshTokens = 0] = run.freshTokens;
    expect(freshTokens).toBeGreaterThan(BRIEF.length / 4);
    expect(run.deferrals).toEqual([deferral("brief-above-trigger", freshTokens)]);
    expect(run.notices).toEqual([deferred(freshTokens)]);
    // Every context measurement states the trigger that the deferral left, not the configured 270,000.
    expect(run.publishedTriggers.length).toBeGreaterThanOrEqual(4);
    expect(new Set(run.publishedTriggers)).toEqual(new Set([850_000]));
  });

  test("a brief above the trigger still gets one saved reset at the window share", async () => {
    const run = await runAboveTrigger("brief-at-window-share", [{ kind: "user", content: BRIEF }, { kind: "assistant", content: "w".repeat(2_300_000) }, { kind: "user", content: "work" }], [
      [{ kind: "tool_use", toolCall: save }, done("tool_use")], [text("Task work done.", "done"), done("end_turn")],
    ]);
    expect(run.result.kind).toBe("completed");
    expect(run.resets).toHaveLength(1);
    const reset = run.resets[0];
    if (reset?.kind !== "compaction_done" || reset.tokensAfter === undefined) throw new Error("expected one measured reset");
    expect(reset.tokensBefore).toBeGreaterThanOrEqual(850_000);
    expect(run.requests).toBe(2);
    const opening = run.history.findLast((message) => message.kind === "user" && typeof message.content === "string" && message.content.includes("# Brief"));
    expect(opening?.kind === "user" && typeof opening.content === "string" && opening.content.endsWith(SAVED)).toBe(true);
    // One measurement before the reset, one by the reset itself; the request after it measures nothing.
    expect(run.briefReads).toBe(2);
    // The fresh context that the reset installed defers again, with the reset's own measurement. The first
    // measurement precedes the save round, which rewrote the checkpoint.
    const [firstTokens = 0] = run.freshTokens;
    expect(firstTokens).toBeGreaterThan(BRIEF.length / 4);
    expect(run.deferrals).toEqual([deferral("brief-at-window-share", firstTokens), deferral("brief-at-window-share", reset.tokensAfter)]);
    expect(run.notices).toEqual([deferred(firstTokens), deferred(reset.tokensAfter)]);
  });

  test.each([
    [{ checkpoint: true, brief: false, saved: true, recallAvailable: false }, "Continue the task from the checkpoint above."],
    [{ checkpoint: true, brief: false, saved: false, recallAvailable: true }, "This reset came before a checkpoint save, so the checkpoint above may not include the latest work. Use the read-only `recall` tool to recover missing details from recorded history; use `expand` for a known durable entry ID. Then continue the task."],
    [{ checkpoint: false, brief: true, saved: false, recallAvailable: false }, "Continue the task from the brief above."],
    [{ checkpoint: false, brief: false, saved: false, recallAvailable: true }, "Use the read-only `recall` tool to recover the latest user request and the work done for it from recorded history, then continue the task."],
    [{ checkpoint: false, brief: false, saved: false, recallAvailable: false }, "Ask the person what to continue."],
  ])("the reset opening for %j states its recovery and never points to an absent checkpoint", (state, recovery) => {
    const opening = renderCompactionOpening({
      checkpoint: state.checkpoint ? emptyConversationCheckpoint() : undefined,
      brief: state.brief ? "The brief." : undefined,
      saved: state.saved, recallAvailable: state.recallAvailable, capabilities: promptCapabilities([{ name: "skill" }]),
    });
    expect(opening).toEndWith(`A fresh context window has started without summarizing the prior conversation. ${recovery}`);
    if (!state.checkpoint) expect(opening).toStartWith("No checkpoint has been saved.");
    if (!state.checkpoint) expect(opening).not.toContain("checkpoint above");
  });

  test("prepareWaitForInput compact control checkpoints, resets, and re-parks", async () => {
    const requests: StreamOptions[] = [];
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("Ready to compact.", "text-0"), done("end_turn")] },
      { events: [{ kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "saved" } } }, done("tool_use")] },
    ], { onRequest: (options) => { requests.push(options); } });
    const events: StreamEvent[] = [];
    const waits: AgentLoopInput[] = [compactInput()];
    let waitCalls = 0;
    const result = await runAgentLoop({
      client,
      ...withSessionNotes(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do it",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "queued-compact", promptCacheKey: "queued-compact",
      sessionId: "agent-session",
      artifactScopeId: "queued-compact",
      retrievalSessionId: "queued-compact",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: (event) => {
        if (event.kind === "compaction_start") events.push(event);
      },
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => {
            waitCalls++;
            return waits.shift() ?? null;
          },
          cancel: async () => {},
        }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(capturedMessages[1])).toContain("Save the checkpoint now:");
    expect(capturedMessages).toHaveLength(2);
    expect(waitCalls).toBe(2);
    expect(requests.map((request) => request.providerSessionKey)).toEqual(["queued-compact", "queued-compact"]);
  });

  test("a message queued behind a parked compact keeps its own tool-continuation turn", async () => {
    const followUpTool: RuntimeTool = {
      name: "follow_up",
      description: "Records a follow-up",
      action: "file_read",
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "follow-up", outcome: "ok", terminate: false }),
    };
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("First.", "text-0"), done("end_turn")] },
      { events: [{ kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "saved" } } }, done("tool_use")] },
      { events: [{ kind: "tool_use", toolCall: { id: "tc_follow_up", name: "follow_up", input: {} } }, done("tool_use")] },
      { events: [text("Second.", "text-4"), done("end_turn")] },
    ]);
    const waits: AgentLoopInput[] = [compactInput()];
    let compactDelivered = false;
    let messageDelivered = false;
    const result = await runAgentLoop({
      client,
      ...withSessionNotes(new RequestToolMap([["follow_up", followUpTool]])),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do it",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "wake-loop", promptCacheKey: "wake-loop",
      artifactScopeId: "wake-loop",
      retrievalSessionId: "wake-loop",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => {
          if (!compactDelivered || messageDelivered) return null;
          messageDelivered = true;
          return messageInput("follow up after compaction");
        },
        prepareWaitForInput: () => ({
          commit: async () => {
            const input = waits.shift() ?? null;
            if (input?.kind === "compact") compactDelivered = true;
            return input;
          },
          cancel: async () => {},
        }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(capturedMessages).toHaveLength(4);
    expect(JSON.stringify(capturedMessages[1])).not.toContain("follow up after compaction");
    expect(JSON.stringify(capturedMessages[2])).toContain("follow up after compaction");
    expect(JSON.stringify(capturedMessages[3])).toContain("follow-up");
  });

  test("a parked compact and the message after it each read the surface current at their own request", async () => {
    const recall: RuntimeTool = {
      name: "recall",
      description: "Reads recorded history",
      action: "file_read",
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "recalled", outcome: "ok", terminate: false }),
    };
    const withoutRecall = withSessionNotes();
    const withRecall = withSessionNotes(new RequestToolMap([["recall", recall]]));
    // The person switches recall while the loop is parked. Each resolve pins
    // the selection that is current at that moment, as the runtime does.
    let selected = withoutRecall.tools;
    let pinned = selected;
    const tools = {
      resolve: () => { pinned = selected; return pinned.resolve(); },
      current: () => pinned.current(),
    };
    const advertised: string[][] = [];
    const { client, capturedMessages } = makeCaptureClient([
      { events: [text("Ready.", "text-0"), done("end_turn")] },
      { events: [{ kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "saved" } } }, done("tool_use")] },
      { events: [text("Second.", "text-2"), done("end_turn")] },
    ], { onRequest: (options) => advertised.push(options.tools.map((tool) => tool.name)) });
    const waits: Array<() => AgentLoopInput> = [
      () => { selected = withRecall.tools; return compactInput(); },
      () => { selected = withoutRecall.tools; return messageInput("second"); },
    ];
    const result = await runAgentLoop({
      client,
      tools,
      checkpoint: withoutRecall.checkpoint,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do it",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "parked-surface", promptCacheKey: "parked-surface",
      artifactScopeId: "parked-surface",
      retrievalSessionId: "parked-surface",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => waits.shift()?.() ?? null,
          cancel: async () => {},
        }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(capturedMessages).toHaveLength(3);
    // The checkpoint instruction names recall only when its request offers it.
    expect(advertised[1]).toContain("recall");
    expect(JSON.stringify(capturedMessages[1])).toContain("Use the `recall` tool");
    // A park ends the compaction's admission: the message reads the new choice.
    expect(advertised[2]).not.toContain("recall");
  });
});
