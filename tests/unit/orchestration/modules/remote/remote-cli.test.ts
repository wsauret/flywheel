import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { AccountServiceInstallation } from "../../../../../src/orchestration/app-service/account-service-installation.js"
import { runDevices, runPair, runProjects, runStatus } from "../../../../../src/orchestration/modules/remote/cli/index.js"
import { mutateRemotePairingStore, readRemotePairingStore } from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js"
import type { AccountModuleRequest } from "../../../../../src/protocol/account-attach.js"
import type { RemoteAccountAnswer } from "../../../../../src/protocol/modules/remote/account-requests.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { unusedLauncher } from "../../../cli/_serve-fixtures.js"
import { installationOf } from "../../app-service/_account-service-fixtures.js"

const temporaryDirectory = temporaryDirectories()

/** An installation whose registration is `installed` and whose logind
 *  reading names `lingerOffFor`. */
const installation = (installed: boolean, lingerOffFor: string | undefined): AccountServiceInstallation => installationOf({ installed: async () => installed, lingerOffFor: async () => lingerOffFor })

/** The lines `flywheel remote status` prints for a fresh account. */
async function statusLines(of: AccountServiceInstallation): Promise<string[]> {
  const accountHome = temporaryDirectory("fw-remote-status-")
  const lines: string[] = []
  const directories = { accountHome, userDataRoot: join(accountHome, ".flywheel"), projectRoot: accountHome, executionCwd: accountHome }
  await runStatus(directories, unusedLauncher(), { log: (line) => { lines.push(line) }, error: (line) => { lines.push(line) } }, of)
  return lines
}

describe("flywheel remote status", () => {
  test("follows Process initiation with the logout notice while lingering is off for the account", async () => {
    const lines = await statusLines(installation(true, "wes"))

    expect(lines.slice(-2)).toEqual([
      "Process initiation: on",
      "Flywheel stops when you log out, because lingering is off for wes. To keep Flywheel running after you log out, run `sudo loginctl enable-linger wes` on this machine.",
    ])
  })

  test.each([
    ["Process initiation is off", false, "wes", "Process initiation: off"],
    ["logind names no account", true, undefined, "Process initiation: on"],
  ] as const)("prints no notice when %s", async (_case, installed, lingerOffFor, reading) => {
    expect((await statusLines(installation(installed, lingerOffFor))).at(-1)).toBe(reading)
  })
})

const PHONE = { id: "phone", label: "Phone", publicKey: "AAAA", pairedAt: 0 }

/** A fresh account whose store pairs PHONE, and the lines a command prints. */
async function pairedAccount() {
  const accountHome = temporaryDirectory("fw-remote-cli-")
  const directories = { accountHome, userDataRoot: join(accountHome, ".flywheel"), projectRoot: accountHome, executionCwd: accountHome }
  await mutateRemotePairingStore(directories.userDataRoot, "dev", (store) => { store.devices = [PHONE] })
  await mutateRemotePairingStore(directories.userDataRoot, "installed", (store) => { store.devices = [PHONE] })
  const lines: string[] = []
  const errors: string[] = []
  return { directories, lines, errors, io: { log: (line: string) => { lines.push(line) }, error: (line: string) => { errors.push(line) } } }
}

/** The lane's account service as a command reaches it: it records each
 *  request and answers it with the answers `answer` returns. */
function accountService(answer: (request: AccountModuleRequest) => readonly RemoteAccountAnswer[] | Error) {
  const received: AccountModuleRequest[] = []
  const accountRequest = async (request: AccountModuleRequest, onAnswer: (answer: unknown) => void): Promise<void> => {
    received.push(request)
    const answers = answer(request)
    if (answers instanceof Error) throw answers
    for (const next of answers) onAnswer(next)
  }
  return { accountRequest, received }
}

const committed = (): readonly RemoteAccountAnswer[] => [{ type: "result", kind: "committed" }]

const exitCode = process.exitCode ?? 0
afterEach(() => { process.exitCode = exitCode })

