import { releaseFit } from "../../../infra/update/release-fit.js"
import type { FrontendEvent, RuntimeStartupStatus } from "../../../protocol/app-service-types.js"
import { createRuntimeConnection } from "../../../protocol/client/connection.js"
import { canCreateProject, creationDetail, creationOn, machineStatus, projectPlacements, projectStatus, type MachinePickerSnapshot, type RemoteCreation } from "../../../protocol/modules/remote/machine-picker.js"
import { createRelayClient, type RelayClient } from "../../../protocol/modules/remote/relay-client.js"
import type { RemoteSelection } from "../../../protocol/modules/remote/relay-device.js"
import type { RemoteAttach, TerminalRemote, TerminalRemoteChoice, TerminalRemoteRequest } from "../../terminal-remote.js"
import { openTerminalDeviceStore, terminalPairedMachineCount } from "./terminal-device-store.js"

/** The terminal as a paired device of a remote machine (PI-REMOTE-016): the
 *  remote module's `terminalRemote` contribution.
 *
 *  It is the terminal's host for the shared relay client (`relay-client.ts`),
 *  the way the phone host is the phone's: it supplies the device store from
 *  an owner-only file, draws the shared machine and project picker as lines
 *  on the terminal, pairs from a pasted link, creates a project on a machine
 *  from a repository the person names, and hands the kernel a runtime client
 *  over the relay's sealed socket. Nothing here starts, finds, or
 *  replaces a runtime on this machine. */

/** How long the picker waits for the relay to answer for every paired
 *  machine before it lists them; a machine that has not answered by then is
 *  listed as checking. */
const PRESENCE_SETTLE_MS = 5_000

/** How long the picker waits, after a pairing, for the machine to offer its
 *  projects. The machine's relay service starts only once the machine holds
 *  a pairing, so a machine paired for the first time comes online a moment
 *  after the pairing succeeds. */
const PAIRED_ONLINE_MS = 15_000

export const terminalRemote: TerminalRemote = {
  pairedMachines: terminalPairedMachineCount,
  async choose(request) {
    const client = await createRelayClient(await openTerminalDeviceStore(request.userDataRoot))
    try {
      const choice = await chooseWith(client, request)
      if (choice.kind !== "attach") client.close()
      return choice
    } catch (cause) {
      client.close()
      throw cause
    }
  },
}

async function chooseWith(client: RelayClient, request: TerminalRemoteRequest): Promise<TerminalRemoteChoice> {
  const handed = handedSelection(request.handed, client.snapshot())
  const selection = handed === undefined ? await ask(client, request) : chosen(client, handed)
  if (selection === undefined) return { kind: "cancelled" }
  let said: string | undefined
  const say = (line: string): void => {
    if (line === said) return
    said = line
    request.print(line)
  }
  for (;;) {
    const snapshot = client.snapshot()
    const runtime = snapshot.runtimes.find((candidate) => candidate.runtimeId === selection.runtimeId)
    if (runtime === undefined) throw new Error("The chosen machine is no longer paired with this terminal.")
    const placement = projectPlacements(runtime).find((candidate) => candidate.id === selection.placementId)
    if (placement === undefined) {
      // A project this terminal created is starting, as the creation's last
      // line said, until presence lists it.
      if (!startingProject(snapshot, selection)) say(`Waiting for ${runtime.label} to offer the project. Press Ctrl+C to stop.`)
    } else {
      const fit = releaseFit(request.terminal, placement)
      const handoff = `${selection.runtimeId}.${selection.placementId}`
      if (fit.kind === "attach") return { kind: "attach", attach: remoteAttach(client, selection, runtime.label, placement) }
      if (fit.kind === "install") return { kind: "install", version: fit.version, machine: runtime.label, handoff }
      if (fit.kind === "cannot-install") {
        throw new Error(fit.reason === "source"
          ? `${runtime.label} runs Flywheel ${placement.version}, which speaks protocol ${placement.protocolVersion}, and this terminal runs Flywheel from source with protocol ${request.terminal.protocolVersion}. A source run installs no release: update this checkout, or run an installed Flywheel.`
          : `${runtime.label} runs a build of Flywheel ${placement.version} that speaks protocol ${placement.protocolVersion}, which the release ${placement.version} does not. Run a release on ${runtime.label}, or run the same build here.`)
      }
      say(`${runtime.label} runs Flywheel ${placement.version}, an earlier release than this terminal's ${request.terminal.version ?? "source"}. This terminal opens ${placement.projectLabel} once ${runtime.label} has updated. Press Ctrl+C to stop.`)
    }
    await nextChange(client)
  }
}

/** Makes `selection` the chosen project, and answers it. */
function chosen(client: RelayClient, selection: RemoteSelection): RemoteSelection {
  client.select(selection)
  return selection
}

function startingProject(snapshot: MachinePickerSnapshot, selection: RemoteSelection): boolean {
  const start = snapshot.start
  return start?.status === "starting" && start.selection.runtimeId === selection.runtimeId && start.selection.placementId === selection.placementId
}

