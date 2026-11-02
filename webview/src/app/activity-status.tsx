import { createEffect, createSignal, on, onCleanup, Show, useContext } from "solid-js"

import { isActiveActivity, type FrontendActivity } from "../../../src/protocol/app-service-types.js"
import { formatActivity, formatElapsed } from "../../../src/protocol/client/format.js"
import type { ClientViewState } from "../client/view-state.js"
import { TranscriptClock } from "./row-time.js"

/** The terminal's reassurance ramp for a long think, so a quiet minute reads as
 *  the machine still working rather than the connection having died. */
function reassurance(elapsedMs: number): string | undefined {
  if (elapsedMs >= 90_000) return "hang tight"
  if (elapsedMs >= 45_000) return "almost there"
  if (elapsedMs >= 30_000) return "this one's tricky"
  if (elapsedMs >= 20_000) return "bear with me"
  return undefined
}

interface ActivityStatusProps {
  readonly startedAt?: number | null | undefined
  readonly activity?: FrontendActivity
  readonly atTail: boolean
  readonly transcriptAvailable: boolean
  readonly settledOutputPosition: ClientViewState["settledOutputPosition"]
  readonly appliedOutputPosition: number | null
  /** What the session waits on while it is parked on a reply ("Waiting on
   *  parent"), which the row shows in place of an activity. */
  readonly waitingOn?: string | undefined
}

/** Shows current activity until the transcript applies the settled output cursor. */
export function ActivityStatus(props: ActivityStatusProps) {
  type Lifecycle = "active" | "holding" | "exiting"
  const [lifecycle, setLifecycle] = createSignal<Lifecycle>("exiting")
  const [verb, setVerb] = createSignal("")
  const sharedClock = useContext(TranscriptClock)
  let observedActive = false
  let renderedFrame: number | undefined
  let exitFrame: number | undefined
  let exitScheduled = false

  const cancelExit = () => {
    if (renderedFrame !== undefined) cancelAnimationFrame(renderedFrame)
    if (exitFrame !== undefined) cancelAnimationFrame(exitFrame)
    renderedFrame = undefined
    exitFrame = undefined
    exitScheduled = false
  }
  const beginExit = () => {
    if (lifecycle() === "exiting" || exitScheduled) return
    exitScheduled = true
    renderedFrame = requestAnimationFrame(() => {
      renderedFrame = undefined
      exitFrame = requestAnimationFrame(() => {
        exitFrame = undefined
        exitScheduled = false
        observedActive = false
        setLifecycle("exiting")
      })
    })
  }

  createEffect(on(
    () => [props.activity, props.transcriptAvailable, props.atTail, props.settledOutputPosition, props.appliedOutputPosition, props.waitingOn] as const,
    ([activity, transcriptAvailable, atTail, settled, applied, waitingOn]) => {
      if (waitingOn !== undefined) {
        cancelExit()
        observedActive = true
        setVerb(waitingOn)
        setLifecycle("active")
        return
      }
      if (isActiveActivity(activity)) {
        cancelExit()
        observedActive = true
        setVerb(`${formatActivity(activity)}…`)
        setLifecycle("active")
        return
      }
      if (observedActive && activity === "idle" && transcriptAvailable && atTail && settled !== null && (typeof settled === "object" || applied === null || applied < settled)) {
        cancelExit()
        setLifecycle("holding")
        return
      }
      beginExit()
    },
  ))

  onCleanup(cancelExit)
  const elapsed = () => lifecycle() !== "active" || props.startedAt == null ? undefined : Math.max(0, (sharedClock?.now() ?? Date.now()) - props.startedAt)
  const reassuranceText = () => {
    const duration = elapsed()
    return duration === undefined || props.waitingOn !== undefined || props.activity !== "thinking" ? undefined : reassurance(duration)
  }

  return (
    <div class="activity-status" classList={{ hidden: lifecycle() === "exiting" }} aria-hidden={lifecycle() === "exiting"}>
      <div class="working">
        <span class="working-marker" />
        <span>{verb()}</span>
        <Show when={elapsed() !== undefined}><span>{formatElapsed(elapsed()!)}</span></Show>
        <Show when={reassuranceText()}><span class="working-aside">{reassuranceText()}</span></Show>
      </div>
    </div>
  )
}
