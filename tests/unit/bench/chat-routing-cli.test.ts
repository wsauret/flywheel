import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRoutingConfig, executeRoutingBenchmark, main, planRoutingMatrix, ROUTING_FIXTURES, writeChatRoutingFatal } from "../../../bench/ab-persona/chat-routing-bench.js";
import { createRoutingRunStore, type RoutingAttemptRecord, type RoutingConfig, type RoutingRunRecord } from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import { ChatRoutingFailure, chatRoutingGuidance, failureFromTerminal } from "../../../src/orchestration/modules/development/benchmark/chat-routing-run.js";
import { parseVariant } from "../../../src/orchestration/modules/development/benchmark/variant.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import { admitBenchmark } from "../../../src/orchestration/modules/development/benchmark/admission.js";
import { RESEARCH_SNAPSHOT } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import type { AgentOptions, AgentRunResult } from "../../../src/orchestration/agent-runtime/types.js";
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js";
import { publishSkillRevision } from "../../../src/workflows/skill-schema.js";
import { dryRunBenchmarkAdmission, dryRunBenchmarkRuntime } from "../../helpers/benchmark-admission.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

type BenchmarkModelSeat = Parameters<typeof admitBenchmark>[1][number];

const AUTHORITY = { profileId: "profile", authorityIncarnation: "incarnation" };
const ACCOUNTING = unavailableBenchmarkAccounting("no usage");

const config: RoutingConfig = {
  kind: "chat-routing-config", fixtures: [{ id: "fixture", expected: "advisor", prompt: "route" }],
  promptIdentity: "prompt", routingGuidanceIdentity: "guidance", routingGuidance: "generated guidance", scoringVersion: "v1",
  variants: [{ id: "model:medium", model: "model", effort: "medium" }], repeats: 1,
  sourceIdentity: "source", activeProfileCandidatePlan: ["model:medium:chat"], deadlineMs: 100,
  identity: { ...AUTHORITY, contentIdentity: "0".repeat(64) },
};
const run: RoutingRunRecord = {
  kind: "chat-routing-run", variant: "model:medium", fixture: "fixture", repeat: 0,
  model: "model", effort: "medium", durationMs: 1, accounting: ACCOUNTING,
  outcome: { kind: "dispatch", persona: "advisor" },
};

async function absent(path: string): Promise<boolean> {
  return stat(path).then(() => false, () => true);
}

