import { randomBytes } from "node:crypto"
import { Redacted } from "effect"
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, join } from "node:path"
import { antigravityHomeLayout } from "../../../../infra/providers/antigravity-engine.js"
import { writeFileAtomic } from "../../../../infra/platform/files/atomic-write.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import type { OwnedCommandRunner } from "../../../../infra/owned-command.js"
import { RouteUnavailableError } from "../../../agent-runtime/llm/errors.js"

// Where agy 1.5.14 keeps its sign-in token (plan P16, Q13). Its keyring
// library runs `/usr/bin/security` by absolute path on macOS, and the binary
// has no documented or caller-level switch to file storage for `agy acp`. When
// the default keychain that `security` finds is missing, macOS shows the person
// "Keychain Not Found"; when it is locked, an unlock dialog. `security` finds
// its keychain search list and default keychain through `HOME`
// (`~/Library/Preferences/com.apple.security.plist`), and every engine runs
// with the login's private `HOME`, so each macOS login gets a keychain of its
// own there: the only keychain in that list, the default, unlocked before each
// launch, and with no lock timeout. The person's own keychains are then
// unreachable for the engine, and no `security` call of the engine can find a
// missing or locked keychain. On Linux the engine's environment has no session
// bus, so it keeps the token in a file of its home; on Windows it uses the
// Credential Manager, which shows no dialog.

const log = Log.create({ service: "provider-google-antigravity" })

/** The private keychain of a macOS login, by the bare name that `security` resolves in `~/Library/Keychains` of the
 *  engine's `HOME`. A bare name also keeps the login directory's path out of the `security -i` command lines. */
const KEYCHAIN_NAME = "flywheel-agy.keychain-db"
const SECURITY = "/usr/bin/security"

/** Where the engine of a login keeps its token: its private keychain (macOS), a file in its home (Linux, no session
 *  bus), or the Windows Credential Manager. */
export type TokenStoreKind = "private-keychain" | "engine-file" | "credential-manager"

/** Why a login's engine must not start, or must stop: its private keychain could not be prepared
 *  (`keychain-unprepared`), or the engine's log shows a keyring call that the token store should have made
 *  impossible (`keychain-reached`), such as a call that waited for a dialog. */
export class TokenStoreUnavailableError extends RouteUnavailableError {
  constructor(readonly reason: "keychain-unprepared" | "keychain-reached", message: string) {
    super(message)
    this.name = "TokenStoreUnavailableError"
  }
}

function keychainPaths(loginDir: string) {
  const { home } = antigravityHomeLayout(loginDir)
  const keychains = join(home, "Library", "Keychains")
  return {
    home,
    keychains,
    preferences: join(home, "Library", "Preferences"),
    keychain: join(keychains, KEYCHAIN_NAME),
    password: join(loginDir, "keychain-password"),
  }
}

/**
 * Makes the token store of the login directory `loginDir` ready for the next engine launch on `platform`, and returns
 * its kind. Call it before every launch (login, logout, discovery, serving): an engine never starts on a login whose
 * store this call did not prepare. On macOS it makes the login's private keychain once, with a random password that
 * only the login directory holds (0600), and on each call unlocks it, turns off its lock timeout, names it as the
 * only and the default keychain of the login's `HOME`, and reads both names back. Every `security` command runs
 * through `run` with only the login's `HOME`, so none reads or changes a keychain setting of the person; the password
 * reaches `security` on its standard input, never on its command line. Elsewhere it changes nothing. Rejects with
 * `TokenStoreUnavailableError` (`keychain-unprepared`) when a command fails or the settings do not read back.
 */
export async function prepareTokenStore(loginDir: string, options: { readonly platform: NodeJS.Platform; readonly run: OwnedCommandRunner }): Promise<TokenStoreKind> {
  if (options.platform === "win32") return "credential-manager"
  if (options.platform !== "darwin") return "engine-file"
  const paths = keychainPaths(loginDir)
  // `security` stores the search list in the preferences folder of `HOME`, and silently keeps none when it is absent.
  for (const folder of [paths.keychains, paths.preferences]) mkdirSync(folder, { recursive: true, mode: 0o700 })
  const security = async (args: readonly string[], stdin?: string) => {
    const result = await options.run([SECURITY, ...args], { env: { HOME: paths.home }, ...(stdin === undefined ? {} : { stdin }) })
    if (result.exitCode !== 0) throw new TokenStoreUnavailableError("keychain-unprepared", `The private keychain of the Google Antigravity login at ${loginDir} could not be prepared: \`security ${(stdin ?? args[0] ?? "").split(" ")[0] ?? ""}\` exited with code ${String(result.exitCode)}.`)
    return result.stdout
  }
  // A command that carries the password runs as one line of `security -i`, which reads it from standard input and
  // exits with that command's status. Its words are the hex password and the bare keychain name, which need no
  // quoting. The password is unwrapped only here and in the password file.
  const password = keychainPassword(paths)
  const withPassword = (verb: "create-keychain" | "unlock-keychain") => security(["-i"], `${verb} -p ${Redacted.value(password)} ${KEYCHAIN_NAME}\n`)
  if (!existsSync(paths.keychain)) {
    await withPassword("create-keychain")
    log.info("Google Antigravity login keychain created", { login: basename(loginDir) })
  }
  // Unlocked first: a locked keychain (after a restart, or a sleep before the settings below held) makes a `security`
  // call that needs it ask the person for its password.
  await withPassword("unlock-keychain")
  // A keychain locks after 5 minutes and on sleep by default. Set on every call, so that a preparation that stopped
  // after the keychain was made still ends with no lock timeout.
  await security(["set-keychain-settings", KEYCHAIN_NAME])
  await security(["list-keychains", "-d", "user", "-s", KEYCHAIN_NAME])
  await security(["default-keychain", "-d", "user", "-s", KEYCHAIN_NAME])
  const listed = keychainList(await security(["list-keychains", "-d", "user"]))
  const fallback = keychainList(await security(["default-keychain", "-d", "user"]))
  // `security` names a keychain by its resolved path, which differs from ours when `HOME` lies behind a link (/var).
  const isPrivate = (keychains: readonly string[]) => keychains.length === 1 && existsSync(keychains[0] ?? "") && realpathSync(keychains[0] ?? "") === realpathSync(paths.keychain)
  if (!isPrivate(listed) || !isPrivate(fallback)) {
    throw new TokenStoreUnavailableError("keychain-unprepared", `The private keychain of the Google Antigravity login at ${loginDir} is not the only and default keychain of its home.`)
  }
  return "private-keychain"
}

