import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Log } from "../../../../../src/infra/log.js"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import {
  antigravityAccounts,
  loginAntigravityAccount,
  logoutAntigravityAccount,
  logoutProfileAntigravityAccounts,
} from "../../../../../src/orchestration/modules/provider-google-antigravity/login.js"
import { gateHookHandler } from "../../../../../src/orchestration/modules/provider-google-antigravity/hook-command.js"
import { createLoginObservations } from "../../../../../src/orchestration/modules/provider-google-antigravity/login-status.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { AGY, engineHost, fakeAgy, GOOD_CODE, pastePorts, profile, SIGN_IN_URL } from "./_fake-agy.js"

const temporaryDirectory = temporaryDirectories()

/** A scratch OS account whose own `~/.gemini` holds a sentinel, and the auth directories of two profiles. */
function place() {
  const home = temporaryDirectory("flywheel-antigravity-login-")
  mkdirSync(join(home, ".gemini"), { recursive: true })
  writeFileSync(join(home, ".gemini", "sentinel"), "the person's own Antigravity")
  const profiles = join(home, ".flywheel", "auth", "profiles")
  return { home, authDir: join(profiles, "default"), otherAuthDir: join(profiles, "work") }
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

function loginDirs(authDir: string): string[] {
  const root = join(authDir, "antigravity")
  return existsSync(root) ? readdirSync(root) : []
}

describe("a Google Antigravity login", () => {
  test("of two profiles gives each its own private home, sends agy's URL to the client and the pasted code only to agy, and never touches the person's ~/.gemini", async () => {
    const { home, authDir, otherAuthDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })
    const first = pastePorts(agy.launcher)

    const account = await loginAntigravityAccount(profile(authDir, engineHost(home)), first.ports)
    const other = await loginAntigravityAccount(profile(otherAuthDir, engineHost(home)), pastePorts(agy.launcher).ports)

    expect(first.urls).toEqual([SIGN_IN_URL])
    expect(agy.pasted).toEqual([GOOD_CODE, GOOD_CODE])
    expect(account).toEqual({ accountId: loginDirs(authDir)[0] ?? "", identity: "person@example.com", configDir: join(authDir, "antigravity", account.accountId) })
    expect(other.configDir.startsWith(join(otherAuthDir, "antigravity"))).toBe(true)
    expect(statSync(account.configDir).mode & 0o777).toBe(0o700)
    const record: unknown = JSON.parse(readFileSync(join(account.configDir, "account.json"), "utf8"))
    expect(record).toEqual({ version: 1, accountId: account.accountId, identity: "person@example.com", createdAt: expect.any(String), refreshedAt: expect.any(String) })
    // Every agy launch runs in the login's own private home and workspace, with agy's own sign-in command.
    const launches = agy.agyLaunches()
    expect(launches.map((launch) => launch.command.slice(0, 3))).toEqual([[AGY, "acp", "--login"], [AGY, "acp", "--login"]])
    for (const [index, dir] of [account.configDir, other.configDir].entries()) {
      expect(launches[index]?.env.HOME).toBe(join(dir, "home"))
      expect(launches[index]?.env.GEMINI_HOME).toBe(join(dir, "home", ".gemini"))
      expect(launches[index]?.cwd).toBe(join(dir, "workspace"))
    }
    // The pasted code is in no file, and agy's log of the sign-in, which names the account, is gone.
    for (const file of filesUnder(join(home, ".flywheel"))) expect(readFileSync(file, "utf8")).not.toContain(GOOD_CODE)
    expect(readdirSync(join(account.configDir, "logs"))).toEqual([])
    expect(readdirSync(join(home, ".gemini"))).toEqual(["sentinel"])
    expect(readFileSync(join(home, ".gemini", "sentinel"), "utf8")).toBe("the person's own Antigravity")
    expect(antigravityAccounts(authDir)).toEqual([account])
  })

  test("at this machine runs agy's own browser sign-in through ACP authenticate", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })

    const account = await loginAntigravityAccount(profile(authDir, engineHost(home)), { launcher: agy.launcher, openBrowser: async () => true })

    expect(agy.methods.map((call) => call.method)).toEqual(["initialize", "authenticate"])
    expect(agy.methods[1]?.params).toEqual({ methodId: "oauth-personal" })
    expect(agy.methods[0]?.params).toMatchObject({ clientInfo: { name: "flywheel" } })
    expect(account.identity).toBe("person@example.com")
  })

  test("on a host with no display, such as a container or an SSH session, goes on with the pasted-code sign-in when agy finds no browser", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com", noDisplay: true })
    const pasting = pastePorts(agy.launcher, GOOD_CODE, { openBrowser: async () => false })

    const account = await loginAntigravityAccount(profile(authDir, engineHost(home)), pasting.ports)

    // agy's browser sign-in refuses with no display, and the same login goes on with `agy acp --login`.
    expect(agy.agyLaunches().map((launch) => launch.command.includes("--login"))).toEqual([false, true])
    expect(agy.methods.map((call) => call.method)).toEqual(["initialize", "authenticate"])
    expect(pasting.urls).toEqual([SIGN_IN_URL])
    expect(agy.pasted).toEqual([GOOD_CODE])
    expect(antigravityAccounts(authDir)).toEqual([account])
    expect(readdirSync(join(account.configDir, "logs"))).toEqual([])
  })

  test("on macOS prepares the login's private keychain before agy starts, with only the login's home", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })

    const account = await loginAntigravityAccount(profile(authDir, engineHost(home, "darwin")), pastePorts(agy.launcher).ports)

    const programs = agy.launches.map((launch) => launch.command[0])
    expect(programs.indexOf("/usr/bin/security")).toBeGreaterThanOrEqual(0)
    expect(programs.lastIndexOf("/usr/bin/security")).toBeLessThan(programs.indexOf(AGY))
    const privateHome = join(account.configDir, "home")
    expect(agy.launches.filter((launch) => launch.command[0] === "/usr/bin/security").every((launch) => launch.env.HOME === privateHome)).toBe(true)
    expect(existsSync(join(privateHome, "Library", "Keychains", "flywheel-agy.keychain-db"))).toBe(true)
  })

  test("that agy does not complete removes its new login directory; one whose log shows a keyring call fails as keychain-reached", async () => {
    const { home, authDir } = place()
    const refused = fakeAgy({ identity: "person@example.com" })

    await expect(loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(refused.launcher, "4/wrong").ports)).rejects.toThrow("couldn't log in: token exchange failed")
    expect(loginDirs(authDir)).toEqual([])

    const keyring = fakeAgy({ identity: "person@example.com", keyringLine: "W1121 composite_token_storage.go:561] Keyring SaveToken timed out after 5s" })
    await expect(loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(keyring.launcher).ports)).rejects.toMatchObject({ name: "TokenStoreUnavailableError", reason: "keychain-reached" })
    expect(loginDirs(authDir)).toEqual([])
  })

  test("cancelled by its signal removes a new login directory and lists no account, and a cancelled reconnect keeps the login", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })
    const controller = new AbortController()
    const never = pastePorts(agy.launcher, GOOD_CODE, { signal: controller.signal, onManualCodeInput: () => new Promise(() => {}), onAuthorizeUrl: () => { controller.abort() } })

    await expect(loginAntigravityAccount(profile(authDir, engineHost(home)), never.ports)).rejects.toThrow("Login cancelled")
    expect(loginDirs(authDir)).toEqual([])
    expect(antigravityAccounts(authDir)).toEqual([])

    const account = await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports)
    const again = new AbortController()
    const cancelled = pastePorts(agy.launcher, GOOD_CODE, { signal: again.signal, onManualCodeInput: () => new Promise(() => {}), onAuthorizeUrl: () => { again.abort() } })
    await expect(loginAntigravityAccount(profile(authDir, engineHost(home)), cancelled.ports, account)).rejects.toThrow("Login cancelled")
    expect(antigravityAccounts(authDir)).toEqual([account])
  })

  test("cancelled while agy starts ends agy at once, reports no URL, takes no code, and removes the new login directory", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })
    const controller = new AbortController()
    // The person cancels while the launcher adopts agy, after the login checked its signal.
    const launcher: LauncherScope = {
      ...agy.launcher,
      spawnOwned: async (command, options) => {
        const owned = await agy.launcher.spawnOwned(command, options)
        if (command[0] === AGY) controller.abort()
        return owned
      },
    }
    const cancelled = pastePorts(launcher, GOOD_CODE, { signal: controller.signal })

    await expect(loginAntigravityAccount(profile(authDir, engineHost(home)), cancelled.ports)).rejects.toThrow("Login cancelled")
    expect(cancelled.urls).toEqual([])
    expect(agy.pasted).toEqual([])
    expect(loginDirs(authDir)).toEqual([])
  })

  test("again in the same place keeps its directory and record but its refresh time; another Google account is refused and leaves the login as it was", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })
    const account = await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports)
    const recordPath = join(account.configDir, "account.json")
    const before = readFileSync(recordPath, "utf8")
    const refreshTime = (text: string) => /"refreshedAt": "([^"]+)"/u.exec(text)?.[1]
    await Bun.sleep(2)

    expect(await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports, account)).toEqual(account)
    const after = readFileSync(recordPath, "utf8")
    const withoutRefresh = (text: string) => text.replace(/"refreshedAt": "[^"]+"/u, "")
    expect(withoutRefresh(after)).toBe(withoutRefresh(before))
    expect(refreshTime(after)).not.toBe(refreshTime(before))
    expect(loginDirs(authDir)).toEqual([account.accountId])

    const unchanged = readFileSync(recordPath, "utf8")
    const observations = createLoginObservations()
    observations.recordRequest(account.configDir, "login-rejected")
    const other = fakeAgy({ identity: "someone-else@example.com" })
    await expect(loginAntigravityAccount(profile(authDir, engineHost(home), observations), pastePorts(other.launcher).ports, account)).rejects.toMatchObject({ name: "AccountMismatchError", expected: "person@example.com", found: "someone-else@example.com" })
    expect(readFileSync(recordPath, "utf8")).toBe(unchanged)
    expect(other.methods.map((call) => call.method)).toEqual([])
    expect(observations.outcome(account.configDir)).toBe("login-rejected")
    expect(loginDirs(authDir)).toEqual([account.accountId])
  })
})

