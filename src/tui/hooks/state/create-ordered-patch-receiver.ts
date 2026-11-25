import { onCleanup } from "solid-js"
import type { AttachedRuntimeClient } from "../../../protocol/runtime/app-service-types.js"
import { createFamilyIntake, type FamilyIntake, type FamilyIntakeOptions } from "../../../protocol/client/runtime/family-intake.js"
import type { RuntimeUiPatch } from "../../../protocol/runtime/runtime-ui-protocol-types.js"

export type OrderedPatchReceiver<Scope> = Omit<FamilyIntake<Scope>, "handle">

export type OrderedPatchReceiverOptions<Scope, Snapshot, Patch extends RuntimeUiPatch = RuntimeUiPatch> =
  FamilyIntakeOptions<Scope, Snapshot, Patch> & { readonly client: Pick<AttachedRuntimeClient, "subscribe" | "onLane"> & Partial<Pick<AttachedRuntimeClient, "query">> }

/** The terminal's binding of the shared family intake: it gives the intake
 *  the runtime client's events and lanes, and ties its life to the Solid
 *  owner. Every ordering decision lives in the client core. */
export function createOrderedPatchReceiver<Scope, Snapshot, Patch extends RuntimeUiPatch = RuntimeUiPatch>(
  options: OrderedPatchReceiverOptions<Scope, Snapshot, Patch>,
): OrderedPatchReceiver<Scope> {
  const { client, ...intakeOptions } = options
  const intake = createFamilyIntake({ ...intakeOptions, lanes: client, readTransport: client.query === undefined ? undefined : { query: client.query } })
  onCleanup(intake.dispose)
  return {
    resnapshot: intake.resnapshot,
    cancelSnapshot: intake.cancelSnapshot,
    release: intake.release,
    dispose: intake.dispose,
  }
}
