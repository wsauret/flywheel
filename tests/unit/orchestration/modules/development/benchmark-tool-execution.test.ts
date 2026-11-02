/**
 * The benchmark tool as an agent sees it, driven through the real exposure
 * planner and the real background execution owner, with every provider
 * operation faked.
 *
 * No test here may issue a paid provider request: the admitted factories build
 * fake candidate runners and a fake judge client, and the account state is a
 * capture whose secrets are Redacted sentinels. A cell that reached a real
 * provider would have to build a client this harness never provides.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";

import { captureProviderConnection, type AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import { createBackgroundExecutionOwner, type BackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { BenchmarkAdmissionDeps } from "../../../../../src/orchestration/modules/development/benchmark/admission.js";
import { createPersonaStore as createRunStore } from "../../../../../src/orchestration/modules/development/benchmark/persona-store.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import type { RuntimeTool, ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { testProviderEligibility } from "../../../../helpers/provider-authority.js";
import type { Agent, AgentRunResult, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js";
import { isRecord, type UnknownRecord } from "../../../../../src/infra/record.js";
import { fixedDefinitions } from "../../../../helpers/project-definitions.js";
import { makeContext } from "../../agent-runtime/tools/_fixtures.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../../../src/orchestration/modules.js";
import { DEVELOPMENT_MODULES } from "../../../../../src/orchestration/development-modules.js";
import { withRequestAdmission } from "../../agent-runtime/_model-client.js";
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js";
import { testKernelToolDeps, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";

import { accessProviderRegistry } from "../../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { authProviders } from "../../../../helpers/auth-context.js";
const { userDataRoot, accountHome } = testDirectories(process.cwd());
const PERSONA_SOURCE = join(process.cwd(), "src", "workflows", "agents", "personas", "explorer.md");
const SOURCE_MODULES = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES];
const sourceModuleSelection = () => composeFirstPartyModules(SOURCE_MODULES);

/** The one secret the harness owns. It exists only as a Redacted sentinel. */
const SECRET = Redacted.make("benchmark-harness-secret");

/** Anthropic, OpenAI and OpenRouter keys are configured, and no subscription
 *  is. Each model below is therefore served by its native API first and by the
 *  OpenRouter aggregator last, which is the order a chain must report. */
const AUTH: AuthContext = {
  providers: authProviders({ apiKeys: { anthropic_api: SECRET, openai_api: SECRET, openrouter: SECRET } }),
  credentialLineages: {}, droppedCredentials: [],
};

const SEATS = [
  { model: "claude-opus-5", effort: "medium" },
  { model: "gpt-6-astra", effort: "high" },
];

/** How a candidate cell settles. A "blocks" cell runs until it is aborted, so a
 *  stop can land while it is in flight; a "completes" cell hands off at once,
 *  which is what a run that reaches scoring needs. */
type CellBehavior = "blocks" | "completes";
const judgeReleases: (() => void)[] = [];
const owners: BackgroundExecutionOwner[] = [];

class FakeCellRunner implements Agent {
  aborted = false;
  settled = false;
  readonly done: Promise<AgentRunResult>;
  readonly #settle: (result: AgentRunResult) => void;
  readonly #behavior: CellBehavior;
  readonly #judgeState?: HarnessState;
  readonly #judgeRelease?: Promise<void>;

  constructor(readonly options: AgentOptions, behavior: CellBehavior, judgeState?: HarnessState, judgeRelease?: Promise<void>) {
    const resolvers = Promise.withResolvers<AgentRunResult>();
    this.done = resolvers.promise;
    this.#settle = resolvers.resolve;
    this.#behavior = behavior;
    this.#judgeState = judgeState;
    this.#judgeRelease = judgeRelease;
  }

