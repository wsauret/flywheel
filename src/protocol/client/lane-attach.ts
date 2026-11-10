import type { FrontendMutation, RuntimeQuery } from "../app-service-types.js"
import type { LaneEndCause, RuntimeClientDiagnostic } from "../runtime-client-diagnostics.js"

/** Where a call goes when a lane opens. The output watch statement goes
 *  first, because the runtime sends a session's live output only once it is
 *  watched, and a transcript read must not see output that its lane then
 *  withholds. The transcript read goes next, because it is what the person
 *  waits for. A hold (an activation, a held detail read, or a release of
 *  either or of a followed background index) lasts only as long as the
 *  connection that carries it, and every holder holds again on each new
 *  lane, so a hold that waited for the lane is dropped instead of sent
 *  twice. */
export type LaneCall = "watch" | "transcript" | "hold" | "call"

export function laneCallOf(request: RuntimeQuery | FrontendMutation): LaneCall {
  switch (request.type) {
    case "output.watch":
      return "watch"
    case "outputWindow":
      return "transcript"
    case "session.activate":
    case "session.release":
    case "session_detail.release":
    case "background.release":
    case "sessionDetailSnapshot":
      return "hold"
    default:
      return "call"
  }
}

/** A call waiting for the lane to open. */
export interface LaneWait {
  readonly kind: LaneCall
  readonly go: () => void
  readonly fail: (cause: unknown) => void
}

/** The calls a lane sends, in order, and the holds it drops. */
interface LaneBurst {
  readonly send: readonly LaneWait[]
  readonly dropped: readonly LaneWait[]
}

/** The calls a lane opens with, in the order they go out: the output watch
 *  statement, the transcript reads, then every other call in the order it
 *  was made. Holds that waited for the lane are returned apart, to be
 *  dropped; a hold made by a lane listener is that lane's own and goes out. */
export function laneBurst(waited: readonly LaneWait[], seeds: readonly LaneWait[]): LaneBurst {
  const calls = [...waited.filter((wait) => wait.kind !== "hold"), ...seeds]
  const first: readonly LaneCall[] = ["watch", "transcript"]
  return {
    send: [...first.flatMap((kind) => calls.filter((wait) => wait.kind === kind)), ...calls.filter((wait) => !first.includes(wait.kind))],
    dropped: waited.filter((wait) => wait.kind === "hold"),
  }
}

/** Where the time to one lane went, from the end of the lane before it to
 *  the runtime's first answer on it. The connection reports it once, so the
 *  runtime records one line per lane with durations and kinds only. */
export class LaneAttachTiming {
  private attempts = 0
  private backoffMs = 0
  private attemptStartedAt = 0
  private openedAt: number | undefined
  private dialMs = 0
  private transcriptMs: number | undefined
  private burst = 0
  private reported = false

  constructor(
    private readonly previous: "first" | LaneEndCause,
    private readonly endedAt: number | undefined,
    private readonly previousVisibility?: "visible" | "hidden",
  ) {}

  attemptStarted(at: number): void {
    this.attempts += 1
    this.attemptStartedAt = at
  }

  waitedBackoff(ms: number): void {
    this.backoffMs += ms
  }

  opened(at: number, burst: number): void {
    this.openedAt = at
    this.dialMs = at - this.attemptStartedAt
    this.burst = burst
  }

  /** The first transcript read of the lane reached its socket. */
  transcriptWritten(at: number): void {
    if (this.openedAt !== undefined) this.transcriptMs ??= at - this.openedAt
  }

  /** The record for the runtime's first answer, or nothing when the lane
   *  never opened or was already reported. */
  answered(at: number): RuntimeClientDiagnostic | undefined {
    const opened = this.openedAt
    if (this.reported || opened === undefined) return undefined
    this.reported = true
    const previous = this.previous
    const previousEnd = previous === "first" ? "first"
      : previous.kind === "requested" || previous.kind === "probe" ? previous.kind
        : previous.kind === "closed" && previous.code === 1000 ? "ended" : "failed"
    return {
      kind: "lane_attach",
      previousEnd,
      ...(previous === "first" ? {} : { previousCause: previous }),
      ...(this.previousVisibility === undefined ? {} : { previousVisibility: this.previousVisibility }),
      attempts: this.attempts,
      ...(this.endedAt === undefined ? {} : { gapMs: opened - this.endedAt }),
      backoffMs: this.backoffMs,
      dialMs: this.dialMs,
      answerMs: at - opened,
      ...(this.transcriptMs === undefined ? {} : { transcriptMs: this.transcriptMs }),
      burst: this.burst,
    }
  }
}
