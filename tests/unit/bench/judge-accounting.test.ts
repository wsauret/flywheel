import { describe, expect, it } from "bun:test";
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js";
import type { UsageEntry } from "../../../src/infra/llm/usage-entry.js";
import type { AgentFactory, AgentRunTerminal } from "../../../src/orchestration/agent-runtime/types.js";
import {
  completeJudge,
  createAgentJudge,
  JudgeCallFailure,
  judgePairs,
  unavailableJudgeAccounting,
  type JudgeAttemptReport,
  type JudgeCandidate,
  type JudgeModel,
} from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { scoreReviews, type ReviewCandidate } from "../../../src/orchestration/modules/development/benchmark/scoring.js";
import type { ReviewManifest } from "../../../src/orchestration/modules/development/benchmark/catalog.js";

const VERDICT = `{"winner":"A","rationale":"clearer citations"}`;

const USAGE: UsageEntry = {
  attemptId: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2026-01-01T00:00:00.000Z",
  profileId: "profile",
  attribution: { kind: "candidate", providerId: "openai_api" },
  spendMode: "direct_api",
  credentialLineage: "00000000-0000-4000-8000-000000000002",
  model: "judge-model",
  tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  classification: "real_spend",
  price: { kind: "priced", estimatedUsd: 0.12, rateCard: {}, provenance: "test" },
  currency: "USD", coverage: "complete",
};

function judgeAgent(entries: readonly UsageEntry[], terminal: AgentRunTerminal = { kind: "completed" }, text = VERDICT): AgentFactory {
  return (options) => ({
    send: () => {
      for (const usage_entry of entries) options.onEvent(createRuntimeEvent("model.usage.measured", { usage_entry, budget_stream_id: "judge" }));
      if (text) options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
        type: "model.assistant_message.recorded",
        message: { content: [{ type: "text", text }] },
      }));
    },
    end: () => undefined,
    abort: () => undefined,
    done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal }),
  });
}

function model(createAgent: AgentFactory): JudgeModel {
  return createAgentJudge({
    createAgent,
    model: "judge-model",
    systemPrompt: "",
    userDataRoot: "/user-data",
    accountHome: "/home",
  });
}

function candidates(): readonly JudgeCandidate[] {
  return [
    { variant: "a", task: "t", repeat: 0, summary: "summary a" },
    { variant: "b", task: "t", repeat: 0, summary: "summary b" },
    { variant: "c", task: "t", repeat: 0, summary: "summary c" },
  ];
}

const PROMPTS = new Map([["t", "the question"]]);

function answering(text: string): JudgeModel {
  return { complete: async () => ({ text, accounting: unavailableJudgeAccounting("the test judge measured nothing") }) };
}

describe("model judge accounting", () => {
  it("reports cost, tokens, and provider only from committed usage entries", async () => {
    const judge = model(judgeAgent([USAGE]));

    const completion = await judge.complete("prompt", new AbortController().signal);

    expect(completion.text).toBe(VERDICT);
    expect(completion.accounting.estimatedUsd).toEqual({ kind: "observed", value: 0.12 });
    expect(completion.accounting.billedUsd).toEqual({ kind: "observed", value: 0.12 });
    expect(completion.accounting.tokens).toEqual({ kind: "observed", value: 120 });
    expect(completion.accounting.providers).toEqual({ kind: "observed", value: ["openai_api"] });
  });

  it("keeps committed accounting when the Agent fails", async () => {
    const settlement = await completeJudge(model(judgeAgent([
      { ...USAGE, attribution: { kind: "candidate", providerId: "anthropic_api" } },
    ], { kind: "api_error", message: "provider stream broke", recovery: { kind: "none" } }, "")), "prompt");

    expect(settlement.error).toContain("provider stream broke");
    expect(settlement.terminal).toBe("failed");
    expect(settlement.accounting.estimatedUsd).toEqual({ kind: "observed", value: 0.12 });
    expect(settlement.accounting.tokens).toEqual({ kind: "observed", value: 120 });
    expect(settlement.accounting.providers).toEqual({ kind: "observed", value: ["anthropic_api"] });
  });

  it("does not account uncommitted provider observations", async () => {
    const completion = await model(judgeAgent([])).complete("prompt", new AbortController().signal);
    expect(completion.accounting).toEqual(unavailableJudgeAccounting("the benchmark reported no committed usage"));
  });

  it("keeps the accounting of a call that outran its bound", async () => {
    const accounting = { ...unavailableJudgeAccounting("no reading"), estimatedUsd: { kind: "observed", value: 0.03 } as const };
    const slow: JudgeModel = {
      complete: async (_prompt, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new JudgeCallFailure(accounting, "the judge call was stopped");
      },
    };

    const settlement = await completeJudge(slow, "prompt", 5);

    expect(settlement.terminal).toBe("timed-out");
    expect(settlement.error).toBe("Judge call timed out after 5 ms");
    expect(settlement.accounting.estimatedUsd).toEqual({ kind: "observed", value: 0.03 });
  });

  it("keeps the accounting of a call the caller cancelled", async () => {
    const accounting = { ...unavailableJudgeAccounting("no reading"), tokens: { kind: "observed", value: 42 } as const };
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    const gated: JudgeModel = {
      complete: async (_prompt, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await gate.promise;
        throw new JudgeCallFailure(accounting, "the judge call was stopped");
      },
    };

    const settlement = completeJudge(gated, "prompt", 60_000, controller.signal);
    let settled = false;
    void settlement.then(() => { settled = true; });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();

    expect(await settlement).toMatchObject({
      value: "",
      error: "Judge call was cancelled",
      terminal: "cancelled",
      accounting: { tokens: { kind: "observed", value: 42 } },
    });
  });

  it("maps a rejected judge call to its provider failure", async () => {
    const refused: JudgeModel = { complete: async () => { throw new Error("provider refused"); } };
    expect(await completeJudge(refused, "prompt")).toMatchObject({
      value: "", error: "Judge call failed: provider refused", terminal: "failed",
    });
  });
});

