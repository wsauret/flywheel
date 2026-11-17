import { definitionOverridesProtocol, type RuntimeDefinitionStalenessView } from "../../../protocol/modules/definition-overrides.js"
import { workspaceDomainCursor } from "../../../protocol/runtime-ui-protocol-types.js"
import type { DefinitionStalenessReport } from "../../../workflows/definitions/override-staleness.js"
import type { ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"

const definitionStalenessCursor = () => workspaceDomainCursor("definitionStaleness")

const EMPTY_VIEW: RuntimeDefinitionStalenessView = { overrides: [], diagnostics: [], reviewCount: 0 }

/** The module's protocol runtime over the project's override operations.
 *  It publishes one complete latest-collapsible view whenever the operations
 *  reload a report that reads differently from the last one published; the
 *  operations own the report and this holds only its wire view. A composition
 *  without them (no definition registry attached the service) answers the
 *  empty view and publishes nothing. */
export function createDefinitionOverridesProtocol(
  services: Pick<ModuleProtocolServices, "definitions" | "publish" | "snapshotPosition">,
): ModuleProtocolRuntime<typeof definitionOverridesProtocol> {
  const overrides = services.definitions.definitionOverrides
  let view = EMPTY_VIEW
  let published: string | undefined
  const unsubscribe = overrides?.subscribe((report) => {
    const next = toView(report)
    const encoded = JSON.stringify(next)
    if (encoded === published) return
    published = encoded
    view = next
    services.publish({ cursor: definitionStalenessCursor(), payload: { kind: "definitionStaleness.changed", definitionStaleness: next } })
  })
  return {
    serve: {
      async definitionStalenessSnapshot() {
        // The reload publishes any change before the position is read, so the
        // position covers the view the snapshot carries.
        if (overrides) await overrides.list()
        return { definitionStaleness: view, snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: definitionStalenessCursor() }) }
      },
    },
    mutate: {},
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
