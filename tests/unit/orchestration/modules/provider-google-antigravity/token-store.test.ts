import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { OwnedCommandOptions, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { keychainReachedFailure, prepareTokenStore, tokenStoreObservation } from "../../../../../src/orchestration/modules/provider-google-antigravity/token-store.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()

/** A `/usr/bin/security` that keeps the search list and the default keychain of each `HOME`, as the real one does,
 *  makes the keychain file that `create-keychain` names, and records each call with the words of any `-i` line. The
 *  first call of the verb `failsOnce` fails. */
function fakeSecurity(options: { readonly keepsSettings?: boolean; readonly failsOnce?: string } = {}) {
  const calls: { readonly words: readonly string[]; readonly argv: readonly string[]; readonly env: OwnedCommandOptions["env"] }[] = []
  const settings = new Map<string, { list: string[]; fallback: string[] }>()
  let failed = false
  const run: OwnedCommandRunner = async (command, runOptions) => {
    const home = runOptions?.env?.HOME ?? ""
    const words = command[1] === "-i" ? (runOptions?.stdin ?? "").trim().split(" ") : command.slice(1)
    calls.push({ words, argv: command, env: runOptions?.env })
    const keychain = (name: string) => join(home, "Library", "Keychains", name)
    const state = settings.get(home) ?? { list: [], fallback: [] }
    settings.set(home, state)
    let stdout = ""
    const [verb] = words
    if (verb === options.failsOnce && !failed) {
      failed = true
      return { exitCode: 51, stdout, stdoutBytes: new Uint8Array(), stderr: "", timedOut: false }
    }
    if (verb === "create-keychain") writeFileSync(keychain(words.at(-1) ?? ""), "keychain")
    if (verb === "list-keychains" && words.includes("-s")) state.list = options.keepsSettings === false ? [] : [keychain(words.at(-1) ?? "")]
    else if (verb === "list-keychains") stdout = state.list.map((path) => `    "${path}"\n`).join("")
    if (verb === "default-keychain" && words.includes("-s")) state.fallback = options.keepsSettings === false ? [] : [keychain(words.at(-1) ?? "")]
    else if (verb === "default-keychain") stdout = state.fallback.map((path) => `    "${path}"\n`).join("")
    return { exitCode: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", timedOut: false }
  }
  return { run, calls }
}

describe("the token store of a macOS login", () => {
  test("is a private keychain, made once with a password that never reaches a command line, and named as the only and default keychain of the login's home before each launch", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-keychain-")
    const security = fakeSecurity()
    const home = join(loginDir, "home")

    expect(await prepareTokenStore(loginDir, { platform: "darwin", run: security.run })).toBe("private-keychain")
    const first = security.calls.length
    expect(await prepareTokenStore(loginDir, { platform: "darwin", run: security.run })).toBe("private-keychain")

    const password = readFileSync(join(loginDir, "keychain-password"), "utf8").trim()
    expect(password).toMatch(/^[0-9a-f]{64}$/u)
    expect(statSync(join(loginDir, "keychain-password")).mode & 0o777).toBe(0o600)
    expect(security.calls.map((call) => call.words.filter((word) => word !== password).join(" "))).toEqual([
      "create-keychain -p flywheel-agy.keychain-db",
      "unlock-keychain -p flywheel-agy.keychain-db",
      "set-keychain-settings flywheel-agy.keychain-db",
      "list-keychains -d user -s flywheel-agy.keychain-db",
      "default-keychain -d user -s flywheel-agy.keychain-db",
      "list-keychains -d user",
      "default-keychain -d user",
      // The next launch makes no keychain and keeps the password, and unlocks the keychain before any other call.
      "unlock-keychain -p flywheel-agy.keychain-db",
      "set-keychain-settings flywheel-agy.keychain-db",
      "list-keychains -d user -s flywheel-agy.keychain-db",
      "default-keychain -d user -s flywheel-agy.keychain-db",
      "list-keychains -d user",
      "default-keychain -d user",
    ])
    expect(security.calls.slice(first).filter((call) => call.words.includes(password))).toHaveLength(1)
    expect(security.calls.every((call) => !call.argv.includes(password))).toBe(true)
    expect(security.calls.every((call) => JSON.stringify(call.env) === JSON.stringify({ HOME: home }))).toBe(true)
    // `security` keeps a home's search list only in a preferences folder that exists.
    expect(existsSync(join(home, "Library", "Preferences"))).toBe(true)
  })

  test("is refused before any launch when the keychain settings do not read back, as when `security` keeps no search list", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-keychain-")

    await expect(prepareTokenStore(loginDir, { platform: "darwin", run: fakeSecurity({ keepsSettings: false }).run })).rejects.toMatchObject({ name: "TokenStoreUnavailableError", reason: "keychain-unprepared" })
  })

  test("is refused when the keychain does not unlock", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-keychain-")

    await expect(prepareTokenStore(loginDir, { platform: "darwin", run: fakeSecurity({ failsOnce: "unlock-keychain" }).run })).rejects.toThrow("`security unlock-keychain` exited with code 51")
  })

  test("ends with no lock timeout after a preparation that stopped between making the keychain and its settings", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-keychain-")
    const security = fakeSecurity({ failsOnce: "set-keychain-settings" })

    await expect(prepareTokenStore(loginDir, { platform: "darwin", run: security.run })).rejects.toMatchObject({ reason: "keychain-unprepared" })
    expect(await prepareTokenStore(loginDir, { platform: "darwin", run: security.run })).toBe("private-keychain")
    expect(security.calls.filter((call) => call.words[0] === "set-keychain-settings")).toHaveLength(2)
    expect(security.calls.filter((call) => call.words[0] === "create-keychain")).toHaveLength(1)
  })

  test("is refused when its password file is gone, and no new keychain replaces the one that holds the token", async () => {
    const loginDir = temporaryDirectory("flywheel-antigravity-keychain-")
    const security = fakeSecurity()
    await prepareTokenStore(loginDir, { platform: "darwin", run: security.run })
    rmSync(join(loginDir, "keychain-password"))

    await expect(prepareTokenStore(loginDir, { platform: "darwin", run: security.run })).rejects.toMatchObject({ reason: "keychain-unprepared" })
    expect(security.calls.filter((call) => call.words[0] === "create-keychain")).toHaveLength(1)
  })
})

