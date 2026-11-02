import { RGBA, type CliRenderer, type TerminalColors } from "@opentui/core"
import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import type { SystemThemeInput } from "../context/theme/system-theme.js"

interface PaletteRenderer extends Pick<CliRenderer, "getPalette" | "clearPaletteCache" | "prependInputHandler" | "removeInputHandler" | "resetTerminalBgColor"> {
  on(event: "palette", listener: (colors: TerminalColors) => void): void
  on(event: "theme_mode", listener: (appearance: "dark" | "light") => void): void
  off(event: "palette", listener: (colors: TerminalColors) => void): void
  off(event: "theme_mode", listener: (appearance: "dark" | "light") => void): void
}

/** Capture before child effects can write OSC 11. Application refreshes are serialized and coalesced.
 * Disposal removes subscriptions without waiting for a detector that can outlive the renderer.
 */
export function createTerminalPalette(renderer: PaletteRenderer | undefined, selected: Accessor<boolean>, mode: Accessor<"dark" | "light">) {
  const [raw, setRaw] = createSignal<{ colors?: TerminalColors; appearance?: "dark" | "light" }>({})
  const [ready, setReady] = createSignal(renderer === undefined)
  let disposed = false
  let busy = false
  let refreshRequested = false
  let scheduled = false
  let selectionRevision = 0

  const publish = (colors: TerminalColors) => setRaw(previous => ({ ...previous, colors }))
  const query = async (initial: boolean) => {
    if (!renderer) return
    busy = true
    const revision = selectionRevision
    try {
      if (!initial) {
        if (disposed || !untrack(selected)) return
        renderer.clearPaletteCache()
      }
      const colors = await renderer.getPalette({ size: 16 })
      if (!disposed && (initial || (revision === selectionRevision && untrack(selected)))) publish(colors)
    } catch {
      // Suspended renderers reject detection. The last report or named fallback remains usable.
    } finally {
      busy = false
      if (!disposed) {
        if (initial) setReady(true)
        if (refreshRequested) scheduleRefresh()
      }
    }
  }
  const scheduleRefresh = () => {
    if (disposed || !untrack(selected)) return
    refreshRequested = true
    if (busy || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (disposed || !untrack(selected)) { refreshRequested = false; return }
      refreshRequested = false
      void query(false)
    })
  }
  const paletteChanged = (colors: TerminalColors) => {
    // Our query publishes through its promise, including after selection changes.
    if (!disposed && !busy && untrack(selected)) publish(colors)
  }
  const appearanceChanged = (appearance: "dark" | "light") => {
    if (!disposed && untrack(selected)) {
      setRaw(previous => ({ ...previous, appearance }))
      scheduleRefresh()
    }
  }
  const observeInput = (sequence: string) => {
    if (sequence.includes("\x1b[?997;")) scheduleRefresh()
    return false
  }
  if (renderer) {
    renderer.on("palette", paletteChanged)
    renderer.on("theme_mode", appearanceChanged)
    renderer.prependInputHandler(observeInput)
    void query(true)
  }
  createEffect(on(selected, (system, previous) => {
    if (previous !== undefined && previous !== system) selectionRevision++
    if (system && previous === false && renderer) {
      renderer.resetTerminalBgColor()
      scheduleRefresh()
    }
  }))
  onCleanup(() => {
    disposed = true
    renderer?.off("palette", paletteChanged)
    renderer?.off("theme_mode", appearanceChanged)
    renderer?.removeInputHandler(observeInput)
  })
  const input = createMemo<SystemThemeInput>(() => {
    const { colors, appearance } = raw()
    const palette = colors?.palette.map(rgb)
    return {
      background: rgb(colors?.defaultBackground),
      foreground: rgb(colors?.defaultForeground),
      palette: palette?.length === 16 && palette.every(color => color !== undefined) ? palette : undefined,
      appearanceHint: appearance ?? mode(),
    }
  })
  const cursorColor = createMemo(() => {
    const reported = raw().colors?.cursorColor
    return reported ? RGBA.fromHex(reported) : undefined
  })
  return { input, ready, cursorColor }
}

function rgb(hex: string | null | undefined) {
  if (!hex) return undefined
  const [r, g, b] = RGBA.fromHex(hex).toInts()
  return { r, g, b }
}
