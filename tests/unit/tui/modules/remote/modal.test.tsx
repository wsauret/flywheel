/** @jsxImportSource @opentui/solid */

import { expect, it } from "bun:test"
import { createTextAttributes, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"
import type { RuntimeRemoteView } from "../../../../../src/protocol/modules/remote.js"
import { runtimeDispatch } from "../../../../helpers/runtime-dispatch.js"
import { createModalStack } from "../../../../../src/tui/components/modal-stack.js"
import { useRemoteModal } from "../../../../../src/tui/modules/remote/use-remote-modal.js"

const [{ testRender }, { createComponent }, { TextRenderable, TextAttributes, getLinkId }, { ThemeProvider }, { RemoteModal }, { resolveTheme }, { default: flywheelTheme }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("@opentui/core"),
  import("../../../../../src/tui/context/theme.js"),
  import("../../../../../src/tui/modules/remote/modal.js"),
  import("../../../../../src/tui/context/theme/resolve.js"),
  import("../../../../../src/tui/context/theme/flywheel.json", { with: { type: "json" } }),
])

function renderModal(view: RuntimeRemoteView, width = 80, height = 30, cursor = 0) {
  return testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() {
      return createComponent(RemoteModal, { view, now: 0, cursor, currentProjectRoot: "/repo", rename: undefined, processInitiationPending: false, onSelect: () => {}, onClose: () => {} })
    },
  }), { width, height })
}

it("keeps the wrapped pairing URL one destination and one hover target", async () => {
  const code = `https://remote.flywl.sh/#p=1.${"abcDEF0123456789_".repeat(12)}`
  const result = await renderModal({
    relayUrl: "https://relay.flywl.sh", connection: "connected", devices: [], attachedClients: 0,
    pairing: { windowId: "test", code, expiresAt: 60_000 }, lastError: null,
    pushPublicKey: null, projects: [], processInitiation: "off",
  }, 60)

  try {
    await result.renderOnce()
    const nodes: Renderable[] = [result.renderer.root]
    for (let index = 0; index < nodes.length; index++) nodes.push(...nodes[index]!.getChildren())
    const url = nodes.find((node) => node instanceof TextRenderable && node.plainText === code)
    expect(url).toBeInstanceOf(TextRenderable)
    if (!(url instanceof TextRenderable)) throw new Error("Pairing URL not rendered")
    expect(url.height).toBeGreaterThan(1)
    expect(url.chunks.map((chunk) => chunk.link?.url)).toEqual([code])
    const normalColor = url.chunks[0]?.fg
    const linkCells = () => result.renderer.currentRenderBuffer.withBuffers((buffers) => Array.from(buffers.attributes).filter((attributes) => getLinkId(attributes) !== 0))
    const linkIds = new Set(linkCells().map(getLinkId))
    expect(linkIds.size).toBe(1)
    expect(linkCells()).toHaveLength(code.length)
    expect(linkCells().every((attributes) => (attributes & TextAttributes.UNDERLINE) === 0)).toBe(true)
    for (const row of [0, Math.floor(url.height / 2), url.height - 1]) {
      await result.mockMouse.moveTo(url.x + 1, url.y + row)
      await result.renderOnce()
      expect(url.chunks[0]?.fg).not.toEqual(normalColor)
      expect(linkCells()).toHaveLength(code.length)
      expect(linkCells().every((attributes) => (attributes & TextAttributes.UNDERLINE) !== 0)).toBe(true)
      expect(new Set(linkCells().map(getLinkId))).toEqual(linkIds)
    }
    await result.mockMouse.moveTo(0, 0)
    await result.renderOnce()
    expect(url.chunks[0]?.fg).toEqual(normalColor)
    expect(linkCells().every((attributes) => (attributes & TextAttributes.UNDERLINE) === 0)).toBe(true)
  } finally {
    result.renderer.destroy()
  }
})

