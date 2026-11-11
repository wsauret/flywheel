import { describe, expect, it } from "bun:test";
import type { UsageEntry } from "../../../src/infra/llm/usage-entry.js";
import type { Agent, AgentFactory, AgentOptions, AgentRunResult, RuntimeToolSurfaces } from "../../../src/orchestration/agent-runtime/types.js";
import { createBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/accounting.js";
import { invokeBenchmarkAgent } from "../../../src/orchestration/modules/development/benchmark/invocation.js";

const BASE_USAGE: UsageEntry = {
  attemptId: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2026-01-01T00:00:00.000Z",
  profileId: "profile",
  attribution: { kind: "candidate", providerId: "anthropic", instanceId: "account" },
  spendMode: "included",
  credentialLineage: "00000000-0000-4000-8000-000000000002",
  model: "claude",
  tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 },
  classification: "subscription_equivalent",
  price: { kind: "priced", estimatedUsd: 0.25, rateCard: {}, provenance: "test" },
  currency: "USD", coverage: "complete",
};

function options(onEvent: AgentOptions["onEvent"] = () => undefined): Omit<AgentOptions, "conversation" | "lifecycle" | "runtimeSurfaces"> {
  return {
    model: "model",
    purpose: { kind: "persona-benchmark" },
    executionCwd: "/project",
    projectRoot: "/project",
    userDataRoot: "/user-data",
    accountHome: "/home",
    onEvent,
  };
}

describe("benchmark usage accounting", () => {
  it("deduplicates identical committed entries and accounts estimated, billed, token, and provider values", () => {
    const accounting = createBenchmarkAccounting();
    accounting.commit(BASE_USAGE);
    accounting.commit(BASE_USAGE);
    accounting.commit({
      ...BASE_USAGE,
      attemptId: "00000000-0000-4000-8000-000000000003",
      spendMode: "direct_api",
      classification: "real_spend",
      price: { kind: "priced", estimatedUsd: 0.5, rateCard: {}, provenance: "test" },
    });

    expect(accounting.observe()).toEqual({
      estimatedUsd: { kind: "observed", value: 0.75 },
      billedUsd: { kind: "observed", value: 0.5 },
      tokens: { kind: "observed", value: 42 },
      providers: { kind: "observed", value: ["anthropic"] },
      pricedEntryCount: 2,
      unpricedEntryCount: 0,
    });
  });

  it("rejects conflicting bytes for one attempt id", () => {
    const accounting = createBenchmarkAccounting();
    accounting.commit(BASE_USAGE);
    expect(() => accounting.commit({ ...BASE_USAGE, model: "different" })).toThrow("conflicts with its existing ledger entry");
  });

  it("reports unavailable values instead of fabricating observations", () => {
    const accounting = createBenchmarkAccounting();
    expect(accounting.observe()).toEqual({
      estimatedUsd: { kind: "unavailable", reason: expect.any(String) },
      billedUsd: { kind: "unavailable", reason: expect.any(String) },
      tokens: { kind: "unavailable", reason: expect.any(String) },
      providers: { kind: "unavailable", reason: expect.any(String) },
      pricedEntryCount: 0,
      unpricedEntryCount: 0,
    });
  });

  it("keeps billed spend observed when only included-value pricing is unavailable", () => {
    const accounting = createBenchmarkAccounting();
    accounting.commit({ ...BASE_USAGE, price: { kind: "unavailable", reason: "no rate card" } });
    expect(accounting.observe().estimatedUsd.kind).toBe("unavailable");
    expect(accounting.observe().billedUsd).toEqual({ kind: "observed", value: 0 });
  });

  it("reports a lower bound and names the attempt when a served attempt reported no usage", () => {
    const accounting = createBenchmarkAccounting();
    const { tokens: _tokens, price: _price, currency: _currency, ...attempt } = BASE_USAGE;
    const unmeasured = "00000000-0000-4000-8000-000000000004";
    accounting.commit({ ...attempt, attemptId: unmeasured, coverage: "unmeasured" });
    accounting.commit(BASE_USAGE);

    const observed = accounting.observe();
    expect(observed.estimatedUsd).toEqual({ kind: "unavailable", reason: expect.stringContaining(unmeasured), atLeast: 0.25 });
    expect(observed.tokens).toEqual({ kind: "unavailable", reason: expect.stringContaining(unmeasured), atLeast: 21 });
    expect(observed.billedUsd).toEqual({ kind: "observed", value: 0 });
    expect([observed.pricedEntryCount, observed.unpricedEntryCount]).toEqual([1, 1]);
  });

  it("marks the totals of a report that ended early as lower bounds", () => {
    const accounting = createBenchmarkAccounting();
    accounting.commit({ ...BASE_USAGE, coverage: "partial", classification: "real_spend", spendMode: "direct_api" });

    const observed = accounting.observe();
    expect(observed.estimatedUsd).toMatchObject({ kind: "unavailable", atLeast: 0.25 });
    expect(observed.billedUsd).toMatchObject({ kind: "unavailable", atLeast: 0.25 });
    expect(observed.tokens).toMatchObject({ kind: "unavailable", atLeast: 21 });
  });
});

describe("benchmark Agent invocation", () => {
  it("uses a stateless one-shot host and forwards runtime tool surfaces unchanged", async () => {
    const surfaces: RuntimeToolSurfaces = {};
    let received: AgentOptions | undefined;
    let sent: unknown;
    const createAgent: AgentFactory = (agentOptions) => {
      received = agentOptions;
      return {
        send: (message) => { sent = message; },
        end: () => undefined,
        abort: () => undefined,
        done: Promise.resolve({ servedRequests: 0, durationMs: 7, terminal: { kind: "completed" } }),
      };
    };

    const result = await invokeBenchmarkAgent({ createAgent, runtimeSurfaces: surfaces, agentOptions: options(), prompt: "hello" });

    expect(result).toEqual({ servedRequests: 0, durationMs: 7, terminal: { kind: "completed" } });
    expect(sent).toBe("hello");
    expect(received?.runtimeSurfaces).toBe(surfaces);
    expect(received?.conversation).toEqual({ kind: "stateless" });
    expect(received?.lifecycle).toEqual({ kind: "one-shot" });
  });

  it("requests deadline cancellation but waits for an abort-ignoring Agent to settle", async () => {
    let settle!: (result: AgentRunResult) => void;
    let aborted = false;
    let invocationSettled = false;
    const createAgent: AgentFactory = () => ({
      send: () => undefined,
      end: () => undefined,
      abort: () => { aborted = true; },
      done: new Promise((resolve) => { settle = resolve; }),
    } satisfies Agent);

    const invocation = invokeBenchmarkAgent({ createAgent, runtimeSurfaces: {}, agentOptions: options(), prompt: "hello", deadlineMs: 1 });
    void invocation.then(() => { invocationSettled = true; });
    await Bun.sleep(10);
    expect(aborted).toBe(true);
    expect(invocationSettled).toBe(false);

    settle({ servedRequests: 0, durationMs: 10, terminal: { kind: "aborted" } });
    expect(await invocation).toEqual({ servedRequests: 0, durationMs: 10, terminal: { kind: "aborted" } });
  });
});
