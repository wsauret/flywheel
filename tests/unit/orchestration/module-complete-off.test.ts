import { describe, expect, test } from "bun:test";
import { createWebSearchProviderResolver, SHIPPED_MODULES, composeFirstPartyModules, moduleProtocolRows, webAuthProviderDefinitions, type FirstPartyModuleComposition } from "../../../src/orchestration/modules.js";
import { DEVELOPMENT_MODULES } from "../../../src/orchestration/development-modules.js";
import { MODULE_IDS } from "../../../src/protocol/module-ids.js";
import { composeModuleRuntimes, NO_MODULE_RUNTIMES } from "../../../src/infra/module-runtime.js";
import { NO_MODULE_SERVICES } from "../../../src/infra/module-service.js";
import { capabilityAccessFor, type RuntimeTool } from "../../../src/orchestration/agent-runtime/tools/types.js";
import { testKernelToolDeps } from "../../helpers/request-tool-surface.js";
import type { KernelToolDeps } from "../../../src/orchestration/agent-runtime/tools/kernel-tool-deps.js";
import { parseSessionFact } from "../../../src/orchestration/session/session-fact-registry.js";
import { parseExperimentFact, type ExperimentFact } from "../../../src/orchestration/modules/experiments/facts.js";
import { toolRegistryFromComposition } from "../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import { planToolExposure } from "../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work.js";
import type { ModulePolicy } from "../../../src/orchestration/config/module-policy.js";
import type { ModuleState } from "../../../src/orchestration/config/module-descriptor.js";
import { capabilityAccessHolding } from "./agent-runtime/tools/_fixtures.js";
import type { AuthContext } from "../../../src/infra/auth/auth-context.js";

import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { authProviders } from "../../helpers/auth-context.js";
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js";
import { asAsyncEventReadSurface } from "../../../src/infra/event-store-types.js";
import { unusedSessionMessaging } from "../../helpers/child-session-control.js";
import { asRecord } from "../../../src/infra/record.js";
import { turnReminders } from "../../../src/orchestration/agent-runtime/turn-reminders.js";
import type { ConversationMessage } from "../../../src/orchestration/agent-runtime/llm/types.js";
import { promptCapabilities } from "../../helpers/prompt-capabilities.js";
// Every module a source run composes: the shipped catalog plus the one the
// source entry installs, so the development module's off-surface is held too.
const CATALOG = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES] as const;
type CatalogId = (typeof CATALOG)[number]["id"];
interface ObservableContributions {
  readonly providers?: readonly string[];
  readonly tools?: readonly string[];
  readonly promptFragments?: readonly string[];
  readonly promptRosters?: readonly string[];
  readonly definitions?: readonly string[];
  readonly memory?: readonly string[];
  readonly cli?: readonly string[];
  readonly config?: readonly string[];
  readonly settings?: readonly string[];
  readonly commands?: readonly string[];
  readonly webBackends?: readonly string[];
  readonly webAuthProviders?: readonly string[];
}

interface ObservableProbe {
  readonly contributions: ObservableContributions;
  /** Lifecycle seams the module observes; the chat seam is the turn-completion continuation effect, and the notify seam records a stated condition. */
  readonly observers?: readonly string[];
  /** Execution seams the module gates after ordinary tool admission. */
  readonly gates?: readonly string[];
  readonly settlesAfterAdmission?: readonly CatalogId[];
}

interface CapabilityObservations extends Required<ObservableContributions> {
  readonly observers: readonly string[];
  readonly gates: readonly string[];
}

type CompleteOffTable = { readonly [Id in CatalogId]: ObservableProbe };

