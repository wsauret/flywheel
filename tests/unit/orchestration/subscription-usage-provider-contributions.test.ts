import { describe, expect, test } from "bun:test";
import { composeFirstPartyModules } from "../../../src/orchestration/modules.js";

import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";


describe("subscription usage provider contributions", () => {
  test("the enabled provider registry exposes every proven provider-owned reader", () => {
    const registry = accessProviderRegistry(composeFirstPartyModules());

    expect([...registry.usageReaders.keys()].toSorted()).toEqual(["chatgpt", "claude_agent_sdk", "deepseek", "github_copilot", "opencode_go", "supergrok"]);
    expect([...registry.resetConsumers.keys()]).toEqual(["chatgpt"]);
    expect(registry.resetConsumers.has("supergrok")).toBe(false);
  });

  test("disabled provider modules contribute no usage reader", () => {
    const registry = accessProviderRegistry(composeFirstPartyModules(undefined, ["provider-github-copilot"]));

    expect(registry.usageReaders.has("github_copilot")).toBe(false);
  });

});
