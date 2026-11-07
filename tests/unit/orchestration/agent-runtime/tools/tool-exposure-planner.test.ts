import { describe, expect, it } from "bun:test";
import { fullAuthority } from "../../../../helpers/launch-authority.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelToolDeps } from "../../../../../src/orchestration/agent-runtime/tools/kernel-tool-deps.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import { testBaseTools, testCapabilityModules, testRuntimeConfigCapture, plannedRequest } from "../../../../helpers/request-tool-surface.js";
import type { HandoffToolSchema } from "../../../../../src/orchestration/workflow-host/handoff-tool-schema.js";
import { buildSystemPrompt } from "../../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt, stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { testSkill } from "../../../../helpers/skill-fixtures.js";
import { runtimeToolExecution, type RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { mcpPortsOver, mcpRuntimeOver } from "../../../../helpers/mcp.js";
import { codeModeRuntimeOver } from "../../../../helpers/code-mode-worker.js";
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js";
import type { AskUserController } from "../../../../../src/orchestration/runner/ask-user-controller.js";
import type { SkillManageToolDeps } from "../../../../../src/orchestration/modules/learning/tools/skill-manage.js";
import type { WorkflowToolDeps } from "../../../../../src/orchestration/agent-runtime/tools/workflow-tool.js";
import type { LearningRuntime } from "../../../../../src/orchestration/modules/learning.js";
import type { WorkflowsRuntime } from "../../../../../src/orchestration/modules/workflows.js";
import type { WorkflowsMode } from "../../../../../src/protocol/module-protocol-types.js";
import type { ModuleId } from "../../../../../src/protocol/module-ids.js";
import { createRecordingFileMutationStore, makeContext } from "./_fixtures.js";
import { ALL_CAPABILITIES, askUserController, plan, skillRevision, subagentsRuntime, userDataRoot } from "./_planner-fixtures.js";
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../../../src/orchestration/modules.js";
import { createToolRegistry } from "../../../../../src/orchestration/tool-catalog.js";
import { DEVELOPMENT_MODULES } from "../../../../../src/orchestration/development-modules.js";
import { learningReviewToolNames } from "../../../../../src/orchestration/agent-runtime/tools/tool-registry.js";
import { createIosSimulatorTool } from "../../../../../src/orchestration/modules/development/ios-simulator-tool.js";
import { createRequestToolSurface } from "../../../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE, resolveModelInteractionProfile } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { unusedSessionMessaging } from "../../../../helpers/child-session-control.js";
import { asRecord } from "../../../../../src/infra/record.js";
import { promptOptions } from "../../../../helpers/prompt-capabilities.js";

const STATIC_TOOL_NAMES = ["bash", "read", "write", "edit", "search", "list"];
/** A messaging authority the planner only has to see. */
const sessionMessaging = unusedSessionMessaging();

/** Exposure is the subject here, so the deps only have to exist: every surface
 *  a benchmark would actually use throws. */
function benchmarkDeps() {
  return {
    userDataRoot,
    accountHome: userDataRoot,
    definitions: { skills: () => skillRevision([]) },
    moduleSelection: composeFirstPartyModules,
    runOwnedCommand: () => { throw new Error("unused in this test"); },
    captureProviderConnection: () => { throw new Error("unused in this test"); },
  };
}

function developmentRuntime() {
  return {
    benchmark: benchmarkDeps(),
    iosSimulator: createIosSimulatorTool({
      execute: () => { throw new Error("unused in this test"); },
    }),
  };
}

/** Workflow deps of one mode. Only the mode and the launch-target resolver are
 *  read by the planner; a launch would fail, which no exposure test performs. */
function workflowDeps(mode: WorkflowsMode): WorkflowToolDeps {
  return {
    startWorkflow: async () => ({ error: "unused in this test" }),
    onRenderEvent: () => {},
    mode,
    resolveLaunchTarget: async () => ({ error: "unused in this test" }), executionCwd: "/project",
  };
}

function workflowsRuntime(mode: WorkflowsMode): WorkflowsRuntime {
  return { deps: () => workflowDeps(mode), authority: () => fullAuthority() };
}

function learningRuntime(root = userDataRoot): LearningRuntime {
  return { memory: { accountHome: root, sessionId: "sess-1" }, skillManage: skillManageDeps(root) };
}

function skillManageDeps(root = userDataRoot): SkillManageToolDeps {
  return { userDataRoot: root, origin: { kind: "agent", sessionId: "session-1" }, registry: () => skillRevision([]) };
}

/** The `decision` properties the planned ask_user advertises, or undefined when
 *  the session has no typed decision surface and advertises no `decision`. */
function decisionProperties(planned: Awaited<ReturnType<typeof planToolExposure>>): RuntimeToolInput | undefined {
  const schema = asRecord(planned.tools.get("ask_user")?.inputSchema);
  const properties = asRecord(schema?.properties);
  const decision = asRecord(properties?.decision);
  return asRecord(decision?.properties);
}

describe("planToolExposure", () => {
  it("omits handoff when no handoff capture is configured", async () => {
    const planned = await plan();
    expect(planned.tools.has("handoff")).toBe(false);
    expect(planned.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "handoff", reason: expect.stringContaining("no handoff capture") }),
    ]));
  });

  it("keeps the stub handoff when a handoff capture is configured", async () => {
    expect((await plan({ handoff: {} })).tools.has("handoff")).toBe(true);
  });

  it("replaces handoff with a schema-bound variant when a handoff schema is provided", async () => {
    const schema: HandoffToolSchema = {
      input: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    };
    const handoff = (await plan({ handoff: { schema } })).tools.get("handoff");
    expect(handoff).toBeDefined();
    expect(handoff?.inputSchema).toMatchObject({ properties: { summary: expect.anything() } });
  });

  it("grants background management after allowlist filtering", async () => {
    const backgroundTasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    const background = (await plan({ backgroundTasks, capabilities: ALL_CAPABILITIES }, [], { selected: new Set(["read"]) })).tools.get("process");

    expect(background).toBeDefined();
    expect(testBaseTools().has("process")).toBe(false);
    expect(await background!.execute({ action: "list" }, makeContext())).toEqual({
      content: "No managed processes and no children. Other sessions of this project are in list_sessions.",
      outcome: "ok",
    });
  });

  // The benchmark tool exists only where the development module is installed,
  // so these two plans compose the catalog the source entry installs.
  const sourceModules = composeFirstPartyModules([...SHIPPED_MODULES, ...DEVELOPMENT_MODULES]);

  it("omits benchmark when no benchmark runtime is wired", async () => {
    const planned = await plan({ moduleSnapshot: sourceModules });
    expect(planned.tools.has("benchmark")).toBe(false);
    expect(planned.omitted).toContainEqual({ name: "benchmark", reason: "no benchmark runtime available" });
    expect(planned.tools.has("ios_simulator")).toBe(false);
    expect(planned.omitted).toContainEqual({ name: "ios_simulator", reason: "no owned command runner available" });
  });

  it("grants benchmark to the turn whose development runtime is wired", async () => {
    // A release never installs the development module, so no build flag is
    // consulted: the runtime instance is the whole grant.
    const granted = await plan({ moduleSnapshot: sourceModules }, [["development", developmentRuntime()]]);
    expect(granted.tools.has("benchmark")).toBe(true);
    expect(granted.tools.has("ios_simulator")).toBe(true);
    // The same map drives the advertisement and dispatch, so a candidate runner
    // whose tool surface is an explicit allowlist cannot launch a benchmark.
    const candidate = await plan({ moduleSnapshot: sourceModules }, [["development", developmentRuntime()]], { selected: new Set(["read", "search", "handoff"]) });
    expect(candidate.tools.has("benchmark")).toBe(false);
    expect(candidate.omitted).toContainEqual({ name: "benchmark", reason: "not in selected allowlist" });
  });

  it("exposes a runnable skill tool that loads a package's canonical context", async () => {
    const skill = (await plan({
      capabilities: ALL_CAPABILITIES,
      skills: skillRevision([testSkill("alpha", { body: "Alpha procedure." })]),
    })).tools.get("skill");
    expect(skill).toBeDefined();

    const result = await skill!.execute({ action: "load", skill_id: "alpha" }, makeContext({ capabilities: () => true }));

    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("Alpha procedure.");
    expect(result.content).not.toContain("## Direct Execution");
  });

  it("pins skill execution to each planned request revision", async () => {
    const first = testSkill("first");
    const second = testSkill("second");
    const firstRevision = publishSkillRevision(1, new Map([[first.id, first]]));
    let current = firstRevision;
    const oldRequest = await plan({ capabilities: ALL_CAPABILITIES, skills: current });

    current = publishSkillRevision(2, new Map([[second.id, second]]));
    const oldTool = oldRequest.tools.get("skill");
    expect(oldRequest.skillRegistry).toBe(firstRevision);
    expect((await oldTool!.execute({ action: "load", skill_id: "first" }, makeContext({ capabilities: () => true }))).outcome).toBe("ok");
    expect((await oldTool!.execute({ action: "load", skill_id: "second" }, makeContext({ capabilities: () => true }))).outcome).toBe("error");

    const nextRequest = await plan({ capabilities: ALL_CAPABILITIES, skills: current });
    expect(nextRequest.skillRegistry).toBe(current);
    expect((await nextRequest.tools.get("skill")!.execute({ action: "load", skill_id: "second" }, makeContext({ capabilities: () => true }))).outcome).toBe("ok");
  });

  it("filters down to the explicit selected set without mutating the base registry", async () => {
    const planA = await plan({}, [], { selected: new Set(["read", "search"]) });
    expect([...planA.tools.keys()]).toEqual(expect.arrayContaining(["read", "search"]));
    expect(planA.tools.has("bash")).toBe(false);
    // Subsequent calls with different selections see the same base: selection
    // is per-turn, never mutates the static map.
    const planB = await plan();
    expect(planB.tools.has("bash")).toBe(true);
  });

  it("keeps the no-tool profile empty despite ambient, handoff, and nested module authority", async () => {
    const hit = { server: "github", name: "issue_get", inputSchema: { type: "object" } };
    const constructed: string[] = [];
    const composition = composeFirstPartyModules();
    const moduleSnapshot = {
      ...composition,
      contributions: composition.contributions.map((contribution) => {
        if (contribution.domain !== "codeTools") return contribution;
        return {
          ...contribution,
          value: {
            ...contribution.value,
            create: (...args: Parameters<typeof contribution.value.create>) => {
              constructed.push("codeTools");
              return contribution.value.create(...args);
            },
          },
        };
      }),
    };
    const registry = new Map([...createToolRegistry()].map(([id, registration]) => [id, {
      ...registration,
      create: (...args: Parameters<typeof registration.create>) => {
        constructed.push(id);
        return registration.create(...args);
      },
    }]));
    const planned = await plan({
      moduleSnapshot,
      capabilities: ALL_CAPABILITIES,
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
      handoff: {},
      skills: skillRevision([testSkill("fixture")]),
    }, [["mcp", mcpRuntimeOver(mcpPortsOver([hit]))], ["code-mode", codeModeRuntimeOver()]], {
      profile: "none",
      selected: new Set(["read", "code", "handoff", "skill"]),
      registry,
      exposureGate: async () => {
        constructed.push("exposureGate");
        return new Map();
      },
    });

    expect([...planned.tools.keys()]).toEqual([]);
    expect([...planned.eligibleTools.keys()]).toEqual([]);
    expect([...planned.registrationIds.keys()]).toEqual([]);
    expect([...planned.registrationIdentities.keys()]).toEqual([]);
    expect(planned.skillRegistry).toBeUndefined();
    expect(constructed).toEqual([]);
    expect(planned.omitted).toContainEqual({ name: "papercut_log", reason: "excluded by the no-tool profile" });
  });

  it("marks subagent and workflow as background runtime tools", async () => {
    const planned = await plan({ capabilities: ALL_CAPABILITIES }, [["subagents", subagentsRuntime()], ["workflows", workflowsRuntime("on")]]);
    expect(runtimeToolExecution(planned.tools.get("subagent"))).toMatchObject({
      mode: "background",
      traceKind: "subagent",
    });
    expect(runtimeToolExecution(planned.tools.get("workflow"))).toMatchObject({
      mode: "background",
      traceKind: "subagent",
      childHasOwnViewport: true,
    });
    expect(runtimeToolExecution(planned.tools.get("read"))).toMatchObject({
      mode: "foreground",
      traceKind: "tool",
    });
  });

  it("omits the workflow tool in OFF and names capability policy as the reason", async () => {
    const planned = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() }, [["workflows", workflowsRuntime("off")]]);

    expect(planned.tools.has("workflow")).toBe(false);
    expect(planned.omitted).toContainEqual({ name: "workflow", reason: "workflows is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" });
    expect(decisionProperties(planned)).toBeUndefined();
  });

  it("advertises the workflow_launch decision in ASK only", async () => {
    const ask = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() }, [["workflows", workflowsRuntime("ask")]]);
    const on = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() }, [["workflows", workflowsRuntime("on")]]);

    expect(Object.keys(decisionProperties(ask) ?? {})).toEqual(["workflow_launch"]);
    expect(decisionProperties(on)).toBeUndefined();
  });

  it("exposes workflows only for executable mode and Ask User combinations", async () => {
    const cases = [
      { mode: "ask", askUser: true, exposed: true },
      { mode: "ask", askUser: false, exposed: false },
      { mode: "on", askUser: true, exposed: true },
      { mode: "on", askUser: false, exposed: true },
      { mode: "off", askUser: true, exposed: false },
      { mode: "off", askUser: false, exposed: false },
    ] as const;

    for (const entry of cases) {
      const planned = await plan({
        capabilities: ALL_CAPABILITIES,
        ...(entry.askUser ? { askUser: askUserController() } : {}),
      }, [["workflows", workflowsRuntime(entry.mode)]]);
      expect(planned.tools.has("workflow"), `${entry.mode}/${entry.askUser}`).toBe(entry.exposed);
    }
  });

  it("never advertises the retired global skill decision", async () => {
    const withWrites = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() }, [["learning", learningRuntime()]]);
    const withoutWrites = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() });

    expect(decisionProperties(withWrites)).toBeUndefined();
    expect(decisionProperties(withoutWrites)).toBeUndefined();
  });

  it("writes a global skill through its learning runtime without Ask User", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-global-skill-decision-"));
    const projectRoot = join(root, "project");
    const runtimeRoot = join(root, "runtime");
    const { writer } = createRecordingFileMutationStore();
    let asked = false;
    const askUser: AskUserController = {
      ask: async () => {
        asked = true;
        return { kind: "cancelled" };
      },
      answerQuestion: () => {},
      cancelQuestion: () => {},
      suspendAll: () => false,
    };

    try {
      const planned = await plan({
        capabilities: ALL_CAPABILITIES,
        askUser,
        userDataRoot: join(root, "request"),
      }, [["learning", learningRuntime(runtimeRoot)]]);
      const context = makeContext({
        projectRoot,
        executionCwd: projectRoot,
        sessionEventWriter: writer,
        conversationId: "conversation-1",
        sessionId: "session-1",
      });
      const result = await planned.tools.get("skill_manage")?.execute({
        action: "save",
        name: "global-notes",
        description: "Use for global notes.",
        body: "Body.",
        reach: "global",
      }, { ...context, toolUseId: "prepare" });
      expect(result?.outcome).toBe("ok");
      expect(result?.content).toContain("Reach: global");
      expect(asked).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives Ask User decisions from the final allowlisted owner surfaces", async () => {
    const definitionOverrides = {
      available: () => true,
      list: async () => ({ overrides: [], diagnostics: [] }),
      diff: async () => ({ version: 1 as const, files: [], omissions: [] }),
      prepare: async () => { throw new Error("unused"); },
      apply: async () => {},
      refresh: async () => {},
      proposal: () => undefined,
      finalizeSkillPublication: async () => {},
    };
    const owners = [
      { name: "skill_manage", runtime: ["learning", learningRuntime()] },
      { name: "definition_overrides", runtime: ["definition-overrides", definitionOverrides] },
      { name: "workflow", runtime: ["workflows", workflowsRuntime("ask")] },
    ] as const;

    for (const owner of owners) {
      const planned = await plan({ capabilities: ALL_CAPABILITIES, askUser: askUserController() }, [owner.runtime], { selected: new Set(["ask_user"]) });
      expect(planned.tools.has("ask_user")).toBe(true);
      expect(planned.tools.has(owner.name)).toBe(false);
      expect(decisionProperties(planned), owner.name).toBeUndefined();
    }
  });

  it("never exposes retired MCP meta-tools", async () => {
    const mcp = ["mcp", mcpRuntimeOver(mcpPortsOver([]))] as const;
    const wired = await plan({}, [mcp, ["code-mode", codeModeRuntimeOver()]], { selected: new Set(["read", "code"]) });
    const unwired = await plan({}, [mcp]);

    for (const planned of [wired, unwired]) {
      expect(planned.tools.has("mcp_search")).toBe(false);
      expect(planned.tools.has("mcp_call")).toBe(false);
      expect(planned.eligibleTools.has("mcp_search")).toBe(false);
      expect(planned.eligibleTools.has("mcp_call")).toBe(false);
    }
    expect(wired.tools.has("code")).toBe(true);
    expect(unwired.tools.has("code")).toBe(false);
    expect(unwired.omitted).toContainEqual({ name: "code", reason: "code mode is not wired" });
  });

  it("withholds the code surface and its MCP exclusives from a selected realm that did not name code", async () => {
    const hit = {
      server: "github",
      name: "issue_get",
      description: "Get one issue",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    };
    const mcp = ["mcp", mcpRuntimeOver(mcpPortsOver([hit]))] as const;
    const codeMode = ["code-mode", codeModeRuntimeOver()] as const;

    const scoped = await plan({}, [mcp, codeMode], { selected: new Set(["read"]) });
    expect(scoped.tools.has("code")).toBe(false);
    expect(scoped.eligibleTools.has("code")).toBe(false);
    expect(scoped.eligibleTools.has("github.issue_get")).toBe(false);
    expect(scoped.omitted).toContainEqual({ name: "code", reason: "not in selected allowlist" });

    const granted = await plan({}, [mcp, codeMode], { selected: new Set(["read", "code"]) });
    expect(granted.tools.has("code")).toBe(true);
    expect(granted.eligibleTools.has("github.issue_get")).toBe(true);
    expect(granted.tools.has("github.issue_get")).toBe(false);
  });

  it("materializes MCP tools only in code-mode eligibility and nested execution", async () => {
    const hit = {
      server: "github",
      name: "issue_get",
      description: "Get one issue",
      inputSchema: { type: "object", properties: { number: { type: "number" } }, required: ["number"] },
      annotations: { readOnlyHint: true },
    };
    // `linear` is configured and still connecting: the catalog names it before its tools arrive.
    const mcp = { ...mcpPortsOver([hit], async ({ name }) => ({ content: [{ type: "text" as const, text: name }], isError: false })), servers: () => ["github", "linear"] };
    const planned = await plan({}, [["mcp", mcpRuntimeOver(mcp)], ["code-mode", codeModeRuntimeOver()]]);

    const exclusive = planned.eligibleTools.get("github.issue_get");
    expect(exclusive?.codeMode).toBe("exclusive");
    expect(exclusive?.action).toBe("shell_exec");
    expect(exclusive?.isConcurrencySafe).toBe(true);
    expect(planned.tools.has("github.issue_get")).toBe(false);
    const code = planned.tools.get("code");
    expect(code?.promptGuidelines?.join("\n")).toContain("## Namespaces\n\n- github\n- linear");
    expect(code?.promptGuidelines?.join("\n")).not.toContain("tools.read(");
    expect(planned.eligibleTools.get("code")).toBe(code);
    expect(code?.gateAdmission).toBe("none");
    expect(planned.registrationIdentities.get("github.issue_get")).toBe(planned.registrationIdentities.get("code"));
    expect(await exclusive?.execute({ number: 7 }, makeContext())).toEqual({ content: [{ type: "text", text: "issue_get" }], outcome: "ok" });
  });

  it("exposes code while keeping native MCP names provider-hidden", async () => {
    const hit = { server: "github", name: "issue_get", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
    const planned = await plan({}, [["mcp", mcpRuntimeOver(mcpPortsOver([hit]))], ["code-mode", codeModeRuntimeOver()]]);

    expect(planned.tools.has("code")).toBe(true);
    expect(planned.eligibleTools.has("code")).toBe(true);
    expect(planned.tools.has("mcp_search")).toBe(false);
    expect(planned.tools.has("mcp_call")).toBe(false);
    expect(planned.tools.has("github.issue_get")).toBe(false);
    expect(planned.eligibleTools.has("github.issue_get")).toBe(true);
  });

  it("omits skill when every installed skill is model-disabled", async () => {
    const planned = await plan({ capabilities: ALL_CAPABILITIES, skills: skillRevision([testSkill("private", { modelInvocable: false })]) });
    expect(planned.tools.has("skill")).toBe(false);
    expect(planned.omitted).toEqual(expect.arrayContaining([
      { name: "skill", reason: "no model-invocable skills installed" },
    ]));
  });

  it("grants skill after allowlist filtering and advertises its roster", async () => {
    const skill = (await plan({ capabilities: ALL_CAPABILITIES, skills: skillRevision([testSkill("pdf-processing")]) }, [], { selected: new Set(["read"]) })).tools.get("skill");
    expect(skill).toBeDefined();
    expect(testBaseTools().has("skill")).toBe(false);
    expect(skill!.promptGuidelines!.join("\n")).toContain("pdf-processing");
  });

  it("advertises a skill only while the tree's modules make it available", async () => {
    const skills = skillRevision([testSkill("pdf-processing"), testSkill("dispatching", { agents: ["advisor"] })]);
    const roster = async (disabled: readonly ModuleId[]) => (await plan({ capabilities: ALL_CAPABILITIES, skills, moduleSnapshot: composeFirstPartyModules(undefined, disabled) }))
      .tools.get("skill")?.promptGuidelines?.join("\n") ?? "";

    expect(await roster([])).toContain("- dispatching: ");
    const withoutSubagents = await roster(["subagents"]);
    expect(withoutSubagents).toContain("- pdf-processing: ");
    expect(withoutSubagents).not.toContain("- dispatching: ");
  });

  it("pins one skill revision for the advertised roster and request metadata", async () => {
    const revision = skillRevision([testSkill("fly.code-review"), testSkill("private", { modelInvocable: false })]);
    const planned = await plan({ capabilities: ALL_CAPABILITIES, skills: revision });

    expect(planned.skillRegistry).toBe(revision);
    expect(planned.tools.get("skill")?.promptGuidelines?.join("\n")).toContain("fly.code-review");
  });

  it("exposes only the load and resource actions", async () => {
    const schema = JSON.stringify((await plan({ capabilities: ALL_CAPABILITIES, skills: skillRevision([testSkill("pdf-processing")]) })).tools.get("skill")!.inputSchema);

    expect(schema).not.toContain("query");
    expect(schema).not.toContain("limit");
    expect(schema).not.toContain('\\"list\\"');
    expect(schema).not.toContain("page");
    expect(schema).toContain("offset");
  });
});

