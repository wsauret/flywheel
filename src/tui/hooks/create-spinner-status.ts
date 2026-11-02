import type { Accessor } from "solid-js"
import { createEffect, createMemo, on } from "solid-js"
import { Log } from "../../infra/log.js"
import type { ConnectionState, StreamPhase } from "../../infra/output-blocks.js"
import type { SessionNotice } from "../../infra/session-notice.js"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import { replyWaitLabel } from "../../protocol/client/session-controls.js"
import {
  type AnimationState,
  advanceAnimation,
  buildStatus,
  initialAnimationState,
  STALL_THRESHOLD_MS,
  STALL_THRESHOLDS,
  statusEquals,
} from "./spinner-status-animation.js"

export interface SpinnerStatusSource {
  sessionId: Accessor<string | undefined>
  status: Accessor<StatusView | undefined>
  /** The characters the session's current phase has streamed, from its
   *  transcript; undefined while the count is not known yet. */
  streamingOutputChars: Accessor<number | undefined>
  agentState: Accessor<"idle" | "active">
  waitingOnBackgroundWork: Accessor<boolean>
  /** The session that started this one, which a wait names "parent". */
  parentSessionId: Accessor<string | undefined>
  compactionStartedAt: Accessor<number | null>
  notice: Accessor<SessionNotice | null>
}

interface SpinnerStatusDeps {
  source: SpinnerStatusSource
  terminalWidth: Accessor<number>
  /** 50ms animation tick: drives token-smoothing, stall easing, and timed thinking hints. */
  tick: Accessor<number>
}

const log = Log.create({ service: "spinner" })

/** Whether the status line animates now: a turn runs, the context compacts, or
 *  a status notice shows. The owner of a status line runs its 50 ms tick only
 *  while this is true; a live state change folds without the tick. */
export function spinnerAnimates(source: SpinnerStatusSource): boolean {
  return source.agentState() === "active" || source.compactionStartedAt() !== null || source.notice() !== null
}

export function createSpinnerStatus(deps: SpinnerStatusDeps) {
  const { source } = deps
  const liveStatus = source.status
  const liveChars = () => source.streamingOutputChars() ?? 0
  const liveActivity = (): StreamPhase | null => {
    const activity = liveStatus()?.activity
    if (!activity || activity === "absent" || activity === "idle" || activity === "awaiting_user") return null
    return activity === "executing_tools" ? "tool_executing" : activity
  }
  // A dropped runtime connection is not this line's business: recovery is
  // invisible, and a fault renders as its own notice in the shell.
  const liveConnection = (): ConnectionState => liveStatus()?.connectionState ?? "connected"
  const liveNotice = source.notice
  // Parked-only, straight from the runner projection: it is already true when a
  // park has live subagents (session-event-adapter). A live subagent count on its
  // own is parallel work, not a park - the foreground runner keeps owning the
  // status line while it thinks and generates.
  const liveBackgroundWait = source.waitingOnBackgroundWork
  const liveBackgroundProcessCount = () => liveStatus()?.activeBackgroundCommands.length ?? 0

  // A folded advance over current live inputs, not the bare initial state: the
  // first synchronous status() read (the footer's first render frame) must
  // already reflect live activity/agentActive; otherwise a mid-generation
  // session flickers null.
  const buildSeedState = (now: number): AnimationState => {
    const chars = liveChars()
    return advanceAnimation(
      initialAnimationState(chars, now),
      { activity: liveActivity(), realChars: chars, agentActive: source.agentState() === "active", backgroundWaitActive: liveBackgroundWait(), connectionState: liveConnection(), compacting: source.compactionStartedAt() !== null, notice: liveNotice() },
      now,
    )
  }

  // The status is a view of live state, so every input change folds at once.
  // A status line stays on screen under an overlay, such as the shell's
  // composer under a child viewer, so the fold never waits for visibility. The
  // tick only paces the animation. The fold seeds again when the session's
  // count first becomes known, so the count a tab switch reads late shows at
  // once instead of ramping up from zero.
  const animationFold = createMemo<{ sessionId: string | undefined; charsKnown: boolean; state: AnimationState }>((previous) => {
    deps.tick()
    const sessionId = source.sessionId()
    const charsKnown = source.streamingOutputChars() !== undefined
    const chars = liveChars()
    const activity = liveActivity()
    const connectionState = liveConnection()
    const notice = liveNotice()
    const compacting = source.compactionStartedAt() !== null
    const agentActive = source.agentState() === "active"
    const backgroundWaitActive = liveBackgroundWait()
    const prior = previous && previous.sessionId === sessionId && (previous.charsKnown || !charsKnown) ? previous.state : buildSeedState(Date.now())
    return {
      sessionId,
      charsKnown,
      state: advanceAnimation(prior, { activity, realChars: chars, agentActive, backgroundWaitActive, connectionState, compacting, notice }, Date.now()),
    }
  })
  const anim = () => animationFold().state
  const firedThresholds = new Set<number>()
  let maxStallMs = 0

  createEffect(
    on(
      source.sessionId,
      () => {
        firedThresholds.clear()
        maxStallMs = 0
      },
      { defer: true },
    ),
  )

  const timeSinceLastToken = createMemo(() => anim().timeSinceLastToken)
  createEffect(on(timeSinceLastToken, (stall) => {

    if (stall >= STALL_THRESHOLD_MS) {
      maxStallMs = Math.max(maxStallMs, stall)
    }

    for (const threshold of STALL_THRESHOLDS) {
      if (stall >= threshold && !firedThresholds.has(threshold)) {
        firedThresholds.add(threshold)
        log.warn("spinner status stalled", { sessionId: source.sessionId(), thresholdMs: threshold, timeSinceLastToken: stall })
      }
    }

    if (stall < STALL_THRESHOLD_MS && firedThresholds.size > 0) {
      log.warn("spinner status stall cleared", { sessionId: source.sessionId(), maxStallMs, thresholds: [...firedThresholds] })
      firedThresholds.clear()
      maxStallMs = 0
    }
  }))

  const status = createMemo(
    () =>
      buildStatus(anim(), {
        terminalWidth: deps.terminalWidth(),
        compacting: source.compactionStartedAt() !== null,
        notice: liveNotice(),
        nowMs: Date.now(),
        activeBackgroundProcessCount: liveBackgroundProcessCount(),
        waitingOn: replyWaitLabel({ waitingOnBackgroundWork: liveBackgroundWait(), replyWaits: liveStatus()?.replyWaits ?? [] }, source.parentSessionId()),
      }),
    undefined,
    { equals: statusEquals },
  )

  return { status }
}
