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
      case "context_overflow": case "stream_error": {
        const repeated = outcome.kind === "stream_error" && outcome.error._tag === "DegenerateRepetition"
        const content = repeated ? withoutLoopingDeliberation(assistantContent, options.observedCalls().length > 0) : assistantContent
        return commitPartial(content, assistantMetadata ?? lastAssistantMetadata, false, entryId)
      }
    }
  }
}

/** The partial of a response that a repetition trip stopped, as the history keeps it. The walk resamples the same
 *  request, and a later request joins this incomplete partial to the resample's answer (`lowerProviderHistory`), so the
 *  partial's deliberation, where the loop ran, stays out of context (ARCH-PROVIDERS-075). One exception keeps the next
 *  request valid: a partial that holds a tool call keeps its replayable deliberation (a signed thinking block or an
 *  encrypted reasoning item), because a provider that signs deliberation refuses an assistant tool turn without it.
 *  An unsigned thinking block never replays (anthropic-messages.ts), so it goes in both cases. Visible text and tool
 *  calls stay: a person saw the text, and an executed call needs its durable reference. */
function withoutLoopingDeliberation(content: readonly ContentBlock[], observedCalls: boolean): ContentBlock[] {
  const holdsCall = observedCalls || content.some((block) => block.type === "tool_use")
  return content.filter((block) => {
    if (block.type === "thinking") return holdsCall && block.signature !== undefined && block.signature !== ""
    if (block.type === "reasoning") return holdsCall
    return true
  })
}