/** The password of the login's private keychain: the one its file holds, or, for a login with no keychain yet, a new
 *  random one, written before the keychain exists so that no keychain is ever made with a password that is lost. */
function keychainPassword(paths: ReturnType<typeof keychainPaths>): Redacted.Redacted<string> {
  if (existsSync(paths.password)) return Redacted.make(readFileSync(paths.password, "utf8").trim())
  if (existsSync(paths.keychain)) throw new TokenStoreUnavailableError("keychain-unprepared", `The private keychain ${paths.keychain} has no password file. Sign in to Google Antigravity again.`)
  const password = Redacted.make(randomBytes(32).toString("hex"))
  writeFileAtomic(paths.password, `${Redacted.value(password)}\n`, { mode: 0o600 })
  return password
}

/** The keychain paths of a `security list-keychains` or `default-keychain` answer: one quoted path per line. */
function keychainList(output: string): string[] {
  return output.split("\n").map((line) => line.trim().replace(/^"(.*)"$/u, "$1")).filter((line) => line.length > 0)
}

/** What the engine's own log says about its token store. */
export interface TokenStoreObservation {
  /** The reason agy gave for file storage (`Using file-based token storage because <reason>`), such as `no D-Bus
   *  session bus detected` on Linux. */
  readonly fileStorageReason?: string
  /** Keyring calls that timed out or failed, by kind: a call that waits is one that a dialog or a missing keyring
   *  holds up. */
  readonly keyringFailures: readonly ("timed-out" | "load-failed" | "writes-disabled" | "credential-manager-unavailable")[]
}

const KEYRING_FAILURES = [
  [/Keyring \w+ timed out after|keyringAuth: timed out after/u, "timed-out"],
  [/Failed to load token from keyring, falling back to file/u, "load-failed"],
  [/keyring writes disabled after an earlier keyring write failure/u, "writes-disabled"],
  [/OS credential manager unavailable/u, "credential-manager-unavailable"],
] as const

/** Reads the token-store lines of the engine log `logLines`: agy's own statements about file storage and about
 *  keyring calls that timed out or failed. It reads no other line. */
export function tokenStoreObservation(logLines: readonly string[]): TokenStoreObservation {
  let fileStorageReason: string | undefined
  const keyringFailures: TokenStoreObservation["keyringFailures"][number][] = []
  for (const line of logLines) {
    fileStorageReason ??= /Using file-based token storage because (.+)$/u.exec(line)?.[1]?.trim()
    for (const [pattern, kind] of KEYRING_FAILURES) if (pattern.test(line)) keyringFailures.push(kind)
  }
  return { ...(fileStorageReason === undefined ? {} : { fileStorageReason }), keyringFailures }
}

/** The kinds of keyring call in `observation` that reached an OS store, once each. An OS credential manager that is
 *  unavailable is no reach: agy reached no OS store and kept its secret in a file of the private home (a Windows
 *  logon with no Credential Manager, such as SSH). */
export function reachedKeyringKinds(observation: TokenStoreObservation): readonly TokenStoreObservation["keyringFailures"][number][] {
  return [...new Set(observation.keyringFailures.filter((kind) => kind !== "credential-manager-unavailable"))]
}

/** The failure of an engine whose log shows a keyring call that failed or waited, which the prepared token store
 *  makes impossible unless it was removed or changed while the engine ran; nothing when the log shows none. Records
 *  one warning per failed engine, with the failure kinds only. */
export function keychainReachedFailure(observation: TokenStoreObservation): TokenStoreUnavailableError | undefined {
  const kinds = reachedKeyringKinds(observation)
  if (kinds.length === 0) return undefined
  log.warn("Google Antigravity engine reached a keyring", { kinds })
  return new TokenStoreUnavailableError("keychain-reached", `The Google Antigravity engine reached a keyring that it must not use (${kinds.join(", ")}).`)
}
