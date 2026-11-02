import type { StreamingToolTextOp, ValueEdit } from "../../infra/output/output-block-delta.js"
import { frontendUtf8Bytes } from "../../protocol/frontend-output-block-metrics.js"
import type { OutputDelta } from "../../protocol/output-protocol-types.js"

/** The wire bytes of one published group of streaming text changes. A large
 *  text change splits into appends of at most this size, so one delta never
 *  carries a whole long tool output. */
const STREAMING_TEXT_CHUNK_BYTES = 2048

/** Partitions live text without yielding between publications. Structural metadata
 * stays on the first delta. The runtime publishes the parts in order on one
 * cursor, and a client applies them as it applies any streaming change. */
export function partitionStreamingTextDelta(delta: OutputDelta): readonly OutputDelta[] {
  if (!delta.streamingToolTextOps?.length) return [delta]
  const groups: StreamingToolTextOp[][] = []
  let group: StreamingToolTextOp[] = []
  let bytes = 0
  for (const original of delta.streamingToolTextOps) {
    for (const op of splitStreamingOp(original)) {
      const size = frontendUtf8Bytes(JSON.stringify(op))
      if (group.length > 0 && bytes + size > STREAMING_TEXT_CHUNK_BYTES) {
        groups.push(group)
        group = []
        bytes = 0
      }
      group.push(op)
      bytes += size
    }
  }
  if (group.length > 0) groups.push(group)
  return groups.map((streamingToolTextOps, index): OutputDelta => index === 0
    ? { ...delta, streamingToolTextOps }
    : { blocks: [], streamingToolTextOps })
}

function* splitStreamingOp(op: StreamingToolTextOp): Generator<StreamingToolTextOp> {
  if (op.kind === "set" && typeof op.entry.content === "string" && frontendUtf8Bytes(JSON.stringify(op.entry.content)) > STREAMING_TEXT_CHUNK_BYTES) {
    let offset = 0
    for (const text of textChunks(op.entry.content)) {
      yield offset === 0
        ? { ...op, entry: { ...op.entry, content: text } }
        : { kind: "edit", toolUseId: op.toolUseId, edits: [{ kind: "append", path: ["content"], offset, text }] }
      offset += text.length
    }
  } else if (op.kind === "edit" && op.edits.some((edit) => editableText(edit) !== undefined && frontendUtf8Bytes(JSON.stringify(editableText(edit))) > STREAMING_TEXT_CHUNK_BYTES)) {
    for (const edit of op.edits) {
      const value = editableText(edit)
      if (value === undefined || (edit.kind !== "assign" && edit.kind !== "append" && edit.kind !== "window") || frontendUtf8Bytes(JSON.stringify(value)) <= STREAMING_TEXT_CHUNK_BYTES) {
        yield { ...op, edits: [edit] }
        continue
      }
      let offset = edit.kind === "append" ? edit.offset : edit.kind === "window" ? edit.offset - edit.drop : 0
      let first = true
      for (const text of textChunks(value)) {
        const part: ValueEdit = first
          ? edit.kind === "assign" ? { ...edit, value: text } : { ...edit, text }
          : { kind: "append", path: edit.path, offset, text }
        yield { ...op, edits: [part] }
        offset += text.length
        first = false
      }
    }
  } else yield op
}

function editableText(edit: ValueEdit): string | undefined {
  return edit.kind === "assign" ? typeof edit.value === "string" ? edit.value : undefined
    : edit.kind === "append" || edit.kind === "window" ? edit.text : undefined
}

function* textChunks(value: string): Generator<string> {
  let start = 0
  let end = 0
  let bytes = 2
  for (const character of value) {
    const size = frontendUtf8Bytes(JSON.stringify(character)) - 2
    if (bytes + size > STREAMING_TEXT_CHUNK_BYTES) {
      yield value.slice(start, end)
      start = end
      bytes = 2
    }
    end += character.length
    bytes += size
  }
  if (end > start) yield value.slice(start, end)
}