const COMPLETE_OFF_ROWS: CompleteOffTable = {
  "ask-user": { contributions: { tools: ["ask_user"], promptFragments: ["ask-user-root"] } },
  "background-commands": { contributions: { settings: ["background-commands"] }, settlesAfterAdmission: ["background-commands"] },
  bash: { contributions: { tools: ["bash"] } },
  "bug-reports": { contributions: { settings: ["bug-reports"] } },
  development: { contributions: { tools: ["benchmark", "ios_simulator"], definitions: ["development"], settings: ["development"], cli: ["claude-sdk"] } },
  "code-mode": { contributions: { tools: ["code"] } },
  "definition-overrides": { contributions: { tools: ["definition_overrides"], settings: ["definition-overrides"] } },
  discovery: { contributions: { tools: ["list", "search"] } },
  experiments: {
    contributions: { tools: ["init_experiment", "run_experiment", "log_experiment"], promptFragments: ["experiments-active"], definitions: ["experiments"], settings: ["experiments"], commands: ["experiment"] },
    observers: ["chat"],
    gates: ["toolExecution", "toolExposure"],
  },
  "file-tools": { contributions: { tools: ["edit", "read", "write"] } },
  learning: {
    contributions: { tools: ["memory", "skill_manage"], promptFragments: ["learning-memory"], memory: ["learning-memory"], settings: ["learning"], commands: ["learn"] },
    settlesAfterAdmission: ["learning"],
  },
  mcp: { contributions: { settings: ["mcp"], commands: ["mcp"] } },
  papercuts: { contributions: { tools: ["papercut_log", "papercut_dispose"], settings: ["papercuts"], commands: ["papercuts"] } },
  "project-notifications": { contributions: { settings: ["project-notifications", "project-notifications-desktop"], commands: ["notifications"] }, observers: ["notify"] },
  "provider-anthropic-api": { contributions: { providers: ["anthropic_api"] } },
  "provider-chatgpt": { contributions: { providers: ["chatgpt"] } },
  "provider-claude-agent-sdk": { contributions: { providers: ["claude_agent_sdk"], settings: ["provider-claude-agent-sdk"] } },
  "provider-deepseek": { contributions: { providers: ["deepseek"] } },
  "provider-github-copilot": { contributions: { providers: ["github_copilot"] } },
  "provider-google-api": { contributions: { providers: ["google_api"] } },
  "provider-google-vertex": { contributions: { providers: ["google_vertex"], settings: ["provider-google-vertex"] } },
  "provider-openai-api": { contributions: { providers: ["openai_api"] } },
  "provider-opencode-go": { contributions: { providers: ["opencode_go"] } },
  "provider-openrouter": { contributions: { providers: ["openrouter"] } },
  "provider-supergrok": { contributions: { providers: ["supergrok"] } },
  recall: { contributions: { tools: ["recall"] } },
  remote: {
    contributions: { cli: ["remote"], config: ["remote"], settings: ["remote", "remote-keep-awake"], commands: ["remote"] },
    settlesAfterAdmission: ["remote"],
  },
  "side-question": { contributions: { settings: ["side-question"], commands: ["btw"] } },
  skills: {
    contributions: { tools: ["skill"], promptRosters: ["skills"], definitions: ["skills"], settings: ["skills"] },
    settlesAfterAdmission: ["skills"],
  },
  "subscription-usage": { contributions: { settings: ["subscription-usage", "subscription-usage-alert-thresholds"], commands: ["usage"] } },
  subagents: { contributions: { tools: ["subagent"], definitions: ["subagents"], settings: ["subagents"] }, settlesAfterAdmission: ["subagents"] },
  web: { contributions: { tools: ["web"], promptRosters: ["web"], settings: ["web"] }, settlesAfterAdmission: ["web"] },
  "web-chatgpt": { contributions: { webBackends: ["chatgpt"] } },
  "web-exa": { contributions: { webBackends: ["exa"], webAuthProviders: ["exa"] } },
  workflows: {
    contributions: { tools: ["workflow", "models"], definitions: ["workflows", "workflows-bundle"], settings: ["workflows"] },
    observers: ["workflow"], settlesAfterAdmission: ["skills", "workflows"],
  },
};

function contributionIds(composition: FirstPartyModuleComposition, domain: FirstPartyModuleComposition["contributions"][number]["domain"]): readonly string[] {
  return composition.contributions.filter((contribution) => contribution.domain === domain).map(({ id }) => id);
}

