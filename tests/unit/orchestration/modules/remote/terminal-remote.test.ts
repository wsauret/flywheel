import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"

import { createAccountProjectRegistry } from "../../../../../src/orchestration/app-service/account-project-registry.js"
import { runMachines } from "../../../../../src/orchestration/modules/remote/cli/machines.js"
import { createRemoteAccess, type RemoteAccess } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import { openTerminalDeviceStore } from "../../../../../src/orchestration/modules/remote/terminal-device-store.js"
import { pickerView, terminalRemote } from "../../../../../src/orchestration/modules/remote/terminal-remote.js"
import type { ReleaseSide } from "../../../../../src/infra/update/release-fit.js"
import type { TerminalRemoteChoice } from "../../../../../src/orchestration/terminal-remote.js"
import * as channel from "../../../../../src/protocol/modules/remote/relay-channel.js"
import * as creating from "../../../../../src/protocol/modules/remote/project-creation.js"
import { machinePlacementId } from "../../../../../src/protocol/modules/remote/project-creation.js"
import type { Placement } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../../../src/protocol/runtime-liveness.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { startRelayStub, type RelayStub } from "./relay-stub.js"

/** A terminal on another machine pairs with the machine from the link that
 *  `flywheel remote pair` shows there, and opens one of its projects through
 *  the relay (PI-REMOTE-016). The machine is a real remote access service
 *  against an in-process relay; the terminal is the remote module's terminal
 *  host over its own account directory. */

const temporary = temporaryDirectories()
const terminalRelease = { version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION }

