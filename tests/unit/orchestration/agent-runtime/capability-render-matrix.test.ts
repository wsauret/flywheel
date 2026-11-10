import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_TYPE_PHRASES, capabilityMentions, realCapabilityVocabulary } from "../../../../scripts/capability-terms.js";
import { planPromptRequest, plannedCapabilities, promptParts, type PlannedRequest, type PromptAssembly } from "../../../../scripts/prompt-assembly.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import type { CapabilityCheck } from "../../../../src/infra/capability-text.js";
import { composeModuleRuntimes } from "../../../../src/infra/module-runtime.js";
import { createDefinitionAvailability, type DefinitionAvailabilitySnapshot } from "../../../../src/orchestration/app-service/definition-availability.js";
import { agentCapabilityCheck } from "../../../../src/orchestration/agent-runtime/capability-checks.js";
import { createCapabilityNarrowing } from "../../../../src/orchestration/agent-runtime/capability-narrowing.js";
import { renderCompactionOpening } from "../../../../src/orchestration/agent-runtime/agent-loop-compaction-state.js";
import { WAIT_EXPIRED_HANDLING } from "../../../../src/orchestration/agent-runtime/agent-loop-input-consumer.js";
import { enforceTurnBudget, limitOutput } from "../../../../src/orchestration/agent-runtime/compaction/truncation.js";
import { createPendingWorkNudge } from "../../../../src/orchestration/agent-runtime/pending-work-nudge.js";
import { availableToolNames } from "../../../../src/orchestration/agent-runtime/persona-tool-rules.js";
import { captureRuntimeConfigRequest } from "../../../../src/orchestration/agent-runtime/request-config.js";
import { interceptBashCommand } from "../../../../src/orchestration/agent-runtime/tools/bash-command-policy.js";
import type { AgentPurpose } from "../../../../src/orchestration/agent-runtime/types.js";
import type { RuntimeToolInput } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js";
import { DEVELOPMENT_MODULES } from "../../../../src/orchestration/development-modules.js";
import { installedDefinitionBundles } from "../../../../src/orchestration/module-catalog.js";
import { composeFirstPartyModules, effectiveModuleIds, SHIPPED_MODULES, workflowsModeOf, type FirstPartyModuleComposition } from "../../../../src/orchestration/modules.js";
import { reviewInstruction } from "../../../../src/orchestration/modules/learning/learning-review-prompts.js";
import { SUBAGENT_HANDOFF_SCHEMA } from "../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { installedPersonaToolEntries } from "../../../../src/orchestration/tool-catalog.js";
import type { ModuleId } from "../../../../src/protocol/module-ids.js";
import { personaInstructions } from "../../../../src/workflows/agents/persona-instructions.js";
import { grantedSubagentTypes, personaToolNames } from "../../../../src/workflows/agents/subagent-reachability.js";
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js";
import { compileOutput } from "../../../../src/workflows/output-contract/compile.js";
import { offeredSkillResources, readSkillResource } from "../../../../src/workflows/skill-context.js";
import { renderSkillContext, renderSkillResourceWindow } from "../../../../src/workflows/skill-render.js";
import { makeContext } from "./tools/_fixtures.js";

// The render matrix of capability-aware prompt text (ARCH-CONTEXT-033). For each module configuration it renders
// every surface that an agent reads, through the production assembly that the prompt dump uses, with a stand-in host
// for every module whose tool needs one, and checks it with the vocabulary of the capability-term lint: no text names
// a capability that is off. A lexical vocabulary cannot find an implied reference, such as a sentence that needs a
// background launch without naming it; the owner tests pin the known ones.

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const CATALOG = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES];
const ALL_IDS: readonly ModuleId[] = CATALOG.map((module) => module.id);
const vocabulary = await realCapabilityVocabulary(REPO_ROOT, CATALOG);
const terms = new Map(vocabulary.modules.map((module) => [module.id, module]));
/** The optional modules whose capability model text can name. */
const NAMED = vocabulary.modules.filter((module) => module.tools.length > 0 || module.skills.length > 0 || module.phrases.length > 0);

