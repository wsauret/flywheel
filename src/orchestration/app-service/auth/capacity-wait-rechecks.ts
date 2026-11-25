import type { RuntimeConfigOwner } from "../../config/runtime-config-owner.js"
import type { CapacityServingCheck, CapacityWaitLedger } from "../../session/control/capacity-wait.js"

/** The executor's capacity waits, as the auth runtime rechecks them. */
export type CapacityWaits = Pick<CapacityWaitLedger, "recheck">

/** When the auth runtime rechecks the executor's capacity waits (PI-MODEL-039). */
interface CapacityWaitRechecks {
  /** Once the runtimes hold an authentication or model admission change: only a wait whose model `serves` now ends,
   *  and the rest keep waiting. */
  afterAuthChange(): void
  dispose(): Promise<void>
}

/** Rechecks the capacity waits after each authentication change and each change of the profiles config. A change of
 *  a profile's role settings ends every wait, so each agent resolves its role again; any other change of a profile,
 *  such as its training routes, can only change what serves. */
export function capacityWaitRechecks(
  runtimeConfig: Pick<RuntimeConfigOwner, "snapshot" | "subscribe">,
  capacityWaits: CapacityWaits,
  serves: CapacityServingCheck,
): CapacityWaitRechecks {
  const rolesOf = (profiles: ReturnType<RuntimeConfigOwner["snapshot"]>["config"]["profiles"]) =>
    JSON.stringify(Object.entries(profiles).map(([id, profile]) => [id, profile.roles]))
  let roles = rolesOf(runtimeConfig.snapshot().config.profiles)
  const unsubscribe = runtimeConfig.subscribe("profiles", ({ config }) => {
    const changed = rolesOf(config.profiles)
    capacityWaits.recheck(changed === roles ? serves : undefined)
    roles = changed
  })
  return { afterAuthChange: () => { capacityWaits.recheck(serves) }, dispose: unsubscribe }
}
