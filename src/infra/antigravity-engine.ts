import { existsSync } from "node:fs"
import { join } from "node:path"
import { runningSourceSnapshot, runsThroughBun, sourceCheckout, sourceSnapshotHome } from "./cli-subprocess.js"
import { readEngineVersion } from "./engine-version.js"
import { QUALIFIED_ANTIGRAVITY_VERSION } from "./distribution/antigravity-engine-pin.js"
import { antigravityEngineFile, buildPlatformArch, checkoutAntigravityEngine, nativeAssetDir } from "./native-assets.js"
import type { OsAccount } from "./os-account.js"
import type { OwnedCommandRunner } from "./owned-command.js"

// The bundled Antigravity CLI (`agy`) is a shared primitive: the Google Antigravity provider runs it for its login,
// logout, model listing, and serving. None of them owns where it lives, which version it must report, or how it is
// kept apart from the person's own Antigravity installation, so all read that here. Which version and bytes Flywheel
// accepts is the pin in `antigravity-engine-pin.ts`.

/** The command that places the verified pinned `agy` in a source checkout. */
const PREPARE_COMMAND = "bun run engine:antigravity:prepare"

/**
 * The `agy` that ships with Flywheel. A release runs the copy that its build placed in the build's native directory
 * and verified against the pin. A source run runs the verified copy that the prepare step placed in the checkout's
 * cache, under a path that names the pinned version. A process that runs from a dev source snapshot runs only the
 * copy that the snapshot pinned, which the snapshot checked against the pin when it was made, and never the
 * checkout's: a later prepare never changes the engine that a running service starts, and a snapshot that pinned none
 * runs none. Flywheel never runs an `agy` from the PATH, so the person's own installation and its updates never serve
 * Flywheel. `execPath` is the running executable, which decides between a build and a source run. Throws, in a source
 * run, when there is no such copy: nothing downloads it at run time, and only the prepare step, which verifies the
 * bytes before it places them, puts a file in the checkout's cache.
 */
export function antigravityEnginePath(execPath: string = process.execPath): string {
  const platformArch = buildPlatformArch()
  if (!runsThroughBun(execPath)) return join(nativeAssetDir(), antigravityEngineFile(platformArch))
  const path = checkoutAntigravityEngine(QUALIFIED_ANTIGRAVITY_VERSION, platformArch)
  const snapshot = runningSourceSnapshot()
  const engine = snapshot === undefined ? join(sourceCheckout(), path) : join(sourceSnapshotHome(snapshot.checkout), snapshot.digest, path)
  if (existsSync(engine)) return engine
  const missing = `no verified Antigravity CLI ${QUALIFIED_ANTIGRAVITY_VERSION} for ${platformArch}. Run \`${PREPARE_COMMAND}\` in the checkout`
  throw new Error(snapshot === undefined ? `This checkout has ${missing} to place it.` : `The source snapshot that this Flywheel runs from has ${missing}, and start Flywheel again.`)
}

/** The version of the `agy` at `engine`, through the caller's owned-command runner. Rejects when the call fails,
 *  and when the version is not the qualified one, with a reason that names both versions: an engine that did not
 *  pass qualification never serves (design decision 10). */
export async function requireQualifiedAntigravityVersion(engine: string, run: OwnedCommandRunner): Promise<string> {
  const version = await readEngineVersion(engine, run)
  if (version !== QUALIFIED_ANTIGRAVITY_VERSION) throw new Error(`The Antigravity CLI at ${engine} is version ${version}, and Flywheel is qualified only on version ${QUALIFIED_ANTIGRAVITY_VERSION}.`)
  return version
}

/** What every `agy` that this process starts shares, whichever login it runs on. */
export interface AntigravityEngineHost {
  /** The account the engine runs on, which names `USER`. */
  readonly account: OsAccount
  /** The platform the engine runs on, which decides the variables of a Windows host. */
  readonly platform: NodeJS.Platform
  /** The host environment the allowlist reads from. */
  readonly hostEnvironment: { readonly [name: string]: string | undefined }
  /** Variables added after the allowlist. Only fake-host scripts and tests set it, to point the engine at a local
   *  host (`GOOGLE_GEMINI_BASE_URL`) with a dummy key (`GEMINI_API_KEY`). */
  readonly testEnvironment?: { readonly [name: string]: string }
}

/** The private home of the login directory `loginDir`, and the folders in it that Flywheel names: the engine's
 *  `.gemini` folder (`GEMINI_HOME`), which holds its configuration, its token, and its conversations, and the
 *  temporary folder of its environment. The login directory must be absolute: the engine refuses a relative
 *  `GEMINI_HOME`. */
export function antigravityHomeLayout(loginDir: string) {
  const home = join(loginDir, "home")
  return { home, geminiHome: join(home, ".gemini"), temporary: join(home, "tmp") }
}

/** The host variables the engine inherits: the PATH, on which it finds `git` and its shell, and on Windows the
 *  variables that `cmd.exe`, which runs its hooks, needs. Everything else stays out: every `GEMINI_*`, `GOOGLE_*`, and
 *  `AGY_*` variable, every credential, `DBUS_SESSION_BUS_ADDRESS` (without a session bus the Linux engine keeps its
 *  token in a file of its home, not in a system keyring), and every home and `XDG_*` variable, which name the
 *  person's own folders. */
const INHERITED_VARIABLES = ["PATH", "SHELL"] as const
const INHERITED_WINDOWS_VARIABLES = ["SystemRoot", "ComSpec", "PATHEXT"] as const

/** The fixed toggles of every engine that Flywheel starts. */
const ENGINE_TOGGLES = {
  // The engine never updates itself: a newer engine comes only with a Flywheel release, after qualification.
  AGY_CLI_DISABLE_AUTO_UPDATE: "true",
} as const

/** The complete environment of one engine launch, by variable name. */
export interface AntigravityEngineEnvironment {
  readonly [name: string]: string
}

/** The environment of every engine on the login directory `loginDir`: the allowlist, the OS account's user, and every
 *  variable by which the engine finds a home, a configuration, a data, cache, or state folder, or a temporary
 *  folder, each in the login's private home (`antigravityHomeLayout`). `HOME` and `GEMINI_HOME` both name the
 *  login's own `.gemini` folder (agy 1.5.14 finds it through `HOME`), so no engine that Flywheel starts reads or
 *  writes the person's own `~/.gemini`, and that installation finds nothing of the engine's. Each login has a home of
 *  its own, so no two logins share a token, a setting, or a conversation. */
export function separatedAntigravityEnvironment(host: AntigravityEngineHost, loginDir: string): AntigravityEngineEnvironment {
  const inheritedNames = host.platform === "win32" ? [...INHERITED_VARIABLES, ...INHERITED_WINDOWS_VARIABLES] : INHERITED_VARIABLES
  const inherited = Object.fromEntries(inheritedNames.flatMap((name) => {
    const value = host.hostEnvironment[name]
    return value === undefined ? [] : [[name, value] as const]
  }))
  const { home, geminiHome, temporary } = antigravityHomeLayout(loginDir)
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    GEMINI_HOME: geminiHome,
    USER: host.account.user,
    ...ENGINE_TOGGLES,
    ...host.testEnvironment,
  }
}
