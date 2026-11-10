import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js";
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js";
import { composeModuleRuntimes } from "../../../../src/infra/module-runtime.js";
import { planToolExposure } from "../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { testKernelToolDeps } from "../../../helpers/request-tool-surface.js";
import { codeModeRuntimeOver } from "../../../helpers/code-mode-worker.js";
import { mcpPortsOver, mcpRuntimeOver } from "../../../helpers/mcp.js";
import { deriveChildRuntimeSurfaces, personaToolEntries } from "../../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import { createPersonaDefinitionSchema } from "../../../../src/workflows/agents/persona-schema.js";
import { personaInstructions } from "../../../../src/workflows/agents/persona-instructions.js";
import { loadStandalonePersonaRegistry } from "../../../../src/workflows/agents/registry.js";
import { personaToolNames } from "../../../../src/workflows/agents/subagent-reachability.js";
import { repoDefinitions } from "../../../helpers/project-definitions.js";
import { createToolRegistry } from "../../../../src/orchestration/tool-catalog.js";
import { composeFirstPartyModules, SHIPPED_MODULES, type ModuleId } from "../../../../src/orchestration/modules.js";
import { renderSkillClosure } from "../../../../src/workflows/skill-context.js";
import { isReadOnlyPersona, toolGrantRules } from "../../../../src/orchestration/agent-runtime/persona-tool-rules.js";
import { toolNotice } from "../../../../src/orchestration/agent-runtime/tool-notice.js";
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { makeContext } from "./tools/_fixtures.js";
import { makeContext as makeDispatchContext, makeDeps } from "./subagent/_fixtures.js";
import { prepareSubagentTools } from "../../../../src/orchestration/modules/subagents/execution/dispatch-preparation.js";
import { agentCapabilityCheck } from "../../../../src/orchestration/agent-runtime/capability-checks.js";
const temporaryDirectory = temporaryDirectories();
const shippedToolRegistry = createToolRegistry(SHIPPED_MODULES);
const toolRegistrations = Object.fromEntries(shippedToolRegistry);
const advertisedTool = (name: string): RuntimeTool => ({
  name, action: "ui_meta", description: name, inputSchema: { type: "object", properties: {} }, isConcurrencySafe: true,
  execute: async () => ({ content: name, outcome: "ok" }),
});
const shippedPersonaToolEntries = personaToolEntries(shippedToolRegistry);
const PersonaDefinitionSchema = createPersonaDefinitionSchema(shippedPersonaToolEntries.map(({ name }) => name));

const PERSONA_DIR = fileURLToPath(new URL("../../../../src/workflows/agents/personas", import.meta.url));
const DOCTRINE_PATH = fileURLToPath(new URL("../../../../src/infra/agent-assets/engineering-doctrine.md", import.meta.url));
const OPTIONAL_MODULE_TOOLS = new Set(["bash", "web", "code"]);
// Every subagent can compact, so every persona holds the checkpoint tools.
const CHECKPOINT_TOOLS = ["checkpoint_read", "checkpoint_replace", "checkpoint_decide"];
const READ_ONLY_TOOLS = ["list", "read", "search", "skill", "process", "handoff", ...CHECKPOINT_TOOLS];
const IMPLEMENTER_TOOLS = ["edit", "list", "read", "search", "write", "skill", "process", "handoff", "subagent", ...CHECKPOINT_TOOLS];
const SHIP_TOOLS = ["write", "handoff", ...CHECKPOINT_TOOLS];
const EXPECTED_PERSONA_TOOLS = {
  explorer: READ_ONLY_TOOLS,
  "reviewer-code-data-integrity": READ_ONLY_TOOLS,
  "reviewer-code-design": READ_ONLY_TOOLS,
  "reviewer-code-elegance": READ_ONLY_TOOLS,
  "reviewer-code-performance": READ_ONLY_TOOLS,
  "reviewer-code-quality": READ_ONLY_TOOLS,
  "reviewer-code-security": READ_ONLY_TOOLS,
  "reviewer-plan-data-integrity": READ_ONLY_TOOLS,
  "reviewer-plan-elegance": READ_ONLY_TOOLS,
  "reviewer-plan-design": READ_ONLY_TOOLS,
  "reviewer-plan-performance": READ_ONLY_TOOLS,
  "reviewer-plan-quality": READ_ONLY_TOOLS,
  "reviewer-plan-security": READ_ONLY_TOOLS,
  "reviewer-mechanism": READ_ONLY_TOOLS,
  "reviewer-uat": READ_ONLY_TOOLS,
  advisor: ["read", "search", "list", "process", "handoff", ...CHECKPOINT_TOOLS],
  implementer: IMPLEMENTER_TOOLS,
  ship: SHIP_TOOLS,
};