describe("a terminal paired with a remote machine", () => {
  let stub: RelayStub
  let machine: RemoteAccess
  let registry: ReturnType<typeof createAccountProjectRegistry>
  let laptop: string
  let projectRoot: string
  let machineData: string

  /** The machine's remote access, serving its project at `version`. */
  function startMachine(version = "test"): RemoteAccess {
    return createRemoteAccess({ projectRegistry: registry, userDataRoot: machineData, lane: "installed", accountHome: "/account", projectRoot, version, publish: () => {}, relayUrl: stub.url, appOrigin: "https://remote.example.test" })
  }

  async function connected(access: RemoteAccess): Promise<void> {
    if (access.view().connection === "connected") return
    await new Promise<void>((resolve) => {
      const stop = access.onChange((view) => { if (view.connection === "connected") { stop(); resolve() } })
    })
  }

  beforeEach(() => {
    stub = startRelayStub()
    machineData = temporary("fw-machine-")
    projectRoot = temporary("fw-project-")
    laptop = join(temporary("fw-laptop-"), ".flywheel")
    registry = createAccountProjectRegistry({ userDataRoot: machineData })
    machine = startMachine()
  })

  afterEach(async () => {
    await machine.dispose()
    await registry.dispose()
    stub.stop()
  })

  /** Opens a pairing window and waits until the relay holds it. */
  async function machineCode(): Promise<string> {
    const window = await machine.openPairing()
    await connected(machine)
    return window.code
  }

  async function choose(answers: string[], printed: string[] = [], terminal: ReleaseSide = terminalRelease): Promise<TerminalRemoteChoice> {
    return await terminalRemote.choose({
      userDataRoot: laptop,
      terminal,
      prompt: async (question) => { printed.push(question); return answers.shift() ?? "" },
      print: (line) => { printed.push(line) },
    })
  }

  test("pairs from the full link pasted at the picker, lists the machine's project, and opens it", async () => {
    const link = await machineCode()
    const printed: string[] = []
    const choice = await choose([link, "1"], printed)
    if (choice.kind !== "attach") throw new Error(`expected an attach, got ${choice.kind}`)
    try {
      expect(printed[0]).toStartWith("This terminal is not paired with a machine.")
      expect(printed).toContain(`Paired with ${choice.attach.machine}.`)
      expect(printed).toContain(`    1. ${choice.attach.project} (open)`)
      expect(choice.attach.release).toEqual({ version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION })
      // The machine records this terminal under its host name, and the
      // terminal remembers the project it opened.
      const store = await openTerminalDeviceStore(laptop)
      expect(machine.view().devices.map((device) => device.label)).toEqual([store.label()])
      expect(await store.selection()).toEqual({ runtimeId: choice.attach.runtimeId, placementId: choice.attach.placementId })
    } finally {
      choice.attach.close()
    }
  })

  test("pairs with `remote machines add` from the part after #, lists it, and opens the project last opened on Enter", async () => {
    const fragment = (await machineCode()).split("#")[1] ?? ""
    const lines: string[] = []
    const io = { log: (line: string) => { lines.push(line) }, error: (line: string) => { lines.push(line) } }
    const directories = { userDataRoot: laptop, accountHome: join(laptop, ".."), projectRoot: laptop, executionCwd: laptop }
    await runMachines(["add", fragment], directories, io)
    expect(lines.at(-1)).toMatch(/^Paired with .+\. Run `flywheel --remote` to open one of its projects\.$/)
    lines.length = 0
    await runMachines([], directories, io)
    expect(lines.some((line) => /^ {4}1\. .+ \(open\)$/.test(line))).toBe(true)
    const first = await choose(["1"])
    if (first.kind !== "attach") throw new Error("expected an attach")
    first.attach.close()
    const printed: string[] = []
    const again = await choose([""], printed)
    if (again.kind !== "attach") throw new Error("expected an attach")
    again.attach.close()
    expect(again.attach.placementId).toBe(first.attach.placementId)
    expect(printed.some((line) => line.includes(", opened last"))).toBe(true)
  })

  test("with no paired machine offering a project, Enter checks again and lists the machine once it is back", async () => {
    const fragment = (await machineCode()).split("#")[1] ?? ""
    const directories = { userDataRoot: laptop, accountHome: join(laptop, ".."), projectRoot: laptop, executionCwd: laptop }
    await runMachines(["add", fragment], directories, { log: () => {}, error: () => {} })
    await machine.dispose()
    const questions: string[] = []
    const choice = await terminalRemote.choose({
      userDataRoot: laptop,
      terminal: terminalRelease,
      prompt: async (question) => {
        questions.push(question)
        if (question.startsWith("Choose a project")) return "1"
        // A person answers a moment later; the relay's news arrives meanwhile.
        if (questions.length > 1) return await new Promise<string>((resolve) => setTimeout(() => resolve(""), 10))
        // The machine comes back while the person reads the prompt.
        machine = startMachine()
        await connected(machine)
        return ""
      },
      print: () => {},
    })
    if (choice.kind !== "attach") throw new Error(`expected an attach, got ${choice.kind}`)
    choice.attach.close()
    expect(questions[0]).toBe("No paired machine offers a project now. Press Enter to check again, or paste a pairing link: ")
    expect(questions.at(-1)).toStartWith("Choose a project [1-1]")
  })

  test("a machine on a later release has the terminal install that release, handing the project to the build it becomes", async () => {
    await machine.dispose()
    machine = startMachine("0.3.0")
    const link = await machineCode()
    const choice = await choose([link, "1"], [], { version: "0.2.0", protocolVersion: RUNTIME_PROTOCOL_VERSION })
    if (choice.kind !== "install") throw new Error(`expected an install, got ${choice.kind}`)
    const store = await openTerminalDeviceStore(laptop)
    const selection = await store.selection()
    expect(choice).toEqual({ kind: "install", version: "0.3.0", machine: (await store.runtimes())[0]!.label, handoff: `${selection?.runtimeId}.${selection?.placementId}` })
  })

  test("a machine on an earlier release keeps the terminal waiting until the machine runs the terminal's release, then opens the project", async () => {
    await machine.dispose()
    machine = startMachine("0.1.0")
    const link = await machineCode()
    const printed: string[] = []
    const waiting = Promise.withResolvers<void>()
    const choice = terminalRemote.choose({
      userDataRoot: laptop,
      terminal: { version: "0.2.0", protocolVersion: RUNTIME_PROTOCOL_VERSION },
      prompt: async (question) => { printed.push(question); return printed.length === 1 ? link : "1" },
      print: (line) => {
        printed.push(line)
        if (line.includes("an earlier release than this terminal's 0.2.0")) waiting.resolve()
      },
    })
    await waiting.promise
    // The machine updates while the terminal waits.
    await machine.dispose()
    machine = startMachine("0.2.0")
    await connected(machine)
    const opened = await choice
    if (opened.kind !== "attach") throw new Error(`expected an attach, got ${opened.kind}`)
    opened.attach.close()
    expect(opened.attach.release.version).toBe("0.2.0")
    expect(printed.filter((line) => line.includes("an earlier release"))).toHaveLength(1)
  })

  test("a terminal from source that speaks an earlier protocol says so and opens nothing", async () => {
    const link = await machineCode()
    expect(String(await choose([link, "1"], [], { version: undefined, protocolVersion: RUNTIME_PROTOCOL_VERSION - 1 }).catch((error: unknown) => error))).toContain("this terminal runs Flywheel from source")
  })

  test("an empty answer with no project opened before ends the prompt without a choice", async () => {
    await machineCode()
    expect(await choose([""])).toEqual({ kind: "cancelled" })
  })
})

