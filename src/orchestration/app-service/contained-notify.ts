import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"

const log = Log.create({ service: "notify" })
const FAILURE_WINDOW_MS = 30_000

/** The notify seam for producers that do not act on a failed delivery. */
export interface ContainedNotify {
  /** Never rejects. One refusing channel fails every delivery sent while it
   *  refuses, so the first failure records and the rest count until a
   *  delivery succeeds again. */
  readonly notify: (episode: NotificationEpisodeInput) => Promise<void>
  /** Reports a count still open, at shutdown. */
  readonly end: () => void
}

export function containNotifyFailures(settledNotify: (episode: NotificationEpisodeInput) => Promise<void>): ContainedNotify {
  const failures = coalesceRepeats<NotificationEpisodeInput["type"]>({
    windowMs: FAILURE_WINDOW_MS,
    first: (error, operation) => { log.error("notification delivery failed", { error, operation }) },
    repeated: (error, repeats) => { log.error("notification delivery failed again", { error, count: repeats.count, windowMs: repeats.windowMs }) },
  })
  return {
    notify: async (episode) => {
      try {
        await settledNotify(episode)
        failures.end()
      } catch (error) { failures.observe(errorMessage(error), episode.type) }
    },
    end: () => { failures.end() },
  }
}
