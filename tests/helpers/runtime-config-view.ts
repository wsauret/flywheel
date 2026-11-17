import { createRuntimeConfigProjection } from "../../src/orchestration/app-service/runtime-config-projection.js"
import type { RuntimeConfigOwner, RuntimeConfigSnapshot } from "../../src/orchestration/config/runtime-config-owner.js"
import type { RuntimeConfigView } from "../../src/protocol/runtime-config-protocol-types.js"

const unused = (): never => { throw new Error("a static config owner serves only its snapshot") }

/** The config view that a project at `projectRoot` publishes while its owner
 *  holds `snapshot`, built by the production projection. */
export function runtimeConfigView(snapshot: RuntimeConfigSnapshot, projectRoot: string): RuntimeConfigView {
  const owner: RuntimeConfigOwner = {
    snapshot: () => snapshot,
    subscribeAll: () => async () => {},
    refresh: unused,
    subscribe: unused,
    mutate: unused,
    resetSettings: unused,
    mutateModuleSetting: unused,
    mutateSection: unused,
    mutateProfileBoolean: unused,
    mutateProjectShowBuild: unused,
    mutateProfileProviderSetting: unused,
    revalidateUseTime: unused,
    useTimeObserver: unused,
    dispose: async () => {},
  }
  return createRuntimeConfigProjection({ owner, projectRoot, publish: unused }).view()
}
