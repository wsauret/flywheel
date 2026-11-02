import type { NativeSession, RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, onCleanup, untrack } from "solid-js"
import { useTheme } from "@tui/context/theme"

/** OSC 11 sequence that sets the terminal's default background color. */
export function oscDefaultBackground(color: RGBA): string {
  const [r, g, b] = color.toInts()
  const hex = ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)
  return `\x1b]11;#${hex}\x07`
}

export type TerminalBackgroundWriter = Pick<NativeSession, "write" | "idle">

/**
 * Keep the terminal's default background color synced to the active theme,
 * only while base surfaces actually sit on the default background.
 *
 * Under compatible rendering (Terminal.app, or the setting forced on) base
 * surfaces render without an explicit background so box glyphs native-draw
 * connected (see utils/terminal-capabilities.ts), and OSC 11 makes the
 * terminal's default background the theme background: the frame keeps theme
 * colors and follows theme switches while borders stay connected. In
 * explicit mode the theme background is painted per cell and the terminal's
 * own default background is restored (OSC 111), which also unwinds a live
 * toggle. The exit paths in app.tsx restore the terminal the same way.
 * The writer must be the renderer's NativeSession so control output cannot
 * interrupt a frame. A refused write waits for idle, then retries only the
 * latest background. Reset, system selection, and disposal cancel pending bytes.
 */
export function createTerminalBackground(writer: TerminalBackgroundWriter): void {
  const renderer = useRenderer()
  const themeContext = useTheme()
  let pending: Uint8Array | undefined
  let waiting = false
  const flush = (): void => {
    if (renderer.isDestroyed || waiting || pending === undefined) return
    if (writer.write(pending)) {
      pending = undefined
      return
    }
    waiting = true
    void writer.idle().then(() => {
      waiting = false
      flush()
    }, () => {
      // The renderer owns native output failures. A failed idle wait cannot drain.
      waiting = false
      pending = undefined
    })
  }
  onCleanup(() => {
    pending = undefined
  })
  createEffect(() => {
    pending = undefined
    if (renderer.isDestroyed || !themeContext.terminalColorsReady || themeContext.themeName === "system") return
    if (themeContext.baseBackground === undefined) {
      pending = new TextEncoder().encode(oscDefaultBackground(themeContext.theme.background))
      untrack(flush)
    } else {
      renderer.resetTerminalBgColor()
    }
  })
}