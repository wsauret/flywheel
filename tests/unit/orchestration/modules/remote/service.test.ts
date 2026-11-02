import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"
import type { AccountModuleFaults, AccountProjectModuleServices } from "../../../../../src/orchestration/app-service/module-service-host.js"
import { composeAccountProjectModuleServices, composeModuleProcessServices } from "../../../../../src/orchestration/app-service/module-service-host.js"
import { composeAccountModuleProtocolRuntimes } from "../../../../../src/orchestration/app-service/module-protocol-host.js"
import { remoteModule } from "../../../../../src/orchestration/modules/remote/module.js"
import { createRemoteService, remoteService } from "../../../../../src/orchestration/modules/remote/service.js"
import type { createRemoteAccess, RemoteAccess, RemoteChannelAccept } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import { EMPTY_REMOTE_VIEW } from "../../../../../src/protocol/modules/remote.js"
import type { FrontendEvent } from "../../../../../src/protocol/app-service-types.js"
import { createLauncherScope } from "../../../../../src/infra/process-supervisor.js"
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js"
import { kernelPorts } from "../../../../helpers/module-kernel.js"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRuntimeConfigOwner } from "../../../../../src/orchestration/config/runtime-config-owner.js"
import { Effect, ManagedRuntime } from "effect"
import { Socket, SocketServer } from "effect/unstable/socket"
import { createModuleTransports, type ModuleTransports } from "../../../../../src/orchestration/app-service/module-transports.js"

/** The account's report of the module services it could not start, as the
 *  account hands it to every project. */
const accountModuleFaults: AccountModuleFaults = { fault: () => undefined, subscribe: () => () => {} }

