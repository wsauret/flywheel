/** @jsxImportSource @opentui/solid */

import { BoxRenderable, TextRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createSignal, Show } from "solid-js"
import type { TextBlock } from "../../../src/infra/output-blocks.js"
import { ThemeProvider } from "../../../src/tui/context/theme.js"
import { createTranscriptSelectionDrag } from "../../../src/tui/hooks/create-transcript-selection-drag.js"
import { OutputWindow } from "../../../src/tui/output-window/output-window.js"
import { consumeSelectedText } from "../../../src/tui/utils/selection.js"
import { transcriptOf } from "./_output-window-transcript.js"
import { scrollFrameHook } from "../../helpers/scroll-frame-hook.js"

function blocks(): TextBlock[] {
  return Array.from({ length: 100 }, (_, index) => ({
    kind: "text",
    id: `block-${index}`,
    content: `transcript row ${String(index).padStart(3, "0")}`,
    timestamp: index,
  }))
}

async function mountOutputWindow(): Promise<{ result: Awaited<ReturnType<typeof testRender>>; scrollbox: ScrollBoxRenderable }> {
  let scrollbox!: ScrollBoxRenderable
  const result = await testRender(() => (
    <ThemeProvider mode="dark">
      <OutputWindow
        layoutSlot={{}}
        transcript={transcriptOf(blocks())}
        running={false}
        captureScrollbox={(value) => { scrollbox = value }}
        sessionIntro={{
          moduleRows: () => [],
          runtimeIdentity: () => ({ version: "test", buildId: null }), showBuild: () => false,
          projectRoot: () => "/project",
          accountHome: "/home",
          userDataRoot: "/home/.flywheel",
          branchName: () => undefined,
          sessionKind: () => "chat",
          modelLabel: () => undefined,
          profileName: () => "default",
          fontTipDismissed: () => true,
          tabsHintDismissed: () => true, onDismissTabsHint: () => {},
          availableWidth: () => 80,
          noProviderReady: () => false,
        }}
      />
    </ThemeProvider>
  ), { width: 80, height: 15 })
  await result.flush()
  for (let index = 0; index < 50; index += 1) await result.mockMouse.scroll(4, 5, "up")
  await result.flush()
  return { result, scrollbox }
}

function updateFrame(scrollbox: ScrollBoxRenderable, milliseconds: number): void {
  const target: object = scrollbox
  if (!("onUpdate" in target) || typeof target.onUpdate !== "function") throw new Error("scrollbox update hook unavailable")
  target.onUpdate(milliseconds)
  // An unmounted transcript destroyed its scrollbox and frame hook; only the base update runs.
  if (!scrollbox.isDestroyed) scrollFrameHook(scrollbox)(milliseconds)
}

describe("transcript selection auto-scroll", () => {
  it("adopts native edge scrolling instead of restoring the prior offset", async () => {
    const { result, scrollbox } = await mountOutputWindow()
    try {
      const before = scrollbox.scrollTop
      const line = result.captureCharFrame().split("\n").findIndex((row) => row.includes("transcript row"))
      expect(line).toBeGreaterThanOrEqual(0)

      await result.mockMouse.pressDown(4, line)
      await result.mockMouse.moveTo(4, scrollbox.y + scrollbox.height - 1)
      updateFrame(scrollbox, 1_000)

      expect(scrollbox.scrollTop).toBeGreaterThan(before)
    } finally {
      result.renderer.destroy()
    }
  })
})

interface TranscriptRowRange { readonly min: number; readonly max: number }

function transcriptRowRange(text: string): TranscriptRowRange {
  const rows = [...text.matchAll(/transcript row (\d+)/g)].map((match) => Number(match[1]))
  if (rows.length === 0) throw new Error("No transcript rows in text")
  return { min: Math.min(...rows), max: Math.max(...rows) }
}

function visibleTranscriptCoordinates(result: Awaited<ReturnType<typeof testRender>>): readonly { x: number; y: number }[] {
  return result.captureCharFrame().split("\n").flatMap((line, y) => {
    const x = line.indexOf("transcript row")
    return x < 0 ? [] : [{ x, y }]
  })
}

interface ShellSurface {
  readonly result: Awaited<ReturnType<typeof testRender>>
  readonly scrollbox: ScrollBoxRenderable
  readonly composerY: number
  readonly currentScrollbox: () => ScrollBoxRenderable
  readonly setOutputVisible: (visible: boolean) => void
}

