import { describe, expect, it } from "bun:test";
import type { AgentDefinition } from "../../../src/infra/agent-definition.js";
import type { Agent, AgentOptions, AgentRunResult } from "../../../src/orchestration/agent-runtime/types.js";
import type { RuntimeToolInput, ToolContext } from "../../../src/orchestration/agent-runtime/tools/types.js";
import { ChatRoutingFailure, chatRoutingGuidance, runChatRoutingTask } from "../../../src/orchestration/modules/development/benchmark/chat-routing-run.js";
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js";
import { composeModuleRuntimes } from "../../../src/infra/module-runtime.js";
import { publishSkillRevision } from "../../../src/workflows/skill-schema.js";
import { testKernelToolDeps } from "../../helpers/request-tool-surface.js";

const ADVISOR: AgentDefinition = { kind: "persona", name: "advisor", role: "advisor", description: "Advice", systemPrompt: "Advise", tools: ["read"], maxTurns: 4 };
const EXPLORER: AgentDefinition = { kind: "persona", name: "explorer", role: "explorer", description: "Explore", systemPrompt: "Explore", tools: ["read"], maxTurns: 4 };

const TOOL_CONTEXT: ToolContext = {
  executionCwd: "/project",
  artifactScopeId: "routing-test",
  retrievalSessionId: "routing-test",
  sessionId: "routing-test",
  userDataRoot: "/scratch/test-account", projectRoot: "/project",
  flushCanonicalMessages: async () => {},
};

function agentFactory(inputs: readonly Readonly<RuntimeToolInput>[], captured: AgentOptions[], sent: unknown[] = []) {
  return (options: AgentOptions) => {
    captured.push(options);
    const settled = Promise.withResolvers<AgentRunResult>();
    let done = false;
    const resolve = (terminal: AgentRunResult["terminal"]) => {
      if (done) return;
      done = true;
      settled.resolve({ servedRequests: 0, durationMs: 1, terminal });
    };
    return {
      send: (message: Parameters<Agent["send"]>[0]) => {
        sent.push(message);
        const contribution = options.moduleSelection?.().contributions.find((entry) => entry.domain === "tools" && entry.value.name === "subagent");
        if (!contribution || contribution.domain !== "tools") throw new Error("missing subagent contribution");
        const registration = contribution.value.declaration.registrations["subagent"];
        if (!registration) throw new Error("missing subagent registration");
        // A routing turn is stateless, so it has no session to own child work and
        // the subagents module builds no runtime for it.
        const exposed = registration.create({ kernel: testKernelToolDeps(), modules: composeModuleRuntimes([]) });
        if (!exposed.tool) throw new Error("missing intercepted tool");
        void Promise.all(inputs.map((input) => exposed.tool?.execute(input, TOOL_CONTEXT))).then(() => resolve({ kind: "completed" }));
      },
      abort: () => resolve({ kind: "interrupted" }),
      end: () => resolve({ kind: "input_closed" }),
      done: settled.promise,
    };
  };
}

function request() {
  return {
    model: "model-a", effort: "medium", prompt: "route", deadlineMs: 1_000,
    workspace: "/project", userDataRoot: "/user", accountHome: "/home",
    agentRegistry: new Map([["advisor", ADVISOR], ["explorer", EXPLORER]]),
    skills: publishSkillRevision(1, new Map()), moduleSelection: () => composeFirstPartyModules(), runtimeSurfaces: {},
  };
}

const rationale = "This independent routing decision is too costly to keep inline.";

