/**
 * Installs Flywheel the way the extension does on a machine that has none,
 * then attaches once.
 *
 * It runs the extension's own code in the extension's own order: resolution
 * finds nothing, the platform's bootstrap installer is fetched from the public
 * release and run with stdin closed, the launcher it placed answers its
 * version, the account service starts, and one project attach reads a
 * snapshot. The versions home and the launcher's `--version` are listed last.
 *
 * The account is a bare home under the system temporary directory. This
 * process takes on that account's environment before it does anything, as an
 * extension host on a new machine has it: HOME, FLYWHEEL_INSTALL_DIR, and
 * TMPDIR name places inside the home, PATH names only the system's own
 * directories, and no inherited FLYWHEEL_ or XDG_ setting reaches it. Bun reads
 * the home directory once at startup, so the home is passed where the
 * extension reads `homedir()`; everything else reads the environment. An
 * account home that is not the login home registers nothing with launchd,
 * systemd, or Task Scheduler (ARCH-RUNTIME-038), so the real account's install,
 * service, and registration are never read or written. A service in such a
 * home is not resident, so the account carries the harness setting that makes
 * it resident, as the registered service is on a new machine; the script stops
 * it by pid. The service binds the release harness's ephemeral hub so a
 * running account service keeps its port.
 *
 * Network: it downloads the installer and the latest release, about 50 MB.
 * It exits 0 only when the attach succeeds, which makes it the extension's
 * publication gate: a package whose runtime release is not public yet fails
 * at the attach. On failure the home is kept for its logs and named.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Redacted } from "effect"

import { createRuntimeConnection } from "../../src/protocol/client/connection.js"
import { installedLauncherPath } from "../../src/protocol/installation.js"
import { releaseRepository } from "../../scripts/release-contract.js"
import { describeInstallFailure, installFlywheel } from "../src/runtime/bootstrap-install.js"
import { nodeSocketLayer } from "../src/runtime/node-socket.js"
import { probeVersion } from "../src/runtime/probe-version.js"
import { MINIMUM_RUNTIME_VERSION, resolveRuntime } from "../src/runtime/runtime-resolver.js"
import { prepareAccountRuntime } from "../src/runtime/supervisor.js"

const windows = process.platform === "win32"
const say = (line: string) => writeSync(1, `${line}\n`)
const step = (name: string, detail = "") => say(`  ${name.padEnd(22)} ${detail}`)
const started = performance.now()
const elapsed = () => `${Math.round(performance.now() - started)} ms`
const diagnostic = (line: string) => say(`    ! ${line}`)

// A short root: a unix socket path longer than 104 bytes fails on macOS, and
// the account socket lives three directories below the home.
const home = realpathSync(mkdtempSync(windows ? join(tmpdir(), "fwb-") : "/tmp/fwb-"))
const projectRoot = join(home, "project")
mkdirSync(join(home, "tmp"))
mkdirSync(projectRoot)
writeFileSync(join(projectRoot, "README.md"), "bootstrap check\n")

for (const name of Object.keys(process.env)) {
  if (name.startsWith("FLYWHEEL_") || name.startsWith("XDG_")) Reflect.deleteProperty(process.env, name)
}
Object.assign(process.env, {
  HOME: home,
  FLYWHEEL_INSTALL_DIR: windows ? join(home, "bin") : join(home, ".local", "bin"),
  TMPDIR: join(home, "tmp"),
  FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
  FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
  FLYWHEEL_INTERNAL_RESIDENT_SERVICE: "1",
  ...(windows
    ? {
      USERPROFILE: home,
      TEMP: join(home, "tmp"),
      TMP: join(home, "tmp"),
      // The Windows installer writes the user Path in the registry, which no
      // environment override redirects (UPD-013).
      FLYWHEEL_NO_MODIFY_PATH: "1",
      PATH: [join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32"), process.env.SystemRoot ?? String.raw`C:\Windows`, join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "WindowsPowerShell", "v1.0")].join(";"),
    }
    : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }),
})

let servicePid: number | undefined
let ok = false

/** Stops the account service by the pid its handshake named. The service is
 *  not this script's child: the executable's find-or-start launched it. */
async function stopService(pid: number): Promise<void> {
  const signal = (name: NodeJS.Signals): boolean => {
    try {
      process.kill(pid, name)
      return true
    } catch {
      return false
    }
  }
  if (!signal("SIGTERM")) return
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
  }
  signal("SIGKILL")
}

try {
  say(`\naccount home ${home}\n`)
  const launcher = installedLauncherPath(process.platform, process.env, home)
  // A launcher outside the bare home would be a real account's.
  if (!launcher.startsWith(home)) throw new Error(`the launcher resolves to ${launcher}, outside ${home}`)
  const resolved = await resolveRuntime({ launcher, minimumVersion: MINIMUM_RUNTIME_VERSION })
  if (resolved.ok || resolved.failure.kind !== "none_found") throw new Error(`a Flywheel is already reachable from the bare account: ${JSON.stringify(resolved)}`)
  step("resolve", `nothing installed (${elapsed()})`)

  const installed = await installFlywheel({
    platform: process.platform,
    repository: releaseRepository(process.env),
    launcher,
    minimumVersion: MINIMUM_RUNTIME_VERSION,
    env: process.env,
    onOutput: (line) => say(`    | ${line}`),
  })
  if (!installed.ok) throw new Error(describeInstallFailure(installed.failure))
  step("install", `${launcher} answers ${installed.version} (${elapsed()})`)

  const account = await prepareAccountRuntime({
    executable: launcher,
    projectRoot,
    accountHome: home,
    minimumVersion: MINIMUM_RUNTIME_VERSION,
    log: { debug: () => {}, info: diagnostic, warn: diagnostic, error: diagnostic },
  })
  if (!account.ok) throw new Error(`the account service did not serve this build: ${JSON.stringify(account.failure)}`)
  servicePid = account.service.pid
  step("listening", `${account.target.socketPath} (${elapsed()})`)

  const connection = createRuntimeConnection({
    socket: nodeSocketLayer({ ...account.target, credential: Redacted.value(account.target.credential) }),
  })
  const snapshot = await connection.query({ type: "snapshot" })
  await connection.close()
  step("attach", `${snapshot.projectRoot} (${elapsed()})`)
  ok = true
} catch (cause) {
  say(`\nFAILED: ${cause instanceof Error ? cause.message : String(cause)}`)
} finally {
  if (servicePid !== undefined) await stopService(servicePid)
  // A service this run started and could not hand back is still this run's,
  // and nothing else names the bare home.
  if (!windows) Bun.spawnSync(["pkill", "-TERM", "-f", home], { stdout: "ignore", stderr: "ignore", windowsHide: true })

  const versions = join(home, ".flywheel", "versions")
  if (existsSync(versions)) {
    for (const version of readdirSync(versions)) {
      for (const build of readdirSync(join(versions, version))) step("versions home", `${version}/${build}`)
    }
  }
  const launcher = installedLauncherPath(process.platform, process.env, home)
  step("flywheel --version", (await probeVersion(launcher)) ?? "no answer")
  step("registration", existsSync(join(home, "Library", "LaunchAgents")) || existsSync(join(home, ".config", "systemd")) ? "written under the bare home" : "none")

  if (ok) rmSync(home, { recursive: true, force: true })
  else say(`\nkept ${home} for its logs`)
  say(ok ? "\nbootstrap: installed and attached" : "\nbootstrap: did not attach")
}

process.exit(ok ? 0 : 1)
