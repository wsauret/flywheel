import type { ContentBlock } from "../../runtime-facts/runtime-content-blocks.js"
import { isProgressUpdate } from "../../../providers/llm/anthropic-narration.js"
import { redactSecrets } from "../../../redact-secrets.js"
import { assistantContentRuns, reasoningSummaryText } from "../assistant-content-runs.js"
import type { OutputProjectionEvent, SettledAssistantContent } from "../output-projection-events.js"
import type { OutputProjector } from "./output-projector.js"

/** Reconciles the streamed drafts of one response with its recorded
 *  message. A draft's text is the text its row holds in the projector; this
 *  class keeps only the keys of the current response's drafts. */
export class AssistantDraftProjector {
  private readonly textDrafts = new Set<string>()
  /** The keys of the thought drafts that have a row. A thought streams under
   *  the key of the part that settles it. */
  private readonly thoughtDrafts = new Set<string>()
  private readonly publishedToolParts = new Set<string>()

  constructor(private readonly projector: OutputProjector) {}

  reset(): void {
    this.textDrafts.clear()
    this.thoughtDrafts.clear()
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
    this.projector.apply({ type: "push-text", text, timestamp, blockKey })
    this.textDrafts.add(blockKey)
  }

  /** Brings text run `blockKey` to `content`. `reclassifiedThoughtKey` names
   *  the thought draft that the text replaces, when signed narration that
   *  streamed as a thought settles as text. */
  reconcileTerminalText(blockKey: string | undefined, content: string, timestamp: number, reclassifiedThoughtKey: string | undefined): void {
    if (blockKey === undefined) return
    for (const step of this.textReconciliation(blockKey, content, timestamp, reclassifiedThoughtKey)) this.projector.apply(step)
  }

  streamThinking(blockKey: string | undefined, thinking: string, timestamp: number, estimatedTokens: number | undefined): void {
    if (blockKey === undefined) return
    this.projector.apply({ type: "push-thinking", text: thinking, timestamp, blockKey, estimatedTokens })
    // The same rule as the row: blank text creates no row.
    if (thinking.trim()) this.thoughtDrafts.add(blockKey)
  }

  /** Settles the thought whose draft streamed under `draftBlockKey` as the
   *  recorded part `blockKey` with text `content`, in place. Only a recorded
   *  fact from before thoughts streamed under their settled key names another
   *  draft key; that draft leaves. */
  finalizeThinking(blockKey: string | undefined, content: string, timestamp: number, draftBlockKey: string | undefined): void {
    if (blockKey === undefined) return
    const steps = draftBlockKey === undefined || draftBlockKey === blockKey ? [] : this.draftRetraction(draftBlockKey, timestamp)
    // A settling thought is live thinking output, whatever its row needs.
    this.projector.apply({ type: "set-model-phase", phase: "thinking", timestamp })
    for (const step of [...steps, ...this.thoughtReconciliation(blockKey, content, timestamp)]) this.projector.apply(step)
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
    const claimedText = new Set<string>()
    for (const { part, index, text } of assistantContentRuns(content)) {
      const key = `${entryId}:${index}`
      if (part.type === "tool_use") {
        // Canonical settlement keeps tool slots for text-run coordinates, but
        // input completion already published those calls before their results.
        if (!this.publishedToolParts.delete(key)) settled.push({ type: "tool-use", toolUseId: part.id, name: part.name, input: part.input, timestamp, parentToolUseId, leadingTextId: `${key}:lead` })
      } else if (parentToolUseId !== undefined) {
        continue
      } else if (part.type === "text" && text !== undefined) {
        claimedText.add(key)
        settled.push(...this.textReconciliation(key, text, timestamp, undefined))
      } else if (part.type === "thinking" && isProgressUpdate(part)) {
        claimedText.add(key)
        settled.push(...this.textReconciliation(key, redactSecrets(part.thinking), timestamp, key))
      } else if (part.type === "thinking" || part.type === "reasoning") {
        settled.push(...this.thoughtReconciliation(key, part.type === "thinking" ? part.thinking : reasoningSummaryText(part), timestamp))
        this.thoughtDrafts.delete(key)
      }
    }
    // A draft no part claimed, such as unsigned thinking, reasoning without
    // encrypted content, or text whose coordinate moved because a looping
    // thought was dropped before recording, is not in the conversation.
    if (parentToolUseId === undefined) settled.push(...this.unclaimedThoughtRetraction(timestamp))
    if (parentToolUseId === undefined && content.some((part) => part.type !== "tool_use")) settled.push(...this.unclaimedTextRetraction(claimedText, timestamp))
    this.projector.apply({ type: "settle-assistant-message", content: settled, timestamp })
  }

