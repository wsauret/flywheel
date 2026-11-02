import { describe, expect, test } from "bun:test";
import { createRuntimeModuleComposer } from "../../../../src/orchestration/app-service/runtime-module-composition.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js";
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { testKernelToolDeps } from "../../../helpers/request-tool-surface.js";

describe("headless tool exclusions", () => {
  test.each([
    ["skill", "skills", "web"],
    ["web", "web", "skills"],
  ] as const)("removes the %s tool and its associated prompt roster", (toolName, promptRosterId, unrelatedPromptRosterId) => {
    const filtered = createRuntimeModuleComposer([toolName])({ moduleIds: composeFirstPartyModules().enabledModuleIds });
    const contributionIds = (domain: "tools" | "promptRosters" | "providers") => filtered.contributions.filter((item) => item.domain === domain).map((item) => item.id);

    expect(contributionIds("tools")).not.toContain(toolName);
    expect(contributionIds("promptRosters")).not.toContain(promptRosterId);
    expect(contributionIds("promptRosters")).toContain(unrelatedPromptRosterId);
    expect(contributionIds("tools")).toContain("read");
    expect(filtered.enabledModuleIds).toEqual(expect.arrayContaining(["skills", "web", "provider-chatgpt", "provider-github-copilot", "provider-openai-api"]));
    expect(contributionIds("providers")).toEqual(expect.arrayContaining(["chatgpt", "github_copilot", "openai_api"]));
  });

  test("rejects an unknown active tool name", () => {
    expect(() => createRuntimeModuleComposer(["unknown"])({ moduleIds: composeFirstPartyModules().enabledModuleIds })).toThrow("Unknown active first-party tool: unknown");
  });

  test("memoizes filtered composition identity across equivalent selections", () => {
    const compose = createRuntimeModuleComposer(["subagent"]);
    const state = { moduleIds: composeFirstPartyModules().enabledModuleIds };
    for (const selection of [compose(state), compose({ ...state })]) {
      expect(selection.contributions.filter(({ domain }) => domain === "tools").map(({ id }) => id)).not.toContain("subagent");
      expect(selection.enabledModuleIds).toContain("subagents");
    }
    expect(compose(state)).toBe(compose({ ...state }));
    expect(createRuntimeModuleComposer()(state).contributions.some((entry) => entry.domain === "tools" && entry.value.name === "subagent")).toBe(true);
    expect(() => createRuntimeModuleComposer(["unknown"])(state)).toThrow("Unknown active first-party tool: unknown");
  });

  test("renders the subagent roster only when the selected tools include subagent", async () => {
    const state = { moduleIds: composeFirstPartyModules().enabledModuleIds };
    for (const disabledTools of [[], ["subagent"]]) {
      const composition = createRuntimeModuleComposer(disabledTools)(state);
      const fragment = composition.contributions.find((entry) => entry.domain === "promptFragments" && entry.id === "subagent-roster");
      if (fragment?.domain !== "promptFragments") throw new Error("Missing subagent roster fragment");
      const tools = new Map<string, RuntimeTool>(composition.contributions.flatMap((entry) => entry.domain === "tools" ? [[entry.value.name, {
        name: entry.value.name, action: entry.value.declaration.action, description: "", inputSchema: { type: "object" },
        isConcurrencySafe: true, execute: async () => { throw new Error("Rendering must not execute tools"); },
      }]] : []));
      const rendered = await fragment.value.render({
        kernel: testKernelToolDeps({ moduleSnapshot: composition }), modules: NO_MODULE_RUNTIMES, tools, memorySnapshot: null,
      });
      if (disabledTools.length === 0) expect(rendered).toContain("# Subagents");
      else expect(rendered).toBeUndefined();
    }
  });

  test("keeps exclusions across module disablement and re-enablement in one composer", () => {
    const compose = createRuntimeModuleComposer(["subagent"]);
    const state = { moduleIds: composeFirstPartyModules().enabledModuleIds };
    const initial = compose(state);
    const disabled = compose({ moduleIds: state.moduleIds.filter((id) => id !== "subagents") });
    expect(disabled.enabledModuleIds).not.toContain("subagents");
    expect(disabled.contributions.some((entry) => entry.domain === "tools" && entry.value.name === "subagent")).toBe(false);
    const enabled = compose(state);
    expect(enabled).toBe(initial);
    expect(enabled.enabledModuleIds).toContain("subagents");
    expect(enabled.contributions.some((entry) => entry.domain === "tools" && entry.value.name === "subagent")).toBe(false);
  });
});
