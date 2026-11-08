import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import type { OwnedProcess, OwnedProcessExit } from "../../../infra/owned-subprocess.js"
import { windowsExecutionStateApi, type WindowsExecutionStateApi } from "../../../infra/windows-execution-state.js"

/** Keeps an awake machine from idle-sleeping while a phone is using a runtime
 *  the account service opened for a phone: `caffeinate -i` on macOS and `systemd-inhibit` on
 *  Linux as owned processes that end with the hold, the execution-state flag
 *  on Windows. A lid closed or an explicit sleep still wins on every platform.
 *  Holding is idempotent; an inhibitor that ends starts again after a short
 *  wait, and after four consecutive failures the hold waits for the next
 *  hold. A hold that cannot be taken is logged, never fatal: a machine that
 *  dozes is the failure this exists to remove, not a reason to stop serving
 *  the phone. */

const log = Log.create({ service: "keep-awake" })

export interface KeepAwake {
  hold(): Promise<void>
  release(): Promise<void>
}

/** The inhibitor process as the hold needs it: something that ends on request
 *  and tells when it ended. */
type Inhibitor = Pick<OwnedProcess, "terminate" | "exited">

export interface KeepAwakeInput {
  readonly platform: NodeJS.Platform
  /** A launcher scope's `spawnOwned`, or any launcher whose process can be ended. */
  readonly spawnOwned: (command: readonly string[]) => Promise<Inhibitor>
  readonly windowsApi?: () => WindowsExecutionStateApi | undefined
  readonly now?: () => number
  readonly setTimer?: (fire: () => void, delayMs: number) => () => void
}

/** An inhibitor that ends sooner than this after it started could not hold on
 *  this machine, so its end counts as one more consecutive failure. Both
 *  commands fail within milliseconds when they cannot hold (a missing binary
 *  exits 127, no logind is a D-Bus error), and the slowest failure is a D-Bus
 *  method call timeout: 25 s by default, 90 s on some distributions. One that
 *  ran longer held, and something else ended it. */
const INHIBITOR_SETTLED_MS = 120_000

/** The wait before each start again after 1, 2, and 3 consecutive failures.
 *  The first is short, so an inhibitor that something ended once is back
 *  before an idle timer can expire; after the fourth failure the hold stops
 *  trying until the next hold, so a machine that cannot hold costs four short
 *  launches per hold. No jitter: one machine has one inhibitor. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 10_000, 60_000]

/** The Unix hold. `released` is the only state in which nobody wants the
 *  machine awake, and `held` is the only state that names an inhibitor.
 *  `waiting` wants it and starts again when its timer fires; `failed` wants it
 *  and stopped trying until the next hold. `failures` counts consecutive
 *  failures since an inhibitor last held for `INHIBITOR_SETTLED_MS`. */
type Starting = { readonly kind: "starting"; readonly failures: number; readonly settled: Promise<void> }
type Held = { readonly kind: "held"; readonly failures: number; readonly inhibitor: Inhibitor; readonly since: number }
type Waiting = { readonly kind: "waiting"; readonly failures: number; readonly cancel: () => void }
type Hold = { readonly kind: "released" } | Starting | Held | Waiting | { readonly kind: "failed" }

/** Every change of the hold. A continuation event names the state it started
 *  from and acts only while that state is still current, so a release or a
 *  newer start always wins over a stale continuation. */
type HoldEvent =
  | { readonly kind: "hold" }
  | { readonly kind: "release" }
  | { readonly kind: "spawned"; readonly from: Starting; readonly inhibitor: Inhibitor }
  | { readonly kind: "spawn-failed"; readonly from: Starting; readonly error: unknown }
  | { readonly kind: "exited"; readonly from: Held; readonly exit: OwnedProcessExit }
  | { readonly kind: "retry-due"; readonly from: Waiting }

const RELEASED: Hold = { kind: "released" }
const FAILED: Hold = { kind: "failed" }
const DONE: Promise<void> = Promise.resolve()

function systemTimer(fire: () => void, delayMs: number): () => void {
  const timer = setTimeout(fire, delayMs)
  return () => clearTimeout(timer)
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
  if (command === undefined) return NO_KEEP_AWAKE
  const now = input.now ?? (() => performance.now())
  const setTimer = input.setTimer ?? systemTimer
  let state: Hold = RELEASED

  const starting = (failures: number): Starting => {
    const next: Starting = {
      kind: "starting",
      failures,
      settled: input.spawnOwned(command).then(
        (inhibitor) => transition({ kind: "spawned", from: next, inhibitor }),
        (error: unknown) => transition({ kind: "spawn-failed", from: next, error }),
      ),
    }
    return next
  }
  const afterFailure = (failures: number): Hold => {
    const delayMs = RETRY_DELAYS_MS[failures - 1]
    if (delayMs === undefined) return FAILED
    const next: Waiting = { kind: "waiting", failures, cancel: setTimer(() => { void transition({ kind: "retry-due", from: next }) }, delayMs) }
    return next
  }
  const end = async (inhibitor: Inhibitor): Promise<void> => {
    await inhibitor.terminate()
    log.info("allowing the system to sleep again", { command: command[0] })
  }

  /** The one writer of `state`. Returns the effect its caller awaits. */
  const transition = (event: HoldEvent): Promise<void> => {
    switch (event.kind) {
      case "hold":
        if (state.kind === "released" || state.kind === "failed") state = starting(0)
        return state.kind === "starting" ? state.settled : DONE
      case "release": {
        const previous = state
        state = RELEASED
        if (previous.kind === "held") return end(previous.inhibitor)
        if (previous.kind === "waiting") previous.cancel()
        // A start under way ends the inhibitor that arrives, through its spawn event that is stale from now.
        return previous.kind === "starting" ? previous.settled : DONE
      }
      case "spawned": {
        if (state !== event.from) return end(event.inhibitor)
        const held: Held = { kind: "held", failures: event.from.failures, inhibitor: event.inhibitor, since: now() }
        state = held
        log.info("keeping the system awake for a phone", { command: command[0] })
        void event.inhibitor.exited.then((exit) => transition({ kind: "exited", from: held, exit }))
        return DONE
      }
      case "spawn-failed": {
        if (state !== event.from) return DONE
        const failures = event.from.failures + 1
        state = afterFailure(failures)
        log.warn("the idle-sleep inhibitor could not start", { command: command[0], error: errorMessage(event.error), failures, retrying: state.kind === "waiting" })
        return DONE
      }
      case "exited": {
        // The exit of our own release arrives after the hold left `held`.
        if (state !== event.from) return DONE
        const ranMs = Math.round(now() - event.from.since)
        const failures = ranMs >= INHIBITOR_SETTLED_MS ? 1 : event.from.failures + 1
        state = afterFailure(failures)
        log.warn("the idle-sleep inhibitor ended", { command: command[0], code: event.exit.code, signal: event.exit.signal, ranMs, failures, retrying: state.kind === "waiting" })
        return DONE
      }
      case "retry-due":
        if (state !== event.from) return DONE
        state = starting(event.from.failures)
        return state.settled
    }
  }

  return {
    hold: () => transition({ kind: "hold" }),
    release: () => transition({ kind: "release" }),
  }
}

/** A hold that does nothing, for a machine whose user turned keep-awake off. */
export const NO_KEEP_AWAKE: KeepAwake = { hold: async () => {}, release: async () => {} }
