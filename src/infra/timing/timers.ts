/** The longest delay one timer can hold, about 24.8 days. A runtime fires a
 *  longer delay at once instead of late, so a later deadline needs several
 *  timers, and a third-party timer that Flywheel must keep from firing is
 *  raised to this value rather than past it. */
export const MAX_TIMER_MS = 2 ** 31 - 1
