import { describe, expect, test } from "bun:test"

import type { ClientSummary } from "../../../src/protocol/client/host/host-contract.js"
import { applyTabIdentity, needsYouTitle, reloadWhenRestoredFromCache } from "../../../webview/local/tab.js"

const ICON_PREFIX = "data:image/svg+xml;utf8,"

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: a partial stand-in for a Document, which bun test cannot build
function memoryDocument(value: unknown): Document {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: applyTabIdentity paints a Document, and bun test has no DOM to build one.
  return value as Document
}

/** The tab's title and icon after `applyTabIdentity` paints one summary onto
 *  a page with an icon link. */
function paintedTab(summary: Pick<ClientSummary, "health" | "busy" | "sessionTitle" | "needsYou">) {
  let href = ""
  const page = {
    title: "",
    querySelector: (selector: string) => selector === 'link[rel="icon"]' ? { setAttribute: (name: string, value: string) => { if (name === "href") href = value } } : null,
  }
  applyTabIdentity(memoryDocument(page), summary)
  return { title: page.title, href, svg: href.startsWith(ICON_PREFIX) ? decodeURIComponent(href.slice(ICON_PREFIX.length)) : "" }
}

const healthy = { kind: "healthy" } as const

describe("local browser tab identity", () => {
  test("reads the tab's state from the runtime's health first, then the session", () => {
    expect(paintedTab({ health: healthy, busy: false, sessionTitle: "Fix" }).title).toBe("Fix · Flywheel")
    expect(paintedTab({ health: healthy, busy: true, sessionTitle: "Fix" }).title).toBe("Working · Fix · Flywheel")
    // Away outranks working: a busy session behind a lost runtime is a page
    // that cannot show it. A drop that is healing is not a loss: the client
    // stays healthy while it reattaches, so the tab says nothing.
    expect(paintedTab({ health: { kind: "faulted", since: 1 }, busy: true, sessionTitle: "Fix" }).title).toBe("Runtime lost · Fix · Flywheel")
    expect(paintedTab({ health: { kind: "faulted", since: 1, cause: "gone" }, busy: false, sessionTitle: "Fix" }).title).toBe("Runtime lost · Fix · Flywheel")
  })

  test("titles the tab session first, product last, state up front", () => {
    expect(paintedTab({ health: healthy, busy: false, sessionTitle: "Fix the parser" }).title).toBe("Fix the parser · Flywheel")
    expect(paintedTab({ health: healthy, busy: true, sessionTitle: "Fix the parser" }).title).toBe("Working · Fix the parser · Flywheel")
    expect(paintedTab({ health: { kind: "faulted", since: 1 }, busy: false, sessionTitle: "Fix the parser" }).title).toBe("Runtime lost · Fix the parser · Flywheel")
    expect(paintedTab({ health: healthy, busy: false, sessionTitle: undefined }).title).toBe("Flywheel")
    expect(paintedTab({ health: healthy, busy: true, sessionTitle: "" }).title).toBe("Working · Flywheel")
  })

  test("leads with how many chats need the person, before the state words, and shows no number at zero", () => {
    expect(paintedTab({ health: healthy, busy: false, sessionTitle: "Fix", needsYou: 2 }).title).toBe("(2) Fix · Flywheel")
    expect(paintedTab({ health: healthy, busy: true, sessionTitle: "Fix", needsYou: 1 }).title).toBe("(1) Working · Fix · Flywheel")
    expect(paintedTab({ health: { kind: "faulted", since: 1 }, busy: false, sessionTitle: "Fix", needsYou: 3 }).title).toBe("(3) Runtime lost · Fix · Flywheel")
    expect(paintedTab({ health: healthy, busy: false, sessionTitle: "Fix", needsYou: 0 }).title).toBe("Fix · Flywheel")
    // The phone page leads its own title with the same count.
    expect(needsYouTitle(2, "Flywheel")).toBe("(2) Flywheel")
    expect(needsYouTitle(0, "Flywheel")).toBe("Flywheel")
  })

  test("badges the icon while working and dims it while away", () => {
    const idle = paintedTab({ health: healthy, busy: false, sessionTitle: undefined })
    const working = paintedTab({ health: healthy, busy: true, sessionTitle: undefined })
    const away = paintedTab({ health: { kind: "faulted", since: 1 }, busy: false, sessionTitle: undefined })
    expect(idle.href.startsWith(ICON_PREFIX)).toBe(true)
    expect(idle.svg).toContain("<svg")
    expect(idle.svg).not.toContain("#89d185")
    expect(working.svg).toContain("#89d185")
    expect(working.svg).not.toContain("fill-opacity=\"0.55\"")
    expect(away.svg).toContain("fill-opacity=\"0.55\"")
    expect(away.svg).toContain("#8b8b8b")
  })
})

describe("a project tab that the browser caches", () => {
  test("loads again only when shown from the cache", () => {
    const page = new EventTarget()
    const calls: string[] = []
    reloadWhenRestoredFromCache(page, () => calls.push("reload"))
    page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }))
    expect(calls).toEqual([])
    page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))
    expect(calls).toEqual(["reload"])
  })
})