describe("a request that owns no capability policy", () => {
  /** Every optional surface wired, so absence of a policy is the only reason
   *  any of them could be withheld. */
  const wired = async () => plan({
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
    askUser: askUserController(),
    skills: skillRevision([testSkill("pdf-processing")]),
  }, [["learning", learningRuntime()], ["workflows", workflowsRuntime("on")], ["subagents", subagentsRuntime()]]);

  it("advertises no optional tool at all", async () => {
    const planned = await wired();

    for (const name of ["skill", "memory", "skill_manage", "subagent", "workflow", "process"]) {
      expect(planned.tools.has(name)).toBe(false);
    }
    expect(planned.omitted).toEqual(expect.arrayContaining([
      { name: "skill", reason: "skills is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" },
      { name: "memory", reason: "learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" },
      { name: "subagent", reason: "subagents is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" },
    ]));
  });

  it("keeps Bash and the other core tools", async () => {
    const planned = await wired();

    for (const name of STATIC_TOOL_NAMES) expect(planned.tools.has(name)).toBe(true);
    expect(planned.tools.get("bash")!.description).toContain("Execute a shell command");
  });
});

describe("chat change review guidance gating", () => {
  const skillTool = { name: "skill", action: "ui_meta" as const, description: "Load a skill package." };
  const base = { task: "", tools: [skillTool], promptKind: "chat" as const, chatHost: { communication: true as const } };

  it("names the review skill only when the package and request skill tool are available in chat", () => {
    const loadSkill = "load the `code-review` skill";
    expect(renderSystemPrompt(buildSystemPrompt(promptOptions({ ...base, skills: ["code-review"] })))).toContain(loadSkill);
    for (const opts of [{ ...base, tools: [], skills: ["code-review"] }, { ...base, skills: [] }, { ...base }]) {
      const prompt = renderSystemPrompt(buildSystemPrompt(promptOptions(opts)));
      expect(prompt).toContain("CHAT CHANGE REVIEW:");
      expect(prompt).not.toContain(loadSkill);
      expect(prompt).toContain("review the draft yourself");
    }
    expect(renderSystemPrompt(buildSystemPrompt(promptOptions({ ...base, chatHost: undefined, promptKind: "subagent", skills: ["code-review"] })))).not.toContain("CHAT CHANGE REVIEW:");
  });
});
describe("Learning surfaces under capability policy", () => {
  const capabilities = (held: readonly string[]) => ({ available: (capability: string) => held.includes(capability) });
  const learning = async (held: readonly string[]) => plan({ capabilities: capabilities(held) }, [["learning", learningRuntime()]]);

  it("omits memory and skill_manage while Learning is off and names the policy", async () => {
    const planned = await learning(["skills"]);

    expect(planned.tools.has("memory")).toBe(false);
    expect(planned.tools.has("skill_manage")).toBe(false);
    expect(planned.omitted).toEqual(expect.arrayContaining([
      { name: "memory", reason: "learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" },
      { name: "skill_manage", reason: "learning is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" },
    ]));
  });

  it("exposes memory only when Learning is held without Skills", async () => {
    const planned = await learning(["learning"]);

    expect(planned.tools.has("memory")).toBe(true);
    expect(planned.tools.has("skill_manage")).toBe(false);
    expect(planned.omitted).toEqual(expect.arrayContaining([
      { name: "skill_manage", reason: "skills is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" },
    ]));
  });

  it("exposes both managed-learning surfaces when Learning and Skills are held", async () => {
    const planned = await learning(["learning", "skills"]);

    expect(planned.tools.has("memory")).toBe(true);
    expect(planned.tools.has("skill_manage")).toBe(true);
  });
});

