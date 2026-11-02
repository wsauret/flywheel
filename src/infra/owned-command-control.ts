import { decodeSupervisorAnswer, encodeSupervisorWord, readOutcomeRecord, type CommandAdoption, type CommandHandover } from "./command-handover.js"
import { connectLines } from "./line-channel.js"
import { Log } from "./log.js"
import type { OwnedChild, OwnedExitStatus, OwnedProcessBackend } from "./owned-subprocess-backend.js"
import { emptyContainers, type ManagedContainer, type ProcessIdentity, type TerminationCause } from "./process-container.js"
import { unsettledEmptyingStreak } from "./process-probe-streak.js"
import { withDeadline } from "./with-deadline.js"

const log = Log.create({ service: "owned-command-control" })

/** The controlling side of a command supervisor's channel (ARCH-TOOLS-023,
 *  ARCH-RUNTIME-033): the container a launcher or an adopting owner controls through the supervisor,
 *  the handover word that hands the command to a later owner, and the reach
 *  and adoption by which that owner takes it. `owned-command-supervisor.ts` is
 *  the supervisor's side of the same channel, and the backend launches and
 *  addresses containers per platform. */

/** What a supervisor made of a handover word. `acknowledged`: it wrote its
 *  record and holds the command alone. `exited`: it ended first, and settles
 *  as it always did. `unacknowledged`: neither happened within the bound, so
 *  the container is still this side's. */
export type HandoverAcknowledgement = "acknowledged" | "exited" | "unacknowledged"

/** A container this side controls through its supervisor's channel. */
export interface ControlledContainer {
  readonly pid: number
  readonly child: OwnedChild
  /** Asks the supervisor to end the container. With `end`, this side also
   *  ends the container at once, for `end`'s reason, with no grace and with no
   *  wait for the supervisor to run. */
  stop(end?: TerminationCause): void
  /** Sends the handover word and waits up to `boundMs` for the supervisor's
   *  acknowledgement. Once acknowledged this side holds nothing: its channel
   *  is closed, and `child.exited` never settles, because the command's exit
   *  now belongs to its next owner. */
  handOver(handover: CommandHandover, boundMs: number): Promise<HandoverAcknowledgement>
}

/** A handed-over command as a later owner names it: its ownership token, the
 *  pid of its supervisor, the channel that supervisor serves, and its
 *  outcome record. */
export interface HandedOverCommand {
  readonly token: string
  readonly pid: number
  readonly channel: string
  readonly recordPath: string
}

/** A handed-over command as an owner that adopts it names it, with what the
 *  handover word that gives it back names: the account whose build its
 *  supervisor holds live, and the command's hard deadline. */
export interface AdoptableCommand extends HandedOverCommand {
  readonly userDataRoot: string
  readonly deadlineAtMs?: number
}

/** The handover word that gives `command` back to its supervisor. */
export function handBackWord(command: AdoptableCommand): CommandHandover {
  const { channel, recordPath, userDataRoot, deadlineAtMs } = command
  return { channel, recordPath, userDataRoot, ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }) }
}

/** A handed-over command's supervisor, reached through its channel. */
export interface ReachedCommand {
  /** Asks the supervisor to take `guardianPid` as its guardian and this side
   *  as its controller, and waits up to `boundMs` for its answer.
   *  `adopted`: it did. `refused`: it speaks no version of the word this side
   *  sent, and the channel is closed. `gone`: it ended before it answered.
   *  Throws when another owner controls the command, or when no answer came
   *  within the bound; an adoption answered after that is handed back with
   *  `handBack`. */
  adopt(guardianPid: number, boundMs: number, handBack: CommandHandover): Promise<
    | { readonly kind: "adopted"; readonly container: ControlledContainer }
    | { readonly kind: "refused" }
    | { readonly kind: "gone" }
  >
  /** Gives an adopted command back to its supervisor with the handover word
   *  `word`, so the supervisor holds it alone again as after its handover,
   *  and closes the channel: for an adoption the supervisor took that this
   *  side cannot complete. */
  handBack(word: CommandHandover): void
  close(): void
}

/** How long a container that outlived one escalation rests before the next. */
const UNSETTLED_RETRY_MS = 250

/** How often a handover's acknowledgement is looked for. The supervisor
 *  writes it within milliseconds of the word. */
const HANDOVER_POLL_MS = 20

