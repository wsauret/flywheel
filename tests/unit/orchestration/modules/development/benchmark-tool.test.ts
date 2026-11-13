import { describe, expect, it } from "bun:test";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Redacted } from "effect";

import { captureProviderConnection, type AuthContext } from "../../../../../src/infra/auth/auth-context.js";
import type { FailoverPlan } from "../../../../../src/infra/llm/access-provider.js";
import { createBenchmarkTool } from "../../../../../src/orchestration/modules/development/benchmark-tool.js";
import { admitBenchmark, type BenchmarkAdmissionDeps } from "../../../../../src/orchestration/modules/development/benchmark/admission.js";
import { createBenchmarkCatalog } from "../../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createBackgroundWorkRegistry, type BackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { repoDefinitions } from "../../../../helpers/project-definitions.js";
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js";
import { testProviderRegistry } from "../../../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { roleCapture } from "../../../../helpers/role-capture.js";
import { makeContext } from "../../agent-runtime/tools/_fixtures.js";

const temporaryDirectory = temporaryDirectories();

interface UnknownRecord { [key: string]: unknown }

function parseRecord(json: string): UnknownRecord {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return Object.fromEntries(Object.entries(value));
}

const { userDataRoot, accountHome } = testDirectories(process.cwd());
const SECRET = Redacted.make("[redacted secret]");

/** The account state a capture reports. Only the OpenAI API key is configured,
 *  so every model this file plans is admitted on exactly one provider. */
const AUTH: AuthContext = {
  providers: authProviders({ apiKeys: { openai_api: SECRET } }),
  credentialLineages: {}, droppedCredentials: [],
};

/** What the tool did at admission: the plans it admitted, and whether it built
 *  anything from them. Every factory throws, so a test that reaches a client or
 *  a cell runner has made a paid request and says so by failing. */
interface AdmissionSpy {
  admitted: ReadonlyMap<string, FailoverPlan> | null;
  captures: number;
}

function toolDeps(auth: AuthContext | (() => AuthContext) = AUTH) {
  const spy: AdmissionSpy = { admitted: null, captures: 0 };
  const foregroundBashHold = createForegroundBashHoldController(() => {});
  const deps: BenchmarkAdmissionDeps = {
    userDataRoot,
    accountHome,
    moduleSelection: composeFirstPartyModules,
    captureRuntimeConfig: testRuntimeConfigCapture,
    profileId: "default",
    authorityIncarnation: "test-authority",
    definitions: repoDefinitions(),
    runOwnedCommand: () => { throw new Error("no command may be launched in this test"); },
    foregroundBashHold,
    captureProviderConnection: async () => {
      spy.captures++;
      return {
        providers: testProviderRegistry(),
        connection: captureProviderConnection({
          profileId: "default",
          authDir: join(userDataRoot, "auth"),
          auth: typeof auth === "function" ? auth() : auth,
          oauthPersistence: "memory-only",
        }),
        runtimeConfig: testRuntimeConfigCapture(),
        eligibility: roleCapture(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]).eligibility,
        requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), standing: async () => ({ kind: "serves" as const }), admit: (plans) => {
          spy.admitted = plans;
          return {
            createAgent: () => { throw new Error("no benchmark cell may run in this test"); },
            createLLMClient: () => { throw new Error("no provider client may be built in this test"); },
          };
        },
      };
    },
  };
  return { deps, spy, foregroundBashHold };
}

function context(projectRoot: string, backgroundTasks?: BackgroundWorkRegistry, executionCwd = projectRoot): ToolContext {
  return makeContext({
    projectRoot,
    executionCwd,
    toolUseId: "tc_1",
    modelRequestId: "req_1",
    ...(backgroundTasks ? { backgroundTasks } : {}),
  });
}

async function run(input: UnknownRecord, projectRoot = process.cwd(), backgroundTasks?: BackgroundWorkRegistry) {
  return await createBenchmarkTool(toolDeps().deps).execute(input, context(projectRoot, backgroundTasks));
}

const SEATS = [{ model: "gpt-6-astra", effort: "medium" }, { model: "gpt-6-luna", effort: "xhigh" }];
const EXPLORER_DEFINITION = `---
name: explorer
description: Read-only investigation.
role: explorer
tools:
  - read
---
Investigate and hand off.
`;

