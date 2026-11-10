import { expect, test } from "bun:test";
import { compactInput, holdInput, resumeInput } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { ContextLengthExceededError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { FUNCTION_TOOL_PRESENTATION, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { assemblyPinned, RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { asModelClient } from "../_model-client.js";
import { makeCaptureClient, withSessionNotes } from "./_loop-fixtures.js";
import { handoffDefinition } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

for (const missing of ["checkpoint", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"] as const) {
  for (const trigger of ["automatic", "manual", "overflow"] as const) {
    test(`${trigger} cannot compact without ${missing}`, async () => {
      const requests: StreamOptions[] = [];
      const notices: string[] = [];
      let queued = false;
      const notes = withSessionNotes();
      const tools = new RequestToolMap(notes.tools);
      tools.delete(missing);
      const client = asModelClient({
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: trigger === "automatic" ? 10_000 : 100_000,
        outputLimit: 8000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION,
        async *streamWithTools(request) {
          requests.push({ ...request, messages: [...request.messages] });
          if (trigger === "overflow") throw normalizeProviderAttemptFailure(new ContextLengthExceededError());
          yield { kind: "text_delta", text: "done", blockKey: "text" } as const;
          yield { kind: "done", stopReason: "end_turn" } as const;
        }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      });
      const result = await runAgentLoop({
        client, tools: await assemblyPinned(tools), systemPrompt: stableSystemPrompt("test"), instruction: null, executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
        providerSessionKey: "no-notes", promptCacheKey: "no-notes", artifactScopeId: "no-notes", retrievalSessionId: "no-notes",
        seed: { kind: "resume", priorMessages: [{ kind: "user", content: "old task" }, { kind: "assistant", content: "old answer ".repeat(4000) }] },
        ...(missing === "checkpoint" ? {} : { checkpoint: notes.checkpoint }),
        onEvent: () => {}, onSystemMessage: (message) => notices.push(message),
        persistence: { history: { append: () => {} } },
        inputSource: { drainPending: () => { if (trigger === "manual" && !queued) { queued = true; return compactInput(); } return null; } },
      });
      expect(result.kind).toBe(trigger === "overflow" ? "context_overflow" : "completed");
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0]?.messages)).toContain("old task");
      expect(JSON.stringify(requests)).not.toContain("Save the checkpoint now:");
      expect(JSON.stringify(requests)).not.toContain("Save one concise checkpoint");
      if (trigger === "manual") expect(notices.join(" ")).toContain("Compaction is unavailable");
    });
  }
}

test("idle manual compaction without notes refuses without starting a provider request", async () => {
  const { client, capturedMessages } = makeCaptureClient([]);
  const notices: string[] = [];
  let queued = false;
  const result = await runAgentLoop({
    client, tools: await assemblyPinned(new RequestToolMap()), systemPrompt: stableSystemPrompt("test"), instruction: null, executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "idle", promptCacheKey: "idle", artifactScopeId: "idle", retrievalSessionId: "idle",
    seed: { kind: "resume", priorMessages: [{ kind: "user", content: "old task" }, { kind: "assistant", content: "old answer" }] },
    persistence: { history: { append: () => {} } },
    lifecycle: { maintenance: {} }, onEvent: () => {}, onSystemMessage: (message) => notices.push(message),
    inputSource: {
      drainPending: () => { if (queued) return null; queued = true; return compactInput(); },
      prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
    },
  });
  expect(result.kind).toBe("input_closed");
  expect(capturedMessages).toHaveLength(0);
  expect(notices.join(" ")).toContain("Compaction is unavailable");
});

// A maintenance start runs no turn of the person's: its hold or its first
// compaction parks where the conversation's last turn ended. Once the person
// resumes, a later compaction parks as any answered turn does.
const park = (userResumeRequired: boolean, turnCount: number) => ({ userResumeRequired, turnCount });
for (const [start, awaitsPerson, requests, parks, turnsEnded] of [
  ["compact", false, 1, [park(false, 1)], 1],
  ["compact", true, 3, [park(true, 1), park(false, 2), park(false, 3)], 2],
  ["hold", false, 0, [park(false, 0)], 0],
  ["hold", true, 2, [park(true, 0), park(false, 1), park(false, 2)], 2],
] as const) {
  test(`maintenance ${start} parks ${awaitsPerson ? "for the person when the last turn waits for the person" : "as an answered turn"}`, async () => {
    // A compaction's request saves the checkpoint; the resumed turn answers.
    const save = { events: [{ kind: "tool_use" as const, toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "saved" } } }, { kind: "done" as const, stopReason: "tool_use" as const }] };
    const answer = { events: [{ kind: "text_delta" as const, text: "answered", blockKey: "text" }, { kind: "done" as const, stopReason: "end_turn" as const }] };
    const { client, capturedMessages } = makeCaptureClient(start === "compact" ? [save, answer, save] : [answer, save]);
    const observedParks: { userResumeRequired: boolean; turnCount: number }[] = [];
    let observedTurnsEnded = 0;
    let queued = false;
    // The person resumes, then compacts again.
    const parkedInputs = awaitsPerson ? [resumeInput(), compactInput()] : [];
    const notes = withSessionNotes();
    const result = await runAgentLoop({
      client, tools: await assemblyPinned(notes.tools), checkpoint: notes.checkpoint, systemPrompt: stableSystemPrompt("test"), instruction: null, executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "maintenance", promptCacheKey: "maintenance", artifactScopeId: "maintenance", retrievalSessionId: "maintenance",
      seed: { kind: "resume", priorMessages: [{ kind: "user", content: "old task" }, { kind: "assistant", content: "old answer" }] },
      persistence: { history: { append: () => {} } },
      lifecycle: {
        maintenance: awaitsPerson ? { personWait: { turnEnd: "recorded" } } : {},
        onTurnEnded: () => { observedTurnsEnded++; },
        onTurnParked: ({ userResumeRequired, turnCount }) => { observedParks.push({ userResumeRequired, turnCount }); },
      },
      onEvent: () => {},
      inputSource: {
        drainPending: () => { if (queued) return null; queued = true; return start === "compact" ? compactInput() : holdInput(); },
        prepareWaitForInput: () => ({ commit: async () => parkedInputs.shift() ?? null, cancel: async () => {} }),
      },
    });
    expect(result.kind).toBe("input_closed");
    expect(capturedMessages).toHaveLength(requests);
    expect(observedParks).toEqual([...parks]);
    expect(observedTurnsEnded).toBe(turnsEnded);
  });
}

