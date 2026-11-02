import { describe, expect, test } from "bun:test";
import { providerModelInfo } from "../../../../../../src/infra/llm/provider-model-info.js";
import {
  coordinatorCandidates, createHostRegistry, HOST_SPLIT_EXCEPTIONS, hostKey, hostValues, type HostPlace,
} from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import type { AgentHost } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host.js";
import { forwardDiagnostics, payloads } from "../_bridge-harness.js";

forwardDiagnostics();

/** A host that records its closes, whose close settles once `stopped` does. The registry reads only `sessionId`,
 *  `ended`, and `close`, so the other members are never called. */
function fakeHost(closes: string[], sessionId = "host", stopped: Promise<void> = Promise.resolve()): AgentHost {
  const ended = Promise.withResolvers<Error>();
  const unused = (): never => { throw new Error("the registry reads only sessionId, ended, and close"); };
  return {
    sessionId, folder: { configDir: "/scratch", cwd: "/scratch", sessionId }, get toolGate() { return unused(); },
    definition: unused, admit: unused, dispatch: unused, settled: unused, stopTask: unused, takeHiddenRequests: unused, released: unused, requestFailure: unused,
    ended: ended.promise,
    served: false,
    close: async (reason: string) => { closes.push(reason); ended.resolve(new Error(reason)); await stopped; },
  };
}

/** The place of an agent of the tree `tree` on the login `/login`, with the values that every agent of a tree sends. */
function place(overrides: Partial<HostPlace> = {}, values: Partial<Parameters<typeof hostValues>[0]> = {}): HostPlace {
  return {
    configDir: "/login", extraUsage: "refuse", treeRootSessionId: "tree", gitRepository: true,
    values: hostValues({
      tools: [], wireModelId: "claude-opus-5-5", contextLimit: 200_000, thinking: { type: "adaptive" }, extraBody: { tool_choice: { type: "auto" }, max_tokens: 64_000 },
      eagerInputStreaming: true, promptCaching: true, effort: "high", ...values,
    }),
    ...overrides,
  };
}

describe("the agent host registry", () => {
  test("opens one host for a key however many agents lease it", () => {
    for (const agents of [1, 8, 100]) {
      const registry = createHostRegistry();
      let opened = 0;
      const leases = Array.from({ length: agents }, () => registry.lease(place(), () => { opened += 1; return fakeHost([]); }));
      expect({ agents, opened, hosts: new Set(leases.map((lease) => lease.host)).size }).toEqual({ agents, opened: 1, hosts: 1 });
      void registry.drain();
    }
  });

  test("opens a host for each key, closes a host at once when its last lease ends, and drains every host", async () => {
    const registry = createHostRegistry();
    const closes: string[] = [];
    const a = registry.lease(place({ configDir: "login-1" }), () => fakeHost(closes));
    const held = registry.lease(place({ configDir: "login-1" }), () => fakeHost(closes));
    const b = registry.lease(place({ configDir: "login-2" }), () => fakeHost(closes));
    expect(a.host).not.toBe(b.host);
    a.release();
    expect(closes).toEqual([]);
    held.release();
    expect(closes).toEqual(["released"]);
    const again = registry.lease(place({ configDir: "login-1" }), () => fakeHost(closes));
    expect(again.host).not.toBe(a.host);
    await registry.drain();
    expect(closes).toEqual(["released", "shutdown", "shutdown"]);
  });

  test("a last release and a drain resolve only once the host's slow close settled, and a new lease meanwhile opens a new host", async () => {
    const registry = createHostRegistry();
    const stopped = Promise.withResolvers<void>();
    const closes: string[] = [];
    const lease = registry.lease(place(), () => fakeHost(closes, "slow", stopped.promise));
    const settled: string[] = [];
    const released = lease.release().then(() => { settled.push("release"); });
    const drained = registry.drain().then(() => { settled.push("drain"); });
    const next = registry.lease(place(), () => fakeHost([], "next"));
    await Bun.sleep(1);
    expect({ closes, settled, next: next.host.sessionId }).toEqual({ closes: ["released"], settled: [], next: "next" });
    stopped.resolve();
    await Promise.all([released, drained]);
    expect(settled.sort()).toEqual(["drain", "release"]);
  });

  test("gives each accepted split its own host and one split record that names its fields as an exception, and names any other difference as no exception", async () => {
    const splits: readonly (readonly [HostPlace, readonly string[]])[] = [
      [place({ configDir: "/other-login" }), ["configDir"]],
      [place({ extraUsage: "allow" }), ["extraUsage"]],
      [place({ gitRepository: false }), ["gitRepository"]],
      [place({}, { thinking: { type: "adaptive", display: "omitted" } }), ["values.thinking.display"]],
      [place({}, { extraBody: { tool_choice: { type: "auto" }, max_tokens: 64_000, context_management: { edits: [] }, service_tier: "auto" } }), ["values.extraBody"]],
      [place({}, { thinking: { type: "enabled", budget_tokens: 16_000 } }), ["values.thinking.type", "values.thinking.budget_tokens"]],
    ];
    for (const [split, fields] of splits) {
      expect(hostKey(split)).not.toBe(hostKey(place()));
      expect(fields.every((field) => HOST_SPLIT_EXCEPTIONS.has(field))).toBe(true);
    }
    const defects: readonly (readonly [HostPlace, readonly string[]])[] = [
      [place({}, { extraBody: { tool_choice: { type: "auto" }, max_tokens: 32_000 } }), ["values.extraBody.max_tokens"]],
      [place({}, { tools: [{ name: "read", description: "Reads a file.", inputSchema: {} }] }), ["values.tools"]],
      [place({}, { promptCaching: false }), ["values.promptCaching"]],
    ];
    for (const [index, [split, fields]] of [...splits, ...defects].entries()) {
      const registry = createHostRegistry();
      registry.lease(place(), () => fakeHost([], "first"));
      registry.lease(place(), () => fakeHost([], "unused"));
      registry.lease(split, () => fakeHost([], "second"));
      registry.lease(split, () => fakeHost([], "unused"));
      registry.lease(place({ treeRootSessionId: "other-tree" }), () => fakeHost([], "other"));
      expect(payloads("provider.claude_sdk.host.split").at(-1)).toEqual({ treeRootSessionId: "tree", sessionId: "second", openHostSessionId: "first", fields, exception: index < splits.length });
      await registry.drain();
    }
    expect(payloads("provider.claude_sdk.host.split")).toHaveLength(splits.length + defects.length);
  });
});

