import { onCleanup } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { createFamilyIntake, type FamilyIntake, type FamilyIntakeOptions } from "../../protocol/client/family-intake.js"
import type { RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"

export type OrderedPatchReceiver<Scope> = Omit<FamilyIntake<Scope>, "handle" | "lane">

export type OrderedPatchReceiverOptions<Scope, Snapshot, Patch extends RuntimeUiPatch = RuntimeUiPatch> =
  FamilyIntakeOptions<Scope, Snapshot, Patch> & { readonly client: Pick<AttachedRuntimeClient, "subscribe" | "onLane"> & Partial<Pick<AttachedRuntimeClient, "query">> }

/** The terminal's binding of the shared family intake: it subscribes the
 *  intake to the runtime client's events and lanes, and ties its life to the
 *  Solid owner. Every ordering decision lives in the client core. */
export function createOrderedPatchReceiver<Scope, Snapshot, Patch extends RuntimeUiPatch = RuntimeUiPatch>(
  options: OrderedPatchReceiverOptions<Scope, Snapshot, Patch>,
): OrderedPatchReceiver<Scope> {
  const { client, ...intakeOptions } = options
  const intake = createFamilyIntake({ ...intakeOptions, readTransport: client.query === undefined ? undefined : { query: client.query } })
  const unsubscribe = client.subscribe(intake.handle)
  const stopLanes = client.onLane(intake.lane)
  const dispose = (): void => {
    stopLanes()
    unsubscribe()
    intake.dispose()
  }
  onCleanup(dispose)
  return {
    resnapshot: intake.resnapshot,
    cancelSnapshot: intake.cancelSnapshot,
    release: intake.release,
    adoptSnapshot: intake.adoptSnapshot,
    dispose,
  }
}
