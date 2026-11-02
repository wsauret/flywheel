/** The optional-capability delivery across every surface it owns (PI-CAP-001).
 *
 *  Integration tier: the subject is one live composition of the real modules
 *  over a real config file, a real skill store, and the installed definitions -
 *  the config boundary and its ownership lock, the process policy, the
 *  capability protocol projection, definition availability, the runtime command
 *  catalog bound to the live skill watcher, the model tool surface, and workflow
 *  admission. Each seam has unit coverage of its own decision; what only this
 *  tier can show is that one file change moves all of them together, that a
 *  second process is ordered against this one, and that admitted work settles
 *  after the capability it holds is disabled.
 *
 *  These cases characterize shipped behavior, so none of them started red. */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ContainedDirectory } from "../../../src/infra/descriptor-directory.js";
import { moduleProtocolRows, type ModuleId, composeFirstPartyModules, composeRealmModuleSnapshot, SHIPPED_MODULES, migrateLegacyCapabilityModules, effectiveModuleIds } from "../../../src/orchestration/modules.js";
import { composeModuleRuntimes } from "../../../src/infra/module-runtime.js";
import { capabilityAccessFor } from "../../../src/orchestration/agent-runtime/tools/types.js";
import { testKernelToolDeps } from "../../helpers/request-tool-surface.js";
import { createBackgroundWorkRegistry } from "../../../src/orchestration/agent-runtime/background-work.js";
import { planToolExposure } from "../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { toolRegistryFromComposition } from "../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import type { SkillManageToolDeps } from "../../../src/orchestration/modules/learning/tools/skill-manage.js";
import type { WorkflowToolDeps } from "../../../src/orchestration/agent-runtime/tools/workflow-tool.js";
import type { AskUserController } from "../../../src/orchestration/runner/ask-user-controller.js";
import { createModuleProjection } from "../../../src/orchestration/app-service/module-projection.js";
import { createCommandCatalogProjection } from "../../../src/orchestration/app-service/command-catalog-projection.js";
import { createDefinitionAvailability } from "../../../src/orchestration/app-service/definition-availability.js";
import { watchDefinitionRoots } from "../../../src/orchestration/app-service/definition-root-watcher.js";
import type { RuntimeUiPatchInput } from "../../../src/protocol/runtime-ui-protocol-types.js";
import type { RuntimeModulesView } from "../../../src/protocol/module-protocol-types.js";
import { startModulePolicy } from "../../../src/orchestration/config/module-policy.js";
import { decodeModuleState } from "../../../src/orchestration/config/module-descriptor.js";
import { admitWorkflowOperation } from "../../../src/orchestration/workflow-host/workflow-admission.js";
import { loadWorkflowFile } from "../../../src/workflows/workflow-file.js";
import { moduleRequirementsForContribution } from "../../../src/orchestration/module-requirements.js";
import { createProjectDefinitionRegistry } from "../../../src/workflows/definition-registry.js";
import { makeContext } from "../../unit/orchestration/agent-runtime/tools/_fixtures.js";
import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
import { canonicalModuleIds, missingModuleIds, MODULE_IDS, moduleDisabledReason } from "../../../src/protocol/module-ids.js";

const REPO = join(import.meta.dir, "..", "..", "..");
/** One installed workflow every case admits against. */
const WORKFLOW_ID = "debug";
const POLL_MS = 5;

const ASK_USER_CONTROLLER: AskUserController = {
  ask: async () => { throw new Error("unused in this test"); },
  answerQuestion: () => {},
  cancelQuestion: () => {},
  suspendAll: () => false,
};

const disposals: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});