  send(): void {
    const judgeState = this.#judgeState;
    const judgeRelease = this.#judgeRelease;
    if (this.options.purpose.kind === "headless-task" && (this.options.toolNames?.length ?? 0) === 0 && judgeState && judgeRelease) {
      judgeState.judgeStarted++;
      void judgeRelease.then(() => {
        judgeState.judgeCompletions++;
        this.options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
          type: "model.assistant_message.recorded",
          message: { content: [{ type: "text", text: '{"winner":"tie","rationale":"fake judge"}' }] },
        }));
        this.settled = true;
        this.#settle({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
      });
      return;
    }
    if (this.#behavior === "blocks") return;
    this.options.runtimeSurfaces?.handoff?.onContent({ summary: `${String(this.options.model)} answered` });
    this.settled = true;
    this.#settle({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
  }

  end(): void {}

  abort(): void {
    this.aborted = true;
    if (this.options.purpose.kind === "headless-task") return;
    setTimeout(() => {
      this.settled = true;
      this.#settle({ servedRequests: 0, durationMs: 1, terminal: { kind: "interrupted" } });
    }, 5);
  }
}

/** What the run built, so a test can prove what it did not build. */
interface HarnessState {
  captures: number;
  admittedModels: readonly string[];
  runners: FakeCellRunner[];
  clientBuilds: string[];
  judgeStarted: number;
  judgeCompletions: number;
  /** Every judge call waits for this, so a test decides when one settles. */
  releaseJudge: () => void;
}


