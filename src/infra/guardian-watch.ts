import { Log } from "./log.js"
import { unixProcessIdentity, windowsProcessIdentity, type ProcessIdentity, type TerminationCause } from "./process-container.js"
import { isProcessAlive } from "./process-liveness.js"
import { UNANSWERED_PROBE_WINDOW_MS } from "./process-probe-streak.js"
import { coalesceRepeats } from "./repeat-coalescer.js"

/** A command supervisor's watch of the process guardian its container
 *  depends on (ARCH-TOOLS-025): how each platform reads the guardian, and the watch
 *  that ends the container only on proof that the guardian is gone. */

// The watch runs in the command supervisor, whose records its launcher relays.
const log = Log.create({ service: "command-supervisor" })

/** How often the guardian behind this container is checked. Liveness is one
 *  signal-zero syscall and identity is one kernel query, so both are cheap
 *  enough to ask on every check. */
const GUARDIAN_CHECK_INTERVAL_MS = 250

/** How a container reads the guardian it depends on. */
export type GuardianReads = Pick<GuardianWatchOptions, "alive" | "identify">

/** A POSIX container asks signal zero whether the guardian's pid is taken, and
 *  the kernel who holds it. */
export const posixGuardianReads: GuardianReads = {
  // Only ESRCH proves the pid free. A refusal is a process that exists.
  alive: isProcessAlive,
  identify: (pid) => unixProcessIdentity(pid),
}

/** Windows asks the kernel both questions. A guardian this side could not
 *  read is not a guardian proven gone, so it counts as alive: ending a
 *  container on no evidence is the one mistake the watch must not make. */
export const windowsGuardianReads: GuardianReads = {
  alive: (pid) => windowsProcessIdentity(pid).kind !== "absent",
  identify: (pid) => windowsProcessIdentity(pid),
}

export interface GuardianWatchOptions {
  readonly pid: number
  /** The guardian's creation identity as the launcher read it. */
  readonly identity: string
  /** False only when the pid is proven free. */
  readonly alive: (pid: number) => boolean
  readonly identify: (pid: number) => ProcessIdentity
  /** Gets the proof: the kind of loss, and the reads it rested on. */
  readonly onLost: (proof: TerminationCause) => void
  readonly intervalMs?: number
}

/** Watches the guardian this container depends on, and reports its loss once.
 *
 *  Ownership is only as real as the guardian behind it: a guardian that died is
 *  no longer anyone's crash backstop, so this container ends rather than
 *  outliving the promise that made it safe to start.
 *
 *  A pid alone cannot say whether the guardian is still there. The operating
 *  system recycles pids, so a container watching a bare number would go on
 *  trusting whatever unrelated process inherited it after the guardian died.
 *  The launch therefore names the pid together with the guardian's creation
 *  identity, and this watch ends the container on proof alone: a pid nobody
 *  holds, a guardian the kernel reports as exited, or a pid now held by a
 *  process the launcher never saw. A probe that did not answer proves none of
 *  these. The container stays, and the next check asks again: ending live work
 *  on a question nobody answered is the one mistake this watch must not make.
 *
 *  The watch polls, and waits on no handle that the guardian's exit would
 *  close, for three reasons. First, an adopting owner names its own guardian
 *  after a handover, and a descriptor this process inherits is fixed when it
 *  is spawned. Second, one identity query with three answers (a process, an
 *  absence, or no proof) serves the launch, the adoption and this watch on
 *  macOS, Linux and Windows. Third, an answer that is late or missing only
 *  delays an end by one check.
 *
 *  An unanswered check changes nothing, but it is recorded: the first one of a
 *  streak with the guardian it asked about, and the repeats as one count when
 *  the window closes or the watch stops. An answer does not end the streak,
 *  so a probe that alternates between no answer and an answer is one streak
 *  and one record, not one for each alternation. */
export function watchGuardian(options: GuardianWatchOptions): () => void {
  let lost = false
  let handle: ReturnType<typeof setInterval> | undefined
  const unanswered = coalesceRepeats<undefined>({
    windowMs: UNANSWERED_PROBE_WINDOW_MS,
    first: () => {
      log.warn("the process guardian's identity probe did not answer; the container stays and the next check asks again", { guardianPid: options.pid, expectedIdentity: options.identity })
    },
    repeated: (_probe, repeats) => {
      log.warn("the process guardian's identity probe did not answer again", { guardianPid: options.pid, count: repeats.count, windowMs: repeats.windowMs })
    },
  })

  const stop = (): void => {
    if (handle !== undefined) clearInterval(handle)
    handle = undefined
    unanswered.end()
  }
  const lose = (reason: string, actual: ProcessIdentity | undefined, startedAt: number): void => {
    if (lost) return
    lost = true
    stop()
    options.onLost({
      reason,
      evidence: {
        guardianPid: options.pid,
        expectedIdentity: options.identity,
        actualIdentity: actual === undefined ? "not probed" : actual.kind === "process" ? actual.identity : actual.kind,
        elapsedProbeMs: performance.now() - startedAt,
      },
    })
  }

  handle = setInterval(() => {
    const startedAt = performance.now()
    if (!options.alive(options.pid)) {
      lose("guardian pid is free", undefined, startedAt)
      return
    }
    const actual = options.identify(options.pid)
    if (actual.kind === "absent") lose("guardian exited", actual, startedAt)
    else if (actual.kind === "process" && actual.identity !== options.identity) lose("guardian identity mismatch", actual, startedAt)
    else if (actual.kind === "unproven") unanswered.observe("identity", undefined)
  }, options.intervalMs ?? GUARDIAN_CHECK_INTERVAL_MS)

  return stop
}
