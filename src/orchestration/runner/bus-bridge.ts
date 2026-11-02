/**
 * Single source of truth for translating agent-runner loop callbacks
 * (`onEvent`, lifecycle callbacks) into event-bus emits. The
 * optional `isLive` predicate is evaluated lazily on every callback so stale
 * runners can no-op uniformly without bespoke guards at each call site.
 */

import type { LogicalTurnStartedContext, TurnParkedContext } from "../../infra/agent-loop-events.js"
import type { EmitFn } from "../../infra/event-bus.js"
import type { RuntimeEvent } from "../../infra/runtime-event-types.js"
import type { SessionNoticeOperation } from "../../infra/session-notice.js"
import type { AgentLifecycleCallbacks } from "../agent-runtime/types.js"

export function createRunnerBusBridge(deps: {
  emit: EmitFn
  sessionId: string
  isLive?: () => boolean
}) {
  const { emit, sessionId, isLive } = deps
  const lifecycle = {
    onTurnParked(ctx: TurnParkedContext) {
      if (isLive?.() === false) return
      emit("agent.turn.parked", { sessionId, data: ctx })
    },
    onTurnResumed() {
      if (isLive?.() === false) return
      emit("agent.turn.resumed", { sessionId, data: {} })
    },
    onLogicalTurnStarted(ctx: LogicalTurnStartedContext) {
      if (isLive?.() === false) return
      emit("agent.logical_turn.started", { sessionId, data: ctx })
    },
  } satisfies AgentLifecycleCallbacks
  return {
    onEvent(event: RuntimeEvent) {
      if (isLive?.() === false) return
      emit(event.type, { sessionId, data: event.data })
    },
    onNotice(operation: SessionNoticeOperation) {
      if (isLive?.() === false) return
      emit("agent.notice.changed", { sessionId, data: { operation } })
    },
    lifecycle,
  }
}