describe("Learning capability module composition", () => {
  it("contributes both Learning tools only while the module is enabled", () => {
    expect(composeFirstPartyModules().contributions.filter((entry) => entry.domain === "tools").map((entry) => entry.id)).toEqual(expect.arrayContaining(["memory", "skill_manage"]));
    expect(composeFirstPartyModules(undefined, ["learning"]).contributions.some((entry) => entry.id === "memory" || entry.id === "skill_manage")).toBe(false);
  });
});
describe("native registry planning", () => {
  it("applies ordinary selection and omission evidence to every request", async () => {
    const planned = await plan({
      capabilities: ALL_CAPABILITIES,
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
      persistentProcesses: true,
    }, [], { selected: new Set(["bash", "process", "edit", "list", "read", "search", "write"]) });

    expect([...planned.tools.keys()]).toEqual(["bash", "edit", "list", "read", "search", "write", "process", "papercut_log", "papercut_dispose"]);
    expect(planned.omitted).toContainEqual({ name: "ask_user", reason: "not in selected allowlist" });
    expect(planned.tools.get("read")?.description).toContain("Image files");
    expect(planned.registrationIdentities.get("process")).toBe("process");
    expect(planned.registrationIds.get("process")).toBe("process.native");
  });

  it("serves gpt-6-luna native bash, native process, and apply_patch", async () => {
    const planned = await plan({
      capabilities: ALL_CAPABILITIES,
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
      fileEditContract: resolveModelInteractionProfile("gpt-6-luna", "openai").fileEditContract,
    });
    expect(planned.registrationIds.get("bash")).toBe("bash");
    expect(planned.registrationIds.get("process")).toBe("process.native");
    expect(planned.tools.has("apply_patch")).toBe(true);
    expect(planned.tools.has("exec")).toBe(false);
  });

  it("keeps ambient papercut tools through explicit selection without granting learning review", async () => {
    const registry = createToolRegistry();
    const planned = await plan({}, [], { selected: new Set(["read"]), registry });

    expect([...planned.tools.keys()]).toEqual(["read", "papercut_log", "papercut_dispose"]);
    expect(registry.get("papercut_log")).toMatchObject({ category: "ambient", capabilities: [], cloneInheritance: "inherit" });
    expect(registry.get("papercut_dispose")).toMatchObject({ category: "ambient", capabilities: [], cloneInheritance: "inherit" });
    expect(learningReviewToolNames(registry).has("papercut_log")).toBe(false);
    expect(learningReviewToolNames(registry).has("papercut_dispose")).toBe(false);
  });
});

