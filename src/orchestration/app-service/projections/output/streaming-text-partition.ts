import type { StreamingToolTextOp, ValueEdit } from "../../../../infra/output/output-block-delta.js"
import type { OutputDelta } from "../../../../protocol/transcript/output-protocol-types.js"

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
      const size = jsonBytes(op)
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
  if (op.kind === "set" && typeof op.entry.content === "string") {
    const content = op.entry.content
    const cuts = textCuts(content)
    if (cuts.length === 0) {
      yield op
      return
    }
    yield { ...op, entry: { ...op.entry, content: content.slice(0, cuts[0]) } }
    for (const [index, offset] of cuts.entries()) {
      yield { kind: "edit", toolUseId: op.toolUseId, edits: [{ kind: "append", path: ["content"], offset, text: content.slice(offset, cuts[index + 1]) }] }
    }
  } else if (op.kind === "edit") {
    const cutEdits = op.edits.map((edit) => {
      const value = editableText(edit)
      return { edit, value, cuts: value === undefined ? [] : textCuts(value) }
    })
    if (cutEdits.every(({ cuts }) => cuts.length === 0)) {
      yield op
      return
    }
    for (const { edit, value, cuts } of cutEdits) {
      if (value === undefined || cuts.length === 0) {
        yield { ...op, edits: [edit] }
        continue
      }
      const base = edit.kind === "append" ? edit.offset : edit.kind === "window" ? edit.offset - edit.drop : 0
      const first = value.slice(0, cuts[0])
      yield { ...op, edits: [withText(edit, first)] }
      for (const [index, cut] of cuts.entries()) {
        yield { ...op, edits: [{ kind: "append", path: edit.path, offset: base + cut, text: value.slice(cut, cuts[index + 1]) }] }
      }
    }
  } else yield op
}

/** The edit with its text replaced; only an edit that `editableText` reads
 *  has text. */
function withText(edit: ValueEdit, text: string): ValueEdit {
  return edit.kind === "assign" ? { ...edit, value: text } : edit.kind === "append" || edit.kind === "window" ? { ...edit, text } : edit
}

function editableText(edit: ValueEdit): string | undefined {
  return edit.kind === "assign" ? typeof edit.value === "string" ? edit.value : undefined
    : edit.kind === "append" || edit.kind === "window" ? edit.text : undefined
}

/** The offsets that cut `value` into pieces whose JSON strings each hold at
 *  most STREAMING_TEXT_CHUNK_BYTES. A cut never parts a surrogate pair. None
 *  when the whole value fits. */
function textCuts(value: string): number[] {
  const cuts: number[] = []
  let bytes = 2
  for (let index = 0, size = 0; index < value.length; index += characterWidth(size)) {
    size = jsonCharacterBytes(value, index)
    if (bytes + size > STREAMING_TEXT_CHUNK_BYTES) {
      cuts.push(index)
      bytes = 2
    }
    bytes += size
  }
  return cuts
}

/** The UTF-8 size of `JSON.stringify(value)`, counted from the structure
 *  without building the text. */
function jsonBytes(value: unknown): number {
  if (typeof value === "string") {
    let bytes = 2
    for (let index = 0, size = 0; index < value.length; index += characterWidth(size)) {
      size = jsonCharacterBytes(value, index)
      bytes += size
    }
    return bytes
  }
  // Numbers, booleans, and null: a partitioned op carries no other scalar.
  if (value === null || typeof value !== "object") return String(value).length
  if (Array.isArray(value)) return value.reduce<number>((bytes, item) => bytes + jsonBytes(item), Math.max(2, value.length + 1))
  let bytes = 1
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) bytes += jsonBytes(key) + jsonBytes(item) + 2
  }
  return Math.max(2, bytes)
}

/** The UTF-8 bytes that the character at `index` takes inside a JSON string.
 *  Quote and backslash take a short escape, controls a short or a `\u`
 *  escape, and a lone surrogate a `\u` escape. Only a surrogate pair takes
 *  four bytes, which is how `characterWidth` knows it spans two code units. */
function jsonCharacterBytes(value: string, index: number): number {
  const code = value.charCodeAt(index)
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0xd800 || code > 0xdfff) return 3
  const next = value.charCodeAt(index + 1)
  return code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 4 : 6
}

function characterWidth(jsonCharacterSize: number): number {
  return jsonCharacterSize === 4 ? 2 : 1
}
