import { describe, expect, it } from "bun:test";
import { composeModuleRuntimes, NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { createToolRegistry } from "../../../../../src/orchestration/tool-catalog.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { KernelToolDeps } from "../../../../../src/orchestration/agent-runtime/tools/kernel-tool-deps.js";
import { planToolExposure, type ToolExposureInput } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { learningReviewToolNames, toolRegistryFromComposition, type RegisteredTool } from "../../../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import { mcpPortsOver, mcpRuntimeOver } from "../../../../helpers/mcp.js";
import { codeModeRuntimeOver } from "../../../../helpers/code-mode-worker.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { unusedSessionMessaging } from "../../../../helpers/child-session-control.js";
import type { ToolAction } from "../../../../../src/infra/workflow-types.js";
const toolRegistrations = Object.fromEntries(createToolRegistry());

function getRegistration(name: string): RegisteredTool {
  const value = toolRegistrations[name];
  if (value === undefined) throw new Error(`Missing tool registration: ${name}`);
  return value;
}

type RuntimeEntries = readonly (readonly [string, unknown])[];
function plan(kernel: Partial<KernelToolDeps> = {}, runtimes: RuntimeEntries = [], rest: Omit<ToolExposureInput, "kernel" | "modules"> = {}) {
  return planToolExposure({ kernel: testKernelToolDeps({ userDataRoot, ...kernel }), modules: composeModuleRuntimes(runtimes), ...rest });
}

const expected = {
  core: ["apply_patch", "bash", "edit", "list", "read", "search", "write"],
  ambient: ["handoff", "list_sessions", "message_session", "models", "init_experiment", "log_experiment", "checkpoint_read", "checkpoint_replace", "checkpoint_decide", "papercut_dispose", "papercut_log", "process.native", "run_experiment", "skill"],
  "opt-in": ["definition_overrides", "memory", "recall", "skill_manage", "ask_user", "code", "subagent", "web", "workflow"],
} as const;
const categories = ["core", "ambient", "opt-in"] as const;
const defaultCore = ["bash", "edit", "list", "read", "search", "write"];
const logicalName = (name: string): string => toolRegistrations[name]?.tool ?? name;
const providerNames = (names: readonly string[]): string[] => [...new Set(names.map(logicalName))];

const { userDataRoot } = testDirectories(process.cwd());
const ALL_CAPABILITIES = { available: () => true };
const backgroundTasks = () => createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
const mcpHit = { server: "github", name: "issue_get", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
const mcp = ["mcp", mcpRuntimeOver(mcpPortsOver([mcpHit]))] as const;
const webSearch = {
  available: () => true,
  run: async () => { throw new Error("unused in this test"); },
};

const sessions = unusedSessionMessaging();

const missingSurfaceReasons = {
  checkpoint_read: "no owning conversation checkpoint available",
  checkpoint_replace: "no owning conversation checkpoint available",
  checkpoint_decide: "no owning conversation checkpoint available",
  models: "no live model access capture available",
  definition_overrides: "no definition override projection available",
  memory: "no memory store available",
  recall: "no conversation history available",
  skill: "no skill registry available",
  skill_manage: "no skill store available",
  ask_user: "no ask-user controller available",
  init_experiment: "no experiment session available",
  run_experiment: "no experiment session available",
  log_experiment: "no experiment session available",
  subagent: "no subagent registry available",
  workflow: "no workflow starter available",
} as const;
/** Ambient tools a runner without the owning surface still exposes. */
const ambientExposed = expected.ambient.filter((name) => !(name in missingSurfaceReasons));

interface RunnerContract {
  readonly name: string;
  readonly selected?: readonly string[];
  readonly exposed: readonly string[];
  readonly omitted: Readonly<{ [name: string]: string }>;
}

const normalRunnerContracts: readonly RunnerContract[] = [
  {
    name: "chat",
    exposed: providerNames([...defaultCore, ...ambientExposed, "code", "web"]),
    omitted: { ...missingSurfaceReasons },
  },
  {
    name: "step worker",
    exposed: providerNames([...defaultCore, ...ambientExposed, "code", "web"]),
    omitted: { ...missingSurfaceReasons },
  },
  {
    name: "persona child",
    selected: ["read", "search", "web", "code", "handoff"],
    exposed: ["read", "search", "handoff", "list_sessions", "message_session", "papercut_dispose", "papercut_log", "process", "code", "web"],
    omitted: {
      bash: "not in selected allowlist",
      edit: "not in selected allowlist",
      list: "not in selected allowlist",
      write: "not in selected allowlist",
      ...missingSurfaceReasons,
      definition_overrides: "not in selected allowlist",
      memory: "not in selected allowlist",
      recall: "not in selected allowlist",
      skill_manage: "not in selected allowlist",
      ask_user: "not in selected allowlist",
      subagent: "not in selected allowlist",
      workflow: "not in selected allowlist",
    },
  },
  {
    name: "general clone",
    selected: [...defaultCore, "definition_overrides", "memory", "skill", "skill_manage", "code", "web", "handoff"],
    exposed: [...defaultCore, "handoff", "list_sessions", "message_session", "papercut_dispose", "papercut_log", "process", "code", "web"],
    omitted: {
      ...missingSurfaceReasons,
      recall: "not in selected allowlist",
      ask_user: "not in selected allowlist",
      subagent: "not in selected allowlist",
      workflow: "not in selected allowlist",
    },
  },
];

async function assertCanonicalContract(contract: RunnerContract): Promise<void> {
  const planned = await plan({
    capabilities: ALL_CAPABILITIES,
    backgroundTasks: backgroundTasks(),
    handoff: {},
    sessions,
  }, [["web", () => webSearch], mcp, ["code-mode", codeModeRuntimeOver()]], contract.selected ? { selected: new Set(contract.selected) } : {});
  const registrationIds = Object.keys(toolRegistrations);
  const canonicalNames = [...new Set(registrationIds.map(logicalName))];
  const omitted = new Map(planned.omitted.filter(({ name }) => canonicalNames.includes(name)).map(({ name, reason }) => [name, reason]));

  expect([...planned.tools.keys()].filter((name) => canonicalNames.includes(name)).sort(), contract.name).toEqual([...contract.exposed].sort());
  expect(Object.fromEntries(omitted), contract.name).toEqual(contract.omitted);
  expect([...contract.exposed, ...omitted.keys()].sort(), contract.name).toEqual(canonicalNames.sort());
  if (contract.name === "persona child" || contract.name === "general clone") {
    expect(planned.eligibleTools.has("github.issue_get"), contract.name).toBe(true);
    expect(planned.tools.has("github.issue_get"), contract.name).toBe(false);
  }
}

describe("runtime tool exposure contract", () => {
  it("classifies every canonical tool in one exact category", () => {
    expect(Object.keys(toolRegistrations).sort()).toEqual(Object.values(expected).flat().sort());
    for (const category of categories) {
      for (const name of expected[category]) expect(getRegistration(name).category).toBe(category);
    }
  });

  it("resolves one logical edit registration to the selected provider contract", async () => {
    expect(getRegistration("edit").action).toBe("file_edit");
    expect(getRegistration("apply_patch")).toMatchObject({ action: "file_edit", tool: "edit" });
    expect(getRegistration("write").action).not.toBe("file_edit");

    for (const fileEditContract of ["edit", "apply_patch"] as const) {
      const planned = await plan({ capabilities: ALL_CAPABILITIES, fileEditContract }, [], { selected: new Set(["edit", "write"]) });
      const expectedTools: Array<"edit" | "apply_patch" | "write"> = [fileEditContract, "write"];
      expect([...planned.tools.keys()].filter((name): name is "edit" | "apply_patch" | "write" => name === "edit" || name === "apply_patch" || name === "write").sort())
        .toEqual(expectedTools.sort());
      expect(planned.registrationIdentities.get(fileEditContract)).toBe("edit");
    }
  });

  it("assigns contributed tools to one module and keeps kernel tools outside module ownership", () => {
    const composition = composeFirstPartyModules();
    const ownership = composition.contributions.filter((entry) => entry.domain === "tools").map((entry) => entry.id);
    const toolNames = new Set(Object.values(toolRegistrations).map((registration) => registration.tool));
    expect(ownership.toSorted()).toEqual([...toolNames].filter((name) => !["handoff", "list_sessions", "message_session", "models", "checkpoint_read", "checkpoint_replace", "checkpoint_decide", "process"].includes(name)).toSorted());
    expect(new Set(ownership).size).toBe(ownership.length);

    const withoutFiles = toolRegistryFromComposition(composeFirstPartyModules(undefined, ["file-tools"]));
    expect([...withoutFiles.keys()]).not.toContainAnyValues(["apply_patch", "edit", "read", "write"]);
    expect(withoutFiles.has("handoff")).toBe(true);
    const withoutDiscovery = toolRegistryFromComposition(composeFirstPartyModules(undefined, ["discovery"]));
    expect([...withoutDiscovery.keys()]).not.toContainAnyValues(["list", "search"]);
    const withoutRuntimeModules = toolRegistryFromComposition(composeFirstPartyModules(undefined, ["ask-user", "recall"]));
    expect([...withoutRuntimeModules.keys()]).not.toContainAnyValues(["ask_user", "recall"]);
    for (const name of ["handoff", "process.native"]) expect(withoutRuntimeModules.has(name)).toBe(true);

    expect(toolRegistryFromComposition(composeFirstPartyModules(undefined, ["code-mode"])).has("code")).toBe(false);
    expect(toolRegistryFromComposition(composeFirstPartyModules(undefined, ["development"])).has("development")).toBe(false);
  });

  it("every registration a bare kernel can build carries the name and action it registers", () => {
    const deps = { kernel: testKernelToolDeps({ userDataRoot, handoff: {} }), modules: NO_MODULE_RUNTIMES };
    // The recall tool shows the `search` action to clients while its policy
    // action is `ui_meta`. The divergence predates its shared definition.
    const displayActions = new Map<string, ToolAction>([["recall", "search"]]);
    const built: string[] = [];
    for (const [name, entry] of Object.entries(toolRegistrations)) {
      const result = entry.create(deps);
      if (result.unusable) {
        expect(result.unusable.tool.name, name).toBe(entry.exposedName ?? name);
        expect(result.unusable.tool.action, name).toBe(displayActions.get(name) ?? entry.action);
        expect(result.unusable.reason, name).toBeString();
        continue;
      }
      if (!result.tool) {
        expect(result.reason, name).toBeString();
        continue;
      }
      built.push(name);
      expect(result.tool.name).toBe(entry.exposedName ?? name);
      expect(result.tool.action).toBe(entry.action);
    }
    expect(built.toSorted()).toEqual(["apply_patch", "bash", "edit", "handoff", "list", "papercut_dispose", "papercut_log", "read", "search", "write"]);
  });

  it("grants self-improvement review execution to exactly the learning surfaces", () => {
    expect([...learningReviewToolNames(createToolRegistry())].sort()).toEqual(["checkpoint_decide", "checkpoint_read", "checkpoint_replace", "memory", "skill", "skill_manage"]);
  });

  for (const contract of normalRunnerContracts) {
    it(`pins every canonical tool for ${contract.name}`, async () => assertCanonicalContract(contract));
  }

  it("pins child omissions when web and code surfaces are missing", async () => {
    for (const name of ["persona child", "general clone"]) {
      const planned = await plan({ capabilities: ALL_CAPABILITIES, backgroundTasks: backgroundTasks(), handoff: {} }, [], { selected: new Set(["read", "web", "code", "handoff"]) });
      expect(planned.omitted, name).toContainEqual({ name: "web", reason: "no web search provider available (connect ChatGPT or Exa in /auth)" });
      expect(planned.omitted, name).toContainEqual({ name: "code", reason: "code mode is not wired" });
      expect(planned.eligibleTools.has("github.issue_get"), name).toBe(false);
    }
  });

  it("evaluates definition override availability for each plan", async () => {
    let available = true;
    const definitionOverrides = {
      available: () => available,
      list: async () => ({ overrides: [], diagnostics: [] }),
      diff: async () => { throw new Error("unused"); },
      prepare: async () => { throw new Error("unused"); },
      apply: async () => {},
      refresh: async () => {},
      proposal: () => undefined,
      finalizeSkillPublication: async () => {},
    };
    const overrides = async () => plan({ capabilities: ALL_CAPABILITIES }, [["definition-overrides", definitionOverrides]]);

    expect((await overrides()).tools.has("definition_overrides")).toBe(true);
    available = false;
    const resolved = await overrides();
    expect(resolved.tools.has("definition_overrides")).toBe(false);
    expect(resolved.omitted).toContainEqual({ name: "definition_overrides", reason: "no definition override projection available" });
  });

  it("pins every process policy branch", async () => {
    const noOwner = await plan({ capabilities: ALL_CAPABILITIES });
    expect(noOwner.omitted).toContainEqual({ name: "process", reason: "no background execution owner available" });

    const disabled = { available: () => false };
    const idle = await plan({ capabilities: disabled, backgroundTasks: backgroundTasks() });
    expect(idle.omitted).toContainEqual({
      name: "process",
      reason: "no background task is running, and background-commands, subagents, workflows are turned off. Turn them on in Settings, or remove them from disabled_modules in flywheel.toml",
    });

    const activeOwner = backgroundTasks();
    activeOwner.track({ done: new Promise(() => {}), meta: { id: "task-1", type: "background_command", description: "server" } });
    const active = await plan({ capabilities: disabled, backgroundTasks: activeOwner });
    expect(active.tools.has("process")).toBe(true);
  });

});