describe("every registered tool schema", () => {
  it("materializes with an object root for the provider request", async () => {
    // Providers reject a tool whose input schema root is not one object. A
    // bare oneOf root on ios_simulator blocked every request in the project on
    // 2026-09-21, and the request-time guard only fires after a user has sent
    // a message, so every registration crosses the same guard here first.
    const sourceModules = composeFirstPartyModules([...SHIPPED_MODULES, ...DEVELOPMENT_MODULES]);
    const planned = await plan({
      capabilities: ALL_CAPABILITIES,
      moduleSnapshot: sourceModules,
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
      askUser: askUserController(),
      handoff: {},
      sessions: sessionMessaging,
      skills: skillRevision([testSkill("pdf-processing")]),
    }, [
      ["code-mode", codeModeRuntimeOver()],
      ["learning", learningRuntime()],
      ["workflows", workflowsRuntime("on")],
      ["subagents", subagentsRuntime()],
      ["development", developmentRuntime()],
      ["mcp", mcpRuntimeOver(mcpPortsOver([]))],
    ]);
    const owner = await createRequestToolSurface(() => plannedRequest(planned), () => sourceModules, testRuntimeConfigCapture);
    const surface = await owner.resolve();
    const prompt = await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);

    const names = prompt.definitions.map((definition) => definition.name);
    expect(names).toEqual(expect.arrayContaining([...STATIC_TOOL_NAMES, "ios_simulator", "subagent", "workflow", "skill", "memory", "process", "code", "message_session", "list_sessions"]));
    for (const definition of prompt.definitions) expect(definition.input_schema).toMatchObject({ type: "object" });
  });

  // The message tools are the only channel from a child to its parent, so no
  // session kind, persona allowlist, or step binding scope removes them.
  const sessionKinds: readonly (readonly [string, KernelToolDeps["purpose"], ReadonlySet<string> | undefined])[] = [["a root chat", { kind: "interactive-chat" }, undefined],
    ["a subagent with a narrow persona allowlist", { kind: "subagent", renderAs: "subagent", parentToolUseId: "tool-1" }, new Set(["read"])],
    ["a workflow step whose binding grants no scoped tool", { kind: "workflow-agent", briefScope: { briefId: "fly.implement" }, workflowAttemptId: "step-1" }, new Set<string>()]];
  it.each(sessionKinds)("materializes both message tools with an object root in %s", async (_name, purpose, selected) => {
    const planned = await plan({ capabilities: ALL_CAPABILITIES, sessions: sessionMessaging, purpose }, [], selected ? { selected } : {});
    const surface = await (await createRequestToolSurface(() => plannedRequest(planned), testCapabilityModules, testRuntimeConfigCapture)).resolve();
    const { definitions } = await surface.prepareStablePrompt(() => stableSystemPrompt("prompt"), DEFAULT_MODEL_INTERACTION_PROFILE);
    for (const name of ["message_session", "list_sessions"]) expect(definitions.find((definition) => definition.name === name)?.input_schema).toMatchObject({ type: "object" });
  });
});