function harness(cells: CellBehavior = "blocks") {
  const judge = Promise.withResolvers<void>();
  judgeReleases.push(() => judge.resolve());
  const state: HarnessState = {
    captures: 0,
    admittedModels: [],
    runners: [],
    clientBuilds: [],
    judgeStarted: 0,
    judgeCompletions: 0,
    releaseJudge: () => judge.resolve(),
  };
  const deps: BenchmarkAdmissionDeps = {
    userDataRoot,
    accountHome,
    profileId: "test",
    authorityIncarnation: "test-incarnation",
    definitions: fixedDefinitions(),
    moduleSelection: sourceModuleSelection,
    // Only a research cell's snapshot of the pinned corpus runs commands here, as no-ops: an archive and its extraction.
    runOwnedCommand: async (command) => {
      if (!(command[0] === "git" && command.includes("archive")) && command[0] !== "tar") throw new Error("no other command may be launched in this harness");
      return { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" };
    },
    captureProviderConnection: async () => {
      state.captures++;
      const eligibility = testProviderEligibility();
      return {
        connection: captureProviderConnection({ profileId: "test", authDir: join(userDataRoot, "auth"), auth: AUTH }),
        providers: accessProviderRegistry(composeFirstPartyModules()),
        runtimeConfig: testRuntimeConfigCapture(),
        eligibility: {
          ...eligibility,
          candidateOffering: (candidate, model, allowTrainingRoutes) => {
            const anthropicModel = model.startsWith("claude-");
            if (candidate.providerId === "anthropic_api" && !anthropicModel) return undefined;
            if (candidate.providerId === "openai_api" && anthropicModel) return undefined;
            return eligibility.candidateOffering?.(candidate, model, allowTrainingRoutes);
          },
        },
        admit: (plans) => {
          state.admittedModels = [...plans.keys()];
          return {
            createAgent: (options) => {
              const runner = new FakeCellRunner(options, cells, state, judge.promise);
              state.runners.push(runner);
              return runner;
            },
            createLLMClient: (model) => {
              state.clientBuilds.push(model);
              return Promise.resolve(withRequestAdmission({
                model,
                modelFamily: "openai",
                plannedAttempt: () => { throw new Error("judge clients run through the fake agent"); },
                streamWithTools: () => { throw new Error("judge clients run through the fake agent"); },
              }));
            },
          };
        },
      };
    },
  };
  return { deps, state };
}

interface Background {
  owner: BackgroundExecutionOwner;
  notifications: string[];
  firstNotification: Promise<string>;
}

function background(): Background {
  const notifications: string[] = [];
  const notified = Promise.withResolvers<string>();
  const owner = createBackgroundExecutionOwner(createBackgroundWorkRegistry({
    kind: "chat",
    enqueueNotification: (text) => {
      notifications.push(text);
      notified.resolve(text);
    },
  }));
  owners.push(owner);
  return { owner, notifications, firstNotification: notified.promise };
}

/** The tool exactly as a turn gets it: constructed by the production planner
 *  from the deps a host wires, never by calling the factory directly. The
 *  development module's runtime carries the benchmark deps as one member
 *  beside the simulator tool, which this harness leaves unwired. */
async function plannedBenchmarkTool(deps: BenchmarkAdmissionDeps, owner: BackgroundExecutionOwner): Promise<RuntimeTool> {
  const plan = await planToolExposure({
    kernel: testKernelToolDeps({ userDataRoot, backgroundTasks: owner.tasks, capabilities: { available: () => true }, moduleSnapshot: sourceModuleSelection() }),
    modules: composeModuleRuntimes([["development", { benchmark: deps }]]),
    selected: new Set(["benchmark"]),
  });
  const tool = plan.tools.get("benchmark");
  if (!tool) throw new Error(`the planner omitted benchmark: ${JSON.stringify(plan.omitted)}`);
  return tool;
}

function toolContext(projectRoot: string, owner: BackgroundExecutionOwner): ToolContext {
  return makeContext({
    projectRoot,
    executionCwd: projectRoot,
    toolUseId: "tc_bench",
    backgroundTasks: owner.tasks,
    backgroundSignal: owner.signal,
  });
}

/** The JSON object a value holds; throws when it is anything else. */
function record(value: unknown): UnknownRecord {
  if (!isRecord(value)) throw new Error(`expected a JSON object, got ${JSON.stringify(value)}`);
  return value;
}

function launchReport(content: string): UnknownRecord {
  return record(JSON.parse(content));
}

function notificationBody(notification: string): UnknownRecord {
  const body = notification.split("<result>")[1]?.split("</result>")[0] ?? "";
  return record(JSON.parse(body));
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const roots: string[] = [];

async function benchmarkedProject(withPersona = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flywheel-benchmark-harness-"));
  roots.push(root);
  if (withPersona) {
    const personas = join(root, "src", "workflows", "agents", "personas");
    await mkdir(personas, { recursive: true });
    await cp(PERSONA_SOURCE, join(personas, "explorer.md"));
  }
  return root;
}

afterEach(async () => {
  for (const release of judgeReleases.splice(0)) release();
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("benchmark tool action surface", () => {
  it("advertises exactly the documented camelCase inputs", async () => {
    const { deps } = harness();
    const { owner } = background();
    const tool = await plannedBenchmarkTool(deps, owner);

    expect(tool.action).toBe("benchmark_run");
    const schema = tool.inputSchema;
    const properties = record(schema.properties);
    expect(Object.keys(properties)).toEqual(["action", "persona", "variants", "repeats", "dryRun", "resultId"]);
    expect(schema.required).toEqual(["action", "dryRun"]);
    expect(schema.additionalProperties).toBe(false);
    expect(record(properties.action).enum).toEqual(["run", "resume"]);
    expect(record(properties.dryRun).type).toBe("boolean");
    expect(record(properties.resultId).type).toBe("string");
    expect(record(properties.repeats).type).toBe("integer");
    const seat = record(record(properties.variants).items);
    expect(Object.keys(record(seat.properties))).toEqual(["model", "effort"]);
    expect(seat.required).toEqual(["model", "effort"]);
    expect(seat.additionalProperties).toBe(false);
    await owner.close();
  });

  it("advertises the same schema whatever else the host wired", async () => {
    const first = harness();
    const second = harness();
    const firstBackground = background();
    const secondBackground = background();

    const one = await plannedBenchmarkTool(first.deps, firstBackground.owner);
    const two = await plannedBenchmarkTool(second.deps, secondBackground.owner);

    expect(JSON.stringify(two.inputSchema)).toBe(JSON.stringify(one.inputSchema));
    await firstBackground.owner.close();
    await secondBackground.owner.close();
  });
});

describe("benchmark tool dry run", () => {
  it("reports the planned matrix through one notification and issues no provider request", async () => {
    const root = await benchmarkedProject();
    const { deps, state } = harness();
    const { owner, notifications, firstNotification } = background();

    const result = await (await plannedBenchmarkTool(deps, owner)).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 2, dryRun: true },
      toolContext(root, owner),
    );

    if (typeof result.content !== "string") throw new Error("expected text result");
    const launch = launchReport(result.content);
    expect(launch.status).toBe("started");
    expect(launch.dryRun).toBe(true);

    const report = notificationBody(await firstNotification);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("<benchmark_notification>");
    expect(report.dryRun).toBe(true);
    expect(report.persona).toBe("explorer");
    expect(report.variants).toEqual(["claude-opus-5@medium", "gpt-6-astra@high"]);
    expect(report.cells).toBe(12);
    expect(report.providerPlans).toEqual(launch.providerPlans);
    expect(report.resultsDir).toBe(join(root, "bench", "ab-persona", "results", String(launch.resultId)));

    // A dry run plans and stops: no cell runner, no client, no judge call.
    expect(state.runners).toHaveLength(0);
    expect(state.clientBuilds).toEqual([]);
    expect(state.judgeCompletions).toBe(0);
    expect(owner.tasks.activeTaskCount()).toBe(0);
    await owner.close();
  });
});

describe("benchmark tool cancellation", () => {
  it("stops concurrent cells, settles every one, and records a canceled attempt for each", async () => {
    const root = await benchmarkedProject(true);
    const { deps, state } = harness();
    const { owner, firstNotification } = background();

    const result = await (await plannedBenchmarkTool(deps, owner)).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: false },
      toolContext(root, owner),
    );
    if (typeof result.content !== "string") throw new Error("expected text result");
    const launch = launchReport(result.content);
    expect(result.outcome).toBe("ok");

    // The first group is both seats of the first task, running concurrently.
    await waitFor(() => state.runners.length === 2, "both cells of the first group to start");
    expect(owner.tasks.activeBackgroundCommands().map((task) => task.id)).toEqual([String(launch.taskId)]);
    expect(owner.tasks.terminate("tc_bench")).toBe(true);

    const notification = await firstNotification;
    expect(notification).toContain("was stopped before it produced a report");
    expect(notification).toContain(`"resume", resultId: "${String(launch.resultId)}"`);
    // Cancellation settles what was in flight and starts nothing further.
    expect(state.runners).toHaveLength(2);
    expect(state.runners.every((runner) => runner.aborted && runner.settled)).toBe(true);
    expect(state.judgeCompletions).toBe(0);

    const resultsDir = join(root, "bench", "ab-persona", "results", String(launch.resultId));
    expect(await Bun.file(join(resultsDir, "campaign.json")).exists()).toBe(true);
    expect(await Bun.file(join(resultsDir, "events.jsonl")).exists()).toBe(true);
    expect(await (await createRunStore({ resultsRoot: join(root, "bench", "ab-persona", "results"), directory: resultsDir })).loadRuns()).toEqual([]);
    const resultsRoot = join(root, "bench", "ab-persona", "results");
    const attempts = await (await createRunStore({ resultsRoot, directory: resultsDir })).loadAttempts();
    expect(attempts).toHaveLength(SEATS.length);
    expect(attempts.every((attempt) => attempt.terminal.kind === "cancelled")).toBe(true);
    expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(SEATS.length);
    expect(attempts.every((attempt) => attempt.durationMs >= 0)).toBe(true);
    expect(attempts.every((attempt) => attempt.accounting.estimatedUsd.kind === "unavailable" && attempt.accounting.tokens.kind === "unavailable")).toBe(true);
    expect(attempts.every((attempt) => attempt.accounting.providers.kind === "unavailable")).toBe(true);
    expect(await Bun.file(join(resultsDir, "report.md")).exists()).toBe(false);

    await owner.close();
    expect(owner.tasks.activeTaskCount()).toBe(0);
  }, 30_000);
});

