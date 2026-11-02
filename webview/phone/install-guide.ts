import type { InstallGuide, InstallStep } from "../src/host.js"

/** Which taps put this page on the Home Screen, decided from what the browser
 *  tells us and nothing else.
 *
 *  An installed app has nothing to guide. A browser that can open the install
 *  prompt itself needs one tap on a button we own. Every other browser has its
 *  own menu for the same job, and a guide that names a control the person
 *  cannot find is worse than none, so each browser this recognises gets its
 *  own sequence, written against that browser's controls, and a browser that
 *  cannot install web apps is told so instead of being sent on a hunt. */

export interface InstallEnvironment {
  /** Running from the Home Screen already, by display mode or Safari's flag. */
  readonly standalone: boolean
  readonly userAgent: string
  /** Touch points, which is how an iPad presenting a desktop user agent is told apart from a Mac. */
  readonly maxTouchPoints: number
  /** The browser offered a `beforeinstallprompt` we are holding. */
  readonly canPrompt: boolean
}

type Browser =
  | { readonly os: "ios"; readonly name: "Safari" | "Chrome" | "Firefox" | "Edge" | "a browser" }
  | { readonly os: "android"; readonly name: "Chrome" | "Samsung Internet" | "Firefox" | "Edge" | "a browser" }
  | { readonly os: "mac"; readonly name: "Safari" | "Chrome" | "Edge" | "Firefox" | "a browser" }
  | { readonly os: "desktop"; readonly name: "Chrome" | "Edge" | "Firefox" | "a browser" }

/** The browser and platform, read from the user agent the way the browsers
 *  themselves document it. Order matters: Chrome on iOS says `CriOS` and still
 *  says `Safari`, Edge says `Edg`, `EdgA`, or `EdgiOS` and still says `Chrome`. */
