import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import type { OwnedProcess } from "../../../infra/owned-subprocess.js"
import { windowsExecutionStateApi, type WindowsExecutionStateApi } from "../../../infra/windows-execution-state.js"

/** Keeps an awake machine from idle-sleeping while a phone is using a runtime
 *  the account service opened for a phone: `caffeinate -i` on macOS and `systemd-inhibit` on
 *  Linux as owned processes that end with the hold, the execution-state flag
 *  on Windows. A lid closed or an explicit sleep still wins on every platform.
 *  Holding is idempotent and a hold that cannot be taken is logged, never
 *  fatal: a machine that dozes is the failure this exists to remove, not a
 *  reason to stop serving the phone. */

const log = Log.create({ service: "keep-awake" })

export interface KeepAwake {
  hold(): Promise<void>
  release(): Promise<void>
}

/** The inhibitor process as the hold needs it: something that ends on request. */
type Inhibitor = Pick<OwnedProcess, "terminate">

export interface KeepAwakeInput {
  readonly platform: NodeJS.Platform
  /** A launcher scope's `spawnOwned`, or any launcher whose process can be ended. */
  readonly spawnOwned: (command: readonly string[]) => Promise<Inhibitor>
  readonly windowsApi?: () => WindowsExecutionStateApi | undefined
}

function inhibitorCommand(platform: NodeJS.Platform): readonly string[] | undefined {
  switch (platform) {
    case "darwin":
      return ["caffeinate", "-i"]
    case "linux":
      return ["systemd-inhibit", "--what=idle", "--who=Flywheel", "--why=A phone is using a Flywheel runtime", "--mode=block", "sleep", "infinity"]
    default:
      return undefined
  }
}

export function createKeepAwake(input: KeepAwakeInput): KeepAwake {
  if (input.platform === "win32") {
    const api = (input.windowsApi ?? windowsExecutionStateApi)()
    let held = false
    return {
      async hold() {
        if (held || !api) return
        held = api.keepSystemAwake()
        if (held) log.info("keeping the system awake for a phone")
        else log.warn("the power manager refused to keep the system awake")
      },
      async release() {
        if (!held || !api) return
        held = false
        if (api.allowSleep()) log.info("allowing the system to sleep again")
        else log.warn("the power manager refused to allow sleep again")
      },
    }
  }
  const command = inhibitorCommand(input.platform)
  let inhibitor: Promise<Inhibitor | undefined> | undefined
  return {
    async hold() {
      if (inhibitor !== undefined || command === undefined) return
      inhibitor = input.spawnOwned(command).then((process) => {
        log.info("keeping the system awake for a phone", { command: command[0] })
        return process
      }, (error: unknown) => {
        log.warn("the idle-sleep inhibitor could not start", { command: command[0], error: errorMessage(error) })
        return undefined
      })
      await inhibitor
    },
    async release() {
      const holding = inhibitor
      if (holding === undefined) return
      inhibitor = undefined
      const process = await holding
      if (!process) return
      await process.terminate()
      log.info("allowing the system to sleep again", { command: command?.[0] })
    },
  }
}

/** A hold that does nothing, for a machine whose user turned keep-awake off. */
export const NO_KEEP_AWAKE: KeepAwake = { hold: async () => {}, release: async () => {} }
