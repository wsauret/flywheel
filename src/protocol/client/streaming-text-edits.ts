import { Schema } from "effect"
import { ToolStreamingTextSchema } from "../../infra/output-blocks.js"
import type { EditableValue, StreamingToolTextOp, ValueEdit, ValuePath } from "../../infra/output/output-block-delta.js"
import type { FrontendOutputBlock, FrontendToolStreamingText } from "../app-service-types.js"
import { frontendToolStreamingTextBytes, frontendUtf8Bytes } from "../frontend-output-block-metrics.js"
import type { OutputView } from "../output-protocol-types.js"

const isToolStreamingText = Schema.is(ToolStreamingTextSchema)

/** Identifies one rejected streaming operation or edit without retaining its values. */
export interface StreamingTextRejection {
  readonly reason: "streaming-missing-entry" | "streaming-edit-rejected" | "streaming-invalid-shape"
  readonly operationIndex: number
  readonly operationKind: StreamingToolTextOp["kind"]
  readonly toolUseId: string
  readonly editIndex?: number
  readonly editKind?: ValueEdit["kind"]
}

/** Text appended at `offset`. A copy that already holds some or all of it (a
 *  redelivery, or a read that raced the append) keeps what it has and gains
 *  the rest; a copy that ends before `offset` is missing text in between, which
 *  the caller recovers from. */
export function appendText(current: string, offset: number, text: string): string | null {
  if (current.length === offset) return current + text
  if (current.length < offset) return null
  const held = current.slice(offset)
  if (held.length >= text.length) return held.startsWith(text) ? current : null
  return text.startsWith(held) ? current + text.slice(held.length) : null
}

/** Applies keyed streaming changes to the resident map. The result is a new
 *  object only when an entry changed, so identity readers see a change exactly
 *  when one happened. Null means the changes do not apply to what this client
 *  holds (an edit to an entry it lacks, or against another base), which the
 *  caller recovers from with a read, never by guessing. The optional rejection
 *  hook fires once on failure with operation and edit metadata only. */
export function applyStreamingToolTextOps(current: OutputView["streamingToolText"], ops: readonly StreamingToolTextOp[], onRejected?: (failure: StreamingTextRejection) => void): OutputView["streamingToolText"] | null {
  let next: { [toolUseId: string]: FrontendToolStreamingText } | null = null
  for (const [operationIndex, op] of ops.entries()) {
    const map: OutputView["streamingToolText"] = next ?? current
    if (op.kind === "remove") {
      if (map[op.toolUseId] === undefined) continue
      const { [op.toolUseId]: _removed, ...rest }: OutputView["streamingToolText"] = map
      next = rest
      continue
    }
    if (op.kind === "set") {
      next ??= { ...current }
      next[op.toolUseId] = op.entry
      continue
    }
    const entry = map[op.toolUseId]
    if (entry === undefined) {
      onRejected?.({ reason: "streaming-missing-entry", operationIndex, operationKind: op.kind, toolUseId: op.toolUseId })
      return null
    }
    const result = applyValueEdits(entry, op.edits)
    if (!result.ok) {
      onRejected?.({ reason: "streaming-edit-rejected", operationIndex, operationKind: op.kind, toolUseId: op.toolUseId, editIndex: result.editIndex, editKind: op.edits[result.editIndex]?.kind })
      return null
    }
    const edited = result.value
    if (edited === entry) continue
    // The edits rebuilt a copy of the entry; it is adopted only in a shape
    // the entry schema accepts, like every other entry this client holds.
    if (!isToolStreamingText(edited)) {
      onRejected?.({ reason: "streaming-invalid-shape", operationIndex, operationKind: op.kind, toolUseId: op.toolUseId })
      return null
    }
    next ??= { ...current }
    next[op.toolUseId] = edited
  }
  return next ?? current
}

const DELETED = Symbol("deleted")

/** A wire block as the JSON value it is. Some block types are interfaces,
 *  which have no index signature, so the compiler cannot see that each block
 *  is such a value; the block schema that every wire block passes makes it one. */
export function editableBlock(block: FrontendOutputBlock): EditableValue {
  // SAFETY: every wire block passed FrontendOutputBlockSchema, whose fields are
  // all JSON values, so the block is an EditableValue at runtime.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: FrontendOutputBlockSchema makes every block a JSON value, but its interfaces carry no index signature
  return block as EditableValue
}