export function detectBrowser(environment: Pick<InstallEnvironment, "userAgent" | "maxTouchPoints">): Browser {
  const ua = environment.userAgent
  const iPadAsMac = /Macintosh/.test(ua) && environment.maxTouchPoints > 1
  if (/iPhone|iPad|iPod/.test(ua) || iPadAsMac) {
    if (/CriOS/.test(ua)) return { os: "ios", name: "Chrome" }
    if (/FxiOS/.test(ua)) return { os: "ios", name: "Firefox" }
    if (/EdgiOS/.test(ua)) return { os: "ios", name: "Edge" }
    if (/Safari/.test(ua)) return { os: "ios", name: "Safari" }
    return { os: "ios", name: "a browser" }
  }
  if (/Android/.test(ua)) {
    if (/SamsungBrowser/.test(ua)) return { os: "android", name: "Samsung Internet" }
    if (/EdgA/.test(ua)) return { os: "android", name: "Edge" }
    if (/Firefox/.test(ua)) return { os: "android", name: "Firefox" }
    if (/Chrome/.test(ua)) return { os: "android", name: "Chrome" }
    return { os: "android", name: "a browser" }
  }
  const os = /Macintosh/.test(ua) ? "mac" : "desktop"
  if (/Edg\//.test(ua)) return { os, name: "Edge" }
  if (/Firefox/.test(ua)) return { os, name: "Firefox" }
  if (/Chrome/.test(ua)) return { os, name: "Chrome" }
  if (os === "mac" && /Safari/.test(ua)) return { os: "mac", name: "Safari" }
  return { os, name: "a browser" }
}

const step = (glyph: InstallStep["glyph"], label: string): InstallStep => ({ glyph, label })

/** The browser-specific half of a guide: its taps, or the note that stands in
 *  for them when the browser cannot install. */
type BrowserSteps = Pick<InstallGuide, "steps" | "note">

/** The taps for one recognised browser. Labels name the control as that
 *  browser labels it and say where it sits when the browser hides it. */
function stepsFor(browser: Browser): BrowserSteps {
  switch (browser.os) {
    case "ios":
      switch (browser.name) {
        case "Safari":
          return {
            steps: [step("share", "Tap Share at the bottom of the screen, inside the ⋯ menu on iOS 26"), step("add-home", "Tap Add to Home Screen"), step("confirm", "Tap Add")],
            note: "The installed app keeps its own pairing: open it and pair once more.",
          }
        case "Chrome":
          return { steps: [step("share", "Tap Share at the top of the screen"), step("add-home", "Tap Add to Home Screen"), step("confirm", "Tap Add")] }
        case "Firefox":
          return { steps: [step("menu", "Tap the menu at the bottom right"), step("share", "Tap Share"), step("add-home", "Tap Add to Home Screen")] }
        case "Edge":
          return { steps: [step("menu", "Tap the menu at the bottom"), step("share", "Tap Share"), step("add-home", "Tap Add to Home Screen")] }
        case "a browser":
          return { steps: [step("share", "Tap Share"), step("add-home", "Tap Add to Home Screen"), step("confirm", "Tap Add")] }
      }
      break
    case "android":
      switch (browser.name) {
        case "Chrome":
          return { steps: [step("menu", "Tap the menu at the top right"), step("install", "Tap Add to Home screen"), step("confirm", "Tap Install")] }
        case "Samsung Internet":
          return { steps: [step("menu", "Tap the menu at the bottom right"), step("add-home", "Tap Add page to, then Home screen"), step("confirm", "Tap Add")] }
        case "Firefox":
          return { steps: [step("menu", "Tap the menu at the top right"), step("install", "Tap Install"), step("confirm", "Tap Add")] }
        case "Edge":
          return { steps: [step("menu", "Tap the menu at the bottom"), step("install", "Tap Add to phone"), step("confirm", "Tap Install")] }
        case "a browser":
          return { steps: [step("menu", "Open the browser menu"), step("add-home", "Tap Add to Home screen")] }
      }
      break
    case "mac":
      switch (browser.name) {
        case "Safari":
          return { steps: [step("menu", "Open the File menu"), step("dock", "Choose Add to Dock"), step("confirm", "Click Add")] }
        case "Chrome":
          return { steps: [step("menu", "Open the menu at the top right"), step("install", "Choose Cast, save, and share, then Install page as app"), step("confirm", "Click Install")] }
        case "Edge":
          return { steps: [step("menu", "Open the menu at the top right"), step("install", "Choose Apps, then Install this site as an app"), step("confirm", "Click Install")] }
        case "Firefox":
          return { steps: [], note: "Firefox does not install web apps. Open this page in Safari, Chrome, or Edge to install it, or keep this tab open." }
        case "a browser":
          return { steps: [step("menu", "Open the browser menu"), step("install", "Choose Install")] }
      }
      break
    case "desktop":
      switch (browser.name) {
        case "Chrome":
          return { steps: [step("menu", "Open the menu at the top right"), step("install", "Choose Cast, save, and share, then Install page as app"), step("confirm", "Click Install")] }
        case "Edge":
          return { steps: [step("menu", "Open the menu at the top right"), step("install", "Choose Apps, then Install this site as an app"), step("confirm", "Click Install")] }
        case "Firefox":
          return { steps: [], note: "Firefox does not install web apps. Open this page in Chrome or Edge to install it, or keep this tab open." }
        case "a browser":
          return { steps: [step("menu", "Open the browser menu"), step("install", "Choose Install")] }
      }
  }
}

export function installGuideFor(environment: InstallEnvironment): InstallGuide | undefined {
  if (environment.standalone) return undefined
  const browser = detectBrowser(environment)
  if (environment.canPrompt) return { browser: browser.name, steps: [step("install", "Install Flywheel")], canPrompt: true }
  const guide = stepsFor(browser)
  return { browser: browser.name, steps: guide.steps, canPrompt: false, ...(guide.note === undefined ? {} : { note: guide.note }) }
}
