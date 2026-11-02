/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { twoColorPng } from "../../../helpers/image.js"
import { ImageRenderable, Renderable, TextRenderable, type BaseRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { captureNativeOutput } from "../_native-output.js"
import { ImageClipBottomProvider } from "../../../../src/tui/context/attachment-images.js"

const { testRender } = await import("@opentui/solid")
const { createSignal } = await import("solid-js")
const { UserMessageBlock } = await import("../../../../src/tui/output-blocks/user-message-block.js")
const { ThemeProvider, useTheme } = await import("../../../../src/tui/context/theme.js")
const { ITALIC } = await import("../../../../src/tui/utils/text-attributes.js")
const { TranscriptViewportHeightProvider } = await import("../../../../src/tui/context/transcript-viewport.js")
const { ModalProvider, useOverlay } = await import("../../../../src/tui/components/modal.js")
const { QuestionInputProvider } = await import("../../../../src/tui/components/question-input.js")
const { ModalFrame } = await import("../../../../src/tui/components/modal-frame.js")
const { ToastProvider } = await import("../../../../src/tui/context/toast.js")

function imagesUnder(node: BaseRenderable): ImageRenderable[] {
  return [
    ...(node instanceof ImageRenderable ? [node] : []),
    ...node.getChildren().flatMap(imagesUnder),
  ]
}

async function loadImages(result: Awaited<ReturnType<typeof testRender>>) {
  await result.renderOnce()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const images = imagesUnder(result.renderer.root)
  await Promise.all(images.map((image) => image.loadPromise))
  await result.renderOnce()
  await result.renderOnce()
  return images
}

describe("user message delivery feedback", () => {
  it.each(["dark", "light"] as const)("keeps queued and unconfirmed feedback distinct in %s mode", async (mode) => {
    const [failed, setFailed] = createSignal(false)
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <UserMessageBlock block={{ kind: "userMessage", id: "local", content: "Hello", timestamp: 1, pending: true, injected: false }} deliveryUnconfirmed={failed()} />
    }
    const result = await testRender(() => <ThemeProvider mode={mode}><Harness /></ThemeProvider>, { width: 90, height: 6 })
    const suffix = (text: string) => {
      const span = result.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes(text))
      if (!span) throw new Error(`Missing delivery suffix: ${text}`)
      return span
    }
    try {
      await result.renderOnce()
      if (!colors) throw new Error("Missing theme")
      expect(suffix("queued").fg.equals(colors.textMuted)).toBe(true)
      expect(suffix("queued").attributes & ITALIC).toBe(ITALIC)
      setFailed(true)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Hello")
      expect(result.captureCharFrame()).toContain("not confirmed; press Up to edit")
      expect(suffix("not confirmed").fg.equals(colors.warning)).toBe(true)
      expect(suffix("not confirmed").attributes & ITALIC).toBe(ITALIC)
    } finally { result.renderer.destroy() }
  })
})

describe("a sent message's words", () => {
  it("shows literal words and wraps inside a grey right margin as the width changes", async () => {
    const content = "which is larger, 17*23 or 19*21? Keep **this** and `that`."
    const [width, setWidth] = createSignal(90)
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <box width={width()} flexDirection="column"><UserMessageBlock block={{ kind: "userMessage", id: "mine", content, timestamp: 1, pending: false, injected: false }} /></box>
    }
    const result = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width: 90, height: 6 })
    try {
      for (const [columns, textRows] of [[90, 1], [content.length + 3, 1], [content.length + 2, 2], [35, 2], [90, 1]] as const) {
        setWidth(columns)
        await result.renderOnce()
        const rows = result.captureCharFrame().split("\n").filter((line) => line.startsWith("┃"))
        expect(rows).toHaveLength(textRows + 2)
        expect(rows.slice(1, -1).map((line) => line.slice(2).trim()).join(" ")).toBe(content)
        for (const row of rows) {
          expect(row[columns - 1]).toBe(" ")
          expect(row.slice(columns).trim()).toBe("")
        }
        if (!colors) throw new Error("Missing theme")
        const lines = result.captureSpans().lines.slice(0, rows.length)
        for (const line of lines) {
          const cells = line.spans.flatMap((span) => Array.from({ length: span.width }, () => span))
          expect(cells[columns - 1]?.bg.equals(colors.backgroundElement)).toBe(true)
        }
        const spans = lines.flatMap((line) => line.spans).filter((item) => item.text.trim().length > 0)
        expect(spans.every((item) => (item.attributes & ITALIC) === 0)).toBe(true)
      }
    } finally { result.renderer.destroy() }
  })
})

