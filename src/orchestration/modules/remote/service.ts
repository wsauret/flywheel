import { serveLaneFor } from "../../../infra/cli-subprocess.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { ownedCommandRunner } from "../../../infra/owned-command.js"
import { Log } from "../../../infra/log.js"
import { EMPTY_REMOTE_VIEW, remoteCursor } from "../../../protocol/modules/remote.js"
import { DEFAULT_REMOTE_APP_ORIGIN } from "../../../protocol/modules/remote/relay-protocol.js"
import type { AccountProjectModuleServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import { createRemoteAccess, type RemoteAccess } from "./remote-access.js"
import { accountServicePlatform, createAccountServiceInstallation } from "../../app-service/account-service-installation.js"
import { createRemoteNotifier } from "./remote-notifier.js"
import { relaySocketServerLayer } from "./relay-socket-server.js"
import { retiredServiceInstallation } from "./account-relay-service.js"
import { servedClientOf } from "./relay-control-channel.js"

export interface RemoteService extends ModuleServiceInstance {
  access(): RemoteAccess | undefined
  ready(): Promise<RemoteAccess | undefined>
}
export const remoteService = moduleServiceHandle<RemoteService>("remote")

/** One selected generation owns access, push delivery, and transport serving.
 *  Turning the module off retires that generation before another can start. */
export function createRemoteService(services: AccountProjectModuleServices, factories: {
  readonly access?: typeof createRemoteAccess
  readonly notifier?: typeof createRemoteNotifier
} = {}): RemoteService {
  const log = Log.create({ service: "remote" })
  let active: { access: RemoteAccess; admitted(): boolean; retire(): void; dispose(): Promise<void> } | undefined
  let started = false
  let closed = false
  let tail = Promise.resolve()
  const access = () => !closed && services.enabled() && active?.admitted() ? active.access : undefined
  const apply = async (selected: boolean): Promise<void> => {
    const wanted = selected && started && !closed && services.enabled()
    if (active && !wanted) {
      const old = active
      active = undefined
      services.publish({ cursor: remoteCursor(), payload: { kind: "remote.changed", remote: EMPTY_REMOTE_VIEW } })
      await old.dispose()
    }
    if (active || !wanted) return
    const { userDataRoot, projectRoot, accountHome } = services.directories
    const lane = serveLaneFor(process.execPath)
    let admitted = true
    const remote = (factories.access ?? createRemoteAccess)({
      userDataRoot, lane, projectRoot, accountHome, version: process.env.FLYWHEEL_APP_VERSION ?? "source",
      ...(services.webClient === undefined ? {} : { client: servedClientOf(services.webClient) }),
      ...(services.accountModuleFaults === undefined ? {} : { accountModuleFaults: services.accountModuleFaults }),
      projectRegistry: services.projectRegistry,
      ...(lane === "installed" ? { installation: createAccountServiceInstallation(() => accountServicePlatform({ userDataRoot, accountHome, retired: [retiredServiceInstallation], runCommand: ownedCommandRunner(services.launcher) })) } : {}),
      publish: (patch) => { if (admitted && services.enabled() && !closed) services.publish(patch) },
      notify: (episode) => { if (admitted && services.enabled() && !closed) void services.notify(episode) },
    })
    const listeners = new Map<Parameters<typeof services.onFrontendEvent>[0], () => void>()
    let notifier: ReturnType<typeof createRemoteNotifier> | undefined
    let removeTransport: (() => Promise<void>) | undefined
    const dispose = async (): Promise<void> => {
      admitted = false
      const results = await Promise.allSettled([remote.dispose(), notifier?.dispose()])
      for (const remove of listeners.values()) remove()
      listeners.clear()
      const transport = await Promise.allSettled([removeTransport?.()])
      const errors = [...results, ...transport].flatMap((result) => result.status === "rejected" ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, "Remote service failed to settle")
    }
    try {
      notifier = (factories.notifier ?? createRemoteNotifier)({
        addListener: (listener) => { listeners.set(listener, services.onFrontendEvent(listener)) },
        removeListener: (listener) => { listeners.get(listener)?.(); listeners.delete(listener) },
        targets: () => remote.pushTargets(),
        forgetSubscription: (deviceId, subscription) => remote.forgetPushSubscription(deviceId, subscription),
        appOrigin: DEFAULT_REMOTE_APP_ORIGIN, subject: "https://flywl.sh",
        address: () => remote.notificationAddress(),
      })
      removeTransport = services.transports.addListener("remote", (onConnectionCountChanged) => relaySocketServerLayer({ remote, onConnectionCountChanged }))
      active = { access: remote, admitted: () => admitted, retire() { admitted = false }, dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
  const reconcile = (): Promise<void> => {
    const selected = services.enabled()
    if (!selected || closed) active?.retire()
    const pending = tail.then(() => apply(selected))
    tail = pending.catch((error: unknown) => log.warn("remote selection failed", { error: error instanceof Error ? error.message : String(error) }))
    return pending
  }
  const unsubscribe = services.onSelectionChanged(reconcile)
  return {
    access,
    async ready() { await tail; return access() },
    start() { started = true; void reconcile().catch(() => {}) },
    closeAdmission() { closed = true; void unsubscribe() },
    async dispose() { closed = true; await unsubscribe(); await reconcile() },
  }
}