const BASE_PERSONA = {
  name: "test-persona",
  description: "Tests persona selection.",
  role: "reviewer",
};

describe("persona tool grants", () => {
  it("resolves every bundled persona to an explicit reviewed tool set", () => {
    const registry = loadStandalonePersonaRegistry(PERSONA_DIR, repoDefinitions().skills(), shippedPersonaToolEntries);

    for (const [name, expected] of Object.entries(EXPECTED_PERSONA_TOOLS)) {
      const persona = registry.get(name);
      if (!persona || persona.kind !== "persona") throw new Error(`Missing bundled persona: ${name}`);
      const actual = personaToolNames(persona, registry);
      expect(actual.filter((tool) => !OPTIONAL_MODULE_TOOLS.has(tool)), name).toEqual(expected);
      for (const optional of OPTIONAL_MODULE_TOOLS) {
        expect(actual.filter((tool) => tool === optional).length, `${name}:${optional}`).toBeLessThanOrEqual(1);
        if (name === "advisor" && optional !== "bash") expect(actual, name).not.toContain(optional);
      }
    }
    // A persona that declares no file edit or write tool is read-only; the general clone and the implementer are not.
    const readOnly = Object.keys(EXPECTED_PERSONA_TOOLS).filter((name) => { const persona = registry.get(name); return persona !== undefined && isReadOnlyPersona(persona); });
    expect(readOnly).toEqual([...Object.keys(EXPECTED_PERSONA_TOOLS).filter((name) => name === "explorer" || name.startsWith("reviewer-")), "advisor"]);
    expect(isReadOnlyPersona({ kind: "general", name: "general", description: "Clone.", maxTurns: 50 })).toBe(false);
    // The shipped registry installs the shell, so an implementer can run its tests.
    const implementer = registry.get("implementer");
    if (!implementer || implementer.kind !== "persona") throw new Error("Missing bundled persona: implementer");
    expect(personaToolNames(implementer, registry)).toContain("bash");
  });

  it("keeps Advisor private, read-only, and decision-focused", () => {
    const registry = loadStandalonePersonaRegistry(PERSONA_DIR, repoDefinitions().skills(), shippedPersonaToolEntries);
    const advisor = registry.get("advisor");
    if (!advisor || advisor.kind !== "persona") throw new Error("Missing bundled persona: advisor");

    expect(advisor.description).toBe("Independent senior engineering advice with read-only repository inspection.");
    expect(advisor.systemPrompt).toContain("private guidance for the caller");
    expect(advisor.systemPrompt).toContain("one recommendation");
    expect(advisor.systemPrompt).toContain("decisive rationale");
    expect(advisor.systemPrompt).toContain("strongest counterargument");
    expect(advisor.systemPrompt).toContain("evidence would reverse");
    expect(advisor.systemPrompt).toContain("Inspect the repository read-only");
    expect(advisor.systemPrompt).toContain("Do not implement changes, run commands that change state");
  });

  it("loads Ship without verification instructions into an isolated publication persona", () => {
    const skills = repoDefinitions().skills();
    const registry = loadStandalonePersonaRegistry(PERSONA_DIR, skills, shippedPersonaToolEntries);
    const ship = registry.get("ship");
    if (!ship || ship.kind !== "persona") throw new Error("Missing bundled persona: ship");

    expect(skills.modelInvocable.map(({ id }) => id)).not.toContain("ship");
    expect(ship.requiredSkills).toEqual(["ship"]);
    expect(ship.allowFork).toBe(false);
    expect(personaToolNames(ship, registry)).toEqual(["bash", ...SHIP_TOOLS]);
    const skillContext = renderSkillClosure(ship.requiredSkills, skills, "Ship test", () => true).slice(1);
    expect(skillContext).toHaveLength(1);
    expect(skillContext[0]).toContain("# Ship Changes");
    expect(skillContext[0]).not.toContain("# Verification");
    expect(skillContext[0]).toContain("Use this method directly or through the Ship subagent");
    expect(skillContext[0]).toContain("The supplied whole-file group is the publication unit, including concurrent edits");
    expect(ship.systemPrompt).toContain("files to publish and a short summary of user intent and implemented design");
    expect(ship.systemPrompt).toContain("write the commit message yourself");
    expect(ship.systemPrompt).toContain("Do not request verification evidence");
    expect(ship.systemPrompt).toContain("Use only `summary` and `files_modified`; add no other keys");
    expect(ship.systemPrompt).toContain("Do not restate verification");
    expect(ship.systemPrompt).toContain("the one precise condition that stopped publication");
    expect(ship.systemPrompt).not.toContain("blockers");
    // The doctrine reaches every agent, including Ship, whose own method is
    // composed but not loadable; naming such a skill sends the model to a
    // `skill` load that can only fail.
    const doctrine = readFileSync(DOCTRINE_PATH, "utf-8");
    for (const skill of skills.skills.values()) {
      if (!skill.modelInvocable) expect(doctrine, skill.id).not.toContain(`\`${skill.id}\` skill`);
    }
  });

  // A persona's declared tools are a ceiling (ARCH-STRUCTURE-031): a module
  // that is off removes its tools from the persona, which still dispatches.
  it.each([
    ["advisor", "discovery", ["search", "list"]],
    ["ship", "bash", ["bash"]],
    ["ship", "file-tools", ["write"]],
  ] as const)("dispatches %s with %s off, granted its declared tools without that module's", async (name, off, lost) => {
    const revision = repoDefinitions().captureRevision();
    const persona = revision.personas.get(name);
    if (persona?.kind !== "persona") throw new Error(`Missing bundled persona: ${name}`);
    const prepare = async (disabled: readonly ModuleId[]) => {
      const prepared = await prepareSubagentTools({
        agent: persona,
        context: makeDispatchContext(),
        deps: makeDeps({ agentRegistry: revision.personas, skills: revision.skills, moduleSelection: () => composeFirstPartyModules(undefined, disabled) }),
        childDepth: 1,
      });
      if (!prepared.ok) throw new Error(prepared.error.content);
      return prepared;
    };
    const all = await prepare([]);
    const narrowed = await prepare([off]);
    for (const tool of lost) expect(all.toolNames).toContain(tool);
    expect(narrowed.toolNames).toEqual(all.toolNames.filter((tool) => !lost.some((lostTool) => lostTool === tool)));
    if (off === "bash") {
      // Ship keeps running without a shell, so neither its body nor its
      // composed method tells it to run Git; it reports the work unpublished.
      for (const shellStep of ["## Git Discipline", "Keep commit-message drafts and other publication scratch files in your scratchpad directory.", "Preflight Bash, Git", "git merge"]) {
        expect(all.task).toContain(shellStep);
        expect(narrowed.task).not.toContain(shellStep);
      }
      expect(narrowed.task).toContain("return Not published, with the missing shell as the condition that stopped publication");
      expect(all.task).not.toContain("You have no shell");
    }
    if (off === "file-tools") {
      // Without Write, Ship still publishes through Bash, and no line of its
      // task offers it the Write tool.
      expect(narrowed.task).toContain("Preflight Bash, Git");
      expect(narrowed.task).toContain("Keep commit-message drafts and other publication scratch files in your scratchpad directory.");
      expect(narrowed.task).not.toMatch(/use Write|Write or Bash|Write tool/);
    }
  });

  // The child's own plan shows what the captured composition cannot: web
  // that has no search backend, or Bash turned off after a workflow captured
  // its composition with Bash on. A declared tool that the child's plan
  // cannot run leaves its grant and its text.
  it.each(["web", "bash"])("drops a declared %s that the child's own plan cannot run from the explorer's grant and its text", async (unusable) => {
    const revision = repoDefinitions().captureRevision();
    const explorer = revision.personas.get("explorer");
    if (explorer?.kind !== "persona") throw new Error("Missing bundled persona: explorer");
    const prepare = async (runs: (tool: string) => boolean) => {
      const deps = makeDeps({
        agentRegistry: revision.personas, skills: revision.skills,
        planChildCapabilities: async (child) => agentCapabilityCheck(new Set(child.toolGrant?.filter(runs)), deps.definitionAvailability),
      });
      const prepared = await prepareSubagentTools({ agent: explorer, context: makeDispatchContext({ availableTools: new Set(["read", "subagent"]) }), deps, childDepth: 1 });
      if (!prepared.ok) throw new Error(prepared.error.content);
      return prepared;
    };
    const line = { web: "- Use web only for data that your other tools cannot provide.", bash: "use read-only `gh` commands through bash" }[unusable] ?? "";
    const all = await prepare(() => true);
    expect(all.toolNames).toContain(unusable);
    expect(all.toolNames).toContain("search");
    expect(all.task).toContain(line);
    const narrowed = await prepare((tool) => tool !== unusable);
    expect(narrowed.toolNames).toEqual(all.toolNames.filter((tool) => tool !== unusable));
    expect(narrowed.task).not.toContain(line);
  });

  it("dispatches a project persona's body byte for byte, capability markers included", async () => {
    const projectDir = temporaryDirectory("project-personas");
    const body = "Report what you find.\n{{if:bash}}\nThis line is literal.\n{{end}}\n{{end}}";
    writeFileSync(join(projectDir, "literal.md"), `---\nname: literal\ndescription: Keeps its markers.\nrole: reviewer\ntools:\n  - read\n---\n${body}\n`);
    const skills = repoDefinitions().skills();
    const registry = loadStandalonePersonaRegistry(PERSONA_DIR, skills, shippedPersonaToolEntries, undefined, projectDir);
    const persona = registry.get("literal");
    if (persona?.kind !== "persona") throw new Error("Missing project persona: literal");
    const prepared = await prepareSubagentTools({ agent: persona, context: makeDispatchContext(), deps: makeDeps({ agentRegistry: registry, skills }), childDepth: 1 });
    if (!prepared.ok) throw new Error(prepared.error.content);
    expect(prepared.task).toContain(body);
  });

  // The benchmark worker receives its persona registry through JSON, and a
  // dispatch narrows a persona's tools through a spread.
  it("renders a bundled persona's markers after a spread or a JSON round trip", () => {
    const skills = repoDefinitions().skills();
    const ship = repoDefinitions().personas().get("ship");
    if (ship?.kind !== "persona") throw new Error("Missing bundled persona: ship");
    const rendered = personaInstructions(ship, skills, () => true);
    expect(ship.systemPrompt).toContain("{{if:bash}}");
    expect(rendered).not.toMatch(/^\{\{(?:if:[^}]*|else|end)\}\}$/mu);
    const transported: typeof ship = JSON.parse(JSON.stringify(ship));
    for (const copy of [{ ...ship }, transported]) {
      expect(personaInstructions(copy, skills, () => true)).toBe(rendered);
    }
  });

  it("prints each persona's effective tools in the roster", async () => {
    const revision = repoDefinitions().captureRevision();
    const rosterLine = async (disabled: readonly ModuleId[]) => {
      const composition = composeFirstPartyModules(undefined, disabled);
      const fragment = composition.contributions.find((entry) => entry.domain === "promptFragments" && entry.id === "subagent-roster");
      if (fragment?.domain !== "promptFragments") throw new Error("Missing subagent roster fragment");
      const rendered = await fragment.value.render({
        kernel: testKernelToolDeps({ moduleSnapshot: composition, personas: revision.personas }),
        modules: composeModuleRuntimes([]),
        tools: new Map([["subagent", advertisedTool("subagent")]]),
        memorySnapshot: null,
        capabilities: () => true,
      });
      return rendered?.split("\n").find((row, index, rows) => rows[index - 1]?.startsWith("- advisor: ") === true) ?? "";
    };
    expect(await rosterLine([])).toContain("search, list");
    const narrowed = await rosterLine(["discovery"]);
    expect(narrowed).toStartWith("  Tools: ");
    expect(narrowed).toContain("read");
    expect(narrowed).not.toMatch(/\b(search|list)\b/);
  });

  it("enforces persona selection before dependency gating", async () => {
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
    const webSearchCapability = {
      available: () => true,
      run: async () => { throw new Error("Unused test web provider"); },
    };
    const child = deriveChildRuntimeSurfaces(
      {
        webSearch: () => webSearchCapability,
      },
      { handoff: { onContent: () => {} }, background },
    );
    const { accountHome, userDataRoot } = testDirectories(process.cwd());
    const registry = loadStandalonePersonaRegistry(PERSONA_DIR, repoDefinitions().skills(), shippedPersonaToolEntries);
    const explorer = registry.get("explorer");
    if (!explorer || explorer.kind !== "persona") throw new Error("Missing bundled persona: explorer");
    const personaPlan = await planToolExposure({
      kernel: testKernelToolDeps({
        userDataRoot,
        capabilities: { available: () => true },
        handoff: child.handoff,
        backgroundTasks: child.background?.tasks,
        skills: testSkillRevision([testSkill("test-child-skill")]),
      }),
      modules: composeModuleRuntimes([
        ["code-mode", codeModeRuntimeOver()],
        ["web", () => webSearchCapability],
        ["learning", { memory: { accountHome }, skillManage: { userDataRoot, origin: { kind: "agent", sessionId: "test-session" }, registry: () => testSkillRevision([]) } }],
        ["definition-overrides", {
          available: () => true,
          list: async () => ({ overrides: [], diagnostics: [] }),
          diff: async () => { throw new Error("Unused definition override diff"); },
          prepare: async () => { throw new Error("Unused definition override preparation"); },
          apply: async () => { throw new Error("Unused definition override application"); },
          refresh: async () => {},
          proposal: () => undefined,
          finalizeSkillPublication: async () => { throw new Error("Unused skill publication"); },
        }],
      ]),
      selected: new Set(personaToolNames(explorer, registry)),
    });

    const planned = [...personaPlan.tools.keys()];
    expect(planned.filter((tool) => !OPTIONAL_MODULE_TOOLS.has(tool))).toEqual(["list", "read", "search", "handoff", "process", "skill", "papercut_log", "papercut_dispose"]);
    for (const optional of OPTIONAL_MODULE_TOOLS) {
      expect(planned.filter((tool) => tool === optional).length).toBeLessThanOrEqual(1);
    }
    for (const name of ["memory", "skill_manage", "definition_overrides", "ask_user", "workflow", "benchmark", "edit", "write", "subagent"]) {
      expect(personaPlan.tools.has(name), name).toBe(false);
    }

    const missingSurfacePlan = await planToolExposure({
      kernel: testKernelToolDeps({
        userDataRoot,
        capabilities: { available: () => true },
        handoff: child.handoff,
        backgroundTasks: child.background?.tasks,
        skills: testSkillRevision([testSkill("test-child-skill")]),
      }),
      modules: composeModuleRuntimes([["web", () => webSearchCapability]]),
      selected: new Set(Object.keys(toolRegistrations)),
    });
    expect(missingSurfacePlan.omitted).toEqual(expect.arrayContaining([
      { name: "ask_user", reason: "no ask-user controller available" },
      { name: "code", reason: "code mode is not wired" },
      { name: "definition_overrides", reason: "no definition override projection available" },
      { name: "memory", reason: "no memory store available" },
      { name: "recall", reason: "no conversation history available" },
      { name: "skill_manage", reason: "no skill store available" },
      { name: "subagent", reason: "no subagent registry available" },
      { name: "workflow", reason: "no workflow starter available" },
    ]));
  });

  it("names the shorter of the usable and the refused lists", () => {
    const advertised = ["read", "list", "search", "edit", "write", "bash"];
    const writer = { readOnly: false, shell: false };
    expect(toolGrantRules(["read", "list"], advertised, writer)[0]).toBe("## Tools\n\nYou may call these tools: read, list. A call to any other tool is refused.");
    expect(toolGrantRules(["read", "list", "search", "edit", "write"], advertised, writer)[0]).toBe("## Tools\n\nThese listed tools do not work for you: bash. Do not call them; a call is refused.");
    // A tie and a grant of every advertised tool keep the usable list.
    expect(toolGrantRules(["read", "list", "search"], advertised, writer)[0]).toBe("## Tools\n\nYou may call these tools: read, list, search. A call to any other tool is refused.");
    expect(toolGrantRules(advertised, advertised, writer)[0]).toBe(`## Tools\n\nYou may call these tools: ${advertised.join(", ")}. A call to any other tool is refused.`);
  });

  it("states the read-only and shell rules from the agent's authority, whatever name its edit and shell tools carry", () => {
    // A patch-contract model is advertised edit as apply_patch and bash as exec.
    const advertised = ["read", "apply_patch", "exec", "write", "web"];
    const request = {
      tools: new Map(advertised.map((name) => [name, advertisedTool(name)])),
      usableToolNames: new Set(["read", "edit", "bash"]),
      registrationIdentities: new Map([["apply_patch", "edit"], ["exec", "bash"]]),
    };
    const headings = (readOnly: boolean) => toolNotice(request, readOnly)?.split("\n\n").filter((line) => line.startsWith("## "));
    expect(headings(false)).toEqual(["## Tools", "## Safety"]);
    expect(headings(true)).toEqual(["## Tools", "## Read-Only", "## Safety"]);
    expect(toolNotice(request, false)).toContain("These listed tools do not work for you: write, web.");
  });

  it("tells an agent that may call no tool to answer in text", () => {
    expect(toolGrantRules([], ["read", "bash"], { readOnly: false, shell: false })[0]).toBe("## Tools\n\nCall no tools. Every tool call is refused; answer in text.");
  });

  it("refuses exactly the advertised tools that the opening notice does not let the agent call, including code and the MCP tools behind it", async () => {
    let mcpCalls = 0;
    const mcp = mcpPortsOver([{ server: "github", name: "issue_get", inputSchema: { type: "object" } }], async () => {
      mcpCalls += 1;
      throw new Error("an ungranted code tool reached an MCP tool");
    });
    const planned = await planToolExposure({
      kernel: testKernelToolDeps({ treeHosted: true, capabilities: { available: () => true } }),
      modules: composeModuleRuntimes([["mcp", mcpRuntimeOver(mcp)], ["code-mode", codeModeRuntimeOver()]]),
      granted: { tools: new Set(["read", "list"]), ambient: true },
    });
    const advertised = [...planned.tools.keys()];
    const notice = toolGrantRules([...planned.usable], advertised, { readOnly: false, shell: false })[0] ?? "";
    const allowed = /You may call these tools: (.*)\. A call to any other tool is refused\./.exec(notice)?.[1]?.split(", ");
    if (!allowed) throw new Error(`Unexpected notice: ${notice}`);
    const refusing: string[] = [];
    for (const [name, tool] of planned.tools) {
      const result = await tool.execute({}, makeContext());
      if (typeof result.content === "string" && result.content.includes(`Do not call ${name} again`)) refusing.push(name);
    }
    expect(refusing).toContain("code");
    expect(refusing).toEqual(advertised.filter((name) => !allowed.includes(name)));
    const code = await planned.tools.get("code")?.execute({ source: "return await tools.github.issue_get({})" }, makeContext());
    expect(code?.content).toContain("Do not call code again");
    expect(mcpCalls).toBe(0);
  });

  it("accepts an empty exclusion list", () => {
    expect(Schema.decodeUnknownSync(PersonaDefinitionSchema)({ ...BASE_PERSONA, excludeActions: [] }).excludeActions).toEqual([]);
  });

  it("rejects both selection forms", () => {
    expect(() => Schema.decodeUnknownSync(PersonaDefinitionSchema)({ ...BASE_PERSONA, tools: ["read"], excludeActions: [] })).toThrow();
  });

  it("rejects a missing selection form", () => {
    expect(() => Schema.decodeUnknownSync(PersonaDefinitionSchema)(BASE_PERSONA)).toThrow();
  });

  it("rejects an unknown legacy tool name", () => {
    expect(() => Schema.decodeUnknownSync(PersonaDefinitionSchema)({ ...BASE_PERSONA, tools: ["typo_tool"] })).toThrow(/at \["tools"\]\[0\]/);
  });

  it("rejects an unknown excluded action", () => {
    expect(() => Schema.decodeUnknownSync(PersonaDefinitionSchema)({ ...BASE_PERSONA, excludeActions: ["unknown_action"] })).toThrow(/at \["excludeActions"\]\[0\]/);
  });
});
