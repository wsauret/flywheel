import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mutateRemotePairingStore, type PairedDevice } from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js"
import { createAccountProjectRegistry } from "../../../../../src/orchestration/app-service/account-project-registry.js"
import type { NotificationEpisodeInput } from "../../../../../src/infra/notification-episode.js"
import { createRemoteAccess, type RemoteAccess } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import { PendingRelaySocket, startRelayStub, type RelayStub } from "./relay-stub.js"
import { pairDevice, pairedNotices, viewWhere } from "./_remote-device-fixtures.js"

/** A device that reaches the account's pairing store raises one "Remote
 *  device paired" warning in every project that is open at that moment. */
describe("the paired-device notice", () => {
  let stub: RelayStub
  let userDataRoot: string
  let projectRoot: string
  const notifications: NotificationEpisodeInput[] = []
  const remotes: RemoteAccess[] = []
  const registries: ReturnType<typeof createAccountProjectRegistry>[] = []

  const createRemote = (overrides: Partial<Parameters<typeof createRemoteAccess>[0]> = {}) => {
    const projectRegistry = createAccountProjectRegistry({ userDataRoot })
    registries.push(projectRegistry)
    const remote = createRemoteAccess({
      projectRegistry, userDataRoot, lane: "installed", accountHome: "/account", projectRoot, version: "test",
      publish: () => {}, notify: (operation) => { notifications.push(operation) },
      relayUrl: stub.url, appOrigin: "https://remote.example.test",
      ...overrides,
    })
    remotes.push(remote)
    return remote
  }

  beforeEach(() => {
    stub = startRelayStub()
    userDataRoot = mkdtempSync(join(tmpdir(), "flywheel-remote-user-"))
    projectRoot = mkdtempSync(join(tmpdir(), "flywheel-remote-project-"))
    notifications.length = 0
  })

  afterEach(async () => {
    for (const remote of remotes.splice(0)) await remote.dispose()
    for (const registry of registries.splice(0)) await registry.dispose()
    stub.stop()
    rmSync(userDataRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  const phone = (id: string): PairedDevice => ({ id, label: `Phone ${id}`, publicKey: "AAAA", pairedAt: 1 })
  /** Writes a device as the account's relay service does when `flywheel
   *  remote pair` or the terminal remote pairs one: through the store, with
   *  no call into any project's remote access. */
  const writeDevice = (device: PairedDevice) => mutateRemotePairingStore(userDataRoot, "installed", (store) => {
    store.devices = [...store.devices, device]
  })
  /** Waits until `remote` has read the store once: any entry point that
   *  needs the devices loads it first, and forgetting no project changes nothing. */
  const loaded = (remote: RemoteAccess) => remote.forgetProject("none")
  /** Renames `deviceId` in the store and waits until `remote` shows it. Every
   *  reload raises its notices when it reads, so once a read of this write is
   *  shown, no earlier write can still raise one. */
  async function settled(remote: RemoteAccess, deviceId: string): Promise<void> {
    const label = `settled ${crypto.randomUUID()}`
    await mutateRemotePairingStore(userDataRoot, "installed", (store) => {
      store.devices = store.devices.map((device) => device.id === deviceId ? { ...device, label } : device)
    })
    await viewWhere(remote, (view) => view.devices.some((device) => device.label === label))
  }

  test("a device that the account relay service writes to the pairing store raises one 'Remote device paired' warning in an open project", async () => {
    const remote = createRemote({ connectWebSocket: () => new PendingRelaySocket() })
    await loaded(remote)
    await writeDevice(phone("phone-a"))
    await viewWhere(remote, (view) => view.devices.length === 1)
    await settled(remote, "phone-a")
    expect(pairedNotices(notifications)).toEqual([{ sourceId: "remote.paired.phone-a", title: "Remote device paired", message: `Phone phone-a can now open this account's projects through ${stub.url}.`, severity: "warning", action: { kind: "open-settings" } }])
  })

  test("a pairing through the project's own window raises exactly one", async () => {
    const remote = createRemote()
    const { device } = await pairDevice(stub.url, remote)
    await viewWhere(remote, (view) => view.devices.length === 1)
    await settled(remote, device.id)
    expect(pairedNotices(notifications).map((notice) => notice.sourceId)).toEqual([`remote.paired.${device.id}`])
  })

  test("starting with two paired devices raises none", async () => {
    await writeDevice(phone("phone-a"))
    await writeDevice(phone("phone-b"))
    const remote = createRemote({ connectWebSocket: () => new PendingRelaySocket() })
    await viewWhere(remote, (view) => view.devices.length === 2)
    await settled(remote, "phone-a")
    expect(pairedNotices(notifications)).toEqual([])
  })

  test("with two open projects, one pairing raises one warning in each project's list", async () => {
    const otherProject = join(projectRoot, "other")
    const lists: NotificationEpisodeInput[][] = [[], []]
    const placements = lists.map((list, index) => createRemote({
      projectRoot: index === 0 ? projectRoot : otherProject,
      connectWebSocket: () => new PendingRelaySocket(),
      notify: (operation) => { list.push(operation) },
    }))
    for (const placement of placements) await loaded(placement)
    await writeDevice(phone("phone-a"))
    for (const placement of placements) await settled(placement, "phone-a")
    expect(lists.map((list) => pairedNotices(list).map((notice) => notice.sourceId))).toEqual([["remote.paired.phone-a"], ["remote.paired.phone-a"]])
  })

  test("a device paired while no project was open raises no warning when the project opens", async () => {
    const closed = createRemote({ connectWebSocket: () => new PendingRelaySocket() })
    await loaded(closed)
    await closed.dispose()
    await writeDevice(phone("phone-a"))
    const remote = createRemote({ connectWebSocket: () => new PendingRelaySocket() })
    await viewWhere(remote, (view) => view.devices.length === 1)
    await settled(remote, "phone-a")
    expect(pairedNotices(notifications)).toEqual([])
  })
})
