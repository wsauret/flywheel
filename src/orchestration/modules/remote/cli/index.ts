import { serveLaneFor } from "../../../../infra/cli-subprocess.js"
import type { StartupDirectories } from "../../../../infra/directory-authorities.js"
import { importLegacyRemotePlacements, readRemotePairingStore } from "../remote-pairing-store.js"
import type { LauncherContext } from "../../../../infra/process-supervisor.js"
import { REMOTE_USAGE } from "./registration.js"
import { DEFAULT_RELAY_URL } from "../../../../protocol/modules/remote/relay-protocol.js"
import { PAIR_FROM_INSTALLED_APP } from "../../../../protocol/modules/remote.js"
import { decodeRemoteAccountAnswer, type RemoteAccountAnswer, type RemoteAccountRequest } from "../../../../protocol/modules/remote/account-requests.js"
import type { CliCommandContext } from "../../../cli-contribution.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { lingerNotice } from "../../../../protocol/client/process-initiation-copy.js"
import { qrCodeRows } from "../../../../infra/qr-code.js"
import { accountServicePlatform, createAccountServiceInstallation, type AccountServiceInstallation } from "../../../app-service/account-service-installation.js"
import { ownedCommandRunner } from "../../../../infra/owned-command.js"
import { createAccountProjectRegistry } from "../../../app-service/account-project-registry.js"
import { retiredServiceInstallation } from "../account-relay-service.js"

interface RemoteCliIo {
  readonly log: (line: string) => void
  readonly error: (line: string) => void
}

/** The remote commands act on the lane of the executable that runs them. */
const LANE = serveLaneFor(process.execPath)

const defaultIo: RemoteCliIo = { log: (line) => process.stdout.write(`${line}\n`), error: (line) => process.stderr.write(`${line}\n`) }

/** True black on true white regardless of the terminal theme, because a
 *  camera reads a QR code by contrast. */
const QR_ON = "\x1b[47m\x1b[30m"
const QR_OFF = "\x1b[0m"

function serviceInstallationFor(directories: StartupDirectories, launcher: LauncherContext) {
  const platform = accountServicePlatform({ userDataRoot: directories.userDataRoot, accountHome: directories.accountHome, retired: [retiredServiceInstallation], runCommand: ownedCommandRunner(launcher.scope) })
  return platform === undefined ? undefined : createAccountServiceInstallation(() => platform)
}

/** Prints this account's remote state. `installation` is the service
 *  registration Process initiation reads, which the launcher's installed
 *  build names unless a caller supplies one. */
export async function runStatus(directories: StartupDirectories, launcher: LauncherContext, io: RemoteCliIo = defaultIo, installation: AccountServiceInstallation | undefined = serviceInstallationFor(directories, launcher)): Promise<void> {
  const store = readRemotePairingStore(directories.userDataRoot, LANE)
  const registry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
  await importLegacyRemotePlacements(directories.userDataRoot, LANE, registry)
  io.log(`Relay:     ${store.relayUrl ?? DEFAULT_RELAY_URL}`)
  io.log(`Identity:  ${store.identity === undefined ? "not created (created on first pairing)" : store.identity.publicKey}`)
  io.log(`Devices:   ${store.devices.length}`)
  io.log(`Projects:  ${(await registry.list()).length}`)
  const on = installation !== undefined && await installation.installed() === true
  io.log(`Process initiation: ${installation === undefined ? "unavailable" : on ? "on" : "off"}`)
  const lingerOffFor = on ? await installation.lingerOffFor() : undefined
  if (lingerOffFor !== undefined) io.log(lingerNotice(lingerOffFor))
  await registry.dispose()
}

/** What a verb that changes remote access runs against. */
type RemoteCommandContext = Pick<CliCommandContext, "directories" | "accountRequest">

/** Sends one request to the remote module of the lane's account service and
 *  hands each answer to `onAnswer`. The service is the one live writer of
 *  the lane's remote state, and each placement it serves applies a change as
 *  the change is written. Reports the reason and fails the command when no
 *  service can serve the request. */
async function requestRemote(context: RemoteCommandContext, request: RemoteAccountRequest, io: RemoteCliIo, onAnswer: (answer: RemoteAccountAnswer) => void): Promise<boolean> {
  try {
    await context.accountRequest(request, (payload) => onAnswer(decodeRemoteAccountAnswer(payload)))
    return true
  } catch (error) {
    io.error(errorMessage(error))
    process.exitCode = 1
    return false
  }
}

