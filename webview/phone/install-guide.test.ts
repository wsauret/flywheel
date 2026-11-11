import { describe, expect, test } from "bun:test"

import { installGuideFor } from "./install-guide.js"

/** The install guide is decided from browser facts alone, so a wrong decision
 *  here would either nag an installed app, name a control the browser does not
 *  have, or hide the one path a phone has to notifications. */

const UA = {
  iosSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iosChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
  iosFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15",
  iosEdge: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0 Mobile/15E148 Safari/604.1",
  iPadDesktopMode: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  androidSamsung: "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  androidEdge: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 EdgA/130.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0",
  windowsFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
}

const env = (userAgent: string, extra: { readonly standalone?: boolean; readonly maxTouchPoints?: number; readonly canPrompt?: boolean } = {}) =>
  ({ userAgent, standalone: extra.standalone ?? false, maxTouchPoints: extra.maxTouchPoints ?? 0, canPrompt: extra.canPrompt ?? false })

const glyphs = (userAgent: string, maxTouchPoints = 0) => installGuideFor(env(userAgent, { maxTouchPoints }))?.steps.map((step) => step.glyph)

const browserOf = (userAgent: string, maxTouchPoints = 0) => installGuideFor(env(userAgent, { maxTouchPoints }))?.browser

describe("browser recognition", () => {
  test("names every recognised browser, including the ones that impersonate another", () => {
    expect(browserOf(UA.iosSafari)).toBe("Safari")
    expect(browserOf(UA.iosChrome)).toBe("Chrome")
    expect(browserOf(UA.iosFirefox)).toBe("Firefox")
    expect(browserOf(UA.iosEdge)).toBe("Edge")
    expect(browserOf(UA.androidChrome)).toBe("Chrome")
    expect(browserOf(UA.androidSamsung)).toBe("Samsung Internet")
    expect(browserOf(UA.androidFirefox)).toBe("Firefox")
    expect(browserOf(UA.androidEdge)).toBe("Edge")
    expect(browserOf(UA.macSafari)).toBe("Safari")
    expect(browserOf(UA.macChrome)).toBe("Chrome")
    expect(browserOf(UA.windowsEdge)).toBe("Edge")
    expect(browserOf(UA.windowsFirefox)).toBe("Firefox")
  })

  test("an iPad presenting a Mac user agent is an iPad, by its touch points", () => {
    expect(glyphs(UA.iPadDesktopMode, 5)).toEqual(["more", "share", "add-home", "confirm"])
    expect(glyphs(UA.iPadDesktopMode, 0)).toEqual(["menu", "dock", "confirm"])
  })
})

describe("installGuideFor", () => {
  test("an installed app is not guided", () => {
    expect(installGuideFor(env(UA.iosSafari, { standalone: true }))).toBeUndefined()
    expect(installGuideFor(env(UA.androidChrome, { standalone: true, canPrompt: true }))).toBeUndefined()
  })

  test("a browser holding an install prompt gets one tap on our own button, named for that browser", () => {
    const guide = installGuideFor(env(UA.androidChrome, { canPrompt: true }))
    expect(guide).toEqual({ browser: "Chrome", steps: [{ glyph: "install", label: "Install Flywheel" }], canPrompt: true })
  })

  test("every iPhone browser installs through the share sheet, and the guide says where that browser keeps it", () => {
    expect(glyphs(UA.iosSafari)).toEqual(["more", "share", "add-home", "confirm"])
    expect(glyphs(UA.iosChrome)).toEqual(["share", "add-home", "confirm"])
    expect(installGuideFor(env(UA.iosChrome))?.steps[0]?.label).toMatch(/top/)
    expect(glyphs(UA.iosFirefox)).toEqual(["menu", "share", "add-home"])
    expect(glyphs(UA.iosEdge)).toEqual(["menu", "share", "add-home"])
  })

  test("iPhone Safari is guided through its compact toolbar and the share sheet's View More, and promises no second pairing", () => {
    const safari = installGuideFor(env(UA.iosSafari))
    const labels = safari?.steps.map((step) => step.label) ?? []
    expect(labels).toEqual([
      "If you do not see Share, tap ⋯ or ≡",
      "Tap Share",
      "Tap Add to Home Screen (in View More)",
      "Keep Open as Web App on, then tap Add",
    ])
    expect(safari?.note).toBeUndefined()
  })

  test("Android browsers without a prompt are guided through their own menus", () => {
    expect(glyphs(UA.androidChrome)).toEqual(["menu", "install", "confirm"])
    expect(glyphs(UA.androidSamsung)).toEqual(["menu", "add-home", "confirm"])
    expect(glyphs(UA.androidFirefox)).toEqual(["menu", "install", "confirm"])
    expect(glyphs(UA.androidEdge)).toEqual(["menu", "install", "confirm"])
  })

  test("desktop browsers install from their menus, Safari to the Dock, and Firefox is told it cannot", () => {
    expect(glyphs(UA.macSafari)).toEqual(["menu", "dock", "confirm"])
    expect(glyphs(UA.macChrome)).toEqual(["menu", "install", "confirm"])
    expect(glyphs(UA.windowsEdge)).toEqual(["menu", "install", "confirm"])
    const firefox = installGuideFor(env(UA.windowsFirefox))
    expect(firefox?.steps).toEqual([])
    expect(firefox?.note).toMatch(/does not install web apps/)
    expect(firefox?.browser).toBe("Firefox")
  })
})
