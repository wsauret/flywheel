import { describe, expect, it } from "bun:test";
import { NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js";

import * as os from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { forkAssignment } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { loadStandalonePersonaRegistry } from "../../../../../src/workflows/agents/registry.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import type { SubagentDispatchDeps } from "../../../../../src/orchestration/modules/subagents/execution/dispatch-deps.js";
import { buildRegistry, grantOf, makeContext, makeDeps, makeMockRunnerFactory, runnerEffort, TEST_RATIONALE, childTask } from "./_fixtures.js";
import { prepareSubagentTools } from "../../../../../src/orchestration/modules/subagents/execution/dispatch-preparation.js";
import type { ContinuationTarget } from "../../../../../src/orchestration/modules/subagents/execution/control-actions.js";
import { canUseCheckpoint } from "../../../../../src/infra/agent-assets/session-notes.js";
import { noSkills } from "../../../../helpers/project-definitions.js";
import { refusingLauncher } from "../../../../helpers/launcher-fake.js";

function registryWithGeneral(): Map<string, AgentDefinition> {
  const registry = new Map(buildRegistry());
  registry.set("general", {
    kind: "general",
    name: "general",
    description: "A clone of the dispatching agent.",
    maxTurns: 100,
  });
  return registry;
}

const PARENT_TOOLS: ReadonlySet<string> = new Set(["read", "search", "bash", "code", "web", "subagent", "process", "handoff", "ask_user", "recall"]);

function generalDeps(overrides?: Partial<SubagentDispatchDeps>): SubagentDispatchDeps {
  return makeDeps({
    agentRegistry: registryWithGeneral(),
    parentEffort: "high",
    parentProviderOptions: { anthropic: { speed: "fast" } },
    parentPromptKind: "chat",
    ...overrides,
  });
}

function tempSessionDir(): string {
  return path.join(os.tmpdir(), `subagent-general-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("subagent tool — general agent dispatch", () => {
  it("inherits the file edit tool under the name the parent's model is served", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const tool = createSubagentDispatch(generalDeps({ sessionDir, createRunner: factory }));

    const result = await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "carry the subtask" }, makeContext({ availableTools: new Set(["read", "apply_patch", "write"]) }));

    expect(result.outcome).toBe("ok");
    expect(calls[0]!.options.toolGrant).toEqual(["read", "apply_patch", "write", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("inherits the parent's model, effort, prompt inputs, and tool set", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const deps = generalDeps({ sessionDir, createRunner: factory });
    const webSearchCapability = { available: () => true, run: async () => ({ results: [] }) };
    const webSearch = () => webSearchCapability;
    const moduleServices = NO_MODULE_SERVICES;
    const launcher = refusingLauncher;
    const parentBackground = deps.backgroundTasks;
    deps.inheritableRuntimeSurfaces = { webSearch, moduleServices, launcher };
    const tool = createSubagentDispatch(deps);
    const ctx = makeContext({ availableTools: PARENT_TOOLS });

    const result = await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "carry the subtask" }, ctx);
    expect(result.outcome).toBe("ok");

    expect(calls.length).toBe(1);
    const opts = calls[0]!.options;
    expect(opts.model).toBe("claude-opus-4.7");
    expect(await runnerEffort(opts)).toBe("high");
    expect(opts.providerOptions).toEqual({ anthropic: { speed: "fast" } });
    expect(opts.purpose.kind).toBe("subagent");
    if (opts.purpose.kind !== "subagent") throw new Error("Expected subagent purpose");
    expect(opts.purpose.renderAs).toBe("chat");
    expect(opts.agentsMd).toBeUndefined();
    expect(opts.maxLLMCalls).toBe(100);
    // A general clone works from its assignment alone: its task carries only
    // the subtask contract.
    expect(childTask(opts)).toStartWith("# Delegated Subtask");
    expect(opts.toolGrant).toEqual(["read", "search", "bash", "code", "web", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
    expect(opts.toolNames).toBeUndefined();
    expect(opts.runtimeSurfaces?.webSearch).toBe(webSearch);
    expect(opts.runtimeSurfaces?.moduleServices).toBe(moduleServices);
    expect(opts.runtimeSurfaces?.launcher).toBe(launcher);
    expect(opts.runtimeSurfaces?.handoff).not.toBeUndefined();
    expect(opts.runtimeSurfaces?.background).not.toBeUndefined();
    expect(opts.runtimeSurfaces?.background?.tasks).not.toBe(parentBackground);
    expect(opts.runtimeSurfaces?.askUser).toBeUndefined();
    expect(opts.runtimeSurfaces?.recall).not.toBeUndefined();
    expect(opts.conversation.kind).toBe("durable-tree");
    if (opts.conversation.kind !== "durable-tree") throw new Error("Expected durable subagent conversation");
    expect(opts.conversation.priorMessages).toEqual([{ kind: "user", content: "carry the subtask" }, { kind: "user", content: childTask(opts), origin: "system" }]);

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("adds the checkpoint tools to a continuation whose recorded tool list has none, and keeps its recorded grants", async () => {
    const deps = generalDeps();
    const continuation: ContinuationTarget = {
      childSessionId: "child", childConversationId: "child-conversation", childRunId: "child-run",
      attempt: { kind: "same_run", expectedSeq: 1 }, task: "recorded task", toolNames: ["read", "bash", "handoff"], personaKind: "general",
      capabilityGrant: grantOf(["subagents"]), admittedModuleIds: [], skillsRevision: 0, maxTurns: 7, maxTokens: 0,
    };
    const prepared = await prepareSubagentTools({ agent: deps.agentRegistry.get("general")!, context: makeContext({ availableTools: PARENT_TOOLS }), deps, childDepth: 1, continuation });
    if (!prepared.ok) throw new Error("the continuation was refused");
    expect(prepared.toolNames).toEqual(["read", "bash", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
    expect(prepared.task).toBe("recorded task");
    expect(prepared.maxTurns).toBe(7);
    // The loop compacts exactly when the checkpoint tools are on the surface.
    expect(canUseCheckpoint(true, new Set(prepared.toolNames))).toBe(true);
    expect(canUseCheckpoint(true, new Set(continuation.toolNames))).toBe(false);
  });

  it("resolves a live parent effort accessor once at dispatch", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const deps = generalDeps({ sessionDir, createRunner: factory, parentEffort: async () => "medium" });
    const tool = createSubagentDispatch(deps);
    const ctx = makeContext({ availableTools: PARENT_TOOLS });

    await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "carry on" }, ctx);
    expect(await runnerEffort(calls[0]?.options)).toBe("medium");

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("fork seeds the child with the parent snapshot plus the framed assignment as the trailing user turn", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const deps = generalDeps({ sessionDir, createRunner: factory });
    const tool = createSubagentDispatch(deps);
    const snapshot: ConversationMessage[] = [
      { kind: "user", content: "original user ask" },
      { kind: "assistant", content: [{ type: "text", text: "parent progress so far" }] },
    ];
    const ctx = makeContext({ availableTools: PARENT_TOOLS, snapshotConversation: async () => snapshot });

    const result = await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "now finish X", fork: true }, ctx);
    expect(result.outcome).toBe("ok");

    const opts = calls[0]!.options;
    expect(opts.model).toBe("claude-opus-4.7");
    expect(opts.conversation.kind).toBe("durable-tree");
    if (opts.conversation.kind !== "durable-tree") throw new Error("Expected durable subagent conversation");
    // In-band disclosure at the fork seam, following the compaction convention.
    expect(opts.conversation.priorMessages).toEqual([...snapshot, { kind: "user", content: forkAssignment("now finish X") }, { kind: "user", content: childTask(opts), origin: "system" }]);
    expect(forkAssignment("now finish X")).toContain("copy of your parent agent's conversation");
    expect(forkAssignment("now finish X")).toEndWith("now finish X");

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("fork without a wired conversation snapshot returns a tool error", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const deps = generalDeps({ sessionDir, createRunner: factory });
    const tool = createSubagentDispatch(deps);
    const ctx = makeContext({ availableTools: PARENT_TOOLS });

    const result = await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "finish X", fork: true }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("fork");
    expect(calls).toHaveLength(0);

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("general without parent tool exposure returns a tool error", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const deps = generalDeps({ sessionDir, createRunner: factory });
    const tool = createSubagentDispatch(deps);
    const ctx = makeContext();

    const result = await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "carry on" }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("registry-approved tool surface");
    expect(calls).toHaveLength(0);

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("fork seeds a persona child with the parent snapshot while keeping its own prompt and tools", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const webSearchCapability = { available: () => true, run: async () => ({ results: [] }) };
    const webSearch = () => webSearchCapability;
    const moduleServices = NO_MODULE_SERVICES;
    const deps = generalDeps({ sessionDir, createRunner: factory, inheritableRuntimeSurfaces: { webSearch, moduleServices } });
    const tool = createSubagentDispatch(deps);
    const snapshot: ConversationMessage[] = [
      { kind: "user", content: "original user ask" },
      { kind: "assistant", content: [{ type: "text", text: "plan developed so far" }] },
    ];
    const ctx = makeContext({ snapshotConversation: async () => snapshot });

    const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "review the plan", fork: true }, ctx);
    expect(result.outcome).toBe("ok");

    const opts = calls[0]!.options;
    expect(opts.conversation.kind).toBe("durable-tree");
    if (opts.conversation.kind !== "durable-tree") throw new Error("Expected durable subagent conversation");
    expect(opts.conversation.priorMessages.slice(0, -1)).toEqual([...snapshot, { kind: "user", content: forkAssignment("review the plan") }]);
    // Persona identity is unchanged by the fork: its own task after the assignment, its tools, and its role model.
    expect(childTask(opts)).toContain("focused codebase investigator");
    expect(opts.toolGrant).toEqual(["read", "search", "list", "bash", "code", "web", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.runtimeSurfaces?.webSearch).toBe(webSearch);
    expect(opts.runtimeSurfaces?.moduleServices).toBe(moduleServices);
    expect(opts.runtimeSurfaces?.askUser).toBeUndefined();
    expect(opts.runtimeSurfaces?.recall).not.toBeUndefined();

    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("does not invent web or module service authority for a child", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const tool = createSubagentDispatch(generalDeps({ sessionDir, createRunner: factory, inheritableRuntimeSurfaces: {} }));

    await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "carry on" }, makeContext({ availableTools: PARENT_TOOLS }));

    expect(calls[0]?.options.runtimeSurfaces?.webSearch).toBeUndefined();
    expect(calls[0]?.options.runtimeSurfaces?.moduleServices).toBeUndefined();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("ignores valid and malformed tiers on the general agent with or without fork", async () => {
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const sessionDir = tempSessionDir();
    const tool = createSubagentDispatch(generalDeps({ sessionDir, createRunner: factory }));
    const context = makeContext({
      availableTools: PARENT_TOOLS,
      snapshotConversation: async () => [],
    });

    for (const fork of [false, true]) {
      for (const tier of ["cheap", "ultra", 42]) {
        const result = await tool.execute({ persona: "general", rationale: TEST_RATIONALE, prompt: "go", tier, fork }, context);

        expect(result.outcome).toBe("ok");
      }
    }

    expect(calls).toHaveLength(6);
    expect(calls.every(({ options }) => options.model === "claude-opus-4.7")).toBe(true);
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("loadStandalonePersonaRegistry always registers the built-in general agent", async () => {
    const registry = await loadStandalonePersonaRegistry(path.join(os.tmpdir(), "flywheel-nonexistent-personas"), noSkills);
    const general = registry.get("general");
    expect(general?.kind).toBe("general");
    expect(general?.description).toContain("clone of the dispatching agent");
  });
});