describe("model judge pin", () => {
  it("asks for the pinned effort, and leaves the model default when no effort is pinned", async () => {
    const efforts: unknown[] = [];
    const recording: AgentFactory = (options) => {
      efforts.push(options.effort);
      return judgeAgent([])(options);
    };
    await createAgentJudge({ createAgent: recording, model: "judge-model", effort: "high", userDataRoot: "/user-data", accountHome: "/home" }).complete("prompt", new AbortController().signal);
    await model(recording).complete("prompt", new AbortController().signal);
    expect(efforts).toEqual(["high", undefined]);
  });
});

describe("judged loop attempt settlement", () => {
  it("reports one attempt for every pair it judged", async () => {
    const attempts: JudgeAttemptReport[] = [];
    const verdicts = await judgePairs(candidates(), PROMPTS, answering(VERDICT), () => true, undefined, {
      onAttempt: async (report) => { attempts.push(report); },
    });

    expect(verdicts).toHaveLength(3);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((report) => report.terminal === "completed")).toBe(true);
    expect(attempts[0]?.score).toEqual({ kind: "pair-score", task: "t", repeat: 0, slotA: "a", slotB: "b" });
  });

  it("persists the settlement and the score of a paid call that cancellation followed", async () => {
    const controller = new AbortController();
    const attempts: JudgeAttemptReport[] = [];
    const settled: string[] = [];
    const verdicts = await judgePairs(candidates(), PROMPTS, answering(VERDICT), () => true, undefined, {
      signal: controller.signal,
      onAttempt: async (report) => {
        attempts.push(report);
        controller.abort();
      },
      onSettled: async ({ value }) => { settled.push(`${value.slotA}/${value.slotB}`); },
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.terminal).toBe("completed");
    expect(settled).toEqual(["a/b"]);
    expect(verdicts).toHaveLength(1);
  });

  it("records canceled accounting and no score for a call stopped before it completed", async () => {
    const controller = new AbortController();
    const attempts: JudgeAttemptReport[] = [];
    const settled: string[] = [];
    const gated: JudgeModel = {
      complete: async (_prompt, signal) => {
        // The stop is observed from a listener registered before the abort, the
        // way a real in-flight request observes it.
        const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        controller.abort();
        await stopped;
        throw new JudgeCallFailure(
          { ...unavailableJudgeAccounting("no reading"), estimatedUsd: { kind: "observed", value: 0.007 } },
          "the judge call was stopped",
        );
      },
    };

    const verdicts = await judgePairs(candidates(), PROMPTS, gated, () => true, undefined, {
      signal: controller.signal,
      onAttempt: async (report) => { attempts.push(report); },
      onSettled: async ({ value }) => { settled.push(value.slotA); },
    });

    expect(verdicts).toEqual([]);
    expect(settled).toEqual([]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.terminal).toBe("cancelled");
    expect(attempts[0]?.accounting.estimatedUsd).toEqual({ kind: "observed", value: 0.007 });
  });

  it("reports one attempt for every review it scored", async () => {
    const manifest: ReviewManifest = { title: "fixture", review_prompt_hint: "review the fixture", defects: [{ id: "d1", title: "t", category: "correctness", files: ["fixture.ts"], catch_criteria: "c" }] };
    const results: readonly ReviewCandidate[] = [{ variant: "a", task: "t", repeat: 0, summary: "review text" }];
    const attempts: JudgeAttemptReport[] = [];

    const scores = await scoreReviews(results, new Map([["t", manifest]]), answering(`{"caught":["d1"],"uncertain":[],"unsupported_finding_count":0,"unsupported_severe_finding_count":0}`), {
      onAttempt: async (report) => { attempts.push(report); },
    });

    expect(scores).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.score).toEqual({ kind: "review-score", variant: "a", task: "t", repeat: 0 });
    expect(attempts[0]?.terminal).toBe("completed");
  });
});
