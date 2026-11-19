import { describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { QuotaCoordinationError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import type { ProviderAvailabilityOwner } from "../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js"
import { disposeSharedProviderAvailability, getSharedProviderAvailability } from "../../../../src/orchestration/agent-runtime/llm/shared-provider-availability.js"
import * as moduleServiceHost from "../../../../src/orchestration/app-service/module-service-host.js"
import * as runtimeConfigOwner from "../../../../src/orchestration/config/runtime-config-owner.js"
import { runHeadlessBootstrap } from "../../../../src/orchestration/headless/headless-bootstrap.js"
import * as headlessProfileRuntime from "../../../../src/orchestration/headless/headless-profile-runtime.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { generationHolders } from "./_headless-run-fixtures.js"

const directory = temporaryDirectories()
const launcher = { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) }

describe("headless bootstrap", () => {
  test("a failed run settlement still disposes in order: module services and config before the store, then the generation and provider availability", async () => {
    const directories = testDirectories(directory("headless-bootstrap-"))
    const dbFile = resolveEventStoreDbFile(directories.projectRoot)
    const stages: string[] = []
    const recordDispose = <Owner extends { dispose(): Promise<void> | void }>(owner: Owner, stage: string): Owner => {
      const dispose = owner.dispose.bind(owner)
      owner.dispose = async () => {
        stages.push(stage)
        await dispose()
      }
      return owner
    }
    const createConfig = runtimeConfigOwner.createRuntimeConfigOwner
    const composeServices = moduleServiceHost.composePortableModuleServices
    const createAdmission = headlessProfileRuntime.createHeadlessSubscriptionAdmission
    const spies = [
      spyOn(runtimeConfigOwner, "createRuntimeConfigOwner").mockImplementation(async (...args) => recordDispose(await createConfig(...args), "config")),
      spyOn(moduleServiceHost, "composePortableModuleServices").mockImplementation((...args) => recordDispose(composeServices(...args), "module-services")),
      spyOn(headlessProfileRuntime, "createHeadlessSubscriptionAdmission").mockImplementation((...args) => recordDispose(createAdmission(...args), "subscription-usage")),
    ]
    const close = Database.prototype.close
    const closing = spyOn(Database.prototype, "close").mockImplementation(function (this: Database) {
      if (this.filename === dbFile) stages.push("runtime")
      close.call(this)
    })
    let acquired: ProviderAvailabilityOwner | undefined
    try {
      // An earlier file in this process can leave the unowned fallback owner,
      // which the bootstrap's idempotent acquisition would then adopt.
      await disposeSharedProviderAvailability()
      await expect(runHeadlessBootstrap({ directories, launcher }, async () => {
        acquired = getSharedProviderAvailability()
        return { result: undefined, settle: async () => { stages.push("run-owned"); throw new Error("task settlement failed") } }
      })).rejects.toThrow("task settlement failed")

      // Startup opens and closes the store too; the disposal order starts at the settlement.
      expect(stages.slice(stages.indexOf("run-owned"))).toEqual(["run-owned", "module-services", "config", "subscription-usage", "runtime"])
      expect(generationHolders(directories.projectRoot)).toEqual([])
      if (!acquired) throw new Error("the run did not see provider availability")
      const disposed = acquired
      expect(() => disposed.forCandidates("default", [{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }]).refreshProjection()).toThrow(QuotaCoordinationError)
    } finally {
      closing.mockRestore()
      for (const spy of spies) spy.mockRestore()
      await disposeSharedProviderAvailability()
    }
  })
})