describe("Chat routing benchmark CLI", () => {
  it("keeps the exact six-fixture contract and admits twelve no-spend cells", async () => {
    expect(ROUTING_FIXTURES).toHaveLength(6);
    expect(ROUTING_FIXTURES.filter((fixture) => fixture.expected === "advisor")).toHaveLength(3);
    const matrix = planRoutingMatrix({ variants: [parseVariant("gpt-6.1-sol:medium"), parseVariant("claude-fable-5:low")], repeats: 1 });
    expect(matrix).toHaveLength(12);
    let output = "";
    let disposed = 0;
    let admitted: readonly BenchmarkModelSeat[] = [];
    await main(["--variant", "gpt-6.1-sol:medium", "--variant", "claude-fable-5:low", "--repeats", "1", "--dry-run"], {
      createRuntime: async () => dryRunBenchmarkRuntime(() => { disposed++; }),
      admitModels: async (_deps, seats) => {
        admitted = seats;
        return dryRunBenchmarkAdmission(seats);
      },
      createStore: async () => { throw new Error("store constructed"); },
      createRoutingRegistry: () => new Map(),
      writeOutput: (text) => { output = text; },
    });
    const parsed: unknown = JSON.parse(output);
    expect(parsed).toMatchObject({ dryRun: true, repeats: 1 });
    expect(admitted).toEqual([
      { role: "candidate", model: "gpt-6.1-sol" },
      { role: "candidate", model: "claude-fable-5" },
    ]);
    expect(disposed).toBe(1);
  });

  it("uses the stored profile and matrix for a resume dry-run", async () => {
    const root = temporaryDirectory("chat-routing-dry-resume-");
    const directory = join(root, "result");
    const guidance = chatRoutingGuidance(new Map());
    const stored = createRoutingConfig({ variants: [parseVariant("model:medium")], repeats: 1 }, guidance, AUTHORITY);
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, stored);
    const tornRuns = `${JSON.stringify({ ...run, variant: "model@medium", model: "model", effort: "medium" })}\n{"kind":`;
    await writeFile(join(directory, "runs.jsonl"), tornRuns);
    let selected: typeof AUTHORITY | undefined;
    let output = "";

    await main(["--resume", directory, "--dry-run"], {
      createRuntime: async (_projectRoot, options) => {
        selected = options?.stored;
        return dryRunBenchmarkRuntime(() => {});
      },
      admitModels: async (_deps, seats) => dryRunBenchmarkAdmission(seats),
      createStore: async () => store,
      createRoutingRegistry: () => new Map(),
      writeOutput: (text) => { output = text; },
    });

    expect(selected).toMatchObject(AUTHORITY);
    expect(JSON.parse(output)).toMatchObject({ dryRun: true, cells: 6, variants: [{ id: "model@medium" }] });
    expect(await readFile(join(directory, "runs.jsonl"), "utf8")).toBe(tornRuns);
  });

  it("runs every routing cell in its own snapshot of the pinned corpus, never the live checkout", async () => {
    const root = temporaryDirectory("chat-routing-snapshot-");
    const directory = join(root, "result");
    const stored = createRoutingConfig({ variants: [parseVariant("model:medium")], repeats: 1 }, chatRoutingGuidance(new Map()), AUTHORITY);
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, stored);
    const archives: string[][] = [];
    const runOwnedCommand: OwnedCommandRunner = async (command) => {
      if (command.includes("archive")) archives.push([...command]);
      return { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" };
    };
    const runtime = Object.assign(dryRunBenchmarkRuntime(() => {}), {
      deps: {
        userDataRoot: join(root, "user"), accountHome: join(root, "home"), runOwnedCommand,
        definitions: { skills: () => publishSkillRevision(1, new Map()) }, moduleSelection: () => composeFirstPartyModules(),
      },
    });
    const roots: { projectRoot: string; executionCwd: string; present: boolean }[] = [];
    const createAgent = (options: AgentOptions) => {
      roots.push({ projectRoot: options.projectRoot, executionCwd: options.executionCwd, present: existsSync(options.projectRoot) });
      const done = Promise.withResolvers<AgentRunResult>();
      return {
        send: () => done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
        abort: () => {}, end: () => {}, done: done.promise,
      };
    };
    const exitCode = process.exitCode;
    try {
      await main(["--resume", directory], {
        createRuntime: async () => runtime,
        admitModels: async (_deps, seats) => {
          const admission = dryRunBenchmarkAdmission(seats);
          return { ...admission, runtime: { ...admission.runtime, createAgent } };
        },
        createStore: async () => store,
        createRoutingRegistry: () => new Map(),
        writeOutput: () => {},
      });
    } finally {
      // No candidate dispatches, so the advisor fixtures fail and main marks the process failed.
      // Bun keeps a set exit code when it is assigned undefined, so an unset code restores as 0.
      process.exitCode = exitCode ?? 0;
    }

    expect(archives).toHaveLength(ROUTING_FIXTURES.length);
    for (const archive of archives) {
      expect(archive.slice(archive.indexOf("--format=tar") + 2)).toEqual([RESEARCH_SNAPSHOT.commit, "--", ...RESEARCH_SNAPSHOT.paths]);
    }
    expect(roots).toHaveLength(ROUTING_FIXTURES.length);
    expect(new Set(roots.map(({ projectRoot }) => projectRoot)).size).toBe(ROUTING_FIXTURES.length);
    for (const { projectRoot, executionCwd, present } of roots) {
      expect(executionCwd).toBe(projectRoot);
      expect(projectRoot).not.toBe(resolve(import.meta.dir, "../../.."));
      expect(present).toBe(true);
      expect(await absent(projectRoot)).toBe(true);
    }
  });

  it("rejects resume identity mismatch before runtime and artifact mutation", async () => {
    const root = temporaryDirectory("chat-routing-resume-");
    const directory = join(root, "result");
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, config);
    let runtimeCalls = 0;
    await expect(main(["--resume", directory, "--variant", "other:low"], {
      createRuntime: async () => { runtimeCalls++; throw new Error("runtime constructed"); },
      admitModels: async () => { throw new Error("admission reached"); },
      createStore: async () => store,
      createRoutingRegistry: () => new Map(),
      writeOutput: () => {},
    })).rejects.toThrow(/identity/);
    expect(runtimeCalls).toBe(0);
    expect(await absent(join(directory, "runs.jsonl"))).toBe(true);
    expect(await absent(join(directory, "attempts.jsonl"))).toBe(true);
    expect(await absent(join(directory, "report.json"))).toBe(true);
  });

  it("rejects changed generated routing guidance before runtime construction", async () => {
    const root = temporaryDirectory("chat-routing-guidance-");
    const directory = join(root, "result");
    const variant = parseVariant("model:medium");
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, createRoutingConfig({ variants: [variant], repeats: 1 }, "guidance-one", AUTHORITY));
    let runtimeCalls = 0;
    await expect(main(["--resume", directory], {
      createRuntime: async () => { runtimeCalls++; throw new Error("runtime constructed"); },
      admitModels: async () => { throw new Error("admission reached"); },
      createStore: async () => store,
      createRoutingRegistry: () => new Map([["changed", { kind: "general", name: "changed", description: "guidance-two", maxTurns: 1 }]]),
      writeOutput: () => {},
    })).rejects.toThrow(/identity/);
    expect(runtimeCalls).toBe(0);
    expect(await absent(join(directory, "report.json"))).toBe(true);
  });

  it("rejects duplicate variant IDs before constructing dependencies", async () => {
    let calls = 0;
    await expect(main(["--variant", "model:medium", "--variant", "model:medium", "--dry-run"], {
      createRuntime: async () => { calls++; throw new Error("runtime constructed"); },
      admitModels: async () => { calls++; throw new Error("admission reached"); },
      createStore: async () => { calls++; throw new Error("store constructed"); },
      createRoutingRegistry: () => { calls++; return new Map(); },
      writeOutput: () => {},
    })).rejects.toThrow(/Duplicate/);
    expect(calls).toBe(0);
  });

  it("routing store rejects duplicate completions", async () => {
    const root = temporaryDirectory("chat-routing-duplicate-");
    const store = await createRoutingRunStore({ resultsRoot: root, directory: join(root, "result") }, config);
    await store.appendRun(run);
    await store.appendRun(run);
    await expect(store.loadRuns()).rejects.toThrow(/Duplicate completed/);
  });

  it("rejects duplicate variant IDs in persisted config", async () => {
    const root = temporaryDirectory("chat-routing-config-duplicate-");
    const directory = join(root, "result");
    const duplicate = { ...config, variants: [config.variants[0]!, config.variants[0]!] };
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, duplicate);
    await expect(store.loadConfig()).rejects.toThrow(/Duplicate/);
  });

  it("rejects persisted rows outside the configured matrix before runtime construction", async () => {
    const root = temporaryDirectory("chat-routing-row-validation-");
    const directory = join(root, "result");
    const variant = parseVariant("model:medium");
    const guidance = chatRoutingGuidance(new Map());
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, createRoutingConfig({ variants: [variant], repeats: 1 }, guidance, AUTHORITY));
    await store.appendRun({ ...run, variant: variant.id, model: variant.model, effort: variant.effort, fixture: "unknown" });
    let runtimeCalls = 0;
    await expect(main(["--resume", directory], {
      createRuntime: async () => { runtimeCalls++; throw new Error("runtime constructed"); },
      admitModels: async () => { throw new Error("admission reached"); },
      createStore: async () => store,
      createRoutingRegistry: () => new Map(),
      writeOutput: () => {},
    })).rejects.toThrow(/row/);
    expect(runtimeCalls).toBe(0);
    expect(await absent(join(directory, "report.json"))).toBe(true);
  });

  it("routing store rejects excess fields and malformed non-tail JSONL", async () => {
    const root = temporaryDirectory("chat-routing-strict-");
    const directory = join(root, "result");
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, config);
    await writeFile(join(directory, "runs.jsonl"), `${JSON.stringify({ ...run, excess: true })}\n`);
    await expect(store.loadRuns()).rejects.toThrow();
    await writeFile(join(directory, "runs.jsonl"), `${JSON.stringify(run)}\n{broken}\n${JSON.stringify({ ...run, repeat: 1 })}\n`);
    await expect(store.loadRuns()).rejects.toThrow(/runs\.jsonl:2/);
  });

  it("routing store repairs a torn runs tail but rejects a torn attempts tail", async () => {
    const root = temporaryDirectory("chat-routing-tail-");
    const directory = join(root, "result");
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, config);
    await writeFile(join(directory, "runs.jsonl"), `${JSON.stringify(run)}\n{"kind":`);
    expect(await store.loadRuns()).toEqual([run]);
    expect(await readFile(join(directory, "runs.jsonl"), "utf8")).toBe(`${JSON.stringify(run)}\n`);
    await writeFile(join(directory, "attempts.jsonl"), `{"kind":`);
    await expect(store.loadAttempts()).rejects.toThrow(/attempts\.jsonl:1/);
  });

  it("report storage retains every routing outcome", async () => {
    const root = temporaryDirectory("chat-routing-report-");
    const directory = join(root, "result");
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, config);
    const outcomes: RoutingRunRecord["outcome"][] = [
      { kind: "dispatch", persona: "advisor" },
      { kind: "invalid-dispatch", evidence: "invalid" },
      { kind: "no-valid-dispatch" },
    ];
    for (const [repeat, outcome] of outcomes.entries()) await store.appendRun({ ...run, repeat, outcome });
    expect((await store.loadRuns()).map((row) => row.outcome)).toEqual(outcomes);
  });

  it("reports current resume failures separately from cumulative failed attempts", async () => {
    const root = temporaryDirectory("chat-routing-resume-report-");
    const directory = join(root, "result");
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, config);
    const attempt: RoutingAttemptRecord = {
      kind: "chat-routing-attempt", attemptId: "prior", at: "2026-01-01T00:00:00.000Z",
      variant: run.variant, fixture: run.fixture, repeat: run.repeat, model: run.model, effort: run.effort,
      durationMs: 2, accounting: ACCOUNTING, terminal: { kind: "failed", code: "unexpected-error" },
    };
    await store.appendAttempt(attempt);
    const cell = { seat: config.variants[0]!, routingFixture: config.fixtures[0]!, variant: run.variant, fixture: run.fixture, repeat: run.repeat };
    const result = await executeRoutingBenchmark({ groups: [[cell]], completed: new Set(), fixtures: config.fixtures, store, run: async () => ({ kind: "dispatch", persona: "advisor", durationMs: 1, accounting: ACCOUNTING }) });
    const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    expect(result).toEqual({ currentExecutionFailures: 0, cumulativeFailedAttempts: 1 });
    expect(report).toMatchObject({ currentExecutionFailures: 0, cumulativeFailedAttempts: 1, attempts: [attempt], runs: [{ passed: true }] });
  });

  it("keeps provider and unexpected errors secret-free across durable CLI artifacts and fatal output", async () => {
    const providerSentinel = "api-key-provider-sentinel-value";
    const thrownSentinel = "token-unexpected-credential-sentinel";
    const root = temporaryDirectory("chat-routing-credential-boundary-");
    const directory = join(root, "result");
    const boundaryConfig = { ...config, fixtures: [...config.fixtures, { id: "thrown", expected: "advisor" as const, prompt: "route" }] };
    const store = await createRoutingRunStore({ resultsRoot: root, directory }, boundaryConfig);
    const cells = boundaryConfig.fixtures.map((fixture) => ({ seat: config.variants[0]!, routingFixture: fixture, variant: run.variant, fixture: fixture.id, repeat: 0 }));
    let call = 0;
    await executeRoutingBenchmark({
      groups: cells.map((cell) => [cell]), completed: new Set(), fixtures: boundaryConfig.fixtures, store,
      run: async () => {
        if (call++ === 0) {
          const terminal = failureFromTerminal({ kind: "api_error", message: providerSentinel, recovery: { kind: "none" } });
          if (!terminal) throw new Error("Expected provider failure conversion");
          throw new ChatRoutingFailure(terminal, 1, ACCOUNTING);
        }
        throw new Error(thrownSentinel);
      },
    });
    let fatal = "";
    writeChatRoutingFatal((text) => { fatal = text; });
    const artifacts = `${await readFile(join(directory, "attempts.jsonl"), "utf8")}\n${await readFile(join(directory, "report.json"), "utf8")}\n${fatal}`;
    expect(artifacts).toContain('"code":"api-error"');
    expect(artifacts).toContain('"code":"unexpected-error"');
    expect(fatal).toBe("Chat routing benchmark failed");
    expect(artifacts).not.toContain(providerSentinel);
    expect(artifacts).not.toContain(thrownSentinel);
  });
});