/** A registry plus the promise of its first notification. */
function registry() {
  const notifications: string[] = [];
  const outputs: { toolUseId: string; output: string; identity: { parentToolUseId?: string; modelRequestId?: string } }[] = [];
  let notified: (() => void) | null = null;
  let outputRecorded: (() => void) | null = null;
  const settled = new Promise<void>((resolve) => { notified = resolve; });
  const firstOutput = new Promise<void>((resolve) => { outputRecorded = resolve; });
  const tasks = createBackgroundWorkRegistry({
    kind: "chat",
    enqueueNotification: (text) => {
      notifications.push(text);
      notified?.();
    },
    // Progress is a running tail: it streams live, and only the settled tail is recorded.
    onExecutionOutput: (toolUseId, output, identity) => {
      outputs.push({ toolUseId, output, identity });
      outputRecorded?.();
    },
  });
  return { tasks, notifications, outputs, settled, firstOutput };
}

describe("benchmark tool input contract", () => {
  it("rejects an action outside the discriminated pair", async () => {
    const result = await run({ action: "rescore", dryRun: true });
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("action to be 'run' or 'resume'");
  });

  it("rejects a resume field passed to run, and a run field passed to resume", async () => {
    const crossedRun = await run({ action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: true, resultId: "explorer-2026" });
    expect(crossedRun.outcome).toBe("error");
    expect(crossedRun.content).toContain("does not accept: resultId");

    const crossedResume = await run({ action: "resume", resultId: "explorer-2026", dryRun: true, persona: "explorer" });
    expect(crossedResume.outcome).toBe("error");
    expect(crossedResume.content).toContain("does not accept: persona");
  });

  it("rejects an unknown field, including a credential, a provider override, a path and a command", async () => {
    for (const extra of [{ apiKey: "sk-live" }, { provider: "openrouter" }, { resultsDir: "/etc" }, { command: "rm -rf /" }]) {
      const field = Object.keys(extra)[0];
      const result = await run({ action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: true, ...extra });
      expect(result.outcome).toBe("error");
      expect(result.content).toContain(`does not accept: ${field}`);
    }
  });

  it("rejects a variant that names anything beyond a model and an effort", async () => {
    const result = await run({
      action: "run",
      persona: "explorer",
      variants: [{ model: "gpt-6-astra", effort: "medium", apiKey: "sk-live" }],
      repeats: 1,
      dryRun: true,
    });
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("benchmark variant does not accept: apiKey");
  });

  it("requires a persona and at least one { model, effort } seat for a run", async () => {
    expect((await run({ action: "run", variants: SEATS, repeats: 1, dryRun: true })).content).toContain("requires a non-empty persona string");
    expect((await run({ action: "run", persona: "explorer", variants: [], repeats: 1, dryRun: true })).content).toContain("non-empty array of { model, effort }");
    expect((await run({ action: "run", persona: "explorer", variants: ["gpt-6-astra:medium"], repeats: 1, dryRun: true })).content)
      .toContain("must each be an object with a model and an effort");
    expect((await run({ action: "run", persona: "explorer", variants: [{ model: "gpt-6-astra", effort: "turbo" }], repeats: 1, dryRun: true })).content)
      .toContain('Unknown effort "turbo"');
  });

  it("requires repeats to be a positive integer and dryRun to be stated", async () => {
    expect((await run({ action: "run", persona: "explorer", variants: SEATS, repeats: 0, dryRun: true })).content).toContain("repeats must be a positive integer");
    expect((await run({ action: "run", persona: "explorer", variants: SEATS, dryRun: true })).content).toContain("repeats must be a positive integer");
    expect((await run({ action: "run", persona: "explorer", variants: SEATS, repeats: 1 })).content).toContain("dryRun must be a boolean");
    expect((await run({ action: "resume", resultId: "explorer-2026" })).content).toContain("dryRun must be a boolean");
  });

  it("rejects a resultId that is not one contained directory name", async () => {
    for (const resultId of ["../../etc", "explorer/2026", "..", "nested\\run"]) {
      const result = await run({ action: "resume", resultId, dryRun: true });
      expect(result.outcome).toBe("error");
      expect(result.content).toContain("must name one results directory");
    }
  });
});