const EMPTY_AUTH: AuthContext = {
  providers: authProviders(),
  credentialLineages: {},
  droppedCredentials: [],
};
async function observe(composition: FirstPartyModuleComposition): Promise<CapabilityObservations> {
  const messages: string[] = [];
  const silentContinuations: string[] = [];
  for (const entry of composition.observers) {
    if (entry.seam === "workflow") {
      const notice = await entry.observer({ getBudgetInfo: async () => ({ remainingCalls: 4, remainingTokens: 9_999 }), getContextPercent: async () => 0 }).onBatchSettled();
      if (notice !== null) messages.push(notice);
      continue;
    }
    // The notify seam with no service built: a stated condition settles as a no-op.
    if (entry.seam === "notify") {
      await entry.observer({ type: "resolve", sourceId: "probe" }, NO_MODULE_SERVICES);
      continue;
    }
    // The experiment continuation effect: a turn that ran no experiment tool
    // neither reads durable state nor enqueues a resume, even while enabled.
    const reader = asAsyncEventReadSurface({
        ...inMemoryEventReader([]),
        read: () => { throw new Error("no experiment state is read without a run"); },
        readTolerant: () => { throw new Error("no experiment state is read without a run"); },
        currentPosition: () => { throw new Error("no experiment state is read without a run"); },
    });
    const chat = entry.observer({
      sessionId: "module-observer-probe",
      eventStore: reader,
      projectionReader: reader,
      writer: {
        record: async () => { throw new Error("no experiment fact is recorded without a run"); },
        recordBatch: async () => { throw new Error("no experiment fact batch is recorded without a run"); },
        recordGuarded: async () => { throw new Error("no experiment fact is recorded without a run"); },
        transaction: async () => { throw new Error("no experiment transaction starts without a run"); },
        dispose: () => {},
      },
      enqueueSilentSystem: (message) => silentContinuations.push(message),
      showSystemMessage: (message) => messages.push(message),
    });
    await chat.onTurnComplete?.("turn_end");
  }
  const promptFragment = composition.contributions.find((entry) => entry.domain === "promptFragments" && entry.id === "learning-memory");
  if (promptFragment?.domain === "promptFragments") {
    expect(await promptFragment.value.render({ kernel: testKernelToolDeps(), modules: NO_MODULE_RUNTIMES, tools: new Map(), memorySnapshot: "probe", capabilities: promptCapabilities([]) })).toContain("probe");
  }
  const observers = composition.observers.map(({ seam }) => String(seam));
  if (observers.includes("workflow")) expect(messages.join("\n")).toContain("Workflow budget running low: 4 attempts and 9999 tokens remain. This agent can finish, but no attempt starts after the budget runs out. Prioritize completing your brief efficiently.");
  expect(silentContinuations).toEqual([]);
  return {
    providers: accessProviderRegistry(composition).selection.definitions.map(({ id }) => id),
    tools: [...toolRegistryFromComposition(composition).keys()],
    promptFragments: contributionIds(composition, "promptFragments"),
    promptRosters: contributionIds(composition, "promptRosters"),
    definitions: contributionIds(composition, "definitions"),
    memory: contributionIds(composition, "memory"),
    cli: contributionIds(composition, "cli"),
    config: contributionIds(composition, "config"),
    settings: contributionIds(composition, "settings"),
    commands: contributionIds(composition, "commands"),
    webBackends: createWebSearchProviderResolver({ authDir: "/scratch", getAuth: () => EMPTY_AUTH })(composition).map(({ id }) => id),
    webAuthProviders: webAuthProviderDefinitions(composition).map(({ id }) => id),
    observers,
    gates: composition.gates.map(({ seam }) => String(seam)),
  };
}

function expectFacet(expected: readonly string[] | undefined, enabled: readonly string[], disabled: readonly string[]): void {
  for (const id of expected ?? []) {
    expect(enabled).toContain(id);
    expect(disabled).not.toContain(id);
  }
}

