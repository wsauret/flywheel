import { join } from "node:path";
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js";
import { tmpdir } from "node:os";
import type { AgentOptions, AgentRunResult } from "../../../src/orchestration/agent-runtime/types.js";
import type { BenchmarkEvent, PersonaBenchmarkDeps } from "../../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import type { JudgeModel } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import type { BenchmarkRuntime } from "../../../src/orchestration/modules/development/benchmark/persona-run.js";
import type { AttemptRecord } from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { fixedDefinitions } from "../../helpers/project-definitions.js";
import { testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";

export const EXPLORER_DEFINITION = `---
name: explorer
description: Read-only investigation.
role: explorer
tools:
  - read
---
Investigate and hand off.
`;

export const REVIEWER_DEFINITION = `---
name: reviewer-code-quality
description: Reviews code quality.
role: reviewer
tools:
  - read
---
Review and hand off.
`;

/** Every command succeeds and writes nothing, so a commit snapshot extracts an empty workspace. */
export const succeedingCommands: OwnedCommandRunner = async () => ({ exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" });

export const TEST_SOURCE_IDENTITY = "test-source";

/** A runtime whose every cell settles the way `settle` says. */
export function fakeRuntime(settle: (options: AgentOptions) => Pick<AgentRunResult, "terminal"> | Promise<Pick<AgentRunResult, "terminal">>): BenchmarkRuntime {
  return {
    definitions: fixedDefinitions(),
    userDataRoot: join(tmpdir(), "flywheel-persona-benchmark-user"),
    accountHome: tmpdir(),
    profileId: "persona-test",
    moduleSelection: composeFirstPartyModules,
    captureRuntimeConfig: testRuntimeConfigCapture,
    authorityIncarnation: "persona-test-incarnation",
    runOwnedCommand: succeedingCommands,
    createLLMClient: () => { throw new Error("a research cell creates no judge client"); },
    createAgent: (options: AgentOptions) => ({
      send: () => { options.runtimeSurfaces?.handoff?.onContent({ summary: `${options.model} answered` }); },
      abort: () => {},
      end: () => {},
      done: Promise.resolve(settle(options)).then((result) => ({ durationMs: 1, servedRequests: 0, ...result })),
    }),
  };
}

/** A judge that answers every call and reports what the call cost. */
export const verdictJudge: JudgeModel = {
  complete: async () => ({
    text: `{"winner":"A","rationale":"clearer citations"}`,
    accounting: {
      estimatedUsd: { kind: "observed", value: 0.01 },
      billedUsd: { kind: "observed", value: 0.01 },
      tokens: { kind: "observed", value: 500 },
      providers: { kind: "observed", value: ["openai_api"] },
      pricedEntryCount: 1,
      unpricedEntryCount: 0,
    },
  }),
};

export function benchmarkDeps(runtime: BenchmarkRuntime, root: string, events: BenchmarkEvent[], signal?: AbortSignal): PersonaBenchmarkDeps {
  return {
    runtime,
    catalog: createBenchmarkCatalog(root),
    createJudge: async () => verdictJudge,
    judge: { model: "judge-model", effort: "high" },
    onEvent: (event) => events.push(event),
    sourceIdentity: TEST_SOURCE_IDENTITY,
    ...(signal ? { signal } : {}),
  };
}

export function cancelledAttempt(task: string, attemptId: string): AttemptRecord {
  const unavailable = { kind: "unavailable", reason: "the run reported no provider usage" } as const;
  return {
    kind: "agent-run-attempt", attemptId, persona: "explorer", mode: "research", variant: "model-a@medium",
    model: "model-a", effort: "medium", task, repeat: 0, at: "2026-07-31T00-00-05-000Z", durationMs: 1,
    terminal: { kind: "cancelled" },
    accounting: { estimatedUsd: unavailable, billedUsd: unavailable, tokens: unavailable, providers: unavailable, pricedEntryCount: 0, unpricedEntryCount: 0 },
  };
}

export function pairScore(task: string, verdict: { repeat: number; slotA: string; slotB: string; winner: string }) {
  return { kind: "pair-score", mode: "research", persona: "explorer", error: null, verdict: { task, ...verdict, rationale: "clearer citations" } } as const;
}