describe("Chat routing production interception", () => {
  it("keeps dispatch absent when the contributing module is disabled", async () => {
    const selected = composeFirstPartyModules(undefined, ["subagents"]);
    let captured: AgentOptions | undefined;
    const outcome = await runChatRoutingTask({ createAgent: (options) => {
      captured = options;
      return {
        send: () => {}, abort: () => {}, end: () => {},
        done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
      };
    } }, { ...request(), moduleSelection: () => selected });
    expect(outcome.kind).toBe("no-valid-dispatch");
    expect(captured?.moduleSelection?.()).toBe(selected);
    expect(selected.contributions.some((entry) => entry.domain === "agentTasks")).toBe(false);
    expect(selected.contributions.some((entry) => entry.domain === "tools" && entry.value.name === "subagent")).toBe(false);
  });

  it("replaces concurrent valid subagent calls before child construction and keeps the first persona", async () => {
    const captured: AgentOptions[] = [];
    const outcome = await runChatRoutingTask({ createAgent: agentFactory([
      { persona: "advisor", rationale, prompt: "advise" },
      { persona: "explorer", rationale, prompt: "explore" },
    ], captured) }, request());
    expect(outcome.kind).toBe("dispatch");
    if (outcome.kind === "dispatch") expect(outcome.persona).toBe("advisor");
    expect(captured[0]).toMatchObject({ model: "model-a", effort: "medium", purpose: { kind: "chat-routing-benchmark" }, executionCwd: "/project", projectRoot: "/project" });
  });

  it("passes non-subagent core tools through unchanged", async () => {
    const captured: AgentOptions[] = [];
    const base = composeFirstPartyModules();
    await runChatRoutingTask({ createAgent: agentFactory([], captured) }, { ...request(), moduleSelection: () => base });
    const routed = captured[0]?.moduleSelection?.();
    const originalRead = base.contributions.find((entry) => entry.domain === "tools" && entry.value.name === "read");
    const routedRead = routed?.contributions.find((entry) => entry.domain === "tools" && entry.value.name === "read");
    expect(routedRead).toBe(originalRead);
  });

  it("captures the complete production Chat request, guidance, deadline, and settlement order", async () => {
    const captured: AgentOptions[] = [];
    const sent: unknown[] = [];
    const order: string[] = [];
    const outcome = await runChatRoutingTask({
      createAgent: (options) => {
        captured.push(options);
        const runner = agentFactory([], [], sent)(options);
        void runner.done.then(() => { order.push("runner"); });
        return runner;
      },
      closeOwnedBackground: async () => { order.push("background"); },
    }, { ...request(), deadlineMs: 777 });
    expect(outcome.kind).toBe("no-valid-dispatch");
    expect(captured[0]).toMatchObject({ model: "model-a", effort: "medium", purpose: { kind: "chat-routing-benchmark" }, lifecycle: { kind: "one-shot" }, executionCwd: "/project", projectRoot: "/project", userDataRoot: "/user", accountHome: "/home" });
    expect(captured[0]).not.toHaveProperty("task");
    expect(sent).toEqual(["route"]);
    expect(chatRoutingGuidance(request().agentRegistry)).toContain("advisor");
    // The model sees the production dispatch tool; the guidance is its description followed by the roster.
    const routed = captured[0]?.moduleSelection?.().contributions.find((entry) => entry.domain === "tools" && entry.value.name === "subagent");
    const tool = routed?.domain === "tools" ? routed.value.declaration.registrations["subagent"]?.create({ kernel: testKernelToolDeps(), modules: composeModuleRuntimes([]) }).tool : undefined;
    expect(tool?.name).toBe("subagent");
    expect(chatRoutingGuidance(request().agentRegistry).startsWith(`${tool?.description}\n\n# Subagents`)).toBe(true);
    expect(order).toEqual(["runner", "background"]);
  });

  it("keeps invalid dispatch distinct from no valid dispatch", async () => {
    const outcome = await runChatRoutingTask({ createAgent: agentFactory([{ persona: "advisor", prompt: "missing rationale" }], []) }, request());
    expect(outcome.kind).toBe("invalid-dispatch");
    if (outcome.kind === "invalid-dispatch") expect(outcome.evidence).not.toContain("missing rationale");
  });

  it("completes without a dispatch when the production runner finishes cleanly", async () => {
    const outcome = await runChatRoutingTask({ createAgent: agentFactory([], []) }, request());
    expect(outcome.kind).toBe("no-valid-dispatch");
  });

  it("reports a deadline as an attempt-only typed failure after runner settlement", async () => {
    let settled = false;
    const createAgent = (_options: AgentOptions) => {
      const done = Promise.withResolvers<AgentRunResult>();
      return {
        send: () => {}, end: () => {},
        abort: () => { settled = true; done.resolve({ servedRequests: 0, durationMs: 2, terminal: { kind: "interrupted" } }); },
        done: done.promise,
      };
    };
    const error = await runChatRoutingTask({ createAgent }, { ...request(), deadlineMs: 1 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatRoutingFailure);
    if (error instanceof ChatRoutingFailure) expect(error.terminal).toEqual({ kind: "timed-out", timeoutMs: 1 });
    expect(settled).toBe(true);
  });

  it("keeps deadline completion pending until external settlement and background closure", async () => {
    const external = Promise.withResolvers<void>();
    const background = Promise.withResolvers<void>();
    let returned = false;
    const running = runChatRoutingTask({
      createAgent: () => {
        const done = Promise.withResolvers<AgentRunResult>();
        return {
          send: () => {}, end: () => {},
          abort: () => { void external.promise.then(() => done.resolve({ servedRequests: 0, durationMs: 2, terminal: { kind: "interrupted" } })); },
          done: done.promise,
        };
      },
      closeOwnedBackground: () => background.promise,
    }, { ...request(), deadlineMs: 1 }).catch((error: unknown) => { returned = true; return error; });
    await Bun.sleep(5);
    expect(returned).toBe(false);
    external.resolve();
    await Bun.sleep(0);
    expect(returned).toBe(false);
    background.resolve();
    const error = await running;
    expect(error).toBeInstanceOf(ChatRoutingFailure);
    if (error instanceof ChatRoutingFailure) expect(error.terminal).toEqual({ kind: "timed-out", timeoutMs: 1 });
    expect((await runChatRoutingTask({ createAgent: agentFactory([], []) }, request())).kind).toBe("no-valid-dispatch");
  });

  it("reports cancellation as an attempt-only typed failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await runChatRoutingTask({ createAgent: agentFactory([], []) }, { ...request(), signal: controller.signal }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatRoutingFailure);
    if (error instanceof ChatRoutingFailure) expect(error.terminal.kind).toBe("cancelled");
  });

  it("accounts provider errors without retaining credential-shaped messages", async () => {
    const sentinel = "sk-live-DO_NOT_PERSIST_123456";
    const createAgent = (options: AgentOptions) => {
      const done = Promise.withResolvers<AgentRunResult>();
      return {
        send: () => {
          options.onEvent({ type: "model.usage.measured", data: { usage_entry: { attemptId: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "routing-test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.25, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" }, budget_stream_id: "routing-test" } });
          options.onEvent({ type: "model.usage.measured", data: { usage_entry: { attemptId: "00000000-0000-4000-8000-000000000002", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "routing-test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.1, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" }, budget_stream_id: "routing-test" } });
          done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: sentinel, recovery: { kind: "none" } } });
        },
        abort: () => {}, end: () => {}, done: done.promise,
      };
    };
    const error = await runChatRoutingTask({ createAgent }, request()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChatRoutingFailure);
    if (error instanceof ChatRoutingFailure) {
      expect(error.terminal).toEqual({ kind: "provider-error", code: "api-error" });
      expect(error.accounting).toMatchObject({
        estimatedUsd: { kind: "observed", value: 0.35 },
        billedUsd: { kind: "observed", value: 0.35 },
        tokens: { kind: "observed", value: 18 },
        pricedEntryCount: 2,
        unpricedEntryCount: 0,
      });
      expect(JSON.stringify({ attempt: error.terminal, report: error.terminal, stderr: error.message })).not.toContain(sentinel);
    }
  });

  it("keeps missing price unavailable instead of reporting a partial or zero total", async () => {
    const createAgent = (options: AgentOptions) => {
      const done = Promise.withResolvers<AgentRunResult>();
      return {
        send: () => {
          options.onEvent({ type: "model.usage.measured", data: { usage_entry: { attemptId: "00000000-0000-4000-8000-000000000003", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "routing-test", attribution: { kind: "candidate", providerId: "openai_api" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "unavailable", reason: "missing rate card" }, currency: "USD", coverage: "complete" }, budget_stream_id: "routing-test" } });
          done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
        },
        abort: () => {},
        end: () => {},
        done: done.promise,
      };
    };
    const outcome = await runChatRoutingTask({ createAgent }, request());
    expect(outcome.accounting).toMatchObject({
      estimatedUsd: { kind: "unavailable" },
      billedUsd: { kind: "unavailable" },
      tokens: { kind: "observed", value: 3 },
      pricedEntryCount: 0,
      unpricedEntryCount: 1,
    });
    expect(JSON.stringify(outcome)).not.toContain('"value":0');
  });

  it("closes owned background work after the runner settles", async () => {
    let runnerSettled = false;
    let closedAfterSettlement = false;
    await runChatRoutingTask({
      createAgent: (options) => {
        const runner = agentFactory([], [])(options);
        void runner.done.then(() => { runnerSettled = true; });
        return runner;
      },
      closeOwnedBackground: async () => { closedAfterSettlement = runnerSettled; },
    }, request());
    expect(closedAfterSettlement).toBe(true);
  });

  it("requires a finite positive deadline before runner construction", async () => {
    let constructed = false;
    await expect(runChatRoutingTask({ createAgent: (options) => { constructed = true; return agentFactory([], [])(options); } }, { ...request(), deadlineMs: Number.POSITIVE_INFINITY })).rejects.toThrow(/finite positive/);
    expect(constructed).toBe(false);
  });
});