  private unclaimedThoughtRetraction(timestamp: number): SettledAssistantContent[] {
    if (this.thoughtDrafts.size === 0) return []
    const blockKeys = [...this.thoughtDrafts]
    this.thoughtDrafts.clear()
    return [{ type: "retract-draft", kind: "thinking", blockKeys, timestamp }]
  }

  /** Ends the text drafts of the settled message: a run that no recorded part
   *  claimed leaves with its streamed characters. */
  private unclaimedTextRetraction(claimed: ReadonlySet<string>, timestamp: number): SettledAssistantContent[] {
    const unclaimed = [...this.textDrafts].filter((blockKey) => !claimed.has(blockKey))
    this.textDrafts.clear()
    if (unclaimed.length === 0) return []
    const retractedChars = unclaimed.reduce((total, blockKey) => total + (this.projector.contentOf("text", blockKey)?.length ?? 0), 0)
    return [{ type: "retract-draft", kind: "text", blockKeys: unclaimed, timestamp, retractedChars }]
  }

  /** Retracts the thought draft `blockKey` and its streamed characters. */
  private draftRetraction(blockKey: string, timestamp: number): SettledAssistantContent[] {
    const draft = this.draft(this.thoughtDrafts, "thinking", blockKey)
    if (draft === undefined) return []
    this.thoughtDrafts.delete(blockKey)
    return [{ type: "retract-draft", kind: "thinking", blockKeys: [blockKey], timestamp, retractedChars: draft.length }]
  }

  /** The content steps that bring the thought row `blockKey` to `thought` in
   *  place. A thought with no text has no row, as in a reopened transcript. */
  private thoughtReconciliation(blockKey: string, thought: string, timestamp: number): SettledAssistantContent[] {
    if (!thought.trim()) return this.draftRetraction(blockKey, timestamp)
    const draft = this.draft(this.thoughtDrafts, "thinking", blockKey)
    this.thoughtDrafts.add(blockKey)
    if (draft === thought) return []
    if (draft === undefined || thought.startsWith(draft)) return [{ type: "push-thinking", text: thought.slice(draft?.length ?? 0), timestamp, blockKey }]
    return [{ type: "replace-thinking", text: thought, blockKey }]
  }

  /** The content steps that bring text run `blockKey` to `content`, retracting
   *  the thought draft `reclassifiedThoughtKey` that the text replaces. */
  private textReconciliation(blockKey: string, content: string, timestamp: number, reclassifiedThoughtKey: string | undefined): SettledAssistantContent[] {
    const steps: SettledAssistantContent[] = reclassifiedThoughtKey === undefined ? [] : this.draftRetraction(reclassifiedThoughtKey, timestamp)
    const draft = this.draft(this.textDrafts, "text", blockKey)
    if (draft === content) return steps
    this.textDrafts.add(blockKey)
    if (draft === undefined) steps.push({ type: "push-text", text: content, timestamp, blockKey })
    else if (content.startsWith(draft)) steps.push({ type: "push-text", text: content.slice(draft.length), timestamp, blockKey })
    else steps.push({ type: "replace-text", text: content, blockKey })
    return steps
  }

  /** The text that draft `blockKey` of the current response streamed: its
   *  row's text, or undefined when this response streamed no such draft. */
  private draft(drafts: ReadonlySet<string>, kind: "text" | "thinking", blockKey: string): string | undefined {
    return drafts.has(blockKey) ? this.projector.contentOf(kind, blockKey) : undefined
  }
}
