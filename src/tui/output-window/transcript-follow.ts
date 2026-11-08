/** Whether the terminal transcript follows its tail, and the baseline of
 *  messages the reader had seen when they left it. A remount latch and a
 *  pending tail are different variants, so a restore never also pins.
 *  - following: the tail pins each frame.
 *  - pendingTail: End or Return to latest asked for the real tail; it pins
 *    once newer history is not pending. The baseline counts what arrives
 *    while the newer window loads.
 *  - detached: the reader is off the tail. `landed` marks a place a land
 *    chose, which reaching the bottom does not end. `restoring` is the remount
 *    latch: the restored offset holds until the extent proves it. */
export type TranscriptFollow =
  | { readonly kind: "following" }
  | { readonly kind: "pendingTail"; readonly baseline: number | undefined }
  | { readonly kind: "detached"; readonly baseline: number; readonly landed: boolean; readonly restoring: boolean }

/** One cause that can change the follow mode.
 *  - input: explicit navigation adopted a new offset.
 *  - toBottom: End, after its input; newer history may still be pending.
 *  - returnToLatest: the control asked for the live end.
 *  - remount: a keyed remount adopted the slot; `offTail` is whether the
 *    saved offset lay above the saved bottom.
 *  - rebase: the visible message count may have dropped below the baseline.
 *  - target: a frame took a handed-on place or a landing (`land`).
 *  - tailPinned: the frame pinned the tail.
 *  - restoreProven: the extent reached the restored offset.
 *  - settled: a frame's position, or newer history that is pending.
 *  - preserve: a collapse or expand toggle that must not move the view. */
export type TranscriptFollowEvent =
  | { readonly kind: "input"; readonly atBottom: boolean; readonly hasAfter: boolean }
  | { readonly kind: "toBottom"; readonly hasAfter: boolean }
  | { readonly kind: "returnToLatest" }
  | { readonly kind: "remount"; readonly offTail: boolean }
  | { readonly kind: "rebase" }
  | { readonly kind: "target"; readonly land: boolean }
  | { readonly kind: "tailPinned" }
  | { readonly kind: "restoreProven" }
  | { readonly kind: "settled"; readonly atLastBottom: boolean; readonly hasAfter: boolean }
  | { readonly kind: "preserve" }

export const FOLLOWING: TranscriptFollow = { kind: "following" }

const detached = (baseline: number, landed = false): TranscriptFollow => ({ kind: "detached", baseline, landed, restoring: false })

/** The visible-message count captured when the reader left the tail, or
 *  undefined while the transcript follows it. The Return to latest control
 *  shows while it is defined. */
export function followBaseline(follow: TranscriptFollow): number | undefined {
  return follow.kind === "following" ? undefined : follow.baseline
}

/** The follow mode after one event. `visibleMessages` is the count a new
 *  baseline captures. Return to latest, End, and explicit input all leave
 *  the remount latch, because none of them answers detached and restoring. */
export function nextTranscriptFollow(follow: TranscriptFollow, event: TranscriptFollowEvent, visibleMessages: number): TranscriptFollow {
  switch (event.kind) {
    case "input":
      return event.atBottom && !event.hasAfter ? FOLLOWING : detached(followBaseline(follow) ?? visibleMessages)
    case "toBottom":
      return event.hasAfter ? { kind: "pendingTail", baseline: undefined } : FOLLOWING
    case "returnToLatest":
      return { kind: "pendingTail", baseline: undefined }
    case "remount":
      // A restore that was at the bottom is positionally a fresh generation:
      // it pins the tail on the first laid-out frame. Only an off-tail place
      // latches, and a land at the bottom stays where the reader asked to be.
      if (follow.kind === "following") return { kind: "pendingTail", baseline: undefined }
      if (follow.kind === "pendingTail") return follow
      if (event.offTail) return { ...follow, restoring: true }
      return follow.landed ? { ...follow, restoring: false } : { kind: "pendingTail", baseline: follow.baseline }
    case "rebase":
      if (follow.kind === "following" || follow.baseline === undefined || visibleMessages >= follow.baseline) return follow
      return { ...follow, baseline: visibleMessages }
    case "target":
      return detached(followBaseline(follow) ?? visibleMessages, event.land)
    case "tailPinned":
      return FOLLOWING
    case "restoreProven":
      return follow.kind === "detached" ? { ...follow, restoring: false } : follow
    case "settled": {
      const atBottom = follow.kind === "detached" ? !follow.landed && event.atLastBottom : event.atLastBottom
      if (atBottom && !event.hasAfter) return follow.kind === "pendingTail" ? { kind: "pendingTail", baseline: undefined } : FOLLOWING
      if (follow.kind === "following") return detached(visibleMessages)
      if (follow.kind === "pendingTail") return { kind: "pendingTail", baseline: follow.baseline ?? visibleMessages }
      return follow
    }
    case "preserve":
      return follow.kind === "detached" ? follow : detached(followBaseline(follow) ?? visibleMessages)
  }
}