describe("the token store elsewhere", () => {
  test("is the engine's own file on Linux and the Credential Manager on Windows, and needs no command", async () => {
    const security = fakeSecurity()

    expect(await prepareTokenStore("/scratch/login", { platform: "linux", run: security.run })).toBe("engine-file")
    expect(await prepareTokenStore("C:\\scratch\\login", { platform: "win32", run: security.run })).toBe("credential-manager")
    expect(security.calls).toEqual([])
  })
})

describe("the engine log's account of its token store", () => {
  test("names the file-storage reason of a Linux engine with no session bus, and no keyring failure", () => {
    const observation = tokenStoreObservation([
      "I1122 06:38:22.025470      69 composite_token_storage.go:176] Using file-based token storage because no D-Bus session bus detected",
      "I1122 06:38:22.031873     194 keyring.go:64] keyringAuth: loaded token, expiry=2026-11-21 23:23:10 expired=false",
    ])

    expect(observation).toEqual({ fileStorageReason: "no D-Bus session bus detected", keyringFailures: [] })
    expect(keychainReachedFailure(observation)).toBeUndefined()
  })

  test("records a Windows Credential Manager that is unavailable, and does not fail the engine that falls back to a file in its home", () => {
    const observation = tokenStoreObservation([
      "W1122 09:02:54.294111      27 auth_store.go:162] OS credential manager unavailable (A specified logon session does not exist. It may already have been terminated.); falling back to file-based secret storage",
      "I1122 09:02:54.294111      27 auth_store.go:199] Using file-based secret storage at C:\\scratch\\login\\home\\AppData\\Roaming\\antigravity\\plugin-secrets.json",
    ])

    expect(observation).toEqual({ keyringFailures: ["credential-manager-unavailable"] })
    expect(keychainReachedFailure(observation)).toBeUndefined()
  })

  test("fails the engine whose keyring call waited, as one that a keychain dialog holds up", () => {
    const failure = keychainReachedFailure(tokenStoreObservation([
      "W1121 22:17:03.000000      12 composite_token_storage.go:300] Keyring SaveToken timed out after 5s, using file-based token storage",
      "W1121 22:17:03.100000      12 composite_token_storage.go:310] keyring writes disabled after an earlier keyring write failure",
    ]))

    expect(failure).toMatchObject({ name: "TokenStoreUnavailableError", reason: "keychain-reached" })
    expect(failure?.message).toContain("timed-out, writes-disabled")
  })
})
