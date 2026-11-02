import { describe, expect, test } from "bun:test"
import { disposeHeadlessBootstrapResources } from "../../../../src/orchestration/headless/headless-bootstrap.js"

describe("headless bootstrap", () => {
    test("uses ordered exhaustive outer disposal", async () => {
      const stages: string[] = []

      await expect(disposeHeadlessBootstrapResources({
        settleRunOwned: async () => { stages.push("run-owned"); throw new Error("task settlement failed") },
        disposeModuleServices: async () => { stages.push("module-services") },
        closeConfig: async () => { stages.push("config") },
        closeSubscriptionUsage: async () => { stages.push("subscription-usage") },
        closeRuntime: async () => { stages.push("runtime") },
        releaseGeneration: () => { stages.push("generation") },
        disposeProviderAvailability: async () => { stages.push("provider") },
      })).rejects.toThrow("task settlement failed")

      expect(stages).toEqual(["run-owned", "module-services", "config", "subscription-usage", "runtime", "generation", "provider"])
    })
})
