import type { EventBus, Unsubscribe } from "../../infra/event-bus.js"
import { FLYWHEEL_EVENT_TYPES, type FlywheelEvent, toRuntimeEvent } from "../../infra/events.js"
import { formatCompactionReport } from "../../protocol/client/format.js"
import { RUNTIME_EVENT_TYPES, type RuntimeEvent } from "../../infra/runtime-event-types.js"
import type { OutputProjectionEvent } from "../../infra/output/output-projection-events.js"
import type { OutputSession } from "../runner/output-session.js"
import type { ChatEntryPatch } from "./types.js"

const compactionTypes = new Set<RuntimeEvent["type"]>(["agent.compaction.started", "agent.compaction.completed"])
const passThroughTypes: ReadonlySet<FlywheelEvent["type"]> = new Set(RUNTIME_EVENT_TYPES.filter((type) => !compactionTypes.has(type)))
function passThrough(event: FlywheelEvent): event is Extract<FlywheelEvent, { type: Exclude<RuntimeEvent["type"], "agent.compaction.started" | "agent.compaction.completed"> }> {
  return passThroughTypes.has(event.type)
}

/** Projects one ordinary conversation. Its execution lease owns all persistence. */
export class SessionEventAdapter {
  private unsubscribe: Unsubscribe | undefined
  constructor(private readonly options: {
    readonly outputSession: OutputSession
    readonly updateEntry: (patch: ChatEntryPatch) => void
  }) {}

  connect(bus: EventBus): void {
    this.disconnect()
    this.unsubscribe = bus.subscribeToTypes(FLYWHEEL_EVENT_TYPES, (event) => this.handle(event), {
      delivery: "direct", deliveryClass: "critical", label: "session-event-adapter",
    })
  }

  applyProjectionEvent(event: OutputProjectionEvent): void {
    this.options.outputSession.applyProjectionEvent(event)
  }

  flush(): void { this.options.outputSession.flush() }

  disconnect(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  /** Projects one event. A sole producer calls it directly, in emit order. */
  handle(event: FlywheelEvent): void {
    const { outputSession: output, updateEntry } = this.options
    if (passThrough(event)) {
      output.dispatchRuntimeEvent(toRuntimeEvent(event), event.timestamp)
      if (event.type === "model.user_message.recorded" && event.data.message?.origin === "user") {
        output.drainQueued()
        output.flush()
      }
      return
    }
    switch (event.type) {
      case "agent.turn.parked":
        updateEntry({
          runnerState: "idle",
          ...(event.data.park === "waiting_on_work" ? {} : { streamingStartedAt: null }),
          waitingOnBackgroundWork: event.data.park === "waiting_on_work",
        })
        break
      case "agent.user_input.awaiting":
        updateEntry({ runnerState: "awaiting_user", streamingStartedAt: null, waitingOnBackgroundWork: false })
        break
      case "agent.turn.resumed":
      case "agent.user_input.resumed":
        updateEntry({ runnerState: "streaming", streamingStartedAt: event.timestamp, waitingOnBackgroundWork: false })
        break
      case "agent.logical_turn.started":
        updateEntry({ runnerState: "streaming", streamingStartedAt: event.timestamp, waitingOnBackgroundWork: false })
        output.beginTurn()
        break
      case "agent.logical_turn.ended":
        output.endTurn(event.data.status === "paused" ? "paused" : "completed")
        break
      case "agent.message.injected":
        output.pushUserMessage(event.data.message, event.timestamp, {
          entryId: event.data.dispatchIds?.[0],
          queued: event.data.pending, injected: event.data.origin === "system",
          ...(event.data.submissionIds ? { submissionIds: event.data.submissionIds } : {}),
          ...(event.data.dispatchIds ? { dispatchIds: event.data.dispatchIds } : {}),
          ...(event.data.from ? { from: event.data.from } : {}),
        })
        break
      case "agent.system_message.recorded":
        output.pushSystemMessage(event.data.message, event.timestamp, {
          level: event.data.level,
          ...("mutationEvidence" in event.data ? { mutationEvidence: event.data.mutationEvidence } : {}),
        })
        output.flush()
        break
      case "agent.notice.changed":
        updateEntry({ noticeOperation: { operation: event.data.operation, timestamp: event.timestamp } })
        break
      case "agent.compaction.started":
        if (!event.data.parent_tool_use_id) updateEntry({ compactionStartedAt: Date.now() })
        break
      case "agent.compaction.completed":
        if (event.data.parent_tool_use_id) break
        updateEntry({ compactionStartedAt: null })
        if (event.data.status === "completed") {
          output.pushSystemMessage(formatCompactionReport(event.data.tokens_before, event.data.tokens_after), event.timestamp)
          output.flush()
        }
        break
    }
  }
}