describe("injected message", () => {
  it("folds on a blank cell of its shown body, while the blank space after its header does nothing", async () => {
    const { BlockDisclosureProvider, createBlockDisclosureChannel } = await import("../../../../src/tui/context/block-disclosure.js")
    const result = await testRender(() => <BlockDisclosureProvider value={createBlockDisclosureChannel()}><ThemeProvider mode="dark">
      <UserMessageBlock block={{ kind: "userMessage", id: "note", content: "first\n\nsecond", timestamp: 1, pending: false, injected: true }} />
    </ThemeProvider></BlockDisclosureProvider>, { width: 80, height: 10 })
    try {
      await result.renderOnce()
      await result.mockMouse.click(60, 0)
      await result.renderOnce()
      const rows = result.captureCharFrame().split("\n")
      expect(rows.some((row) => row.includes("second"))).toBe(true)
      // The padding row above the body's first line.
      await result.mockMouse.click(60, rows.findIndex((row) => row.includes("first")) - 1)
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("second")
      expect(result.captureCharFrame()).toContain("System ▸")
    } finally { result.renderer.destroy() }
  })
})

describe("initial message", () => {
  it("folds its opened body from any cell of it, while the blank space after its header does nothing", async () => {
    const { BlockDisclosureProvider, createBlockDisclosureChannel } = await import("../../../../src/tui/context/block-disclosure.js")
    const { InitialMessageProvider } = await import("../../../../src/tui/output-blocks/user-message-block.js")
    const result = await testRender(() => <BlockDisclosureProvider value={createBlockDisclosureChannel()}><ThemeProvider mode="dark">
      <InitialMessageProvider value={{ id: () => "brief", label: () => "Brief" }}>
        <UserMessageBlock block={{ kind: "userMessage", id: "brief", content: "do it", timestamp: 1, pending: false, injected: false }} />
      </InitialMessageProvider>
    </ThemeProvider></BlockDisclosureProvider>, { width: 80, height: 10 })
    const rows = () => result.captureCharFrame().split("\n")
    try {
      await result.renderOnce()
      await result.mockMouse.click(0, 0)
      await result.renderOnce()
      await result.mockMouse.click(60, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("do it")
      // The space after the body's text, then its rail.
      await result.mockMouse.click(60, rows().findIndex((row) => row.includes("do it")))
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("do it")
      await result.mockMouse.click(0, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("do it")
      await result.renderOnce()
      const bodyRow = rows().findIndex((row) => row.includes("do it"))
      await result.mockMouse.click(rows()[bodyRow]?.indexOf("┃") ?? -1, bodyRow)
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("do it")
      expect(rows()[0]).toContain("▸ Brief")
    } finally { result.renderer.destroy() }
  })
})

describe("message from another session", () => {
  it.each(["child", "sibling", "other"] as const)("starts a message from a %s collapsed and restores its disclosure after a remount", async (relation) => {
    const { BlockDisclosureProvider, createBlockDisclosureChannel } = await import("../../../../src/tui/context/block-disclosure.js")
    const disclosure = createBlockDisclosureChannel()
    const render = () => testRender(() => <BlockDisclosureProvider value={disclosure}><ThemeProvider mode="dark">
      <UserMessageBlock block={{ kind: "userMessage", id: "msg", content: "Use main.ts", timestamp: 1, pending: false, injected: false,
        from: { sessionId: "sender", name: "Trace message rendering", relation, ...(relation === "other" ? {} : { typeLabel: "Explorer" }), personWords: "keep the tests green" } }} />
    </ThemeProvider></BlockDisclosureProvider>, { width: 90, height: 16 })
    const result = await render()
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(relation === "other" ? "Message from Trace message rendering" : "Message from Explorer · Trace message rendering")
      expect(result.captureCharFrame()).not.toContain("Use main.ts")
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Use main.ts")
      expect(result.captureCharFrame()).toContain("From the person")
      expect(result.captureCharFrame()).toContain("keep the tests green")
    } finally { result.renderer.destroy() }
    const remounted = await render()
    try {
      await remounted.renderOnce()
      expect(remounted.captureCharFrame()).toContain("Use main.ts")
    } finally { remounted.renderer.destroy() }
  })

  it.each(["dark", "light"] as const)("marks a message from another session with its own color on its bar and its sender header in %s mode", async (mode) => {
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <UserMessageBlock block={{ kind: "userMessage", id: "msg", content: "Use main.ts", timestamp: 1, pending: false, injected: false,
        from: { sessionId: "parent-1", name: "Plan the release", relation: "parent", personWords: "keep the tests green" } }} />
    }
    const result = await testRender(() => <ThemeProvider mode={mode}><Harness /></ThemeProvider>, { width: 90, height: 12 })
    const span = (text: string) => {
      const found = result.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes(text))
      if (!found) throw new Error(`Missing span: ${text}`)
      return found
    }
    try {
      await result.renderOnce()
      if (!colors) throw new Error("Missing theme")
      const frame = result.captureCharFrame()
      expect(frame.indexOf("From Plan the release (parent)")).toBeLessThan(frame.indexOf("Use main.ts"))
      expect(frame.indexOf("Use main.ts")).toBeLessThan(frame.indexOf("From the person"))
      expect(frame).toContain("keep the tests green")
      // Blue marks another session: the bar and the header that names it.
      // The person's words that the sender quotes stay muted.
      expect(colors.sessionMessage.equals(colors.secondary)).toBe(false)
      expect(span("┃").fg.equals(colors.sessionMessage)).toBe(true)
      expect(span("From Plan the release (parent)").fg.equals(colors.sessionMessage)).toBe(true)
      expect(span("From the person").fg.equals(colors.textMuted)).toBe(true)
      expect(span("Use main.ts").fg.equals(colors.textMuted)).toBe(false)
    } finally { result.renderer.destroy() }
  })

  it("keeps the person's own message on the secondary bar", async () => {
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <UserMessageBlock block={{ kind: "userMessage", id: "mine", content: "Ship it", timestamp: 1, pending: false, injected: false }} />
    }
    const result = await testRender(() => <ThemeProvider mode="dark"><Harness /></ThemeProvider>, { width: 90, height: 6 })
    try {
      await result.renderOnce()
      if (!colors) throw new Error("Missing theme")
      const bar = result.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes("┃"))
      expect(bar?.fg.equals(colors.secondary)).toBe(true)
    } finally { result.renderer.destroy() }
  })
})

