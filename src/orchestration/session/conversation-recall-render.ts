import type { MessageEntry, ConversationEntry } from "./conversation/conversation-entry-types.js"
import type { RecallHit } from "../../protocol/conversation-recall.js"

type PersistedMessage = MessageEntry["message"]
type PersistedContent = Extract<PersistedMessage, { kind: "user" }>["content"]

// Cut at a word boundary, avoiding a split inside a surrogate pair.
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(" ", max)
  let end = cut > max * 0.6 ? cut : max
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end--
  }
  return text.slice(0, end)
}

// Reads Flywheel's PersistedContent (string | PersistedContentBlock[],
// filtering type === "text"). Our own typed data, so trust the shape and
// never safeParse.
function textOf(content: PersistedContent): string {
  if (typeof content === "string") return content
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

// Render assistant tool_use blocks as `name(args)`.
function toolCalls(content: PersistedContent): string {
  if (typeof content === "string") return ""
  return content
    .filter((block) => block.type === "tool_use")
    .map((block) => `${block.name}(${summarizeToolArgs(block.input)})`)
    .join(", ")
}

// Pull the target path out of a tool call's arguments, by conventional key.
function extractPath(args: StringMap<unknown>): string | null {
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const value = args[key]
    if (typeof value === "string") return value
  }
  return null
}

// One-line summary of a tool call's arguments for the recall row.
function summarizeToolArgs(args: StringMap<unknown>): string {
  const path = extractPath(args)
  if (path) return `path=${path}`
  if (typeof args.command === "string") return `command=${args.command}`
  if (typeof args.query === "string") return `query=${args.query}`
  return Object.keys(args).join(", ")
}

// Collect the file paths a message's content blocks reference.
function filesFromContent(content: PersistedContent): string[] {
  if (typeof content === "string") return []
  return content
    .filter((block) => block.type === "tool_use")
    .map((block) => extractPath(block.input))
    .filter((p): p is string => p !== null)
}

interface RecallBody {
  role: string
  text: string
  files?: string[]
}

function renderMessage(entry: MessageEntry): RecallBody {
  const message = entry.message
  if (message.kind === "user") {
    return { role: "user", text: textOf(message.content) }
  }
  if (message.kind === "toolResult") {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    const body = `[${message.toolUseId}] ${text}`
    return { role: "tool_result", text: body }
  }
  if (message.kind === "assistant") {
    const text = textOf(message.content)
    const tools = toolCalls(message.content)
    const files = filesFromContent(message.content)
    const full = tools ? `${tools}\n${text}` : text
    return { role: "assistant", text: full, ...(files.length > 0 ? { files } : {}) }
  }
  // system / compactionSummary messages are not surfaced by recall (their text
  // is internal context plumbing, not a recallable turn).
  return { role: message.kind, text: "" }
}

function renderRecallBody(entry: ConversationEntry): RecallBody {
  if (entry.kind === "message") return renderMessage(entry)
  if (entry.kind === "compaction") {
    return { role: "compaction", text: entry.mode === "reset" ? "Context reset without summarization. Recover through session notes and recorded history." : entry.summary }
  }
  if (entry.kind === "branch_summary") {
    return { role: "branch_summary", text: entry.summary }
  }
  // Non-renderable kinds (leaf/label/session_info) are filtered before indexing
  // (orderedScopedEntries), so this is unreachable for a well-formed scope set.
  return { role: entry.kind, text: "" }
}

/** Renders a compact reference without exposing the complete entry body. */
export function renderRecallEntry(entry: ConversationEntry, index: number): RecallHit {
  const rendered = renderRecallBody(entry)
  const max = rendered.role === "tool_result" ? 200 : 300
  return {
    index,
    entryId: entry.id,
    role: rendered.role,
    summary: clip(rendered.text, max),
    ...(rendered.files ? { files: rendered.files } : {}),
  }
}

/** Renders the canonical text from which bounded expand ranges are selected. */
export function renderRecallEntryText(entry: ConversationEntry): string {
  return renderRecallBody(entry).text
}
interface StringMap<T> { [key: string]: T }
