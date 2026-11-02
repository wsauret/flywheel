import { createEmit } from "../../infra/event-bus.js"
import { isVisibleMessageBlock, messageSenderOf } from "../../infra/output-blocks.js"
import type { AttachChildSessionProjection } from "../module-seams.js"
import { SessionTranscriptProjection } from "../session/conversation/transcript-projection.js"
import { SessionEventAdapter } from "./event-adapter.js"
import { createRunnerBusBridge } from "../runner/bus-bridge.js"
import { createOutputSession } from "../runner/output-session.js"
import type { SessionStore } from "./types.js"
import { readSessionDurationFromReader } from "../session/session-duration-projection.js"

/** Attaches a projection, not a runner. Its events reach only its adapter, synchronously in emit order, and none is persisted. */
export function childSessionProjectionAttachment(store: Pick<SessionStore, "openSessionRuntime" | "updateChatEntry" | "remove">): AttachChildSessionProjection {
  return async (input) => {
    const transcript = new SessionTranscriptProjection({
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      executionCwd: input.executionCwd,
      store: input.eventStore,
      projectionReader: input.projectionReader,
      historyScope: "session",
    })
    let history
    try {
      history = await transcript.read()
    } finally {
      await transcript.dispose()
    }
    const blockCount = history?.blockCount ?? 0
    const start = Math.max(0, blockCount - 64)
    const priorBlocks = history ? await Promise.all(Array.from({ length: blockCount - start }, (_, index) => history.readBlock(start + index))) : []
    const visibleSuffix = priorBlocks.filter(isVisibleMessageBlock).length
    store.openSessionRuntime({
      ...(input.kind === "workflow-agent" ? { kind: input.kind, workflowId: input.workflowId } : { kind: "subagent" }),
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      description: input.description,
      priorBlocks,
      accumulatedActiveMs: (await readSessionDurationFromReader(input.projectionReader, input.sessionId)).accumulatedActiveMs,
      outputSequenceStart: start,
      visibleMessageCountPrefix: (history?.visibleMessageCount ?? 0) - visibleSuffix,
    })
    const updateEntry = (patch: Parameters<SessionStore["updateChatEntry"]>[1]) => store.updateChatEntry(input.sessionId, patch)
    const output = createOutputSession({ sessionId: input.sessionId, executionCwd: input.executionCwd, priorBlocks, updateEntry })
    const adapter = new SessionEventAdapter({ outputSession: output, updateEntry })
    let open = true
    const emit = createEmit({ emit: (event) => { if (open) adapter.handle(event) } })
    const bridge = createRunnerBusBridge({ emit, sessionId: input.sessionId })
    updateEntry({ runnerState: "streaming", streamingStartedAt: Date.now() })
    return {
      onEvent(event) {
        // Parent correlation routes the parent's compact card, not the child's own transcript.
        emit(event.type, { sessionId: input.sessionId, data: { ...event.data, parent_tool_use_id: undefined } })
      },
      queueUserMessage(message) {
        const from = messageSenderOf(message.producer)
        emit("agent.message.injected", {
          sessionId: input.sessionId,
          data: {
            message: message.invocation?.args ?? message.text,
            origin: "user",
            pending: true,
            ...(message.submissionIds?.length ? { submissionIds: message.submissionIds } : {}),
            ...(message.dispatchIds?.length ? { dispatchIds: message.dispatchIds } : {}),
            ...(from ? { from } : {}),
          },
        })
      },
      withdrawQueuedMessage(dispatchIds) {
        const restore = output.withdrawQueued(dispatchIds)
        output.flush()
        return restore ? () => { restore(); output.flush() } : null
      },
      lifecycle: {
        ...bridge.lifecycle,
        onConnectionState: (connectionState) => updateEntry({ connectionState }),
      },
      updateMetrics: updateEntry,
      updateBackgroundCommands: (commands) => updateEntry({ activeBackgroundCommands: commands }),
      updateForegroundBash: (ids) => updateEntry({ activeForegroundBashToolCallIds: ids }),
      updateOperations: (operations) => updateEntry({ operations }),
      async dispose() {
        output.endTurn("teardown")
        adapter.flush()
        open = false
        output.dispose()
        updateEntry({ runnerState: "absent", streamingStartedAt: null, waitingOnBackgroundWork: false, activeBackgroundCommands: [] })
        await store.remove(input.sessionId)
      },
    }
  }
}