describe("benchmark tool admission", () => {
  it("falls through unavailable candidate and judge settings with each role's effort", async () => {
    const { deps } = toolDeps();
    const captured = roleCapture(["claude-haiku-4.5", "claude-opus-5.5"], { "benchmark-judge": { model: "lost-judge", effort: "low" } });
    const admission = await admitBenchmark({
      ...deps,
      captureProviderConnection: async () => ({ ...captured, admit: () => ({ createAgent: () => { throw new Error("unused"); }, createLLMClient: () => { throw new Error("unused"); } }) }),
    }, [{ role: "candidate", roleId: "explorer", model: "lost-candidate", effort: "low" }, { role: "judge" }]);
    expect(admission.providerPlans).toEqual([
      { role: "candidate", model: "claude-haiku-4.5", effort: "high", profileId: "default", providers: ["anthropic_api"] },
      { role: "judge", model: "claude-opus-5.5", effort: "high", profileId: "default", providers: ["anthropic_api"] },
    ]);
  });

  it("preserves the host foreground Bash hold without constructing a client", async () => {
    const { deps, spy, foregroundBashHold } = toolDeps();

    const admission = await admitBenchmark(deps, [{ role: "candidate", model: "gpt-6-astra" }]);

    expect(admission.runtime.foregroundBashHold).toBe(foregroundBashHold);
    expect(spy.captures).toBe(1);
    foregroundBashHold.dispose();
  });

  it("plans every candidate and the judge on one capture, and reports the chains it admitted", async () => {
    const { deps, spy } = toolDeps();
    const { tasks, notifications, settled } = registry();
    const result = await createBenchmarkTool(deps).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 2, dryRun: true },
      context(process.cwd(), tasks),
    );

    expect(result.outcome).toBe("ok");
    const launch = parseRecord(String(result.content));
    expect(launch.status).toBe("started");
    expect(launch.dryRun).toBe(true);
    expect(launch.operation).toBe("run");
    expect(String(launch.resultId)).toStartWith("explorer-");
    expect(String(launch.taskId)).toStartWith(`benchmark:${String(launch.resultId)}:`);
    expect(tasks.processRecord(String(launch.taskId))).toMatchObject({
      kind: "benchmark",
      description: expect.stringContaining("explorer benchmark"),
    });
    // Exactly the role, the model and the ordered candidates: no directory, no
    // credential, no plan internals.
    expect(launch.providerPlans).toEqual([
      { role: "candidate", model: "gpt-6-astra", effort: "medium", profileId: "default", providers: ["openai_api"] },
      { role: "candidate", model: "gpt-6-luna", effort: "high", profileId: "default", providers: ["openai_api"] },
      { role: "judge", model: "gpt-6.1-sol", effort: "high", profileId: "default", providers: ["openai_api"] },
    ]);
    // One capture for the whole run, and every model it will ask for is admitted
    // from it before anything is built.
    expect(spy.captures).toBe(1);
    expect([...(spy.admitted?.keys() ?? [])]).toEqual(["gpt-6-astra", "gpt-6-luna", "gpt-6.1-sol"]);
    expect(String(result.content)).not.toContain("[redacted secret]");

    await settled;
    expect(notifications).toHaveLength(1);
    const report = parseRecord(String(notifications[0]).split("<result>")[1]?.split("</result>")[0] ?? "");
    expect(report.dryRun).toBe(true);
    expect(report.mode).toBe("research");
    expect(report.variants).toEqual(["gpt-6-astra@medium", "gpt-6-luna@xhigh"]);
    expect(report.cells).toBe((await createBenchmarkCatalog(process.cwd()).researchTasks("explorer")).length * SEATS.length * 2);
    expect(report.providerPlans).toEqual(launch.providerPlans);
    expect(String(report.resultsDir)).toContain(join("bench", "ab-persona", "results"));
    expect(tasks.activeTaskCount()).toBe(0);
  });

  it("plans only the named tasks under a pinned judge, and names the candidates that share the judge's model", async () => {
    const { deps } = toolDeps();
    const { tasks, notifications, settled } = registry();
    const [first] = await createBenchmarkCatalog(process.cwd()).researchTasks("explorer");
    const result = await createBenchmarkTool(deps).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: true, tasks: [first!.id], judge: { model: "gpt-6.1-sol", effort: "low" } },
      context(process.cwd(), tasks),
    );
    expect(result.outcome).toBe("ok");
    await settled;
    const report = parseRecord(String(notifications[0]).split("<result>")[1]?.split("</result>")[0] ?? "");
    expect(report.tasks).toEqual([first!.id]);
    expect(report.cells).toBe(2);
    expect(report.providerPlans).toContainEqual({ role: "judge", model: "gpt-6.1-sol", effort: "low", profileId: "default", providers: ["openai_api"] });
    expect(report.judgeModelCandidates).toEqual([]);

    const sharing = registry();
    expect((await createBenchmarkTool(deps).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: true, judge: { model: "gpt-6-astra", effort: "low" } },
      context(process.cwd(), sharing.tasks),
    )).outcome).toBe("ok");
    await sharing.settled;
    const shared = parseRecord(String(sharing.notifications[0]).split("<result>")[1]?.split("</result>")[0] ?? "");
    expect(shared.judgeModelCandidates).toEqual(["gpt-6-astra:medium"]);
  });

  it("keeps one run on capture A and admits the next run from capture B", async () => {
    let auth = AUTH;
    const { deps, spy } = toolDeps(() => auth);
    const firstTasks = registry();
    const first = await createBenchmarkTool(deps).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: true },
      context(process.cwd(), firstTasks.tasks),
    );

    auth = { ...AUTH, providers: authProviders({ base: AUTH.providers, without: ["openai_api"] }),};
    const secondTasks = registry();
    const second = await createBenchmarkTool(deps).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: true },
      context(process.cwd(), secondTasks.tasks),
    );

    expect(first.outcome).toBe("ok");
    expect(second.outcome).toBe("ok");
    expect(parseRecord(String(second.content)).providerPlans).toEqual([
      { role: "candidate", profileId: "default", providers: [] },
      { role: "candidate", profileId: "default", providers: [] },
      { role: "judge", profileId: "default", providers: [] },
    ]);
    expect(spy.captures).toBe(2);
    await firstTasks.settled;
    await secondTasks.settled;
  });

  it("loads fixtures and results from the parent execution directory", async () => {
    const projectRoot = temporaryDirectory("flywheel-benchmark-parent-");
    const { deps } = toolDeps();
    const { tasks, notifications, settled } = registry();
    const result = await createBenchmarkTool(deps).execute(
      { action: "run", persona: "implementer", variants: SEATS, repeats: 1, dryRun: true },
      context(projectRoot, tasks, process.cwd()),
    );

    expect(result.outcome).toBe("ok");
    const launch = parseRecord(String(result.content));
    expect(String(launch.resultId)).toStartWith("implementer-");
    await settled;
    const report = parseRecord(String(notifications[0]).split("<result>")[1]?.split("</result>")[0] ?? "");
    expect(String(report.resultsDir)).toStartWith(join(process.cwd(), "bench", "ab-persona", "results"));
    expect(await readdir(projectRoot)).toEqual([]);
  });

  it("uses the loaded persona's role when no variant is authored", async () => {
    const root = temporaryDirectory("benchmark-role-preflight-");
    const personas = join(root, "src", "workflows", "agents", "personas");
    await mkdir(personas, { recursive: true });
    await Bun.write(join(personas, "explorer.md"), EXPLORER_DEFINITION.replace("role: explorer", "role: advisor"));
    const { deps } = toolDeps();
    const { tasks, settled } = registry();
    const result = await createBenchmarkTool(deps).execute(
      { action: "run", persona: "explorer", repeats: 1, dryRun: true },
      context(root, tasks),
    );
    expect(result.outcome).toBe("ok");
    expect(parseRecord(String(result.content)).providerPlans).toEqual([
      { role: "candidate", model: "gpt-6-astra", effort: "high", profileId: "default", providers: ["openai_api"] },
    ]);
    await settled;
  });

  it("reports an empty profile without refusing launch or constructing a client", async () => {
    const { deps, spy } = toolDeps({ ...AUTH, providers: authProviders({ base: AUTH.providers, without: ["openai_api"] }),});
    const { tasks, settled } = registry();
    const result = await createBenchmarkTool(deps).execute(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: true },
      context(process.cwd(), tasks),
    );
    expect(result.outcome).toBe("ok");
    expect(parseRecord(String(result.content)).providerPlans).toEqual([
      { role: "candidate", profileId: "default", providers: [] },
      { role: "candidate", profileId: "default", providers: [] },
      { role: "judge", profileId: "default", providers: [] },
    ]);
    expect(spy.admitted?.size).toBe(0);
    await settled;
    expect(tasks.activeTaskCount()).toBe(0);
  });
});