const baseView: RuntimeRemoteView = {
  relayUrl: "https://relay.flywl.sh", connection: "connected", attachedClients: 1, pairing: null, lastError: null, pushPublicKey: null, processInitiation: "off",
  devices: [{ id: "d1", label: "Alice's iPhone", pairedAt: Date.UTC(2026, 8, 6, 12), notifies: true, attached: true }],
  projects: [{ placementId: "data", projectRoot: "/Users/alice/Documents/GitHub/data", displayPath: "~/Documents/GitHub/data", projectLabel: "data", lastAttachedAt: 0, state: "open" }],
}

it("retains device and project renderables while current labels and presence change", async () => {
  const [view, setView] = createSignal(baseView)
  const commands: unknown[] = []
  let press = (_name: string): void => { throw new Error("Modal is not mounted") }
  let paste = (_text: string): void => { throw new Error("Modal is not mounted") }
  const dispatch = runtimeDispatch({ "remote.device.rename": async (command) => {
    commands.push(command)
    return { kind: "committed" }
  } })
  function Mounted() {
    const stack = createModalStack()
    const remote = useRemoteModal({ modal: stack, renderModal: () => undefined, view, currentProjectRoot: () => "/repo", appService: { dispatch }, showToast() {} })
    remote.openRemoteModal()
    press = name => { stack.input({ name }) }
    paste = text => { stack.paste(text) }
    return <RemoteModal view={view()} now={0} cursor={remote.cursor()} currentProjectRoot="/repo" rename={remote.rename()} processInitiationPending={false} onSelect={remote.select} onClose={remote.closeRemoteModal} />
  }
  const result = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark", get children() { return createComponent(Mounted, {}) },
  }), { width: 80, height: 30 })
  const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
  try {
    await result.renderOnce()
    const device = descendants(result.renderer.root).find(node => node instanceof TextRenderable && node.plainText.includes("Alice's iPhone"))
    const project = descendants(result.renderer.root).find(node => node instanceof TextRenderable && node.plainText.includes("~/Documents/GitHub/data"))
    if (!device || !project) throw new Error("Remote rows did not render")
    setView(structuredClone(baseView))
    await result.renderOnce()
    expect(descendants(result.renderer.root).includes(device)).toBe(true)
    setView({ ...baseView, devices: baseView.devices.map(current => ({ ...current, label: "Renamed phone", attached: false })) })
    await result.renderOnce()
    expect(descendants(result.renderer.root).includes(device)).toBe(true)
    expect(descendants(result.renderer.root).includes(project)).toBe(true)
    expect(result.captureCharFrame()).toContain("Renamed phone")
    expect(result.captureCharFrame()).not.toContain("attached now")
    press("r")
    paste(" unsent")
    await result.renderOnce()
    const editor = descendants(result.renderer.root).find(node => node instanceof TextRenderable && node.plainText.includes("Renamed phone unsent"))
    if (!(editor instanceof TextRenderable)) throw new Error("Rename editor did not render")
    const cursor = result.renderer.getCursorState()
    const inverse = createTextAttributes({ inverse: true })
    const focusedCursor = () => result.captureSpans().lines.flatMap(line => line.spans).some(span => (span.attributes & inverse) !== 0)
    expect(focusedCursor()).toBe(true)
    setView({ ...baseView, devices: baseView.devices.map(current => ({ ...current, label: "Published name", attached: true })) })
    await result.renderOnce()
    expect(descendants(result.renderer.root).includes(editor)).toBe(true)
    expect(editor.plainText).toContain("Renamed phone unsent")
    expect(result.captureCharFrame()).toContain("attached now")
    expect(result.renderer.getCursorState()).toEqual(cursor)
    expect(focusedCursor()).toBe(true)
    paste("!")
    await result.renderOnce()
    expect(editor.plainText).toContain("unsent!")
    press("return")
    await result.renderOnce()
    expect(commands).toEqual([{ type: "remote.device.rename", deviceId: "d1", label: "Renamed phone unsent!" }])
  } finally { result.renderer.destroy() }
})

