import { Effect, Schema } from "effect"
import { CONTROL_RPC_DEADLINE_MS, MODEL_CONFIG_RPC_DEADLINE_MS, OUTPUT_HISTORY_RPC_DEADLINE_MS } from "../infra/with-deadline.js"
import { PROTOCOL_MODULE_MUTATIONS, PROTOCOL_MODULE_READS } from "./modules.js"
import { protocolMutationTable, protocolQueryTable } from "./protocol-module.js"

export type RuntimeCallPolicy =
  | { readonly _tag: "Lossless" }
  | { readonly _tag: "BestEffort"; readonly deadlineMs: number }

const LOSSLESS = { _tag: "Lossless" } as const
const controlRead = { _tag: "BestEffort", deadlineMs: CONTROL_RPC_DEADLINE_MS } as const
const outputRead = { _tag: "BestEffort", deadlineMs: OUTPUT_HISTORY_RPC_DEADLINE_MS } as const
const modelConfigRead = { _tag: "BestEffort", deadlineMs: MODEL_CONFIG_RPC_DEADLINE_MS } as const

interface RuntimeCallPolicyByOperation {
  [operation: string]: RuntimeCallPolicy
}
/** Runtime mutations are lossless because a client deadline can report failure
 *  after delivery or silently discard a user action before delivery. In
 *  particular, a message to a cold chat once exceeded its deadline and dropped
 *  the user's message. Lossless calls therefore rely on worker failure routing
 *  and the process watchdog for liveness; retryable reads remain best-effort. */
export const runtimeCallPolicies = {
  dispatch: LOSSLESS,
  dispatchWorkflow: LOSSLESS,
  clientDiagnostic: controlRead,
  snapshot: controlRead,
  outputWindow: outputRead,
  outputRange: outputRead,
  outputGroupChildren: outputRead,
  outputBlockBody: outputRead,
  transcriptSearch: outputRead,
  projectFiles: outputRead,
  statusSnapshot: controlRead,
  budgetSnapshot: controlRead,
  questionSnapshot: controlRead,
  roleSnapshot: controlRead,
  authStatusSnapshot: controlRead,
  authProfileDeletionPreview: controlRead,
  updateSnapshot: controlRead,
  moduleSnapshot: controlRead,
  configSnapshot: controlRead,
  gitAiAttributionSnapshot: controlRead,
  gitSnapshot: controlRead,
  commandUsageSnapshot: controlRead,
  sessionDetail: controlRead,
  sessionDetailSnapshot: controlRead,
  sessionChanges: outputRead,
  sessionChangeSummary: outputRead,
  sessionChangeDiff: outputRead,
  mutationFiles: outputRead,
  mutationPatchWindow: outputRead,
  sessionBackgroundWork: outputRead,
  recallQueuedMessage: LOSSLESS,
  commandCatalog: controlRead,
  invokeCommand: LOSSLESS,
  modelAssignments: modelConfigRead,
  sessionModelPlan: modelConfigRead,
  modelOptions: modelConfigRead,
  effortOptions: modelConfigRead,
  saveModelEffort: LOSSLESS,
  resetModelAssignments: LOSSLESS,
  modelRoles: modelConfigRead,
  "provider_models.query": modelConfigRead,
  "command_usage.record": LOSSLESS,
  warmBackground: controlRead,
  // A module read takes the tier its protocol home declares, and a module
  // mutation the call class it declares.
  ...protocolQueryTable(PROTOCOL_MODULE_READS, (read) => read.deadline === "control" ? controlRead : outputRead),
  ...protocolMutationTable(PROTOCOL_MODULE_MUTATIONS, (mutation) => mutation.policy === "lossless" ? LOSSLESS : controlRead),
} as const satisfies RuntimeCallPolicyByOperation

export function applyRuntimeCallPolicy<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  policy: RuntimeCallPolicy,
): Effect.Effect<A, E | RuntimeCallTimeout, R> {
  if (policy._tag === "Lossless") return effect
  return effect.pipe(Effect.timeoutOrElse({
    duration: policy.deadlineMs,
    orElse: () => Effect.fail(RuntimeCallTimeout.forDeadline(policy.deadlineMs)),
  }))
}

/** Client-local timeout for a best-effort runtime RPC. It is not part of the RPC
 *  error union in runtime-protocol-schemas.ts because it belongs to the client layer.
 *  The worker client raises it on the Effect error channel, while the background
 *  lane converts infra's DeadlineExceeded into the same tagged error. */
export class RuntimeCallTimeout extends Schema.TaggedErrorClass<RuntimeCallTimeout>()("RuntimeCallTimeout", { message: Schema.String }) {
  /** The action-oriented message shared by both bounded client lanes, so a
   *  timed-out read never surfaces as a contentless toast. */
  static forDeadline(deadlineMs: number): RuntimeCallTimeout {
    return new RuntimeCallTimeout({ message: `The runtime didn't respond within ${Math.round(deadlineMs / 1000)}s - it may be busy or starting up. Try again in a moment.` })
  }
}
