import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRunStore } from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import {
  assertSameVariants,
  buildPlanJudgePrompt,
  facetPrompt,
  loadFacetBrief,
  main,
  parseArgs,
  PLAN_TASKS,
  RESEARCH_PROTOCOL_PATH,
  seatFor,
  settleConcurrent,
  strategyVariants,
  STRATEGY_PERSONA,
} from "../../../bench/ab-persona/strategy-bench.js";
import { validateRuns } from "../../../src/orchestration/modules/development/benchmark/persona-evidence-validation.js";
import type { AttemptRecord, ResearchRunRecord, RunConfig } from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import { PersonaTaskFailure, renderPersonaTaskGuidance } from "../../../src/orchestration/modules/development/benchmark/persona-run.js";
import { loadBenchmarkPersona } from "../../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { structuredIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";
import { createBenchmarkCatalog, RESEARCH_SNAPSHOT, RESEARCH_TASKS_CHANGED } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureProviderConnection, type AuthContext } from "../../../src/infra/auth/auth-context.js";
import type { FailoverPlan } from "../../../src/infra/llm/access-provider.js";
import type { AgentOptions } from "../../../src/orchestration/agent-runtime/types.js";
import type { WorkflowDeps } from "../../../src/orchestration/workflow-host/deps.js";
import type { OwnedBenchmarkRuntime } from "../../../bench/shared/runtime.js";
import { createForegroundBashHoldController } from "../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import { createBackgroundExecutionOwner } from "../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work.js";
import type { LauncherScope } from "../../../src/infra/process-supervisor.js";
import { testCapabilityModules, testProviderRegistry } from "../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../helpers/request-tool-surface.js";
import { roleCapture } from "../../helpers/role-capture.js";
import { fakeModelsClient } from "../../helpers/model-tier-fixtures.js";
import { testDirectories } from "../../helpers/directories.js";
import { refusingLauncher } from "../../helpers/launcher-fake.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory.js";
import { captureRuntimeConfigRequest } from "../../../src/orchestration/agent-runtime/request-config.js";
import { CONFIG_DEFAULTS } from "../../../src/orchestration/config/schema.js";
import { authProviders } from "../../helpers/auth-context.js";
import { planEveryCapability } from "../../helpers/attempt-brief.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const STRATEGY_VARIANTS = strategyVariants(seatFor("explorer"));
const FIRST_TASK = PLAN_TASKS[0]!;
const AUTH: AuthContext = {
  providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }),
  credentialLineages: {},
  droppedCredentials: [],
};

interface RuntimeSpy {
  captures: number;
  agents: AgentOptions[];
  storedIdentities: Array<RunConfig["identity"] | undefined>;
  admittedPlans: ReadonlyMap<string, FailoverPlan> | undefined;
  launcher: LauncherScope;
  background: ReturnType<typeof createBackgroundExecutionOwner>;
}

interface FakeRuntimeFixture {
  readonly create: (projectRoot: string, stored?: RunConfig["identity"]) => Promise<OwnedBenchmarkRuntime>;
  readonly spy: RuntimeSpy;
}

