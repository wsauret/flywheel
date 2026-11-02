import type { GitAiAttributionService } from "../agent-runtime/git-ai-attribution-service.js"
import { gitAiAttributionCursor, type GitAiAttributionStatus } from "../../protocol/git-ai-attribution-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"

export interface GitAiAttributionProjection {
  view(): GitAiAttributionStatus
  check(): Promise<GitAiAttributionStatus>
  dispose(): void
}

const NO_REPOSITORY_STATUS = Object.freeze({ kind: "unavailable", reason: "no-repository" } as const)

export function createGitAiAttributionProjection(options: { readonly service?: GitAiAttributionService; readonly publish: (patch: RuntimeUiPatchInput) => void }): GitAiAttributionProjection {
  const service = options.service
  if (service === undefined) return Object.freeze({ view: () => NO_REPOSITORY_STATUS, check: async () => NO_REPOSITORY_STATUS, dispose: () => {} })

  let view: GitAiAttributionStatus = service.status()
  const unsubscribe = service.subscribe((status) => {
    view = status
    options.publish({ cursor: gitAiAttributionCursor(), payload: { kind: "gitAiAttribution.changed", status } })
  })
  return Object.freeze({ view: () => view, check: () => service.checkAvailability(), dispose: unsubscribe })
}
