import { describe, expect, spyOn, test } from "bun:test";
import { summarizeSubagentWork } from "../../../../src/orchestration/modules/subagents/execution/summarize-work.js";
import { buildFallbackSummary, type SubagentToolCallRecord } from "../../../../src/orchestration/modules/subagents/execution/work-log.js";
import { AllCandidatesExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors.js";
import { failureSummaryInput } from "./subagent/_fixtures.js";
import { checkpointTestPersistences } from "../../../helpers/checkpoint-store.js";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { FUNCTION_TOOL_PRESENTATION, type ModelClient, type ProviderStreamEvent, type ServingAttempt, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { ownHistoryTarget } from "./_model-client.js";

const records: SubagentToolCallRecord[] = ["a.ts", "b.ts", "c.ts"].map((path) => ({ toolName: "read", input: { path }, status: "done" }));
type Stream = (options: StreamOptions) => AsyncGenerator<ProviderStreamEvent>;
function clientFor(streams: Stream[]): ModelClient {
  const attempts: ServingAttempt[] = streams.map((_, index) => ({
    accessProvider: "github_copilot", accessProviderCandidate: { kind: "subscription", providerId: "github_copilot", instanceId: `account-${index}`, spendMode: "included" },
    modelFamily: "openai", model: "gpt-4.1", toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  }));
  const plannedAttempt = async () => attempts[0]!;
  return {
    model: "gpt-4.1", modelFamily: "openai", plannedAttempt,
    admitRequest: async () => ({
      candidateAttributions: [], plannedAttempt,
      prepare: async () => { throw new Error("this fake serves sends only") },
      run: async ({ execute, prepare }) => {
        for (const [index, streamWithTools] of streams.entries()) {
          const attempt = attempts[index]!;
          const prepared = await prepare(attempt);
          const result = await execute({ attempt, client: { historyTarget: ownHistoryTarget, ...attempt, streamWithTools(options) {
            expect(prepared.messages).toBe(options.messages);
            expect(options.systemPrompt).toEqual(prepared.systemPrompt);
            expect(options.tools).toBe(prepared.tools);
            expect(options.cacheRetention).toBe(prepared.cacheRetention);
            return streamWithTools(options);
          } }, prepared });
          if (result.kind === "success") return result.value;
        }
        throw new AllCandidatesExhaustedError({ message: "all accounts exhausted", recovery: { kind: "none" } });
      },
    }),
  };
}
const persistence = checkpointTestPersistences();
const summary = (client: ModelClient, signal?: AbortSignal) => summarizeSubagentWork(failureSummaryInput(persistence(), async () => client, { records, terminalError: "worker failed", ...(signal ? { signal } : {}) }));
function quota(): Error {
  return normalizeProviderAttemptFailure(Object.assign(new Error("quota exhausted"), { status: 429 }));
}
// Preserve the production deadline while making its timer deterministic and fast in this test.
function fastSummaryDeadline() {
  const original = AbortSignal.timeout;
  return spyOn(AbortSignal, "timeout").mockImplementation(() => original(1));
}

describe("auxiliary fallback regressions", () => {
  test("summary falls back only on actual candidate exhaustion, not a local Failure tag", async () => {
    expect(await summary(clientFor([async function* () { throw quota(); }]))).toBe(buildFallbackSummary(records));
    const local = Object.assign(new Error("local closure broke"), { _tag: "LocalFailure" });
    await expect(summary(clientFor([async function* () { throw local; }]))).rejects.toThrow("local closure broke");
  });

  test("summary deadline returns fallback before provider closure, including a late local fault", async () => {
    const timer = fastSummaryDeadline();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let settled = false;
    const client = clientFor([async function* (options) {
      const signal = options.signal!;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
      await release.promise;
      throw Object.assign(new Error("closure failed"), { _tag: "LocalFailure" });
    }]);
    try {
      const pending = summary(client);
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await aborted.promise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      expect(await pending).toBe(buildFallbackSummary(records));
      release.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    } finally { release.resolve(); timer.mockRestore(); }
  });

  test("summary caller cancellation returns deterministic fallback, including an already stopped caller", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const client = clientFor([async function* () { controller.abort(reason); throw reason; }]);
    expect(await summary(client, controller.signal)).toBe(buildFallbackSummary(records));
    expect(await summarizeSubagentWork(failureSummaryInput(persistence(), async () => client, { records: [], terminalError: "failed", signal: controller.signal }))).toBe(buildFallbackSummary([]));
  });

});
