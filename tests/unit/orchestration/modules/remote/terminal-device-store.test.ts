import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { openTerminalDeviceStore, terminalPairedMachineCount } from "../../../../../src/orchestration/modules/remote/terminal-device-store.js"
import { deviceIdentity } from "../../../../../src/protocol/modules/remote/relay-device.js"
import { keyDigest, ownedBytes } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

/** The terminal's device store is a credential file: whoever holds the device
 *  key attaches as this terminal to every machine it paired with. It keeps
 *  the same rules as the machine's pairing store: private on disk, never
 *  readable from memory, and never emptied by a shape it cannot read. */

const machine = { runtimeId: "r".repeat(43), publicKey: "p".repeat(43), relay: "wss://relay.example", label: "Box", pairedAt: 1 }
const temporary = temporaryDirectories()
const dirs = (): string => temporary("flywheel-terminal-device-")

describe("terminal device store", () => {
  test("creates one device key, signs with it, and keeps it across opens", async () => {
    const root = dirs()
    const first = await openTerminalDeviceStore(root, "laptop")
    const second = await openTerminalDeviceStore(root, "laptop")
    expect(second.device.deviceId).toBe(first.device.deviceId)
    expect(first.device.deviceId).toBe(await keyDigest(first.device.publicKey))
    expect(first.device.keyPair.privateKey.extractable).toBe(false)
    const message = new TextEncoder().encode("challenge")
    const signature = await deviceIdentity(second.device).sign(message)
    expect(await crypto.subtle.verify("Ed25519", first.device.keyPair.publicKey, ownedBytes(signature), message)).toBe(true)
  })

  test("writes the file private to the account and states its version", async () => {
    const root = dirs()
    await openTerminalDeviceStore(root, "laptop")
    const file = join(root, "auth", "remote-device.json")
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1)
    if (process.platform === "win32") return
    expect(statSync(file).mode & 0o077).toBe(0)
    expect(statSync(join(root, "auth")).mode & 0o077).toBe(0)
  })

  test("names the device by the host until the person names it, and keeps machines and the last choice", async () => {
    const root = dirs()
    const store = await openTerminalDeviceStore(root, "laptop")
    expect(store.label()).toBe("laptop")
    await store.setLabel("Work laptop")
    await store.putRuntime(machine)
    await store.setSelection({ runtimeId: machine.runtimeId, placementId: "q".repeat(43) })
    const reopened = await openTerminalDeviceStore(root, "laptop")
    expect(reopened.label()).toBe("Work laptop")
    expect(await reopened.runtimes()).toEqual([machine])
    expect(await reopened.selection()).toEqual({ runtimeId: machine.runtimeId, placementId: "q".repeat(43) })
    expect(terminalPairedMachineCount(root)).toBe(1)
    await reopened.putRuntime({ ...machine, label: "Box again" })
    await reopened.removeRuntime("other")
    expect(await reopened.runtimes()).toEqual([{ ...machine, label: "Box again" }])
    await reopened.removeRuntime(machine.runtimeId)
    await reopened.setSelection(undefined)
    expect(terminalPairedMachineCount(root)).toBe(0)
    expect(await reopened.selection()).toBeUndefined()
  })

  test("counts no machine and creates no file before the terminal first pairs", () => {
    const root = dirs()
    expect(terminalPairedMachineCount(root)).toBe(0)
    expect(() => statSync(join(root, "auth", "remote-device.json"))).toThrow()
  })

  test("refuses a file it cannot read and leaves it as it is", async () => {
    const root = dirs()
    mkdirSync(join(root, "auth"), { recursive: true, mode: 0o700 })
    const file = join(root, "auth", "remote-device.json")
    const future = JSON.stringify({ version: 2, somethingNew: true })
    writeFileSync(file, future, { mode: 0o600 })
    await expect(openTerminalDeviceStore(root, "laptop")).rejects.toThrow("not in a shape this Flywheel reads")
    expect(() => terminalPairedMachineCount(root)).toThrow("not in a shape this Flywheel reads")
    expect(readFileSync(file, "utf8")).toBe(future)
  })
})
