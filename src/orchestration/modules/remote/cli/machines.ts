import { existsSync } from "node:fs"

import type { StartupDirectories } from "../../../../infra/directory-authorities.js"
import { terminalDeviceStoreFile } from "../../../../infra/paths.js"
import { createRelayClient, type RelayClient } from "../../../../protocol/modules/remote/relay-client.js"
import { openTerminalDeviceStore } from "../terminal-device-store.js"
import { pickerView, presenceSettled } from "../terminal-remote.js"
import { REMOTE_USAGE } from "./registration.js"

interface MachinesIo {
  readonly log: (line: string) => void
  readonly error: (line: string) => void
}

const defaultIo: MachinesIo = { log: (line) => process.stdout.write(`${line}\n`), error: (line) => process.stderr.write(`${line}\n`) }

const NOT_PAIRED = "This terminal is not paired with a machine. Run `flywheel remote pair` on the machine, then `flywheel remote machines add <link>` here with the link it shows."

/** `flywheel remote machines`: this terminal's side of remote access, where
 *  it is the paired device (PI-REMOTE-016). It lists the machines this
 *  terminal paired with and each one's projects as the relay reports them,
 *  pairs with a machine from the link `flywheel remote pair` shows there (the
 *  whole link or the part after `#`), and forgets one. `flywheel --remote`
 *  then opens one of their projects. */
export async function runMachines(args: readonly string[], directories: StartupDirectories, io: MachinesIo = defaultIo): Promise<void> {
  const [verb, argument, ...rest] = args
  if (verb === undefined) {
    if (!existsSync(terminalDeviceStoreFile(directories.userDataRoot))) {
      io.log(NOT_PAIRED)
      return
    }
    await withClient(directories, async (client) => {
      io.log(`This terminal: ${client.snapshot().deviceLabel} (device ${client.deviceId})`)
      if (client.snapshot().runtimes.length === 0) {
        io.log(NOT_PAIRED)
        return
      }
      await presenceSettled(client)
      for (const runtime of client.snapshot().runtimes) io.log(`${runtime.runtimeId}  ${runtime.label}  ${runtime.relay}`)
      for (const line of pickerView(client.snapshot()).lines) io.log(line)
    })
    return
  }
  if ((verb !== "add" && verb !== "forget") || argument === undefined || rest.length > 0) {
    io.error(REMOTE_USAGE)
    process.exitCode = 2
    return
  }
  await withClient(directories, async (client) => {
    if (verb === "add") {
      try {
        await client.pair(argument)
      } catch (cause) {
        io.error(`Pairing failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        process.exitCode = 1
        return
      }
      io.log(`Paired with ${client.snapshot().runtimes.at(-1)?.label ?? "the machine"}. Run \`flywheel --remote\` to open one of its projects.`)
      return
    }
    const runtime = client.snapshot().runtimes.find((candidate) => candidate.runtimeId === argument || candidate.label === argument)
    if (runtime === undefined) {
      io.error(`This terminal is not paired with a machine named ${argument}.`)
      process.exitCode = 1
      return
    }
    await client.forget(runtime.runtimeId)
    io.log(`Forgot ${runtime.label}. It lists this terminal until you revoke it there with \`flywheel remote devices revoke ${client.deviceId}\`.`)
  })
}

async function withClient(directories: StartupDirectories, use: (client: RelayClient) => Promise<void>): Promise<void> {
  const client = await createRelayClient(await openTerminalDeviceStore(directories.userDataRoot))
  try {
    await use(client)
  } finally {
    client.close()
  }
}