describe("a Google Antigravity logout", () => {
  test("waits until no engine runs on the login, then runs agy's logout there and removes only that login before any engine may start on it again", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })
    const first = await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports)
    const sibling = await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports)
    const siblingFiles = filesUnder(sibling.configDir).map((file) => [relative(sibling.configDir, file), readFileSync(file, "utf8")])
    const lease = Promise.withResolvers<void>()
    const released: string[] = []
    const atRelease: { readonly loggedOut: boolean; readonly folderKept: boolean }[] = []
    const withLoginReleased = async <T>(loginDir: string, _signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
      released.push(loginDir)
      await lease.promise
      const result = await work()
      atRelease.push({ loggedOut: agy.methods.some((call) => call.method === "logout"), folderKept: existsSync(loginDir) })
      return result
    }

    const logout = logoutAntigravityAccount(profile(authDir, engineHost(home), undefined, withLoginReleased), first.accountId, { launcher: agy.launcher })
    await Bun.sleep(5)
    expect(released).toEqual([first.configDir])
    expect(agy.methods.filter((call) => call.method === "logout")).toEqual([])
    lease.resolve()
    await logout
    expect(atRelease).toEqual([{ loggedOut: true, folderKept: false }])

    expect(agy.methods.filter((call) => call.method === "logout").map((call) => call.home)).toEqual([join(first.configDir, "home")])
    expect(existsSync(first.configDir)).toBe(false)
    expect(filesUnder(sibling.configDir).map((file) => [relative(sibling.configDir, file), readFileSync(file, "utf8")])).toEqual(siblingFiles)
    expect(antigravityAccounts(authDir)).toEqual([sibling])
  })

  test("of a login that another live Flywheel process serves is refused before agy runs, as is a login again there, and every file stays until that process is gone", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com" })
    const account = await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports)
    // The test runner that started this process is alive and is not this process: its engines serve the login.
    const foreign = join(account.configDir, "processes", "other.json")
    mkdirSync(join(account.configDir, "processes"), { recursive: true })
    writeFileSync(foreign, JSON.stringify({ pid: process.ppid, pendingOpens: 0, sessions: [] }))
    const files = filesUnder(account.configDir).map((file) => [relative(account.configDir, file), readFileSync(file, "utf8")])
    const runs = agy.launches.length

    // The caller runs another executable, whose hook would differ from the owner's.
    const other = { ...profile(authDir, engineHost(home)), gateHook: (loginDir: string) => gateHookHandler({ address: join(loginDir, "gate"), loginGateId: "gate", entry: ["/opt/other/flywheel"], platform: "linux" }) }
    await expect(logoutAntigravityAccount(other, account.accountId, { launcher: agy.launcher })).rejects.toThrow("Another Flywheel process serves the Google Antigravity login")
    await expect(loginAntigravityAccount(other, pastePorts(agy.launcher).ports, account)).rejects.toMatchObject({ name: "EngineUnavailableError", reason: "login-in-use" })
    expect({ runs: agy.launches.length, files: filesUnder(account.configDir).map((file) => [relative(account.configDir, file), readFileSync(file, "utf8")]) }).toEqual({ runs, files })

    rmSync(foreign)
    await logoutAntigravityAccount(other, account.accountId, { launcher: agy.launcher })
    expect(existsSync(account.configDir)).toBe(false)
  })

  test("whose agy step fails keeps the login directory and names the account; a profile logout tries every login", async () => {
    const { home, authDir } = place()
    const agy = fakeAgy({ identity: "person@example.com", logoutFails: false })
    const account = await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports)
    await loginAntigravityAccount(profile(authDir, engineHost(home)), pastePorts(agy.launcher).ports)
    const failing = fakeAgy({ identity: "person@example.com", logoutFails: true })

    await expect(logoutAntigravityAccount(profile(authDir, engineHost(home)), account.accountId, { launcher: failing.launcher })).rejects.toThrow("The Google Antigravity logout of person@example.com did not complete")
    expect(antigravityAccounts(authDir).map((found) => found.accountId)).toContain(account.accountId)

    await expect(logoutProfileAntigravityAccounts(profile(authDir, engineHost(home)), { launcher: failing.launcher })).rejects.toThrow("2 Google Antigravity logins of the profile did not end")
    expect(failing.methods.filter((call) => call.method === "logout")).toHaveLength(3)
    expect(loginDirs(authDir)).toHaveLength(2)

    await logoutProfileAntigravityAccounts(profile(authDir, engineHost(home)), { launcher: agy.launcher })
    expect(loginDirs(authDir)).toEqual([])
  })
})

describe("the Google Antigravity accounts of a profile", () => {
  test("skip an account record of an unknown shape with one warning and leave its file as it is", () => {
    const { authDir } = place()
    const loginDir = join(authDir, "antigravity", "future")
    mkdirSync(loginDir, { recursive: true })
    const text = JSON.stringify({ version: 2, accountId: "future", identity: "person@example.com" })
    writeFileSync(join(loginDir, "account.json"), text)
    const warning = spyOn(Log.create({ service: "provider-google-antigravity" }), "warn").mockImplementation(() => {})
    try {
      expect(antigravityAccounts(authDir)).toEqual([])
      expect(antigravityAccounts(authDir)).toEqual([])
      expect(warning.mock.calls.filter(([message]) => String(message).includes("account record")).map(([, fields]) => fields)).toEqual([{ path: join(loginDir, "account.json"), bytes: text.length }])
    } finally {
      warning.mockRestore()
    }
    expect(readFileSync(join(loginDir, "account.json"), "utf8")).toBe(text)
  })
})