function usageEvent(model: string, value: number, sequence: number) {
  return createRuntimeEvent("model.usage.measured", {
    usage_entry: {
      attemptId: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      occurredAt: "2026-09-02T00:00:00.000Z",
      profileId: "strategy-profile",
      attribution: { kind: "unattributed" },
      spendMode: "direct_api",
      credentialLineage: "10000000-0000-4000-8000-000000000001",
      model,
      tokens: { input: value * 10, output: value, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      classification: "real_spend",
      price: { kind: "priced", estimatedUsd: value / 100, rateCard: {}, provenance: "test" },
      currency: "USD", coverage: "complete",
    },
    budget_stream_id: "strategy-profile",
  });
}

function fakeRuntime(options: {
  terminalFor?: (agent: AgentOptions, call: number) => { kind: "completed" } | { kind: "output_overflow" };
  assertIdentity?: (identity: RunConfig["identity"]) => void;
  /** Exit code of the nth `git archive`, the first command of each persona call's snapshot. */
  archiveExitCode?: (archive: number) => number;
} = {}): FakeRuntimeFixture {
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
  const launcher = refusingLauncher;
  const spy: RuntimeSpy = { captures: 0, agents: [], storedIdentities: [], admittedPlans: undefined, launcher, background };
  const directories = testDirectories(REPO_ROOT);
  const definitions = repoDefinitions();
  let archives = 0;
  const create = async (_projectRoot: string, stored?: RunConfig["identity"]): Promise<OwnedBenchmarkRuntime> => {
    spy.storedIdentities.push(stored);
    const deps: WorkflowDeps = {
      ...directories,
      definitions,
      auth: AUTH,
      availableModels: new Map(),
      modelInfos: new Map(),
      modelsClient: fakeModelsClient,
      moduleSelection: testCapabilityModules,
      awaitModelAccessSettled: async () => {},
      resolveEnvSnapshot: async (scope) => ({
        envBlock: scope.executionCwd,
      }),
      captureRuntimeConfig: () => captureRuntimeConfigRequest({
        revision: 0,
        config: CONFIG_DEFAULTS,
        warnings: [],
        diagnostics: [],
        sourceIdentity: "strategy-test",
        status: { kind: "valid" },
      }, "strategy-profile"),
      captureProviderConnection: async () => {
        spy.captures++;
        return {
          providers: testProviderRegistry(),
          connection: captureProviderConnection({ profileId: "strategy-profile", authDir: join(directories.userDataRoot, "auth"), auth: AUTH }),
          runtimeConfig: deps.captureRuntimeConfig(),
          eligibility: roleCapture(["gpt-6-luna", "gpt-6.1-sol"]).eligibility,
          requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), standing: async () => ({ kind: "serves" as const }), admit: (plans: ReadonlyMap<string, FailoverPlan>) => {
            spy.admittedPlans = plans;
            return {
              createAgent: (agent: AgentOptions) => {
                spy.agents.push(agent);
                const call = spy.agents.length;
                return {
                  send: () => {
                    if (agent.model === undefined) throw new Error("Benchmark fixture requires an explicit model");
                    agent.onEvent(usageEvent(agent.model, call, call));
                    agent.onEvent({
                      type: "model.assistant_message.recorded",
                      data: {
                        type: "model.assistant_message.recorded",
                        message: {
                          content: [{ type: "text", text: `${agent.model} result` }],
                          usage: { input_tokens: call * 10 },
                        },
                      },
                    });
                  },
                  abort: () => {},
                  end: () => {},
                  done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: options.terminalFor?.(agent, call) ?? { kind: "completed" as const } }),
                };
              },
              createLLMClient: () => { throw new Error("no provider request may run"); },
            };
          },
        };
      },
      createAgent: () => { throw new Error("only the admitted Agent factory may run"); },
      prepareRequest: () => { throw new Error("a benchmark prepares no pre-start"); },
      planCapabilities: planEveryCapability,
      createLLMClient: () => { throw new Error("no provider request may run"); },
      // Each persona call snapshots the research corpus; by default the snapshot commands succeed and extract nothing.
      runOwnedCommand: async (command) => ({
        exitCode: command.includes("archive") ? options.archiveExitCode?.(++archives) ?? 0 : 0,
        timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "",
      }),
    };
    const foregroundBashHold = createForegroundBashHoldController(() => {});
    return {
      deps,
      profileId: "strategy-profile",
      usageAuthority: { profileId: "strategy-profile", authorityIncarnation: "strategy-incarnation" },
      background,
      foregroundBashHold,
      launcher,
      shell: background.shell,
      runOwnedCommand: deps.runOwnedCommand,
      assertUsageAuthority: options.assertIdentity ?? (() => {}),
      [Symbol.asyncDispose]: async () => {
        await background.close();
        await foregroundBashHold.awaitSettlement();
        foregroundBashHold.dispose();
      },
    };
  };
  return { create, spy };
}

