import { afterEach, describe, expect, it } from "bun:test";
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import type { AgentOptions } from "../../../src/orchestration/agent-runtime/types.js";
import { createBenchmarkCatalog, RESEARCH_SNAPSHOT } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import {
  planPersonaBenchmark,
  runPersonaBenchmark,
  type BenchmarkEvent,
} from "../../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { runGroups } from "../../../src/orchestration/modules/development/benchmark/matrix-runner.js";
import { checkCitations } from "../../../src/orchestration/modules/development/benchmark/research-scoring.js";
import { createPersonaStore as createRunStore } from "../../../src/orchestration/modules/development/benchmark/persona-store.js";
import { parseVariant } from "../../../src/orchestration/modules/development/benchmark/variant.js";
import { loadCampaignRecords } from "../../../src/orchestration/modules/development/benchmark/benchmark-records.js";
import type { BenchmarkRuntime } from "../../../src/orchestration/modules/development/benchmark/persona-run.js";
import { createForegroundBashHoldController } from "../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { runPersonaTask } from "../../../src/orchestration/modules/development/benchmark/persona-run.js";
import { fixedDefinitions } from "../../helpers/project-definitions.js";
import { testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";
import { roleCapture } from "../../helpers/role-capture.js";
import {
  benchmarkDeps as deps,
  EXPLORER_DEFINITION,
  fakeRuntime,
  succeedingCommands,
  TEST_SOURCE_IDENTITY,
  REVIEWER_DEFINITION,
  verdictJudge,
} from "./_persona-benchmark-fixtures.js";

const VARIANTS = [parseVariant("model-a:medium"), parseVariant("model-b:high")];

const projectRoots: string[] = [];

afterEach(async () => {
  for (const root of projectRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function syntheticProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flywheel-persona-benchmark-"));
  projectRoots.push(root);
  await mkdir(join(root, "src", "workflows", "agents", "personas"), { recursive: true });
  await Bun.write(join(root, "src", "workflows", "agents", "personas", "explorer.md"), EXPLORER_DEFINITION);
  return root;
}

describe("persona benchmark service", () => {
  it("passes the benchmark foreground Bash hold into candidate AgentOptions", async () => {
    const hold = createForegroundBashHoldController(() => {});
    let received: AgentOptions | undefined;
    const runtime = {
      ...fakeRuntime((options) => {
        received = options;
        return { terminal: { kind: "completed" } };
      }),
      foregroundBashHold: hold,
    };
    const root = await syntheticProject();
    const persona = {
      kind: "persona",
      name: "explorer",
      description: "Read-only investigation.",
      model: "inherit",
      effort: "medium",
      tools: [],
      requiredSkills: [],
      maxTurns: 1,
      systemPrompt: "Investigate.",
      role: "explorer",
    } as const;

    await runPersonaTask(runtime, {
      persona,
      seat: { model: "model-a", effort: "medium" },
      prompt: "Inspect.",
      label: "hold",
      workspace: root,
    });

    expect(received?.runtimeSurfaces?.foregroundBashHold).toBe(hold);
    hold.dispose();
  });

  it("runs every cell, judges the pairs, and reports one terminal completion", async () => {
    const root = await syntheticProject();
    const events: BenchmarkEvent[] = [];
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, createBenchmarkCatalog(root));
    const outcome = await runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, events));

    if (outcome.status !== "completed") throw new Error(`expected completion, got ${outcome.status}`);
    const cells = plan.tasks.length * VARIANTS.length;
    expect(events.filter((event) => event.kind === "cell.completed")).toHaveLength(cells);
    expect(events.filter((event) => event.kind === "cell.failed")).toHaveLength(0);
    expect(events.at(0)).toEqual({ kind: "benchmark.started", resultsDir: plan.resultsDir, pendingCells: cells });
    expect(events.at(-1)?.kind).toBe("benchmark.completed");
    expect(outcome.counts).toEqual({
      failedJudgeCalls: 0,
      unsuccessfulAttempts: 0,
      unsuccessfulAccounting: { estimatedUsd: { kind: "observed", value: 0 }, billedUsd: { kind: "observed", value: 0 }, tokens: { kind: "observed", value: 0 }, providers: { kind: "observed", value: [] }, pricedEntryCount: 0, unpricedEntryCount: 0 },
      unsuccessfulAccountingUnavailable: 0,
      judgeAccounting: expect.objectContaining({ tokens: { kind: "observed", value: 500 * plan.tasks.length } }),
      judgeAccountingUnavailable: 0,
    });
    expect(outcome.report).toContain("Unsuccessful cell attempts: 0");
    expect(await Bun.file(join(plan.resultsDir, "report.md")).text()).toBe(outcome.report);

    const store = await createRunStore({ resultsRoot: createBenchmarkCatalog(root).resultsRoot, directory: plan.resultsDir });
    expect(await store.loadRuns()).toHaveLength(cells);
    expect(await store.loadAttempts()).toEqual([]);
  });

  it("retains completed candidates with inherited provider options", async () => {
    const root = await syntheticProject();
    const runtime = {
      ...fakeRuntime(async options => {
        await options.resolveRoles?.();
        return { terminal: { kind: "completed" as const } };
      }),
      captureProviderConnection: async () => roleCapture(["gpt-6.1-sol"], {
        reviewer: { model: "gpt-6.1-sol", effort: "high", provider_options: { anthropic: { user_id: "benchmark-user" } } },
      }),
    };
    const plan = await planPersonaBenchmark({ operation: "run", variants: [VARIANTS[0]!], repeats: 1 }, createBenchmarkCatalog(root));
    await runPersonaBenchmark(plan, deps(runtime, root, []));
    const store = await createRunStore({ resultsRoot: createBenchmarkCatalog(root).resultsRoot, directory: plan.resultsDir });
    expect(await store.loadRuns()).toHaveLength(plan.tasks.length);
    expect(await store.loadAttempts()).toEqual([]);
    const events = (await Bun.file(join(plan.resultsDir, "events.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.kind === "cell-roles").map(event => event.roles))
      .toMatchObject(plan.tasks.map(() => ({ reviewer: { model: "gpt-6.1-sol", effort: "high" } })));
    for (const event of events.filter(record => record.kind === "cell-roles")) {
      const roles: { [id: string]: { model: string; effort: string } } = event.roles;
      for (const role of Object.values(roles)) expect(Object.keys(role).sort()).toEqual(["effort", "model"]);
    }
  });

  it("persists a completed candidate before a role record failure", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    const tasks = await catalog.researchTasks("explorer");
    const plan = await planPersonaBenchmark({ operation: "run", variants: [VARIANTS[0]!], repeats: 1, taskIds: [tasks[0]!.id] }, catalog);
    const runtime = fakeRuntime(async () => {
      const cell = join(plan.resultsDir, "cells", VARIANTS[0]!.id, tasks[0]!.id, "0");
      const [attempt] = await readdir(cell);
      await Bun.write(join(cell, attempt!, "roles.json"), "not JSON");
      return { terminal: { kind: "completed" as const } };
    });
    await expect(runPersonaBenchmark(plan, deps(runtime, root, []))).rejects.toThrow();
    const store = await createRunStore({ resultsRoot: catalog.resultsRoot, directory: plan.resultsDir });
    const runs = await store.loadRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.summary).toContain("model-a answered");
    expect(runs[0]?.accounting.tokens.kind).toBe("unavailable");
    expect(await store.loadAttempts()).toEqual([]);
  });

  it("records one judge attempt per call and reports the judge overhead separately", async () => {
    const root = await syntheticProject();
    const events: BenchmarkEvent[] = [];
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, createBenchmarkCatalog(root));
    const outcome = await runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, events));

    if (outcome.status !== "completed") throw new Error(`expected completion, got ${outcome.status}`);
    const store = await createRunStore({ resultsRoot: createBenchmarkCatalog(root).resultsRoot, directory: plan.resultsDir });
    const judgeAttempts = await store.loadJudgeAttempts();
    expect(judgeAttempts).toHaveLength(plan.tasks.length);
    expect(new Set(judgeAttempts.map((attempt) => attempt.attemptId)).size).toBe(judgeAttempts.length);
    expect(judgeAttempts.every((attempt) => attempt.terminal === "completed" && attempt.score.kind === "pair-score")).toBe(true);
    expect(judgeAttempts.every((attempt) => attempt.persona === "explorer" && attempt.mode === "research")).toBe(true);
    // Judge spend is benchmark overhead: it is reported, and it never joins the
    // candidate totals the report compares.
    const { estimatedUsd, billedUsd, tokens } = outcome.counts.judgeAccounting;
    expect(estimatedUsd.kind === "observed" ? estimatedUsd.value : undefined).toBeCloseTo(0.01 * plan.tasks.length, 10);
    expect(billedUsd.kind === "observed" ? billedUsd.value : undefined).toBeCloseTo(0.01 * plan.tasks.length, 10);
    expect(tokens).toEqual({ kind: "observed", value: 500 * plan.tasks.length });
    expect(outcome.counts.judgeAccountingUnavailable).toBe(0);
    expect(outcome.report).toContain("Judge overhead");
  });

  it("records an unsuccessful attempt for a cell that produced no run record", async () => {
    const root = await syntheticProject();
    const events: BenchmarkEvent[] = [];
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, createBenchmarkCatalog(root));
    const runtime = fakeRuntime((options) => ({ terminal: options.model === "model-b" ? { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } : { kind: "completed" } }));

    await expect(runPersonaBenchmark(plan, deps(runtime, root, events))).rejects.toThrow(`${plan.tasks.length} benchmark cells failed`);

    const store = await createRunStore({ resultsRoot: createBenchmarkCatalog(root).resultsRoot, directory: plan.resultsDir });
    const attempts = await store.loadAttempts();
    expect(attempts).toHaveLength(plan.tasks.length);
    expect(attempts.every((attempt) => attempt.variant === "model-b@high" && attempt.persona === "explorer" && attempt.mode === "research")).toBe(true);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(attempts.length);
    const terminal = attempts[0]?.terminal;
    if (terminal?.kind !== "failed") throw new Error(`expected a failed terminal, got ${String(terminal?.kind)}`);
    expect(terminal.message).toContain("provider failed");
    expect(attempts.every((attempt) => attempt.durationMs >= 0)).toBe(true);
    // The fake runner reports no usage, so cost and tokens are unavailable
    // rather than a fabricated zero.
    expect(attempts.every((attempt) => attempt.accounting.estimatedUsd.kind === "unavailable" && attempt.accounting.tokens.kind === "unavailable")).toBe(true);
    expect(attempts.every((attempt) => attempt.accounting.providers.kind === "unavailable")).toBe(true);
    expect(await store.loadRuns()).toHaveLength(plan.tasks.length);
    expect(events.filter((event) => event.kind === "cell.failed")).toHaveLength(plan.tasks.length);
  });

  it("carries the recorded attempts into a resumed run's report", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    const first = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, catalog);
    const failOnB = fakeRuntime((options) => ({ terminal: options.model === "model-b" ? { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } : { kind: "completed" } }));
    await expect(runPersonaBenchmark(first, deps(failOnB, root, []))).rejects.toThrow(/failed/);

    const events: BenchmarkEvent[] = [];
    const resumed = await planPersonaBenchmark({ operation: "resume", resultsDir: first.resultsDir, variants: [] }, catalog);
    const runtime = { ...fakeRuntime(() => ({ terminal: { kind: "completed" } })), profileId: "changed-profile", authorityIncarnation: "changed-incarnation" };
    const outcome = await runPersonaBenchmark(resumed, deps(runtime, root, events));

    if (outcome.status !== "completed") throw new Error(`expected completion, got ${outcome.status}`);
    expect(resumed.stamp).toBe(first.stamp);
    expect(events.at(0)).toEqual({ kind: "benchmark.started", resultsDir: first.resultsDir, pendingCells: resumed.tasks.length });
    expect(outcome.counts.unsuccessfulAttempts).toBe(resumed.tasks.length);
    expect(outcome.report).toContain(`Unsuccessful cell attempts: ${resumed.tasks.length}`);
  });

  it("settles the run it cancelled and records a canceled attempt for every stopped cell", async () => {
    const root = await syntheticProject();
    const events: BenchmarkEvent[] = [];
    const controller = new AbortController();
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, createBenchmarkCatalog(root));
    let judged = false;
    let running = 0;
    let runningAtCancellation: number | undefined;
    let snapshots = 0;
    const runtime: BenchmarkRuntime = {
      definitions: fixedDefinitions(),
      userDataRoot: join(tmpdir(), "flywheel-persona-benchmark-user"),
      accountHome: tmpdir(),
      profileId: "persona-test",
      moduleSelection: composeFirstPartyModules,
      captureRuntimeConfig: testRuntimeConfigCapture,
      authorityIncarnation: "persona-test-incarnation",
      // One cell is stopped while its runner works, and the other while it
      // still extracts its workspace: the stop ends that command as it ends a
      // real one.
      runOwnedCommand: async (command, options) => {
        if (command[0] !== "git" || ++snapshots !== 2) return await succeedingCommands(command, options);
        const signal = options?.signal;
        if (!signal) throw new Error("a benchmark command carries the run's signal");
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw signal.reason;
      },
      createLLMClient: () => { throw new Error("a cancelled run creates no judge client"); },
      createAgent: () => {
        let settleDone: (value: { servedRequests: 0, durationMs: number; terminal: { kind: "interrupted" } }) => void = () => {};
        const done = new Promise<{ servedRequests: 0, durationMs: number; terminal: { kind: "interrupted" } }>((resolve) => { settleDone = resolve; });
        running++;
        return {
          send: () => { controller.abort(); },
          end: () => {},
          // A real runner settles only after its own teardown; the terminal
          // event must wait for that, not for the abort call.
          abort: () => { setTimeout(() => { running--; settleDone({ servedRequests: 0, durationMs: 1, terminal: { kind: "interrupted" } }); }, 5); },
          done,
        };
      },
    };
    const outcome = await runPersonaBenchmark(plan, {
      runtime,
      catalog: createBenchmarkCatalog(root),
      createJudge: async () => ({ complete: async () => { judged = true; return { text: "{}", accounting: unavailableJudgeAccounting("the test judge measured nothing") }; } }),
      judge: { model: "judge-model", effort: "high" },
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "benchmark.cancelled") runningAtCancellation = running;
      },
      signal: controller.signal,
      sourceIdentity: TEST_SOURCE_IDENTITY,
    });

    expect(outcome).toEqual({ status: "cancelled", resultsDir: plan.resultsDir });
    expect(events.at(-1)).toEqual({ kind: "benchmark.cancelled", resultsDir: plan.resultsDir });
    expect(runningAtCancellation).toBe(0);
    expect(events.filter((event) => event.kind === "cell.failed")).toHaveLength(VARIANTS.length);
    expect(judged).toBe(false);
    const store = await createRunStore({ resultsRoot: createBenchmarkCatalog(root).resultsRoot, directory: plan.resultsDir });
    expect(await store.loadRuns()).toEqual([]);
    const attempts = await store.loadAttempts();
    expect(attempts).toHaveLength(VARIANTS.length);
    expect(attempts.every((attempt) => attempt.terminal.kind === "cancelled")).toBe(true);
    expect(attempts.every((attempt) => attempt.task === plan.tasks[0]?.id)).toBe(true);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(VARIANTS.length);
    expect(await Bun.file(join(plan.resultsDir, "report.md")).exists()).toBe(false);
  });

  it("keeps a sibling that completed and cancels only the sibling still running", async () => {
    const root = await syntheticProject();
    const events: BenchmarkEvent[] = [];
    const controller = new AbortController();
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, createBenchmarkCatalog(root));
    const runtime: BenchmarkRuntime = {
      definitions: fixedDefinitions(),
      userDataRoot: join(tmpdir(), "flywheel-persona-benchmark-user"),
      accountHome: tmpdir(),
      profileId: "persona-test",
      moduleSelection: composeFirstPartyModules,
      captureRuntimeConfig: testRuntimeConfigCapture,
      authorityIncarnation: "persona-test-incarnation",
      runOwnedCommand: succeedingCommands,
      createLLMClient: () => { throw new Error("a cancelled run creates no judge client"); },
      createAgent: (options: AgentOptions) => {
        if (options.model === "model-a") {
          return {
            // This seat finishes its work and the stop arrives in the same tick.
            send: () => {
              options.runtimeSurfaces?.handoff?.onContent({ summary: "model-a answered" });
              controller.abort();
            },
            abort: () => {},
            end: () => {},
            done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
          };
        }
        const settled = Promise.withResolvers<{ servedRequests: 0, durationMs: number; terminal: { kind: "interrupted" } }>();
        return {
          send: () => {},
          end: () => {},
          abort: () => { setTimeout(() => settled.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "interrupted" } }), 5); },
          done: settled.promise,
        };
      },
    };

    const outcome = await runPersonaBenchmark(plan, deps(runtime, root, events, controller.signal));

    expect(outcome).toEqual({ status: "cancelled", resultsDir: plan.resultsDir });
    const store = await createRunStore({ resultsRoot: createBenchmarkCatalog(root).resultsRoot, directory: plan.resultsDir });
    expect((await store.loadRuns()).map((run) => run.variant)).toEqual(["model-a@medium"]);
    const attempts = await store.loadAttempts();
    expect(attempts.map((attempt) => [attempt.variant, attempt.terminal.kind])).toEqual([["model-b@high", "cancelled"]]);
  });

  it("refuses a resume whose seats do not match the stored run config", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, catalog);
    const controller = new AbortController();
    controller.abort();
    await runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [], controller.signal));

    await expect(planPersonaBenchmark({ operation: "resume", resultsDir: plan.resultsDir, variants: [parseVariant("model-c:low")] }, catalog))
      .rejects.toThrow(/conflict with --variant arguments/);
    await expect(planPersonaBenchmark({ operation: "resume", resultsDir: plan.resultsDir, variants: [], persona: "implementer" }, catalog))
      .rejects.toThrow(/Results persona explorer conflicts/);
  });

  it("resumes a campaign under another Flywheel source and reports each source that ran cells", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, catalog);
    const failOnB = fakeRuntime((options) => ({ terminal: options.model === "model-b" ? { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } : { kind: "completed" } }));
    await expect(runPersonaBenchmark(plan, { ...deps(failOnB, root, []), sourceIdentity: "a".repeat(64) })).rejects.toThrow(/failed/);

    const resume = await planPersonaBenchmark({ operation: "resume", resultsDir: plan.resultsDir, variants: [] }, catalog);
    const outcome = await runPersonaBenchmark(resume, { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []), sourceIdentity: "b".repeat(64) });

    if (outcome.status !== "completed") throw new Error(`expected completion, got ${outcome.status}`);
    const store = await createRunStore({ resultsRoot: catalog.resultsRoot, directory: plan.resultsDir });
    const runs = await store.loadRuns();
    expect(runs.filter((run) => run.variant === VARIANTS[0]!.id).every((run) => run.sourceIdentity === "a".repeat(64))).toBe(true);
    expect(runs.filter((run) => run.variant === VARIANTS[1]!.id).every((run) => run.sourceIdentity === "b".repeat(64))).toBe(true);
    expect((await store.loadAttempts()).every((attempt) => attempt.sourceIdentity === "a".repeat(64))).toBe(true);
    expect(outcome.report).toContain(`- ${"a".repeat(64)}: ${plan.tasks.length} cells`);
    expect(outcome.report).toContain(`- ${"b".repeat(64)}: ${plan.tasks.length} cells`);
    // The failed run published nothing; the completed resume publishes every cell with the source that ran it.
    const records = await loadCampaignRecords(catalog.recordsFile(plan.persona, plan.stamp));
    expect(records?.cells.map((cell) => cell.sourceIdentity).sort()).toEqual(runs.map((run) => run.sourceIdentity).sort());
  });

  it("rejects changed task content before candidate or judge work", async () => {
    const root = await syntheticProject();
    await Bun.write(join(root, "src", "workflows", "agents", "personas", "reviewer-code-quality.md"), REVIEWER_DEFINITION);
    const fixture = join(root, "bench", "ab-persona", "fixtures", "reviews", "billing-ledger");
    await mkdir(join(fixture, "project"), { recursive: true });
    await Bun.write(join(fixture, "project", "ledger.ts"), "export const total = 1;\n");
    await Bun.write(join(fixture, "diff.patch"), "diff --git a/ledger.ts b/ledger.ts\n");
    await Bun.write(join(fixture, "manifest.json"), JSON.stringify({
      title: "Billing ledger",
      review_prompt_hint: "Read the ledger rounding path",
      defects: [{ id: "rounding-drift", title: "Rounding drift", category: "correctness", files: ["ledger.ts"], catch_criteria: "Names the drift" }],
    }));
    const catalog = createBenchmarkCatalog(root);
    const plan = await planPersonaBenchmark({ persona: "reviewer-code-quality", variants: VARIANTS, repeats: 1, operation: "run" }, catalog);
    await Bun.write(join(fixture, "diff.patch"), "changed after planning\n");
    let candidateCalls = 0;
    let judgeCalls = 0;
    const runtime = fakeRuntime(() => {
      candidateCalls++;
      return { terminal: { kind: "completed" } };
    });
    const benchmarkDeps = {
      ...deps(runtime, root, []),
      createJudge: async () => {
        judgeCalls++;
        return verdictJudge;
      },
    };

    await expect(runPersonaBenchmark(plan, benchmarkDeps)).rejects.toThrow("Benchmark task content changed after planning");
    expect(candidateCalls).toBe(0);
    expect(judgeCalls).toBe(0);
  });

  it("stops every sandbox command it started and stays pending until they settle", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    // A research task archives its pinned snapshot with a sandbox command, so each cell starts one.
    const task = (await catalog.researchTasks("explorer"))[0]!;

    const controller = new AbortController();
    const allStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<OwnedCommandResult>();
    let started = 0;
    let terminated = 0;
    const hangingCommand: OwnedCommandRunner = (_command, options) => {
      options?.signal?.addEventListener("abort", () => { terminated++; });
      started++;
      if (started === VARIANTS.length) allStarted.resolve();
      return release.promise;
    };
    const runtime: BenchmarkRuntime = {
      ...fakeRuntime(() => ({ terminal: { kind: "completed" } })),
      runOwnedCommand: hangingCommand,
    };

    const plan = await planPersonaBenchmark({ persona: "explorer", variants: VARIANTS, repeats: 1, operation: "run", taskIds: [task.id] }, catalog);
    const outcome = runPersonaBenchmark(plan, deps(runtime, root, [], controller.signal));

    await allStarted.promise;
    controller.abort();
    // The stop reaches the container itself, and nothing terminal may land while
    // a command it started is still in flight.
    expect(terminated).toBe(VARIANTS.length);
    expect(await Promise.race([outcome.then(() => "settled"), Bun.sleep(20).then(() => "pending")])).toBe("pending");

    release.resolve({ exitCode: 143, stdoutBytes: new Uint8Array(), stdout: "", stderr: "", timedOut: false });
    expect(await outcome).toEqual({ status: "cancelled", resultsDir: plan.resultsDir });
  });

  it("runs a selected research task with the default solo seat without a judge call", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    const task = (await catalog.researchTasks("explorer"))[0]!;
    const plan = await planPersonaBenchmark({ variants: [], operation: "run", taskIds: [task.id] }, catalog);
    expect(plan.variants).toEqual([{ id: "profile" }]);
    expect(plan.tasks.map(({ id }) => id)).toEqual([task.id]);
    let received: AgentOptions | undefined;
    const commands: string[][] = [];
    const runtime = {
      ...fakeRuntime((options) => {
        received = options;
        return { terminal: { kind: "completed" } };
      }),
      runOwnedCommand: (async (command, options) => {
        commands.push([...command]);
        return succeedingCommands(command, options);
      }) satisfies OwnedCommandRunner,
    };
    const outcome = await runPersonaBenchmark(plan, {
      ...deps(runtime, root, []),
      createJudge: async () => { throw new Error("a solo research cell must not judge"); },
    });
    expect(outcome.status).toBe("completed");
    // The trial reads a pinned snapshot as its whole project, never the live checkout, and the snapshot is gone afterwards.
    const workspace = received?.projectRoot;
    if (!workspace) throw new Error("expected the research cell to run a candidate");
    expect(received?.executionCwd).toBe(workspace);
    expect(workspace).not.toBe(root);
    expect(await readdir(workspace).then(() => true, () => false)).toBe(false);
    const archives = commands.filter((command) => command[0] === "git" && command.includes("archive"));
    expect(archives).toHaveLength(1);
    expect(archives[0]!.slice(archives[0]!.indexOf("--format=tar") + 2)).toEqual([RESEARCH_SNAPSHOT.commit, "--", ...RESEARCH_SNAPSHOT.paths]);
    expect(await Bun.file(join(plan.resultsDir, "campaign.json")).exists()).toBe(true);
    expect(await Bun.file(join(plan.resultsDir, "events.jsonl")).exists()).toBe(true);
    const resumed = await planPersonaBenchmark({ variants: [], operation: "resume", resultsDir: plan.resultsDir }, catalog);
    expect(resumed.variants).toEqual([{ id: "profile" }]);
    const store = await createRunStore({ resultsRoot: catalog.resultsRoot, directory: plan.resultsDir });
    const runs = await store.loadRuns();
    expect(runs).toMatchObject([{ variant: "profile", task: task.id }]);
    expect(runs[0]).not.toHaveProperty("model");
  });
});