// Real filesystem events land a few event loop turns later; poll instead of
// sleeping a fixed guess so the case is neither slow nor flaky.
async function waitFor(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

interface Harness {
  readonly configPath: string;
  readonly skillRoot: string;
  readonly policy: Awaited<ReturnType<typeof startModulePolicy>>["policy"];
  readonly definitions: ReturnType<typeof createProjectDefinitionRegistry>;
  readonly availability: Awaited<ReturnType<typeof createDefinitionAvailability>>;
  readonly moduleProjection: Awaited<ReturnType<typeof createModuleProjection>>;
  readonly commandCatalog: ReturnType<typeof createCommandCatalogProjection>;
  /** Every capability view this runtime published, oldest first. */
  readonly publishedViews: () => readonly { capabilities: readonly ModuleId[]; workflowsMode: string; warnings: readonly string[]; error?: string }[];
  readonly configText: () => string;
  /** The model tool surface one request would be planned with, under the live
   *  policy or under an operation's own grant. */
  readonly toolPlan: (access?: ReturnType<typeof capabilityAccessFor>) => ReturnType<typeof planToolExposure>;
  readonly access: () => ReturnType<typeof capabilityAccessFor>;
}

/** Compose one runtime's capability surfaces over a real config file, exactly as
 *  `composeRuntime` wires them: the policy owns the selection, availability and
 *  the capability projection follow it, and the command catalog publishes from
 *  the same availability owner. */
async function startHarness(configSource = ""): Promise<Harness> {
  const caseDir = mkdtempSync(join(tmpdir(), "flywheel-harness-capabilities-"));
  disposals.push(() => { rmSync(caseDir, { recursive: true, force: true }) });
  const configPath = join(caseDir, "flywheel.toml");
  writeFileSync(configPath, configSource);
  const projectRoot = join(caseDir, "project");
  const userDataRoot = join(caseDir, "account");
  const skillRoot = join(caseDir, "skills");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(userDataRoot, { recursive: true });
  writeSkill(skillRoot, "probe.plain", "Probe plain");

  const directories = { projectRoot, userDataRoot, accountHome: caseDir };
  const started = await startModulePolicy({ configPath });
  const capabilities = started.policy;
  const moduleSelection = () => composeRealmModuleSnapshot(capabilities.state());
  // The watch starts before the registry loads, exactly as `composeRuntime`
  // orders them, so a skill written after this point reaches the registry.
  const skillRoots = [{ dir: skillRoot, owned: true, reach: "global" }] as const;
  const definitionWatch = watchDefinitionRoots({ roots: skillRoots, debounceMs: POLL_MS });
  disposals.push(() => definitionWatch.dispose());
  const definitions = createProjectDefinitionRegistry({ bundles: [], ...directories, skillRoots });
  const availability = await createDefinitionAvailability({ definitions, capabilities });
  const unsubscribe = capabilities.onChange(() => { void availability.refresh() });
  disposals.push(unsubscribe);

  const patches: RuntimeUiPatchInput[] = [];
  const moduleProjection = await createModuleProjection({
    location: { configPath },
    capabilities,
    publish: (patch) => { patches.push(patch) },
    persistentProcesses,
    settlePublication: async () => { await availability.refresh() },
  });
  disposals.push(() => { moduleProjection.dispose() });
  const commandCatalog = createCommandCatalogProjection({
    definitions,
    availability,
    moduleSelection,
    publish: (patch) => { patches.push(patch) },
    watch: definitionWatch,
  });
  disposals.push(() => { commandCatalog.dispose() });

  const access = () => capabilityAccessFor(capabilities);
  const toolPlan = (granted?: ReturnType<typeof capabilityAccessFor>) => {
    const requestAccess = granted ?? access();
    const composition = composeFirstPartyModules(SHIPPED_MODULES, MODULE_IDS.filter((id) => !requestAccess.available(id)));
    const skillManage: SkillManageToolDeps = { userDataRoot, origin: { kind: "agent", sessionId: "session-under-test" }, registry: () => definitions.skills() };
    return planToolExposure({
      kernel: testKernelToolDeps({
        userDataRoot,
        capabilities: requestAccess,
        skills: definitions.skills(),
        ...(requestAccess.available("ask-user") ? { askUser: ASK_USER_CONTROLLER } : {}),
        backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
        moduleSnapshot: composition,
      }),
      modules: composeModuleRuntimes([
        // No case launches a workflow file, so no launch needs this session's tool or persona authority.
        ["workflows", { deps: () => workflowDeps(moduleProjection.workflowsMode()), authority: () => ({ toolActions: new Set(), personas: new Set() }) }],
        ["learning", { memory: { accountHome: caseDir, sessionId: "session-under-test" }, skillManage }],
      ]),
      registry: toolRegistryFromComposition(composition),
    });
  };

  return {
    configPath,
    skillRoot,
    policy: capabilities,
    definitions,
    availability,
    moduleProjection,
    commandCatalog,
    publishedViews: () => patches.flatMap((patch) => patch.payload.kind === "modules.changed" ? [patch.payload.capabilities] : []),
    configText: () => readFileSync(configPath, "utf8"),
    toolPlan,
    access,
  };
}

/** Workflow tool deps of one mode. The planner reads the mode and the launch
 *  resolver only; no case here starts a workflow through the tool. */
function workflowDeps(mode: "off" | "ask" | "on"): WorkflowToolDeps {
  return {
    startWorkflow: async () => ({ error: "no launch happens in this test" }),
    onRenderEvent: () => {},
    mode,
    resolveLaunchTarget: async () => ({ error: "no launch happens in this test" }),
    executionCwd: "/project",
  };
}

function writeSkill(root: string, id: string, trigger: string): void {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, "SKILL.md"), `---\ndescription: ${trigger}\n---\nBody.`);
}