/** Applies edits in order to a streaming entry or a block. The result shares
 *  every untouched container with the input, and is the input itself when no
 *  edit changed anything. A failure names the first edit that does not apply
 *  to this copy: it lacks the edited path, or holds another base. */
export function applyValueEdits(value: EditableValue, edits: readonly ValueEdit[]): { readonly ok: true; readonly value: EditableValue } | { readonly ok: false; readonly editIndex: number } {
  let edited = value
  for (const [editIndex, edit] of edits.entries()) {
    const next = editAt(edited, edit.path, 0, edit)
    if (next === null) return { ok: false, editIndex }
    edited = next
  }
  return { ok: true, value: edited }
}

/** Rebuilds the containers along `path` around the one edited value. */
function editAt(value: EditableValue, path: ValuePath, depth: number, edit: ValueEdit): EditableValue | null {
  const key = path[depth]
  if (key === undefined) {
    const edited = applyEdit(value, edit)
    return edited === DELETED ? null : edited
  }
  const last = depth === path.length - 1
  if (Array.isArray(value) && typeof key === "number") {
    const child = value[key]
    if (child === undefined) return null
    const edited = last ? applyEdit(child, edit) : editAt(child, path, depth + 1, edit)
    if (edited === null || edited === DELETED) return null
    if (edited === child) return value
    const copy = [...value]
    copy[key] = edited
    return copy
  }
  if (isObject(value) && typeof key === "string") {
    const child = value[key]
    if (child === undefined) {
      // Only an assignment may create a key, and deleting a key already gone
      // is a redelivery; any other edit needs its base.
      if (last && edit.kind === "assign") return { ...value, [key]: edit.value }
      return last && edit.kind === "delete" ? value : null
    }
    const edited = last ? applyEdit(child, edit) : editAt(child, path, depth + 1, edit)
    if (edited === null) return null
    if (edited === DELETED) {
      const { [key]: _deleted, ...rest } = value
      return rest
    }
    return edited === child ? value : { ...value, [key]: edited }
  }
  return null
}

function applyEdit(value: EditableValue, edit: ValueEdit): EditableValue | typeof DELETED | null {
  switch (edit.kind) {
    case "assign": return edit.value
    case "delete": return DELETED
    case "append": return typeof value === "string" ? appendText(value, edit.offset, edit.text) : null
    case "window": {
      if (typeof value !== "string") return null
      if (value.length === edit.offset) return value.slice(edit.drop) + edit.text
      // A read that raced the slide already holds its result.
      return value.length === edit.offset - edit.drop + edit.text.length && value.endsWith(edit.text) ? value : null
    }
    case "push": {
      if (!Array.isArray(value)) return null
      if (value.length === edit.length) return [...value, ...edit.items]
      const held = value.slice(edit.length)
      return held.length === edit.items.length && JSON.stringify(held) === JSON.stringify(edit.items) ? value : null
    }
  }
}

function isObject(value: EditableValue): value is { readonly [key: string]: EditableValue | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** What the streaming changes cost on the wire, for the delta size bound. */
export function streamingToolTextOpsBytes(ops: readonly StreamingToolTextOp[]): number {
  let bytes = 0
  for (const op of ops) {
    bytes += frontendUtf8Bytes(op.toolUseId)
    if (op.kind === "set") bytes += frontendToolStreamingTextBytes(op.entry)
    else if (op.kind === "edit") bytes += valueEditsBytes(op.edits)
  }
  return bytes
}

/** What a list of edits costs on the wire, for the delta size bound. */
export function valueEditsBytes(edits: readonly ValueEdit[]): number {
  let bytes = 0
  for (const edit of edits) bytes += editBytes(edit)
  return bytes
}

function editBytes(edit: ValueEdit): number {
  switch (edit.kind) {
    case "append":
    case "window": return frontendUtf8Bytes(edit.text)
    case "push": return frontendUtf8Bytes(JSON.stringify(edit.items))
    case "assign": return frontendUtf8Bytes(JSON.stringify(edit.value))
    case "delete": return 0
  }
}
