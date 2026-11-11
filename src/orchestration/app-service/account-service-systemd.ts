import { dirname, posix } from "node:path"

import { Log } from "../../infra/log.js"
import type { AccountServicePlatform, AccountServiceRegistrationControl, ServiceManager } from "./account-service-installation.js"
import { systemdUnit } from "./account-service-registration.js"
import { answered, assertOk, failure, type ServiceCommandOutput, type ServiceCommandRunner } from "./service-manager-command.js"

/** The account service on Linux (PI-REMOTE-013): the systemd user unit that
 *  registers it with the user's service manager, and logind's lingering,
 *  which decides whether that manager outlives the user's last logout.
 *  Registering the service also turns lingering on for the account. */

const log = Log.create({ service: "account-service-installation" })

export function systemdUnitPath(platform: Pick<AccountServicePlatform, "accountHome" | "env" | "names">): string {
  const configHome = platform.env.XDG_CONFIG_HOME || posix.join(platform.accountHome, ".config")
  return posix.join(configHome, "systemd", "user", platform.names.systemdUnit)
}

export function systemdManager(platform: AccountServicePlatform, isForeign: () => Promise<boolean>): ServiceManager {
  const run = platform.runCommand
  const unit = systemdUnitPath(platform)
  const registered = async (): Promise<boolean> => platform.files.exists(unit) && !(await isForeign())
  return {
    registered,
    async installed() { return (await run(["systemctl", "--user", "is-enabled", "--quiet", platform.names.systemdUnit])).exitCode === 0 },
    async install() {
      const active = (await run(["systemctl", "--user", "is-active", "--quiet", platform.names.systemdUnit])).exitCode === 0
      const enabled = (await run(["systemctl", "--user", "is-enabled", "--quiet", platform.names.systemdUnit])).exitCode === 0
      // An active unit is neither written nor reloaded. A reload under a
      // running earlier build would give it this unit's restart policy, which
      // that build's exit codes do not follow, and any later reload by
      // another program would do the same to a unit written now. The service
      // of this build writes and reloads its unit itself (`refreshUnit`).
      // `--no-reload` keeps enable and disable from reloading implicitly.
      if (!active) {
        const registration = systemdUnit(platform.command, platform.accountHome)
        if (platform.files.read(unit) !== registration) platform.files.write(unit, registration)
        assertOk("systemctl daemon-reload", await run(["systemctl", "--user", "daemon-reload"]))
      }
      if (!enabled) {
        assertOk("systemctl enable", await run(["systemctl", "--user", "enable", "--no-reload", ...(active ? [] : ["--now"]), platform.names.systemdUnit]))
      } else if (!active) {
        assertOk("systemctl start", await run(["systemctl", "--user", "start", platform.names.systemdUnit]))
      }
      for (const retired of platform.retired) {
        await run(["systemctl", "--user", "disable", "--no-reload", "--now", retired.systemdUnit])
        platform.files.remove(posix.join(dirname(unit), retired.systemdUnit))
      }
      if (!active) await run(["systemctl", "--user", "daemon-reload"])
      if (platform.uid !== undefined) await keepUserManagerAfterLogout(run, platform.uid)
    },
    async uninstall() {
      // Neither step here stops anything. A stop from inside the unit's own
      // control group would end the process that asked for it, so a
      // transient unit outside that group stops the service. Its stop comes
      // before its reload, so KillMode and TimeoutStopSec still apply to it.
      await run(["systemctl", "--user", "disable", "--no-reload", platform.names.systemdUnit])
      platform.files.remove(unit)
      assertOk("systemd-run", await run(["systemd-run", "--user", "--collect", "--quiet", "--", "/bin/sh", "-c", `systemctl --user stop "$0"; systemctl --user daemon-reload`, platform.names.systemdUnit]))
      log.info("the account service unit was removed; a transient unit stops the service from outside its control group")
    },
    async start() {
      if (!await registered()) return false
      const enabled = await run(["systemctl", "--user", "is-enabled", platform.names.systemdUnit])
      if (enabled.exitCode === 0) {
        assertOk("systemctl start", await run(["systemctl", "--user", "start", platform.names.systemdUnit]))
        return true
      }
      // Only a state systemd names proves the unit is not registered to run.
      // A manager the client cannot reach answers none, and that is a failed
      // start, never an absent registration.
      if (answered(enabled) && /^(?:disabled|masked|masked-runtime|linked|linked-runtime|not-found|bad)$/m.test(enabled.stdout.trim())) return false
      throw failure("systemctl is-enabled", enabled)
    },
  }
}

