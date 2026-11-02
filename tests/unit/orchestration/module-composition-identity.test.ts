import { describe, expect, test } from "bun:test"
import { installCustomProviders } from "../../../src/infra/llm/custom-provider-registry.js"
import { toolRegistryFromComposition } from "../../../src/orchestration/agent-runtime/tools/tool-registry.js"
import { SHIPPED_MODULES, composeFirstPartyModules, composeRealmModuleSnapshot } from "../../../src/orchestration/modules.js"
import { installedModules } from "../../../src/orchestration/module-catalog.js"
import { createToolRegistry } from "../../../src/orchestration/tool-catalog.js"
import { EMPTY_MODULE_IDS, MODULE_IDS } from "../../../src/protocol/module-ids.js"

const everyShipped = SHIPPED_MODULES.map((module) => module.id)

describe("module composition identity", () => {
  test("equal inputs return one frozen value", () => {
    const composition = composeFirstPartyModules(SHIPPED_MODULES)
    expect(composeFirstPartyModules(SHIPPED_MODULES)).toBe(composition)
    expect(composeFirstPartyModules(SHIPPED_MODULES, EMPTY_MODULE_IDS)).toBe(composition)
    expect(composeRealmModuleSnapshot({ moduleIds: everyShipped }, SHIPPED_MODULES)).toBe(composition)
    expect(Object.isFrozen(composition)).toBe(true)
    expect(Object.isFrozen(composition.contributions)).toBe(true)
    expect(Object.isFrozen(composition.warnings)).toBe(true)
  })

  test("the disabled set is a set: order and repeats do not split the value", () => {
    const one = composeFirstPartyModules(SHIPPED_MODULES, ["workflows", "skills"])
    expect(composeFirstPartyModules(SHIPPED_MODULES, ["skills", "workflows", "skills"])).toBe(one)
    expect(composeRealmModuleSnapshot({ moduleIds: everyShipped.filter((id) => id !== "workflows" && id !== "skills") }, SHIPPED_MODULES)).toBe(one)
    expect(one).not.toBe(composeFirstPartyModules(SHIPPED_MODULES))
  })

  test("a custom-provider generation change yields a new value that carries the new provider", () => {
    const before = composeFirstPartyModules(SHIPPED_MODULES)
    try {
      installCustomProviders([{ id: "local_llama", displayName: "Local Llama", baseUrl: "http://localhost:8080/v1", modelIds: new Set(["llama-3.3-70b"]), catalogId: undefined, contextLimit: 128_000 }])
      const after = composeFirstPartyModules(SHIPPED_MODULES)
      expect(after).not.toBe(before)
      expect(after.enabledModuleIds).toContain("provider-custom-local_llama")
      expect(composeFirstPartyModules(SHIPPED_MODULES)).toBe(after)
    } finally {
      installCustomProviders([])
    }
    expect(composeFirstPartyModules(SHIPPED_MODULES)).not.toBe(before)
    expect(composeFirstPartyModules(SHIPPED_MODULES)).toEqual(before)
  })

  test("the tool registry is one value per composition and per catalog", () => {
    const composition = composeFirstPartyModules(SHIPPED_MODULES)
    expect(toolRegistryFromComposition(composition)).toBe(toolRegistryFromComposition(composition))
    expect(toolRegistryFromComposition(composeFirstPartyModules(SHIPPED_MODULES, ["bash"]))).not.toBe(toolRegistryFromComposition(composition))
    const complete = createToolRegistry(SHIPPED_MODULES)
    expect(createToolRegistry(SHIPPED_MODULES)).toBe(complete)
    expect([...complete.keys()]).toEqual([...toolRegistryFromComposition(composition).keys()])
  })

  test("captures an immutable realm snapshot from one policy state", () => {
    const snapshot = composeRealmModuleSnapshot({ moduleIds: MODULE_IDS })
    // Stated against the policy it was given rather than a copied list: a
    // module added to the registry must not need this case rewritten. A wire
    // id whose module the release entry does not install (development) is
    // not enabled by naming it.
    const installed = new Set(installedModules().map((module) => module.id))
    expect(snapshot.enabledModuleIds).toEqual(MODULE_IDS.filter((id) => installed.has(id)))
    expect(Object.isFrozen(snapshot.enabledModuleIds)).toBe(true)
  })
})
