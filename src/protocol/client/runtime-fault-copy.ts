import type { ServeLane } from "../../infra/cli-subprocess.js"
import type { RuntimeHealth, RuntimeProtocolRefusal } from "../app-service-types.js"
import { RUNTIME_PROTOCOL_VERSION } from "../runtime-liveness.js"
import type { ServeStartRefusal } from "../serve-handshake.js"

export interface RuntimeFaultCopy {
  /** A fault needs the person to act; a warning says that Flywheel is already acting. */
  readonly tone: "fault" | "warning"
  /** What is wrong, in the user's terms, with the runtime's own words when it had any. */
  readonly title: string
  /** What to do about it, or what Flywheel does about it. */
  readonly remedy: string
  /** Where the details are, and what happened to work in flight. */
  readonly detail: string
}

/** A cause can carry a stack or a process's last output; the notice shows its first line. */
function firstLine(text: string | undefined): string | undefined {
  return text?.split("\n").map((line) => line.trim()).find((line) => line.length > 0)
}

/** A release a terminal attached through the relay installs because the
 *  remote machine refused it as the older side (PI-REMOTE-016): it is
 *  installing it, or could not, and says why. */
export type ReleaseInstall =
  | { readonly status: "installing"; readonly version: string }
  | { readonly status: "failed"; readonly version: string; readonly message: string }

/** A device that reaches the runtime's machine through the relay: a
 *  terminal on another machine, or a page on a phone or in a browser. The
 *  person sits at the device, not at the machine, so a notice never asks for
 *  a command this device runs on the machine. */
interface RemoteReach {
  /** The machine's name, as the device's machine list shows it. */
  readonly machine: string
  /** Where this device keeps its own debug log, as a person types the path:
   *  a terminal keeps one under its account's directory for that machine. A
   *  page keeps none, and the machine's log has the details. */
  readonly log?: string
  /** The relay reports the machine offline: it is asleep, or no Flywheel
   *  service runs on it. The machine list says asleep at the same time. */
  readonly offline?: boolean
  /** The chosen project, while the awake machine shows it as not open:
   *  asleep, starting, or failed to start, as its row in the machine list
   *  says at the same time, or unlisted while the list shows no row for it. */
  readonly project?: { readonly name: string; readonly status: "asleep" | "starting" | "failed" } | { readonly status: "unlisted" }
  /** The release a terminal installs to match the machine. */
  readonly install?: ReleaseInstall
}

/** How the client reaches the runtime, which decides the remedy a notice
 *  names: the serve lane of a client on the runtime's own machine, or the
 *  remote machine a device attaches to through the relay. A client that knows
 *  neither, such as a local browser page, passes nothing. */
export type FaultReach = ServeLane | RemoteReach

const INTERRUPTED = "A turn that was running opens interrupted; Resume or your next message continues it."

/** What a surface says when an action it sent was lost with the lane: the
 *  runtime does not answer, so the action did not run. The fault notice says
 *  why; this names no cause of its own. */
export const UNANSWERED_ACTION = "Flywheel does not answer, so this did not run. Try again once Flywheel answers."

/** Where the details are: this client's own log, the remote machine's log
 *  for a page that keeps none, or the account log on this machine. */
function faultDetail(reach: FaultReach | undefined): string {
  const log = typeof reach !== "object" ? "~/.flywheel/log" : reach.log ?? `~/.flywheel/log on ${reach.machine}`
  return `If this keeps happening, the debug log at ${log} has the details. ${INTERRUPTED}`
}

/** The reset a person runs for the client's lane. A browser page, which does
 *  not know its lane, names the installed command. A device attached to a
 *  remote machine names that machine: a reset on this machine ends this
 *  machine's Flywheel, never the remote one. */
function resetRemedy(reach: FaultReach | undefined): string {
  if (typeof reach === "object") return `Open the project again. If that does not help, run \`flywheel kill\` on ${reach.machine}, then open the project again.`
  return reach === "dev"
    ? "Run `flywheel kill dev`, then run `bun run dev` again."
    : reach === "installed"
      ? "Run `flywheel kill`, then start Flywheel again."
      : "Run `flywheel kill`, then open the project again."
}