describe("creating a project on a paired machine from the terminal", () => {
  const runtimeId = "machine"
  const machinePlacement: Placement = { id: machinePlacementId(runtimeId), projectLabel: "box", version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "live" }
  const project: Placement = { id: "project", projectLabel: "flywheel", version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "live" }
  const restores: (() => void)[] = []
  let laptop: string
  /** Reports the machine's placements to the terminal, as the relay does. */
  let report: (placements: readonly Placement[]) => void

  beforeEach(async () => {
    laptop = join(temporary("fw-laptop-"), ".flywheel")
    const store = await openTerminalDeviceStore(laptop, "laptop")
    await store.putRuntime({ runtimeId, publicKey: "AA", relay: "wss://relay.example.test", label: "box", pairedAt: 0 })
    // The terminal opened a project before, so the picker remembers one.
    await store.setSelection({ runtimeId, placementId: project.id })
    const watch = spyOn(channel, "watchPresence").mockImplementation((_relay, _runtime, _device, onPlacements) => {
      report = onPlacements
      queueMicrotask(() => onPlacements([machinePlacement, project]))
      return { close() {} }
    })
    restores.push(() => watch.mockRestore())
  })

  afterEach(() => {
    for (const restore of restores.splice(0)) restore()
  })

  async function choose(answers: string[], printed: string[]): Promise<TerminalRemoteChoice> {
    return await terminalRemote.choose({
      userDataRoot: laptop,
      terminal: terminalRelease,
      prompt: async (question) => { printed.push(question); return answers.shift() ?? "" },
      print: (line) => { printed.push(line) },
    })
  }

  test("names a repository, shows the clone and the start as the phone does, and opens the new project once the machine reports it open", async () => {
    const created: Placement = { id: "created", projectLabel: "tool", version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "live" }
    const request = spyOn(creating, "requestProjectCreation").mockImplementation(async (asked) => {
      asked.onOpening({ placementId: created.id, projectLabel: created.projectLabel })
      // The machine opens the project, and presence lists it a moment later.
      setTimeout(() => report([machinePlacement, project, created]), 5)
      return { placementId: created.id, projectLabel: created.projectLabel }
    })
    restores.push(() => request.mockRestore())
    const printed: string[] = []
    const choice = await choose(["2", " owner/tool "], printed)
    if (choice.kind !== "attach") throw new Error(`expected an attach, got ${choice.kind}`)
    choice.attach.close()
    expect(printed.slice(0, 5)).toEqual([
      "Projects on paired machines:",
      "  box:",
      "    1. flywheel (open), opened last",
      "    2. New project from repository",
      "Choose a project [1-2], press Enter for flywheel on box, or paste a pairing link: ",
    ])
    expect(printed.slice(5)).toEqual([
      "Repository to clone on box (owner/repo or a git URL), or press Enter to go back: ",
      "owner/tool: Cloning on the machine... Press Ctrl+C to stop.",
      "tool: Cloned. Starting Flywheel on the machine... Press Ctrl+C to stop.",
    ])
    expect(request.mock.calls[0]?.[0]).toMatchObject({ runtimeId, repository: "owner/tool" })
    expect(choice.attach).toMatchObject({ runtimeId, placementId: "created", project: "tool", machine: "box" })
    expect(await (await openTerminalDeviceStore(laptop)).selection()).toEqual({ runtimeId, placementId: "created" })
  })

  test("with no project opened before, the new project is starting on the load screen until its machine opens it", async () => {
    await (await openTerminalDeviceStore(laptop)).setSelection(undefined)
    const created: Placement = { id: "created", projectLabel: "tool", version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "dormant" }
    const request = spyOn(creating, "requestProjectCreation").mockImplementation(async () => {
      setTimeout(() => report([machinePlacement, project, created]), 5)
      return { placementId: created.id, projectLabel: created.projectLabel }
    })
    restores.push(() => request.mockRestore())
    const printed: string[] = []
    const choice = await choose(["2", "owner/tool"], printed)
    if (choice.kind !== "attach") throw new Error(`expected an attach, got ${choice.kind}`)
    expect(choice.attach).toMatchObject({ placementId: "created", project: "tool" })
    expect(printed.some((line) => line.startsWith("Waiting for"))).toBe(false)
    const runtime = choice.attach.connect(() => {})
    const startup: unknown[] = []
    const release = runtime.subscribe((event) => { if (event.type === "runtime.startup") startup.push(event.status) })
    // The attach waits for the project to report open; a presence report
    // meanwhile says it is starting.
    report([machinePlacement, project, created])
    expect(startup).toEqual([{ kind: "phase", label: "Starting Flywheel for tool on box" }])
    release()
    await runtime.close()
  })

  test("a creation the machine refuses shows its reason under the machine, and the picker asks again", async () => {
    const request = spyOn(creating, "requestProjectCreation").mockRejectedValue(new Error("The machine could not read owner/private."))
    restores.push(() => request.mockRestore())
    const printed: string[] = []
    const choice = await choose(["2", "owner/private", "1"], printed)
    if (choice.kind !== "attach") throw new Error(`expected an attach, got ${choice.kind}`)
    choice.attach.close()
    const redrawn = printed.slice(printed.indexOf("Repository to clone on box (owner/repo or a git URL), or press Enter to go back: ") + 1)
    expect(redrawn).toEqual([
      "owner/private: Cloning on the machine... Press Ctrl+C to stop.",
      "Projects on paired machines:",
      "  box:",
      "    1. flywheel (open), opened last",
      "    owner/private: The machine could not read owner/private.",
      "    2. New project from repository",
      "Choose a project [1-2], press Enter for flywheel on box, or paste a pairing link: ",
    ])
    expect(choice.attach.placementId).toBe(project.id)
  })

  test("an empty repository goes back to the picker and asks the machine nothing", async () => {
    const request = spyOn(creating, "requestProjectCreation")
    restores.push(() => request.mockRestore())
    const printed: string[] = []
    const choice = await choose(["2", "", "1"], printed)
    if (choice.kind !== "attach") throw new Error(`expected an attach, got ${choice.kind}`)
    choice.attach.close()
    expect(request).not.toHaveBeenCalled()
    expect(printed).toContain("Repository to clone on box (owner/repo or a git URL), or press Enter to go back: ")
    expect(printed.filter((line) => line === "Projects on paired machines:")).toHaveLength(2)
  })
})