describe("research answer keys", () => {
  const answerKey = {
    facts: [
      { id: "start", claim: "The bound starts at the stop item.", catch_criteria: "Names the stop item", files: ["src/a.ts"] },
      { id: "replay", claim: "Buffered events replay in order.", catch_criteria: "Names the replay", files: ["src/a.ts"] },
    ],
    traps: [{ id: "thinking-end", wrong_answer: "The bound starts when thinking ends." }],
  };

  it("checks each distinct citation against exactly one file and line of the pin", () => {
    const lines = new Map([["src/a.ts", 3], ["src/x/index.ts", 9], ["src/y/index.ts", 9]]);
    expect(checkCitations("`/tmp/flywheel-bench-trial-1/src/a.ts:3`, a.ts:2-3, src/a.ts:4, index.ts:1, src/x/index.ts:9, src/a.ts:4", lines)).toEqual({
      total: 5, invalid: ["src/a.ts:4", "index.ts:1"],
    });
    // Only an absolute path loses its leading parts; a relative path keeps every part it states, and a range runs forward from line 1.
    expect(checkCitations("nonexistent/src/a.ts:1, x/index.ts:2, src/a.ts:0, src/a.ts:3-0, src/a.ts:3-2, C:\\trial\\src\\a.ts:1", lines)).toEqual({
      total: 6, invalid: ["nonexistent/src/a.ts:1", "src/a.ts:0", "src/a.ts:3-0", "src/a.ts:3-2"],
    });
  });

  it("reads the complete path of a citation, with filename punctuation and spaces", () => {
    const lines = new Map([["src/a.ts", 3], ["docs/my notes.md", 2]]);
    const text = [
      "invented$/src/a.ts:1, invented+/src/a.ts:1",
      "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\flywheel-bench-trial-X\\src\\a.ts:1",
      "`docs/my notes.md`:2 and \"docs/my notes.md:3\"",
    ].join("\n");
    expect(checkCitations(text, lines)).toEqual({
      total: 5, invalid: ["invented$/src/a.ts:1", "invented+/src/a.ts:1", "docs/my notes.md:3"],
    });
  });

  it("judges a solo seat against the answer key, checks its citations at the pin, and reports both", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    const taskDir = join(catalog.researchTasksDir, "bound");
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({ id: "bound", sandbox: { commit: "b5833f6a4e4458a80e02612cfb5c0729aaaaf267", paths: ["src"] } }));
    await Bun.write(join(taskDir, "prompt.md"), "Where does the bound start?");
    await Bun.write(join(taskDir, "manifest.json"), JSON.stringify(answerKey));
    const runtime: BenchmarkRuntime = {
      ...fakeRuntime(() => ({ terminal: { kind: "completed" } })),
      // The extraction step of each snapshot writes the pinned file the answer cites.
      runOwnedCommand: async (command, options) => {
        if (command[0] === "tar") await Bun.write(join(command[4]!, "src", "a.ts"), "one\ntwo\nthree\n");
        return succeedingCommands(command, options);
      },
      createAgent: (options: AgentOptions) => ({
        send: () => { options.runtimeSurfaces?.handoff?.onContent({ summary: "It starts at the stop item, as in Acmebot:\nC:\\trial\\src\\a.ts:2\nsrc/a.ts:1\nsrc/a.ts:40" }); },
        abort: () => {},
        end: () => {},
        done: Promise.resolve({ durationMs: 1, servedRequests: 0, terminal: { kind: "completed" as const } }),
      }),
    };
    // A harness-name lint in the shape of the maintainer's private one, with an invented name.
    await Bun.write(join(root, "private", "scripts", "check-harness-names.ts"), [
      "const HARNESS_TERMS: readonly RegExp[] = [\n  /acmebot/i,\n];",
      "const WIRE_IDENTIFIERS: readonly RegExp[] = [\n  /ACMEBOT_API_KEY/g,\n];",
      "export function findHarnessNames(): string[] { return []; }",
    ].join("\n\n"));
    const prompts: string[] = [];
    const plan = await planPersonaBenchmark({ variants: [VARIANTS[0]!], operation: "run", taskIds: ["bound"] }, catalog);
    const scoringDeps = {
      ...deps(runtime, root, []),
      createJudge: async () => ({
        complete: async (prompt: string) => {
          prompts.push(prompt);
          return { ...await verdictJudge.complete(prompt, new AbortController().signal), text: `{"caught":["start"],"uncertain":[],"traps_asserted":["thinking-end"]}` };
        },
      }),
    };
    const outcome = await runPersonaBenchmark(plan, scoringDeps);

    if (outcome.status !== "completed") throw new Error(`expected completion, got ${outcome.status}`);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("The bound starts when thinking ends.");
    expect(prompts[0]).not.toContain("src/a.ts\"");
    const scores = (await createRunStore({ resultsRoot: catalog.resultsRoot, directory: plan.resultsDir }).then((store) => store.loadScores()));
    expect(scores).toEqual([{
      kind: "research-score", mode: "research", persona: "explorer", error: null,
      score: { variant: VARIANTS[0]!.id, task: "bound", repeat: 0, caught: ["start"], uncertain: [], trapsAsserted: ["thinking-end"], citations: { total: 3, invalid: ["src/a.ts:40"] } },
    }]);
    expect(outcome.report).toContain(`| bound | ${VARIANTS[0]!.id} | 1 | 1/2 (50.0%) | 0 | 1/1 (100.0%) | 2/3 (66.7%) |`);

    // The completed campaign publishes its record file: header, the cell with its task identity and redacted output, and the score.
    const recordsFile = catalog.recordsFile("explorer", plan.stamp);
    const published = await Bun.file(recordsFile).text();
    const [task] = await catalog.researchTasks("explorer").then((tasks) => tasks.filter(({ id }) => id === "bound"));
    expect(published.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { kind: "campaign", version: 1, persona: "explorer", mode: "research", stamp: plan.stamp, judge: { model: "judge-model", effort: "high" }, scoringVersion: "persona-v2", personaGuidanceIdentity: expect.any(String) },
      expect.objectContaining({ kind: "cell", variant: VARIANTS[0]!.id, task: "bound", taskIdentity: task!.contentIdentity, repeat: 0, sourceIdentity: TEST_SOURCE_IDENTITY, output: { kind: "answer", text: expect.stringContaining("as in another coding agent:") } }),
      { kind: "score", judge: { model: "judge-model", effort: "high" }, scoringVersion: "persona-v2", scorer: "research", score: { variant: VARIANTS[0]!.id, task: "bound", repeat: 0, caught: ["start"], uncertain: [], trapsAsserted: ["thinking-end"], citations: { total: 3, invalid: ["src/a.ts:40"] } } },
    ]);
    // A rescore of the same campaign appends nothing that the file already holds.
    await runPersonaBenchmark(await planPersonaBenchmark({ operation: "rescore", resultsDir: plan.resultsDir, variants: [] }, catalog), scoringDeps);
    expect(await Bun.file(recordsFile).text()).toBe(published);
  });
});

describe("benchmark group ownership", () => {
  it("settles every sibling cell before it reports a failed durable write", async () => {
    const settled: string[] = [];
    const persisted: string[] = [];

    const failed = runGroups(
      [["fast"], ["slow"]],
      async (cell: string) => {
        if (cell === "slow") await Bun.sleep(20);
        settled.push(cell);
        return cell;
      },
      async (cell: string) => {
        if (cell === "fast") throw new Error("runs.jsonl append failed");
        persisted.push(cell);
      },
      () => { throw new Error("no cell of this lane failed"); },
    );

    await expect(failed).rejects.toThrow("runs.jsonl append failed");
    // The write of the first cell failed while its sibling lane was still running:
    // the scheduler owns both, so the sibling ran and was persisted before the
    // retained error surfaced.
    expect(settled).toEqual(["fast", "slow"]);
    expect(persisted).toEqual(["slow"]);
  });
});