// A context overflow of the checkpoint request resets the context in place of
// the planned compaction, so the plan still decides what follows: a
// maintenance start parks where the last turn ended and runs no request of
// the task.
for (const awaitsPerson of [false, true]) {
  test(`maintenance compact whose checkpoint overflows parks ${awaitsPerson ? "for the person when the last turn waits for the person" : "as an answered turn"}`, async () => {
    const requests: StreamOptions[] = [];
    const observedParks: { userResumeRequired: boolean; turnCount: number }[] = [];
    let observedTurnsEnded = 0;
    let resets = 0;
    let queued = false;
    const client = asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000,
      outputLimit: 8000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(request) {
        requests.push({ ...request, messages: [...request.messages] });
        if (requests.length === 1) throw normalizeProviderAttemptFailure(new ContextLengthExceededError());
        yield { kind: "text_delta", text: "continued the task", blockKey: "text" } as const;
        yield { kind: "done", stopReason: "end_turn" } as const;
      }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    });
    const notes = withSessionNotes();
    const result = await runAgentLoop({
      client, tools: await assemblyPinned(notes.tools), checkpoint: notes.checkpoint, systemPrompt: stableSystemPrompt("test"), instruction: null, executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "maintenance-overflow", promptCacheKey: "maintenance-overflow", artifactScopeId: "maintenance-overflow", retrievalSessionId: "maintenance-overflow",
      seed: { kind: "resume", priorMessages: [{ kind: "user", content: "old task" }, { kind: "assistant", content: "old answer" }] },
      persistence: { history: { append: () => {} } },
      lifecycle: {
        maintenance: awaitsPerson ? { personWait: { turnEnd: "recorded" } } : {},
        onTurnEnded: () => { observedTurnsEnded++; },
        onTurnParked: ({ userResumeRequired, turnCount }) => { observedParks.push({ userResumeRequired, turnCount }); },
      },
      onEvent: (event) => { if (event.kind === "compaction_done" && event.success) resets++; },
      inputSource: {
        drainPending: () => { if (queued) return null; queued = true; return compactInput(); },
        prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
      },
    });
    expect(result.kind).toBe("input_closed");
    expect(requests).toHaveLength(1);
    expect(observedParks).toEqual([park(awaitsPerson, 1)]);
    expect(resets).toBe(1);
    expect(observedTurnsEnded).toBe(awaitsPerson ? 0 : 1);
  });
}

// A plan is admitted only when its whole save round, a checkpoint read and
// up to three writes, precedes the budget closure.
test.each([
  [4, "refuses a plan whose save round would reach the closure", 0],
  [5, "saves after a read-only first response that the closure follows", 1],
] as const)("automatic checkpoint with a %d-call budget %s", async (maxLLMCalls, _case, expectedResets) => {
  const toolRound = (id: string, name: string, input: { section?: string; value?: string; summary?: string }) => ({ events: [{ kind: "tool_use" as const, toolCall: { id, name, input } }, { kind: "done" as const, stopReason: "tool_use" as const }] });
  const { client, capturedMessages } = makeCaptureClient([
    ...(maxLLMCalls === 4 ? [] : [toolRound("read", "checkpoint_read", {}), toolRound("save", "checkpoint_replace", { section: "currentState", value: "saved state" })]),
    toolRound("done", "handoff", { summary: "done" }),
  ], { contextLimit: 10_000 });
  const notes = withSessionNotes(new RequestToolMap([["handoff", handoffDefinition]]));
  let resets = 0;
  const publishedTriggers: number[] = [];
  const result = await runAgentLoop({
    client, ...notes, maxLLMCalls, handoff: { onContent: () => {} },
    tools: notes.tools,
    systemPrompt: stableSystemPrompt("test"), instruction: null, executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "closure", promptCacheKey: "closure", artifactScopeId: "closure", retrievalSessionId: "closure",
    seed: { kind: "resume", priorMessages: [{ kind: "user", content: "retain this task" }, { kind: "assistant", content: "old work ".repeat(4000) }] },
    onEvent: (event) => {
      if (event.kind === "compaction_done" && event.success) resets++;
      if (event.kind === "context_update" && event.compactionTriggerTokens !== undefined) publishedTriggers.push(event.compactionTriggerTokens);
    },
    persistence: { history: { append: () => {} } },
  });
  expect(result.kind).toBe("completed");
  expect(resets).toBe(expectedResets);
  // A run that cannot admit a plan states that no automatic reset runs.
  if (maxLLMCalls === 4) expect(new Set(publishedTriggers)).toEqual(new Set([0]));
  else expect(publishedTriggers[0]).toBeGreaterThan(0);
  expect(capturedMessages).toHaveLength(maxLLMCalls === 4 ? 1 : 3);
  if (maxLLMCalls === 4) expect(JSON.stringify(capturedMessages[0])).toContain("retain this task");
  else expect(JSON.stringify(capturedMessages[2])).not.toContain("retain this task");
});
