import type { ContentBlock } from "../runtime-content-blocks.js"
import { isProgressUpdate } from "../llm/anthropic-narration.js"
import { redactSecrets } from "../redact-secrets.js"
import { assistantContentRuns, reasoningSummaryText } from "./assistant-content-runs.js"
import type { OutputProjectionEvent, SettledAssistantContent } from "./output-projection-events.js"
import type { OutputProjector } from "./output-projector.js"

export class AssistantDraftProjector {
  private readonly text = new Map<string, string>()
  private readonly thinking = new Map<string, string>()
  private readonly publishedToolParts = new Set<string>()

  constructor(private readonly projector: OutputProjector) {}

  reset(): void {
    this.text.clear()
    this.thinking.clear()
    this.publishedToolParts.clear()
  }

  /** Ends the current response, however it ended: settled, completed with
   *  nothing to record, interrupted, retried, or followed by the next
   *  response. Every thought row settles to one persisted part, so a thought
   *  draft that no recorded part claimed is retracted here; a reopened
   *  transcript does not have it. */
  endResponse(timestamp: number): void {
    for (const step of this.unclaimedThoughtRetraction(timestamp)) this.projector.apply(step)
    this.reset()
  }

  streamText(blockKey: string | undefined, text: string, timestamp: number): void {
    if (blockKey === undefined) return
    this.projector.apply({ type: "complete-thinking", timestamp })
    this.projector.apply({ type: "push-text", text, timestamp, blockKey })
    this.text.set(blockKey, (this.text.get(blockKey) ?? "") + text)
  }

  reconcileTerminalText(blockKey: string | undefined, content: string, timestamp: number, provisionalBlockKey = blockKey): void {
    if (blockKey === undefined) return
    for (const step of this.textReconciliation(blockKey, content, timestamp, provisionalBlockKey)) this.projector.apply(step)
  }

  streamThinking(blockKey: string | undefined, thinking: string, timestamp: number, estimatedTokens: number | undefined): void {
    if (blockKey === undefined) return
    this.projector.apply({ type: "push-thinking", text: thinking, timestamp, blockKey, estimatedTokens })
    if (thinking.length > 0) this.thinking.set(blockKey, (this.thinking.get(blockKey) ?? "") + thinking)
  }

  finalizeThinking(blockKey: string | undefined, content: string, timestamp: number, provisionalBlockKey: string | undefined): void {
    if (blockKey === undefined) return
    if (provisionalBlockKey !== undefined) {
      const draft = this.thinking.get(provisionalBlockKey)
      if (draft !== undefined) this.projector.apply({ type: "retract-draft", blockKeys: [provisionalBlockKey], timestamp, reclassifiedChars: draft.length })
      this.thinking.delete(provisionalBlockKey)
    }
    this.streamThinking(blockKey, content, timestamp, undefined)
  }

  completeText(blockKey: string | undefined, timestamp: number): void {
    this.projector.apply({ type: "complete-text", timestamp, blockKey })
  }

  completeToolInput(event: Extract<OutputProjectionEvent, { type: "tool-input-complete" }>, blockKey: string | undefined): void {
    this.projector.apply(event)
    if (blockKey !== undefined) this.publishedToolParts.add(blockKey)
  }

  /** Live preview of tool calls the model has started to write. It is a live
   *  stream event, so the calls move the phase like any other live output. */
  previewToolUse(content: readonly ContentBlock[], parentToolUseId: string | undefined, timestamp: number): void {
    for (const part of content) {
      if (part.type === "tool_use") this.projector.apply({ type: "tool-use", toolUseId: part.id, name: part.name, input: part.input, timestamp, parentToolUseId })
    }
    this.projector.apply({ type: "complete-thinking", timestamp })
  }

  /** Reconciles the recorded message `entryId` with its streamed drafts as one
   *  content-only settlement: it renders what the stream did not and never
   *  moves the live stream phase. */
  settle(content: readonly ContentBlock[], parentToolUseId: string | undefined, timestamp: number, entryId: string): void {
    const settled: SettledAssistantContent[] = []
    for (const { part, index, text } of assistantContentRuns(content)) {
      const key = `${entryId}:${index}`
      if (part.type === "tool_use") {
        // Canonical settlement keeps tool slots for text-run coordinates, but
        // input completion already published those calls before their results.
        if (!this.publishedToolParts.delete(key)) settled.push({ type: "tool-use", toolUseId: part.id, name: part.name, input: part.input, timestamp, parentToolUseId, leadingTextId: `${key}:lead` })
      } else if (parentToolUseId !== undefined) {
        continue
      } else if (part.type === "text" && text !== undefined) {
        settled.push(...this.textReconciliation(key, text, timestamp, key))
      } else if (part.type === "thinking" && isProgressUpdate(part)) {
        settled.push(...this.textReconciliation(key, redactSecrets(part.thinking), timestamp, key))
      } else if (part.type === "thinking" || part.type === "reasoning") {
        const thought = part.type === "thinking" ? part.thinking : reasoningSummaryText(part)
        const draft = this.thinking.get(key) ?? ""
        if (thought.startsWith(draft)) settled.push({ type: "push-thinking", text: thought.slice(draft.length), timestamp, blockKey: key })
        this.thinking.delete(key)
      }
    }
    // A draft no part claimed, such as unsigned thinking or reasoning without
    // encrypted content, is not in the conversation.
    if (parentToolUseId === undefined) settled.push(...this.unclaimedThoughtRetraction(timestamp))
    this.projector.apply({ type: "settle-assistant-message", content: settled, timestamp })
    if (parentToolUseId === undefined && content.some((part) => part.type !== "tool_use")) this.text.clear()
  }

  private unclaimedThoughtRetraction(timestamp: number): SettledAssistantContent[] {
    if (this.thinking.size === 0) return []
    const blockKeys = [...this.thinking.keys()]
    this.thinking.clear()
    return [{ type: "retract-draft", blockKeys, timestamp }]
  }

  /** The content steps that bring text run `blockKey` to `content`, retracting
   *  the provisional thinking draft that the text replaces. */
  private textReconciliation(blockKey: string, content: string, timestamp: number, provisionalBlockKey: string | undefined): SettledAssistantContent[] {
    const steps: SettledAssistantContent[] = []
    if (provisionalBlockKey !== undefined) {
      const thought = this.thinking.get(provisionalBlockKey)
      if (thought !== undefined) {
        steps.push({ type: "retract-draft", blockKeys: [provisionalBlockKey], timestamp, reclassifiedChars: thought.length })
        this.thinking.delete(provisionalBlockKey)
      }
    }
    const draft = this.text.get(blockKey)
    if (draft === content) return steps
    this.text.set(blockKey, content)
    if (draft === undefined) steps.push({ type: "push-text", text: content, timestamp, blockKey })
    else if (content.startsWith(draft)) steps.push({ type: "push-text", text: content.slice(draft.length), timestamp, blockKey })
    else steps.push({ type: "replace-text", text: content, blockKey })
    return steps
  }
}
