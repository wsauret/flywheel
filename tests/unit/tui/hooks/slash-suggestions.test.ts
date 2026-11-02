import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSlashSuggestions, type SlashSuggestionsHook } from "../../../../src/tui/hooks/create-slash-suggestions.js"
import type { ModalSelectOption } from "../../../../src/tui/components/modal-select-types.js"

const CATALOG: ModalSelectOption[] = [
  { id: "help", title: "Help", value: "/help", description: "Show help", footer: "/help" },
  { id: "sessions", title: "Sessions", value: "/sessions", description: "Open sessions", footer: "/sessions" },
  { id: "debug-log", title: "Runtime log", value: "/debug-log", description: "Open the runtime's own output", footer: "/debug-log" },
  { id: "diff", title: "Review changes", value: "/diff", description: "The files this chat changed", footer: "/diff" },
  { id: "papercuts", title: "Papercuts", value: "/papercuts", description: "Log a papercut", footer: "/papercuts /paper" },
]

function withHook(
  initial: string,
  run: (hook: SlashSuggestionsHook, setText: (text: string) => void) => void,
  frequency: ReadonlyMap<string, number> = new Map(),
  dispatchable: ReadonlySet<string> = new Set(),
): void {
  createRoot((dispose) => {
    const [text, setText] = createSignal(initial)
    const hook = createSlashSuggestions({
      textBeforeCursor: text,
      inputText: text,
      catalog: () => CATALOG,
      frequency: () => frequency,
      dispatchableTokens: () => dispatchable,
    })
    run(hook, setText)
    dispose()
  })
}

describe("createSlashSuggestions trigger", () => {
  it("is hidden for empty input and plain text", () => {
    withHook("", (hook, setText) => {
      expect(hook.visible()).toBe(false)
      setText("hello")
      expect(hook.visible()).toBe(false)
    })
  })

  it("shows the full catalog for a bare slash", () => {
    withHook("/", (hook) => {
      expect(hook.visible()).toBe(true)
      expect(hook.matches().length).toBe(CATALOG.length)
    })
  })

  it("hides once whitespace follows the token (arguments typed)", () => {
    withHook("/help ", (hook) => {
      expect(hook.visible()).toBe(false)
    })
  })

  it("hides when no catalog entry matches the query", () => {
    withHook("/zzzzqq", (hook) => {
      expect(hook.visible()).toBe(false)
    })
  })

  it("hides for an exact dispatchable token the catalog omits (hidden command, alias)", () => {
    const dispatchable = new Set(["quit", "help", "sessions"])
    // "quit" is dispatchable but has no catalog entry: enter must submit as typed.
    withHook("/quit", (hook, setText) => {
      expect(hook.visible()).toBe(false)
      // A catalog-backed exact token keeps the popup (completion dispatches identically).
      setText("/sessions")
      expect(hook.visible()).toBe(true)
    }, new Map(), dispatchable)
  })
})

describe("createSlashSuggestions ranking", () => {
  it("fuzzy-matches the token over title with token weighted higher", () => {
    withHook("/debug", (hook) => {
      expect(hook.matches()[0]?.value).toBe("/debug-log")
    })
    // Title-only match still surfaces the entry.
    withHook("/review", (hook) => {
      expect(hook.matches().map((m) => m.value)).toContain("/diff")
    })
  })
})

describe("createSlashSuggestions selection", () => {
  it("wraps in both directions and resets when the query changes", () => {
    withHook("/", (hook, setText) => {
      expect(hook.selectedIndex()).toBe(0)
      hook.moveSelection(-1)
      expect(hook.selectedIndex()).toBe(CATALOG.length - 1)
      hook.moveSelection(1)
      expect(hook.selectedIndex()).toBe(0)
      hook.moveSelection(1)
      expect(hook.selectedIndex()).toBe(1)
      setText("/s")
      expect(hook.selectedIndex()).toBe(0)
      setText("/")
      expect(hook.selectedIndex()).toBe(0)
    })
  })
})

describe("createSlashSuggestions completedText", () => {
  it("completes the selected entry, not the literal token", () => {
    withHook("/debug", (hook) => {
      expect(hook.completedText()).toBe("/debug-log ")
    })
  })

  it("preserves an argument tail after the token", () => {
    createRoot((dispose) => {
      const [text] = createSignal("/help")
      const hook = createSlashSuggestions({
        textBeforeCursor: text,
        inputText: () => "/help some args",
        catalog: () => CATALOG,
        frequency: () => new Map(),
        dispatchableTokens: () => new Set(),
      })
      expect(hook.completedText()).toBe("/help some args")
      dispose()
    })
  })
})

describe("createSlashSuggestions dismiss", () => {
  it("stays hidden for the dismissed token and reopens when the token changes", () => {
    withHook("/help", (hook, setText) => {
      expect(hook.visible()).toBe(true)
      hook.dismiss()
      expect(hook.visible()).toBe(false)
      setText("/hel")
      expect(hook.visible()).toBe(true)
      setText("/help")
      expect(hook.visible()).toBe(false)
    })
  })

  it("clears the dismissal once the input stops being a slash token", () => {
    withHook("/help", (hook, setText) => {
      hook.dismiss()
      expect(hook.visible()).toBe(false)
      setText("")
      setText("/help")
      expect(hook.visible()).toBe(true)
    })
  })
})

describe("createSlashSuggestions frequency reactivity", () => {
  it("reorders the empty-query listing when the frequency map updates", () => {
    createRoot((dispose) => {
      const [text] = createSignal("/")
      const [frequency, setFrequency] = createSignal<ReadonlyMap<string, number>>(new Map())
      const hook = createSlashSuggestions({
        textBeforeCursor: text,
        inputText: text,
        catalog: () => CATALOG,
        frequency,
        dispatchableTokens: () => new Set(),
      })
      expect(hook.matches()[0]?.id).toBe("help")
      hook.moveSelection(1)
      expect(hook.completedText()).toBe("/sessions ")
      setFrequency(new Map([["papercuts", 3], ["debug-log", 1]]))
      expect(hook.matches().slice(0, 2).map((m) => m.id)).toEqual(["papercuts", "debug-log"])
      expect(hook.selectedIndex()).toBe(0)
      expect(hook.completedText()).toBe("/papercuts ")
      dispose()
    })
  })
})
