/** Cross-realm deadline tiers, named for the round-trip they bound. Pass the
 *  tier matching the call site; there is no caller-chosen abstraction.
 *
 *  CONTROL_RPC_DEADLINE_MS — a unary cosmetic read from the runtime. Fast: a
 *  healthy runtime answers in milliseconds. User-action calls are lossless and
 *  do not use this tier.
 *
 *  OUTPUT_HISTORY_RPC_DEADLINE_MS — a bounded historical transcript read from
 *  the runtime. Wider than control calls because it may reconstruct
 *  and serialize a page of indexed transcript content, but still bounded so a bad
 *  page cannot wedge the TUI.
 *
 *  MODEL_CONFIG_RPC_DEADLINE_MS — model assignment/config queries. These may
 *  touch the provider listing cache or wait for a provider-listing timeout, so
 *  they are not control-plane hot-path calls.
 */
export const CONTROL_RPC_DEADLINE_MS = 5_000
export const OUTPUT_HISTORY_RPC_DEADLINE_MS = 12_000
export const MODEL_CONFIG_RPC_DEADLINE_MS = 12_000

/** Rejected when a bounded IPC wait overruns its deadline. Infra-level and
 *  plain (infra imports nothing from src/): orchestration callers catch it and
 *  re-throw the client-local RuntimeCallTimeout that belongs to their layer. */
export class DeadlineExceeded extends Error {
  override readonly name = "DeadlineExceeded"
  constructor(readonly deadlineMs: number) {
    super(`operation exceeded its ${deadlineMs}ms deadline`)
  }
}

/** Races `inner` against a deadline timer, rejecting with DeadlineExceeded if
 *  the timer wins. The timer is injected (default setTimeout) so tests fire the
 *  deadline deterministically without sleeping. Promise-only: every concrete
 *  consumer is async/await, and the Effect-native path uses Effect.timeout
 *  directly — a dual-mode helper would only force an `as` cast. */
export function withDeadline<T>(
  inner: Promise<T>,
  deadlineMs: number,
  options: { readonly setTimer?: (fire: () => void) => () => void } = {},
): Promise<T> {
  const setTimer = options.setTimer ?? ((fire) => {
    const handle = setTimeout(fire, deadlineMs)
    return () => clearTimeout(handle)
  })
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let firedBeforeTimerReturned = false
    let cancel = (): void => { firedBeforeTimerReturned = true }
    const fire = (): void => {
      if (settled) return
      settled = true
      cancel()
      reject(new DeadlineExceeded(deadlineMs))
    }
    cancel = setTimer(fire)
    if (firedBeforeTimerReturned) cancel()
    inner.then(
      (value) => {
        if (settled) return
        settled = true
        cancel()
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        cancel()
        reject(err)
      },
    )
  })
}