async function renderedText(view: RuntimeRemoteView, cursor = 0): Promise<string> {
  const result = await renderModal(view, 80, 30, cursor)
  try {
    await result.renderOnce()
    const nodes: Renderable[] = [result.renderer.root]
    for (let index = 0; index < nodes.length; index++) nodes.push(...nodes[index]!.getChildren())
    return nodes.flatMap((node) => node instanceof TextRenderable ? [node.plainText] : []).join("\n")
  } finally {
    result.renderer.destroy()
  }
}

it("shows the remote state as one grid: initiation, devices, and projects under the account home", async () => {
  const text = await renderedText(baseView)
  const lines = text.split("\n")
  const initiation = lines.find((line) => line.includes("Remote process initiation"))
  const device = lines.find((line) => line.includes("Alice's iPhone"))
  const project = lines.find((line) => line.includes("~/Documents/GitHub/data"))
  expect(initiation).toContain("off · press i to turn on")
  expect(device).toContain("attached now · paired")
  expect(project).toBeDefined()
  expect(text).not.toContain("relay.flywl.sh")
  expect(text).toContain("Available projects")
})

it("omits process initiation from source-build rows and controls", async () => {
  const { processInitiation: _capability, ...sourceView } = baseView
  const text = await renderedText(sourceView)
  expect(text).not.toContain("Remote process initiation")
  expect(text).not.toContain("i initiation")
})

it("offers repair when an installed build cannot read process initiation", async () => {
  const text = await renderedText({ ...baseView, processInitiation: "unavailable" })
  expect(text).toContain("unavailable · press i to repair")
  expect(text).toContain("i repair")
})

it("shows each process initiation action explicitly", async () => {
  expect(await renderedText({ ...baseView, processInitiation: "on" })).toContain("on · press i to turn off")
  expect(await renderedText({ ...baseView, processInitiation: "on" })).toContain("i turn off")
  expect(await renderedText(baseView)).toContain("i turn on")
})

it("marks a selected dormant project and offers its removal action", async () => {
  const text = await renderedText({
    ...baseView,
    devices: [],
    projects: [
      { placementId: "repo", projectRoot: "/repo", displayPath: "/repo", projectLabel: "repo", lastAttachedAt: 0, state: "open" },
      { placementId: "web-uat", projectRoot: "/private/tmp/web-uat", displayPath: "/private/tmp/web-uat", projectLabel: "web-uat", lastAttachedAt: 0, state: "asleep" },
    ],
  }, 1)
  expect(text).toContain("> web-uat")
  expect(text).toContain("d stop offering")
})

it("shows only the code while a pairing window is open", async () => {
  const text = await renderedText({ ...baseView, pairing: { windowId: "w", code: "https://remote.flywl.sh/#p=1.abc", expiresAt: 61_000 } })
  expect(text).toContain("The code expires in 1:01")
  expect(text).toContain("https://remote.flywl.sh/#p=1.abc")
  expect(text).not.toContain("Alice's iPhone")
  expect(text).not.toContain("Remote process initiation")
  expect(text).not.toContain("Available projects")
})

const notice = "Flywheel stops when you log out, because lingering is off for wes. To keep Flywheel running after you log out, run `sudo loginctl enable-linger wes` on this machine."
const lingering: Partial<RuntimeRemoteView> = { processInitiation: "on", lingerOffFor: "wes" }
const accountFault = "A phone cannot open an asleep project: EEXIST: file already exists, mkdir '/Users/alice/.flywheel/auth'"