async function strategyConfig(identity: RunConfig["identity"]): Promise<RunConfig> {
  const definitions = repoDefinitions();
  const { persona, registry } = await loadBenchmarkPersona({
    persona: "explorer",
    mode: "research",
    variants: [{ id: "explorer-seat", ...seatFor("explorer") }],
    repeats: 1,
    stamp: "strategy-test",
    resultsDir: "unused",
    operation: "run",
    tasks: [],
  }, createBenchmarkCatalog(REPO_ROOT), { definitions, moduleSelection: testCapabilityModules });
  const taskIdentity = structuredIdentity({ snapshot: RESEARCH_SNAPSHOT, tasks: PLAN_TASKS, facetBrief: await loadFacetBrief() });
  const personaGuidanceIdentity = structuredIdentity([renderPersonaTaskGuidance(persona, registry, { definitions, moduleSelection: testCapabilityModules, captureRuntimeConfig: testRuntimeConfigCapture })]);
  const judgeIdentity = structuredIdentity({ model: "gpt-6.1-sol", template: buildPlanJudgePrompt("__TASK__", "__A__", "__B__") });
  return {
    kind: "benchmark-config",
    persona: STRATEGY_PERSONA,
    mode: "research",
    variants: STRATEGY_VARIANTS,
    repeats: 1,
    stamp: "strategy-test",
    identity: {
      ...identity,
      contentIdentity: structuredIdentity({
        persona: STRATEGY_PERSONA,
        variants: STRATEGY_VARIANTS,
        repeats: 1,
        taskIdentity,
        personaGuidanceIdentity,
        judgeIdentity,
        scoringVersion: "strategy-v1",
      }),
    },
    taskIdentity,
    personaGuidanceIdentity,
    judgeIdentity,
    scoringVersion: "strategy-v1",
    sourceIdentity: STRATEGY_SOURCE,
  };
}

const STRATEGY_SOURCE = "strategy-source";
const strategySource = async () => STRATEGY_SOURCE;

async function storedStrategyRun(root: string): Promise<{ directory: string; store: Awaited<ReturnType<typeof createRunStore>>; config: RunConfig }> {
  const directory = join(root, "strategy-results");
  const config = await strategyConfig({ profileId: "strategy-profile", authorityIncarnation: "strategy-incarnation", contentIdentity: "replaced" });
  const store = await createRunStore({ resultsRoot: root, directory }, config);
  return { directory, store, config };
}

async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(" ")); });
  const error = spyOn(console, "error").mockImplementation((...values: unknown[]) => { errors.push(values.map(String).join(" ")); });
  try {
    return { result: await run(), logs, errors };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

function failedAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  const unavailable = { kind: "unavailable", reason: "test failure" } as const;
  return {
    kind: "agent-run-attempt",
    attemptId: crypto.randomUUID(),
    at: "2026-09-02T00:00:00.000Z",
    persona: STRATEGY_PERSONA,
    mode: "research",
    variant: STRATEGY_VARIANTS[0]!.id,
    model: STRATEGY_VARIANTS[0]!.model,
    effort: STRATEGY_VARIANTS[0]!.effort,
    task: FIRST_TASK.id,
    repeat: 0,
    durationMs: 1,
    terminal: { kind: "failed", message: "test failure" },
    accounting: {
      estimatedUsd: unavailable,
      billedUsd: unavailable,
      tokens: unavailable,
      providers: unavailable,
      pricedEntryCount: 0,
      unpricedEntryCount: 0,
    },
    ...overrides,
  };
}

function researchRun(overrides: Partial<ResearchRunRecord> = {}): ResearchRunRecord {
  return {
    kind: "agent-run",
    mode: "research",
    persona: STRATEGY_PERSONA,
    variant: "explorer-single",
    model: "gpt-6-astra",
    effort: "medium",
    task: FIRST_TASK.id,
    repeat: 0,
    accounting: {
      estimatedUsd: { kind: "observed", value: 0.01 },
      billedUsd: { kind: "observed", value: 0.01 },
      tokens: { kind: "observed", value: 100 },
      providers: { kind: "observed", value: ["openai_api"] },
      pricedEntryCount: 1,
      unpricedEntryCount: 0,
    },
    durationMs: 1000,
    summary: "answer",
    ...overrides,
  };
}

const SEAT = { model: "explorer-model", effort: "medium" as const };

