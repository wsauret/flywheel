import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createAccountProjectRegistry } from "../../../../../src/orchestration/app-service/account-project-registry.js"
import { createAccountRelayService } from "../../../../../src/orchestration/modules/remote/account-relay-service.js"
import { createKeepAwake, NO_KEEP_AWAKE } from "../../../../../src/orchestration/modules/remote/keep-awake.js"
import { createAccountService } from "../../../../../src/orchestration/app-service/account-service.js"
import { createRemoteAccess, placementId, type RemoteAccess } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import * as control from "../../../../../src/orchestration/modules/remote/relay-control-channel.js"
import * as pairing from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js"
import { canonicalPathWithMissingTail } from "../../../../../src/infra/canonical-path.js"
import { createAccountProjectClone } from "../../../../../src/orchestration/app-service/account-project-clone.js"
import { ensureRemoteIdentity } from "../../../../../src/orchestration/modules/remote/remote-identity.js"
import { requestProjectCreation, type CreatedProject } from "../../../../../src/protocol/modules/remote/project-creation.js"
import { asKeyPair, fromBase64Url, keyDigest, ownedBytes, parsePairingCodeUrl, toBase64Url, type OpenFrame, type RuntimeControlFrame } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import { openPairingChannel, type DeviceIdentity } from "../../../../../src/protocol/modules/remote/relay-channel.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../../../helpers/owned-command-fake.js"
import { PendingRelaySocket, startRelayStub } from "./relay-stub.js"
import { decodeRemoteAccountAnswer, type RemoteAccountAnswer, type RemoteAccountRequest } from "../../../../../src/protocol/modules/remote/account-requests.js"
import { pairDevice } from "../../../../../src/protocol/modules/remote/relay-pairing.js"
import { machineName } from "../../../../../src/orchestration/modules/remote/remote-pairing-exchange.js"
import { deviceIdentity, sealDevice, text } from "./_remote-device-fixtures.js"

const temporary = temporaryDirectories()
/** No device ever asks these services to create a project. */
const NO_CLONE = { clone: async () => { throw new Error("no clone in this test") } }

/** Every answer the service gives `request` until it ends it. */
async function answersTo(service: ReturnType<typeof createAccountRelayService>, request: RemoteAccountRequest, withdrawn = new AbortController().signal): Promise<unknown[]> {
  const answers: unknown[] = []
  await service.serveRequest(request, async (answer) => { answers.push(answer) }, withdrawn)
  return answers
}

/** Account projects with nothing to open, for services that only pair. */
function idleProjects() {
  const projects = createAccountService<{ dispose(): Promise<void> }>({
    canonicalizeProjectRoot: canonicalPathWithMissingTail,
    recordTrustedAttach: async () => {},
    openProject: async () => ({ dispose: async () => {} }),
  })
  projects.openAdmission()
  return projects
}

/** `until` with the bound a real relay connection needs. */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(condition()).toBe(true)
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