async function probeAdmissionSettlement(required: readonly CatalogId[]): Promise<void> {
  let selected = [...required];
  let effects = 0;
  const state = (): ModuleState => ({ capabilities: selected, moduleIds: selected, requireWorkflowConfirmation: true, workflowsMode: selected.includes("workflows") ? "ask" : "off", identity: selected.join(",") });
  const policy: Pick<ModulePolicy, "admit" | "state"> = {
    state,
    admit: async ({ operation, required: requested }) => {
      const missing = requested.filter((id) => !selected.includes(id));
      return missing.length > 0
        ? { ok: false, missing, reason: `${operation} is unavailable` }
        : { ok: true, grant: { ...state(), operation, required: requested } };
    },
  };
  const access = capabilityAccessFor(policy);
  const admitted = await access.admit({ operation: "observable probe", required });
  expect(admitted.ok).toBe(true);
  if (!admitted.ok) throw new Error(admitted.reason);
  effects += 1;
  const settling = capabilityAccessFor(policy, admitted.grant);
  selected = [];
  for (const id of required) expect(settling.available(id)).toBe(true);
  const stale = await access.admit({ operation: "stale observable probe", required });
  if (stale.ok) effects += 1;
  expect(stale.ok).toBe(false);
  expect(effects).toBe(1);
}