/** The notice for a runtime that does not answer this client, after the
 *  connection's recovery has failed for its fault window. The connection
 *  keeps reattaching while the notice shows, so the remedy says that first,
 *  and the notice goes once the runtime answers. A local client names the
 *  reset for a notice that stays. A remote device names what a person can do
 *  about the machine, and says that the machine is asleep or offline when
 *  the relay reports it so, or what the machine list says of the chosen
 *  project when the awake machine lists it as not open. */
function unansweredCopy(cause: string | undefined, reach: FaultReach | undefined): Pick<RuntimeFaultCopy, "tone" | "title" | "remedy"> {
  const trying = "Flywheel keeps trying to reach it. If this notice stays,"
  if (typeof reach !== "object") {
    const remedy = resetRemedy(reach)
    return {
      tone: "fault",
      title: cause === undefined ? "Flywheel's background service stopped answering." : `Flywheel's background service failed: ${cause}`,
      remedy: `${trying} ${remedy.charAt(0).toLowerCase()}${remedy.slice(1)}`,
    }
  }
  const machine = reach.machine
  if (cause === undefined && reach.offline === true) return { tone: "fault", title: `${machine} is asleep or offline.`, remedy: "Wake it, or open Flywheel on it. Flywheel connects by itself after that." }
  if (cause === undefined && reach.project !== undefined) return projectCopy(reach.project, machine)
  return {
    tone: "fault",
    title: cause === undefined ? `Flywheel on ${machine} does not answer.` : `Flywheel on ${machine} failed: ${cause}`,
    remedy: `${trying} make sure that ${machine} is awake and online, then open Flywheel on ${machine}.`,
  }
}

/** The notice for a chosen project that the awake machine shows as not open.
 *  A start in progress asks nothing of the person; an asleep project and a
 *  start that failed ask for the tap its row offers. A project with no row
 *  asks the person to open it on the machine, which then offers it again. */
function projectCopy(project: NonNullable<RemoteReach["project"]>, machine: string): Pick<RuntimeFaultCopy, "tone" | "title" | "remedy"> {
  if (project.status === "unlisted") return { tone: "fault", title: `${machine} does not offer this project now.`, remedy: `Open the project on ${machine}. Flywheel connects by itself after that.` }
  switch (project.status) {
    case "asleep": return { tone: "fault", title: `${project.name} is asleep on ${machine}.`, remedy: "Start it from the machine list. Flywheel connects by itself after that." }
    case "starting": return { tone: "warning", title: `Flywheel is starting ${project.name} on ${machine}.`, remedy: `Flywheel connects by itself once ${project.name} is open.` }
    case "failed": return { tone: "fault", title: `Flywheel could not start ${project.name} on ${machine}.`, remedy: "Try again from the machine list." }
  }
}

/** The notice for a start that the service refused with a named cause,
 *  whose remedy is not the lane reset alone. An empty claim asks nothing of
 *  the person: it clears itself. A held hub port names the reset for the
 *  case that the program on it is an earlier Flywheel, and the command that
 *  names any other program. Each host that starts the service shows these
 *  words, the editor's included. */
export function startRefusalCopy(refusal: ServeStartRefusal, reach?: FaultReach): Pick<RuntimeFaultCopy, "tone" | "title" | "remedy"> {
  switch (refusal.kind) {
    case "claim-settling":
      return {
        tone: "warning",
        title: "Flywheel's background service is waiting to start: an earlier version of Flywheel left an empty start claim.",
        remedy: `The claim clears itself once it is 10 minutes old, and Flywheel can start after that. The claim is \`${refusal.path}\`.`,
      }
    case "address-access":
      return {
        tone: "fault",
        title: `Flywheel's background service could not start: its address refused this user's connection (${refusal.code}).`,
        remedy: `Fix the permissions of \`${refusal.path}\` so that you can connect to it, or remove the file. Flywheel can start after that.`,
      }
    case "port-in-use":
      return {
        tone: "fault",
        title: `Flywheel's background service could not start: another program uses port ${refusal.port}.`,
        remedy: `If that program is an earlier Flywheel: ${resetRemedy(reach)} Otherwise stop that program; \`lsof -nP -iTCP:${refusal.port} -sTCP:LISTEN\` names it (on Windows, \`netstat -ano | findstr :${refusal.port}\`).`,
      }
    case "state-from-newer-release":
      return {
        tone: "fault",
        title: `Flywheel cannot open this project: a newer Flywheel release saved its state (state version ${refusal.stateEpoch}; this release reads version ${refusal.readableEpoch}).`,
        remedy: "Update Flywheel with `flywheel update`, then open the project again.",
      }
  }
}

