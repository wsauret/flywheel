import { errorMessage } from "../../../infra/error-message.js"
import { EMPTY_REMOTE_VIEW, remoteCursor, remoteProtocol, type RemoteMutationResult } from "../../../protocol/modules/remote.js"
import type { ModuleProtocolRuntime, AccountModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import type { RemoteAccess } from "./remote-access.js"
import { remoteService } from "./service.js"

export function createRemoteProtocol(services: AccountModuleProtocolServices): ModuleProtocolRuntime<typeof remoteProtocol> {
  const current = () => services.enabled() ? services.modules.get(remoteService) : undefined
  const mutate = async (run: (remote: RemoteAccess) => Promise<void | boolean>, missing = "That device is not paired."): Promise<RemoteMutationResult> => {
    const remote = await current()?.ready()
    if (!remote || !services.enabled()) return { kind: "rejected", message: "Remote access is off" }
    try {
      if (await run(remote) === false) return { kind: "rejected", message: missing }
      return { kind: "committed" }
    } catch (error) {
      return { kind: "rejected", message: errorMessage(error) }
    }
  }
  return {
    serve: {
      remoteSnapshot: async () => ({ remote: current()?.access()?.view() ?? EMPTY_REMOTE_VIEW, snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: remoteCursor() }) }),
    },
    mutate: {
      "remote.pair.open": () => mutate(async (remote) => { await remote.openPairing() }),
      "remote.pair.cancel": () => mutate((remote) => remote.cancelPairing()),
      "remote.device.revoke": (request) => mutate((remote) => remote.revokeDevice(request.deviceId)),
      "remote.device.rename": (request) => mutate((remote) => remote.renameDevice(request.deviceId, request.label.trim())),
      "remote.push.subscribe": (request) => mutate((remote) => remote.setPushSubscription(request.deviceId, request.subscription)),
      "remote.push.unsubscribe": (request) => mutate((remote) => remote.setPushSubscription(request.deviceId, undefined)),
      "remote.project.forget": (request) => mutate((remote) => remote.forgetProject(request.placementId), "That project is not recorded."),
      "remote.process_initiation.set": (request) => mutate((remote) => remote.setProcessInitiation(request.enabled)),
    },
    dispose() {},
  }
}