function fixture(transports?: ModuleTransports, onSelectionChanged?: AccountProjectModuleServices["onSelectionChanged"]) {
  let enabled = false
  let rejectListener = false
  let rejectNotifier = false
  const frontendListeners = new Set<(event: FrontendEvent) => void>()
  let hold: Promise<void> | undefined
  const calls: string[] = []
  const listeners = new Set<() => void | Promise<void>>()
  let created = 0
  const registered = Promise.withResolvers<RemoteChannelAccept>()
  const accessOptions: Parameters<typeof createRemoteAccess>[0][] = []
  const factory: NonNullable<Parameters<typeof createRemoteService>[1]> = {
    access: (options) => {
      accessOptions.push(options)
      const id = ++created
      calls.push(`create ${id}`)
      const remote: RemoteAccess = {
        view: () => EMPTY_REMOTE_VIEW,
        openPairing: async () => { calls.push(`pair ${id}`); return { windowId: "window", code: "link", expiresAt: 100 } },
        cancelPairing: async () => {}, revokeDevice: async () => { calls.push(`revoke ${id}`); return true }, renameDevice: async () => true,
        forgetProject: async () => true, setProcessInitiation: async () => {}, setPushSubscription: async () => true,
        pushTargets: () => [], forgetPushSubscription: async () => {},
        notificationAddress: async () => ({ runtimeId: "machine", placementId: "project", machine: "Machine", project: "Project" }),
        acceptChannels: (accept) => { registered.resolve(accept); return () => { calls.push(`unaccept ${id}`) } }, onChange: () => () => {},
        async dispose() { calls.push(`closing ${id}`); await hold; calls.push(`closed ${id}`) },
      }
      return remote
    },
    notifier: (options) => {
      const listener = () => {}
      options.addListener(listener)
      if (rejectNotifier) throw new Error("notifier refused")
      return { async dispose() { options.removeListener(listener); calls.push("notifier closed") } }
    },
  }
  // Only the ports the tested service consumes are supplied; the process owner
  // forwards the remaining kernel authorities without reading them.
  const kernel: Omit<AccountProjectModuleServices, "modules" | "enabled"> = {
    projectRegistry: { list: async () => [], record: async () => { throw new Error("not used") }, forget: async () => {}, watch: () => () => {} },
    directories: testDirectories("/scratch/remote-service"), launcher: createLauncherScope({ spawnOwned: () => { throw new Error("No process starts in this service fixture") }, adoptOwned: () => Promise.reject(new Error("no command is adopted here")) }),
    eventStore: asAsyncEventReadSurface(inMemoryEventReader([])),
    projectionReader: asAsyncEventReadSurface(inMemoryEventReader([])),
    eventWriter: {
      append: async () => { throw new Error("not used") },
      appendBatch: async () => { throw new Error("not used") },
      pruneSupersededEvents: async () => 0,
    },
    onStored: () => () => {},
    accountModuleFaults,
    snapshotPosition: () => 0,
    publish: (input) => ({ ...input, position: 1, prevPosition: 0 }), notify: async () => {}, onFrontendEvent: (listener) => { frontendListeners.add(listener); return () => { frontendListeners.delete(listener) } },
    onSelectionChanged: onSelectionChanged ?? ((listener: () => void | Promise<void>) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    transports: transports ?? { addListener: () => {
      if (rejectListener) throw new Error("listener refused")
      calls.push("listen")
      return async () => { calls.push("unlisten") }
    } },
  }
  const module = { ...remoteModule, service: { ...remoteModule.service, create: (services: AccountProjectModuleServices) => createRemoteService(services, factory) } }
  const selected = () => enabled ? [remoteModule.id] : []
  const owner = composeAccountProjectModuleServices([module], selected, kernel)
  const protocol = composeAccountModuleProtocolRuntimes([module], { ...kernel, modules: owner.services }, selected)
  owner.reconcile()
  owner.start()
  return {
    calls, owner, protocol, module, registered: registered.promise, frontendListeners, accessOptions, get created() { return created },
    service: () => owner.services.get(remoteService),
    rejectNotifier(value: boolean) { rejectNotifier = value },
    reject(value: boolean) { rejectListener = value }, hold(value: Promise<void>) { hold = value },
    async select(value: boolean) { enabled = value; owner.reconcile(); await Promise.all([...listeners].map((listener) => listener())) },
  }
}

describe("Remote service ownership", () => {
  const temporaryDirectory = temporaryDirectories()

  test("shutdown joins a config callback scheduled before it enters the reconciliation queue", async () => {
    const configPath = join(temporaryDirectory("remote-config-stop-"), "flywheel.toml")
    writeFileSync(configPath, "")
    const config = await createRuntimeConfigOwner({ configPath, watch: false })
    const f = fixture(undefined, (listener) => config.subscribe("moduleSelection", listener))
    await f.select(true)
    await f.service()?.ready()
    // Snapshot subscribers run before the selection callback queued by the same publication.
    config.subscribeAll(() => f.owner.closeAdmission())
    writeFileSync(configPath, 'disabled_modules = ["remote"]\n')
    await config.refresh()
    await f.owner.dispose()
    await config.dispose()
    f.protocol.dispose()
    expect(f.calls).toContain("closed 1")
    expect(f.created).toBe(1)
  })

  test("account transport accepts into its protocol owner and releases its project hold", async () => {
    const transports = createModuleTransports()
    const f = fixture(transports)
    const counts: number[] = []
    const answers: unknown[] = []
    await transports.serve((_kind, listener) => {
      const runtime = ManagedRuntime.make(listener((count) => { counts.push(count) }))
      const serving = runtime.runPromise(Effect.flatMap(SocketServer.SocketServer, (server) =>
        server.run(() => Effect.promise(async () => { answers.push(await f.protocol.mutate({ type: "remote.pair.open" })) }))))
      void serving.catch(() => {})
      return { ready: runtime.context().then(() => {}), async dispose() { await runtime.dispose(); await serving.catch(() => {}) } }
    })
    try {
      await f.select(true)
      const accept = await f.registered
      const socket = await Effect.runPromise(Socket.fromTransformStream(Effect.succeed({
        readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>(),
      })))
      await accept(socket, { id: "phone", label: "Phone", publicKey: "key", pairedAt: 0 })
      expect(answers).toEqual([{ kind: "committed" }])
      expect(f.calls).toContain("pair 1")
      expect(counts).toEqual([1, 0])
      await f.select(false)
      expect(f.calls).toContain("unaccept 1")
    } finally {
      f.protocol.dispose()
      await f.owner.dispose()
      await transports.dispose()
    }
  })
  test("executor skips the account service; account protocol shares pairing and revoke ownership", async () => {
    const f = fixture()
    // The executor must not read a port when its only module belongs to the account.
    const unavailable = new Proxy(kernelPorts(), { get() { throw new Error("executor accessed account service ports") } })
    const executor = composeModuleProcessServices([f.module], () => ["remote"], unavailable)
    executor.start()
    expect(executor.instances).toHaveLength(0)
    await f.select(true)
    expect(f.protocol.owns({ type: "remoteSnapshot" })).toBe(true)
    expect(await f.protocol.mutate({ type: "remote.pair.open" })).toEqual({ kind: "committed" })
    expect(await f.protocol.mutate({ type: "remote.device.revoke", deviceId: "phone" })).toEqual({ kind: "committed" })
    expect(f.calls.filter((call) => call === "listen")).toHaveLength(1)
    expect(f.calls).toContain("pair 1")
    expect(f.calls).toContain("revoke 1")
    await f.select(false)
    expect(await f.protocol.mutate({ type: "remote.pair.open" })).toEqual({ kind: "rejected", message: "Remote access is off" })
    expect((await f.protocol.serve({ type: "remoteSnapshot" })).remote).toEqual(EMPTY_REMOTE_VIEW)
    expect(f.frontendListeners.size).toBe(0)
    expect(f.calls).toContain("unlisten")
    f.protocol.dispose()
    await f.owner.dispose()
    await executor.dispose()
  })
  test("hands the account's report of the module services it could not start to the remote access it creates", async () => {
    const f = fixture()
    await f.select(true)
    expect(f.accessOptions.map((options) => options.accountModuleFaults)).toEqual([accountModuleFaults])
    await f.owner.dispose()
  })

  test("initial off constructs no service or listener; first live enable attaches once", async () => {
    const f = fixture()
    expect(f.service()).toBeUndefined()
    expect(f.calls).toEqual([])
    await f.select(true)
    expect(await f.service()?.ready()).toBeDefined()
    expect(f.calls).toEqual(["create 1", "listen"])
    await f.select(true)
    expect(f.created).toBe(1)
    await f.owner.dispose()
    expect(f.calls).toContain("notifier closed")
    expect(f.calls).toContain("closed 1")
    expect(f.calls.at(-1)).toBe("unlisten")
  })

  test("rapid off and on waits for all old ownership before recreating", async () => {
    const f = fixture()
    await f.select(true)
    const closed = Promise.withResolvers<void>()
    f.hold(closed.promise)
    const off = f.select(false)
    const on = f.select(true)
    await Promise.resolve()
    expect(f.created).toBe(1)
    expect(f.service()?.access()).toBeUndefined()
    closed.resolve()
    await Promise.all([off, on])
    expect(f.calls.indexOf("closed 1")).toBeLessThan(f.calls.indexOf("create 2"))
    expect(f.calls.indexOf("unlisten")).toBeLessThan(f.calls.indexOf("create 2"))
    await f.owner.dispose()
  })

  test("partial notifier acquisition releases its frontend listener and access", async () => {
    const f = fixture()
    f.rejectNotifier(true)
    await expect(f.select(true)).rejects.toThrow("notifier refused")
    expect(f.frontendListeners.size).toBe(0)
    expect(f.calls).toContain("closed 1")
    expect(f.calls).not.toContain("listen")
    await f.owner.dispose()
  })

  test("failed listener acquisition releases the access and notifier and permits a fresh enable", async () => {
    const f = fixture()
    f.reject(true)
    await expect(f.select(true)).rejects.toThrow("listener refused")
    expect(f.calls).toContain("notifier closed")
    expect(f.calls).toContain("closed 1")
    expect(f.frontendListeners.size).toBe(0)
    expect(f.service()?.access()).toBeUndefined()
    f.reject(false)
    await f.select(false)
    await f.select(true)
    expect(await f.service()?.ready()).toBeDefined()
    await f.owner.dispose()
  })
})
