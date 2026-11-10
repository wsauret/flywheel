import { describe, expect, test } from "bun:test"
import { authDir } from "../../../../src/infra/paths.js"
import { createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testDirectories } from "../../../helpers/directories.js"
import { testAuthContext } from "../../../helpers/auth-context.js"

const DIRECTORIES = testDirectories(process.cwd())
const PROFILE = { id: "work", directory: authDir(DIRECTORIES.userDataRoot, "work") }

describe("background discovery", () => {
  test("background discovery runs one interval after a profile's latest discovery, never before its first one, only while the profile is held open, and stops on disposal (PI-MODEL-046)", async () => {
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    service.publish(service.prepare({
      profileId: PROFILE.id, authRevision: "auth-v1", preferenceRevision: "preferences-v1",
      catalogs: new Map(), accountCatalogs: new Map(), inventoryCandidates: new Map(), releaseDates: new Map(),
    }))
    let now = 0
    let held = true
    const calls: number[] = []
    let ran = Promise.withResolvers<void>()
    const prepare = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: DIRECTORIES.userDataRoot, resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]), prepare: service.prepare, publish: service.publish, current: service.state,
      inputRevision: () => ({ auth: "auth-v1", preferences: "preferences-v1" }),
      resolveAuth: async () => testAuthContext(), now: () => now, backgroundDiscoveryIntervalMs: 5,
      holdsProfile: () => held,
      resolveCatalog: async () => {
        calls.push(now)
        ran.resolve()
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    await Bun.sleep(15)
    expect(calls).toEqual([])

    prepare.scheduleRefresh(PROFILE)
    await ran.promise
    ran = Promise.withResolvers()
    now = 3_600_000
    await ran.promise
    expect(calls).toEqual([0, 3_600_000])

    // A released profile discovers nothing in the background, until a later discovery of it arms it again.
    held = false
    now = 7_200_000
    await Bun.sleep(15)
    held = true
    await Bun.sleep(15)
    expect(calls).toEqual([0, 3_600_000])
    ran = Promise.withResolvers()
    prepare.scheduleRefresh(PROFILE)
    await ran.promise
    ran = Promise.withResolvers()
    now = 10_800_000
    await ran.promise
    expect(calls).toEqual([0, 3_600_000, 7_200_000, 10_800_000])

    await prepare.dispose()
    now = 14_400_000
    await Bun.sleep(15)
    expect(calls).toHaveLength(4)
    await service.dispose()
  })
})