/** Sends the handover word, then waits for the supervisor's record of it, for
 *  the supervisor's end, or for the bound.
 *
 *  A record counts only when it was written after the word was sent: an
 *  adopted command already has one from its earlier handover. Both processes
 *  read one clock. */
async function awaitHandover(say: (line: string) => void, gone: Promise<unknown>, handover: CommandHandover, boundMs: number): Promise<HandoverAcknowledgement> {
  let isGone = false
  void gone.then(() => { isGone = true })
  const sentAtMs = Date.now()
  say(`${encodeSupervisorWord({ kind: "handover", handover })}\n`)
  for (const deadline = sentAtMs + boundMs; ; await Bun.sleep(HANDOVER_POLL_MS)) {
    const read = readOutcomeRecord(handover.recordPath)
    if (read.kind === "record" && read.record.handedOverAtMs >= sentAtMs) return "acknowledged"
    // A record this release cannot read is no acknowledgement, and reading it
    // again would only report it again.
    if (read.kind === "unreadable") return "unacknowledged"
    if (isGone) return "exited"
    if (Date.now() >= deadline) return "unacknowledged"
  }
}

interface ControlledContainerInput {
  readonly pid: number
  readonly stdio: Pick<OwnedChild, "stdin" | "stdout" | "stderr">
  /** Settles when the supervisor is gone: its process exited, or the channel
   *  it serves ended. */
  readonly gone: Promise<unknown>
  /** Proves the container empty and reads its status. */
  readonly settle: () => Promise<OwnedExitStatus>
  /** Sends one line to the supervisor. */
  readonly say: (line: string) => void
  readonly stop: (end?: TerminationCause) => void
  /** Releases everything this side holds for a container it handed over. */
  readonly letGo: () => void
}

/** A container whose exit this side reports only after the container is
 *  proven empty, unless this side handed it over first.
 *
 *  A handover can race the supervisor's exit. The exit then waits for the
 *  handover's answer: an acknowledged handover means the next owner reports
 *  the command, so this side never does, and exactly one owner publishes each
 *  command's end. */
export function controlledContainer(input: ControlledContainerInput): ControlledContainer {
  let handover: Promise<HandoverAcknowledgement> | undefined
  const exited = input.gone.then(async (): Promise<OwnedExitStatus> => {
    if (handover !== undefined && await handover === "acknowledged") return await new Promise<never>(() => {})
    return await input.settle()
  })
  return {
    pid: input.pid,
    child: { ...input.stdio, exited },
    stop: input.stop,
    handOver(word, boundMs) {
      const attempt = awaitHandover(input.say, input.gone, word, boundMs).then((acknowledgement) => {
        if (acknowledgement === "acknowledged") input.letGo()
        return acknowledgement
      })
      handover = attempt
      return attempt
    },
  }
}

/** Proves the container that `owned.pid` leads empty, ending whatever it
 *  still holds.
 *
 *  A supervisor that exits of its own accord emptied its container first, so
 *  here the proof costs one probe. A supervisor that was killed or crashed ran
 *  no escalation, and its guardian watch ended with it, so its payload and
 *  every descendant are still in the container and nothing inside it will end
 *  them. This side ends them, and reports the exit only after emptiness is
 *  proven: an exit reported earlier would release a lease on a container that
 *  still holds work, and the guardian would then have nothing to sweep. A
 *  container that outlives one escalation stays owned and gets the next one,
 *  after `sleep`. `reason` is why the container is being ended, which its
 *  termination records name. The first escalation that did not empty it is
 *  recorded once, and the repeats count until the container is empty. */
export async function emptied(
  owned: { readonly pid: number; readonly container: ManagedContainer },
  killGraceMs: number,
  reason: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const unsettled = unsettledEmptyingStreak(log, "the command's owner", { container: owned.pid })
  try {
    for (;;) {
      const settlement = await emptyContainers([owned.container], killGraceMs, sleep, { reason })
      if (settlement.kind === "empty") return
      unsettled.observe({ remaining: settlement.remaining, reason })
      await sleep(UNSETTLED_RETRY_MS)
    }
  } finally {
    unsettled.end()
  }
}

/** Ends a container from this side at once, for `end`'s reason: no grace,
 *  and no wait for its supervisor, which under load can wait a minute for the
 *  scheduler at background priority. A stop hold still delays it, as it
 *  delays every other end. The supervisor's own settlement still reports the
 *  exit. */
