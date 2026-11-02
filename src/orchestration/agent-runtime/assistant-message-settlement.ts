import { Exit } from "effect"
import { Log } from "../../infra/log.js"
import { hasAssistantOutput } from "./assistant-output.js"
import { toolUseBlock } from "./agent-state.js"
import type { AssistantTurnResult } from "./assistant-turn-result.js"
import type { AssistantMetadata, ContentBlock, ToolCall } from "./llm/types.js"

const log = Log.create({ service: "agent-loop" })

interface AssistantMessageSettlementOptions {
  readonly interruptSignal: AbortSignal
  readonly runSignal?: AbortSignal
  readonly observedCalls: () => readonly ToolCall[]
  readonly onTurnAssistantMessage?: (content: ContentBlock[], entryId?: string) => void
  readonly pushAssistant: (content: ContentBlock[], provenance?: AssistantProvenance, incomplete?: true, entryId?: string) => void | Promise<void>
}

/** What an assistant message records about the response that produced it. */
export type AssistantProvenance = AssistantMetadata & { readonly reasoningTokens?: number }

/** Builds the durable assistant append that determines which tool calls a turn can settle. */
export function createAssistantMessageSettlement(options: AssistantMessageSettlementOptions) {
  /** `interrupted` when the turn was asked to stop, by a person or a planned
   *  replacement: that is an outcome, recorded per request below the default
   *  level, and only a provider's failure is a warning. */
  const commitPartial = async (content: readonly ContentBlock[], metadata: AssistantMetadata | undefined, interrupted: boolean, entryId?: string): Promise<readonly ToolCall[]> => {
    const observedCalls = options.observedCalls()
    const recorded = new Set(content.flatMap((block) => block.type === "tool_use" ? [block.id] : []))
    const partial = [...content, ...observedCalls.filter((call) => !recorded.has(call.id)).map(toolUseBlock)]
    if (!hasAssistantOutput(partial)) return []
    const fields = { contentBlocks: partial.length, toolCalls: observedCalls.length }
    if (interrupted) log.debug("turn interrupted mid-response, persisting partial output for resume", fields)
    else log.warn("provider failed mid-turn, persisting partial output for resume", fields)
    options.onTurnAssistantMessage?.(partial, entryId)
    await options.pushAssistant(partial, metadata, true, entryId)
    return observedCalls
  }

  return async (exit: Exit.Exit<AssistantTurnResult>): Promise<readonly ToolCall[]> => {
    if (!Exit.isSuccess(exit)) return commitPartial([], undefined, options.interruptSignal.aborted || options.runSignal?.aborted === true)
    const { assistantContent, assistantMetadata, lastAssistantMetadata, toolCalls, outcome, usageAnchor, entryId } = exit.value
    switch (outcome.kind) {
      case "aborted":
        return commitPartial(assistantContent, assistantMetadata, true, entryId)
      case "ok":
        if (!hasAssistantOutput(assistantContent)) return []
        options.onTurnAssistantMessage?.(assistantContent, entryId)
        // Only a complete response has a final usage report. A partial one
        // keeps the visible estimate.
        await options.pushAssistant(assistantContent, assistantMetadata && usageAnchor && usageAnchor.reasoningTokens > 0
          ? { ...assistantMetadata, reasoningTokens: usageAnchor.reasoningTokens }
          : assistantMetadata, undefined, entryId)
        return toolCalls
      case "incomplete": case "output_overflow":
      case "context_overflow": case "stream_error":
        return commitPartial(assistantContent, assistantMetadata ?? lastAssistantMetadata, false, entryId)
    }
  }
}