describe("sent image previews", () => {
  it("keeps async previews at their full transcript extent across queue clipping and recovery", async () => {
    const { chunks, stdout, nativeSession } = captureNativeOutput(90, 40)
    const [bottom, setBottom] = createSignal<number | undefined>(6)
    const [attachments, setAttachments] = createSignal<readonly { mediaType: string; data: string }[]>([])
    const result = await testRender(() => <ThemeProvider mode="dark">
      <ImageClipBottomProvider value={bottom}>
        <UserMessageBlock block={{
          kind: "userMessage", id: "clipped-image", content: "Sent text\n[Image #1]", timestamp: 1,
          pending: false, injected: false, images: attachments(),
        }} />
      </ImageClipBottomProvider>
    </ThemeProvider>, { width: 90, height: 40, stdout, nativeSession, bufferedOutput: "stdout", exitSignals: [], useMouse: false, clock: new ManualClock() })
    const following = new TextRenderable(result.renderer, { id: "following", content: "FOLLOWING", height: 1, flexShrink: 0 })
    result.renderer.root.add(following)
    try {
      await result.renderer.setupTerminal()
      setAttachments([{ mediaType: "image/png", data: twoColorPng(800, 600) }])
      const [image] = imagesUnder(result.renderer.root)
      if (!image) throw new Error("Missing async preview")
      expect(image.image).toBeNull()
      image.protocol = "kitty"
      await result.renderOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await image.loadPromise
      await result.renderOnce()
      await nativeSession.idle()
      expect(image.height).toBe(10)
      const paint = async () => {
        await result.renderOnce()
        await nativeSession.idle()
        // Kitty retains placements, including those sent before this explicit frame.
        const rows = Buffer.concat(chunks).toString().split("\x1b_G")
          .filter((command) => command.startsWith("a=p,"))
          .map((command) => Number(/(?:^|,)r=(\d+)/.exec(command)?.[1]))
        chunks.length = 0
        return rows
      }
      expect(await paint()).toEqual([3])
      expect(image.y).toBe(3)
      expect(following.y).toBe(14)
      expect(result.renderer.root.getChildren()[0]!.height).toBe(14)
      const clip = image.parent!.parent!
      const writes: string[] = []
      for (const property of ["maxHeight", "marginBottom", "opacity"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(Renderable.prototype, property)!
        Object.defineProperty(clip, property, { ...descriptor, get() { return descriptor.get?.call(this) }, set(value: unknown) {
          writes.push(property)
          descriptor.set!.call(this, value)
        } })
      }
      await paint()
      expect(writes).toEqual([])
      expect(following.y).toBe(14)
      for (const [boundary, rows] of [[3, []], [7, [4]], [undefined, [10]]] as const) {
        setBottom(boundary)
        expect(await paint()).toEqual([...rows])
        expect(following.y).toBe(14)
        expect(result.renderer.root.getChildren()[0]!.height).toBe(14)
        writes.length = 0
        await paint()
        expect(writes).toEqual([])
        expect(following.y).toBe(14)
        expect(result.renderer.root.getChildren()[0]!.height).toBe(14)
      }
    } finally { await result.dispose() }
  })

  it("opens retained pixels, zooms, and suppresses pictures behind covering dialogs", async () => {
    let overlay: ReturnType<typeof useOverlay> | undefined
    function Harness() {
      overlay = useOverlay()
      return <UserMessageBlock block={{ kind: "userMessage", id: "picture", content: "Screenshot [Image #1]", timestamp: 1,
        pending: false, injected: false,
        images: [{ mediaType: "image/png", data: twoColorPng(800, 600) }] }} />
    }
    const result = await testRender(() => <ToastProvider><ThemeProvider mode="dark"><QuestionInputProvider>
      <ModalProvider clipboard={{ copy: async () => {}, readImage: async () => null }}><Harness /></ModalProvider>
    </QuestionInputProvider></ThemeProvider></ToastProvider>, { width: 90, height: 40 })
    try {
      const [preview] = await loadImages(result)
      if (!preview || !overlay) throw new Error("Missing image harness")
      expect(preview.visible).toBe(true)
      await result.mockMouse.click(preview.x + 1, preview.y + 1)
      const images = await loadImages(result)
      const enlarged = images.find((image) => image !== preview)
      if (!enlarged) throw new Error("Image viewer did not open")
      expect(result.captureCharFrame()).toContain("Image #1")
      expect(preview.visible).toBe(false)
      expect(enlarged.visible).toBe(true)
      expect(enlarged.image?.width).toBe(800)
      expect(enlarged.height).toBeGreaterThan(preview.height)
      const fitted = enlarged.height
      overlay.input({ name: "+" })
      await result.renderOnce()
      expect(enlarged.height).toBeGreaterThan(fitted)
      overlay.input({ name: "0" })
      await result.renderOnce()
      expect(enlarged.height).toBe(fitted)
      overlay.dialog.push(() => <ModalFrame title="Sessions" width={60} onClose={() => overlay?.dialog.pop()}><text>Session list</text></ModalFrame>)
      await result.renderOnce()
      expect(enlarged.visible).toBe(false)
      overlay.dialog.pop()
      await result.renderOnce()
      expect(enlarged.visible).toBe(true)
      overlay.input({ name: "escape" })
      await result.renderOnce()
      expect(overlay.viewer.stack).toHaveLength(0)
      expect(preview.visible).toBe(true)
      expect(enlarged.image).toBeNull()
      expect(imagesUnder(result.renderer.root)).toEqual([preview])
    } finally { result.renderer.destroy() }
  })
  it.each([
    { width: 90, height: 40, viewport: 30, sourceWidth: 32, sourceHeight: 16 },
    { width: 18, height: 24, viewport: 24, sourceWidth: 32, sourceHeight: 16 },
    { width: 90, height: 40, viewport: 6, sourceWidth: 32, sourceHeight: 16 },
    { width: 90, height: 40, viewport: 30, sourceWidth: 128, sourceHeight: 8 },
  ])("fits real pixels in $width columns and $viewport viewport rows without cropping", async ({ width, height, viewport, sourceWidth, sourceHeight }) => {
    const result = await testRender(() => <ThemeProvider mode="dark">
      <TranscriptViewportHeightProvider value={() => viewport}>
        <UserMessageBlock block={{
          kind: "userMessage", id: "image", content: "Sent text\n[Image #1]", timestamp: 1, pending: false, injected: false,
          images: [{ mediaType: "image/png", data: twoColorPng(sourceWidth, sourceHeight) }],
        }} />
      </TranscriptViewportHeightProvider>
    </ThemeProvider>, { width, height })
    try {
      const images = await loadImages(result)
      expect(images).toHaveLength(1)
      const image = images[0]!
      expect(image.image?.width).toBe(sourceWidth)
      expect(image.image?.height).toBe(sourceHeight)
      expect(image.width).toBeGreaterThan(0)
      expect(image.width).toBeLessThanOrEqual(Math.min(60, width - 2))
      expect(image.height).toBeGreaterThan(0)
      expect(image.height).toBeLessThanOrEqual(Math.min(10, Math.floor(viewport / 3)))
      const cellAspect = sourceWidth / sourceHeight * image.cellAspectRatio
      expect(Math.abs(image.width - image.height * cellAspect)).toBeLessThanOrEqual(cellAspect / 2 + 0.5)
      const lines = result.captureSpans().lines
      const textRow = lines.findIndex((line) => line.spans.some((span) => span.text.includes("Sent text")))
      const pixelRow = lines.findIndex((line) => line.spans.some((span) => span.fg.r > 0.9 && span.fg.b < 0.1))
      expect(pixelRow).toBeGreaterThan(textRow)
      const colors = lines.flatMap((line) => line.spans.flatMap((span) => [span.fg, span.bg]))
      expect(colors.some((color) => color.r > 0.9 && color.g < 0.1 && color.b < 0.1)).toBe(true)
      expect(colors.some((color) => color.b > 0.9 && color.g < 0.1 && color.r < 0.1)).toBe(true)
      expect(result.captureCharFrame()).toContain("[Image #1]")
    } finally { result.renderer.destroy() }
  })

  it("requests image-only sent bodies once and renders loaded images in attachment order", async () => {
    const data = twoColorPng(32, 16)
    const [images, setImages] = createSignal<readonly { mediaType: string; data: string }[]>()
    const requests: string[] = []
    const result = await testRender(() => <ThemeProvider mode="dark">
      <UserMessageBlock block={{
        kind: "userMessage", id: "reopened", content: "[Image #1] [Image #2]", timestamp: 1,
        pending: false, injected: false, imageCount: 2, images: images(),
      }} onHydrateBody={(id) => {
        requests.push(id)
        setImages([{ mediaType: "image/png", data }, { mediaType: "image/png", data: twoColorPng(8, 32) }])
      }} />
    </ThemeProvider>, { width: 90, height: 40 })
    try {
      const rendered = await loadImages(result)
      expect(requests).toEqual(["userMessage:reopened"])
      expect(rendered.map((image) => [image.image?.width, image.image?.height])).toEqual([[32, 16], [8, 32]])
      expect(rendered[1]!.y).toBeGreaterThanOrEqual(rendered[0]!.y + rendered[0]!.height)
      expect(result.captureCharFrame()).toContain("[Image #1] [Image #2]")
      result.renderer.destroy()
      expect(rendered.every((image) => image.image === null)).toBe(true)
    } finally { if (!result.renderer.isDestroyed) result.renderer.destroy() }
  })

})