it("shows the lingering notice under Process initiation from the label's column across the rest of the content width in the warning color while the view names the account", async () => {
  const result = await renderModal({ ...baseView, ...lingering })
  try {
    await result.renderOnce()
    const nodes: Renderable[] = [result.renderer.root]
    for (let index = 0; index < nodes.length; index++) nodes.push(...nodes[index]!.getChildren())
    const text = nodes.find((node) => node instanceof TextRenderable && node.plainText === notice)
    const row = nodes.find((node) => node instanceof TextRenderable && node.plainText.includes("Remote process initiation"))
    if (!(text instanceof TextRenderable) || !(row instanceof TextRenderable)) throw new Error("Lingering notice or Process initiation row not rendered")
    // The notice starts in the label's column, after the gutter, and wraps
    // across the rest of the frame's 74-cell inner width, not in the detail
    // column.
    expect(text.x).toBe(row.x + row.plainText.indexOf("Remote process initiation"))
    expect(text.width).toBe(72)
    const lines = result.captureSpans().lines
    const initiation = lines.findIndex((line) => line.spans.some((span) => span.text.includes("Remote process initiation")))
    expect(initiation).toBeGreaterThanOrEqual(0)
    expect(text.y).toBe(initiation + 1)
    const warning = resolveTheme(flywheelTheme, "dark").warning
    const noticeSpans = lines.slice(text.y, text.y + text.height).flatMap((line) => {
      let column = 0
      return line.spans.filter((span) => {
        const start = column
        column += span.width
        return start >= text.x && column <= text.x + text.width && span.text.trim() !== ""
      })
    })
    // OpenTUI can break a line after a hyphen, so the rows are compared
    // without whitespace.
    expect(noticeSpans.map((span) => span.text).join("").replace(/\s+/gu, "")).toBe(notice.replace(/\s+/gu, ""))
    expect(noticeSpans.every((span) => span.fg.equals(warning))).toBe(true)
  } finally {
    result.renderer.destroy()
  }
  expect(await renderedText({ ...baseView, ...lingering })).toContain(notice)
  expect(await renderedText({ ...baseView, processInitiation: "on" })).not.toContain("lingering")
})

it("states what keeps remote access from working, whole and above the remote state, while no pairing window is open", async () => {
  expect((await renderedText({ ...baseView, lastError: accountFault })).replace(/\s+/gu, "")).toContain(accountFault.replace(/\s+/gu, ""))
  const result = await renderModal({ ...baseView, lastError: accountFault })
  try {
    await result.renderOnce()
    const rows = result.captureCharFrame().split("\n")
    const problem = rows.findIndex((row) => row.includes("A phone cannot open an asleep project"))
    expect(problem).toBeGreaterThanOrEqual(0)
    expect(problem).toBeLessThan(rows.findIndex((row) => row.includes("Remote process initiation")))
  } finally {
    result.renderer.destroy()
  }
})

// A cause as long as this one takes more rows than the device list can give
// up on a 60x24 screen, so the list must shrink by the rows the problem takes.
const longProblem = `${accountFault}; the relay refused the control channel: ${"the relay answered with a close frame whose reason names no known protocol version, ".repeat(3)}`

// At 80x16 the device list is at its one-row minimum, so each row that the
// problem or the notice takes adds a row to the modal. The modal renders from
// the top row here, so a visible bottom border means that the modal fits the
// screen.
const fitCases: [number, number, string, Partial<RuntimeRemoteView>][] = [
  [80, 16, "the lingering notice", lingering],
  [80, 20, "the lingering notice", lingering],
  [60, 24, "the lingering notice", lingering],
  [80, 16, "the problem", { lastError: accountFault }],
  [60, 24, "a long problem", { lastError: longProblem }],
  [80, 20, "the problem and the lingering notice", { ...lingering, lastError: accountFault }],
]

it.each(fitCases)("keeps the whole modal and its footer on a %dx%d screen while %s shows", async (width, height, _shows, lines) => {
  const devices = Array.from({ length: 8 }, (_, index) => ({ id: `d${index}`, label: `Phone ${index}`, pairedAt: 0, notifies: false, attached: false }))
  const result = await renderModal({ ...baseView, devices, ...lines }, width, height)
  try {
    await result.renderOnce()
    const frame = result.captureCharFrame()
    for (const line of [lines.lastError, lines.lingerOffFor === undefined ? undefined : notice]) {
      if (line) expect(frame.replace(/[\s│]+/gu, "")).toContain(line.replace(/\s+/gu, ""))
    }
    expect(frame).toContain("esc close")
    expect(frame).toContain("╰")
  } finally {
    result.renderer.destroy()
  }
})
