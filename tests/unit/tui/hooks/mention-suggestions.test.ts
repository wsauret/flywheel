import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { ProjectFileEntry } from "../../../../src/protocol/transcript-protocol-types.js"
import { createMentionSuggestions } from "../../../../src/tui/hooks/create-mention-suggestions.js"

const ENTRIES: ProjectFileEntry[] = [
  { path: "src", directory: true },
  { path: "src/app/composer.tsx", directory: false },
  { path: "docs/my notes.md", directory: false },
]

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

function harness(initial: string) {
  const [text, setText] = createSignal(initial)
  const queries: string[] = []
  const hook = createRoot(() => createMentionSuggestions({
    textBeforeCursor: text,
    inputText: text,
    cursorOffset: () => text().length,
    projectFiles: async (query) => { queries.push(query); return ENTRIES },
    debounceMs: 0,
  }))
  return { hook, setText, queries }
}

describe("createMentionSuggestions", () => {
  it("opens on an @ token, asks the runtime with the token's text, and shows name rows over full paths", async () => {
    const { hook, queries } = harness("look at @comp")
    expect(hook.visible()).toBe(false)
    await settle()
    expect(queries).toEqual(["comp"])
    expect(hook.visible()).toBe(true)
    expect(hook.matches().map((row) => [row.value, row.description])).toEqual([
      ["@src/", "src"],
      ["@composer.tsx", "src/app/composer.tsx"],
      ["@my notes.md", "docs/my notes.md"],
    ])
  })

  it("completes a file with a space, a directory with a slash, and quotes spaces", async () => {
    const { hook } = harness("look at @comp")
    await settle()
    expect(hook.completedText()).toBe("look at @src/")
    hook.moveSelection(1)
    expect(hook.completedText()).toBe("look at @src/app/composer.tsx ")
    hook.moveSelection(1)
    expect(hook.completedText()).toBe('look at @"docs/my notes.md" ')
  })

  it("stays closed away from an @ token and after a dismissal until the token changes", async () => {
    const { hook, setText } = harness("mail me@example.com")
    await settle()
    expect(hook.visible()).toBe(false)
    setText("see @src")
    await settle()
    expect(hook.visible()).toBe(true)
    hook.dismiss()
    expect(hook.visible()).toBe(false)
    setText("see @src/")
    await settle()
    expect(hook.visible()).toBe(true)
  })
})
