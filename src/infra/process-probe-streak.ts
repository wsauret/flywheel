import type { Log } from "./log.js"
import { coalesceRepeats } from "./repeat-coalescer.js"

/** The record of a process probe that did not answer (ARCH-TOOLS-026). Such a probe
 *  changes no decision: the container it asked about stays, and the next
 *  check asks again. A streak of them is recorded once when it starts, with
 *  its evidence, and its repeats count. */

/** How long one streak of unanswered process probes collects repeats before
 *  its count is recorded. A probe that stops answering usually stays that
 *  way, so one count an hour shows that the streak continues without filling
 *  the log. */
export const UNANSWERED_PROBE_WINDOW_MS = 60 * 60_000

interface StreakFields {
  readonly [field: string]: unknown
}

/** One container's streak of emptyings that did not prove it empty. Each
 *  unsettled emptying is observed with its own evidence; `end` reports the
 *  count once the container is empty or its owner stops emptying it. */
interface UnsettledEmptyingStreak {
  observe(evidence: StreakFields): void
  end(): void
}

/** Starts one container's streak of unsettled emptyings. `owner` names who
 *  keeps the container and empties it again, and `identity` holds the fields
 *  both records carry. */
export function unsettledEmptyingStreak(log: Pick<ReturnType<typeof Log.create>, "warn">, owner: string, identity: StreakFields = {}): UnsettledEmptyingStreak {
  const streak = coalesceRepeats<StreakFields>({
    windowMs: UNANSWERED_PROBE_WINDOW_MS,
    first: (_container, evidence) => { log.warn(`the container was not proven empty; ${owner} keeps it and empties it again`, { ...identity, ...evidence }) },
    repeated: (_container, repeats) => { log.warn("the container was not proven empty again", { ...identity, count: repeats.count, windowMs: repeats.windowMs }) },
  })
  return { observe: (evidence) => streak.observe("container", evidence), end: () => streak.end() }
}