function availableSkillIds(harness: Harness): readonly string[] {
  return [...harness.availability.snapshot().skills].filter(([, skill]) => skill.available).map(([id]) => id).toSorted();
}

function builtIn(harness: Harness, id: string): boolean {
  return harness.commandCatalog.snapshot().builtInCommands.some((command) => command.id === id);
}

async function admitWorkflow(harness: Harness) {
  return await admitWorkflowOperation({
    capabilities: harness.policy,
    availability: harness.availability,
    operation: `the ${WORKFLOW_ID} workflow`,
    resolve: (revision) => {
      const loaded = loadWorkflowFile({ file: "probe.workflow.yaml", content: "id: probe\nname: Probe\nphases:\n  - phase: work\n    brief: Do the work.\n    writes: []\n", location: undefined, provenance: { layer: "session", filePath: "probe.workflow.yaml" }, skills: revision.skills });
      return loaded.ok ? { ok: true, workflow: loaded.workflow } : { ok: false, reason: "the file is not valid", diagnostics: loaded.diagnostics };
    },
  });
}

// In the key order `persistentProcessPolicy` produces: the projection compares
// views by their serialized bytes, so a reordered fixture reads as a change.
const persistentProcesses = { persisted: false, forcedByCli: false, effective: false } as const;

function expectedCapabilityView(
  moduleIds: readonly ModuleId[],
  requireWorkflowConfirmation = false,
  descriptorIdentity = decodeModuleState("").identity,
): RuntimeModulesView {
  const selected = new Set(moduleIds);
  const composition = composeFirstPartyModules(
    SHIPPED_MODULES,
    MODULE_IDS.filter((id) => !selected.has(id)),
  );
  return {
    capabilities: moduleIds,
    moduleIds,
    descriptorIdentity,
    modules: moduleProtocolRows(moduleIds),
    warnings: composition.warnings,
    requireWorkflowConfirmation,
    workflowsMode: moduleIds.includes("workflows") ? (requireWorkflowConfirmation ? "ask" : "on") : "off",
    persistentProcesses,
  };
}

// The capabilities that run under a migrated legacy selection: the migration keeps
// every module the features vocabulary never named, and
// a module whose dependency the selection leaves off runs off too.
function migratedLegacyCapabilities(moduleIds: readonly string[]): readonly ModuleId[] {
  const selection = migrateLegacyCapabilityModules(moduleIds);
  if (!selection.ok) throw new Error(selection.error);
  return effectiveModuleIds(selection.moduleIds);
}

