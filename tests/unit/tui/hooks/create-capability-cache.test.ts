import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { capabilitiesCursor, type RuntimeModuleSnapshotResult, type RuntimeModulesView } from "../../../../src/protocol/module-protocol-types.js"
import { createModuleCache } from "../../../../src/tui/hooks/create-module-cache.js"
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

function view(overrides: Partial<RuntimeModulesView> = {}): RuntimeModulesView {
  return {
    capabilities: ["workflows", "skills"],
    moduleIds: ["skills", "workflows"],
    descriptorIdentity: decodeModuleState('disabled_modules = ["learning"]\n').identity,
    modules: [],
    warnings: [],
    workflowsMode: "ask",
    requireWorkflowConfirmation: true,
    persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
    ...overrides,
  }
}

function fakeAppService(initial: RuntimeModulesView) {
  const sequencer = createRuntimeUiPatchSequencer()
  const cursor = capabilitiesCursor()
  let snapshot = initial
  let snapshotCalls = 0
  let deferNextSnapshot = false
  let settleDeferredSnapshot: (() => void) | null = null
  let listener: ((event: FrontendEvent) => void) | null = null
  let lastPatch: (FrontendEvent & { type: "patch" }) | null = null

  const lanes = fakeLanes()
  const query = runtimeQuery({ moduleSnapshot: async () => {
    snapshotCalls += 1
    const answer: RuntimeModuleSnapshotResult = { capabilities: snapshot, snapshotPosition: sequencer.snapshotPosition({ kind: "cursor", cursor }) }
    if (!deferNextSnapshot) return answer
    deferNextSnapshot = false
    const gate = Promise.withResolvers<RuntimeModuleSnapshotResult>()
    settleDeferredSnapshot = () => { gate.resolve(answer) }
    return await gate.promise
  } })
  const service = {
    query,
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { listener = null }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">

  return {
    service,
    setSnapshot: (next: RuntimeModulesView) => { snapshot = next },
    /** Hold the next snapshot answer in flight, so a later publication can
     *  overtake the view it was taken from. */
    deferNextSnapshot: () => { deferNextSnapshot = true },
    settleSnapshot: () => { settleDeferredSnapshot?.(); settleDeferredSnapshot = null },
    snapshotCalls: () => snapshotCalls,
    live: (next: RuntimeModulesView) => {
      lastPatch = { type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "modules.changed", capabilities: next } }) }
      listener?.(lastPatch)
    },
    redeliverLastPatch: () => { if (lastPatch) listener?.(lastPatch) },
    skipThenLive: (next: RuntimeModulesView) => {
      sequencer.publish({ cursor, payload: { kind: "modules.changed", capabilities: view({ capabilities: [] , workflowsMode: "off" }) } })
      listener?.({ type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "modules.changed", capabilities: next } }) })
    },
    reconnect: () => {
      lanes.end()
      listener?.(LANE_BREAK)
      lanes.open()
    },
  }
}

/** Lets a held view's read answer: the read crosses several promise turns. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

describe("createModuleCache", () => {
  it("holds no selection before the runtime publishes one", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createModuleCache({ appService: fake.service })

      expect(cache.view()).toBeUndefined()
      await settle()

      expect(cache.view()).toEqual(view())
      dispose()
    })
  })

  it("replaces the held view outright, including the optional configuration error", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view({ capabilities: [], workflowsMode: "off", error: "features is invalid" }))
      const cache = createModuleCache({ appService: fake.service })
      await settle()

      expect(cache.view()?.error).toBe("features is invalid")

      fake.live(view({ capabilities: ["skills"], workflowsMode: "off" }))
      expect(cache.view()).toEqual(view({ capabilities: ["skills"], workflowsMode: "off" }))
      expect(cache.view()?.error).toBeUndefined()
      dispose()
    })
  })

  it("resnapshots on reconnect", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createModuleCache({ appService: fake.service })
      await settle()
      const reconnected = view({ capabilities: [], workflowsMode: "off", error: "flywheel.toml cannot be parsed" })
      fake.setSnapshot(reconnected)

      fake.reconnect()
      await settle()

      expect(cache.view()).toEqual(reconnected)
      dispose()
    })
  })

  it("keeps a publication that overtook an in-flight snapshot", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService(view())
      const cache = createModuleCache({ appService: fake.service })
      await settle()
      fake.setSnapshot(view({ capabilities: [], workflowsMode: "off" }))
      fake.deferNextSnapshot()

      // The gap starts a resnapshot whose answer is still in flight, and a newer
      // publication lands before it. That publication is the later state, so it
      // survives the obsolete snapshot it overtook.
      fake.skipThenLive(view({ capabilities: ["skills"], workflowsMode: "off" }))
      fake.live(view({ capabilities: ["skills", "subagents"], workflowsMode: "off" }))
      fake.settleSnapshot()
      for (let i = 0; i < 6; i++) await settle()

      expect(cache.view()?.capabilities).toEqual(["skills", "subagents"])
      dispose()
    })
  })

  it("retains warning state from runtime publications", async () => {
    await createRoot(async (dispose) => {
      const noTools = "No tools contributions are enabled"
      const noProviders = "No providers contributions are enabled"
      const fake = fakeAppService(view({ warnings: [noTools] }))
      const cache = createModuleCache({ appService: fake.service })
      await settle()

      expect(cache.view()?.warnings).toEqual([noTools])
      fake.live(view({ capabilities: [], warnings: [noTools, noProviders] }))
      expect(cache.view()?.warnings).toEqual([noTools, noProviders])
      fake.live(view())
      expect(cache.view()?.warnings).toEqual([])
      dispose()
    })
  })
})