export function systemdControl(platform: AccountServicePlatform): NonNullable<AccountServiceRegistrationControl["systemd"]> {
  const run = platform.runCommand
  const unit = systemdUnitPath(platform)
  return {
    async refreshUnit() {
      // A unit file that is gone is Process initiation Off's, which removes
      // it before its transient unit stops the service, so a unit systemd
      // still holds can restart the service meanwhile. A file written again
      // here would register the service at the next update.
      if (!platform.files.exists(unit)) {
        log.info("the account service unit file is gone, so Process initiation is off; the service writes no unit")
        return false
      }
      const registration = systemdUnit(platform.command, platform.accountHome)
      if (platform.files.read(unit) !== registration) platform.files.write(unit, registration)
      else {
        const shown = await run(["systemctl", "--user", "show", "-p", "NeedDaemonReload", platform.names.systemdUnit])
        assertOk("systemctl show", shown)
        if (!/^NeedDaemonReload=yes$/m.test(shown.stdout)) return false
      }
      assertOk("systemctl daemon-reload", await run(["systemctl", "--user", "daemon-reload"]))
      log.info("the account service wrote or loaded its current unit; the systemd user manager reloaded it")
      return true
    },
  }
}

/** How long logind gets to answer about lingering, for the reading and for
 *  the enable alike. Neither asks the person anything, so a logind that is
 *  slow to answer leaves lingering as it is rather than hold the
 *  `serve install` that registers the service, whose whole run a first
 *  install bounds. */
const LINGER_TIMEOUT_MS = 2_000

interface SystemdUserLingerStatus {
  readonly user: string
  readonly linger: "yes" | "no"
}

/** logind's answer about the user manager of `uid`: the user's name, and
 *  whether the manager outlives the user's last logout. Copied from
 *  OpenClaw's readSystemdUserLingerStatus (its systemd-linger.ts) and
 *  edited: the command names the uid, and logind names the user in the same
 *  answer, as the account database rather than the environment names the
 *  login home. It runs through the installation's runner. A command that
 *  cannot start, such as a loginctl outside the directories a trusted launch
 *  searches, fails, or does not answer, answers nothing. */
async function readSystemdUserLingerStatus(run: ServiceCommandRunner, uid: number): Promise<SystemdUserLingerStatus | undefined> {
  let result: ServiceCommandOutput
  try {
    result = await run(["loginctl", "show-user", String(uid), "-p", "Name", "-p", "Linger"], { timeoutMs: LINGER_TIMEOUT_MS })
  } catch {
    // A command that never started proves nothing about lingering.
    return undefined
  }
  const field = (name: string): string | undefined => result.stdout.split("\n").find((entry) => entry.trim().startsWith(`${name}=`))?.trim().slice(name.length + 1)
  const user = field("Name")
  const value = field("Linger")?.toLowerCase()
  return answered(result) && result.exitCode === 0 && user && (value === "yes" || value === "no") ? { user, linger: value } : undefined
}

/** The name logind states for `uid` while lingering is off for it, so the
 *  user manager, and the account service with it, stops at the user's last
 *  logout. Nothing while lingering is on or when logind does not answer. */
export async function logindLingerOffFor(run: ServiceCommandRunner, uid: number): Promise<string | undefined> {
  const status = await readSystemdUserLingerStatus(run, uid)
  log.debug("logind lingering read", { linger: status?.linger ?? "no answer" })
  return status?.linger === "no" ? status.user : undefined
}

/** Turns lingering on for `uid` while logind says it is off, so the user
 *  manager, and the account service with it, keeps running after the user's
 *  last logout, such as when the SSH or SSM session of a headless machine
 *  ends. systemd's polkit policy grants a user
 *  `org.freedesktop.login1.set-self-linger` without a password, from any
 *  session or none, so no sudo is needed. `--no-ask-password` keeps a
 *  distribution rule that wants a password from prompting: logind refuses
 *  instead. A refusal, or a logind that does not answer, fails nothing; the
 *  lingering reading then still finds it off and names the command the
 *  person can run. Turning Process initiation off leaves lingering on,
 *  because other services of the account can depend on it. */
async function keepUserManagerAfterLogout(run: ServiceCommandRunner, uid: number): Promise<void> {
  const status = await readSystemdUserLingerStatus(run, uid)
  if (status?.linger !== "no") {
    log.debug("logind lingering needs no change", { linger: status?.linger ?? "no answer" })
    return
  }
  let result: ServiceCommandOutput | undefined
  try {
    result = await run(["loginctl", "enable-linger", "--no-ask-password", String(uid)], { timeoutMs: LINGER_TIMEOUT_MS })
  } catch {
    // A loginctl that cannot start is a logind that did not answer.
  }
  const outcome = result === undefined || !answered(result) ? "no answer" : result.exitCode === 0 ? "enabled" : "refused"
  log.info("asked logind to keep the account service running after logout", { outcome, ...(outcome === "refused" ? { exitCode: result?.exitCode } : {}) })
}
