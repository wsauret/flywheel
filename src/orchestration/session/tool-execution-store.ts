import type { EmitFn } from "../../infra/event-bus.js"
import type { AsyncEventReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { truncateField } from "../../infra/truncate-field.js"
import {
  createToolExecutionProjection,
  TOOL_EXECUTION_FACT_TYPES,
  toolExecutionTimelineFromProjection,
} from "./tool-execution-projection.js"
import type { EventProjection } from "../../infra/event-projection.js"
import type { SessionRuntimeFact } from "./session-runtime-event-types.js"
import type { SessionToolExecutionStore, ToolExecutionEntry, ToolExecutionState } from "./tool-execution-types.js"
import type { SessionFactWriter } from "./session-fact-writer.js"

const MAX_FIELD_BYTES = 4096

const TOOL_EXECUTION_EVENT_TYPE_SET: ReadonlySet<string> = new Set(TOOL_EXECUTION_FACT_TYPES)

interface SessionToolExecutionStoreDeps {
  sessionId: string
  projectionReader: AsyncEventReadSurface
  /** The session's tool-execution projection when the caller already holds
   *  it, such as an activation whose completion sweep read the same calls:
   *  the calls then fold once for both. */
  projection?: EventProjection<ToolExecutionState>
  emitter?: EmitFn
  /** Invoked after every apply where the projection-derived active-subagent
   *  set changed. The set is the source of truth for the parent's "busy"
   *  signal; consumers push it onto the session entry so the tab spinner
   *  reflects only invisible child work (subagents), never workflow launches. */
  onActiveSubagentsChanged?: (ids: ReadonlySet<string>) => void
}

export function createSessionToolExecutionStore(
  deps: SessionToolExecutionStoreDeps,
): SessionToolExecutionStore {
  const { sessionId, emitter } = deps
  const projection = deps.projection ?? createToolExecutionProjection(deps.projectionReader, sessionId)
  let disposed = false
  let reportedActiveSubagentRevision: number | undefined

  async function applyStoredFact(stored: StoredFact): Promise<void> {
    if (disposed) return
    reportedActiveSubagentRevision ??= projection.getState().activeSubagentRevision
    // Only a tool fact needs a fold and a trace. The projection reads for no
    // other fact.
    if (!TOOL_EXECUTION_EVENT_TYPE_SET.has(stored.type)) return
    // The entry before this fact is read before the fold awaits: another
    // holder of the shared projection can fold the fact meanwhile, and a
    // later snapshot would then hide the transition this fact makes. Every
    // tool fact names its call, and the fold rejects one that does not.
    const toolUseId = stored.payload.toolUseId
    const beforeEntry = typeof toolUseId === "string" ? projection.getState().tools[toolUseId] : undefined
    const after = await projection.apply(stored)
    if (deps.onActiveSubagentsChanged) notifyActiveSubagents(after)
    if (!emitter || typeof toolUseId !== "string") return
    const entry = after.tools[toolUseId]
    if (!entry || entry === beforeEntry) return
    switch (stored.type) {
      case "tool.input.completed":
      case "tool.runtime_invocation.recorded":
        emitTraceStarted(entry)
        return
      case "tool.validation.failed":
        emitTraceStarted(entry)
        emitTraceCompleted(entry)
        return
      case "tool.result.recorded":
        emitTraceCompleted(entry)
        return
      default:
        return
    }
  }

  async function loadTimeline(): Promise<ToolExecutionEntry[]> {
    const state = await projection.replay()
    // Historical replay establishes the baseline, not newly started child work.
    reportedActiveSubagentRevision ??= state.activeSubagentRevision
    if (deps.onActiveSubagentsChanged) notifyActiveSubagents(state)
    return toolExecutionTimelineFromProjection(state)
  }

  function notifyActiveSubagents(state: ReturnType<typeof projection.getState>): void {
    if (reportedActiveSubagentRevision === state.activeSubagentRevision) return
    reportedActiveSubagentRevision = state.activeSubagentRevision
    deps.onActiveSubagentsChanged?.(new Set(state.activeSubagentToolUseIds))
  }

  function emitTraceStarted(entry: ToolExecutionEntry): void {
    if (entry.traceKind === "subagent") {
      const description = String(entry.input?.description ?? entry.input?.task ?? entry.toolName)
      const prompt = truncateField(entry.input?.prompt ?? entry.input?.task ?? "", MAX_FIELD_BYTES)
      emitter?.("trace.subagent.started", {
        sessionId,
        data: {
          toolUseId: entry.toolUseId,
          agentType: entry.toolName,
          description,
          prompt,
          model: "",
          ...traceIdentity(entry),
        },
      })
      return
    }

    emitter?.("trace.tool.started", {
      sessionId,
      data: {
        toolUseId: entry.toolUseId,
        toolName: entry.toolName,
        toolInput: traceInput(entry),
        ...traceIdentity(entry),
      },
    })
  }

  function emitTraceCompleted(entry: ToolExecutionEntry): void {
    const output = traceOutput(entry)
    if (entry.traceKind === "subagent") {
      emitter?.("trace.subagent.completed", {
        sessionId,
        data: {
          toolUseId: entry.toolUseId,
          result: output,
          isError: entry.status === "failed",
          ...traceIdentity(entry),
        },
      })
    } else {
      emitter?.("trace.tool.completed", {
        sessionId,
        data: {
          toolUseId: entry.toolUseId,
          toolOutput: output,
          isError: entry.status === "failed" || entry.status === "validation_failed",
          ...traceIdentity(entry),
        },
      })
    }
  }

  function dispose(): void {
    disposed = true
  }

  return { applyStoredFact, loadTimeline, dispose }
}

/** Runner start is a hard boundary: no tool call from a previous process can
 *  still be running. Record an interrupted result only when the projection has
 *  no terminal evidence. */
export async function repairInterruptedToolExecutions(
  store: SessionToolExecutionStore,
  writer: Pick<SessionFactWriter, "record" | "transaction">,
  protectedToolUseIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const facts = (await store.loadTimeline()).flatMap((entry): SessionRuntimeFact[] => {
    if (entry.resultEventId || entry.validationEventId) return []
    if (protectedToolUseIds.has(entry.toolUseId)) return []
    return [{
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: entry.toolUseId,
        outcome: "interrupted",
        contentPreview: "Interrupted: the session restarted before this tool call completed.",
        ...(entry.modelRequestId ? { modelRequestId: entry.modelRequestId } : {}),
        ...(entry.parentToolUseId ? { parentToolUseId: entry.parentToolUseId } : {}),
      },
    }]
  })
  await writer.transaction(() => {
    for (const fact of facts) void writer.record(fact)
  })
  await store.loadTimeline()
}

function traceIdentity(entry: ToolExecutionEntry) {
  return {
    executionMode: entry.executionMode,
    traceKind: entry.traceKind,
    ...(entry.modelRequestId ? { modelRequestId: entry.modelRequestId } : {}),
    ...(entry.parentToolUseId ? { parentToolUseId: entry.parentToolUseId } : {}),
  }
}

function traceInput(entry: ToolExecutionEntry): string {
  return entry.input === undefined
    ? entry.inputPreview ?? "{}"
    : truncateField(entry.input, MAX_FIELD_BYTES)
}

function traceOutput(entry: ToolExecutionEntry): string {
  return entry.contentPreview ?? ""
}