describe("benchmark tool run identity", () => {
  it("refuses a second launch of one results directory and keeps the first run tracked", async () => {
    const root = await benchmarkedProject(true);
    const { deps, state } = harness();
    const { owner, notifications, firstNotification } = background();
    const tool = await plannedBenchmarkTool(deps, owner);

    const first = await tool.execute({ action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: false }, toolContext(root, owner));
    expect(first.outcome).toBe("ok");
    const firstLaunch = launchReport(String(first.content));
    const resultId = String(firstLaunch.resultId);
    const firstTaskId = String(firstLaunch.taskId);
    const resume = { action: "resume", resultId, dryRun: false };
    await waitFor(() => state.runners.length === 2, "both cells of the first group to start");

    const second = await tool.execute(resume, toolContext(root, owner));

    expect(second.outcome).toBe("error");
    expect(second.content).toContain(`benchmark-${resultId} is already active`);
    // The run already in flight keeps its registration, so stopping it still
    // reaches its cancellation and it reports exactly one terminal result.
    expect(owner.tasks.activeBackgroundCommands().map((task) => task.id)).toEqual([firstTaskId]);
    expect(owner.tasks.terminate("tc_bench")).toBe(true);
    expect(await firstNotification).toContain("was stopped before it produced a report");
    expect(notifications).toHaveLength(1);

    const resumed = await tool.execute(resume, toolContext(root, owner));
    expect(resumed.outcome).toBe("ok");
    expect(String(launchReport(String(resumed.content)).taskId)).not.toBe(firstTaskId);
    expect(owner.tasks.terminate("tc_bench")).toBe(true);
    await owner.close();
    expect(owner.tasks.activeTaskCount()).toBe(0);
  }, 30_000);
});