describe("one runtime's optional capability surfaces", () => {
  it("offers the complete roster under Full and launches a model workflow without a question", async () => {
    const harness = await startHarness();

    expect(harness.moduleProjection.view()).toEqual(expectedCapabilityView(MODULE_IDS));
    expect(availableSkillIds(harness)).toContain("probe.plain");
    expect(harness.commandCatalog.snapshot()).not.toHaveProperty("workflows");
    expect(harness.commandCatalog.snapshot()).not.toHaveProperty("assignableBriefs");
    expect(builtIn(harness, "bg")).toBe(true);
    expect(builtIn(harness, "learn")).toBe(true);

    const plan = await harness.toolPlan();
    for (const name of ["skill", "memory", "skill_manage", "workflow"]) expect(plan.tools.has(name)).toBe(true);
    expect(plan.tools.get("bash")?.description).toContain("background: true");
    expect((await admitWorkflow(harness)).ok).toBe(true);
    const moduleSnapshot = composeRealmModuleSnapshot(harness.policy.state());
    expect(moduleSnapshot.enabledModuleIds).toContain("workflows");
    expect(moduleSnapshot.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "settings", id: "workflows" }),
      expect.objectContaining({ domain: "tools", id: "workflow" }),
      expect.objectContaining({ domain: "settings", id: "background-commands" }),
      expect.not.objectContaining({ domain: "commands", id: "bg" }),
    ]));
  });

  it("publishes every Minimal projection before the capability mutation resolves", async () => {
    const harness = await startHarness();

    expect(await harness.moduleProjection.setModules("minimal", harness.moduleProjection.view())).toEqual({ ok: true });

    expect(harness.moduleProjection.view()).toEqual(expectedCapabilityView([], false, harness.policy.state().identity));
    expect(harness.publishedViews().at(-1)).toEqual(expectedCapabilityView([], false, harness.policy.state().identity));
    expect(availableSkillIds(harness)).toEqual([]);
    expect(builtIn(harness, "bg")).toBe(false);
    expect(builtIn(harness, "learn")).toBe(false);
    // No dispatchable persona survives, so nothing below a request can reach one.
    expect([...harness.availability.snapshot().availablePersonas.keys()]).toEqual([]);

    const plan = await harness.toolPlan();
    for (const name of ["bash", "skill", "memory", "skill_manage", "workflow"]) expect(plan.tools.has(name)).toBe(false);
    expect(plan.tools.has("process")).toBe(false);
    expect(plan.omitted.find((entry) => entry.name === "process")?.reason).toContain("disabled_modules in flywheel.toml");

    const refusal = await admitWorkflow(harness);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error("expected a refusal");
    const missing = missingModuleIds(["skills", "workflows"], []);
    expect(refusal.reason).toBe(`the ${WORKFLOW_ID} workflow is unavailable: ${moduleDisabledReason(missing)}`);

    // The control that repairs the selection is the same one that closed it.
    expect(await harness.moduleProjection.setModule("skills", harness.moduleProjection.view().capabilities.includes("skills"), true)).toEqual({ ok: true });
    expect(composeRealmModuleSnapshot({ moduleIds: ["workflows"] }).enabledModuleIds).toEqual([]);
    expect(harness.moduleProjection.view().capabilities).toEqual(["skills"]);
  });

  it("changes the next request and the command roster on a custom selection, with no restart", async () => {
    const harness = await startHarness('features = ["skills", "learning", "background_commands"]\n');
    expect(builtIn(harness, "bg")).toBe(true);

    expect(harness.moduleProjection.view().workflowsMode).toBe("off");
    expect(availableSkillIds(harness)).toContain("probe.plain");
    expect((await harness.toolPlan()).tools.has("memory")).toBe(true);

    expect(await harness.moduleProjection.setModule("learning", harness.moduleProjection.view().capabilities.includes("learning"), false)).toEqual({ ok: true });

    expect(harness.moduleProjection.view().capabilities).toEqual(
      canonicalModuleIds(migratedLegacyCapabilities(["skills", "learning", "background_commands"])).filter((id) => id !== "learning"),
    );
    // The same runtime, the same projections: the next planned request loses the
    // Learning surfaces while the skill roster it never named is untouched.
    const plan = await harness.toolPlan();
    expect(plan.tools.has("memory")).toBe(false);
    expect(plan.tools.has("skill_manage")).toBe(false);
    expect(plan.tools.has("skill")).toBe(true);
    expect(availableSkillIds(harness)).toContain("probe.plain");
    expect(builtIn(harness, "learn")).toBe(false);
  });

  it("pins an in-flight Bash and provider composition while later requests follow live module changes", async () => {
    const harness = await startHarness();
    const inFlight = composeRealmModuleSnapshot(harness.policy.state());
    expect(toolRegistryFromComposition(inFlight).has("bash")).toBe(true);
    expect(accessProviderRegistry(inFlight).factories.has("anthropic_api")).toBe(true);

    expect(await harness.moduleProjection.setModule("bash", harness.moduleProjection.view().capabilities.includes("bash"), false)).toEqual({ ok: true });
    expect(await harness.moduleProjection.setModule("provider-anthropic-api", harness.moduleProjection.view().capabilities.includes("provider-anthropic-api"), false)).toEqual({ ok: true });

    const nextRequest = composeRealmModuleSnapshot(harness.policy.state());
    expect(toolRegistryFromComposition(nextRequest).has("bash")).toBe(false);
    expect(accessProviderRegistry(nextRequest).factories.has("anthropic_api")).toBe(false);
    expect(toolRegistryFromComposition(inFlight).has("bash")).toBe(true);
    expect(accessProviderRegistry(inFlight).factories.has("anthropic_api")).toBe(true);

    expect(await harness.moduleProjection.setModule("bash", harness.moduleProjection.view().capabilities.includes("bash"), true)).toEqual({ ok: true });
    expect(await harness.moduleProjection.setModule("provider-anthropic-api", harness.moduleProjection.view().capabilities.includes("provider-anthropic-api"), true)).toEqual({ ok: true });

    const restoredRequest = composeRealmModuleSnapshot(harness.policy.state());
    expect(toolRegistryFromComposition(restoredRequest).has("bash")).toBe(true);
    expect(accessProviderRegistry(restoredRequest).factories.has("anthropic_api")).toBe(true);
  });

  it("pins an in-flight experiments composition while later requests and the command roster follow live module changes", async () => {
    const harness = await startHarness();
    const inFlight = composeRealmModuleSnapshot(harness.policy.state());
    const experimentSurface = (snapshot: ReturnType<typeof composeRealmModuleSnapshot>) => ({
      tools: ["init_experiment", "run_experiment", "log_experiment"].filter((name) => toolRegistryFromComposition(snapshot).has(name)),
      command: snapshot.contributions.some((contribution) => contribution.domain === "commands" && contribution.id === "experiment"),
      continuation: snapshot.observers.some(({ seam }) => seam === "chat"),
    });
    const admitted = { tools: ["init_experiment", "run_experiment", "log_experiment"], command: true, continuation: true };
    expect(experimentSurface(inFlight)).toEqual(admitted);
    expect(builtIn(harness, "experiment")).toBe(true);

    expect(await harness.moduleProjection.setModule("experiments", harness.moduleProjection.view().capabilities.includes("experiments"), false)).toEqual({ ok: true });

    // Only admission decided after the change sees the loss: the request that
    // pinned the earlier composition keeps every experiment surface it holds.
    expect(experimentSurface(composeRealmModuleSnapshot(harness.policy.state()))).toEqual({ tools: [], command: false, continuation: false });
    expect(builtIn(harness, "experiment")).toBe(false);
    expect(experimentSurface(inFlight)).toEqual(admitted);

    expect(await harness.moduleProjection.setModule("experiments", harness.moduleProjection.view().capabilities.includes("experiments"), true)).toEqual({ ok: true });
    expect(experimentSurface(composeRealmModuleSnapshot(harness.policy.state()))).toEqual(admitted);
    expect(builtIn(harness, "experiment")).toBe(true);
  });

  it("enables experiments for a retired module snapshot that predates it", async () => {
    // A retired `modules` snapshot cannot state a decision about modules that
    // shipped after it, so migration reads them as enabled.
    const harness = await startHarness('modules = ["skills"]\n');

    expect(harness.moduleProjection.view().capabilities).toEqual(canonicalModuleIds(["definition-overrides", "experiments", "mcp", "papercuts", "project-notifications", ...MODULE_IDS.filter((id) => id.startsWith("provider-")), "side-question", "skills"]));
    expect(composeRealmModuleSnapshot(harness.policy.state()).enabledModuleIds).toContain("experiments");
    expect(builtIn(harness, "experiment")).toBe(true);
  });

  it("applies the Full preset's workflow confirmation preference", async () => {
    const harness = await startHarness();

    expect(await harness.moduleProjection.setWorkflowMode(harness.moduleProjection.view().workflowsMode, "ask")).toEqual({ ok: true });
    expect(harness.moduleProjection.view().workflowsMode).toBe("ask");

    expect(await harness.moduleProjection.setModules("minimal", harness.moduleProjection.view())).toEqual({ ok: true });
    expect(harness.moduleProjection.view().workflowsMode).toBe("off");
    expect(await harness.moduleProjection.setModules("full", harness.moduleProjection.view())).toEqual({ ok: true });

    expect(harness.moduleProjection.view().workflowsMode).toBe("on");
    expect(harness.configText()).toContain("require_workflow_confirmation = false");
  });

  it("refuses disabling Ask User in workflow Ask mode but allows it in On mode", async () => {
    const harness = await startHarness();
    expect(await harness.moduleProjection.setWorkflowMode(harness.moduleProjection.view().workflowsMode, "ask")).toEqual({ ok: true });

    const refused = await harness.moduleProjection.setModule("ask-user", harness.moduleProjection.view().capabilities.includes("ask-user"), false);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.error.message).toContain("Workflows in Ask mode requires the Ask User capability");
    expect((await harness.toolPlan()).tools.has("workflow")).toBe(true);

    expect(await harness.moduleProjection.setWorkflowMode(harness.moduleProjection.view().workflowsMode, "on")).toEqual({ ok: true });
    expect(await harness.moduleProjection.setModule("ask-user", harness.moduleProjection.view().capabilities.includes("ask-user"), false)).toEqual({ ok: true });
    const plan = await harness.toolPlan();
    expect(plan.tools.has("ask_user")).toBe(false);
    expect(plan.tools.has("workflow")).toBe(true);
  });

  it("withdraws a skill and refuses a stale launch after the capability is disabled", async () => {
    // Workflows depends on Skills, so a selection still holding Workflows would
    // refuse this change before it committed. This case is the one where the
    // change lands and a client is left rendering the roster it published.
    const harness = await startHarness('features = ["skills", "learning"]\n');
    const staleRoster = availableSkillIds(harness);
    expect(staleRoster).toContain("probe.plain");

    expect(await harness.moduleProjection.setModule("skills", harness.moduleProjection.view().capabilities.includes("skills"), false)).toEqual({ ok: true });

    // The skill a client last saw is no longer available, and a launch of a
    // workflow it still lists is refused.
    expect(harness.availability.snapshot().skills.get("probe.plain")?.available).toBe(false);
    expect((await admitWorkflow(harness)).ok).toBe(false);
  });

  it("keeps requests and admission on the retained selection until complete replacement repairs invalid bytes", async () => {
    const harness = await startHarness();
    const prior = harness.moduleProjection.view().capabilities;
    const source = 'modules = ["unknown-uat"]\nshow_thinking = true\n';
    writeFileSync(harness.configPath, source);
    await harness.policy.refresh();
    await harness.moduleProjection.refresh();
    const failed = harness.moduleProjection.view();
    expect(failed.capabilities).toEqual(prior);
    expect(failed.error).toContain("unknown-uat");
    expect(failed.warnings).toEqual([
      'flywheel.toml modules contains unknown id "unknown-uat". Flywheel keeps the last valid module selection until you fix it.',
    ]);
    expect(availableSkillIds(harness)).toContain("probe.plain");

    const nextRequest = await harness.toolPlan();
    const skill = nextRequest.tools.get("skill");
    expect(skill).toBeDefined();
    expect((await skill!.execute({ action: "load", skill_id: "probe.plain" }, makeContext())).outcome).toBe("ok");
    const admission = await harness.policy.admit({
      operation: "skill lifecycle maintenance",
      required: moduleRequirementsForContribution("tools", "skill_manage"),
    });
    expect(admission.ok).toBe(true);

    const publishedBeforeRepeat = harness.publishedViews().length;
    await harness.policy.refresh();
    await harness.moduleProjection.refresh();
    expect(harness.publishedViews().length).toBe(publishedBeforeRepeat);

    expect((await harness.moduleProjection.setModule("skills", harness.moduleProjection.view().capabilities.includes("skills"), true)).ok).toBe(false);
    expect(harness.configText()).toBe(source);

    expect(await harness.moduleProjection.setModules("full", harness.moduleProjection.view())).toEqual({ ok: true });
    expect(harness.moduleProjection.view()).toEqual(expectedCapabilityView(MODULE_IDS, false, harness.policy.state().identity));
    expect((await harness.policy.admit({
      operation: "skill lifecycle maintenance",
      required: moduleRequirementsForContribution("tools", "skill_manage"),
    })).ok).toBe(true);
    expect(harness.configText()).toContain("show_thinking = true");
  });

  it("writes nothing and publishes nothing when a selection change is refused before it commits", async () => {
    const harness = await startHarness('features = ["subagents"]\n');
    const before = harness.configText();
    const publishedBefore = harness.publishedViews().length;

    // A write that expects a Workflows mode the file no longer states is
    // refused before it commits.
    const stale = harness.moduleProjection.view().workflowsMode === "on" ? "ask" : "on";
    const refused = await harness.moduleProjection.setWorkflowMode(stale, "off");

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.error.message).toBe("The configuration changed before this update. Try again.");
    expect(harness.configText()).toBe(before);
    expect(harness.moduleProjection.view().capabilities).toEqual(migratedLegacyCapabilities(["subagents"]));
    expect(harness.publishedViews().length).toBe(publishedBefore);
  });

  it("keeps a committed change whose durability failed in effect on every surface", async () => {
    const harness = await startHarness();
    const original = ContainedDirectory.prototype.publishFileBytesThrough;
    // Inject after real publication at the shared boundary: the bytes are in
    // place and their durability is unknown. Windows flushes files, so a
    // directory-fsync injection cannot reach its durability result.
    let failed = false;
    const publication = spyOn(ContainedDirectory.prototype, "publishFileBytesThrough").mockImplementation(function (this: ContainedDirectory, pending, name, content, expected, metadata) {
      const attempt = original.call(this, pending, name, content, expected, metadata);
      if (attempt.status !== "published") return attempt;
      if (name === "flywheel.toml" && harness.configText().includes('"learning"') && !failed) {
        failed = true;
        return { status: "indeterminate", error: new Error("publication sync boom") };
      }
      return attempt;
    });
    try {
      const result = await harness.moduleProjection.setModule("learning", harness.moduleProjection.view().capabilities.includes("learning"), false);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected a committed write");
      expect(failed).toBe(true);
      expect(result.durabilityError?.message).toContain("publication sync boom");
    } finally {
      publication.mockRestore();
    }

    expect(harness.configText()).toContain('disabled_modules = ["learning"]');
    expect(harness.moduleProjection.view().capabilities).not.toContain("learning");
    expect(harness.publishedViews().at(-1)?.capabilities).not.toContain("learning");
    expect((await harness.toolPlan()).tools.has("memory")).toBe(false);
  });

  it("orders member changes made by other processes against this one", async () => {
    const harness = await startHarness();
    const barrier = join(harness.skillRoot, "..", "go");
    const script = join(harness.skillRoot, "..", "capability-worker.ts");
    writeFileSync(script, `
import { existsSync } from "node:fs";
import { updateModuleMember } from ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/config/module-selection-writer.js")).href)};

const feature = process.argv[2];
while (!existsSync(${JSON.stringify(barrier)})) await Bun.sleep(1);
const result = await updateModuleMember(feature, true, false, { configPath: ${JSON.stringify(harness.configPath)} });
if (!result.ok) {
  console.error(result.error.message);
  process.exit(1);
}
`);

    const children = ["learning", "subagents"].map((feature) =>
      Bun.spawn(["bun", script, feature], { cwd: REPO, stdout: "pipe", stderr: "pipe", windowsHide: true }));
    writeFileSync(barrier, "");
    const runs = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      err: await new Response(child.stderr).text(),
    })));
    for (const run of runs) expect(run.code === 0 ? "" : run.err).toBe("");

    // Neither removal lost the other: each writer re-read the stated selection
    // inside the ownership window it committed in.
    expect(harness.configText()).toContain('"learning"');
    expect(harness.configText()).toContain('"subagents"');
    // Admission reads the file under that same lock, so this process decides
    // from what the other processes committed and not from its own projection.
    expect(harness.moduleProjection.view().capabilities).toContain("learning");
    const admission = await harness.policy.admit({ operation: "the reflection review", required: ["skills", "learning"] });
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("expected a refusal");
    expect(admission.missing).toEqual(["learning"]);
    expect(harness.policy.state().capabilities).toEqual(
      canonicalModuleIds(MODULE_IDS.filter((id) => id !== "learning" && id !== "subagents")),
    );
  }, 60_000);

  it("allows only one process to commit the same member expectation", async () => {
    const harness = await startHarness();
    const barrier = join(harness.skillRoot, "..", "same-member-go");
    const script = join(harness.skillRoot, "..", "same-member-worker.ts");
    writeFileSync(script, `
import { existsSync } from "node:fs";
import { ConfigStaleWriteError } from ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/config/writer.js")).href)};
import { updateModuleMember } from ${JSON.stringify(pathToFileURL(join(REPO, "src/orchestration/config/module-selection-writer.js")).href)};

while (!existsSync(${JSON.stringify(barrier)})) await Bun.sleep(1);
const result = await updateModuleMember("learning", true, false, { configPath: ${JSON.stringify(harness.configPath)} });
if (!result.ok) process.exit(result.error instanceof ConfigStaleWriteError ? 2 : 1);
`);

    const children = [0, 1].map(() => Bun.spawn(["bun", script], { cwd: REPO, stdout: "pipe", stderr: "pipe", windowsHide: true }));
    writeFileSync(barrier, "");
    const codes = await Promise.all(children.map(async (child) => await child.exited));

    expect(codes.toSorted()).toEqual([0, 2]);
    expect(harness.configText()).toContain('disabled_modules = ["learning"]');
  }, 60_000);

  it("lets admitted work settle after its capability is disabled and refuses the next launch", async () => {
    const harness = await startHarness();
    const admitted = await admitWorkflow(harness);
    if (!admitted.ok) throw new Error(admitted.reason);
    const workerAccess = capabilityAccessFor(harness.policy, admitted.grant);

    expect(await harness.moduleProjection.setModules("minimal", harness.moduleProjection.view())).toEqual({ ok: true });

    // The operation that was already admitted keeps exactly the surface its
    // definition requires, so its own steps are never refused mid-run.
    expect(workerAccess.available("workflows")).toBe(true);
    expect(workerAccess.available("skills")).toBe(true);
    const settling = await harness.toolPlan(workerAccess);
    expect(settling.tools.has("skill")).toBe(true);
    expect(settling.tools.has("memory")).toBe(false);
    // The skill packages the run needs remain available while it settles.
    expect(admitted.availability.skills.get("probe.plain")?.available).toBe(true);

    // A new operation is decided by the current selection alone.
    expect((await admitWorkflow(harness)).ok).toBe(false);
    expect((await harness.toolPlan()).tools.has("skill")).toBe(false);
  });

  it("preserves installed definitions while disabled and restores the roster on re-enable", async () => {
    const harness = await startHarness();
    const roster = availableSkillIds(harness);
    const installed = harness.definitions.skills().skills.size;

    expect(await harness.moduleProjection.setModules("minimal", harness.moduleProjection.view())).toEqual({ ok: true });
    expect(harness.definitions.skills().skills.size).toBe(installed);

    // A package installed while Skills is off is still loaded; only its
    // availability is withheld.
    writeSkill(harness.skillRoot, "probe.installed-while-off", "Probe installed while off");
    await waitFor("the skill installed while Skills was off", () => harness.definitions.skills().skills.has("probe.installed-while-off"));
    expect(availableSkillIds(harness)).toEqual([]);

    expect(await harness.moduleProjection.setModules("full", harness.moduleProjection.view())).toEqual({ ok: true });

    expect(availableSkillIds(harness)).toEqual([...roster, "probe.installed-while-off"].toSorted());
    expect(harness.availability.snapshot().skills.get("probe.installed-while-off")?.available).toBe(true);
    expect((await admitWorkflow(harness)).ok).toBe(true);
  });
});
