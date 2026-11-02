import type { Accessor } from "solid-js"

import type { FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { actionKey } from "../../client/action-key.js"
import type { ClientActions } from "../../client/actions.js"

export type RemoteMutation = Extract<FrontendMutation, { readonly type: `remote.${string}` }>

interface RemoteMutationClient {
  readonly dispatch: (mutation: RemoteMutation) => Promise<MutationResult<RemoteMutation>>
  readonly report: (severity: "warning", message: string) => void
  readonly actions: Pick<ClientActions, "runInOrder" | "working">
}

/** What a remote operation acts on: a device, a project, or the machine's
 *  one pairing and service, which need no name. */
function targetOf(mutation: RemoteMutation): string | undefined {
  if ("deviceId" in mutation) return mutation.deviceId
  if ("placementId" in mutation) return mutation.placementId
  return undefined
}

/** The value an operation writes, when it has one: a device's new name, or
 *  whether the service starts on its own. */
function valueOf(mutation: RemoteMutation): string | undefined {
  if (mutation.type === "remote.device.rename") return mutation.label
  if (mutation.type === "remote.process_initiation.set") return String(mutation.enabled)
  return undefined
}

/** Runs the web Remote sheet's operations through the client's action owner,
 *  each in order under its mutation type and the device or project it acts
 *  on. The tapped control reads working until the runtime answers. A
 *  repeated tap joins the running operation, another value, such as a second
 *  new name, runs after it, and an operation on another device or project
 *  runs on its own. A refusal keeps the service's own words. */
export function createRemoteMutation(
  client: RemoteMutationClient,
  active: Accessor<boolean>,
  allowed: (type: RemoteMutation["type"]) => boolean,
) {
  const report = (message: string, repair: boolean): void => client.report("warning", repair
    ? `${message}. Run \`flywheel serve install\` on this machine. If that command also fails, report a bug.`
    : message)
  const mutate = async (mutation: RemoteMutation, repair = false): Promise<void> => {
    if (!active() || !allowed(mutation.type)) return
    const target = targetOf(mutation)
    await client.actions.runInOrder(actionKey(mutation.type, target), actionKey(mutation.type, target, valueOf(mutation)), async () => {
      let refusal: string | undefined
      try {
        const result = await client.dispatch(mutation)
        if (result.kind === "rejected") refusal = result.message
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error)
      }
      if (refusal !== undefined) report(refusal, repair)
    })
  }
  /** Whether the operation `type` on `target` runs. Reactive. */
  const working = (type: RemoteMutation["type"], target?: string): boolean => client.actions.working(actionKey(type, target))
  return { mutate, working }
}
