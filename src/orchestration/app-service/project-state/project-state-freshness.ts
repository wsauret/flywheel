/** How long a barrier that some request in flight may still answer waits
 *  before it sends its own capture. */
const CAPTURE_DEFERRAL_MS = 2

/** A reader waiting for its barrier. `mark` is the lowest id that a request
 *  sent after its call can have. */
interface BarrierWaiter {
  readonly mark: number
  readonly resolve: (position: number) => void
  readonly reject: (error: Error) => void
}

/** The client's request liveness, which it owns alone: its id allocation and
 *  its map of requests in flight. Every read is O(1). */
export interface ProjectStateRequestLiveness {
  /** The id that the next request sent gets. */
  nextId(): number
  /** Whether any request is in flight. */
  anyPending(): boolean
  /** Whether request `id` is in flight. */
  pending(id: number): boolean
}

/** The barrier that keeps a local read of the commit window as fresh as a
 *  read of the store. A reader waits for the head of a response to a request
 *  sent after its call, on any lane, and pays for a capture of its own only
 *  when no such request is coming. It serves ARCH-SUBSTRATE-019.
 *
 *  It owns request causality and timing only: the client owns request
 *  liveness and reports each control request it sends and each response it
 *  receives, and the commit window stays the owner of the facts. */
export interface ProjectStateFreshness {
  /** Answers a committed position at least as new as every commit that
   *  completed before the call. Rejects when the capture sent for it fails
   *  or the client ends. */
  barrier(): Promise<number>
  /** The client sent control request `id`. Ids grow with each send. */
  sentControl(id: number): void
  /** Request `id` was answered with `head`, after the client stopped
   *  counting it as pending. For a position capture, `capture` is the
   *  position it answered or the error that it failed with. */
  answered(id: number, head: number | undefined, capture?: number | Error): void
  /** Fails every waiting reader and stops the pending capture. */
  end(error: Error): void
}

/** `requestCapture` sends one position capture through the client, so its
 *  response reaches `answered`. It rejects when the capture is not served. */
export function createProjectStateFreshness(
  requests: ProjectStateRequestLiveness,
  requestCapture: () => Promise<number>,
): ProjectStateFreshness {
  const waiters: BarrierWaiter[] = []
  /** The id of the newest control request sent. The control lane is FIFO
   *  through the account and the Worker, so while it is in flight it will
   *  answer before a capture sent now would. */
  let newestControl = 0
  /** The capture in flight; at most one is. */
  let capture: object | undefined
  let cancelFallback: (() => void) | undefined

  function covered(): boolean {
    // SAFETY: called only while a waiter waits.
    return newestControl >= waiters.at(-1)!.mark && requests.pending(newestControl)
  }

  /** Sends the fallback capture at the next task when nothing is in flight,
   *  so an idle reader pays no delay and the readers of one tick share it,
   *  and after a short deferral otherwise, so the response to a request
   *  sent meanwhile can serve the barrier instead. */
  function scheduleCapture(): void {
    if (waiters.length === 0 || capture || cancelFallback || covered()) return
    if (!requests.anyPending()) {
      const immediate = setImmediate(sendCapture)
      cancelFallback = () => clearImmediate(immediate)
    } else {
      const timer = setTimeout(sendCapture, CAPTURE_DEFERRAL_MS)
      cancelFallback = () => clearTimeout(timer)
    }
  }

  function sendCapture(): void {
    cancelFallback = undefined
    if (waiters.length === 0 || capture || covered()) return
    const sent = {}
    capture = sent
    const upTo = requests.nextId()
    // A capture that the Worker answered settles in `answered`. One refused
    // or lost before any response fails the readers it was sent for.
    void requestCapture().catch((error: Error) => {
      if (capture !== sent) return
      capture = undefined
      for (const waiter of takeWaiters(upTo)) waiter.reject(error)
      scheduleCapture()
    })
  }

  /** Removes and answers the waiters whose mark is at most `id`. */
  function takeWaiters(id: number): BarrierWaiter[] {
    let count = 0
    // SAFETY: count is below waiters.length.
    while (count < waiters.length && waiters[count]!.mark <= id) count += 1
    return waiters.splice(0, count)
  }

  return {
    barrier() {
      return new Promise<number>((resolve, reject) => {
        waiters.push({ mark: requests.nextId(), resolve, reject })
        scheduleCapture()
      })
    },
    sentControl(id) {
      newestControl = id
    },
    // The head serves every reader whose call came before the request was
    // sent, and a capture's own position does too when it travels without a head.
    answered(id, head, outcome) {
      if (head !== undefined) for (const waiter of takeWaiters(id)) waiter.resolve(head)
      if (outcome !== undefined) {
        capture = undefined
        for (const waiter of takeWaiters(id)) {
          if (outcome instanceof Error) waiter.reject(outcome)
          else waiter.resolve(outcome)
        }
      }
      scheduleCapture()
    },
    end(error) {
      cancelFallback?.()
      cancelFallback = undefined
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
  }
}