/** The project a predecessor terminal handed this one, while its machine is
 *  still paired. */
function handedSelection(handed: string | undefined, snapshot: MachinePickerSnapshot): RemoteSelection | undefined {
  const [runtimeId, placementId, ...rest] = handed?.split(".") ?? []
  if (runtimeId === undefined || placementId === undefined || rest.length > 0) return undefined
  return snapshot.runtimes.some((runtime) => runtime.runtimeId === runtimeId) ? { runtimeId, placementId } : undefined
}

/** One line of the picker the person can choose, by its number: a project,
 *  or a new project from a repository on a machine that offers one. */
type PickerChoice = ProjectChoice | { readonly kind: "create"; readonly runtimeId: string; readonly machine: string }

interface ProjectChoice {
  readonly kind: "project"
  readonly selection: RemoteSelection
  readonly name: string
}

export interface PickerView {
  readonly lines: readonly string[]
  readonly choices: readonly PickerChoice[]
  /** The project last opened, which Enter chooses, while the machine offers it. */
  readonly last?: ProjectChoice
}

/** The picker as lines: every paired machine with what it is doing, and
 *  under each machine that is awake its projects, numbered, open or asleep
 *  (PI-REMOTE-009), then, while the machine offers it, the project this
 *  terminal is creating there and the choice of a new project from a
 *  repository. A machine that is offline or has not answered lists nothing
 *  to choose, and the machine placement, through which the machine creates
 *  projects, is never a project. */
export function pickerView(snapshot: MachinePickerSnapshot): PickerView {
  const lines: string[] = []
  const choices: PickerChoice[] = []
  let last: ProjectChoice | undefined
  for (const runtime of snapshot.runtimes) {
    const status = machineStatus(runtime)
    if (status.kind !== "awake") {
      lines.push(`  ${runtime.label}: ${status.kind === "checking" ? "checking" : "offline"}`)
      continue
    }
    lines.push(`  ${runtime.label}:`)
    for (const placement of projectPlacements(runtime)) {
      const choice: ProjectChoice = { kind: "project", selection: { runtimeId: runtime.runtimeId, placementId: placement.id }, name: `${placement.projectLabel} on ${runtime.label}` }
      choices.push(choice)
      const isLast = snapshot.selected?.runtimeId === runtime.runtimeId && snapshot.selected.placementId === placement.id
      if (isLast) last = choice
      lines.push(`    ${choices.length}. ${placement.projectLabel} (${projectStatus(snapshot, runtime.runtimeId, placement)})${isLast ? ", opened last" : ""}`)
    }
    if (!canCreateProject(runtime)) continue
    const creation = creationOn(snapshot, runtime.runtimeId)
    if (creation !== undefined) lines.push(`    ${creationLine(creation)}`)
    choices.push({ kind: "create", runtimeId: runtime.runtimeId, machine: runtime.label })
    lines.push(`    ${choices.length}. New project from repository`)
  }
  return { lines, choices, ...(last === undefined ? {} : { last }) }
}

function creationLine(creation: RemoteCreation): string {
  const detail = creationDetail(creation)
  return `${detail.name}: ${detail.text}`
}

/** Asks for a project until the person chooses one, pairing a machine from
 *  each link they paste and creating a project from each repository they
 *  name, and answers the chosen project. An empty answer chooses the project
 *  opened last; with none to take, it checks the paired machines again, or
 *  ends the prompt with no choice when no machine is paired. */
