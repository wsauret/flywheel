import { afterEach, describe, it, expect, beforeEach } from "bun:test"
import { createPromptHistory } from "../../../../src/tui/hooks/create-composer-history.js"

describe("createPromptHistory", () => {
  let appends: (readonly string[])[]
  let rewrites: (readonly string[])[]
  let history: ReturnType<typeof createPromptHistory>

  beforeEach(() => {
    appends = []
    rewrites = []
    history = createPromptHistory([], {
      append: (lines) => { appends.push(lines); return Promise.resolve() },
      rewrite: (entries) => { rewrites.push(entries); return Promise.resolve() },
    })
  })
  afterEach(() => { history.dispose() })

  it("add() appends non-empty trimmed prompt to history", () => {
    history.add("  hello  ")
    expect(history.entries()).toEqual(["hello"])
  })

  it("add() deduplicates consecutive identical entries", () => {
    history.add("hello")
    history.add("hello")
    history.add("hello")
    expect(history.entries()).toEqual(["hello"])
  })

  it("add() ignores empty/whitespace-only strings", () => {
    history.add("")
    history.add("   ")
    history.add("\t\n")
    expect(history.entries()).toEqual([])
  })

  it("entries() is an immutable snapshot: add() produces a new array", () => {
    history.add("a")
    const before = history.entries()
    history.add("b")
    expect(before).toEqual(["a"])
    expect(history.entries()).toEqual(["a", "b"])
    expect(history.entries()).not.toBe(before)
  })

  it("orders entries oldest-first, including entries loaded from a prior session", () => {
    const h = createPromptHistory(["old1", "old2"], {
      append: () => Promise.resolve(),
      rewrite: () => Promise.resolve(),
    })
    h.add("new1")
    expect(h.entries()).toEqual(["old1", "old2", "new1"])
    h.dispose()
  })

  it("history is capped at 500 entries via a rewrite, not an append", async () => {
    const big = Array.from({ length: 600 }, (_, i) => `entry-${i}`)
    const h = createPromptHistory(big, {
      append: (lines) => { appends.push(lines); return Promise.resolve() },
      rewrite: (entries) => { rewrites.push(entries); return Promise.resolve() },
      debounceMs: 0,
    })
    h.add("new")
    await h.flush()
    expect(rewrites.length).toBe(1)
    expect(appends.length).toBe(0)
    const lastRewrite = rewrites[rewrites.length - 1]!
    expect(lastRewrite.length).toBeLessThanOrEqual(500)
    expect(lastRewrite[lastRewrite.length - 1]).toBe("new")
    h.dispose()
  })

  it("DebouncedWriter coalesces rapid add() calls into a single append covering all of them", async () => {
    const h = createPromptHistory([], {
      append: (lines) => { appends.push(lines); return Promise.resolve() },
      rewrite: (entries) => { rewrites.push(entries); return Promise.resolve() },
      debounceMs: 50,
    })
    h.add("a")
    h.add("b")
    h.add("c")
    await h.flush()
    expect(appends.length).toBe(1)
    expect(appends[0]).toEqual(["a", "b", "c"])
    h.dispose()

  })
  it("does not append entries already persisted by an in-flight write", async () => {
    let releaseFirstAppend!: () => void
    const firstAppend = new Promise<void>((resolve) => { releaseFirstAppend = resolve })
    let appendCount = 0
    const h = createPromptHistory([], {
      append: (lines) => {
        appends.push(lines)
        appendCount++
        return appendCount === 1 ? firstAppend : Promise.resolve()
      },
      rewrite: (entries) => { rewrites.push(entries); return Promise.resolve() },
      debounceMs: 0,
    })
    h.add("a")
    await new Promise(resolve => setTimeout(resolve, 0))
    h.add("b")
    releaseFirstAppend()
    await h.flush()
    expect(appends).toEqual([["a"], ["b"]])
    h.dispose()
  })

  it("does not schedule a write for a load with nothing new to add", () => {
    createPromptHistory(["old1", "old2"], {
      append: (lines) => { appends.push(lines); return Promise.resolve() },
      rewrite: (entries) => { rewrites.push(entries); return Promise.resolve() },
    })
    expect(appends.length).toBe(0)
    expect(rewrites.length).toBe(0)
  })

  it("only appends entries added this process, not entries already loaded from disk", async () => {
    const h = createPromptHistory(["old"], {
      append: (lines) => { appends.push(lines); return Promise.resolve() },
      rewrite: (entries) => { rewrites.push(entries); return Promise.resolve() },
      debounceMs: 0,
    })
    h.add("new")
    await h.flush()
    expect(appends).toEqual([["new"]])
    h.dispose()
  })

})