export function endAtOnce(container: ManagedContainer, end: TerminationCause): void {
  void emptyContainers([container], 0, Bun.sleep, end)
}

/** Reaches a handed-over command's supervisor through the channel it serves.
 *  `identify` reads the adopting guardian's identity on this platform. */
export async function reachCommand(
  command: HandedOverCommand,
  backend: Pick<OwnedProcessBackend, "container" | "forget">,
  identify: (pid: number) => ProcessIdentity,
  killGraceMs: number,
): Promise<ReachedCommand | undefined> {
  const connection = await connectLines(command.channel)
  if (connection === undefined) return undefined
  const handBack = (word: CommandHandover): void => {
    connection.say(encodeSupervisorWord({ kind: "handover", handover: word }))
    connection.close()
  }
  const controlled = (): ControlledContainer => controlledContainer({
    pid: command.pid,
    stdio: { stdin: undefined, stdout: undefined, stderr: undefined },
    gone: connection.ended,
    async settle() {
      await emptied({ pid: command.pid, container: backend.container(command) }, killGraceMs, "handed-over command supervisor exited with work left", Bun.sleep)
      const read = readOutcomeRecord(command.recordPath)
      const outcome = read.kind === "record" ? read.record.outcome : undefined
      // A supervisor that ended without an outcome recorded was killed, so
      // the status it would have reported is its own death.
      return outcome === undefined
        ? { code: null, signal: null, statusOf: "supervisor" }
        : { code: outcome.code, signal: outcome.signal, statusOf: "payload" }
    },
    say: (line) => { connection.say(line) },
    // The channel stays open: its end is how this side observes the
    // supervisor's exit. A stop from an adopting owner is therefore the
    // supervisor's end of its container, retried until the container is empty.
    stop: (end) => {
      connection.say(encodeSupervisorWord({ kind: "stop" }))
      if (end !== undefined) endAtOnce(backend.container(command), end)
    },
    letGo() {
      connection.close()
      backend.forget(command)
    },
  })
  return {
    close: () => { connection.close() },
    handBack,
    async adopt(guardianPid, boundMs, word) {
      let adoption: CommandAdoption
      try {
        adoption = { guardianPid, guardianIdentity: identifyGuardian(identify(guardianPid)) }
      } catch (err) {
        // Nothing was asked, so the supervisor's one controller slot is
        // freed for a later attempt.
        connection.close()
        throw err
      }
      connection.say(encodeSupervisorWord({ kind: "adopt", adoption }))
      const answered = connection.next()
      let line: string | undefined
      try {
        line = await withDeadline(answered, boundMs)
      } catch (err) {
        // The answer may still come. An adoption taken after this side gave
        // up is handed straight back, so the supervisor never watches a
        // guardian that holds no lease of it.
        void answered.then((late) => {
          if (late !== undefined && decodeSupervisorAnswer(late).kind === "adopted") handBack(word)
          else connection.close()
        })
        throw err
      }
      if (line === undefined) {
        // The supervisor ended this connection unanswered. Either it exited,
        // or another owner controls it and it refused a second connection. A
        // second connection tells them apart without touching the container.
        const again = await connectLines(command.channel)
        if (again === undefined) return { kind: "gone" }
        again.close()
        throw new Error("another owner controls this command")
      }
      const answer = decodeSupervisorAnswer(line)
      if (answer.kind === "adopted") return { kind: "adopted", container: controlled() }
      connection.close()
      if (answer.kind === "refused") return { kind: "refused" }
      throw new Error(`the command's supervisor answered a word this release does not read: ${answer.word}`)
    },
  }
}

/** The guardian's identity, carried to the supervisor in its argv at a launch
 *  and in the adopt word at an adoption: the container must watch the
 *  guardian it was cleared against, not whatever process later holds that
 *  pid.
 *
 *  The launch or adoption must decide now, so it asks once. A guardian proven
 *  gone refuses it instead of leaving a container nothing backstops. A
 *  guardian nobody could identify refuses it too, because a container cannot
 *  watch a guardian it has no identity for, but the error says what happened
 *  rather than claiming the guardian died. Nothing is kept, so the next one
 *  asks again. */
export function identifyGuardian(identity: ProcessIdentity): string {
  if (identity.kind === "process") return identity.identity
  if (identity.kind === "absent") throw new Error("the process guardian is not running, so no container may depend on it")
  throw new Error("the process guardian could not be identified, so no container may depend on it")
}
