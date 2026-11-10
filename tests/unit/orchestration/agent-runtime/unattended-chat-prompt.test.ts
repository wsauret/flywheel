import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plannedCapabilities, planPromptRequest, promptParts, type PromptAssembly } from "../../../../scripts/prompt-assembly.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { captureRuntimeConfigRequest } from "../../../../src/orchestration/agent-runtime/request-config.js";
import type { AgentPurpose } from "../../../../src/orchestration/agent-runtime/types.js";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { installedDefinitionBundles } from "../../../../src/orchestration/module-catalog.js";
import { capabilityAccessFor } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import type { CapabilityRequest } from "../../../../src/orchestration/config/module-policy.js";
import { composeFirstPartyModules, unattendedModuleIds } from "../../../../src/orchestration/modules.js";
import { canonicalModuleIds } from "../../../../src/protocol/module-ids.js";
import { installedPersonaToolEntries } from "../../../../src/orchestration/tool-catalog.js";
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistryRevision } from "../../../../src/workflows/definition-registry.js";
import { publishSkillRevision, type SkillDefinition } from "../../../../src/workflows/skill-schema.js";
import { unusedSessionMessaging } from "../../../helpers/child-session-control.js";
import type { CapabilityCheck } from "../../../../src/infra/capability-text.js";
import { interceptBashCommand } from "../../../../src/orchestration/agent-runtime/tools/bash-command-policy.js";
import { makeContext } from "./tools/_fixtures.js";

// The system prompt of an unattended chat (PI-AGENT-121) beside the interactive chat's, both built the way a live
// request builds them (`requestSystemPromptOptions`): the unattended chat keeps the core prompt and the checkpoint, and
// leaves out the bundled doctrine and every block that serves a person who reads the conversation.