async function mountShellSurface(): Promise<ShellSurface> {
  let selectionState = (): { isActive: boolean; isDragging: boolean } | null => null
  let scrollbox!: ScrollBoxRenderable
  let composer!: BoxRenderable
  const [outputVisible, setOutputVisible] = createSignal(true)
  const selectionDrag = createTranscriptSelectionDrag({
    getSelection: () => selectionState(),
  })

  const result = await testRender(() => (
    <ThemeProvider mode="dark">
      <box
        width={80}
        height={18}
        flexDirection="column"
        onMouseDown={selectionDrag.onMouseDown}
        onMouseDrag={selectionDrag.onMouseDrag}
        onMouseUp={selectionDrag.onMouseUp}
      >
        <box height={2} flexShrink={0} selectable={false}>
          <text>HEADER SHOULD NOT COPY</text>
        </box>
        <box flexGrow={1}>
          <Show when={outputVisible()}>
          <OutputWindow
            layoutSlot={{}}
            transcript={transcriptOf(blocks())}
            running={false}
            captureScrollbox={(value) => { scrollbox = value }}
            registerSelectionAutoScroll={selectionDrag.register}
            sessionIntro={{
              moduleRows: () => [],
              runtimeIdentity: () => ({ version: "test", buildId: null }), showBuild: () => false,
              projectRoot: () => "/project",
              accountHome: "/home",
              userDataRoot: "/home/.flywheel",
              branchName: () => undefined,
              sessionKind: () => "chat",
              modelLabel: () => undefined,
              profileName: () => "default",
              fontTipDismissed: () => true,
              tabsHintDismissed: () => true, onDismissTabsHint: () => {},
              availableWidth: () => 80,
              noProviderReady: () => false,
            }}
          />
          </Show>
        </box>
        <box ref={(value) => { composer = value }} height={3} flexShrink={0} selectable={false}>
          <text>COMPOSER SHOULD NOT COPY</text>
        </box>
      </box>
    </ThemeProvider>
  ), { width: 80, height: 18 })
  selectionState = () => result.renderer.getSelection()

  await result.flush()
  for (let index = 0; index < 50; index += 1) await result.mockMouse.scroll(4, 5, "up")
  await result.flush()
  return { result, scrollbox, composerY: composer.y, currentScrollbox: () => scrollbox, setOutputVisible }
}

