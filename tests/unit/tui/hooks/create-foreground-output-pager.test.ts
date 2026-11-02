import { describe, expect, it } from "bun:test"
import { createForegroundOutputPager } from "../../../../src/tui/hooks/create-foreground-output-pager.js"
import type { LoadDirection, LoadPageResult } from "../../../../src/tui/transcript-store/output-transcript-cache-types.js"

interface DeferredPage {
  readonly promise: Promise<LoadPageResult>
  readonly resolve: (result?: LoadPageResult) => void
  readonly reject: (error: Error) => void
}

function deferredPage(): DeferredPage {
  let resolvePage: ((result: LoadPageResult) => void) | undefined
  let rejectPage: ((error: Error) => void) | undefined
  const promise = new Promise<LoadPageResult>((resolve, reject) => {
    resolvePage = resolve
    rejectPage = reject
  })
  const resolve = resolvePage
  const reject = rejectPage
  if (!resolve || !reject) throw new Error("deferred promise callbacks were not initialized")
  return { promise, resolve: (result = "loaded") => resolve(result), reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function pageAt(pages: readonly DeferredPage[], index: number): DeferredPage {
  const page = pages[index]
  if (!page) throw new Error(`missing deferred page ${index}`)
  return page
}

describe("createForegroundOutputPager", () => {
  it("uses fresh edge observations instead of replaying requests from old frames", async () => {
    const foregroundId: string | undefined = "s1"
    const pages: DeferredPage[] = []
    const calls: Array<{ readonly sessionId: string; readonly direction: LoadDirection }> = []
    const failures: unknown[] = []
    const pager = createForegroundOutputPager({
      foregroundId: () => foregroundId,
      transcriptCache: {
        loadPage: (sessionId, direction) => {
          calls.push({ sessionId, direction })
          const page = deferredPage()
          pages.push(page)
          return page.promise
        },
      },
      onFailure: (_sessionId, error) => { failures.push(error) },
    })

    pager.pageForegroundOutput("older")
    pager.pageForegroundOutput("older")
    pager.pageForegroundOutput("older")

    expect(calls).toEqual([{ sessionId: "s1", direction: "older" }])

    pageAt(pages, 0).resolve()
    await pageAt(pages, 0).promise
    await flushMicrotasks()

    expect(calls).toEqual([{ sessionId: "s1", direction: "older" }])

    pager.pageForegroundOutput("newer")
    expect(calls).toEqual([
      { sessionId: "s1", direction: "older" },
      { sessionId: "s1", direction: "newer" },
    ])
    pageAt(pages, 1).resolve()
    await pageAt(pages, 1).promise
    await flushMicrotasks()

    expect(calls.length).toBe(2)
    expect(failures).toEqual([])
  })

  it("serializes both directions per session without blocking another foreground session", async () => {
    let foregroundId: string | undefined = "s1"
    const pages: DeferredPage[] = []
    const calls: Array<{ readonly sessionId: string; readonly direction: LoadDirection }> = []
    const pager = createForegroundOutputPager({
      foregroundId: () => foregroundId,
      transcriptCache: {
        loadPage: (sessionId, direction) => {
          calls.push({ sessionId, direction })
          const page = deferredPage()
          pages.push(page)
          return page.promise
        },
      },
      onFailure: () => {},
    })

    pager.pageForegroundOutput("older")
    pager.pageForegroundOutput("newer")
    expect(calls).toEqual([{ sessionId: "s1", direction: "older" }])
    foregroundId = "s2"
    pager.pageForegroundOutput("newer")
    expect(calls).toEqual([
      { sessionId: "s1", direction: "older" },
      { sessionId: "s2", direction: "newer" },
    ])

    pageAt(pages, 0).resolve()
    await pageAt(pages, 0).promise
    await flushMicrotasks()

    expect(calls.length).toBe(2)
    pageAt(pages, 1).resolve()
    await pageAt(pages, 1).promise
    await flushMicrotasks()
  })

  it("releases the session after a skipped or failed page without replaying old observations", async () => {
    const pages: DeferredPage[] = []
    const calls: Array<{ readonly sessionId: string; readonly direction: LoadDirection }> = []
    const pager = createForegroundOutputPager({
      foregroundId: () => "s1",
      transcriptCache: {
        loadPage: (sessionId, direction) => {
          calls.push({ sessionId, direction })
          const page = deferredPage()
          pages.push(page)
          return page.promise
        },
      },
      onFailure: (_sessionId, error) => { failures.push(error) },
    })
    const failures: unknown[] = []

    pager.pageForegroundOutput("older")
    pager.pageForegroundOutput("older")
    pager.pageForegroundOutput("older")

    pageAt(pages, 0).resolve("skipped")
    await pageAt(pages, 0).promise
    await flushMicrotasks()
    expect(calls.length).toBe(1)

    pager.pageForegroundOutput("newer")
    const error = new Error("page failed")
    pageAt(pages, 1).reject(error)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(failures).toEqual([error])

    pager.pageForegroundOutput("older")
    pageAt(pages, 2).resolve()
    await pageAt(pages, 2).promise
    await flushMicrotasks()
    expect(calls.length).toBe(3)
  })
})