describe("account relay service", () => {
  test.each(["claim", "startup"] as const)("reports a %s refusal to every joined phone over the machine control", async (stage) => {
    const root = realpathSync(temporary("flywheel-account-relay-refusal-"))
    const registry = createAccountProjectRegistry({ userDataRoot: root })
    const channels = new Map<string, { options: control.RelayControlChannelOptions; held: boolean }>()
    const terminal: RuntimeControlFrame[] = []
    const controls = spyOn(control, "createRelayControlChannel").mockImplementation((options) => {
      const label = (() => { try { return options.placement().projectLabel } catch { return "machine" } })()
      const channel = { options, held: false }
      channels.set(label, channel)
      return {
        send(frame) {
          if (!channel.held) return false
          if (label === "machine") terminal.push(frame)
          return true
        },
        channelOpened: () => () => {},
        connected: () => channel.held,
        reconcile() { channel.held = options.wanted() },
        async dispose() { channel.held = false },
      }
    })
    const store = spyOn(pairing, "readRemotePairingStore").mockImplementation(() => ({
      identity: undefined, vapid: undefined, relayUrl: undefined,
      devices: [{ id: "phone", publicKey: "key", pairedAt: 0, label: "Phone" }],
    }))
    const opening = Promise.withResolvers<void>()
    const prepared = Promise.withResolvers<void>()
    const inhibitor = Promise.withResolvers<void>()
    let claims = 0
    let terminated = 0
    const keepAwake = createKeepAwake({
      platform: "darwin",
      spawnOwned: async () => {
        await inhibitor.promise
        return {
          terminate: async () => {
            terminated += 1
            return { code: 0, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const }
          },
        }
      },
    })
    let service!: ReturnType<typeof createAccountRelayService>
    let openCalls = 0
    const projects = createAccountService<{ dispose(): Promise<void> }>({
      canonicalizeProjectRoot: canonicalPathWithMissingTail,
      recordTrustedAttach: async () => {},
      claimProject: stage === "claim" ? async () => {
        claims += 1
        await opening.promise
        return () => {}
      } : undefined,
      async openProject(projectRoot) {
        openCalls += 1
        await service.prepareProject(projectRoot)
        prepared.resolve()
        await opening.promise
        return { dispose: async () => {} }
      },
    })
    projects.openAdmission()
    try {
      await registry.record({ projectRoot: root, label: "Project" })
      service = createAccountRelayService({ userDataRoot: root, lane: "installed", version: "test", registry, projects, projectClone: NO_CLONE, keepAwake: stage === "claim" ? keepAwake : NO_KEEP_AWAKE })
      await until(() => channels.has("Project") && channels.get("machine")?.held === true)
      const dormant = channels.get("Project")!
      const initial: RuntimeControlFrame[] = []
      const wake = (channelId: string) => dormant.options.onOpen({ type: "open", channelId, ticket: channelId, kind: "device", deviceId: "phone" }, (frame) => {
        if (dormant.held) initial.push(frame)
      })
      const first = wake("first")
      const joined = wake("joined")
      await until(() => projects.state(root) === "opening")
      if (stage === "startup") {
        await prepared.promise
        expect(dormant.held).toBe(false)
      }
      opening.reject(new Error(stage === "claim" ? "project is open in the dev lane" : "project startup failed"))
      // A refusal reaches both phones even while the inhibitor is still starting.
      await until(() => terminal.length === 2)
      inhibitor.resolve()
      await Promise.all([first, joined])
      if (stage === "claim") await until(() => terminated === 1)
      expect(initial).toEqual([
        { type: "decline", channelId: "first", reason: "starting" },
        { type: "decline", channelId: "joined", reason: "starting" },
      ])
      expect(terminal).toEqual(expect.arrayContaining([
        { type: "decline", channelId: "first", reason: "start_failed" },
        { type: "decline", channelId: "joined", reason: "start_failed" },
      ]))
      expect(terminal).toHaveLength(2)
      expect(openCalls).toBe(stage === "claim" ? 0 : 1)
      expect(claims).toBe(stage === "claim" ? 1 : 0)
      expect(terminated).toBe(stage === "claim" ? 1 : 0)
    } finally {
      inhibitor.resolve()
      opening.resolve()
      await projects.dispose()
      await service?.dispose()
      await registry.dispose()
      controls.mockRestore()
      store.mockRestore()
    }
  })

  test("hands dormant ownership to the live project without overlapping controls or closing siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-account-relay-transfer-"))
    const sibling = join(root, "sibling")
    mkdirSync(sibling)
    const registry = createAccountProjectRegistry({ userDataRoot: root })
    const active = new Map<string, number>()
    let maximum = 0
    const controls = spyOn(control, "createRelayControlChannel").mockImplementation((options) => {
      let held = false
      // The machine placement reads the identity it waits for; only projects count here.
      const id = (() => { try { return options.placement().id } catch { return "machine" } })()
      const release = () => {
        if (!held) return
        held = false
        active.set(id, (active.get(id) ?? 0) - 1)
      }
      return {
        send: () => held, channelOpened: () => () => {}, connected: () => held,
        reconcile() {
          if (!options.wanted()) { release(); return }
          if (held) return
          held = true
          active.set(id, (active.get(id) ?? 0) + 1)
          maximum = Math.max(maximum, active.get(id)!)
        },
        async dispose() { release() },
      }
    })
    const store = spyOn(pairing, "readRemotePairingStore").mockImplementation(() => ({
      identity: undefined, vapid: undefined, relayUrl: undefined,
      devices: [{ id: "phone", publicKey: "key", pairedAt: 0, label: "Phone" }],
    }))
    let service!: ReturnType<typeof createAccountRelayService>
    const projects = createAccountService<RemoteAccess>({
      canonicalizeProjectRoot: canonicalPathWithMissingTail,
      recordTrustedAttach: async () => {},
      async openProject(projectRoot) {
        await service.prepareProject(projectRoot)
        return createRemoteAccess({ userDataRoot: root, projectRoot, accountHome: root, projectRegistry: registry, lane: "installed", version: "test", publish: () => {} })
      },
    })
    projects.openAdmission()
    try {
      await registry.record({ projectRoot: root, label: "Project" })
      await registry.record({ projectRoot: sibling, label: "Sibling" })
      service = createAccountRelayService({ userDataRoot: root, lane: "installed", version: "test", registry, projects, projectClone: NO_CLONE, keepAwake: NO_KEEP_AWAKE })
      const projectControls = () => [...active].filter(([id]) => id !== "machine").reduce((sum, [, count]) => sum + count, 0)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(projectControls()).toBe(2)
      // The machine placement stays announced whatever the projects do.
      expect(active.get("machine")).toBe(1)
      await projects.open(root)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(maximum).toBe(1)
      expect(projectControls()).toBe(2)
      await projects.close(root)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(maximum).toBe(1)
      expect(projectControls()).toBe(2)
      expect(active.get("machine")).toBe(1)
    } finally {
      await projects.dispose()
      await service?.dispose()
      await registry.dispose()
      controls.mockRestore()
      store.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("answers which projects a phone woke, and takes one keep-awake reference for a continued project that its close releases", async () => {
    // Canonical, as the account names every project root.
    const root = realpathSync(temporary("flywheel-account-relay-awake-"))
    const woken = join(root, "woken")
    const continued = join(root, "continued")
    mkdirSync(woken)
    mkdirSync(continued)
    const registry = createAccountProjectRegistry({ userDataRoot: root })
    const opens = new Map<string, control.RelayControlChannelOptions["onOpen"]>()
    const controls = spyOn(control, "createRelayControlChannel").mockImplementation((options) => {
      // The machine placement reads the identity it waits for; only projects count here.
      try { opens.set(options.placement().projectLabel, options.onOpen) } catch { /* the machine placement */ }
      return { send: () => false, channelOpened: () => () => {}, connected: () => false, reconcile() {}, async dispose() {} }
    })
    const store = spyOn(pairing, "readRemotePairingStore").mockImplementation(() => ({
      identity: undefined, vapid: undefined, relayUrl: undefined,
      devices: [{ id: "phone", publicKey: "key", pairedAt: 0, label: "Phone" }],
    }))
    const keepAwake = { holds: 0, releases: 0 }
    const projects = createAccountService<{ dispose(): Promise<void> }>({
      canonicalizeProjectRoot: canonicalPathWithMissingTail,
      recordTrustedAttach: async () => {},
      openProject: async () => ({ dispose: async () => {} }),
    })
    projects.openAdmission()
    const service = createAccountRelayService({
      userDataRoot: root, lane: "installed", version: "test", registry, projects,
      projectClone: NO_CLONE,
      keepAwake: { hold: async () => { keepAwake.holds += 1 }, release: async () => { keepAwake.releases += 1 } },
    })
    try {
      await registry.record({ projectRoot: woken, label: "Woken" })
      await registry.record({ projectRoot: continued, label: "Continued" })
      await until(() => opens.size === 2)
      // A phone wakes one project; the other opens for a successor's continuation.
      const wake: OpenFrame = { type: "open", channelId: "channel-1", ticket: "ticket-1", kind: "device", deviceId: "phone" }
      await opens.get("Woken")?.(wake, () => {})
      await projects.open(continued)
      expect(service.phoneKeepAwake.held(woken)).toBe(true)
      expect(service.phoneKeepAwake.held(continued)).toBe(false)

      await service.phoneKeepAwake.hold(continued)
      await service.phoneKeepAwake.hold(continued)
      expect(service.phoneKeepAwake.held(continued)).toBe(true)
      // One reference for the account, whichever projects share it.
      expect(keepAwake).toEqual({ holds: 1, releases: 0 })

      await projects.close(woken)
      await until(() => !service.phoneKeepAwake.held(woken))
      expect(keepAwake.releases).toBe(0)
      await projects.close(continued)
      await until(() => !service.phoneKeepAwake.held(continued))
      expect(keepAwake).toEqual({ holds: 1, releases: 1 })
    } finally {
      await projects.dispose()
      await service.dispose()
      await registry.dispose()
      controls.mockRestore()
      store.mockRestore()
    }
  })

  test("stays offline without a paired device", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-account-relay-"))
    try {
      mkdirSync(join(root, "auth"), { recursive: true })
      const registry = createAccountProjectRegistry({ userDataRoot: root })
      await registry.record({ projectRoot: root, label: "project" })
      let connections = 0
      const service = createAccountRelayService({
        userDataRoot: root,
        lane: "installed",
        version: "test",
        registry,
        projects: { open: async () => ({ dispose: async () => {} }), close: async () => {}, state: () => undefined, project: () => undefined, slots: () => new Map(), watch: () => () => {}, openAdmission: () => false, closeAdmission: () => {}, dispose: async () => {} },
        projectClone: NO_CLONE,
        keepAwake: NO_KEEP_AWAKE,
        connectWebSocket: () => { connections += 1; throw new Error("unexpected connection") },
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(connections).toBe(0)
      await service.dispose()
      await registry.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("comes online once a placement of this process pairs a device, with no file watch", async () => {
    const root = mkdtempSync(join(tmpdir(), "flywheel-account-relay-"))
    const registry = createAccountProjectRegistry({ userDataRoot: root })
    const dials: string[] = []
    const service = createAccountRelayService({
      userDataRoot: root,
      lane: "installed",
      version: "test",
      registry,
      projects: { open: async () => ({ dispose: async () => {} }), close: async () => {}, state: () => undefined, project: () => undefined, slots: () => new Map(), watch: () => () => {}, openAdmission: () => false, closeAdmission: () => {}, dispose: async () => {} },
      projectClone: NO_CLONE,
      keepAwake: NO_KEEP_AWAKE,
      connectWebSocket: (url) => { dials.push(url); return new PendingRelaySocket() },
    })
    const watch = spyOn(fs, "watch")
    try {
      await ensureRemoteIdentity(root, "installed")
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(dials).toEqual([])
      await pairing.mutateRemotePairingStore(root, "installed", (store) => {
        store.devices = [{ id: "phone", label: "Phone", publicKey: toBase64Url(new Uint8Array(32)), pairedAt: 0 }]
      })
      await until(() => dials.length > 0)
      expect(watch).not.toHaveBeenCalled()
    } finally {
      watch.mockRestore()
      await service.dispose()
      await registry.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a revocation that `flywheel remote` sends while another device stays paired tells every attached placement at once, and the revoked device's wake starts nothing", async () => {
    const root = realpathSync(temporary("flywheel-account-relay-revoke-"))
    const registry = createAccountProjectRegistry({ userDataRoot: root })
    const sent = new Map<string, RuntimeControlFrame[]>()
    const opens = new Map<string, control.RelayControlChannelOptions["onOpen"]>()
    const controls = spyOn(control, "createRelayControlChannel").mockImplementation((options) => {
      const label = (() => { try { return options.placement().projectLabel } catch { return "machine" } })()
      const frames: RuntimeControlFrame[] = []
      sent.set(label, frames)
      opens.set(label, options.onOpen)
      let held = false
      return {
        send(frame) { if (held) frames.push(frame); return held },
        channelOpened: () => () => {},
        connected: () => held,
        reconcile() { held = options.wanted() },
        async dispose() { held = false },
      }
    })
    const device = (id: string) => ({ id, label: id, publicKey: toBase64Url(new Uint8Array(32)), pairedAt: 0 })
    let opened = 0
    const projects = createAccountService<{ dispose(): Promise<void> }>({
      canonicalizeProjectRoot: canonicalPathWithMissingTail,
      recordTrustedAttach: async () => {},
      openProject: async () => { opened += 1; return { dispose: async () => {} } },
    })
    projects.openAdmission()
    let service: ReturnType<typeof createAccountRelayService> | undefined
    try {
      await pairing.mutateRemotePairingStore(root, "installed", (store) => { store.devices = [device("phone"), device("tablet")] })
      await registry.record({ projectRoot: root, label: "Project" })
      service = createAccountRelayService({ userDataRoot: root, lane: "installed", version: "test", registry, projects, projectClone: NO_CLONE, keepAwake: NO_KEEP_AWAKE })
      await until(() => sent.has("Project") && sent.has("machine"))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(await answersTo(service, { type: "remote.device.revoke", deviceId: "tablet" })).toEqual([{ type: "result", kind: "committed" }])
      expect(await answersTo(service, { type: "remote.device.revoke", deviceId: "tablet" })).toEqual([{ type: "result", kind: "rejected", message: "No paired device has the id tablet" }])
      expect(pairing.readRemotePairingStore(root, "installed").devices.map((paired) => paired.id)).toEqual(["phone"])
      await until(() => sent.get("machine")!.length > 0 && sent.get("Project")!.length > 0)
      expect(sent.get("machine")).toEqual([{ type: "devices", devices: ["phone"] }])
      expect(sent.get("Project")).toEqual([{ type: "devices", devices: ["phone"] }])

      const answers: RuntimeControlFrame[] = []
      await opens.get("Project")!({ type: "open", channelId: "wake", ticket: "wake", kind: "device", deviceId: "tablet" }, (frame) => answers.push(frame))
      expect(answers).toEqual([{ type: "decline", channelId: "wake", reason: "start_failed" }])
      expect(opened).toBe(0)
      expect(projects.state(root)).toBeUndefined()

      expect(await answersTo(service, { type: "remote.project.forget", projectRoot: root })).toEqual([{ type: "result", kind: "committed" }])
      expect(await registry.list()).toEqual([])
      expect(await answersTo(service, { type: "remote.project.forget", projectRoot: root })).toEqual([{ type: "result", kind: "rejected", message: `No project is recorded at ${root}` }])
    } finally {
      await projects.dispose()
      await service?.dispose()
      await registry.dispose()
      controls.mockRestore()
    }
  })

  test("a paired device creates a project by naming a repository: the machine clones it, opens it, and names its placement", async () => {
    const stub = startRelayStub()
    const home = realpathSync(temporary("flywheel-account-relay-create-"))
    const userDataRoot = join(home, ".flywheel")
    const projectsRoot = join(home, "flywheel-projects")
    const pair = asKeyPair(await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
    const device: DeviceIdentity = { deviceId: await keyDigest(publicKey), publicKey, sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, ownedBytes(bytes))) }
    const identity = await ensureRemoteIdentity(userDataRoot, "installed")
    await pairing.mutateRemotePairingStore(userDataRoot, "installed", (store) => {
      store.relayUrl = stub.url
      store.devices = [{ id: device.deviceId, label: "Laptop", publicKey: toBase64Url(publicKey), pairedAt: 0 }]
    })
    const registry = createAccountProjectRegistry({ userDataRoot })
    const git = fakeOwnedCommandRunner(async (command) => {
      mkdirSync(join(command.at(-1) ?? "", ".git"), { recursive: true })
      return ownedCommandResult()
    })
    const projectClone = createAccountProjectClone({ projectsRoot, registry, run: git.run, searchPath: () => undefined })
    const opened: string[] = []
    const projects = createAccountService<{ dispose(): Promise<void> }>({
      canonicalizeProjectRoot: canonicalPathWithMissingTail,
      recordTrustedAttach: async () => {},
      openProject: async (projectRoot) => { opened.push(projectRoot); return { dispose: async () => {} } },
    })
    projects.openAdmission()
    const service = createAccountRelayService({ userDataRoot, lane: "installed", version: "test", registry, projects, projectClone, keepAwake: NO_KEEP_AWAKE })
    try {
      // A machine with no project yet still offers to create one, under the machine's name.
      await until(() => stub.placements(identity.runtimeId).some((placement) => placement.id === identity.runtimeId))
      expect(stub.placements(identity.runtimeId)).toEqual([expect.objectContaining({ id: identity.runtimeId, projectLabel: machineName("installed"), state: "live" })])
      const opening: CreatedProject[] = []
      const created = await requestProjectCreation({
        relay: stub.url, runtimeId: identity.runtimeId, runtimePublicKey: toBase64Url(identity.publicKey), device, repository: "owner/tool",
        onOpening: (project) => { opening.push(project) },
      })
      const projectRoot = join(projectsRoot, "tool")
      expect(created).toEqual({ placementId: placementId(projectRoot), projectLabel: "tool" })
      expect(opening).toEqual([created])
      expect(git.calls.map((call) => call.command.slice(-2))).toEqual([["https://github.com/owner/tool.git", projectRoot]])
      expect(opened).toEqual([projectRoot])
      expect((await registry.list()).map((project) => project.projectRoot)).toEqual([projectRoot])
      // Nothing the device and the machine said crossed the relay in the clear.
      const pumped = new TextDecoder().decode(Buffer.concat(stub.pumped))
      expect(pumped).not.toContain("owner/tool")

      // A repository the machine refuses comes back as the machine's reason.
      expect(String(await requestProjectCreation({
        relay: stub.url, runtimeId: identity.runtimeId, runtimePublicKey: toBase64Url(identity.publicKey), device, repository: "/home/person/secret",
        onOpening: () => {},
      }).catch((error: unknown) => error))).toContain("Name a repository as owner/repo")
      expect(git.calls).toHaveLength(1)

      // A revocation the relay has not heard yet: the store decides at the open.
      const read = pairing.readRemotePairingStore
      const revoked = spyOn(pairing, "readRemotePairingStore").mockImplementation((root, lane) => ({ ...read(root, lane), devices: [] }))
      try {
        expect(await requestProjectCreation({
          relay: stub.url, runtimeId: identity.runtimeId, runtimePublicKey: toBase64Url(identity.publicKey), device, repository: "owner/other",
          onOpening: () => {},
        }).then(() => "resolved", () => "refused")).toBe("refused")
      } finally { revoked.mockRestore() }
      expect(git.calls).toHaveLength(1)
      expect(opened).toEqual([projectRoot])
    } finally {
      await service.dispose()
      await projectClone.dispose()
      await projects.dispose()
      await registry.dispose()
      stub.stop()
    }
  })

  test("pairs a device through the machine placement on the relay `flywheel remote pair` names, which the store keeps, and closes a window its request leaves", async () => {
    const stub = startRelayStub()
    const home = realpathSync(temporary("flywheel-account-relay-pair-"))
    const userDataRoot = join(home, ".flywheel")
    const registry = createAccountProjectRegistry({ userDataRoot })
    const projects = createAccountService<{ dispose(): Promise<void> }>({
      canonicalizeProjectRoot: canonicalPathWithMissingTail,
      recordTrustedAttach: async () => {},
      openProject: async () => ({ dispose: async () => {} }),
    })
    projects.openAdmission()
    const service = createAccountRelayService({ userDataRoot, lane: "installed", version: "test", registry, projects, projectClone: NO_CLONE, keepAwake: NO_KEEP_AWAKE })
    try {
      const answers: RemoteAccountAnswer[] = []
      const paired = service.serveRequest({ type: "remote.pair.open", relayUrl: stub.url }, async (answer) => { answers.push(decodeRemoteAccountAnswer(answer)) }, new AbortController().signal)
      await waitUntil(() => answers.some((answer) => answer.type === "relay" && answer.connection === "connected"))
      const window = answers.find((answer) => answer.type === "pairing")
      if (window?.type !== "pairing") throw new Error("the service showed no pairing code")
      const pair = asKeyPair(await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
      const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
      const runtime = await pairDevice(window.code, { publicKey, label: "Phone", sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, ownedBytes(bytes))) })
      await paired

      expect(answers.at(-1)).toEqual({ type: "paired", label: "Phone" })
      expect(runtime.label).toBe(machineName("installed"))
      const store = pairing.readRemotePairingStore(userDataRoot, "installed")
      expect(store.relayUrl).toBe(stub.url)
      expect(store.devices.map((device) => device.label)).toEqual(["Phone"])
      expect(stub.pairingWindows.size).toBe(0)

      const left = new AbortController()
      const again: RemoteAccountAnswer[] = []
      const leaving = service.serveRequest({ type: "remote.pair.open" }, async (answer) => { again.push(decodeRemoteAccountAnswer(answer)) }, left.signal)
      await waitUntil(() => stub.pairingWindows.size === 1)
      left.abort()
      await leaving
      await waitUntil(() => stub.pairingWindows.size === 0)
      expect(again.map((answer) => answer.type)).toEqual(["pairing", "relay"])
      await expect(answersTo(service, { type: "remote.pair.open", relayUrl: "relay.example.test" })).rejects.toThrow("The relay must be a ws:// or wss:// URL, not relay.example.test")
    } finally {
      await service.dispose()
      await projects.dispose()
      await registry.dispose()
      stub.stop()
    }
  })

  test("a device whose window is withdrawn during its exchange learns at once, and the machine records nothing", async () => {
    const stub = startRelayStub()
    const userDataRoot = join(realpathSync(temporary("flywheel-account-relay-withdraw-")), ".flywheel")
    const registry = createAccountProjectRegistry({ userDataRoot })
    const projects = idleProjects()
    const service = createAccountRelayService({ userDataRoot, lane: "installed", version: "test", registry, projects, projectClone: NO_CLONE, keepAwake: NO_KEEP_AWAKE })
    try {
      const left = new AbortController()
      const answers: RemoteAccountAnswer[] = []
      const request = service.serveRequest({ type: "remote.pair.open", relayUrl: stub.url }, async (answer) => { answers.push(decodeRemoteAccountAnswer(answer)) }, left.signal)
      await waitUntil(() => answers.some((answer) => answer.type === "relay" && answer.connection === "connected"))
      const window = answers.find((answer) => answer.type === "pairing")
      if (window?.type !== "pairing") throw new Error("the service showed no pairing code")
      const identity = await deviceIdentity()
      // The person leaves `flywheel remote pair` after the handshake, while the
      // device writes its request. The machine closes the channel unanswered.
      const device = { publicKey: identity.publicKey, sign: identity.sign, get label() { left.abort(); return "Phone" } }
      expect(String(await pairDevice(window.code, device).catch((error: unknown) => error))).toContain("The connection to the machine ended before it answered.")
      await request
      expect(pairing.readRemotePairingStore(userDataRoot, "installed").devices).toEqual([])
    } finally {
      await service.dispose()
      await projects.dispose()
      await registry.dispose()
      stub.stop()
    }
  })

  // A device that never hangs up must not make the stop wait out the
  // exchange's bound. A device that leaves right after its request ends the
  // machine's channel before the answer goes out, and that answer must not
  // wait for a next run of the channel, which never comes.
  test.each(["keeps its channel open after it paired", "leaves right after its request"] as const)("a device that %s is recorded and does not hold the service's stop", async (behavior) => {
    const stub = startRelayStub()
    const userDataRoot = join(realpathSync(temporary("flywheel-account-relay-linger-")), ".flywheel")
    const registry = createAccountProjectRegistry({ userDataRoot })
    const projects = idleProjects()
    const service = createAccountRelayService({ userDataRoot, lane: "installed", version: "test", registry, projects, projectClone: NO_CLONE, keepAwake: NO_KEEP_AWAKE })
    let channel: Awaited<ReturnType<typeof sealDevice>> | undefined
    try {
      const answers: RemoteAccountAnswer[] = []
      const request = service.serveRequest({ type: "remote.pair.open", relayUrl: stub.url }, async (answer) => { answers.push(decodeRemoteAccountAnswer(answer)) }, new AbortController().signal)
      await waitUntil(() => answers.some((answer) => answer.type === "relay" && answer.connection === "connected"))
      const window = answers.find((answer) => answer.type === "pairing")
      if (window?.type !== "pairing") throw new Error("the service showed no pairing code")
      const code = parsePairingCodeUrl(window.code)
      const identity = await deviceIdentity()
      channel = await sealDevice(await openPairingChannel(stub.url, await keyDigest(fromBase64Url(code.publicKey)), code.windowId), identity, { kind: "pairing", secret: fromBase64Url(code.secret) })
      await Effect.runPromise(channel.established)
      await Effect.runPromise(channel.write(text(JSON.stringify({ type: "pair.request", label: "Phone" }))))
      if (behavior === "leaves right after its request") await channel.close()
      await request
      const accepted = channel
      if (behavior === "keeps its channel open after it paired") await waitUntil(() => accepted.received.length === 1)
      expect(answers.at(-1)).toEqual({ type: "paired", label: "Phone" })
      expect(pairing.readRemotePairingStore(userDataRoot, "installed").devices.map((device) => device.id)).toEqual([identity.id])

      let stopped = false
      void service.dispose().then(() => { stopped = true })
      await waitUntil(() => stopped)
    } finally {
      await channel?.close()
      await service.dispose()
      await projects.dispose()
      await registry.dispose()
      stub.stop()
    }
  })

  test("a service that stops ends each request waiting on its window, and a request through another relay than the open window's is refused", async () => {
    const userDataRoot = join(realpathSync(temporary("flywheel-account-relay-stop-")), ".flywheel")
    const registry = createAccountProjectRegistry({ userDataRoot })
    const projects = idleProjects()
    const service = createAccountRelayService({ userDataRoot, lane: "installed", version: "test", registry, projects, projectClone: NO_CLONE, keepAwake: NO_KEEP_AWAKE, connectWebSocket: () => new PendingRelaySocket() })
    try {
      const first: RemoteAccountAnswer[] = []
      const joined: RemoteAccountAnswer[] = []
      const waiting = service.serveRequest({ type: "remote.pair.open", relayUrl: "wss://one.example.test" }, async (answer) => { first.push(decodeRemoteAccountAnswer(answer)) }, new AbortController().signal)
      await waitUntil(() => first.some((answer) => answer.type === "pairing"))
      await expect(answersTo(service, { type: "remote.pair.open", relayUrl: "wss://two.example.test" })).rejects.toThrow("A pairing window through wss://one.example.test is already open.")
      const joining = service.serveRequest({ type: "remote.pair.open" }, async (answer) => { joined.push(decodeRemoteAccountAnswer(answer)) }, new AbortController().signal)
      await waitUntil(() => joined.some((answer) => answer.type === "pairing"))
      expect(joined.find((answer) => answer.type === "pairing")).toEqual(first.find((answer) => answer.type === "pairing"))

      await service.dispose()
      await Promise.all([waiting, joining])
      expect(first.at(-1)).toEqual({ type: "stopped" })
      expect(joined.at(-1)).toEqual({ type: "stopped" })
      expect(await answersTo(service, { type: "remote.pair.open" })).toEqual([{ type: "stopped" }])
    } finally {
      await service.dispose()
      await projects.dispose()
      await registry.dispose()
    }
  })
})
