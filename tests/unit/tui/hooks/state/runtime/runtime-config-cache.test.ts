import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import type { RuntimeClient } from "../../../../../../src/protocol/runtime/app-service-types.js"
import type { RuntimeConfigSnapshotResult } from "../../../../../../src/protocol/settings/runtime-config-protocol-types.js"
import { createRuntimeConfigCache } from "../../../../../../src/tui/hooks/state/runtime/create-runtime-config-cache.js"
import { mutateRuntimeConfig } from "../../../../../../src/tui/hooks/state/create-settings-store.js"
import { configValues } from "../../../modals/settings/_settings-modal-fixtures.js"
import { fakeLanes, LANE_BREAK } from "../../../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery, type DispatchAnswers, type QueryAnswers } from "../../../../../helpers/runtime-dispatch.js"

function configClient(options: {
  readonly query?: QueryAnswers["configSnapshot"]
  readonly dispatch?: DispatchAnswers["config.mutate"]
}) {
  // The lane is open from the start.
  return {
    query: runtimeQuery({ configSnapshot: options.query }),
    dispatch: runtimeDispatch({ "config.mutate": options.dispatch }),
    onLane: fakeLanes().onLane,
  }
}
describe("runtime config cache mutation settlement", () => {
  it("resnapshots an acknowledged revision when its patch is lost", async () => {
    await createRoot(async (dispose) => {
      const query = mock(async (): Promise<RuntimeConfigSnapshotResult> => ({
        snapshotPosition: 2,
        config: { revision: 2, values: { ...configValues(), theme: "twilight" }, status: { kind: "valid" }, warnings: [], diagnostics: [] },
      }))
      query.mockImplementationOnce(async () => ({
        snapshotPosition: 1,
        config: { revision: 1, values: configValues(), status: { kind: "valid" }, warnings: [], diagnostics: [] },
      }))
      const subscribe: Pick<RuntimeClient, "subscribe">["subscribe"] = () => () => {}
      const dispatch = mock(async () => ({ kind: "committed", revision: 2 } as const))
      const cache = createRuntimeConfigCache({ appService: { ...configClient({ query }), subscribe } })
      // The lane's read lands before the mutation, and no patch follows it.
      for (let turn = 0; turn < 10 && cache.view() === undefined; turn++) await Promise.resolve()
      expect(cache.view()?.revision).toBe(1)

      const result = await mutateRuntimeConfig(cache, configClient({ dispatch }), {
        type: "config.mutate",
        setting: { id: "theme", expected: { kind: "absent" }, desired: "twilight" },
      })

      expect(result).toEqual({ kind: "committed", revision: 2 })
      expect(cache.view()?.values.theme).toBe("twilight")
      expect(query).toHaveBeenCalledTimes(2)
      dispose()
    })
  })

  it("waits through a failed settlement read and settles when a later read lands the revision", async () => {
    await createRoot(async (dispose) => {
      const revision = (number: 1 | 2): RuntimeConfigSnapshotResult => ({
        snapshotPosition: number,
        config: { revision: number, values: number === 1 ? configValues() : { ...configValues(), theme: "twilight" }, status: { kind: "valid" }, warnings: [], diagnostics: [] },
      })
      const query = mock(async (): Promise<RuntimeConfigSnapshotResult> => revision(2))
      query.mockImplementationOnce(async () => revision(1))
      query.mockImplementationOnce(async () => { throw new Error("configuration read timed out") })
      const listeners = new Set<Parameters<Pick<RuntimeClient, "subscribe">["subscribe"]>[0]>()
      const subscribe: Pick<RuntimeClient, "subscribe">["subscribe"] = (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }
      const lanes = fakeLanes()
      const cache = createRuntimeConfigCache({ appService: { ...configClient({ query }), subscribe, onLane: lanes.onLane } })
      for (let turn = 0; turn < 10 && cache.view() === undefined; turn++) await Promise.resolve()
      expect(cache.view()?.revision).toBe(1)

      let settled = false
      const mutation = mutateRuntimeConfig(cache, configClient({ dispatch: async () => ({ kind: "committed", revision: 2 }) }), {
        type: "config.mutate",
        setting: { id: "theme", expected: { kind: "absent" }, desired: "twilight" },
      }).finally(() => { settled = true })
      for (let turn = 0; turn < 20 && query.mock.calls.length < 2; turn++) await Promise.resolve()
      for (let turn = 0; turn < 20; turn++) await Promise.resolve()
      // The write committed, so a failed read is no answer: the mutation waits.
      expect(query).toHaveBeenCalledTimes(2)
      expect(settled).toBe(false)

      lanes.end()
      for (const listener of listeners) listener(LANE_BREAK)
      lanes.open()

      expect(await mutation).toEqual({ kind: "committed", revision: 2 })
      expect(cache.view()?.values.theme).toBe("twilight")
      dispose()
    })
  })

  it("settles a module setting from its published section and key", async () => {
    await createRoot(async (dispose) => {
      const query = mock(async (): Promise<RuntimeConfigSnapshotResult> => ({
        snapshotPosition: 3,
        config: { revision: 3, values: { ...configValues(), moduleSections: { synthetic: { levels: [10, 50] } } }, status: { kind: "valid" }, warnings: [], diagnostics: [] },
      }))
      const subscribe: Pick<RuntimeClient, "subscribe">["subscribe"] = () => () => {}
      const cache = createRuntimeConfigCache({ appService: { ...configClient({ query }), subscribe } })
      const result = await mutateRuntimeConfig(cache, configClient({ dispatch: async () => ({ kind: "committed", revision: 3 }) }), {
        type: "config.mutate",
        setting: { id: "module", section: "synthetic", key: "levels", expected: { kind: "value", value: [] }, desired: [10, 50] },
      })
      expect(result).toEqual({ kind: "committed", revision: 3 })
      expect(cache.view()?.values.moduleSections.synthetic?.levels).toEqual([10, 50])
      dispose()
    })
  })

  it("returns a typed closed failure when the cache closes before publication", async () => {
    const query = mock(async (): Promise<RuntimeConfigSnapshotResult> => { throw new Error("query must not run after close") })
    const subscribe: Pick<RuntimeClient, "subscribe">["subscribe"] = () => () => {}
    const cache = createRoot((dispose) => {
      // The cache closes before any lane opens.
      const created = createRuntimeConfigCache({ appService: { ...configClient({ query }), subscribe, onLane: fakeLanes({ open: false }).onLane } })
      dispose()
      return created
    })

    const result = await mutateRuntimeConfig(cache, configClient({ dispatch: async () => ({ kind: "committed", revision: 2 }) }), {
      type: "config.mutate",
      setting: { id: "theme", expected: { kind: "absent" }, desired: "twilight" },
    })

    expect(result).toEqual({ kind: "disposed", message: "Configuration updates are unavailable." })
    expect(query).not.toHaveBeenCalled()
  })
})