/** Applies one change and prints `done` once the service commits it. */
async function changeRemoteAccess(context: RemoteCommandContext, request: RemoteAccountRequest, done: string, io: RemoteCliIo): Promise<void> {
  let rejected: string | undefined
  let committed = false
  const answered = await requestRemote(context, request, io, (answer) => {
    if (answer.type !== "result") return
    if (answer.kind === "committed") committed = true
    else rejected = answer.message
  })
  if (!answered) return
  if (committed) {
    io.log(done)
    return
  }
  io.error(rejected ?? "The account service ended the request without an answer.")
  process.exitCode = 1
}

export async function runDevices(args: readonly string[], context: RemoteCommandContext, io: RemoteCliIo = defaultIo): Promise<void> {
  if (args[0] === "revoke") {
    const id = args[1]
    if (id === undefined) {
      io.error(`revoke requires a device id\n\n${REMOTE_USAGE}`)
      process.exitCode = 2
      return
    }
    await changeRemoteAccess(context, { type: "remote.device.revoke", deviceId: id }, `Revoked ${id}`, io)
    return
  }
  const store = readRemotePairingStore(context.directories.userDataRoot, LANE)
  if (store.devices.length === 0) {
    io.log("No paired devices. Run `flywheel remote pair` to pair one.")
    return
  }
  for (const device of store.devices) io.log(`${device.id}  ${device.label}  paired ${new Date(device.pairedAt).toISOString()}`)
}

export async function runProjects(args: readonly string[], context: RemoteCommandContext, io: RemoteCliIo = defaultIo): Promise<void> {
  if (args[0] === "forget") {
    const root = args[1]
    if (root === undefined) {
      io.error(`forget requires a project root\n\n${REMOTE_USAGE}`)
      process.exitCode = 2
      return
    }
    await changeRemoteAccess(context, { type: "remote.project.forget", projectRoot: root }, `Forgot ${root}`, io)
    return
  }
  const registry = createAccountProjectRegistry({ userDataRoot: context.directories.userDataRoot })
  try {
    await importLegacyRemotePlacements(context.directories.userDataRoot, LANE, registry)
    const projects = await registry.list()
    if (projects.length === 0) {
      io.log("No projects yet. A project is recorded when a runtime for it attaches to the relay while a device is paired.")
      return
    }
    for (const project of projects) io.log(`${project.projectRoot}  ${project.label}  last attached ${new Date(project.lastAttachedAt).toISOString()}`)
  } finally {
    await registry.dispose()
  }
}

/** Opens the account service's pairing window, shows its code, and waits
 *  until a device pairs or the window expires. The window closes when this
 *  command ends, by any exit or signal, because the service withdraws a
 *  request whose connection closes. */
export async function runPair(args: readonly string[], context: RemoteCommandContext, io: RemoteCliIo = defaultIo): Promise<void> {
  let relayUrl: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--relay") {
      relayUrl = args[index + 1]
      if (relayUrl === undefined) {
        io.error(`--relay requires a URL\n\n${REMOTE_USAGE}`)
        process.exitCode = 2
        return
      }
      index += 1
      continue
    }
    io.error(`Unknown option: ${args[index]}\n\n${REMOTE_USAGE}`)
    process.exitCode = 2
    return
  }
  let end: Extract<RemoteAccountAnswer, { readonly type: "paired" | "expired" | "stopped" }> | undefined
  let lastConnection: string | undefined
  const answered = await requestRemote(context, { type: "remote.pair.open", ...(relayUrl === undefined ? {} : { relayUrl }) }, io, (answer) => {
    if (answer.type === "pairing") showCode(answer, io)
    else if (answer.type === "relay" && answer.connection !== lastConnection) {
      lastConnection = answer.connection
      io.log(answer.connection === "connected" ? "Attached to the relay; waiting for the phone..." : `Relay: ${answer.connection}${answer.lastError ? ` (${answer.lastError})` : ""}`)
    } else if (answer.type === "paired" || answer.type === "expired" || answer.type === "stopped") end = answer
  })
  if (!answered) return
  if (end?.type === "paired") {
    io.log(`Paired ${end.label}.`)
    return
  }
  io.error(end?.type === "stopped"
    ? "Remote access on this machine restarted or turned off before a device paired. Run `flywheel remote pair` again to show a new code."
    : "The pairing window closed without a device pairing.")
  process.exitCode = 1
}

function showCode(window: { readonly code: string; readonly expiresAt: number }, io: RemoteCliIo): void {
  io.log("Scan this code with your phone's camera, or open the link on the phone:")
  io.log("")
  for (const row of qrCodeRows(window.code)) io.log(`  ${QR_ON}${row}${QR_OFF}`)
  io.log("")
  io.log(window.code)
  io.log("")
  io.log(`The code expires at ${new Date(window.expiresAt).toLocaleTimeString()}.`)
  io.log(PAIR_FROM_INSTALLED_APP)
}