const root = mkdtempSync(join(tmpdir(), "flywheel-unattended-chat-prompt-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const definitions = createProjectDefinitionRegistry({ projectRoot: root, userDataRoot: root, accountHome: root, skillRoots: [], bundles: installedDefinitionBundles(), personaToolEntries: installedPersonaToolEntries() }).captureRevision();
const loaded = loadConfig(undefined, {}, root);
const modules = composeFirstPartyModules();
const assembly: PromptAssembly = {
  projectRoot: root, userDataRoot: root, accountHome: root, scratchDir: join(root, "session", "scratch"), definitions,
  runtimeConfig: captureRuntimeConfigRequest({ revision: 0, config: loaded.config, warnings: loaded.warnings, diagnostics: loaded.diagnostics, sourceIdentity: "unattended-chat-prompt", status: { kind: "missing" } }, "default"),
  capture: modules, live: modules, workflowsMode: "off", servingModel: { model: "prompt-model", modelFamily: "anthropic" }, hosts: false,
};
const sources = {
  corePrompt: loadSystemPrompt({ projectRoot: root, userDataRoot: root }),
  engineeringDoctrine: loadEngineeringDoctrine({ projectRoot: root, userDataRoot: root }),
  agentsMd: undefined,
  memory: () => null,
};

// Every module the configuration enables is selected; the chat runner bounds it with its ceiling.
const enabled = canonicalModuleIds(modules.enabledModuleIds);
const policy = {
  state: () => ({ capabilities: enabled, moduleIds: enabled, requireWorkflowConfirmation: true, workflowsMode: "off" as const, identity: "all" }),
  admit: async (asked: CapabilityRequest) => ({ ok: false as const, missing: [...asked.required], reason: "planning only" }),
};

const sessionIdentity = { sessionId: "root-1", rootSessionId: "root-1", conversationId: "root-conversation", kind: "chat" as const };

/** The capability boundary that the chat runner gives a root chat of `purpose`, which every child that it starts
 *  inherits. `withoutChildren` also turns off the modules that start a child session. */
function rootAccess(purpose: AgentPurpose, withoutChildren: boolean) {
  const unattended = purpose.kind === "unattended-chat";
  const ceiling = unattended ? unattendedModuleIds().filter((id) => !withoutChildren || (id !== "subagents" && id !== "workflows")) : undefined;
  return capabilityAccessFor(policy, undefined, ceiling, unattended);
}

/** The installed definitions with `changed` skills added or replaced, published as the registry publishes them. */
function revisionWith(...changed: SkillDefinition[]): ProjectDefinitionRegistryRevision {
  const skills = new Map(definitions.skills.skills);
  for (const skill of changed) skills.set(skill.id, skill);
  return { ...definitions, skills: publishSkillRevision(definitions.skills.revision, skills, definitions.skills.bundledCorpus) };
}

function installedSkill(id: string): SkillDefinition {
  const skill = definitions.skills.skills.get(id);
  if (!skill) throw new Error(`skill ${id} is not installed`);
  return skill;
}

interface RequestOptions {
  readonly withoutChildren?: boolean;
  /** Replaces the realm's doctrine. */
  readonly engineeringDoctrine?: string;
  readonly revision?: ProjectDefinitionRegistryRevision;
  /** The root chat whose boundary the request holds; the request's own purpose by default. */
  readonly treeRoot?: AgentPurpose;
}

/** One request under the capability boundary of its tree's root chat, with the session messaging that a chat runner
 *  holds. */
async function request(purpose: AgentPurpose, { withoutChildren = false, engineeringDoctrine = sources.engineeringDoctrine, revision = definitions, treeRoot = purpose }: RequestOptions = {}) {
  const planAssembly = { ...assembly, definitions: revision };
  const planned = await planPromptRequest(planAssembly, { personas: definitions.personas, purpose, askUser: true, capabilityAccess: rootAccess(treeRoot, withoutChildren), sessions: unusedSessionMessaging() });
  planned.tools.delete("handoff");
  return { planned, tools: [...planned.tools.keys()], messageSession: planned.tools.get("message_session"), parts: await promptParts(planAssembly, purpose, planned, { ...sources, engineeringDoctrine, sessionIdentity }) };
}

/** The skill ids of a system prompt's catalog, in order. */
function catalog(parts: readonly { readonly text: string }[]): string[] {
  const after = parts.map((part) => part.text).join("\n").split("Installed skills, trigger descriptions only:\n")[1] ?? "";
  const ids: string[] = [];
  for (const row of after.split("\n")) {
    const id = /^- ([a-z0-9-]+): /.exec(row)?.[1];
    if (!id) break;
    ids.push(id);
  }
  return ids;
}

const UNATTENDED: AgentPurpose = { kind: "unattended-chat" };
const INTERACTIVE: AgentPurpose = { kind: "interactive-chat" };
const SUBAGENT: AgentPurpose = { kind: "subagent", renderAs: "subagent", parentToolUseId: "dispatch" };

describe("system prompt of an unattended chat", () => {
  test("leaves out the person-facing blocks, tools, the bundled doctrine, and publication rules, where the interactive chat keeps them", async () => {
    const PERSON_BLOCKS = ["chat change review", "communication", "conversation-first delivery", "engineering doctrine"];
    const PERSON_TOOLS = ["ask_user"];
    const PUBLICATION = ["commit + push", "Run the repository's standard gates first", "One commit per unit"];
    const KEPT = ["core system prompt", "session checkpoint"];
    const chat = await request({ kind: "interactive-chat" });
    const unattended = await request({ kind: "unattended-chat" });
    const labels = unattended.parts.map((part) => part.label);
    const text = (parts: typeof chat.parts) => parts.map((part) => part.text).join("\n");

    for (const label of PERSON_BLOCKS) expect(chat.parts.map((part) => part.label)).toContain(label);
    expect(chat.parts.map((part) => part.label)).not.toContain("working unattended");
    for (const tool of PERSON_TOOLS) expect(chat.tools).toContain(tool);
    for (const rule of [...PUBLICATION, "ELEGANCE:"]) expect(text(chat.parts)).toContain(rule);

    for (const label of KEPT) expect(labels).toContain(label);
    for (const label of PERSON_BLOCKS) expect(labels).not.toContain(label);
    for (const tool of PERSON_TOOLS) expect(unattended.tools).not.toContain(tool);
    for (const rule of [...PUBLICATION, "ELEGANCE:"]) expect(text(unattended.parts)).not.toContain(rule);

    // The guidance states the unattended contract and nothing that steers the work; an unattended chat runs no
    // brief and has no parent, so it is not told to hand off or message one.
    const guidance = unattended.parts.find((part) => part.label === "working unattended")?.text;
    expect(guidance).toBe("WORKING UNATTENDED:\nYou complete one request without a person available to answer questions. Your final reply is the result.\n\n- Never end with an offer to do the work again or in another way.");
  });

  // Nobody reviews an unattended chat's result, so its verification rule asks for every named requirement instead of
  // limiting the checks to the smallest set.
  test("checks every named requirement before it finishes, where the interactive chat keeps the scope limits", async () => {
    const COMPLETION = "Before you finish, check each requirement that the request names against your work and exercise it, including how the new inputs combine and how a caller reaches the change through its public entry point; the work is done when every named requirement is verified, not a plausible subset.";
    const SCOPE_LIMITS = [
      "Use the smallest complete verification of the work, then stop.",
      "Add UAT beyond that only for a specific evidence gap or explicit acceptance requirement.",
      "Honor explicit repository gates, but do not add broader suites or adjacent scenarios without a concrete reason.",
      "minimal means the smallest decisive fresh check, not reuse of an earlier result",
    ];
    const core = async (purpose: AgentPurpose) => (await request(purpose)).parts.find((part) => part.label === "core system prompt")?.text ?? "";
    const chat = await core({ kind: "interactive-chat" });
    const unattended = await core({ kind: "unattended-chat" });

    for (const limit of SCOPE_LIMITS) expect(chat).toContain(limit);
    expect(chat).not.toContain(COMPLETION);
    expect(unattended).toContain(COMPLETION);
    for (const limit of SCOPE_LIMITS) expect(unattended).not.toContain(limit);
    expect(unattended).toContain("Honor explicit repository gates. Assume past observations are stale");
    expect(unattended).toContain("Run fresh checks for the current decision and fresh post-implementation verification.");
    expect(unattended).not.toContain("{{");
  });

  test("keeps a doctrine that a person wrote byte for byte", async () => {
    const written = "WRITING:\n- Follow the conventions of this repository.\n\n---\n\nCOMMITS:\n- Commit each unit.";
    const unattended = await request(UNATTENDED, { engineeringDoctrine: written });
    expect(unattended.parts.find((part) => part.label === "engineering doctrine")?.text).toBe(written);
  });

  // A root that no person reads coordinates with no peer chat, so it reaches only the children that it starts.
  test("offers session messaging and the session identity only toward the children that it can start", async () => {
    const MESSAGE_TOOLS = ["message_session", "list_sessions"];
    const chat = await request({ kind: "interactive-chat" });
    for (const tool of MESSAGE_TOOLS) expect(chat.tools).toContain(tool);
    expect(chat.parts.map((part) => part.label)).toContain("session identity");

    const alone = await request(UNATTENDED, { withoutChildren: true });
    expect(alone.tools).not.toContain("subagent");
    for (const tool of MESSAGE_TOOLS) expect(alone.tools).not.toContain(tool);
    expect(alone.parts.map((part) => part.label)).not.toContain("session identity");
    expect(alone.parts.map((part) => part.text).join("\n")).not.toContain("list_sessions");

    const withChildren = await request({ kind: "unattended-chat" });
    expect(withChildren.tools).toContain("subagent");
    expect(withChildren.tools).toContain("message_session");
    expect(withChildren.tools).not.toContain("list_sessions");
    expect(JSON.stringify(withChildren.messageSession?.inputSchema)).not.toContain("list_sessions");
    expect(withChildren.parts.map((part) => part.label)).not.toContain("session identity");
  });

  // PI-AGENT-121: no person watches a child stream or reads a message of an unattended chat, and its run has no
  // installed command to inspect its own session records. A subagent runs one brief, so it never self-debugs.
  test("leaves out the streaming sentence, the person rules of messaging, and self-debugging, where the interactive chat keeps them", async () => {
    const STREAMING = "The subagent's streaming output (text, tool calls) is visible to the user in real time.";
    const PERSON = ["Your person sees every message that you send or receive", "When a message needs a decision from your person", "Return delegated results through handoff"];
    const SELF_DEBUG = "flywheel events search";
    const surface = async (purpose: AgentPurpose, treeRoot = purpose) => {
      const { planned, parts } = await request(purpose, { treeRoot });
      const messageSession = planned.tools.get("message_session");
      return {
        tools: JSON.stringify([...planned.tools.values()].map((tool) => [tool.name, tool.description, tool.promptGuidelines, tool.inputSchema])),
        // The tools whose words depend on whether a person reads the tree, which every agent of the tree shares.
        treeWorded: JSON.stringify(["bash", "subagent", "message_session", "process"].map((name) => planned.tools.get(name)).map((tool) => [tool?.description, tool?.promptGuidelines, tool?.inputSchema])),
        subagent: planned.tools.get("subagent")?.description ?? "",
        messaging: `${messageSession?.description ?? ""}\n${messageSession?.promptGuidelines?.join("\n") ?? ""}`,
        prompt: parts.map((part) => part.text).join("\n"),
      };
    };
    const chat = await surface(INTERACTIVE);
    const unattended = await surface(UNATTENDED);

    expect(chat.subagent).toContain(STREAMING);
    for (const rule of PERSON) expect(chat.messaging).toContain(rule);
    expect(chat.prompt).toContain(SELF_DEBUG);
    expect((await surface({ kind: "workflow-agent", briefScope: { briefId: "brief" }, workflowAttemptId: "attempt" })).prompt).toContain(SELF_DEBUG);

    expect(unattended.subagent).not.toBe("");
    expect(unattended.subagent).not.toContain(STREAMING);
    expect(unattended.messaging).toContain("A message is not a conversation.");
    for (const rule of PERSON) expect(unattended.messaging).not.toContain(rule);
    expect(unattended.prompt).not.toContain(SELF_DEBUG);

    // A child of a tree reads the tree's words, not its own purpose's (ARCH-CONTEXT-018).
    for (const [treeRoot, rootSurface] of [[INTERACTIVE, chat], [UNATTENDED, unattended]] as const) {
      const [first, second] = await Promise.all([surface(SUBAGENT, treeRoot), surface(SUBAGENT, treeRoot)]);
      expect(first.prompt).not.toContain(SELF_DEBUG);
      expect(second.tools).toBe(first.tools);
      expect(first.treeWorded).toBe(rootSurface.treeWorded);
    }
  });

  // The coding methods serve an unattended run; a method that a person answers or approves (`attended: true`) does
  // not, and a delegated method such as `ship` is never in a catalog.
  test("offers the skill catalog without the methods that a person answers or approves", async () => {
    const chat = await request(INTERACTIVE);
    const unattended = await request(UNATTENDED);
    const chatSkills = catalog(chat.parts);
    const unattendedSkills = catalog(unattended.parts);

    expect(unattended.tools).toContain("skill");
    for (const id of ["test-driven-development", "systematic-debugging", "root-cause-analysis", "verification", "implementation"]) expect(unattendedSkills).toContain(id);
    for (const id of ["design", "experiment-charter", "experiment-finalize", "ship"]) expect(unattendedSkills).not.toContain(id);
    expect(chatSkills.filter((id) => !unattendedSkills.includes(id))).toEqual(["design", "experiment-charter", "experiment-finalize"]);
    expect(chatSkills).not.toContain("ship");
  });

  // Loading a skill renders every skill that it composes, so a skill that composes an attended method is as attended
  // as that method: the catalog, both capability checks, and the load agree on it.
  test("leaves out a skill that composes a method that a person answers, where the interactive chat keeps it", async () => {
    const revision = revisionWith({ ...installedSkill("verification"), id: "composes-design", dependencies: ["design"] });
    const surface = async (purpose: AgentPurpose) => {
      const { planned, parts } = await request(purpose, { revision });
      const has = plannedCapabilities(planned);
      const skill = planned.tools.get("skill");
      if (!skill) throw new Error("the skill tool is not planned");
      const load = await skill.execute({ action: "load", skill_id: "composes-design" }, makeContext({ capabilities: has }));
      const refusal = load.outcome === "error" ? String(load.content).split(".")[0] : undefined;
      return { listed: catalog(parts).includes("composes-design"), tree: planned.kernel.treeCapabilities("skill:composes-design"), agent: has("skill:composes-design"), load: load.outcome, refusal };
    };

    expect(await surface(INTERACTIVE)).toEqual({ listed: true, tree: true, agent: true, load: "ok", refusal: undefined });
    expect(await surface(UNATTENDED)).toEqual({ listed: false, tree: false, agent: false, load: "error", refusal: 'Unknown or unavailable skill_id "composes-design"' });
  });

  // A subagent's purpose is its own, but its tree's root decides whether a person reads the tree: the subagent holds
  // the boundary of the chat that started it.
  test("leaves the attended methods out of a subagent of an unattended chat, where a subagent of an interactive chat keeps them", async () => {
    const under = async (treeRoot: AgentPurpose) => {
      const { planned, parts } = await request(SUBAGENT, { treeRoot });
      return { listed: catalog(parts).includes("design"), tree: planned.kernel.treeCapabilities("skill:design"), agent: plannedCapabilities(planned)("skill:design") };
    };
    expect(await under(INTERACTIVE)).toEqual({ listed: true, tree: true, agent: true });
    expect(await under(UNATTENDED)).toEqual({ listed: false, tree: false, agent: false });
  });

  // A skill that an unattended chat leaves out of its catalog is no capability there, so every `skill:` term and every
  // rule that reads one, such as the shell's worktree rule, agrees with the catalog.
  test("reports a left-out skill as unavailable, and gates worktree commands only while their method is available", async () => {
    const agentCheck = async (purpose: AgentPurpose, revision = definitions) => plannedCapabilities((await request(purpose, { revision })).planned);
    const worktreeRule = async (capabilities: CapabilityCheck) => interceptBashCommand("git worktree add ../other", { capabilities, effectiveBundledSkillIds: new Set() });

    const chat = await agentCheck(INTERACTIVE);
    const unattended = await agentCheck(UNATTENDED);
    expect(chat("skill:design")).toBe(true);
    expect(unattended("skill:design")).toBe(false);
    expect(unattended("skill:worktree-lifecycle")).toBe(true);
    expect(await worktreeRule(unattended)).not.toBeNull();

    const withoutWorktreeMethod = await agentCheck(UNATTENDED, revisionWith({ ...installedSkill("worktree-lifecycle"), attended: true }));
    expect(withoutWorktreeMethod("skill:worktree-lifecycle")).toBe(false);
    expect(await worktreeRule(withoutWorktreeMethod)).toBeNull();
  });
});
