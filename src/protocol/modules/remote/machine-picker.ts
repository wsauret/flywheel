import { isMachinePlacement } from "./project-creation.js"
import type { RemoteSelection } from "./relay-device.js"
import type { Placement } from "./relay-protocol.js"

/** The machine and project picker every relay-attached client draws: the
 *  shapes the relay client (`relay-client.ts`) publishes, and the states
 *  PI-REMOTE-009 and PI-REMOTE-010 name, derived from them. Pure and free of
 *  transport, so a client can draw the picker without loading the relay's
 *  socket code. */

/** One machine this device is paired with, as the relay reports it now. */
export interface RemoteRuntimeSummary {
  readonly runtimeId: string
  readonly label: string
  readonly relay: string
  /** The placements the relay reports right now: live ones a runtime serves,
   *  dormant ones the machine's account service can start, and the machine
   *  placement through which its account service creates projects
   *  (`project-creation.ts`). Empty while the machine is asleep with no
   *  account service, or the relay is unreachable. */
  readonly placements: readonly Placement[]
  /** `watching` until the relay first answers for the machine. */
  readonly presence: "watching" | "online" | "offline"
}

/** A dormant placement the person chose: its machine's account service is
 *  starting a runtime for it, or could not. */
export interface RemoteStart {
  readonly selection: RemoteSelection
  readonly status: "starting" | "failed"
}

/** A project this device asked a machine to create from a repository: the
 *  machine is cloning it, has cloned it and is opening it, or could not. Once
 *  the machine has opened it, it is the chosen project and its row says so. */
export type RemoteCreation =
  | { readonly runtimeId: string; readonly repository: string; readonly status: "cloning" }
  | { readonly runtimeId: string; readonly repository: string; readonly status: "opening"; readonly projectLabel: string }
  | { readonly runtimeId: string; readonly repository: string; readonly status: "failed"; readonly message: string }

export type RemotePairing = { readonly status: "idle" } | { readonly status: "pairing" } | { readonly status: "failed"; readonly message: string }

/** What a picker draws: this device, its paired machines and their
 *  projects, the chosen project, a start in progress, a project being created,
 *  and pairing. */
export interface MachinePickerSnapshot {
  /** How this device names itself to the machines it pairs with. */
  readonly deviceLabel: string
  readonly runtimes: readonly RemoteRuntimeSummary[]
  readonly selected: RemoteSelection | undefined
  readonly start?: RemoteStart
  readonly creation?: RemoteCreation
  readonly pairing: RemotePairing
}

/** What a client can do from the picker. The relay client implements it, and
 *  a host hands it to the client with whatever its platform adds to the
 *  snapshot. */
export interface MachinePicker<Snapshot extends MachinePickerSnapshot = MachinePickerSnapshot> {
  /** This device's id as the runtime recorded it at pairing. */
  readonly deviceId: string
  snapshot(): Snapshot
  onChange(listener: (snapshot: Snapshot) => void): () => void
  /** Pairs from a code: the URL a QR code carries, or its fragment. Rejects
   *  with a message a person can act on, which the snapshot also carries. */
  pair(code: string): Promise<void>
  /** Names this device for the machines it pairs with from now on. */
  setLabel(label: string): Promise<void>
  select(selection: RemoteSelection): void
  forget(runtimeId: string): Promise<void>
  /** Asks a machine whose account service offers it (`canCreateProject`) to
   *  clone a repository into a new project, and resolves with the project
   *  once the machine has opened it. The project is then chosen as starting
   *  only when no project is chosen, so a pick the person made stays. A host
   *  with no project on screen, such as the terminal's picker, passes
   *  `choose`, and the project is chosen as starting whatever was chosen
   *  before. The snapshot's `creation` follows the request. Rejects with a
   *  message a person can act on, which the snapshot also carries. */
  createProject(runtimeId: string, repository: string, options?: { readonly choose?: boolean }): Promise<RemoteSelection>
}

/** Whether the client should show the machine and project picker instead of
 *  a session (PI-REMOTE-010).
 *
 *  The picker is for when no project is selected and live. Two cases keep it
 *  away. A placement its machine is still starting stays on the picker, which is
 *  where its row says so. A remembered selection whose machine the relay has
 *  not yet answered for is the opposite: the client was just opened on a
 *  paired device, presence is a second away, and showing pairing instructions
 *  in that second told the person the pairing was gone. That second belongs to
 *  the loading screen, until presence says the machine is online without the
 *  project or offline altogether. */
export function needsRuntime(snapshot: Pick<MachinePickerSnapshot, "selected" | "runtimes">): boolean {
  const runtime = snapshot.runtimes.find((candidate) => candidate.runtimeId === snapshot.selected?.runtimeId)
  if (runtime?.presence === "watching") return false
  return !selectionServed(snapshot)
}

