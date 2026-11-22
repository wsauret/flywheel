import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { QUALIFIED_ANTIGRAVITY_VERSION, type AntigravityPinnedBytes } from "../../../../../src/infra/antigravity-engine.js"
import { AcpRequestError } from "../../../../../src/orchestration/modules/provider-google-antigravity/acp/connection.js"
import { acpRequestFailure } from "../../../../../src/orchestration/modules/provider-google-antigravity/errors.js"
import { antigravityLogins, googleAntigravityLogin } from "../../../../../src/orchestration/modules/provider-google-antigravity/login.js"
import { antigravityLoginHealth, createLoginObservations, EngineCannotStartError, loginFailure } from "../../../../../src/orchestration/modules/provider-google-antigravity/login-status.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { engineHost, fakeAgy, pastePorts, profile } from "./_fake-agy.js"

const temporaryDirectory = temporaryDirectories()

/** An engine file and the pin of its bytes. */
function engineFile(home: string) {
  const bytes = "the pinned agy"
  const path = join(home, "bin", "agy")
  mkdirSync(join(home, "bin"), { recursive: true })
  writeFileSync(path, bytes)
  const pinned: AntigravityPinnedBytes = { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  return { path, pinned }
}

/** Two accounts of one profile, logged in through the provider's login strategy on the fake engine. */
async function twoAccounts() {
  const home = temporaryDirectory("flywheel-antigravity-status-")
  const authDir = join(home, ".flywheel", "auth", "profiles", "default")
  const observations = createLoginObservations()
  const agy = fakeAgy({ identity: "a@example.com" })
  const strategy = googleAntigravityLogin(observations, (dir) => profile(dir, engineHost(home)))
  const a = await strategy.login(authDir, pastePorts(agy.launcher).ports)
  const b = await strategy.login(authDir, pastePorts(fakeAgy({ identity: "b@example.com" }).launcher).ports)
  return { home, authDir, observations, strategy, a, b }
}

describe("what a request tells about a Google Antigravity login", () => {
  test("agy's Authentication required refuses the login, an engine that cannot start and an engine exit are their own failures", () => {
    expect(loginFailure(acpRequestFailure(new AcpRequestError("session/new", { code: -32000, message: "Authentication required" })), false)).toBe("login-rejected")
    expect(loginFailure(new EngineCannotStartError("no verified Antigravity CLI", undefined), false)).toBe("program-cannot-start")
    expect(loginFailure(undefined, true)).toBe("program-exited")
    expect(loginFailure(undefined, false)).toBeUndefined()
  })

  test("a refused login is a problem of that account only, its waits join one question, and a login of another account does not renew them", async () => {
    const { authDir, observations, strategy, a, b } = await twoAccounts()
    observations.recordRequest(a.configDir, "login-rejected")

    expect(strategy.problems(authDir)).toEqual([{ kind: "login-rejected", accountId: a.accountId, message: "Google Antigravity refused this account's login in this profile. Log in again." }])
    const answers: string[] = []
    const first = strategy.awaitLogin(authDir, a.accountId, new AbortController().signal).then((answer) => { answers.push(answer) })
    const second = strategy.awaitLogin(authDir, a.accountId, new AbortController().signal).then((answer) => { answers.push(answer) })
    expect(await strategy.awaitLogin(authDir, b.accountId, new AbortController().signal)).toBe("renewed")
    const questions = strategy.loginQuestions()
    expect(questions).toHaveLength(1)
    const question = questions[0]
    if (question === undefined) throw new Error("no question")
    expect(question.account.accountId).toBe(a.accountId)
    expect(strategy.answerLogin(question.id, "renewed")?.phase).toBe("logging-in")

    // The person signs in to a new login instead of the refused one: the refused account still waits.
    const ports = pastePorts(fakeAgy({ identity: "c@example.com" }).launcher, undefined, { loginQuestionId: question.id }).ports
    await expect(strategy.login(authDir, ports)).rejects.toThrow("The login used a different account: c@example.com")
    await Bun.sleep(1)
    expect(answers).toEqual([])

    // A login again of the refused account renews its waits only once the runtime settles the question.
    await strategy.login(authDir, pastePorts(fakeAgy({ identity: "a@example.com" }).launcher, undefined, { loginQuestionId: question.id }).ports, a)
    await Bun.sleep(1)
    expect(answers).toEqual([])
    expect(strategy.problems(authDir)).toHaveLength(1)
    strategy.settleLogin(question.id, "renewed")
    await Promise.all([first, second])
    expect(answers).toEqual(["renewed", "renewed"])
    expect(strategy.problems(authDir)).toEqual([])
  })

  test("a login of the refused account whose settlement the runtime declines ends its waits declined and keeps the problem", async () => {
    const { authDir, observations, strategy, a } = await twoAccounts()
    observations.recordRequest(a.configDir, "login-rejected")
    const waiting = strategy.awaitLogin(authDir, a.accountId, new AbortController().signal)
    const question = strategy.loginQuestions()[0]
    if (question === undefined) throw new Error("no question")
    strategy.answerLogin(question.id, "renewed")

    await strategy.login(authDir, pastePorts(fakeAgy({ identity: "a@example.com" }).launcher, undefined, { loginQuestionId: question.id }).ports, a)
    strategy.settleLogin(question.id, "declined")

    expect(await waiting).toBe("declined")
    expect(strategy.problems(authDir).map((problem) => problem.accountId)).toEqual([a.accountId])
  })
})

describe("the Google Antigravity section of /doctor", () => {
  test("names the engine against its qualified version, each login folder, its token store and last observation, and states that token presence is not checked", async () => {
    const { home, authDir, observations, a, b } = await twoAccounts()
    const engine = engineFile(home)
    observations.recordTokenStoreObservation(a.configDir, { fileStorageReason: "no D-Bus session bus detected", keyringFailures: [] })
    observations.recordRequest(a.configDir, "served")
    observations.recordTokenStoreObservation(b.configDir, { keyringFailures: ["credential-manager-unavailable"] })

    const report = await antigravityLoginHealth(antigravityLogins(authDir), observations, { enginePath: () => engine.path, pinned: engine.pinned })

    expect(report.attention).toBe(false)
    expect(report.lines[0]).toBe(`Antigravity CLI: version ${QUALIFIED_ANTIGRAVITY_VERSION} (the qualified version, its bytes verified against the pin), at ${engine.path}.`)
    expect(report.lines).toContain("a@example.com: logged in, as far as this process observed")
    expect(report.lines).toContain(`a@example.com login folder: ${a.configDir}. Token store: a file in the login's private home; last observation: file storage, because no D-Bus session bus detected. Token presence: not checked (Flywheel reads no Antigravity credential). Last request in this process: served.`)
    expect(report.lines.filter((line) => line.startsWith("b@example.com login folder:"))).toHaveLength(1)
    expect(report.lines.find((line) => line.startsWith("b@example.com login folder:"))).toContain("last observation: file storage, because the OS credential manager is unavailable.")
  })

  test("needs attention for an engine of another version, a missing engine, a refused login, and a keyring that an engine reached", async () => {
    const { home, authDir, observations, a, b } = await twoAccounts()
    const engine = engineFile(home)
    const logins = antigravityLogins(authDir)

    const other = await antigravityLoginHealth(logins, observations, { enginePath: () => engine.path, pinned: { ...engine.pinned, sha256: "0".repeat(64) } })
    expect(other.attention).toBe(true)
    expect(other.lines[0]).toBe(`The Antigravity CLI at ${engine.path} cannot serve: it does not hold the bytes of the qualified version ${QUALIFIED_ANTIGRAVITY_VERSION}. Reinstall Flywheel, or run bun run engine:antigravity:prepare in a source checkout.`)

    const unpinned = await antigravityLoginHealth(logins, observations, { enginePath: () => engine.path, pinned: undefined })
    expect(unpinned.attention).toBe(true)
    expect(unpinned.lines[0]).toBe("The Antigravity CLI cannot serve: Flywheel pins no Antigravity CLI for this platform.")

    const missing = await antigravityLoginHealth(logins, observations, { enginePath: () => { throw new Error("This checkout has no verified Antigravity CLI.") }, pinned: engine.pinned })
    expect(missing.attention).toBe(true)
    expect(missing.lines[0]).toBe("The Antigravity CLI cannot start: This checkout has no verified Antigravity CLI.")

    observations.recordRequest(a.configDir, "login-rejected")
    observations.recordTokenStoreObservation(b.configDir, { keyringFailures: ["timed-out"] })
    const report = await antigravityLoginHealth(logins, observations, { enginePath: () => engine.path, pinned: engine.pinned })
    expect(report.attention).toBe(true)
    expect(report.lines).toContain("a@example.com: Google Antigravity refused this account's login in this profile. Log in again.")
    expect(report.lines.find((line) => line.startsWith("b@example.com login folder:"))).toContain("last observation: the engine reached a keyring that it must not use (timed-out)")
  })
})
