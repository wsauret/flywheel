import { describe, expect, test } from "bun:test"
import { SHIPPED_MODULES, composeFirstPartyModules } from "../../../src/orchestration/modules.js"

import { accessProviderRegistry } from "../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
describe("first-party capability module composition", () => {
  test("all-provider-off remains legal and disabling one removes only that provider", () => {
    const providerModuleIds = SHIPPED_MODULES.filter((module) => module.id.startsWith("provider-")).map((module) => module.id)
    const none = composeFirstPartyModules(SHIPPED_MODULES, providerModuleIds)
    expect(none.warnings).toContain("No providers contributions are enabled")
    expect(accessProviderRegistry(none).selection.definitions).toEqual([])

    const withoutChatGpt = accessProviderRegistry(composeFirstPartyModules(SHIPPED_MODULES, ["provider-chatgpt"]))
    expect(withoutChatGpt.selection.definitions.map((definition) => definition.id)).not.toContain("chatgpt")
    expect(withoutChatGpt.selection.definitions).toHaveLength(10)
  })

})