async function ask(client: RelayClient, request: TerminalRemoteRequest): Promise<RemoteSelection | undefined> {
  await presenceSettled(client)
  for (;;) {
    const view = pickerView(client.snapshot())
    if (view.lines.length > 0) {
      request.print("Projects on paired machines:")
      for (const line of view.lines) request.print(line)
    }
    const question = view.lines.length === 0
      ? "This terminal is not paired with a machine. Run `flywheel remote pair` on the machine, then paste the link it shows: "
      : view.choices.length === 0
        ? "No paired machine offers a project now. Press Enter to check again, or paste a pairing link: "
        : `Choose a project [1-${view.choices.length}]${view.last === undefined ? "" : `, press Enter for ${view.last.name}`}, or paste a pairing link: `
    const answer = await request.prompt(question)
    if (answer === "") {
      if (view.last !== undefined) return chosen(client, view.last.selection)
      if (view.lines.length === 0) return undefined
      await presenceSettled(client)
      continue
    }
    if (/^\d+$/.test(answer)) {
      const choice = view.choices[Number(answer) - 1]
      if (choice === undefined) {
        request.print(`${answer} is not a choice.`)
        continue
      }
      if (choice.kind === "project") return chosen(client, choice.selection)
      const created = await createProject(client, request, choice)
      if (created !== undefined) return created
      continue
    }
    try {
      await client.pair(answer)
      const paired = client.snapshot().runtimes.at(-1)
      request.print(`Paired with ${paired?.label ?? "the machine"}.`)
      if (paired !== undefined) await presenceShows(client, (snapshot) => machineAwake(snapshot, paired.runtimeId), PAIRED_ONLINE_MS)
    } catch (cause) {
      request.print(cause instanceof Error && cause.message === "not a Flywheel pairing code" ? `${answer} is not a choice or a pairing link.` : `Pairing failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}

/** Creates a project on a machine from the repository the person names
 *  (PI-REMOTE-009), printing what the machine is doing as the phone's row
 *  says it, and answers the project, chosen as starting, once the machine
 *  has opened it. The picker has no project on screen, so the new project is
 *  chosen over the one opened last. The person names only the repository:
 *  the machine clones it with its own git access and derives the folder. An
 *  empty answer, or a creation that failed, answers nothing, and the picker
 *  drawn again shows why it failed. */
async function createProject(client: RelayClient, request: TerminalRemoteRequest, choice: { readonly runtimeId: string; readonly machine: string }): Promise<RemoteSelection | undefined> {
  const repository = (await request.prompt(`Repository to clone on ${choice.machine} (owner/repo or a git URL), or press Enter to go back: `)).trim()
  if (repository === "") return undefined
  let said: string | undefined
  const stop = client.onChange((snapshot) => {
    const creation = creationOn(snapshot, choice.runtimeId)
    if (creation === undefined || creation.status === "failed") return
    // A clone can take minutes, so each line says how to stop, as every
    // other wait of the picker does.
    const line = `${creationLine(creation)} Press Ctrl+C to stop.`
    if (line === said) return
    said = line
    request.print(line)
  })
  try {
    return await client.createProject(choice.runtimeId, repository, { choose: true })
  } catch {
    return undefined
  } finally {
    stop()
  }
}

function machineAwake(snapshot: MachinePickerSnapshot, runtimeId: string): boolean {
  const runtime = snapshot.runtimes.find((candidate) => candidate.runtimeId === runtimeId)
  return runtime === undefined || machineStatus(runtime).kind === "awake"
}

/** Resolves once the relay has answered for every paired machine, or after
 *  the settle bound. */
export function presenceSettled(client: RelayClient): Promise<void> {
  return presenceShows(client, (snapshot) => snapshot.runtimes.every((runtime) => runtime.presence !== "watching"), PRESENCE_SETTLE_MS)
}

/** Resolves once presence shows what `shows` asks for, or after `boundMs`. */
function presenceShows(client: RelayClient, shows: (snapshot: MachinePickerSnapshot) => boolean, boundMs: number): Promise<void> {
  if (shows(client.snapshot())) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, boundMs)
  const unsubscribe = client.onChange((snapshot) => { if (shows(snapshot)) resolve() })
  return promise.finally(() => {
    clearTimeout(timer)
    unsubscribe()
  })
}

function nextChange(client: RelayClient): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = client.onChange(() => {
      unsubscribe()
      resolve()
    })
  })
}

function remoteAttach(client: RelayClient, selection: RemoteSelection, machine: string, placement: { readonly projectLabel: string; readonly version: string; readonly protocolVersion: number }): RemoteAttach {
  return {
    machine,
    project: placement.projectLabel,
    runtimeId: selection.runtimeId,
    placementId: selection.placementId,
    handoff: `${selection.runtimeId}.${selection.placementId}`,
    release: { version: placement.version, protocolVersion: placement.protocolVersion },
    connect(onDiagnostic) {
      const connection = createRuntimeConnection({ socket: client.socket, onDiagnostic })
      // A project its machine is starting shows on the load screen the way a
      // local start does; the lane that opens supersedes it.
      const listeners = new Set<(event: FrontendEvent) => void>()
      let reported: RuntimeStartupStatus["kind"] | undefined
      const stopStart = client.onChange((snapshot) => {
        const start = snapshot.start
        if (start?.selection.runtimeId !== selection.runtimeId || start.selection.placementId !== selection.placementId) {
          reported = undefined
          return
        }
        const status: RuntimeStartupStatus = start.status === "starting"
          ? { kind: "phase", label: `Starting Flywheel for ${placement.projectLabel} on ${machine}` }
          : { kind: "failed", error: `Flywheel on ${machine} could not open ${placement.projectLabel}.` }
        if (status.kind === reported) return
        reported = status.kind
        for (const listener of listeners) listener({ type: "runtime.startup", status })
      })
      return {
        query: connection.query,
        dispatch: connection.dispatch,
        onLane: connection.onLane,
        watchOutput: connection.watchOutput,
        subscribe(listener) {
          listeners.add(listener)
          const release = connection.subscribe(listener)
          return () => {
            listeners.delete(listener)
            release()
          }
        },
        async close() {
          stopStart()
          listeners.clear()
          try {
            await connection.close()
          } finally {
            client.close()
          }
        },
      }
    },
    close: () => client.close(),
  }
}
