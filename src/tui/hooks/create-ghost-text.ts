import type { Accessor } from "solid-js"
import { createMemo } from "solid-js"

export function createGhostText(textBeforeCursor: Accessor<string>, commandNames: () => string[]): Accessor<string> {
  // eslint-disable-next-line solid/reactivity -- the memo is returned as the function result, not lost
  return createMemo(() => {
    const before = textBeforeCursor()
    const match = before.match(/(^|[\s])\/([a-z][\w-]*(?::[\w-]*)?)$/i)
    if (!match) return ""
    const rawPrefix = match[2]
    if (!rawPrefix) return ""
    const prefix = rawPrefix.toLowerCase()
    if (!prefix) return ""

    const names = commandNames()
    for (const name of names) {
      const lower = name.toLowerCase()
      if (lower.startsWith(prefix) && lower !== prefix) return name.slice(prefix.length)
    }
    return ""
  })
}
