/** Repeats of one condition coalesce into one record (ARCH-RUNTIME-077).
 *
 *  The first occurrence of a condition records in full, with its evidence.
 *  Later occurrences inside the window only count, and the count is reported
 *  once, when the window closes or the condition ends. A window that closed
 *  with repeats opens the next one, so a condition that keeps recurring
 *  writes one summary per window; a window that closed with none ends the
 *  episode, and the next occurrence records in full again. One lost
 *  connection that fails eighty queries in a second is one record and one
 *  count, not eighty stacks. */

/** Repeats kept for a summary. The count stays exact past it. */
const MAX_SAMPLE = 256

export interface Repeats<E> {
  /** Occurrences after the one recorded in full, in this window. */
  readonly count: number
  /** The first of them, in arrival order, at most MAX_SAMPLE. */
  readonly events: readonly E[]
  /** Time from the window's start to this report. */
  readonly windowMs: number
}

export interface RepeatCoalescer<E> {
  /** One occurrence of the condition `key` names. */
  observe(key: string, event: E): void
  /** The condition changed or ended: reports the repeats of `key`, or of
   *  every condition, now, and closes its episode. An owner calls it with
   *  no key when it closes, so no count is lost with it. */
  end(key?: string): void
}

interface Episode<E> {
  startedAt: number
  count: number
  events: E[]
  timer: ReturnType<typeof setTimeout>
}

export function coalesceRepeats<E>(options: {
  readonly windowMs: number
  readonly first: (key: string, event: E) => void
  readonly repeated: (key: string, repeats: Repeats<E>) => void
}): RepeatCoalescer<E> {
  const episodes = new Map<string, Episode<E>>()

  const report = (key: string, episode: Episode<E>): void => {
    if (episode.count === 0) return
    options.repeated(key, { count: episode.count, events: episode.events, windowMs: Date.now() - episode.startedAt })
  }

  const arm = (key: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => {
      const episode = episodes.get(key)
      if (episode === undefined) return
      if (episode.count === 0) {
        episodes.delete(key)
        return
      }
      report(key, episode)
      episodes.set(key, { startedAt: Date.now(), count: 0, events: [], timer: arm(key) })
    }, options.windowMs)
    // A pending report must never hold its process open.
    timer.unref?.()
    return timer
  }

  const end = (key: string, episode: Episode<E>): void => {
    clearTimeout(episode.timer)
    episodes.delete(key)
    report(key, episode)
  }

  return {
    observe(key, event) {
      const episode = episodes.get(key)
      if (episode === undefined) {
        episodes.set(key, { startedAt: Date.now(), count: 0, events: [], timer: arm(key) })
        options.first(key, event)
        return
      }
      episode.count += 1
      if (episode.events.length < MAX_SAMPLE) episode.events.push(event)
    },
    end(key) {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const [open, episode] of episodes) {
        if (key === undefined || key === open) end(open, episode)
      }
    },
  }
}