const root = mkdtempSync(join(tmpdir(), "flywheel-render-matrix-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, "image.bin"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));

// Bundled definitions only, and no user or project package. The request plans over the definitions of this test
// realm's installed catalog, whose requirements the kernel resolves; skill loads and persona bodies render from the
// definitions of the whole catalog, development included, whose requirements resolve against that catalog.
const bundledRegistry = (bundles: ReturnType<typeof installedDefinitionBundles>) => createProjectDefinitionRegistry({ projectRoot: root, userDataRoot: root, accountHome: root, skillRoots: [], bundles, personaToolEntries: installedPersonaToolEntries() });
const definitions = bundledRegistry(installedDefinitionBundles()).captureRevision();
const catalogRegistry = bundledRegistry(installedDefinitionBundles(CATALOG));
const catalogDefinitions = catalogRegistry.captureRevision();
const catalogAvailabilities = new Map<string, DefinitionAvailabilitySnapshot>();
/** The availability of the whole catalog's definitions under `live` and the agent types `disabledTypes` turns off. */
async function catalogAvailability(live: FirstPartyModuleComposition, disabledTypes: readonly string[]): Promise<DefinitionAvailabilitySnapshot> {
  const capabilities = ALL_IDS.filter((id) => live.enabledModuleIds.includes(id));
  const key = JSON.stringify([capabilities, disabledTypes]);
  const held = catalogAvailabilities.get(key);
  if (held) return held;
  const state = { ...decodeModuleState(""), capabilities };
  const snapshot = (await createDefinitionAvailability({ definitions: catalogRegistry, modules: CATALOG, capabilities: { state: () => state }, agentTypes: { disabled: () => disabledTypes } })).snapshot();
  catalogAvailabilities.set(key, snapshot);
  return snapshot;
}
const loaded = loadConfig(undefined, {}, root);
const runtimeConfig = captureRuntimeConfigRequest({ revision: 0, config: loaded.config, warnings: loaded.warnings, diagnostics: loaded.diagnostics, sourceIdentity: "render-matrix", status: { kind: "missing" } }, "default");
const sources = {
  corePrompt: loadSystemPrompt({ projectRoot: root, userDataRoot: root }),
  engineeringDoctrine: loadEngineeringDoctrine({ projectRoot: root, userDataRoot: root }),
  agentsMd: undefined,
  memory: () => "",
};

/** The runtime configuration with `disabledTypes` in `[subagents] disabled_types`. */
const configWithTypes = (disabledTypes: readonly string[]) => disabledTypes.length === 0 ? runtimeConfig : { ...runtimeConfig, moduleSections: { ...runtimeConfig.moduleSections, subagents: { disabled_types: disabledTypes } } };

const CHAT: AgentPurpose = { kind: "interactive-chat" };
const UNATTENDED_CHAT: AgentPurpose = { kind: "unattended-chat" };
const SUBAGENT: AgentPurpose = { kind: "subagent", renderAs: "subagent", parentToolUseId: "matrix" };
/** A general subagent, which renders as a chat. */
const GENERAL_SUBAGENT: AgentPurpose = { kind: "subagent", renderAs: "chat", parentToolUseId: "matrix" };
const WORKFLOW_AGENT: AgentPurpose = { kind: "workflow-agent", briefScope: { briefId: "matrix" }, workflowAttemptId: "matrix" };
/** One serving model per interaction profile: the default body with the edit tool, a Claude 5 chat body, and the
 *  apply_patch edit contract. */
const PROFILES: readonly PromptAssembly["servingModel"][] = [
  { model: "matrix-model", modelFamily: "anthropic" },
  { model: "claude-opus-5.5", modelFamily: "anthropic" },
  { model: "gpt-6-luna", modelFamily: "openai" },
];

const selections = new Map<string, FirstPartyModuleComposition>();
/** The selection with `off` turned off, and every module that needs one of them (PI-CAP-018); one composition per
 *  configuration, so the tree checks that memoize on it are shared. */
function selection(off: readonly string[]): FirstPartyModuleComposition {
  const effective = new Set<string>(effectiveModuleIds(ALL_IDS.filter((id) => !off.includes(id)), CATALOG));
  const disabled = ALL_IDS.filter((id) => !effective.has(id));
  const key = disabled.join(",");
  const held = selections.get(key) ?? composeFirstPartyModules(CATALOG, disabled);
  selections.set(key, held);
  return held;
}

/** One rendered text, and whether it is text that every agent of the chat tree shares. */
interface Rendered {
  readonly surface: string;
  readonly text: string;
  readonly shared: boolean;
}

interface Render {
  readonly rendered: readonly Rendered[];
  readonly planned: PlannedRequest;
}

/** Every surface that one request of `purpose` renders under `capture`, with `live` as the agent's own selection.
 *  Workflows is Off exactly while its module is off (`workflowsModeOf`); `ask` selects Ask while it is on. */
async function render(capture: FirstPartyModuleComposition, live: FirstPartyModuleComposition, purpose: AgentPurpose, servingModel = PROFILES[0]!, ask = false, disabledTypes: readonly string[] = []): Promise<Render> {
  const workflowsMode = workflowsModeOf(ALL_IDS.filter((id) => live.enabledModuleIds.includes(id)), ask);
  const assembly: PromptAssembly = { projectRoot: root, userDataRoot: root, accountHome: root, scratchDir: join(root, "session", "scratch"), definitions, runtimeConfig: configWithTypes(disabledTypes), capture, live, workflowsMode, servingModel, hosts: true };
  const chat = purpose.kind === "interactive-chat";
  const planned = await planPromptRequest(assembly, { personas: definitions.personas, purpose, askUser: chat, ...(chat ? {} : { handoffSchema: { schema: SUBAGENT_HANDOFF_SCHEMA } }) });
  if (chat) planned.tools.delete("handoff");
  const has: CapabilityCheck = plannedCapabilities(planned);
  const usableIdentities = [...planned.usable].filter((name) => planned.tools.has(name)).map((name) => planned.registrationIdentities.get(name) ?? name);
  const availability = await catalogAvailability(live, disabledTypes);
  const reader: CapabilityCheck = agentCapabilityCheck(new Set(usableIdentities), availability, planned.kernel.allowedSubagentTypes);
  const rendered: Rendered[] = [];
  const shared = (surface: string, text: string | undefined): void => { if (text) rendered.push({ surface, text, shared: true }); };
  const own = (surface: string, text: string | undefined): void => { if (text) rendered.push({ surface, text, shared: false }); };

  for (const [name, tool] of planned.tools) {
    shared(`tool ${name} name`, `\`${name}\``);
    shared(`tool ${name} description`, tool.description);
    shared(`tool ${name} snippet`, tool.promptSnippet);
    shared(`tool ${name} guidelines`, [...tool.promptGuidelines ?? [], ...tool.livePromptGuidelines?.() ?? []].join("\n"));
    shared(`tool ${name} examples`, tool.promptExamples);
    shared(`tool ${name} schema`, JSON.stringify(tool.inputSchema));
  }
  for (const [name, tool] of planned.eligibleTools) {
    if (!planned.tools.has(name)) shared(`code catalog ${name}`, `${name}: ${tool.description}`);
  }
  // Every tier renders from the tree check, so the whole system prompt is what the chat tree shares.
  for (const part of await promptParts(assembly, purpose, planned, sources)) shared(`prompt ${part.label}`, part.text);

  for (const skill of catalogDefinitions.skills.skills.values()) {
    if (!reader(`skill:${skill.id}`)) continue;
    own(`skill load ${skill.id}`, renderSkillContext(skill, reader));
    for (const resource of offeredSkillResources(skill, reader)) {
      own(`skill resource ${skill.id}/${resource.path}`, renderSkillResourceWindow(skill, resource.path, readSkillResource(skill, resource.path, 0, Number.MAX_SAFE_INTEGER, reader), 0));
    }
  }
  // A persona renders for its own projected grant: its declared tools that the live selection serves and the
  // dispatcher's plan can run, with the tools every child gets (ARCH-STRUCTURE-031).
  for (const persona of catalogDefinitions.personas.values()) {
    if (persona.kind !== "persona" || !reader(`persona:${persona.name}`)) continue;
    const grant = availableToolNames(personaToolNames(persona, catalogDefinitions.personas), live).filter((name) => !persona.tools.includes(name) || planned.usable.has(name));
    own(`persona ${persona.name}`, personaInstructions(persona, catalogDefinitions.skills, agentCapabilityCheck(new Set(grant.map((name) => planned.registrationIdentities.get(name) ?? name)), availability, grantedSubagentTypes(persona, catalogDefinitions.personas))));
  }

  own("postamble", compileOutput({}).instructions(has("bash")));
  for (const contribution of live.contributions) {
    if (contribution.domain !== "turnReminders") continue;
    for (const state of ["on", "still", "off"] as const) own(`reminder ${contribution.id} ${state}`, contribution.value[state](has));
  }
  if (live.enabledModuleIds.includes("learning")) own("learning review", reviewInstruction(["memory", "skill"], has));

  let nudge: string | undefined;
  await createPendingWorkNudge({ providerSessionKey: "matrix", pushUser: async (content) => { nudge = content; } }).turnEndedWithoutWait(1);
  own("pending-work nudge", nudge);
  own("wait-expired notice", WAIT_EXPIRED_HANDLING);
  own("reset opening", renderCompactionOpening({ checkpoint: undefined, brief: undefined, saved: false, recallAvailable: has("recall"), capabilities: has }));
  own("reset opening with brief", renderCompactionOpening({ checkpoint: undefined, brief: "Do the task.", saved: false, recallAvailable: has("recall"), capabilities: has }));
  const truncated = await limitOutput({ content: "x".repeat(40_000), executionCwd: root, projectRoot: root, artifactScopeId: "matrix", capabilities: has });
  own("truncation notice", truncated.text.slice(-600));
  const budget = await enforceTurnBudget([{ toolUseId: "matrix", toolName: "bash", exempt: false, content: [{ type: "text", text: "y".repeat(20_000) }] }], { budgetChars: 1_000, executionCwd: root, projectRoot: root, artifactScopeId: "matrix", capabilities: has });
  for (const replacement of budget) own("turn budget preview", JSON.stringify(replacement));

  // The results that the usable file and discovery tools give for a path they cannot serve.
  const context = makeContext({ executionCwd: root, projectRoot: root, userDataRoot: root, capabilities: has });
  const result = async (name: string, input: RuntimeToolInput) => {
    if (!planned.usable.has(name)) return undefined;
    const content = (await planned.tools.get(name)?.execute(input, context))?.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  };
  own("read missing path", await result("read", { path: join(root, "missing.txt") }));
  own("read binary file", await result("read", { path: join(root, "image.bin") }));
  own("list missing path", await result("list", { path: join(root, "missing") }));

  // The reason that each tool of the live selection gives when its host is absent, such as the web tool's remedy.
  const noHosts = composeModuleRuntimes([]);
  for (const contribution of live.contributions) {
    if (contribution.domain !== "tools") continue;
    for (const [id, registration] of Object.entries(contribution.value.declaration.registrations)) {
      const built = registration.create({ kernel: planned.kernel, modules: noHosts });
      own(`absent host ${id}`, "unusable" in built && built.unusable ? built.unusable.reason : "reason" in built ? built.reason : undefined);
    }
  }
  if (has("bash")) {
    for (const command of ["vim notes.txt", "less notes.txt", "sleep 30", "git worktree add ../other"]) own(`bash refusal ${command}`, (await interceptBashCommand(command, { capabilities: has }))?.message);
  }
  return { rendered, planned };
}

/** Every surface of one configuration: a chat under each interaction profile, a subagent, and an agent of a
 *  workflow, each labeled with its purpose and model. */
async function renderConfiguration(composition: FirstPartyModuleComposition, disabledTypes: readonly string[] = []): Promise<Rendered[]> {
  const requests = [
    ...PROFILES.map((profile) => [CHAT, profile] as const),
    [UNATTENDED_CHAT, PROFILES[0]!] as const,
    [SUBAGENT, PROFILES[0]!] as const,
    [GENERAL_SUBAGENT, PROFILES[0]!] as const,
    [WORKFLOW_AGENT, PROFILES[0]!] as const,
  ];
  const renders = await Promise.all(requests.map(async ([purpose, profile]) => (await render(composition, composition, purpose, profile, false, disabledTypes)).rendered.map((entry) => ({ ...entry, surface: `${purpose.kind}${purpose.kind === "subagent" ? `:${purpose.renderAs}` : ""} ${profile.model} ${entry.surface}` }))));
  return renders.flat();
}

/** Each place where a rendered text names a capability of a module in `off`, as "<surface>: <module> <mention>". */
function mentions(rendered: readonly Rendered[], off: readonly string[], include: (entry: Rendered) => boolean = () => true): string[] {
  const offTerms = off.flatMap((id) => terms.get(id) ?? []);
  return rendered.filter(include).flatMap((entry) => capabilityMentions(entry.text, offTerms).map(({ module, mention }) => `${entry.surface}: ${module} ${mention}`));
}

/** The modules that a selection leaves off once dependents follow their dependencies. */
const turnedOff = (composition: FirstPartyModuleComposition): string[] => ALL_IDS.filter((id) => !composition.enabledModuleIds.includes(id));

describe("capability render matrix", () => {
  // An off case proves something only for a module that the all-on render names.
  test("the all-on render names every optional module", async () => {
    const named = new Set(capabilityMentions((await renderConfiguration(selection([]))).map((entry) => entry.text).join("\n"), NAMED).map((mention) => mention.module));
    expect(NAMED.map((module) => module.id).filter((id) => !named.has(id))).toEqual([]);
  });

  for (const module of NAMED) {
    test(`with ${module.id} off, no text names it or a module that needs it`, async () => {
      const composition = selection([module.id]);
      expect(mentions(await renderConfiguration(composition), turnedOff(composition))).toEqual([]);
    });
  }

  test("Minimal turns every module off, and no text names one", async () => {
    const composition = selection(ALL_IDS);
    expect(composition.enabledModuleIds).toEqual([]);
    expect(mentions(await renderConfiguration(composition), ALL_IDS)).toEqual([]);
  });

  for (const mode of ["off", "ask", "on"] as const) {
    test(`Workflows ${mode} names workflows only where the chat can launch one`, async () => {
      const composition = selection(mode === "off" ? ["workflows"] : []);
      const launchMentions = mentions((await render(composition, composition, CHAT, PROFILES[0], mode === "ask")).rendered, ["workflows"]);
      if (mode === "off") expect(launchMentions).toEqual([]);
      else expect(launchMentions.length).toBeGreaterThan(0);
    });
  }

  for (const purpose of [SUBAGENT, WORKFLOW_AGENT]) {
    test(`a tree-hosted ${purpose.kind} keeps the tree's shared bytes after a live disable, and its own text names no module turned off`, async () => {
      const capture = selection([]);
      const allOn = await render(capture, capture, purpose);
      const sharedOf = (rendered: readonly Rendered[]) => rendered.filter((entry) => entry.shared).map((entry) => `${entry.surface}\n${entry.text}`);
      const modelsTool = (rendered: readonly Rendered[]) => rendered.filter((entry) => entry.surface.startsWith("tool models "));
      for (const id of ["subagents", "workflows", "web", "recall"]) {
        const live = selection([id]);
        const off = turnedOff(live);
        const narrowed = await render(capture, live, purpose);
        expect(sharedOf(narrowed.rendered)).toEqual(sharedOf(allOn.rendered));
        expect(mentions(narrowed.rendered, off, (entry) => !entry.shared)).toEqual([]);
        expect(createCapabilityNarrowing(() => capture).due([], { moduleIds: narrowed.planned.turnedOff, types: [] })?.moduleIds).toEqual(expect.arrayContaining(off.filter((offId) => capture.contributions.some((contribution) => contribution.module === offId && contribution.domain === "tools"))));
        // A child gets no workflow starter, so only `models` of the Workflows tools reaches it; it stays advertised.
        if (id === "workflows") {
          expect(allOn.rendered.some((entry) => entry.surface.startsWith("tool workflow "))).toBe(false);
          expect(modelsTool(narrowed.rendered).length).toBeGreaterThan(0);
          expect(modelsTool(narrowed.rendered)).toEqual(modelsTool(allOn.rendered));
          expect(narrowed.planned.usable.has("models")).toBe(false);
        }
      }
    });
  }

  /** Each pointer in `rendered` to a skill, or a resource of a skill, that an agent with every tool reads with every
   *  type on and that leaves with `disabledTypes`: a skill id or a resource file name in backticks. */
  async function pointersToWhatLeft(rendered: readonly Rendered[], disabledTypes: readonly string[]): Promise<string[]> {
    const [on, off] = await Promise.all([catalogAvailability(selection([]), []), catalogAvailability(selection([]), disabledTypes)]);
    const reader = (availability: DefinitionAvailabilitySnapshot) => agentCapabilityCheck(new Set(["skill", "subagent", "workflow", "bash"]), availability, undefined);
    const left = [...on.skills.values()].filter((skill) => skill.modelInvocable && off.skills.get(skill.id)?.modelInvocable !== true).map((skill) => skill.id);
    for (const skill of catalogDefinitions.skills.skills.values()) {
      if (!reader(off)(`skill:${skill.id}`)) continue;
      const kept = new Set(offeredSkillResources(skill, reader(off)).map((resource) => resource.path));
      left.push(...offeredSkillResources(skill, reader(on)).filter((resource) => !kept.has(resource.path)).map((resource) => resource.path.split("/").at(-1) ?? resource.path));
    }
    return rendered.flatMap((entry) => left.filter((name) => entry.text.includes(`\`${name}\``)).map((name) => `${entry.surface}: ${name}`));
  }

  // An agent type that is off works like a module that is off: no text names it (R4). The spelling of a type is the
  // lint's, read unmasked, so a code span that grammar masking would pass still counts here.
  const CORE_TYPES = Object.entries(AGENT_TYPE_PHRASES);
  for (const off of [...CORE_TYPES.map((entry) => [entry]), CORE_TYPES]) {
    const types = off.map(([type]) => type);
    test(`with ${types.length === 1 ? `the ${types[0]} type` : "every core type"} off, no text that an agent reads names it`, async () => {
      const rendered = await renderConfiguration(selection([]), types);
      expect(rendered.flatMap((entry) => off.flatMap(([type, phrases]) => phrases.flatMap((pattern) => {
        const found = pattern.exec(entry.text)?.[0];
        return found === undefined ? [] : [`${entry.surface}: ${type} ${found}`];
      })))).toEqual([]);
      expect(await pointersToWhatLeft(rendered, types)).toEqual([]);
    });
  }

  // R5: the review method needs every reviewer it declares, and no advisor; every other bundled skill stays.
  test("the bundled skill catalog drops only code-review while reviewers or one reviewer role are off, and keeps it with the advisor off", async () => {
    const offered = async (disabledTypes: readonly string[]) => [...(await catalogAvailability(selection([]), disabledTypes)).skills.values()].filter((skill) => skill.modelInvocable).map((skill) => skill.id);
    const all = await offered([]);
    const left = async (disabledTypes: readonly string[]) => { const kept = new Set(await offered(disabledTypes)); return all.filter((id) => !kept.has(id)); };
    expect(all).toContain("code-review");
    expect(await left(["advisor"])).toEqual([]);
    expect(await left(["reviewer"])).toEqual(["code-review"]);
    expect(await left(["reviewer-security"])).toEqual(["code-review"]);
  });

  test("a bundled example workflow that runs reviewer personas is not offered while one of its reviewers is off", async () => {
    const authoring = catalogDefinitions.skills.skills.get("workflow-authoring");
    if (!authoring) throw new Error("the catalog installs workflow-authoring");
    const offered = async (disabledTypes: readonly string[]) => offeredSkillResources(authoring, agentCapabilityCheck(new Set(["skill", "subagent", "workflow"]), await catalogAvailability(selection([]), disabledTypes), undefined)).map((resource) => resource.path);
    const reviewerExamples = ["examples/build-review-loop.workflow.yaml", "examples/lens-review.workflow.yaml"];
    expect(await offered([])).toEqual(expect.arrayContaining([...reviewerExamples, "references/review-briefs.md"]));
    expect((await offered(["reviewer"])).filter((path) => [...reviewerExamples, "references/review-briefs.md"].includes(path))).toEqual([]);
    expect((await offered(["reviewer-security"])).filter((path) => reviewerExamples.includes(path))).toEqual(["examples/build-review-loop.workflow.yaml"]);
  });

  // One reviewer role off leaves the others on, so reviewer text stays, but no text names a persona of that role.
  test("with one reviewer role off, no text that an agent reads names a persona of that role", async () => {
    const roles = vocabulary.types.filter((type) => type.id.startsWith("type:reviewer-"));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const rendered = await renderConfiguration(selection([]), [role.id.slice("type:".length)]);
      expect(rendered.flatMap((entry) => capabilityMentions(entry.text, [role]).map(({ mention }) => `${entry.surface}: ${mention}`))).toEqual([]);
      expect(await pointersToWhatLeft(rendered, [role.id.slice("type:".length)])).toEqual([]);
    }
  }, 60_000);

  test("with every agent type off, a new chat tree plans no dispatch tool and no roster, and still launches workflows; one type on brings both back", async () => {
    const capture = selection([]);
    const everyType = [...new Set([...definitions.personas.values()].map((agent) => agent.kind === "persona" ? agent.role : "general"))];
    const chatWith = async (disabledTypes: readonly string[]) => {
      const config = { ...runtimeConfig, moduleSections: { ...runtimeConfig.moduleSections, subagents: { disabled_types: disabledTypes } } };
      const assembly: PromptAssembly = { projectRoot: root, userDataRoot: root, accountHome: root, scratchDir: join(root, "session", "scratch"), definitions, runtimeConfig: config, capture, live: capture, workflowsMode: "on", servingModel: PROFILES[0]!, hosts: true };
      const planned = await planPromptRequest(assembly, { personas: definitions.personas, purpose: CHAT, askUser: true });
      const prompt = (await promptParts(assembly, CHAT, planned, sources)).map((part) => part.text).join("\n");
      return { tools: [...planned.tools.keys()], roster: prompt.includes("# Subagents") };
    };

    const allOff = await chatWith(everyType);
    expect(allOff.tools).not.toContain("subagent");
    expect(allOff.roster).toBe(false);
    expect(allOff.tools).toContain("workflow");
    const explorerOn = await chatWith(everyType.filter((type) => type !== "explorer"));
    expect(explorerOn.tools).toContain("subagent");
    expect(explorerOn.roster).toBe(true);
  });
});