describe("the terminal picker", () => {
  test("lists a machine's projects but never its machine placement, which it offers as a new project from a repository", () => {
    const runtimeId = "machine-1"
    const project = { id: "placement-1", projectLabel: "flywheel", version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "live" as const }
    const machinePlacement = { id: machinePlacementId(runtimeId), projectLabel: "box", version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "live" as const }
    const view = pickerView({ deviceLabel: "laptop", runtimes: [{ runtimeId, label: "box", relay: "https://relay.example.test", placements: [machinePlacement, project], presence: "online" }], selected: undefined, pairing: { status: "idle" } })
    expect(view.lines).toEqual(["  box:", "    1. flywheel (open)", "    2. New project from repository"])
    expect(view.choices).toEqual([
      { kind: "project", selection: { runtimeId, placementId: "placement-1" }, name: "flywheel on box" },
      { kind: "create", runtimeId, machine: "box" },
    ])
  })

  test("a machine that does not offer creation lists no new project", () => {
    const project = { id: "placement-1", projectLabel: "flywheel", version: "test", protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "live" as const }
    const view = pickerView({ deviceLabel: "laptop", runtimes: [{ runtimeId: "machine-1", label: "box", relay: "https://relay.example.test", placements: [project], presence: "online" }], selected: undefined, pairing: { status: "idle" } })
    expect(view.lines).toEqual(["  box:", "    1. flywheel (open)"])
  })
})
