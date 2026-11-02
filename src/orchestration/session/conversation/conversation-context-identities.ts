import { HashSet } from "effect"
import type { ConversationEntry } from "./conversation-entry-types.js"

interface IdentityChanges {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

/** Content-bound identities mentioned by user-role or system-role context.
 * Each branch shares its parent's immutable set. A reset starts a new set,
 * so a reference to an older view never changes under a reader. */
export class ContextContentIdentities {
  constructor(
    readonly values: HashSet.HashSet<string> = HashSet.empty(),
    private readonly previous?: ContextContentIdentities,
    private readonly added: readonly string[] = [],
    private readonly removed: readonly string[] = [],
    private readonly depth = 0,
  ) {}

  has(identity: string): boolean {
    return HashSet.has(this.values, identity)
  }

  /** Append-only context visits only new identities. A branch switch or
   * compaction compares the two selected generations, not their transcripts. */
  changesSince(previous: ContextContentIdentities | undefined): IdentityChanges {
    if (this === previous) return { added: [], removed: [] }
    if (previous) {
      const changed = new Set([...this.added, ...this.removed])
      for (let current = this.previous; current && current.depth >= previous.depth; current = current.previous) {
        if (current === previous) return {
          added: [...changed].filter(id => this.has(id) && !previous.has(id)),
          removed: [...changed].filter(id => !this.has(id) && previous.has(id)),
        }
        for (const id of current.added) changed.add(id)
        for (const id of current.removed) changed.add(id)
      }
    }
    return {
      added: [...HashSet.difference(this.values, previous?.values ?? HashSet.empty())],
      removed: previous ? [...HashSet.difference(previous.values, this.values)] : [],
    }
  }

  appendText(text: string): ContextContentIdentities {
    return this.withMembership(contentIdentities(text), () => true)
  }

  withMembership(identities: Iterable<string>, present: (identity: string) => boolean): ContextContentIdentities {
    let values = this.values
    const added: string[] = []
    const removed: string[] = []
    for (const identity of identities) {
      const include = present(identity)
      if (HashSet.has(values, identity) === include) continue
      values = include ? HashSet.add(values, identity) : HashSet.remove(values, identity)
      if (include) added.push(identity)
      else removed.push(identity)
    }
    return values === this.values ? this : new ContextContentIdentities(values, this, added, removed, this.depth + 1)
  }
}

function* contentIdentities(text: string): Generator<string> {
  // Lookahead preserves substring membership when a person embeds a
  // lowercase SHA-256 identity in a longer hex string.
  for (const match of text.matchAll(/(?=([a-f0-9]{64}))/g)) {
    // SAFETY: the lookahead has one required capture.
    yield match[1]!
  }
}

interface EntryContext {
  readonly content: ContextContentIdentities
  readonly anchors: ContextContentIdentities
}

/** The conversation projection owns this derived selection beside entriesById.
 * Retained compaction input and its concurrently committed suffix follow the
 * same boundary as reconstructRawSessionMessages. */
export class ConversationContextIdentities {
  private readonly byEntry = new Map<string, EntryContext>()
  // Entry ids are nonempty. The empty key names gaps before the first entry.
  private readonly empty: EntryContext = {
    content: new ContextContentIdentities(),
    anchors: new ContextContentIdentities().withMembership([""], () => true),
  }
  private readonly gapsByAnchor = new Map<string, HashSet.HashSet<string>>()
  private readonly gaps: { anchor: string; identities: readonly string[] }[] = []
  private gapPosition = 0
  private readonly activeGapCounts = new Map<string, number>()
  private selected?: { source: EntryContext; identities: ContextContentIdentities }

  at(entryId: string | null): ContextContentIdentities {
    const source = this.sourceAt(entryId)
    const previous = this.selected
    const content = source.content.changesSince(previous?.source.content)
    const changed = new Set([...content.added, ...content.removed])
    const changeGapCount = (identity: string, delta: number) => {
      const count = (this.activeGapCounts.get(identity) ?? 0) + delta
      if (count === 0) this.activeGapCounts.delete(identity)
      else this.activeGapCounts.set(identity, count)
      changed.add(identity)
    }
    for (const gap of this.gaps.slice(this.gapPosition)) {
      if (previous?.source.anchors.has(gap.anchor)) {
        for (const identity of gap.identities) changeGapCount(identity, 1)
      }
    }
    this.gapPosition = this.gaps.length
    const anchors = source.anchors.changesSince(previous?.source.anchors)
    for (const anchor of anchors.removed) {
      for (const identity of this.gapsByAnchor.get(anchor) ?? []) changeGapCount(identity, -1)
    }
    for (const anchor of anchors.added) {
      for (const identity of this.gapsByAnchor.get(anchor) ?? []) changeGapCount(identity, 1)
    }
    const identities = (previous?.identities ?? this.empty.content).withMembership(changed,
      identity => source.content.has(identity) || this.activeGapCounts.has(identity))
    this.selected = { source, identities }
    return identities
  }

  appendGap(anchorLeafId: string | null, raw: string): void {
    const anchor = anchorLeafId ?? ""
    let recorded = this.gapsByAnchor.get(anchor) ?? HashSet.empty<string>()
    const identities: string[] = []
    for (const identity of contentIdentities(raw)) {
      if (HashSet.has(recorded, identity)) continue
      recorded = HashSet.add(recorded, identity)
      identities.push(identity)
    }
    this.gapsByAnchor.set(anchor, recorded)
    if (identities.length > 0) this.gaps.push({ anchor, identities })
  }

  append(entry: ConversationEntry, entriesById: { readonly [entryId: string]: ConversationEntry }): void {
    const parent = this.sourceAt(entry.parentId)
    let context = parent.content
    let anchors = parent.anchors.withMembership([entry.id], () => true)
    if (entry.kind === "compaction") {
      context = this.empty.content
      anchors = new ContextContentIdentities().withMembership([entry.sourceLeafId, entry.id], () => true)
      if (entry.mode !== "reset") {
        for (const message of entry.retainedMessages) context = context.appendText(message.content)
      }
      const suffix: ConversationEntry[] = []
      let current = entry.parentId === null ? undefined : entriesById[entry.parentId]
      while (current && current.id !== entry.sourceLeafId) {
        suffix.push(current)
        current = current.parentId === null ? undefined : entriesById[current.parentId]
      }
      for (const item of suffix.toReversed()) {
        context = appendEntryText(context, item)
        anchors = anchors.withMembership([item.id], () => true)
      }
    } else {
      context = appendEntryText(context, entry)
    }
    this.byEntry.set(entry.id, { content: context, anchors })
  }

  private sourceAt(entryId: string | null): EntryContext {
    // SAFETY: the conversation fold validates each selected leaf and parent
    // before it publishes an entry to this index.
    return entryId === null ? this.empty : this.byEntry.get(entryId)!
  }
}

function appendEntryText(context: ContextContentIdentities, entry: ConversationEntry): ContextContentIdentities {
  if (entry.kind === "branch_summary") return context.appendText(`<branchSummary fromId="${entry.fromId}">${entry.summary}</branchSummary>`)
  if (entry.kind !== "message" || entry.displayOnly || (entry.message.kind !== "user" && entry.message.kind !== "system")) return context
  const content = entry.message.content
  return context.appendText(typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text).join("\n"))
}
