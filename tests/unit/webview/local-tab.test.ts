import { describe, expect, test } from "bun:test"

import { faviconHref, faviconSvg, reloadWhenRestoredFromCache, tabState, tabTitle } from "../../../webview/local/tab.js"

describe("local browser tab identity", () => {
  test("reads the tab's state from the runtime's health first, then the session", () => {
    expect(tabState({ health: { kind: "healthy" }, busy: false })).toBe("idle")
    expect(tabState({ health: { kind: "healthy" }, busy: true })).toBe("working")
    // Away outranks working: a busy session behind a lost runtime is a page
    // that cannot show it. A drop that is healing is not a loss: the client
    // stays healthy while it reattaches, so the tab says nothing.
    expect(tabState({ health: { kind: "faulted", since: 1 }, busy: true })).toBe("away")
    expect(tabState({ health: { kind: "faulted", since: 1, cause: "gone" }, busy: false })).toBe("away")
  })

  test("titles the tab session first, product last, state up front", () => {
    expect(tabTitle("Fix the parser", "idle")).toBe("Fix the parser · Flywheel")
    expect(tabTitle("Fix the parser", "working")).toBe("Working · Fix the parser · Flywheel")
    expect(tabTitle("Fix the parser", "away")).toBe("Runtime lost · Fix the parser · Flywheel")
    expect(tabTitle(undefined, "idle")).toBe("Flywheel")
    expect(tabTitle("", "working")).toBe("Working · Flywheel")
  })

  test("badges the icon while working and dims it while away", () => {
    const idle = faviconSvg("idle")
    const working = faviconSvg("working")
    const away = faviconSvg("away")
    expect(idle).toContain("<svg")
    expect(idle).not.toContain("#89d185")
    expect(working).toContain("#89d185")
    expect(working).not.toContain("fill-opacity=\"0.55\"")
    expect(away).toContain("fill-opacity=\"0.55\"")
    expect(away).toContain("#8b8b8b")
    expect(faviconHref("working").startsWith("data:image/svg+xml;utf8,")).toBe(true)
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