describe("benchmark tool launch", () => {
  it("refuses to launch without a background registry, because nothing would track it", async () => {
    const result = await run({ action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: false });
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("no background task registry");
  });

  it("tracks one stoppable task and reports its terminal state through one notification", async () => {
    const projectRoot = temporaryDirectory("flywheel-benchmark-tool-");
    const personasDir = join(projectRoot, "src", "workflows", "agents", "personas");
    await mkdir(personasDir, { recursive: true });
    await Bun.write(join(personasDir, "explorer.md"), EXPLORER_DEFINITION);
    const { tasks, notifications, outputs, settled, firstOutput } = registry();

    const result = await run(
      { action: "run", persona: "explorer", variants: SEATS, repeats: 1, dryRun: false },
      projectRoot,
      tasks,
    );

    expect(result.outcome).toBe("ok");
    const launch = parseRecord(String(result.content));
    expect(launch.status).toBe("started");
    expect(launch.dryRun).toBe(false);
    await firstOutput;
    // The existing background surfaces see it: list names this tool call, and
    // stop reaches its cancellation.
    expect(tasks.activeBackgroundCommands().map((task) => task.id)).toEqual([String(launch.taskId)]);
    expect(tasks.activeBackgroundCommands().map((task) => task.toolUseId)).toEqual(["tc_1"]);
    expect(tasks.terminate("tc_1")).toBe(true);

    await settled;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("<benchmark_notification>");
    expect(notifications[0]).toContain(String(launch.resultId));
    expect(tasks.activeTaskCount()).toBe(0);
    // Progress streamed on the live execution-output channel while it ran,
    // keyed to this tool call like a backgrounded command's log tail. Each
    // publication is the full replacement tail, so every earlier tail is a
    // prefix of the next, and each carries the call's identity.
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.every((entry) => entry.toolUseId === "tc_1")).toBe(true);
    expect(outputs.every((entry) => entry.identity.modelRequestId === "req_1")).toBe(true);
    for (let i = 1; i < outputs.length; i += 1) {
      // SAFETY: loop bounds keep both indices inside outputs.
      expect(outputs[i]!.output.startsWith(outputs[i - 1]!.output)).toBe(true);
    }
    // Zero-based stored repeats render one-based, and every line stays single-line.
    const lines = outputs[outputs.length - 1]!.output.split("\n");
    expect(lines.every((line) => line.length > 0 && line.length <= 404)).toBe(true);
    expect(outputs[outputs.length - 1]!.output).not.toContain("#0");

    const resumed = await run(
      { action: "resume", resultId: launch.resultId, dryRun: true },
      projectRoot,
      tasks,
    );
    expect(resumed.outcome).toBe("ok");
    const resumedLaunch = parseRecord(String(resumed.content));
    expect(resumedLaunch.resultId).toBe(launch.resultId);
    expect(resumedLaunch.taskId).not.toBe(launch.taskId);
    expect(tasks.processRecord(String(resumedLaunch.taskId))?.kind).toBe("benchmark");
    expect(await tasks.waitProcess(String(resumedLaunch.taskId))).toBe(true);
  });

  it("refuses a dry-run resume of a results directory that does not exist, and creates nothing", async () => {
    const projectRoot = temporaryDirectory("flywheel-benchmark-resume-");
    const { tasks } = registry();

    const result = await run({ action: "resume", resultId: "explorer-2026-08-08T04-50-28-280Z", dryRun: true }, projectRoot, tasks);

    expect(result.outcome).toBe("error");
    // A dry run reads: it leaves no results directory behind for a resultId
    // that names nothing.
    await expect(readdir(join(projectRoot, "bench"))).rejects.toThrow(/ENOENT/);
    expect(tasks.activeTaskCount()).toBe(0);
  });

});
