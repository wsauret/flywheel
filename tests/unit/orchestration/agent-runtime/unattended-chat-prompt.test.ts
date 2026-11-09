import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPromptRequest, promptParts, type PromptAssembly } from "../../../../scripts/prompt-assembly.js";
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
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js";
import { unusedSessionMessaging } from "../../../helpers/child-session-control.js";

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

/** One request of a root chat, under the capability ceiling that the chat runner gives its purpose, with the session
 *  messaging that a chat runner holds. `withoutChildren` also turns off the modules that start a child session, and
 *  `engineeringDoctrine` replaces the realm's doctrine. */
async function request(purpose: AgentPurpose, withoutChildren = false, engineeringDoctrine = sources.engineeringDoctrine) {
  const ceiling = purpose.kind === "unattended-chat" ? unattendedModuleIds().filter((id) => !withoutChildren || (id !== "subagents" && id !== "workflows")) : undefined;
  const capabilityAccess = capabilityAccessFor(policy, undefined, ceiling);
  const planned = await planPromptRequest(assembly, { personas: definitions.personas, purpose, askUser: true, capabilityAccess, sessions: unusedSessionMessaging() });
  planned.tools.delete("handoff");
  return { tools: [...planned.tools.keys()], messageSession: planned.tools.get("message_session"), parts: await promptParts(assembly, purpose, planned, { ...sources, engineeringDoctrine, sessionIdentity }) };
}

describe("system prompt of an unattended chat", () => {
  test("leaves out the person-facing blocks, tools, the bundled doctrine, and publication rules, where the interactive chat keeps them", async () => {
    const PERSON_BLOCKS = ["chat change review", "communication", "conversation-first delivery", "engineering doctrine"];
    const PERSON_TOOLS = ["skill", "ask_user"];
    const PUBLICATION = ["commit + push", "Run the repository's standard gates first", "One commit per unit"];
    const KEPT = ["core system prompt", "session checkpoint"];
    const chat = await request({ kind: "interactive-chat" });
    const unattended = await request({ kind: "unattended-chat" });
    const labels = unattended.parts.map((part) => part.label);
    const text = (parts: typeof chat.parts) => parts.map((part) => part.text).join("\n");

    for (const label of PERSON_BLOCKS) expect(chat.parts.map((part) => part.label)).toContain(label);
    expect(chat.parts.map((part) => part.label)).not.toContain("working unattended");
    for (const tool of PERSON_TOOLS) expect(chat.tools).toContain(tool);
    for (const rule of [...PUBLICATION, "Installed skills", "ELEGANCE:"]) expect(text(chat.parts)).toContain(rule);

    for (const label of KEPT) expect(labels).toContain(label);
    for (const label of PERSON_BLOCKS) expect(labels).not.toContain(label);
    for (const tool of PERSON_TOOLS) expect(unattended.tools).not.toContain(tool);
    for (const rule of [...PUBLICATION, "Installed skills", "ELEGANCE:"]) expect(text(unattended.parts)).not.toContain(rule);

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
    const unattended = await request({ kind: "unattended-chat" }, false, written);
    expect(unattended.parts.find((part) => part.label === "engineering doctrine")?.text).toBe(written);
  });

  // A root that no person reads coordinates with no peer chat, so it reaches only the children that it starts.
  test("offers session messaging and the session identity only toward the children that it can start", async () => {
    const MESSAGE_TOOLS = ["message_session", "list_sessions"];
    const chat = await request({ kind: "interactive-chat" });
    for (const tool of MESSAGE_TOOLS) expect(chat.tools).toContain(tool);
    expect(chat.parts.map((part) => part.label)).toContain("session identity");

    const alone = await request({ kind: "unattended-chat" }, true);
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
});