describe("research strategy benchmark", () => {
  it("runs both strategy arms on the one explorer seat", () => {
    expect(strategyVariants(SEAT)).toEqual([
      { id: "explorer-single", ...SEAT },
      { id: "explorer-facets", ...SEAT },
    ]);
  });

  it("fills the research protocol's facet brief with the task's fixed facet and refuses a brief whose placeholders changed", async () => {
    const protocol = await Bun.file(RESEARCH_PROTOCOL_PATH).text();
    const facet = FIRST_TASK.facets[0]!;
    const prompt = facetPrompt(await loadFacetBrief(), FIRST_TASK, facet);
    expect(prompt).toStartWith(`Topic: ${FIRST_TASK.topic}`);
    expect(prompt).toContain(`Research this facet exhaustively: ${facet.description}.`);
    expect(prompt).toContain(`(${facet.find})`);
    expect(prompt).not.toMatch(/<[^>]+>/);
    for (const line of prompt.split("\n")) {
      if (![FIRST_TASK.topic, facet.description, facet.find].some((value) => line.includes(value))) expect(protocol).toContain(line);
    }
    expect(() => facetPrompt("Topic: <topic>", FIRST_TASK, facet)).toThrow("no longer has the placeholder");
  });

  it("rejects stored variants that drifted from the current benchmarked seats", () => {
    const current = strategyVariants(SEAT);
    expect(() => assertSameVariants(current, current)).not.toThrow();
    const drifted = current.map((variant, index) => (index === 1 ? { ...variant, model: "old-model" } : variant));
    expect(() => assertSameVariants(current, drifted)).toThrow("benchmark seats changed since the run started");
  });

  it("validates persisted runs against persona, strategy, task, repeats, and duplicates", () => {
    const plan = {
      persona: STRATEGY_PERSONA,
      mode: "research" as const,
      variants: strategyVariants({ model: "gpt-6-astra", effort: "medium" }),
      repeats: 1,
      tasks: PLAN_TASKS,
    };
    const taskIds = new Set(PLAN_TASKS.map((task) => task.id));
    expect(() => validateRuns(plan, taskIds, [researchRun()])).not.toThrow();
    expect(() => validateRuns(plan, taskIds, [researchRun({ persona: "explorer" })])).toThrow("belongs to explorer/research");
    expect(() => validateRuns(plan, taskIds, [researchRun({ variant: "unknown" })])).toThrow("conflicts with the configured variants");
    expect(() => validateRuns(plan, taskIds, [researchRun({ model: "wrong-model" })])).toThrow("conflicts with the configured variants");
    expect(() => validateRuns(plan, taskIds, [researchRun({ effort: "high" })])).toThrow("conflicts with the configured variants");
    expect(() => validateRuns(plan, taskIds, [researchRun({ task: "missing" })])).toThrow("unknown task");
    expect(() => validateRuns(plan, taskIds, [researchRun({ repeat: 1 })])).toThrow("exceeds configured repeats");
    expect(() => validateRuns(plan, taskIds, [researchRun(), researchRun()])).toThrow("Duplicate run record");
  });

  it("judges plan briefs for planner coverage, not Q&A concision", () => {
    const prompt = buildPlanJudgePrompt("add budgets", "brief a", "brief b");
    expect(prompt).toContain("about to plan the change");
    expect(prompt).toContain("Judge coverage first");
    expect(prompt).toContain("## BRIEF A");
    expect(prompt).toContain("brief b");
    expect(prompt).toContain(`{"winner":"A"|"B"|"tie"`);
  });

  it("inherits repeats from a stored config on resume and rejects conflicts and foreign campaigns", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-strategy-bench-test-"));
    try {
      const storedConfig = (persona: string) => ({
        kind: "benchmark-config" as const,
        persona,
        mode: "research" as const,
        variants: [{ id: "explorer-single", model: "m", effort: "medium" as const }],
        repeats: 2,
        stamp: "stamp",
        identity: { profileId: "test", authorityIncarnation: "test-incarnation", contentIdentity: "0".repeat(64) },
        taskIdentity: "tasks",
        personaGuidanceIdentity: "guidance",
        judgeIdentity: "judge",
        scoringVersion: "strategy-v1",
      });
      const dir = join(root, "strategy");
      await createRunStore({ resultsRoot: root, directory: dir }, storedConfig(STRATEGY_PERSONA));
      const resumed = await parseArgs(["--resume", dir]);
      expect(resumed.repeats).toBe(2);
      await expect(parseArgs(["--rescore", dir, "--repeats", "3"])).rejects.toThrow("Results repeats 2 conflict with --repeats 3");
      const foreign = join(root, "foreign");
      await createRunStore({ resultsRoot: root, directory: foreign }, storedConfig("plan-research-strategy"));
      await expect(parseArgs(["--resume", foreign])).rejects.toThrow("Results persona plan-research-strategy is not a strategy benchmark");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("strategy main", () => {
  it("passes stored identity to runtime creation and rejects resume and rescore identity drift before Agent creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-strategy-main-"));
    try {
      const { directory, config } = await storedStrategyRun(root);
      for (const operation of ["--resume", "--rescore"] as const) {
        const { create, spy } = fakeRuntime({ assertIdentity: () => { throw new Error("runtime identity drift"); } });
        await expect(captureConsole(() => main([operation, directory], create, strategySource))).rejects.toThrow("runtime identity drift");
        expect(spy.storedIdentities).toEqual([config.identity]);
        expect(spy.captures).toBe(0);
        expect(spy.agents).toHaveLength(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("dry-runs one provider capture for every strategy seat and the judge without creating an Agent or result directory", async () => {
    const { create, spy } = fakeRuntime();
    const { logs } = await captureConsole(() => main(["--dry-run"], create, strategySource));
    const report: unknown = JSON.parse(logs.join("\n"));
    if (typeof report !== "object" || report === null || !("providerPlans" in report) || !("resultsDir" in report)) {
      throw new Error("Expected a dry-run report");
    }
    const providerPlans = report.providerPlans;
    if (!Array.isArray(providerPlans) || typeof report.resultsDir !== "string") throw new Error("Expected provider plans and a results directory");
    if (!("cells" in report) || !("variants" in report) || !("matrix" in report) || !Array.isArray(report.matrix)) throw new Error("Expected the matrix summary");

    expect(report.variants).toEqual(STRATEGY_VARIANTS.map((variant) => variant.id));
    expect(report.cells).toBe(report.matrix.length);
    expect(spy.captures).toBe(1);
    expect(providerPlans.map((plan) => typeof plan === "object" && plan !== null && "model" in plan ? plan.model : undefined)).toEqual([
      seatFor("explorer").model,
      "gpt-6.1-sol",
    ]);
    expect(spy.agents).toHaveLength(0);
    expect(await Bun.file(join(report.resultsDir, "config.json")).exists()).toBe(false);
  });

  it("forwards the runtime launcher, background owner, and shell to the first explorer facet", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-strategy-main-"));
    try {
      const { directory, store } = await storedStrategyRun(root);
      await store.appendRun(researchRun({
        variant: STRATEGY_VARIANTS[0]!.id,
        model: STRATEGY_VARIANTS[0]!.model,
        effort: STRATEGY_VARIANTS[0]!.effort,
      }));
      const { create, spy } = fakeRuntime({
        terminalFor: (_agent, call) => call === 2
          ? { kind: "output_overflow" }
          : { kind: "completed" },
      });

      await expect(captureConsole(() => main(["--resume", directory], create, strategySource))).rejects.toThrow();

      const facet = spy.agents[0];
      // Every persona call reads its own snapshot of the pinned corpus as its whole project, never the live checkout.
      expect(facet?.projectRoot).toBe(facet?.executionCwd);
      expect(facet?.projectRoot).not.toBe(REPO_ROOT);
      expect(facet?.runtimeSurfaces?.launcher).toBe(spy.launcher);
      expect(facet?.runtimeSurfaces?.background).toBe(spy.background);
      expect(facet?.runtimeSurfaces?.shell).toBe(spy.background.shell);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to resume candidates under a source the campaign did not record", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-strategy-main-"));
    try {
      const { directory } = await storedStrategyRun(root);
      const { create, spy } = fakeRuntime();
      await expect(captureConsole(() => main(["--resume", directory], create, async () => "other-source")))
        .rejects.toThrow("Flywheel source changed since this campaign started (campaign strategy-sou, running other-source)");
      expect(spy.agents).toHaveLength(0);

      // A campaign whose tasks predate the corpus pin is read-only evidence: even a rescore refuses.
      const configPath = join(directory, "run-config.json");
      await Bun.write(configPath, JSON.stringify({ ...await Bun.file(configPath).json(), taskIdentity: structuredIdentity({ tasks: PLAN_TASKS }) }));
      await expect(captureConsole(() => main(["--rescore", directory], create, strategySource))).rejects.toThrow(RESEARCH_TASKS_CHANGED);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed attempt and judge-attempt ledgers before candidate or judge invocation", async () => {
    for (const ledger of ["attempt", "judge-attempt"] as const) {
      const root = await mkdtemp(join(tmpdir(), "flywheel-strategy-main-"));
      try {
        const { directory, store } = await storedStrategyRun(root);
        if (ledger === "attempt") {
          await store.appendAttempt(failedAttempt({ model: "wrong-model" }));
        } else {
          await store.appendJudgeAttempt({
            kind: "judge-attempt",
            attemptId: crypto.randomUUID(),
            at: "2026-09-02T00:00:00.000Z",
            persona: STRATEGY_PERSONA,
            mode: "research",
            score: { kind: "review-score", variant: STRATEGY_VARIANTS[0]!.id, task: FIRST_TASK.id, repeat: 0 },
            terminal: "completed",
            accounting: failedAttempt().accounting,
          });
        }
        const { create, spy } = fakeRuntime();

        await expect(captureConsole(() => main(["--resume", directory], create, strategySource))).rejects.toThrow(
          ledger === "attempt" ? "conflicts with the configured variants" : "review-score, which is not valid for research mode",
        );
        expect(spy.agents).toHaveLength(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("records one combined facets attempt when one explorer facet fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "flywheel-strategy-main-"));
    try {
      const { directory, store } = await storedStrategyRun(root);
      await store.appendRun(researchRun({
        variant: STRATEGY_VARIANTS[0]!.id,
        model: STRATEGY_VARIANTS[0]!.model,
        effort: STRATEGY_VARIANTS[0]!.effort,
      }));
      const { create, spy } = fakeRuntime({
        terminalFor: (_agent, call) => call === 2
          ? { kind: "output_overflow" }
          : { kind: "completed" },
      });

      await expect(captureConsole(() => main(["--resume", directory], create, strategySource))).rejects.toThrow();

      // Every sibling facet settles before the failure is recorded, so the attempt carries all four runs.
      expect(spy.agents.map((agent) => agent.model)).toEqual(FIRST_TASK.facets.map(() => seatFor("explorer").model));
      const attempts = await store.loadAttempts();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        variant: "explorer-facets",
        model: seatFor("explorer").model,
        accounting: {
          tokens: { kind: "observed", value: 110 },
          pricedEntryCount: 4,
        },
      });
      expect(attempts[0]?.accounting.estimatedUsd.kind === "observed" ? attempts[0].accounting.estimatedUsd.value : undefined).toBeCloseTo(0.1);

      // One facet's snapshot fails before its run: the attempt keeps the other facets' spend and marks the rest unavailable.
      const snapshotFailure = fakeRuntime({ archiveExitCode: (archive) => archive === 2 ? 128 : 0 });
      await expect(captureConsole(() => main(["--resume", directory], snapshotFailure.create, strategySource))).rejects.toThrow("exit code 128");
      expect(snapshotFailure.spy.agents).toHaveLength(FIRST_TASK.facets.length - 1);
      const [, snapshotAttempt] = await store.loadAttempts();
      expect(snapshotAttempt).toMatchObject({
        variant: "explorer-facets",
        terminal: { kind: "failed" },
        accounting: { estimatedUsd: { kind: "unavailable" }, pricedEntryCount: FIRST_TASK.facets.length - 1 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("strategy concurrency settlement", () => {
  it("waits for sibling branches before propagating a failure", async () => {
    const accounting = researchRun().accounting;
    const sibling = Promise.withResolvers<{ accounting: typeof accounting; durationMs: number; summary: string }>();
    const failure = new Error("facet failed");
    const result = settleConcurrent([Promise.reject(failure), sibling.promise]);
    let observed: unknown;
    void result.catch((error) => { observed = error; });

    await Bun.sleep(1);
    expect(observed).toBeUndefined();
    sibling.resolve({ accounting, durationMs: 1, summary: "done" });
    await expect(result).rejects.toBe(failure);
  });

  it("combines fulfilled and failed facet accounting after every branch settles", async () => {
    const observed = (value: number) => ({
      estimatedUsd: { kind: "observed" as const, value },
      billedUsd: { kind: "observed" as const, value },
      tokens: { kind: "observed" as const, value: value * 1000 },
      providers: { kind: "observed" as const, value: ["openai_api"] },
      pricedEntryCount: 1,
      unpricedEntryCount: 0,
    });
    const failure = new PersonaTaskFailure(
      { kind: "failed", message: "facet failed" },
      { durationMs: 7, accounting: observed(0.02) },
      "facet failed",
    );

    const result = settleConcurrent([
      Promise.resolve({ accounting: observed(0.01), durationMs: 5, summary: "facet one" }),
      Promise.reject(failure),
    ]);
    const combined = await result.then(() => undefined, (error) => error);

    expect(combined).toBeInstanceOf(PersonaTaskFailure);
    if (!(combined instanceof PersonaTaskFailure)) throw new Error("Expected a PersonaTaskFailure");
    expect(combined.accounting.durationMs).toBe(12);
    expect(combined.accounting.accounting.estimatedUsd).toEqual({ kind: "observed", value: 0.03 });
    expect(combined.accounting.accounting.tokens).toEqual({ kind: "observed", value: 30 });
    expect(combined.accounting.accounting.pricedEntryCount).toBe(2);

    // A lower-bound facet keeps every exact facet's amount in the bound.
    const lowerBound = { ...observed(2), estimatedUsd: { kind: "unavailable" as const, reason: "attempt b reported no usage", atLeast: 2 }, tokens: { kind: "unavailable" as const, reason: "attempt b reported no usage", atLeast: 200 } };
    const unknown = { ...observed(0), estimatedUsd: { kind: "unavailable" as const, reason: "no committed usage" }, tokens: { kind: "unavailable" as const, reason: "no committed usage" } };
    const bounded = await settleConcurrent([
      Promise.resolve({ accounting: { ...observed(1), tokens: { kind: "observed" as const, value: 100 } }, durationMs: 1, summary: "exact" }),
      Promise.reject(new PersonaTaskFailure({ kind: "failed", message: "facet failed" }, { durationMs: 1, accounting: lowerBound }, "facet failed")),
      Promise.reject(new PersonaTaskFailure({ kind: "failed", message: "facet failed" }, { durationMs: 1, accounting: unknown }, "facet failed")),
    ]).then(() => undefined, (error) => error);
    if (!(bounded instanceof PersonaTaskFailure)) throw new Error("Expected a PersonaTaskFailure");
    expect(bounded.accounting.accounting.estimatedUsd).toEqual({ kind: "unavailable", reason: "attempt b reported no usage; no committed usage", atLeast: 3 });
    expect(bounded.accounting.accounting.tokens).toEqual({ kind: "unavailable", reason: "attempt b reported no usage; no committed usage", atLeast: 300 });
    expect(bounded.accounting.accounting.billedUsd).toEqual({ kind: "observed", value: 3 });

    // With no facet stating an amount, the combined total has no lower bound.
    const none = await settleConcurrent([
      Promise.reject(new PersonaTaskFailure({ kind: "failed", message: "facet failed" }, { durationMs: 1, accounting: unknown }, "facet failed")),
    ]).then(() => undefined, (error) => error);
    if (!(none instanceof PersonaTaskFailure)) throw new Error("Expected a PersonaTaskFailure");
    expect(none.accounting.accounting.estimatedUsd).toEqual({ kind: "unavailable", reason: "no committed usage" });
  });
});
