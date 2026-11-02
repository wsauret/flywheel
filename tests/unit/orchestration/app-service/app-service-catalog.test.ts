import { describe, expect, test } from "bun:test"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"

describe("FlywheelAppService catalog discovery", () => {
  test("catalog scheduling acknowledges while owner-held discovery is pending", async () => {
    const store = fakeSessionStore(new Map())
    const manager = fakeManager()
    const models = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let calls = 0
    const owner = createEligibilityPreparation({
      allowTrainingRoutes: () => false,
      userDataRoot: "/unused", resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules([]), prepare: models.prepare, publish: models.publish, current: models.state,
      inputRevision: () => ({ auth: "a", preferences: "p" }), resolveAuth: async () => testAuthContext(),
      resolveCatalog: async ({ discoveryMode }) => {
        if (discoveryMode === "refresh") { calls += 1; entered.resolve(); await held.promise }
        return { providers: new Map(), accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
      },
    })
    const scopes: unknown[] = []
    const service = createFlywheelAppService({
      projectRoot: "/scratch", projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: "/scratch" }),
      bus: createRuntimeUiBus(), ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor(),
      scheduleCatalogRefresh: async (scope) => { scopes.push(scope); owner.scheduleRefresh({ id: "work", directory: "/unused/work" }) },
      authProfileSelection: {
        previewDelete: async () => { throw new Error("unexpected deletion preview") },
        refresh: async () => { throw new Error("broad refresh must not run") },
        settle: async () => { throw new Error("auth settlement must not run") },
        mutate: async () => { throw new Error("not used") },
      },
    })
    try {
      for (const scope of [{ kind: "defaults" }, { kind: "session", sessionId: "chat-1" }, { kind: "profile", profileId: "work" }] as const) {
        await expect(service.dispatch({ type: "auth.catalog.refresh", scope })).resolves.toEqual({ ok: true })
      }
      await entered.promise
      expect(calls).toBe(1)
      expect(scopes).toEqual([{ kind: "defaults" }, { kind: "session", sessionId: "chat-1" }, { kind: "profile", profileId: "work" }])
    } finally {
      held.resolve()
      await owner.dispose()
      await models.dispose()
      await runRuntimeShutdownBarrier(service.shutdown)
    }
  })
})
