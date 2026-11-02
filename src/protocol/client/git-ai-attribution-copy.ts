import type { GitAiAttributionStatus } from "../git-ai-attribution-protocol-types.js"

/** Why Git AI attribution cannot record now, in the words every client shows. */
export function gitAiAttributionUnavailableReason(status: GitAiAttributionStatus & { readonly kind: "unavailable" }): string {
  switch (status.reason) {
    case "no-repository": return "Git AI attribution is unavailable because the runtime is not in a Git repository"
    case "command-not-found": return "Git AI attribution is unavailable because git-ai is not installed"
    case "check-failed": return "Git AI attribution availability could not be checked"
    case "check-timed-out": return "Git AI attribution availability check timed out"
  }
}

/** What an enabled setting can do now, or undefined when it records as set.
 *  A switch that is on cannot show by itself that the runtime cannot act on
 *  it, so every client states the reading beside it. */
export function gitAiAttributionReading(status: GitAiAttributionStatus | undefined): string | undefined {
  if (status?.kind === "checking") return "checking"
  if (status?.kind === "unavailable") return gitAiAttributionUnavailableReason(status)
  return undefined
}
