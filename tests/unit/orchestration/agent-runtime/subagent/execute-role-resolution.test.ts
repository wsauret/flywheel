import { describe, expect, it } from "bun:test";

import * as os from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { Schema } from "effect";
import { RoleSettingsSchema } from "../../../../../src/infra/role-settings.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import { buildRegistry, makeContext, makeDeps, makeMockRunnerFactory, runnerEffort, TEST_RATIONALE } from "./_fixtures.js";

function selectedModelLabels(events: readonly RuntimeEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== "agent.subagent_model.selected") return [];
    const model = event.data["model"];
    return typeof model === "string" ? [model] : [];
  });
}

describe("subagent tool — execute role resolution", () => {
    it.each([
      { model: "claude-sonnet-4-6", effort: "medium" },
      { model: "claude-sonnet-4-6" },
    ])("publishes a session-scoped persona setting without provider options: %j", async (setting) => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const deps = makeDeps({
        resolveRoles: async () => new Map([
          ["explorer", {
            roleId: "explorer", model: "claude-sonnet-4-6", effort: "medium",
            setting: { ...setting, fixedEffort: "medium" }, settingScope: "session",
          }],
        ]),
        createRunner: factory,
      });
      const publish = deps.subagentSessions.publish;
      let published = false;
      deps.subagentSessions.publish = async (input) => {
        const roles = Schema.decodeUnknownSync(RoleSettingsSchema, { onExcessProperty: "error" })(input.initialRoles);
        expect(roles).toEqual({ explorer: setting });
        const child = await publish(input);
        published = true;
        return child;
      };

      const result = await createSubagentDispatch(deps).execute(
        { persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext(),
      );

      expect(result.outcome).toBe("ok");
      expect(published).toBe(true);
      expect(calls).toHaveLength(1);
    });

    it("resolves persona roles at dispatch time", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const roles = new Map([
        ["explorer", { roleId: "explorer", model: "claude-sonnet-4-6", effort: "medium" }],
      ]);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => roles,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext());
      expect(calls[0]?.options.model).toBe("claude-sonnet-4-6");

      roles.set("explorer", { roleId: "explorer", model: "claude-haiku-4-5", effort: "low" });
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find newer stuff" }, makeContext());

      expect(calls[1]?.options.model).toBe("claude-haiku-4-5");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("inherits the live parent reviewer assignment", async () => {
      const emitted: RuntimeEvent[] = [];
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const agentRegistry = buildRegistry();
      agentRegistry.set("reviewer-code-data-integrity", {
        kind: "persona",
        name: "reviewer-code-data-integrity",
        description: "Reviews durable data behavior.",
        role: "reviewer-data-integrity",
        tools: ["read", "search", "list"],
        maxTurns: 50,
        systemPrompt: "Review durable data behavior.",
      });
      const roles = new Map([
        ["reviewer", { roleId: "reviewer", model: "gpt-6.1-sol", effort: "low" }],
      ]);
      const deps = makeDeps({
        agentRegistry,
        sessionDir,
        resolveRoles: async () => roles,
        onRenderEvent: (event) => emitted.push(event),
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "reviewer-code-data-integrity", rationale: TEST_RATIONALE, prompt: "review it" }, makeContext({ toolUseId: "review-one" }));
      roles.set("reviewer", { roleId: "reviewer", model: "gpt-6-astra", effort: "high" });
      await tool.execute({ persona: "reviewer-code-data-integrity", rationale: TEST_RATIONALE, prompt: "review it again" }, makeContext({ toolUseId: "review-two" }));

      expect(await Promise.all(calls.map(async ({ options }) => [options.model, await runnerEffort(options)]))).toEqual([
        ["gpt-6.1-sol", "low"],
        ["gpt-6-astra", "high"],
      ]);
      expect(selectedModelLabels(emitted)).toEqual([
        "gpt-6.1-sol low",
        "gpt-6-astra high",
      ]);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("starts request admission when no persona role can currently resolve", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => new Map(),
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext());

      expect(result.outcome).toBe("ok");
      expect(calls.length).toBe(1);
      expect(calls[0]?.options.model).toBeUndefined();
      expect(await calls[0]?.options.requestSelection?.(new Map())).toEqual({ roleId: "explorer" });

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("step-scoped agent role wins over global persona role", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const roles = new Map([
        ["explorer", { roleId: "explorer", model: "claude-sonnet-4-6", effort: "medium" }],
        ["brief.plan-review.persona.explorer", { roleId: "brief.plan-review.persona.explorer", model: "claude-opus-4-6", effort: "high" }],
      ]);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => roles,
        briefScope: { briefId: "plan-review" },
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext());

      expect(calls[0]?.options.model).toBe("claude-opus-4-6");
      expect(await runnerEffort(calls[0]?.options)).toBe("high");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("qualified skill slot ignores a runtime attempt role", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const roles = new Map([
        ["explorer", { roleId: "explorer", model: "claude-haiku-4-5", effort: "low" }],
        ["brief.plan-review.persona.explorer", { roleId: "brief.plan-review.persona.explorer", model: "claude-sonnet-4-6", effort: "medium" }],
        ["brief.runtime-plan-review.persona.explorer", { roleId: "brief.runtime-plan-review.persona.explorer", model: "claude-opus-4-6", effort: "high" }],
      ]);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => roles,
        briefScope: { briefId: "plan-review" },
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext());

      expect(calls[0]?.options.model).toBe("claude-sonnet-4-6");
      expect(await runnerEffort(calls[0]?.options)).toBe("medium");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("global role fallback used when no step-scoped assignment exists", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const roles = new Map([
        ["explorer", { roleId: "explorer", model: "claude-sonnet-4-6", effort: "medium" }],
      ]);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => roles,
        briefScope: { briefId: "code-review" },
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext());

      expect(calls[0]?.options.model).toBe("claude-sonnet-4-6");
      expect(await runnerEffort(calls[0]?.options)).toBe("medium");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("emitted subagent_model block reflects exact model/effort from step-scoped resolution", async () => {
      const emitted: RuntimeEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const roles = new Map([
        ["explorer", { roleId: "explorer", model: "claude-haiku-4-5", effort: "low" }],
        ["brief.plan-review.persona.explorer", { roleId: "brief.plan-review.persona.explorer", model: "claude-opus-4-6", effort: "xhigh" }],
      ]);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => roles,
        briefScope: { briefId: "plan-review" },
        onRenderEvent: (event) => emitted.push(event),
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff", description: "Find" }, makeContext({ toolUseId: "tc_model_emit" }));

      const modelEvent = emitted.find(e => e.type === "agent.subagent_model.selected");
      expect(modelEvent).toBeDefined();
      expect(modelEvent!.data.model).toBe("claude-opus-4-6 xhigh");
      expect(deps.backgroundTasks.activeBackgroundCommands()).toEqual([expect.objectContaining({
        description: "Find",
        model: "claude-opus-4-6",
        effort: "xhigh",
      })]);

      rmSync(sessionDir, { recursive: true, force: true });
    });

});