describe("benchmark tool judge settlement", () => {
  it("keeps the outcome and the owner's close pending until the judge call settles", async () => {
    const root = await benchmarkedProject(true);
    const { deps, state } = harness("completes");
    const { owner, notifications } = background();
    const tool = await plannedBenchmarkTool(deps, owner);

    const result = await tool.execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: false },
      toolContext(root, owner),
    );
    expect(result.outcome).toBe("ok");
    const launch = launchReport(String(result.content));
    const resultId = String(launch.resultId);

    // Every cell has completed and the run is inside its first judge call.
    await waitFor(() => state.judgeStarted === 1, "the first judge call to start");
    expect(owner.tasks.terminateProcess(String(launch.taskId), "user")).toBe(true);
    expect(owner.tasks.processRecord(String(launch.taskId))?.status).toBe("stopping");
    const duplicate = await tool.execute({ action: "resume", resultId, dryRun: false }, toolContext(root, owner));
    expect(duplicate.outcome).toBe("error");
    expect(duplicate.content).toContain(`benchmark-${resultId} is already active`);
    const closed = owner.close().then(() => "closed" as const);

    // The stop asks the judge call to stop; that call has not settled, so
    // nothing terminal may land: the run reports no outcome and the host is not
    // settled while a judge request is still in flight.
    expect(await Promise.race([closed, Bun.sleep(20).then(() => "pending" as const)])).toBe("pending");
    expect(notifications).toEqual([]);

    state.releaseJudge();
    expect(await closed).toBe("closed");
    expect(state.judgeCompletions).toBe(1);
    expect(owner.tasks.activeTaskCount()).toBe(0);
  }, 30_000);
});
