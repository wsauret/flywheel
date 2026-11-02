/** How a refusal that a request proved reaches the profile's eligibility: saved, republished at a new revision
 *  after any owned discovery, then handed to the host. */
import { describe, expect, test } from "bun:test"
import { captureProviderConnection } from "../../../../src/infra/auth/auth-context.js"
import { authDir } from "../../../../src/infra/paths.js"
import { createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { testDirectories } from "../../../helpers/directories.js"

const DIRECTORIES = testDirectories(process.cwd())
const PROFILE = { id: "work", directory: authDir(DIRECTORIES.userDataRoot, "work") }

describe("eligibility preparation after a refusal", () => {
  test("republishes saved evidence after the owned discovery, with unchanged inputs, at a new revision", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const modes: string[] = []
    const held = Promise.withResolvers<void>()
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot, resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]), prepare: service.prepare, publish: service.publish, current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(),
      resolveCatalog: async ({ discoveryMode }) => {
        modes.push(discoveryMode ?? "cached-first")
        if (discoveryMode === "refresh") await held.promise
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    const first = await prepare(PROFILE)
    for (let turn = 0; turn < 50 && modes.length < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    const republished = prepare.republish(PROFILE)
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    expect(modes).toEqual(["cached-first", "refresh"])
    held.resolve()
    await republished
    expect(modes).toEqual(["cached-first", "refresh", "cached-first"])
    expect(service.state(PROFILE.id)!.revision).toBeGreaterThan(first.revision)
    await prepare.dispose()
    await expect(prepare.republish(PROFILE)).rejects.toThrow("disposed")
    await service.dispose()
  })

  test.each([true, false])("a refusal that a request proved republishes the profile and then applies it only when it was saved (saved=%p)", async (saved) => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const order: string[] = []
    const applied = Promise.withResolvers<string>()
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot, resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]), prepare: service.prepare, publish: (state) => { order.push("publish"); service.publish(state) }, current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(),
      resolveCatalog: async () => ({ providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }),
      saveModelRefusal: async () => { order.push("save"); return saved },
      apply: async (profileId) => { order.push("apply"); applied.resolve(profileId) },
    })
    await prepare(PROFILE, { mode: "refresh" })
    order.length = 0
    const connection = captureProviderConnection({ profileId: PROFILE.id, authDir: PROFILE.directory, auth: testAuthContext() })
    const candidate = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" } as const
    prepare.recordModelRefusal({ connection, candidate, wireModelId: "claude-sonnet-4-6", refusal: { kind: "model" } })
    if (saved) expect(await applied.promise).toBe(PROFILE.id)
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(saved ? ["save", "publish", "apply"] : ["save"])
    await prepare.dispose()
    await service.dispose()
  })
})