describe("catalog-exhaustive complete-off behavior", () => {
  test("the observable probe table recruits every installed module", () => {
    expect(Object.keys(COMPLETE_OFF_ROWS).sort()).toEqual(CATALOG.map(({ id }) => id).sort());
  });

  test("every installed module offers a switch that turns it off", () => {
    const withoutSwitch = moduleProtocolRows(MODULE_IDS, CATALOG).filter((row) => row.installed && row.setting === undefined).map((row) => row.id);
    expect(withoutSwitch).toEqual([]);
  });

  for (const module of CATALOG) {
    test(`${module.id} loses every observable active facet in canonical and reversed catalogs`, async () => {
      const row = COMPLETE_OFF_ROWS[module.id];
      const disabled = new Set<CatalogId>([module.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of CATALOG) {
          if (!disabled.has(candidate.id) && candidate.dependencies.some((dependency) => disabled.has(dependency))) {
            disabled.add(candidate.id);
            changed = true;
          }
        }
      }

      for (const catalog of [CATALOG, CATALOG.toReversed()]) {
        const enabledComposition = composeFirstPartyModules(catalog, []);
        const enabledObservations = await observe(enabledComposition);
        const disabledComposition = composeFirstPartyModules(catalog, [...disabled]);
        const disabledObservations = await observe(disabledComposition);
        expect(enabledComposition.enabledModuleIds).toContain(module.id);
        expect(disabledComposition.enabledModuleIds).not.toContain(module.id);
        expectFacet(row.contributions.providers, enabledObservations.providers, disabledObservations.providers);
        expectFacet(row.contributions.tools, enabledObservations.tools, disabledObservations.tools);
        expectFacet(row.contributions.promptFragments, enabledObservations.promptFragments, disabledObservations.promptFragments);
        expectFacet(row.contributions.promptRosters, enabledObservations.promptRosters, disabledObservations.promptRosters);
        expectFacet(row.contributions.definitions, enabledObservations.definitions, disabledObservations.definitions);
        expectFacet(row.contributions.memory, enabledObservations.memory, disabledObservations.memory);
        expectFacet(row.contributions.cli, enabledObservations.cli, disabledObservations.cli);
        expectFacet(row.contributions.config, enabledObservations.config, disabledObservations.config);
        expectFacet(row.contributions.settings, enabledObservations.settings, disabledObservations.settings);
        expectFacet(row.contributions.commands, enabledObservations.commands, disabledObservations.commands);
        expectFacet(row.contributions.webBackends, enabledObservations.webBackends, disabledObservations.webBackends);
        expectFacet(row.contributions.webAuthProviders, enabledObservations.webAuthProviders, disabledObservations.webAuthProviders);
        expectFacet(row.observers, enabledObservations.observers, disabledObservations.observers);
        expectFacet(row.gates, enabledObservations.gates, disabledObservations.gates);
      }
      if (row.settlesAfterAdmission) await probeAdmissionSettlement(row.settlesAfterAdmission);
    });
  }

  test("all-module-off exposes only kernel tools allowed by live runner services", async () => {
    const registry = toolRegistryFromComposition(composeFirstPartyModules(CATALOG, CATALOG.map(({ id }) => id)));
    const backgroundTasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const plan = (kernel: Parameters<typeof testKernelToolDeps>[0] = {}) => planToolExposure({
      kernel: testKernelToolDeps({ userDataRoot: "/scratch", capabilities: capabilityAccessHolding([]), backgroundTasks, ...kernel }),
      modules: NO_MODULE_RUNTIMES,
      registry,
    });

    expect([...registry.keys()]).toEqual(["handoff", "process.native", "checkpoint_read", "checkpoint_replace", "checkpoint_decide", "message_session", "list_sessions"]);
    expect([...(await plan({ handoff: {} })).tools.keys()]).toEqual(["handoff"]);
    const sessions = unusedSessionMessaging();
    expect([...(await plan({ sessions })).tools.keys()]).toEqual(["message_session", "list_sessions"]);
    expect((await plan()).tools.has("handoff")).toBe(false);
    expect((await plan()).tools.has("process")).toBe(false);

    for (const producer of ["background-commands", "subagents", "workflows"] as const) {
      expect((await plan({ capabilities: capabilityAccessHolding([producer]) })).tools.has("process")).toBe(true);
    }

    let finish: ((result: { status: "completed"; content: string }) => void) | undefined;
    const done = new Promise<{ status: "completed"; content: string }>((resolve) => { finish = resolve; });
    backgroundTasks.track({ done, meta: { id: "existing", type: "background_command", description: "existing task" } });
    expect((await plan()).tools.has("process")).toBe(true);
    finish?.({ status: "completed", content: "done" });
    await done;
  });

  test("Workflows gates launch, and only the root chat in On mode is told to orchestrate", async () => {
    let mode: "on" | "ask" = "on";
    const workflows = {
      deps: () => ({
        startWorkflow: async () => ({ error: "probe launches nothing" }),
        onRenderEvent: () => {},
        mode,
        resolveLaunchTarget: async () => ({ error: "probe launches nothing" }),
        sessionDir: "/scratch/session",
        executionCwd: "/scratch",
      }),
      authority: () => ({ toolActions: new Set<string>(), personas: new Set<string>() }),
    };
    const sourceKinds = async (disabledIds: readonly CatalogId[], purpose: KernelToolDeps["purpose"] = { kind: "interactive-chat" }) => {
      const composition = composeFirstPartyModules(CATALOG, [...disabledIds]);
      const kernel = testKernelToolDeps({
        userDataRoot: "/scratch",
        capabilities: capabilityAccessHolding(MODULE_IDS.filter((id) => composition.enabledModuleIds.includes(id))),
        backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
        moduleSnapshot: composition,
        purpose,
        captureProviderConnection: () => Promise.reject(new Error("the probe reads no model access")),
        askUser: purpose.kind === "interactive-chat" ? {
          ask: async () => ({ kind: "cancelled" }),
          answerQuestion: () => {},
          cancelQuestion: () => {},
          suspendAll: () => false,
        } : undefined,
      });
      const modules = composeModuleRuntimes([["workflows", workflows]]);
      const plan = await planToolExposure({ kernel, modules, registry: toolRegistryFromComposition(composition) });
      const source = asRecord(asRecord(plan.tools.get("workflow")?.inputSchema.properties)?.source);
      const fragments = await Promise.all(composition.contributions.flatMap((contribution) => contribution.domain === "promptFragments" ? [contribution.value] : [])
        .map((fragment) => fragment.render({ kernel, modules, tools: plan.tools, memorySnapshot: "", capabilities: promptCapabilities([...plan.tools.values()]) })));
      const orchestration = fragments.find((text) => text?.startsWith("# Orchestrating with workflows"));
      if (orchestration) {
        expect(orchestration).toContain("Write a workflow file for the task and launch it by content or path with the workflow tool.");
        expect(orchestration).toContain("Workflows is On:");
        expect(orchestration).toContain("ask the person, and pass the answer as `input` to the next workflow.");
        expect(orchestration.includes("Give the work of one agent to a subagent.")).toBe(plan.tools.has("subagent"));
        expect(orchestration).not.toContain("ask_user");
      }
      const reminder = composition.installedContributions.find((contribution) => contribution.domain === "turnReminders" && contribution.id === "workflow-orchestration");
      const reminds = reminder?.domain === "turnReminders" && composition.enabledModuleIds.includes(reminder.module) && reminder.value.holds({ kernel, modules, tools: plan.tools });
      return { kinds: asRecord(asRecord(source?.properties)?.kind)?.enum, orchestrates: fragments.some((text) => text?.startsWith("# Orchestrating with workflows") === true), reminds, models: plan.tools.has("models") };
    };

    expect(await sourceKinds([])).toEqual({ kinds: ["path", "content"], orchestrates: true, reminds: true, models: true });
    expect(await sourceKinds([], { kind: "subagent", renderAs: "subagent", parentToolUseId: "parent" })).toEqual({ kinds: ["path", "content"], orchestrates: false, reminds: false, models: true });
    // The models table serves choosing workflow agents, so Workflows Off removes it with the workflow tool.
    expect(await sourceKinds(["workflows"])).toEqual({ kinds: undefined, orchestrates: false, reminds: false, models: false });
    expect(await sourceKinds(["subagents"])).toEqual({ kinds: ["path", "content"], orchestrates: true, reminds: true, models: true });
    mode = "ask";
    expect(await sourceKinds([])).toEqual({ kinds: ["path", "content"], orchestrates: false, reminds: false, models: true });
  });

  test("the orchestration reminder recognizes the unmarked statement that conversations before its marker hold", () => {
    const reminder = composeFirstPartyModules(CATALOG, []).installedContributions.find((contribution) => contribution.domain === "turnReminders" && contribution.id === "workflow-orchestration");
    if (reminder?.domain !== "turnReminders") throw new Error("workflow orchestration declares no turn reminder");
    const unmarked = "<system-reminder>\nAd hoc workflows is on: aim for the most complete and correct answer, not the fastest or cheapest one. Run every substantive task through a workflow; token cost is not a constraint. Refer to the Orchestrating with workflows section. Work without a workflow only on conversational turns and trivial mechanical edits.\n</system-reminder>";
    const history: ConversationMessage[] = [{ kind: "user", content: "audit this", origin: "human" }, { kind: "user", origin: "system", content: unmarked }, { kind: "user", content: "next", origin: "human" }];
    const state = (holds: boolean) => ({ ...reminder.value, id: reminder.id, holds });
    const every = () => true;
    expect(turnReminders(history, [state(true)], every)).toEqual([]);
    expect(turnReminders(history, [state(false)], every).map((message) => message.content)).toEqual([`<system-reminder mode="workflow-orchestration" state="off">\n${reminder.value.off(every)}\n</system-reminder>`]);
    const retiredOff: ConversationMessage = { kind: "user", origin: "system", content: "<system-reminder>\nAd hoc workflows is off: launch only a registered workflow, and only when its purpose fits the task.\n</system-reminder>" };
    expect(turnReminders([retiredOff], [state(false)], every)).toEqual([]);
  });

  test("the orchestration statements name only what the agent that reads them can use", () => {
    const reminder = composeFirstPartyModules(CATALOG, []).installedContributions.find((contribution) => contribution.domain === "turnReminders" && contribution.id === "workflow-orchestration");
    if (reminder?.domain !== "turnReminders") throw new Error("workflow orchestration declares no turn reminder");
    const holding = (...tools: string[]) => (term: string) => tools.includes(term);
    // Ask mode keeps the workflow tool, so the off statement still says when to launch one.
    expect(reminder.value.off(holding("workflow", "subagent"))).toBe("Workflows is no longer On: stop delegating every substantive task. Do the work directly, or delegate a focused task when it pays for itself. Launch a workflow only when the task needs one.");
    expect(reminder.value.off(holding())).toBe("Workflows is no longer On: stop delegating every substantive task. Do the work directly.");
    expect(reminder.value.on(holding("workflow", "subagent"))).toContain("; use subagents for one agent or for agents that can run at the same time.");
    expect(reminder.value.on(holding("workflow"))).not.toContain("subagent");
  });

  test("disabled experiments admits no experiment surface while historical facts still decode", async () => {
    const disabled = composeFirstPartyModules(CATALOG, ["experiments"]);
    const registry = toolRegistryFromComposition(disabled);
    const experimentTool = (name: string): RuntimeTool => ({
      name,
      action: "ui_meta",
      description: `${name} probe`,
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => { throw new Error(`${name} must not execute while experiments is disabled`); },
    });
    // A runner that still holds an experiments runtime cannot recruit the tools
    // into a request once the module is disabled: registration, not the
    // runtime, decides exposure.
    const activeRuntime = {
      tools: { initExperiment: experimentTool("init_experiment"), runExperiment: experimentTool("run_experiment"), logExperiment: experimentTool("log_experiment") },
      finalizeGrant: () => ({ skillIds: [], run: async () => { throw new Error("finalize must not run while experiments is disabled"); } }),
      guard: () => undefined,
      snapshot: () => ({ mode: { active: true, workDir: "/repo" }, configuration: null }),
    };
    const modules = composeModuleRuntimes([["experiments", activeRuntime]]);
    const plan = await planToolExposure({
      kernel: testKernelToolDeps({
        userDataRoot: "/scratch",
        capabilities: capabilityAccessHolding(MODULE_IDS.filter((id) => id !== "experiments")),
        backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
        moduleSnapshot: disabled,
      }),
      modules,
      registry,
    });
    for (const name of ["init_experiment", "run_experiment", "log_experiment"]) {
      expect(registry.has(name)).toBe(false);
      expect(plan.tools.has(name)).toBe(false);
    }
    expect(disabled.contributions.some((entry) => entry.domain === "commands" && entry.id === "experiment")).toBe(false);
    expect(disabled.contributions.some((entry) => entry.domain === "promptFragments" && entry.id === "experiments-active")).toBe(false);
    expect(disabled.observers.map(({ seam }) => seam)).not.toContain("chat");
    expect(disabled.gates).toEqual([]);
    // The active-experiment prompt fragment is a contribution of the module, so
    // it is pinned with the request's module snapshot: an enabled composition
    // renders it over an active runtime, a disabled one carries nothing to render.
    const fragmentInput = { kernel: testKernelToolDeps(), modules, tools: new Map(), memorySnapshot: null, capabilities: promptCapabilities([]) };
    const enabledFragment = composeFirstPartyModules().contributions.find((entry) => entry.domain === "promptFragments" && entry.id === "experiments-active");
    if (enabledFragment?.domain !== "promptFragments") throw new Error("missing experiments prompt fragment");
    expect(await enabledFragment.value.render(fragmentInput)).toContain("Experiment Mode (ACTIVE)");
    expect(await enabledFragment.value.render({ ...fragmentInput, modules: NO_MODULE_RUNTIMES })).toBeUndefined();

    const historical: ExperimentFact = {
      type: "experiment.mode.changed",
      version: 1,
      actor: "flywheel",
      payload: { active: false, workDir: "/repo" },
    };
    expect(parseExperimentFact(historical)).toEqual(historical);
    expect(parseSessionFact(historical)).toEqual(historical);
  });
});