describe("selection drag across shell regions", () => {
  it("does not auto-scroll a non-selectable transcript drag after an empty click", async () => {
    const result = await testRender(() => null, { width: 24, height: 4 })
    let updates = 0
    try {
      const selectionDrag = createTranscriptSelectionDrag(result.renderer)
      const shell = new BoxRenderable(result.renderer, {
        width: 24, height: 4,
        onMouseDown: selectionDrag.onMouseDown,
        onMouseDrag: selectionDrag.onMouseDrag,
        onMouseUp: () => {
          selectionDrag.onMouseUp()
          consumeSelectedText(result.renderer)
        },
      })
      const transcript = new BoxRenderable(result.renderer, { width: 24, height: 4 })
      transcript.add(new TextRenderable(result.renderer, { content: "hello world", selectable: true, height: 1 }))
      transcript.add(new TextRenderable(result.renderer, { content: "non-selectable control", selectable: false, height: 1 }))
      shell.add(transcript)
      result.renderer.root.add(shell)
      selectionDrag.register({
        contains: target => target === transcript || target?.parent === transcript,
        update: () => { updates += 1 },
        stop: () => {},
      })
      await result.renderOnce()
      await result.mockMouse.click(2, 0)
      expect(result.renderer.getSelection()?.isActive).toBe(true)
      expect(result.renderer.getSelection()?.isDragging).toBe(false)
      expect(result.renderer.getSelection()?.selectedRenderables).toHaveLength(0)
      await result.mockMouse.pressDown(2, 1)
      await result.mockMouse.moveTo(2, 3)
      await result.mockMouse.release(2, 3)
      expect(updates).toBe(0)
    } finally {
      result.renderer.destroy()
      await result.renderer.closed
    }
  })

  it("scrolls downward and selects off-screen transcript text over the composer", async () => {
    const { result, scrollbox, composerY } = await mountShellSurface()
    try {
      const before = scrollbox.scrollTop
      const visibleRange = transcriptRowRange(result.captureCharFrame())
      const start = visibleTranscriptCoordinates(result)[0]
      if (!start) throw new Error("No visible transcript row")

      await result.mockMouse.pressDown(start.x, start.y)
      await result.mockMouse.moveTo(start.x, composerY + 1)
      for (let frame = 0; frame < 10; frame += 1) {
        updateFrame(scrollbox, 100)
        await result.renderOnce()
      }

      const selected = result.renderer.getSelection()?.getSelectedText() ?? ""
      expect(scrollbox.scrollTop).toBeGreaterThan(before)
      expect(transcriptRowRange(selected).max).toBeGreaterThan(visibleRange.max)
      expect(selected).not.toContain("COMPOSER SHOULD NOT COPY")
    } finally {
      result.renderer.destroy()
    }
  })

  it("scrolls upward and selects off-screen transcript text over the header", async () => {
    const { result, scrollbox } = await mountShellSurface()
    try {
      const before = scrollbox.scrollTop
      const visibleRange = transcriptRowRange(result.captureCharFrame())
      const start = visibleTranscriptCoordinates(result).at(-1)
      if (!start) throw new Error("No visible transcript row")

      await result.mockMouse.pressDown(start.x, start.y)
      await result.mockMouse.moveTo(start.x, 0)
      for (let frame = 0; frame < 6; frame += 1) {
        updateFrame(scrollbox, 100)
        await result.renderOnce()
      }

      const selected = result.renderer.getSelection()?.getSelectedText() ?? ""
      expect(scrollbox.scrollTop).toBeLessThan(before)
      expect(transcriptRowRange(selected).min).toBeLessThan(visibleRange.min)
      expect(selected).not.toContain("HEADER SHOULD NOT COPY")
    } finally {
      result.renderer.destroy()
    }
  })

  it("stops on release and ignores drags that start in the composer", async () => {
    const first = await mountShellSurface()
    try {
      const start = visibleTranscriptCoordinates(first.result)[0]
      if (!start) throw new Error("No visible transcript row")
      await first.result.mockMouse.pressDown(start.x, start.y)
      await first.result.mockMouse.moveTo(start.x, first.composerY + 1)
      updateFrame(first.scrollbox, 200)
      const releasedAt = first.scrollbox.scrollTop
      await first.result.mockMouse.release(start.x, first.composerY + 1)
      updateFrame(first.scrollbox, 1_000)
      expect(first.scrollbox.scrollTop).toBe(releasedAt)
    } finally {
      first.result.renderer.destroy()
    }

    const second = await mountShellSurface()
    try {
      const before = second.scrollbox.scrollTop
      await second.result.mockMouse.pressDown(4, second.composerY + 1)
      await second.result.mockMouse.moveTo(4, second.scrollbox.y + second.scrollbox.height - 1)
      updateFrame(second.scrollbox, 1_000)
      expect(second.scrollbox.scrollTop).toBe(before)
    } finally {
      second.result.renderer.destroy()
    }
  })

  it("stops in the transcript interior and clamps at the boundary", async () => {
    const { result, scrollbox, composerY } = await mountShellSurface()
    try {
      const start = visibleTranscriptCoordinates(result)[0]
      if (!start) throw new Error("No visible transcript row")
      await result.mockMouse.pressDown(start.x, start.y)
      await result.mockMouse.moveTo(start.x, composerY + 1)
      updateFrame(scrollbox, 200)
      const afterEdge = scrollbox.scrollTop
      await result.mockMouse.moveTo(start.x, scrollbox.y + Math.floor(scrollbox.height / 2))
      updateFrame(scrollbox, 1_000)
      expect(scrollbox.scrollTop).toBe(afterEdge)

      await result.mockMouse.moveTo(start.x, composerY + 1)
      updateFrame(scrollbox, 10_000)
      const atBoundary = scrollbox.scrollTop
      updateFrame(scrollbox, 10_000)
      expect(scrollbox.scrollTop).toBe(atBoundary)
    } finally {
      result.renderer.destroy()
    }
  })

  it("stops an active drag when the transcript unmounts and registers its replacement", async () => {
    const surface = await mountShellSurface()
    try {
      const start = visibleTranscriptCoordinates(surface.result)[0]
      if (!start) throw new Error("No visible transcript row")
      await surface.result.mockMouse.pressDown(start.x, start.y)
      await surface.result.mockMouse.moveTo(start.x, surface.composerY + 1)
      updateFrame(surface.scrollbox, 200)
      const oldOffset = surface.scrollbox.scrollTop

      surface.setOutputVisible(false)
      await surface.result.flush()
      updateFrame(surface.scrollbox, 1_000)
      expect(surface.scrollbox.scrollTop).toBe(oldOffset)

      surface.setOutputVisible(true)
      await surface.result.flush()
      const replacement = surface.currentScrollbox()
      expect(replacement).not.toBe(surface.scrollbox)
      for (let index = 0; index < 50; index += 1) await surface.result.mockMouse.scroll(4, 5, "up")
      await surface.result.flush()
      const replacementStart = visibleTranscriptCoordinates(surface.result)[0]
      if (!replacementStart) throw new Error("No visible replacement transcript row")
      const replacementOffset = replacement.scrollTop
      await surface.result.mockMouse.pressDown(replacementStart.x, replacementStart.y)
      await surface.result.mockMouse.moveTo(replacementStart.x, surface.composerY + 1)
      updateFrame(replacement, 200)
      expect(replacement.scrollTop).toBeGreaterThan(replacementOffset)
    } finally {
      surface.result.renderer.destroy()
    }
  })
})