/** The notice for a runtime that refused this client's protocol version.
 *  The protocol versions say which side is older; the runtime's release is
 *  named only as the runtime's, because a client's own release number, such
 *  as an editor extension's, can differ or even match. An older client asks
 *  the person to update it, except a terminal attached through the relay,
 *  which installs the machine's release itself and says so, or says why it
 *  could not. A newer client asks nothing: it attaches by itself once the
 *  runtime runs its release. The refusal ends no work in the project, so the
 *  detail says so instead of naming interrupted turns. */
function protocolRefusalCopy(refusal: RuntimeProtocolRefusal, reach: FaultReach | undefined): RuntimeFaultCopy {
  const detail = `This client speaks protocol ${RUNTIME_PROTOCOL_VERSION}, and the project's runtime speaks protocol ${refusal.protocolVersion}. Work that runs in the project continues.`
  if (refusal.protocolVersion <= RUNTIME_PROTOCOL_VERSION) {
    return {
      tone: "warning",
      title: `This project runs an earlier Flywheel (Flywheel ${refusal.version}) than this client.`,
      remedy: "This client connects by itself once the project runs its release.",
      detail,
    }
  }
  if (typeof reach === "object" && reach.install !== undefined) {
    const install = reach.install
    const title = `Flywheel on ${reach.machine} runs a later release (Flywheel ${refusal.version}) than this terminal.`
    return install.status === "installing"
      ? { tone: "warning", title, remedy: `Installing Flywheel ${install.version} to match ${reach.machine}. This terminal opens the project again after that.`, detail }
      : { tone: "fault", title, remedy: install.message, detail }
  }
  return {
    tone: "fault",
    title: `This client is older than the Flywheel that runs this project (Flywheel ${refusal.version}).`,
    remedy: "Update this client. It connects after that.",
    detail,
  }
}

/** The one notice a runtime that is not healthy gets, on every surface. A
 *  lost runtime and a project whose sessions could not be restored are
 *  faults: a lost runtime says that Flywheel keeps trying and what to do if
 *  it does not answer (`unansweredCopy`), and a failed restore names the
 *  reset for the client's lane or remote machine. A start whose refusal the
 *  service named shows that refusal's own remedy instead, because the reset
 *  alone does not clear it. A process that keeps stopping asks nothing of
 *  the person: Flywheel starts it again, and the notice goes once the new
 *  process is ready. A background service that keeps stopping soon after it
 *  starts asks nothing either, and its notice goes once the service has run
 *  for a minute. */
export function runtimeFaultCopy(health: Exclude<RuntimeHealth, { kind: "healthy" }>, reach?: FaultReach): RuntimeFaultCopy {
  switch (health.kind) {
    case "crash_loop":
      return {
        tone: "warning",
        title: `Flywheel's background service keeps stopping soon after it starts. Last cause: ${firstLine(health.cause) ?? "not recorded"}.`,
        remedy: "Flywheel starts it again. Open sessions continue when it starts.",
        detail: faultDetail(reach),
      }
    case "restarting":
      return {
        tone: "warning",
        title: `Flywheel's process for this project stopped again. Last cause: ${firstLine(health.cause) ?? "not recorded"}.`,
        remedy: "Flywheel starts it again. Open sessions continue when it starts.",
        detail: faultDetail(reach),
      }
    case "recovery_failed": {
      // A failure with no specific cause states none, rather than a
      // placeholder or the title again.
      const cause = firstLine(health.cause)
      return {
        tone: "fault",
        title: `Flywheel could not restore this project's sessions after its process stopped.${cause === undefined ? "" : ` Cause: ${cause}.`}`,
        remedy: resetRemedy(reach),
        detail: faultDetail(reach),
      }
    }
    case "faulted": {
      if (health.refusal?.kind === "protocol-mismatch") return protocolRefusalCopy(health.refusal, reach)
      if (health.refusal !== undefined) return { ...startRefusalCopy(health.refusal, reach), detail: faultDetail(reach) }
      return { ...unansweredCopy(firstLine(health.cause), reach), detail: faultDetail(reach) }
    }
  }
}
