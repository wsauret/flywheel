import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { renderSubagentRoster } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { scopedAgentRegistry } from "../../../../../src/orchestration/modules/subagents/execution/dispatch-configuration.js";
import type { SubagentDispatchDeps } from "../../../../../src/orchestration/modules/subagents/execution/dispatch-deps.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createChildSlotRegistry } from "../../../../../src/orchestration/agent-runtime/child-slot-registry.js";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import type { AgentRunResult, Agent, AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js";
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js";
import { fixedAvailability } from "../../../../helpers/project-definitions.js";
import { grantOf, makeCapabilityAccess, makeDeps } from "./_fixtures.js";

function agent(name: string, tools: readonly string[], role = name): AgentDefinition {
  return {
    kind: "persona",
    name,
    description: `${name} agent`,
    systemPrompt: `${name} prompt`,
    tools,
    role,
    maxTurns: 10,
  };
}

function context() {
  return {
    executionCwd: os.tmpdir(),
    projectRoot: os.tmpdir(),
    availableTools: new Set(["read", "search", "list", "bash", "subagent"]),
    // Scope is the subject here, so the dispatch carries the boundary a
    // production dispatch is admitted on.
    capabilityAccess: makeCapabilityAccess({ grant: grantOf(["subagents"]) }),
    toolUseId: "scope-test-tool-use",
    conversationId: "scope-test-conversation",
    artifactScopeId: "scope-test",
  };
}

function deps(calls: AgentOptions[], allowedSubagentTypes?: ReadonlySet<string>): SubagentDispatchDeps {
  const registry = new Map<string, AgentDefinition>([
    ["explorer", agent("explorer", ["read", "search", "list", "bash"])],
    ["implementer", agent("implementer", ["read", "search", "list", "bash", "edit", "write"])],
  ]);

  return makeDeps({
    agentRegistry: registry,
    capabilityRequirements: ["subagents"],
    ...(allowedSubagentTypes ? { allowedSubagentTypes } : {}),
    modelFamily: "anthropic",
    parentModel: "claude-opus-4-7",
    resolveRoles: async () => new Map([
      ["explorer", { roleId: "explorer", model: "claude-sonnet-4-6", effort: "medium" }],
      ["implementer", { roleId: "implementer", model: "claude-opus-4-6", effort: "high" }],
    ]),
    onRenderEvent: () => {},
    backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }),
    childSlots: createChildSlotRegistry(),
    sessionDir: path.join(os.tmpdir(), `subagent-scope-${Date.now()}`),
    inheritableRuntimeSurfaces: {},
    createRunner: (options: AgentOptions): Agent => {
      calls.push(options);
      const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
      return {
        send() { resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "mock", terminal: { kind: "completed" } }); },
        end() {},
        abort() {},
        done: promise,
      };
    },
  });
}

describe("subagent scope enforcement", () => {
  test("admits a granted implementer from a parent that lacks mutation tools, with the implementer's own tools", async () => {
    const calls: AgentOptions[] = [];
    const tool = createSubagentDispatch(deps(calls));

    const result = await tool.execute({ persona: "implementer", rationale: "test fixture: grants alone decide which children a read-only parent dispatches", prompt: "create a file" }, context());

    expect(result.outcome).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolGrant).toEqual(expect.arrayContaining(["edit", "write"]));
  });

  test("allows read-only subagents when parent step lacks mutation tools", async () => {
    const calls: AgentOptions[] = [];
    const tool = createSubagentDispatch(deps(calls));

    const result = await tool.execute({ persona: "explorer", rationale: "test fixture: validating read-only path under restricted parent", prompt: "find config" }, context());

    expect(result.outcome).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolGrant).toEqual(["read", "search", "list", "bash", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);
  });

  test("hides subagents not declared for the active step", async () => {
    const calls: AgentOptions[] = [];
    const tool = createSubagentDispatch(deps(calls, new Set(["explorer"])));
    const mutationContext = {
      ...context(),
      availableTools: new Set(["read", "search", "list", "bash", "write", "edit", "subagent"]),
    };

    const roster = renderSubagentRoster(scopedAgentRegistry(deps(calls).agentRegistry, new Set(["explorer"])), () => true);
    expect(roster).toContain("explorer");
    expect(roster).not.toContain("implementer");

    const result = await tool.execute({ persona: "implementer", rationale: "test fixture: validating that hidden subagent types are rejected", prompt: "create a file" }, mutationContext);

    expect(result.outcome).toBe("error");
    expect(result.content).toContain("No subagent registered as 'implementer'");
    expect(result.content).toContain("explorer");
    expect(calls).toHaveLength(0);
  });

  test("lists only the names the caller can dispatch when it names none of them", async () => {
    const calls: AgentOptions[] = [];
    const agentRegistry = new Map<string, AgentDefinition>([
      ["explorer", agent("explorer", ["read"])],
      ["advisor", agent("advisor", ["read"])],
      ["reviewer-code-quality", agent("reviewer-code-quality", ["read"], "reviewer-quality")],
    ]);
    const dispatchWith = (disabledTypes: readonly string[]) => createSubagentDispatch({
      ...deps(calls),
      agentRegistry,
      definitionAvailability: fixedAvailability({ personas: agentRegistry }, composeFirstPartyModules().enabledModuleIds, disabledTypes),
    });
    const input = { persona: "planner", rationale: "test fixture: an unknown name is refused with the dispatchable names", prompt: "plan" };

    expect((await dispatchWith([]).execute(input, context())).content).toContain("Available persona values: explorer, advisor, reviewer-code-quality.");
    const refused = await dispatchWith(["advisor", "reviewer"]).execute(input, context());
    expect(refused.content).toContain("Available persona values: explorer.");
    expect(refused.content).not.toContain("advisor");
    expect(refused.content).not.toContain("reviewer");
    expect(calls).toHaveLength(0);
  });
});
