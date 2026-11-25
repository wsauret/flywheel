/**
 * The keys and the envelope of a watch's notices (ARCH-TOOLS-059), as both
 * their producer and every transcript reader see them. A watch is a tracked
 * background command whose complete output lines reach its agent while it
 * runs. Each event commits as its own conversation entry under a key that
 * names the output position where its lines end, and the watch's last notice
 * commits under the key that names its end. The transcript shows each one as
 * a row with the command's text, never the envelope around it (PI-AGENT-136).
 */
import type { SystemWatch } from "./output-blocks.js"

/** The envelope element of one event. */
export const WATCH_EVENT_TAG = "watch_event"
/** The envelope element of the notice that ends a watch. */
export const WATCH_ENDED_TAG = "watch_ended"

const KEY_PREFIX = "watch:"
const END = "end"

/** The key of the event whose lines end at byte `position` of the command's
 *  log. A repeat of one delivery carries the same key, so it commits once. */
export function watchEventKey(processId: string, position: number): string {
  return `${KEY_PREFIX}${processId}:${position}`
}

/** The key of the last notice of a watch, which says how it ended. */
export function watchEndKey(processId: string): string {
  return `${KEY_PREFIX}${processId}:${END}`
}

/** The process a watch key names, or undefined for any other key. */
function watchKeyProcess(key: string): string | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined
  const separator = key.lastIndexOf(":")
  const tail = key.slice(separator + 1)
  if (separator <= KEY_PREFIX.length || (tail !== END && !/^\d+$/.test(tail))) return undefined
  return key.slice(KEY_PREFIX.length, separator)
}

/** The longest label of a command that an event notice and a row carry. */
const LABEL_CHARS = 120

/** A short label of a watched command: its first line, cut. An event notice
 *  carries it in place of the whole command, so the cost of each event stays
 *  bounded; the start and end notices carry the whole command. */
export function watchLabel(description: string): string {
  const first = description.trim().split("\n")[0] ?? ""
  return first.length > LABEL_CHARS ? `${first.slice(0, LABEL_CHARS)}...` : first
}

/** What a transcript row shows of one watch notice: the watch, as the row's
 *  `SystemWatch` states it, and the text, which is the event's lines or how
 *  the watch ended followed by its unfinished last line. */
export interface WatchNoticeRow {
  readonly watch: SystemWatch
  readonly text: string
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function element(content: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content)
  return match?.[1] === undefined ? undefined : unescapeXml(match[1])
}

/** The row of a conversation entry that holds a watch notice, read from the
 *  entry's notification keys and its text. Undefined for every other entry,
 *  and for an entry whose text is not a watch envelope. */
export function watchNoticeRow(notificationKeys: readonly string[] | undefined, content: string): WatchNoticeRow | undefined {
  const key = notificationKeys?.length === 1 ? notificationKeys[0] : undefined
  const processId = key === undefined ? undefined : watchKeyProcess(key)
  if (processId === undefined) return undefined
  const kind = key?.endsWith(`:${END}`) ? "end" : "event"
  if (!content.startsWith(`<${kind === "end" ? WATCH_ENDED_TAG : WATCH_EVENT_TAG}>`)) return undefined
  const description = element(content, "description")
  if (description === undefined) return undefined
  const output = /<output>\n([\s\S]*)\n<\/output>/.exec(content)?.[1]
  const lines = output === undefined ? undefined : unescapeXml(output)
  const dropped = Number(element(content, "dropped_events") ?? 0)
  const watch: SystemWatch = { processId, description: watchLabel(description), kind, ...(dropped > 0 ? { dropped } : {}) }
  if (kind === "event") return lines === undefined ? undefined : { watch, text: lines }
  const summary = element(content, "summary")
  if (summary === undefined) return undefined
  return { watch, text: lines === undefined ? summary : `${summary}\n${lines}` }
}
