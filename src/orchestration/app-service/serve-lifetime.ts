/** How long a serve that is not resident waits for the client that started it. */
const SERVE_STARTUP_GRACE_MS = 10_000
/** How long a serve that is not resident stays after its last hold is gone. */
const SERVE_IDLE_GRACE_MS = 1_000
/** How long a dev-lane project stays open with no client and no live work.
 *  Thirty seconds is the installed lane's grace; a developer closing
 *  everything wants the next `bun run dev` on the current source within a
 *  couple of seconds. */
export const DEV_SERVE_PROJECT_IDLE_GRACE_MS = 1_000

/** What holds a serve up: attached connections and open projects. */
export interface ServeHolds {
  setConnectionCount(count: number): void
  setProjectCount(count: number): void
}

export interface ServeLifetimeOptions {
  /** A resident serve never retires on idle. A residency that is still being
   *  decided holds the serve until it settles. */
  readonly resident: boolean | Promise<boolean>
  readonly startupGraceMs?: number
  readonly idleGraceMs?: number
  /** The clock, replaceable by a test; returns the cancel. */
  readonly setTimer?: (fire: () => void, ms: number) => () => void
}

const realTimer = (fire: () => void, ms: number): (() => void) => {
  const handle = setTimeout(fire, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

/** Reconcile operator, startup, client, and project holds for one serve
 *  generation. A resident serve is held by its operator until an explicit
 *  stop; any other serve retires once the startup grace has passed and no
 *  connection or open project holds it for the idle grace. Copied from pi's
 *  `ServerLifetime` with project holds in place of worker holds. */
export class ServeLifetime implements ServeHolds {
  /** Undefined until a residency that was still being decided settles. */
  #resident: boolean | undefined
  readonly #startupGraceMs: number
  readonly #idleGraceMs: number
  readonly #setTimer: (fire: () => void, ms: number) => () => void
  #connectionCount = 0
  #projectCount = 0
  #startupHeld: boolean
  #cancelStartup: (() => void) | undefined
  #cancelRetirement: (() => void) | undefined
  #retire: (() => void) | undefined
  #stopped = false

  constructor(options: ServeLifetimeOptions) {
    this.#startupGraceMs = options.startupGraceMs ?? SERVE_STARTUP_GRACE_MS
    this.#idleGraceMs = options.idleGraceMs ?? SERVE_IDLE_GRACE_MS
    this.#setTimer = options.setTimer ?? realTimer
    const { resident } = options
    if (typeof resident === "boolean") {
      this.#resident = resident
    } else {
      void resident.then((decided) => {
        this.#resident = decided
        this.#reconcile()
      })
    }
    this.#startupHeld = this.#resident !== true
  }

  /** Whether the serve stays up while nothing holds it, as decided now. */
  get resident(): boolean {
    return this.#resident === true
  }

  start(retire: () => void): void {
    this.#retire = retire
    if (this.#startupHeld) {
      this.#cancelStartup = this.#setTimer(() => {
        this.#cancelStartup = undefined
        this.#startupHeld = false
        this.#reconcile()
      }, this.#startupGraceMs)
    }
    this.#reconcile()
  }

  setConnectionCount(count: number): void {
    this.#connectionCount = count
    if (count > 0 && this.#startupHeld) {
      this.#startupHeld = false
      this.#cancelStartup?.()
      this.#cancelStartup = undefined
    }
    this.#reconcile()
  }

  setProjectCount(count: number): void {
    this.#projectCount = count
    this.#reconcile()
  }

  /** Changes a decided residency, as a client-started service's registration
   *  appears or disappears, and answers whether it changed. A serve that
   *  stops being resident retires after the idle grace once nothing holds it;
   *  one made resident again cancels a pending retirement. */
  setResident(resident: boolean): boolean {
    if (this.#resident === resident) return false
    this.#resident = resident
    this.#reconcile()
    return true
  }

  stop(): void {
    this.#stopped = true
    this.#cancelStartup?.()
    this.#cancelRetirement?.()
    this.#cancelStartup = undefined
    this.#cancelRetirement = undefined
  }

  #reconcile(): void {
    if (
      this.#stopped ||
      this.#resident !== false ||
      this.#startupHeld ||
      this.#connectionCount !== 0 ||
      this.#projectCount !== 0
    ) {
      this.#cancelRetirement?.()
      this.#cancelRetirement = undefined
      return
    }
    const retire = this.#retire
    if (this.#cancelRetirement || !retire) return
    this.#cancelRetirement = this.#setTimer(() => {
      this.#cancelRetirement = undefined
      if (!this.#stopped && !this.#startupHeld && this.#connectionCount === 0 && this.#projectCount === 0) {
        retire()
      }
    }, this.#idleGraceMs)
  }
}
