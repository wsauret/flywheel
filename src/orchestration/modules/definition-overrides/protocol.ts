import { definitionOverridesProtocol, type RuntimeDefinitionStalenessView } from "../../../protocol/modules/definition-overrides.js"
import { workspaceDomainCursor, type RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
import type { DefinitionOverrideOperations, DefinitionStalenessReport } from "../../../workflows/definitions/override-staleness.js"
import type { ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"

const definitionStalenessCursor = () => workspaceDomainCursor("definitionStaleness")

const EMPTY_VIEW: RuntimeDefinitionStalenessView = { overrides: [], diagnostics: [], reviewCount: 0 }

/** The module's protocol runtime over the project's override operations. A
 *  composition without them (no definition registry attached the service)
 *  answers the empty view and publishes nothing. */
export function createDefinitionOverridesProtocol(services: ModuleProtocolServices): ModuleProtocolRuntime<typeof definitionOverridesProtocol> {
  const projection = createDefinitionStalenessProjection({ overrides: services.definitions.definitionOverrides, publish: services.publish })
  return {
    serve: {
      async definitionStalenessSnapshot() {
        // The reload publishes any change before the position is read, so the
        // position covers the view the snapshot carries.
        const definitionStaleness = await projection.snapshot()
        return { definitionStaleness, snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: definitionStalenessCursor() }) }
      },
    },
    mutate: {},
    dispose: projection.dispose,
  }
}

export interface DefinitionStalenessProjection {
  /** Reloads the report through the operations and answers the resulting view. */
  snapshot(): Promise<RuntimeDefinitionStalenessView>
  dispose(): void
}

/** Publishes one complete latest-collapsible view whenever the override
 *  operations reload a report that reads differently from the last one
 *  published. The operations own the report; this holds only its wire view. */
export function createDefinitionStalenessProjection(options: {
  readonly overrides: Pick<DefinitionOverrideOperations, "list" | "subscribe"> | undefined
  readonly publish: (input: RuntimeUiPatchInput) => void
}): DefinitionStalenessProjection {
  let view = EMPTY_VIEW
  let published: string | undefined
  const unsubscribe = options.overrides?.subscribe((report) => {
    const next = toView(report)
    const encoded = JSON.stringify(next)
    if (encoded === published) return
    published = encoded
    view = next
    options.publish({ cursor: definitionStalenessCursor(), payload: { kind: "definitionStaleness.changed", definitionStaleness: next } })
  })
  return {
    async snapshot() {
      if (options.overrides) await options.overrides.list()
      return view
    },
    dispose() {
      unsubscribe?.()
    },
  }
}

/** The view counts only overrides in effect. A rejected override reaches the
 *  person as its diagnostic, because the copy that runs is not that override. */
function toView(report: DefinitionStalenessReport): RuntimeDefinitionStalenessView {
  const overrides = report.overrides
    .filter((override) => override.valid)
    .map(({ family, id, layer, path, status, snapshotAvailable }) => ({ family, id, layer, path, status, snapshotAvailable }))
  return {
    overrides,
    diagnostics: report.diagnostics,
    reviewCount: overrides.filter((override) => override.status !== "current").length,
  }
}