describe("the coordinator's models", () => {
  const values = (thinking: { readonly type: "adaptive" } | { readonly type: "enabled"; readonly budget_tokens: number }, maxTokens = 64_000, effort?: "high") => hostValues({
    tools: [], wireModelId: "claude-opus-5-5", contextLimit: 200_000, thinking, extraBody: { max_tokens: maxTokens }, eagerInputStreaming: true, promptCaching: true, ...(effort === undefined ? {} : { effort }),
  });
  const offered = (wireModelId: string, releaseDate?: string, facts: { readonly outputLimit?: number; readonly reasoningEfforts?: readonly ("low" | "medium" | "high")[] } = {}) => ({
    wireModelId, resolvedModelMetadata: providerModelInfo({ provider: "anthropic", id: wireModelId, outputLimit: facts.outputLimit ?? 128_000, reasoning: true, ...(releaseDate === undefined ? {} : { releaseDate }), ...(facts.reasoningEfforts === undefined ? {} : { reasoningEfforts: facts.reasoningEfforts }) }),
  });
  const own = (wireModelId: string, model = wireModelId) => ({ wireModelId, model });
  const models = (candidates: readonly { readonly model: string }[]) => candidates.map(({ model }) => model);
  // A lineup listed oldest first and out of family order, so only the ranking can put it in order.
  const lineup = [
    offered("claude-fable-5-1", "2026-06-04"), offered("claude-opus-5-5", "2026-09-10"), offered("claude-sonnet-4-5", "2025-09-29"), offered("claude-haiku-5-6"),
    offered("claude-sonnet-5-5", "2026-09-10"), offered("claude-haiku-4-5", "2025-10-15"), offered("claude-haiku-5", "2026-03-01"), offered("claude-haiku-5-5", "2026-09-10"),
  ];

  test("run from Haiku to Fable whatever the version, newest release first within a family and an unknown release last, and end with the opening agent's model", () => {
    expect(models(coordinatorCandidates(lineup, values({ type: "enabled", budget_tokens: 16_000 }), own("claude-fable-5-1")))).toEqual([
      "claude-haiku-5-5", "claude-haiku-5", "claude-haiku-4-5", "claude-haiku-5-6", "claude-sonnet-5-5", "claude-sonnet-4-5", "claude-opus-5-5", "claude-fable-5-1",
    ]);
  });

  test("go on past the opening agent's model, which keeps its place in its engine spelling when the lineup lists it and else comes last", () => {
    expect(models(coordinatorCandidates(lineup, values({ type: "adaptive" }), own("claude-haiku-5-5", "claude-haiku-5-5[1m]")))).toEqual([
      "claude-haiku-5-5[1m]", "claude-haiku-5", "claude-haiku-5-6", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1",
    ]);
    expect(models(coordinatorCandidates([offered("claude-opus-5-5", "2026-09-10"), offered("claude-sonnet-5-5", "2026-09-10")], values({ type: "adaptive" }), own("claude-sonnet-5-1", "claude-sonnet-5-1[1m]")))).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-sonnet-5-1[1m]"]);
  });

  test("skip a family that the lineup lacks, a model that the login refused and so left the lineup, and a model of no Claude family", () => {
    expect(models(coordinatorCandidates([offered("claude-opus-5-5", "2026-09-10"), offered("claude-mythos-5-1", "2026-09-10")], values({ type: "adaptive" }), own("claude-fable-5-1")))).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
  });

  test("skip a model that does not accept the host's values: adaptive thinking, a max_tokens over its output limit, or the coordinator's effort", () => {
    const adaptive = models(coordinatorCandidates(lineup, values({ type: "adaptive" }), own("claude-fable-5-1")));
    expect(adaptive).not.toContain("claude-haiku-4-5");
    expect(adaptive).not.toContain("claude-sonnet-4-5");
    expect(models(coordinatorCandidates([offered("claude-haiku-5-5", "2026-09-10", { outputLimit: 64_000 }), offered("claude-sonnet-5-5", "2026-09-10")], values({ type: "adaptive" }, 100_000), own("claude-opus-5-5"))))
      .toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(models(coordinatorCandidates([offered("claude-haiku-5-5", "2026-09-10", { reasoningEfforts: ["medium", "high"] }), offered("claude-sonnet-5-5", "2026-09-10")], values({ type: "adaptive" }, 64_000, "high"), own("claude-opus-5-5"))))
      .toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  });

  test("skip a model whose facts Flywheel does not know, and run on the opening agent's model without a lineup", () => {
    expect(models(coordinatorCandidates([{ wireModelId: "claude-haiku-5-5" }], values({ type: "adaptive" }), own("claude-opus-5-5")))).toEqual(["claude-opus-5-5"]);
    expect(coordinatorCandidates([], values({ type: "adaptive" }), own("claude-opus-5-5", "claude-opus-5-5[1m]"))).toEqual([own("claude-opus-5-5", "claude-opus-5-5[1m]")]);
  });
});