describe("flywheel remote devices revoke", () => {
  test("sends the revoke to the account service, which records and applies it", async () => {
    const { directories, lines, io } = await pairedAccount()
    const service = accountService(committed)

    await runDevices(["revoke", PHONE.id], { directories, accountRequest: service.accountRequest }, io)

    expect(service.received).toEqual([{ type: "remote.device.revoke", deviceId: PHONE.id }])
    expect(lines).toEqual([`Revoked ${PHONE.id}`])
    // The service is the store's one live writer; the command wrote nothing.
    expect(readRemotePairingStore(directories.userDataRoot, "installed").devices).toEqual([PHONE])
    expect(readRemotePairingStore(directories.userDataRoot, "dev").devices).toEqual([PHONE])
  })

  test("states the reason and fails when the account service refuses the revoke", async () => {
    const { directories, errors, io } = await pairedAccount()
    const service = accountService(() => [{ type: "result", kind: "rejected", message: "No paired device has the id unknown" }])

    await runDevices(["revoke", "unknown"], { directories, accountRequest: service.accountRequest }, io)

    expect(errors).toEqual(["No paired device has the id unknown"])
    expect(process.exitCode).toBe(1)
  })

  test("states the reason and fails when no account service can serve the revoke", async () => {
    const { directories, errors, io } = await pairedAccount()
    const service = accountService(() => new Error("The remote module is off for this account."))

    await runDevices(["revoke", PHONE.id], { directories, accountRequest: service.accountRequest }, io)

    expect(errors).toEqual(["The remote module is off for this account."])
    expect(process.exitCode).toBe(1)
    expect(readRemotePairingStore(directories.userDataRoot, "dev").devices).toEqual([PHONE])
  })
})

describe("flywheel remote projects forget", () => {
  test("sends the forget to the account service by the project's root", async () => {
    const { directories, lines, io } = await pairedAccount()
    const projectRoot = join(directories.accountHome, "project")
    const service = accountService(committed)

    await runProjects(["forget", projectRoot], { directories, accountRequest: service.accountRequest }, io)

    expect(service.received).toEqual([{ type: "remote.project.forget", projectRoot }])
    expect(lines).toEqual([`Forgot ${projectRoot}`])
  })
})

describe("flywheel remote pair", () => {
  const pairing: RemoteAccountAnswer = { type: "pairing", code: "https://remote.example.test/pair#code", expiresAt: Date.now() + 60_000 }

  test("shows the account service's code, narrates the relay, and reports the device that pairs", async () => {
    const { directories, lines, errors, io } = await pairedAccount()
    const service = accountService(() => [pairing, { type: "relay", connection: "connecting", lastError: null }, { type: "relay", connection: "connected", lastError: null }, { type: "paired", label: "Laptop" }])

    await runPair([], { directories, accountRequest: service.accountRequest }, io)

    expect(service.received).toEqual([{ type: "remote.pair.open" }])
    expect(lines).toContain(pairing.code)
    expect(lines.slice(-3)).toEqual(["Relay: connecting", "Attached to the relay; waiting for the phone...", "Paired Laptop."])
    expect(errors).toEqual([])
  })

  test("asks the account service to pair through the relay it names", async () => {
    const { directories, io } = await pairedAccount()
    const service = accountService(() => [pairing, { type: "paired", label: "Laptop" }])

    await runPair(["--relay", "wss://other.example.test"], { directories, accountRequest: service.accountRequest }, io)

    expect(service.received).toEqual([{ type: "remote.pair.open", relayUrl: "wss://other.example.test" }])
  })

  test("fails when the window expires with no device", async () => {
    const { directories, errors, io } = await pairedAccount()
    const service = accountService(() => [pairing, { type: "expired" }])

    await runPair([], { directories, accountRequest: service.accountRequest }, io)

    expect(errors).toEqual(["The pairing window closed without a device pairing."])
    expect(process.exitCode).toBe(1)
  })
})
