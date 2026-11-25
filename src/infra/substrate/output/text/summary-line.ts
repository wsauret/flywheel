/** The line that names what a handoff summary says, for a one-line place
 *  such as a workflow card's quiet column, which shows plain text: its first
 *  substantive sentence, without bold marks or its final period. Wrapped
 *  lines in the first paragraph form one sentence. A label-only paragraph
 *  before a list gives way to the first list item's sentence. An agent often
 *  opens its summary with a heading, such as `## Debug Summary`, which names
 *  the text but says nothing about the result, and labels its parts in bold,
 *  such as `**Problem**:`. A summary that holds only headings reads as its
 *  first heading, without its `#` marks. */
export function summaryLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim().replace(BOLD, "$1"))
  let start = lines.findIndex((line) => line !== "" && !HEADING.test(line))
  if (/^[^.!?]+:$/.test(lines[start] ?? "")) {
    const next = lines.findIndex((line, index) => index > start && line !== "")
    if (LIST_ITEM.test(lines[next] ?? "")) start = next
  }
  const paragraph: string[] = []
  for (const line of lines.slice(start < 0 ? lines.length : start)) {
    if (line === "" || HEADING.test(line) || (paragraph.length > 0 && LIST_ITEM.test(line))) break
    paragraph.push(line.replace(LIST_ITEM, ""))
  }
  const plain = (paragraph.length > 0 ? paragraph.join(" ") : lines.find((line) => line !== "")?.replace(HEADING, "") ?? "").replace(/\s+/g, " ")
  for (const match of plain.matchAll(/[.!?](?=\s|$)/g)) {
    const end = match.index + 1
    const prefix = plain.slice(0, end)
    if (/(?:\b[a-z]\.){2,}$/i.test(prefix)) continue
    return match[0] === "." ? prefix.slice(0, -1) : prefix
  }
  return plain
}

const HEADING = /^#{1,6}\s+/
const LIST_ITEM = /^(?:[-*+]|\d+\.)\s+/
// A bold span starts on a word character, so a glob such as `src/**/*.ts`
// keeps its stars. Underscores stay, because a name such as `__init__`
// uses them.
const BOLD = /\*\*(\w[^*\n]*?)\*\*/g
