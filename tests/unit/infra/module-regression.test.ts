import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AccessProviderId } from "../../../src/infra/llm/access-provider.js";
import { composeFirstPartyModules, SHIPPED_MODULES } from "../../../src/orchestration/modules.js";
import { MODULE_IDS } from "../../../src/protocol/module-ids.js";
import { createObserverChain } from "../../../src/orchestration/agent-runtime/batch-observers.js";
import { generateCapabilityModuleBaseline } from "./module-baseline-generator.js";

import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js";
const fixturePath = resolve(import.meta.dir, "../../fixtures/modules/baseline.json");
const providerIds = accessProviderRegistry(composeFirstPartyModules()).selection.definitions.map((definition) => definition.id);

function providerTripwire(provider: AccessProviderId): boolean {
  switch (provider) {
    case "anthropic_api":
    case "chatgpt":
    case "claude_agent_sdk":
    case "deepseek":
    case "github_copilot":
    case "google_api":
    case "google_vertex":
    case "openai_api":
    case "opencode_go":
    case "openrouter":
    case "supergrok":
      return true;
    default:
      return false;
  }
}

describe("capability module regression baseline", () => {
  test("matches the committed current-production manifest", async () => {
    // Module commands appear only when the runtime catalog supplies them. The
    // byte comparison also holds every unrelated registration and prompt stable.
    expect(await generateCapabilityModuleBaseline()).toBe(await readFile(fixturePath, "utf8"));
  });

  test("derives identical default ids from reordered catalogs and recruits every default provider", () => {
    const canonicalOutput = composeFirstPartyModules(SHIPPED_MODULES).enabledModuleIds;
    const reorderedOutput = composeFirstPartyModules(SHIPPED_MODULES.toReversed()).enabledModuleIds;
    // The vocabulary also names the development module, which only the source entry installs.
    expect(canonicalOutput).toEqual(MODULE_IDS.filter((id) => id !== "development"));
    expect(reorderedOutput).toEqual(canonicalOutput);
    expect(providerIds.map(providerTripwire)).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
  });

  test("characterizes the production workflow observer chain", async () => {
    const context = { getBudgetInfo: async () => ({ remainingCalls: 4, remainingTokens: 9_999 }), getContextPercent: async () => 61 };
    const chain = createObserverChain(composeFirstPartyModules().observers.flatMap((declaration) =>
      declaration.seam === "workflow" ? [declaration.observer(context)] : []));
    const budget = expect.stringContaining("Workflow budget running low: 4 attempts and 9999 tokens remain. This agent can finish, but no attempt starts after the budget runs out. Prioritize completing your brief efficiently.");
    const pressure = expect.stringContaining("Context is filling up. Be concise in your responses and tool usage to preserve context space.");
    expect(await chain.onBatchSettled()).toEqual([budget, pressure]);
    expect(await chain.onBatchSettled()).toEqual([]);
    chain.reset();
    expect(await chain.onBatchSettled()).toEqual([budget, pressure]);
  });
});
