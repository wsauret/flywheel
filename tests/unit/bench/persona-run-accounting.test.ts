import { describe, expect, it } from "bun:test";
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js";
import type { AgentOptions, AgentRunResult } from "../../../src/orchestration/agent-runtime/types.js";
import {
  PersonaTaskFailure,
  runPersonaTask,
  renderPersonaTaskGuidance,
  type BenchmarkRuntime,
  type PersonaDefinition,
  type PersonaTaskRequest,
} from "../../../src/orchestration/modules/development/benchmark/persona-run.js";
import { fixedDefinitions } from "../../helpers/project-definitions.js";
import type { AgentDefinition } from "../../../src/infra/agent-definition.js";
import { runGroups } from "../../../src/orchestration/modules/development/benchmark/matrix-runner.js";

const PERSONA: PersonaDefinition = {
  kind: "persona",
  name: "explorer",
  description: "Read-only investigation.",
  role: "explorer",
  systemPrompt: "Investigate and hand off.",
  tools: ["read"],
  maxTurns: 4,
};

describe("direct persona benchmark scheduling", () => {
  it("runs lanes concurrently while serializing the durable appends", async () => {
    let active = 0;
    let peakActive = 0;
    let activeAppends = 0;
    let peakAppends = 0;
    const run = async (cell: string): Promise<string> => {
      active++;
      peakActive = Math.max(peakActive, active);
      await Bun.sleep(20);
      active--;
      return cell;
    };
    const persist = async (): Promise<void> => {
      activeAppends++;
      peakAppends = Math.max(peakAppends, activeAppends);
      await Bun.sleep(5);
      activeAppends--;
    };

    await runGroups([["a"], ["b"], ["c"]], run, persist, () => {});

    expect(peakActive).toBe(3);
    expect(peakAppends).toBe(1);
  });

  it("never overlaps two cells from the same lane", async () => {
    const activeLanes = new Set<string>();
    let overlapped = false;
    const started: string[] = [];
    const run = async (cell: string): Promise<string> => {
      const lane = cell.charAt(0);
      if (activeLanes.has(lane)) overlapped = true;
      activeLanes.add(lane);
      started.push(cell);
      await Bun.sleep(5);
      activeLanes.delete(lane);
      return cell;
    };

    await runGroups([["a1", "a2"], ["b1", "b2"]], run, async () => {}, () => {});

    expect(overlapped).toBe(false);
    expect(started.filter((cell) => cell.startsWith("a"))).toEqual(["a1", "a2"]);
    expect(started.filter((cell) => cell.startsWith("b"))).toEqual(["b1", "b2"]);
  });

  it("reports a failed cell without persisting it or stopping the lane", async () => {
    const failures: string[] = [];
    const persisted: string[] = [];
    const run = async (cell: string): Promise<string> => {
      if (cell === "b") throw new Error("cell failed");
      return cell;
    };

    const failed = await runGroups(
      [["a", "b", "c"]],
      run,
      async (_cell, result) => { persisted.push(result); },
      (cell, error) => { failures.push(`${cell}: ${error instanceof Error ? error.message : String(error)}`); },
    );

    expect(failed).toBe(1);
    expect(failures).toEqual(["b: cell failed"]);
    expect(persisted.sort()).toEqual(["a", "c"]);
  });
});

