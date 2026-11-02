import { createStreamingSanitizer, type StreamingSanitizer } from "../control-characters.js";
import type { ProvisionalDiff, ToolStreamingText } from "../output-blocks.js";
import { NO_CHANGED_TOOLS } from "./output-block-delta.js";

type StreamingToolTextSnapshot = { [toolUseId in string]: ToolStreamingText };

interface TextEntry { content: string; filetype?: string; acceptedBytes: number }

const EMPTY: Readonly<StreamingToolTextSnapshot> = Object.freeze({});

/** Per-token tool-input text lives here, not in the block tree: deltas arrive
 *  far more often than structural changes, and a string append is O(chunk)
 *  where a block patch costs a child-array spread plus downstream re-diffing.
 *
 *  The store holds only the live values. Each write marks its tool, and
 *  `drainChanged` names the marked tools. The output publisher owns what its
 *  clients hold and measures each named entry against the copy it last
 *  shipped, so a change costs what it adds, never the accumulated entry or the
 *  rest of the map. */
export class StreamingToolTextStore {
  private readonly entries = new Map<string, TextEntry>();
  private readonly proposals = new Map<string, ProvisionalDiff>();
  private readonly previewChecks = new Map<string, string>();
  private readonly sanitizers = new Map<string, StreamingSanitizer>();
  private readonly changed = new Set<string>();
  private cachedSnapshot: Readonly<StreamingToolTextSnapshot> | null = null;

  constructor(private readonly onChange: () => void) {}

  append(toolUseId: string, content: string, filetype?: string): void {
    this.proposals.delete(toolUseId);
    let entry = this.entries.get(toolUseId);
    if (!entry) {
      entry = { content: "", acceptedBytes: 0, ...(filetype && { filetype }) };
      this.entries.set(toolUseId, entry);
    } else if (filetype && entry.filetype !== filetype) {
      entry.filetype = filetype;
    }
    this.markChanged(toolUseId);
    let sanitizer = this.sanitizers.get(toolUseId);
    if (!sanitizer) {
      sanitizer = createStreamingSanitizer((text) => this.appendSanitized(toolUseId, text));
      this.sanitizers.set(toolUseId, sanitizer);
    }
    entry.acceptedBytes += Buffer.byteLength(content);
    sanitizer.push(content);
    this.onChange();
  }

  /** Set one tool's whole text (an execution-output tail arrives cumulative,
   *  not chunked). */
  replace(toolUseId: string, content: string): void {
    this.sanitizers.delete(toolUseId);
    let sanitized = "";
    const sanitizer = createStreamingSanitizer((text) => { sanitized += text; });
    sanitizer.push(content);
    this.proposals.delete(toolUseId);
    this.previewChecks.delete(toolUseId);
    let entry = this.entries.get(toolUseId);
    if (!entry) {
      entry = { content: "", acceptedBytes: 0 };
      this.entries.set(toolUseId, entry);
    } else if (entry.filetype !== undefined) {
      // Execution output carries no filetype; a highlighted input preview that
      // this output supersedes drops its highlighting with it.
      delete entry.filetype;
    }
    entry.acceptedBytes = Buffer.byteLength(content);
    entry.content = sanitized;
    this.markChanged(toolUseId);
    this.onChange();
  }

  setProposedDiff(toolUseId: string, proposedDiff: ProvisionalDiff): void {
    this.sanitizers.delete(toolUseId);
    this.entries.delete(toolUseId);
    this.proposals.set(toolUseId, proposedDiff);
    this.markChanged(toolUseId);
    this.onChange();
  }

  setPreviewCheck(toolUseId: string, advice: string): void {
    this.previewChecks.set(toolUseId, advice);
    this.markChanged(toolUseId);
    this.onChange();
  }

  clearPreviewCheck(toolUseId: string): void {
    if (!this.previewChecks.delete(toolUseId)) return;
    this.markChanged(toolUseId);
    this.onChange();
  }

  /** Remove without notifying: the caller's own block change carries the
   *  notification. The removal still drains, because the map changed. */
  clearSilently(toolUseId: string): void {
    if (this.remove(toolUseId)) this.markChanged(toolUseId);
  }

  /** Relinquish a transferred tool without naming it changed: its new owner
   *  names it when its own copy changes, so its clients see the entry continue
   *  instead of a removal. */
  release(toolUseId: string): void {
    this.remove(toolUseId);
    this.cachedSnapshot = null;
    this.changed.delete(toolUseId);
  }

  acceptedBytes(toolUseId: string): number {
    return this.entries.get(toolUseId)?.acceptedBytes ?? 0;
  }

  clear(toolUseId: string): void {
    if (!this.remove(toolUseId)) return;
    this.markChanged(toolUseId);
    this.onChange();
  }

  clearAll(): void {
    if (this.entries.size === 0 && this.proposals.size === 0 && this.previewChecks.size === 0) return;
    this.reset();
    this.onChange();
  }

  /** Drop everything without notifying - for builder reset paths that already
   *  own their own change notification. */
  reset(): void {
    for (const toolUseId of [...this.entries.keys(), ...this.proposals.keys(), ...this.previewChecks.keys()]) this.changed.add(toolUseId);
    this.entries.clear();
    this.proposals.clear();
    this.previewChecks.clear();
    this.sanitizers.clear();
    this.cachedSnapshot = null;
  }

  /** Reads and clears the tools whose entries changed since the last drain,
   *  including tools that the change removed. The builder's `drainChanges` is
   *  the sole caller. */
  drainChanged(): ReadonlySet<string> {
    if (this.changed.size === 0) return NO_CHANGED_TOOLS;
    const changed = new Set(this.changed);
    this.changed.clear();
    return changed;
  }

  /** The current map. One object identity per state: a caller that compares
   *  identities sees a change exactly when the text or the shape changed. */
  snapshot(): Readonly<StreamingToolTextSnapshot> {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = this.entries.size === 0 && this.proposals.size === 0 && this.previewChecks.size === 0
      ? EMPTY
      : Object.fromEntries([
        ...[...this.entries].map(([id, entry]): [string, ToolStreamingText] => [
          id,
          { content: entry.content, ...(entry.filetype && { filetype: entry.filetype }) },
        ]),
        ...[...this.proposals].map(([id, proposedDiff]): [string, ToolStreamingText] => [id, { proposedDiff }]),
        ...[...this.previewChecks].map(([id, previewCheck]): [string, ToolStreamingText] => [id, { previewCheck }]),
      ]);
    return this.cachedSnapshot;
  }

  private appendSanitized(toolUseId: string, text: string): void {
    const entry = this.entries.get(toolUseId);
    if (!entry || text.length === 0) return;
    entry.content += text;
    this.markChanged(toolUseId);
  }

  private markChanged(toolUseId: string): void {
    this.changed.add(toolUseId);
    this.cachedSnapshot = null;
  }

  private remove(toolUseId: string): boolean {
    this.sanitizers.delete(toolUseId);
    const removedEntry = this.entries.delete(toolUseId);
    const removedProposal = this.proposals.delete(toolUseId);
    const removedPreviewCheck = this.previewChecks.delete(toolUseId);
    return removedEntry || removedProposal || removedPreviewCheck;
  }
}