/** Whether presence lists the chosen project as open: a runtime on its
 *  machine serves it now. */
export function selectionServed(snapshot: Pick<MachinePickerSnapshot, "selected" | "runtimes">): boolean {
  const selected = snapshot.selected
  const runtime = snapshot.runtimes.find((candidate) => candidate.runtimeId === selected?.runtimeId)
  return selected !== undefined && runtime !== undefined && runtime.placements.some((placement) => placement.id === selected.placementId && placement.state === "live")
}

/** The machine's projects, as its picker lists them: every placement but the
 *  machine placement. */
export function projectPlacements(runtime: Pick<RemoteRuntimeSummary, "runtimeId" | "placements">): readonly Placement[] {
  return runtime.placements.filter((placement) => !isMachinePlacement(runtime.runtimeId, placement))
}

/** Whether the machine's account service offers to create a project from a
 *  repository, which it does while it announces the machine placement. */
export function canCreateProject(runtime: Pick<RemoteRuntimeSummary, "runtimeId" | "placements">): boolean {
  return runtime.placements.some((placement) => isMachinePlacement(runtime.runtimeId, placement))
}

/** What a paired machine is doing, as its picker row states it: the relay has
 *  not answered yet, the relay reports it offline (asleep, or with no account
 *  service to offer projects), or it is awake with some number of projects
 *  open. */
type MachineStatus = { readonly kind: "checking" } | { readonly kind: "offline" } | { readonly kind: "awake"; readonly open: number }

export function machineStatus(runtime: RemoteRuntimeSummary): MachineStatus {
  if (runtime.presence === "watching") return { kind: "checking" }
  if (runtime.placements.length === 0) return { kind: "offline" }
  return { kind: "awake", open: projectPlacements(runtime).filter((placement) => placement.state === "live").length }
}

/** The machine of the chosen project, as a fault notice names it: its name,
 *  whether the relay reports it offline, which its row shows as asleep, and
 *  the chosen project's state when no runtime serves it: its row's state by
 *  the same rule (`projectStatus`), or `unlisted` while the awake machine
 *  shows no row for it, as between the stop and the start of the machine's
 *  service. Nothing while no machine is chosen. */
export function selectedMachine(snapshot: Pick<MachinePickerSnapshot, "runtimes" | "selected" | "start">): {
  readonly machine: string
  readonly offline: boolean
  readonly project?: { readonly name: string; readonly status: Exclude<ProjectStatus, "open"> } | { readonly status: "unlisted" }
} | undefined {
  const selected = snapshot.selected
  const runtime = snapshot.runtimes.find((candidate) => candidate.runtimeId === selected?.runtimeId)
  if (selected === undefined || runtime === undefined) return undefined
  const machine = machineStatus(runtime)
  const reach = { machine: runtime.label, offline: machine.kind === "offline" }
  const placement = runtime.placements.find((candidate) => candidate.id === selected.placementId)
  if (placement === undefined) return machine.kind === "awake" ? { ...reach, project: { status: "unlisted" } } : reach
  const status = projectStatus(snapshot, runtime.runtimeId, placement)
  return status === "open" ? reach : { ...reach, project: { name: placement.projectLabel, status } }
}

/** The project this device is creating on a machine, if any. */
export function creationOn(snapshot: Pick<MachinePickerSnapshot, "creation">, runtimeId: string): RemoteCreation | undefined {
  return snapshot.creation?.runtimeId === runtimeId ? snapshot.creation : undefined
}

/** What the row of a project being created says: its name, which is the
 *  repository until the machine has named the project, and what the machine
 *  is doing about it. `warn` marks a creation that failed. */
export function creationDetail(creation: RemoteCreation) {
  switch (creation.status) {
    case "cloning": return { name: creation.repository, text: "Cloning on the machine...", warn: false }
    case "opening": return { name: creation.projectLabel, text: "Cloned. Starting Flywheel on the machine...", warn: false }
    case "failed": return { name: creation.repository, text: creation.message, warn: true }
  }
}

/** What one announced project is doing, as its picker row states it
 *  (PI-REMOTE-009): open when a runtime serves it, otherwise asleep, or
 *  starting or failed to start after the person chose it. */
type ProjectStatus = "open" | "asleep" | "starting" | "failed"

export function projectStatus(snapshot: Pick<MachinePickerSnapshot, "start">, runtimeId: string, placement: Placement): ProjectStatus {
  if (placement.state === "live") return "open"
  const start = snapshot.start
  if (start?.selection.runtimeId === runtimeId && start.selection.placementId === placement.id) return start.status
  return "asleep"
}