describe("direct persona timeout", () => {
  it("aborts the runner and reports a timeout failure", async () => {
    let aborted = false;
    let runnerOptions: AgentOptions | undefined;
    let sent: unknown;
    let settleDone: (value: AgentRunResult) => void = () => {};
    const done = new Promise<AgentRunResult>((resolveDone) => { settleDone = resolveDone; });
    const started = Promise.withResolvers<void>();
    const deps = runtimeOf((options) => {
      runnerOptions = options;
      started.resolve();
      return { send: (input) => { sent = input; }, abort: () => { aborted = true; }, end: () => {}, done };
    });
    const persona = { kind: "persona", name: "implementer", description: "implement", role: "implementer", systemPrompt: "prompt", tools: [], maxTurns: 1, subagentRoles: ["explorer"] } satisfies PersonaDefinition;
    const registry = new Map<string, AgentDefinition>([["researcher", { kind: "persona", name: "researcher", description: "research", role: "explorer", systemPrompt: "research", tools: [], maxTurns: 1 }]]);

    const outcome = runPersonaTask(deps, { persona, seat: { model: "m", effort: "medium" }, prompt: "do it", label: "implementer/task/0", workspace: process.cwd(), timeoutMs: 20, agentRegistry: registry });
    let outcomeSettled = false;
    void outcome.finally(() => { outcomeSettled = true; }).catch(() => {});
    await started.promise;
    expect(runnerOptions?.toolNames).toEqual(["subagent", "process", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
    expect([...runnerOptions?.allowedSubagentTypes ?? []]).toEqual(["researcher"]);
    expect(runnerOptions?.maxLLMCalls).toBe(persona.maxTurns);

    await Bun.sleep(30);
    expect(String(sent)).toContain("at most 1 turns");
    expect(aborted).toBe(true);
    expect(outcomeSettled).toBe(false);
    settleDone({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
    await expect(outcome).rejects.toThrow("implementer/task/0 timed out after 20 ms");
  });

  it("rejects typed runner failures even after a handoff", async () => {
    const deps = runtimeOf((options) => ({
      send: () => { options.runtimeSurfaces?.handoff?.onContent({ summary: "partial work" }); },
      abort: () => {},
      end: () => {},
      done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error" as const, message: "provider failed", recovery: { kind: "none" } } }),
    }));
    const persona = { kind: "persona", name: "implementer", description: "implement", role: "implementer", systemPrompt: "prompt", tools: [], maxTurns: 1 } satisfies PersonaDefinition;

    await expect(runPersonaTask(deps, { persona, seat: { model: "m", effort: "medium" }, prompt: "do it", label: "implementer/task/failure", workspace: process.cwd() })).rejects.toThrow("implementer/task/failure failed:");
  });
});

interface FakeRunner {
  send: (input: unknown) => void;
  abort: () => void;
  end: () => void;
  done: Promise<Pick<AgentRunResult, "terminal">>;
}

function runtimeOf(createAgent: (options: AgentOptions) => FakeRunner): BenchmarkRuntime {
  return {
    definitions: fixedDefinitions(),
    userDataRoot: join(tmpdir(), "flywheel-persona-run-user"),
    accountHome: tmpdir(),
    profileId: "persona-test",
    moduleSelection: composeFirstPartyModules,
    authorityIncarnation: "persona-test-incarnation",
    runOwnedCommand: async () => { throw new Error("a research cell runs no commands"); },
    createLLMClient: () => { throw new Error("a persona cell creates no judge client"); },
    createAgent: (options) => {
      const runner = createAgent(options);
      return { ...runner, done: runner.done.then((result) => ({ durationMs: 1, servedRequests: 0, ...result })) };
    },
  };
}

/** One committed usage delta, as the runtime publishes it. */
function usageEvent(costUsd: number, inputTokens: number, outputTokens: number, sequence: number) {
  return createRuntimeEvent("model.usage.measured", {
    usage_entry: {
      attemptId: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      occurredAt: "2026-09-02T00:00:00.000Z",
      profileId: "persona-test",
      attribution: { kind: "unattributed" },
      spendMode: "direct_api",
      credentialLineage: "10000000-0000-4000-8000-000000000001",
      model: "model-a",
      tokens: { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      classification: "real_spend",
      price: { kind: "priced", estimatedUsd: costUsd, rateCard: {}, provenance: "test" },
      currency: "USD", coverage: "complete",
    },
    budget_stream_id: "persona-test",
  });
}

function request(signal?: AbortSignal): PersonaTaskRequest {
  return {
    persona: PERSONA,
    seat: { model: "model-a", effort: "medium" },
    prompt: "investigate",
    label: "model-a@medium/task/0",
    workspace: join(tmpdir(), "flywheel-persona-workspace"),
    ...(signal ? { signal } : {}),
  };
}

async function failureOf(runtime: BenchmarkRuntime, signal?: AbortSignal): Promise<PersonaTaskFailure> {
  const error = await runPersonaTask(runtime, request(signal)).then(() => undefined, (reason) => reason);
  if (!(error instanceof PersonaTaskFailure)) throw new Error(`expected a PersonaTaskFailure, got ${String(error)}`);
  return error;
}

describe("persona cell accounting", () => {
  it("keeps direct persona guidance and completed text when dispatch is disabled", async () => {
    let captured: AgentOptions | undefined;
    let sent: unknown;
    const runtime = runtimeOf((options) => {
      captured = options;
      return {
        send: (input) => { sent = input; options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
          type: "model.assistant_message.recorded",
          message: { content: [{ type: "text", text: "Exact completed answer." }] },
        })); },
        abort: () => {},
        end: () => {},
        done: Promise.resolve({ terminal: { kind: "completed" } }),
      };
    });
    const benchmarkRuntime = { ...runtime, moduleSelection: () => composeFirstPartyModules(undefined, ["subagents"]) };
    const outcome = await runPersonaTask(benchmarkRuntime, request());
    expect(outcome.summary).toBe("Exact completed answer.");
    expect(String(sent)).toEndWith(`\n\n${renderPersonaTaskGuidance(PERSONA, new Map(), benchmarkRuntime).task}`);
    expect(captured?.runtimeSurfaces?.handoff?.schema).toBeDefined();
  });

  it("reports the live usage totals of a failed run that completed no turn", async () => {
    const failure = await failureOf(runtimeOf((options) => ({
      send: () => {
        options.onEvent(usageEvent(0.02, 100, 20, 1));
        options.onEvent(usageEvent(0.05, 300, 40, 2));
      },
      abort: () => {},
      end: () => {},
      done: Promise.resolve({ terminal: { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } }),
    })));

    expect(failure.terminal.kind).toBe("failed");
    expect(failure.accounting.accounting.estimatedUsd).toEqual({ kind: "observed", value: 0.07 });
    expect(failure.accounting.accounting.billedUsd).toEqual({ kind: "observed", value: 0.07 });
    expect(failure.accounting.accounting.tokens).toEqual({ kind: "observed", value: 460 });
    expect(failure.accounting.accounting.providers.kind).toBe("unavailable");
  });

  it("runs the trial with its workspace as both the project root and the execution directory", async () => {
    let runnerOptions: AgentOptions | undefined;
    const failure = await failureOf(runtimeOf((options) => {
      runnerOptions = options;
      return {
        send: () => {},
        abort: () => {},
        end: () => {},
        done: Promise.resolve({ terminal: { kind: "api_error", message: "stop", recovery: { kind: "none" } } }),
      };
    }));

    expect(failure.terminal.kind).toBe("failed");
    expect(runnerOptions?.projectRoot).toBe(join(tmpdir(), "flywheel-persona-workspace"));
    expect(runnerOptions?.executionCwd).toBe(join(tmpdir(), "flywheel-persona-workspace"));
  });

  it("keeps the partial usage of a run that was cancelled mid-stream", async () => {
    const controller = new AbortController();
    const failure = await failureOf(runtimeOf((options) => {
      const settled = Promise.withResolvers<Pick<AgentRunResult, "terminal">>();
      return {
        send: () => {
          options.onEvent(usageEvent(0.011, 90, 10, 1));
          controller.abort();
        },
        abort: () => { settled.resolve({ terminal: { kind: "interrupted" } }); },
        end: () => {},
        done: settled.promise,
      };
    }), controller.signal);

    expect(failure.terminal).toEqual({ kind: "cancelled" });
    expect(failure.accounting.accounting.estimatedUsd).toEqual({ kind: "observed", value: 0.011 });
    expect(failure.accounting.accounting.tokens).toEqual({ kind: "observed", value: 100 });
    expect(failure.accounting.accounting.providers.kind).toBe("unavailable");
  });

  it("reports a run that measured nothing as unavailable rather than zero", async () => {
    const failure = await failureOf(runtimeOf(() => ({
      send: () => {},
      abort: () => {},
      end: () => {},
      done: Promise.resolve({ terminal: { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } }),
    })));

    expect(failure.accounting.accounting.estimatedUsd.kind).toBe("unavailable");
    expect(failure.accounting.accounting.tokens.kind).toBe("unavailable");
    expect(failure.accounting.accounting.providers.kind).toBe("unavailable");
  });
});
