import type { RuntimePosition } from "./runtime-ui-protocol-types.js"

type GitAiAttributionUnavailableReason = "no-repository" | "command-not-found" | "check-failed" | "check-timed-out"

export type GitAiAttributionStatus =
  | { readonly kind: "checking" }
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: GitAiAttributionUnavailableReason }

export interface RuntimeGitAiAttributionSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly status: GitAiAttributionStatus
}

export type GitAiAttributionPatchPayload = { readonly kind: "gitAiAttribution.changed"; readonly status: GitAiAttributionStatus }

export function gitAiAttributionCursor() {
  return { scope: "workspace", domain: "gitAiAttribution" } as const
}
