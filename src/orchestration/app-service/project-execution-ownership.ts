import type { RuntimeOwnership } from "./runtime-ownership.js"
import type { RuntimeShutdownOwners } from "./runtime-shutdown.js"

/** Assigns the project's acquired resources to their shutdown phases.
 * Throws when a required resource is absent or an acquisition has no owner. */
export function completeProjectExecutionOwnership(scope: RuntimeOwnership, input: {
  readonly hasAttributionService: boolean
  readonly stateReleaseResources: readonly string[]
}): RuntimeShutdownOwners {
  scope.shutdown("provider-observations", "stop-runners")
  scope.shutdown("startup-recovery", "stop-runners")
  // The role projection resolves provider connections through session auth
  // admission, which settles inside the runtime-supervisor step, so it stops first.
  scope.sequence("session-runtime", "stop-runners", ["role-projection", "workflow-held-messages", "child-result-notices", "runtime-supervisor", "workflow-hosts", "session-store", "capacity-waits", "auth-session-admission"])
  scope.sequence("durable-state", "flush-durable-state", [
    "history-projection",
    "transcript-cache",
    "subscription-spend-consent-notification-materializer",
    "auth-attention-publisher",
    "module-services",
    "event-store-writer-lane",
  ])
  scope.shutdown("provider-availability", "dispose-availability")
  scope.shutdown("persistent-process-client", "close-client-streams")
  // Reports the repeats of a delivery failure that later producers can still add to.
  scope.shutdown("notification-delivery-failures", "release-state")
  scope.sequence("background-runtime", "close-client-streams", ["background-lane", "background-process-client"])
  scope.shutdown("streaming-edit-validation", "close-client-streams")
  scope.shutdown("session-changes-publisher", "close-client-streams")
  scope.shutdown("background-index", "close-client-streams")
  scope.sequence("frontend-projection", "close-client-streams", [
    "definition-availability-subscription",
    "provider-observations-availability-fold", "provider-observations-capability-subscription",
    "subscription-usage-publication-subscription",
    "auth-free-plan-reconciliation",
    "subscription-spend-consent-materialization-listener",
    "auth-profile-watcher",
    "auth-file-watchers",
    "auth-external-login-observations",
    "auth-project-profile-subscription",
    "chat-default-profiles-subscription",
    "module-selection-subscription",
    "custom-providers-subscription",
    "auth-capability-subscription",
    "auth-session-subscription",
    "auth-login",
    "runtime-config-projection",
    "module-projection",
    "git-ai-attribution-projection",
    "module-transports",
    ...(input.hasAttributionService ? ["git-ai-attribution-service"] : []),
    "output-projection", "kept-output-projection", "status-projection", "budget-projection", "question-projection",
    "module-protocol-runtimes",
    "definition-root-watch",
    "command-catalog",
    "command-usage-projection",
    "runtime-ui-bus",
    "runtime-summary-projection",
    "frontend-projection",
  ])
  scope.sequence("project-state-generation", "release-state", [
    "auth-refresh-coordinator",
    "auth-eligibility-preparation",
    "auth-runtime-core",
    "auth-provider-models",
    "runtime-config",
    ...input.stateReleaseResources,
  ])
  return scope.complete()
}
