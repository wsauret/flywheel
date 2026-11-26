/** @jsxImportSource @opentui/solid */

import { BoxRenderable, RGBA, type BoxOptions, type OptimizedBuffer, type RenderContext } from "@opentui/core"
import { extend, type ExtendedComponentProps } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import type { JSX } from "solid-js"

// In compatible rendering mode setCell direct-stores this into each cell, so
// the cell reaches the wire as SGR 49 and the OSC 11 default background
// supplies the visible color (see hooks/create-terminal-background.ts).
// drawText and fillRect alpha-blend a transparent background (a no-op) and
// cannot clear.
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

/**
 * A box that occludes the content beneath it by direct-storing space cells
 * over its full rectangle - border cells included - before drawing its
 * border chrome on top.
 *
 * The stored background is the theme context's baseBackground, injected by
 * the JSX wrapper as `clearColor`. In compatible rendering mode that is
 * transparent: an explicit background SGR would stop macOS Terminal.app from
 * native-drawing box glyphs and gap every border, so the cells stay on the
 * terminal default background and OSC 11 colors them. In explicit mode it is
 * the theme background, matching the base surfaces that are painted per
 * cell.
 *
 * `interiorColor` direct-stores an elevated fill on the cells inside the
 * border ring only - unlike `clearColor`, which covers the whole rectangle -
 * so a raised surface (the question dock) keeps its elevation cue while its
 * border cells keep the base contract above and render connected.
 */
interface OpaqueBoxOptions extends BoxOptions {
  /** Elevated fill for the cells inside the border ring; border cells keep
   *  the clearColor base contract. */
  interiorColor?: RGBA
  /** Color the full rectangle clears to. Transparent keeps cells on the
   *  terminal default background; the JSX wrapper supplies the value from
   *  the theme context's baseBackground. */
  clearColor?: RGBA
}

class OpaqueBoxRenderable extends BoxRenderable {
  private _interiorColor?: RGBA
  private _clearColor?: RGBA

  constructor(ctx: RenderContext, options: OpaqueBoxOptions) {
    super(ctx, options)
    this._interiorColor = options.interiorColor
    this._clearColor = options.clearColor
  }

  get interiorColor(): RGBA | undefined {
    return this._interiorColor
  }

  set interiorColor(value: RGBA | undefined) {
    if (this._interiorColor !== value) {
      this._interiorColor = value
      this.requestRender()
    }
  }

  get clearColor(): RGBA | undefined {
    return this._clearColor
  }

  set clearColor(value: RGBA | undefined) {
    if (this._clearColor !== value) {
      this._clearColor = value
      this.requestRender()
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    // setCell replaces cells without the buffer's opacity stack, so a fully
    // transparent box must skip its fill or it blanks what lies under it.
    if (buffer.getCurrentOpacity() === 0) {
      super.renderSelf(buffer)
      return
    }
    // Clamp to the buffer so the per-cell native writes stay bounded by the
    // viewport; Yoga's non-finite between-layout dimensions also collapse the
    // loops to nothing here, and the next frame is real.
    const left = Math.max(this.x, 0)
    const top = Math.max(this.y, 0)
    const right = Math.min(this.x + this.width, buffer.width)
    const bottom = Math.min(this.y + this.height, buffer.height)
    const clear = this._clearColor ?? TRANSPARENT
    for (let row = top; row < bottom; row++) {
      for (let col = left; col < right; col++) {
        buffer.setCell(col, row, " ", TRANSPARENT, clear)
      }
    }
    const fill = this._interiorColor
    if (fill) {
      // borderSides is all-false when the border is disabled, so the fill
      // spans the whole rectangle in that case.
      const fillLeft = Math.max(this.x + (this.borderSides.left ? 1 : 0), 0)
      const fillTop = Math.max(this.y + (this.borderSides.top ? 1 : 0), 0)
      const fillRight = Math.min(this.x + this.width - (this.borderSides.right ? 1 : 0), buffer.width)
      const fillBottom = Math.min(this.y + this.height - (this.borderSides.bottom ? 1 : 0), buffer.height)
      for (let row = fillTop; row < fillBottom; row++) {
        for (let col = fillLeft; col < fillRight; col++) {
          buffer.setCell(col, row, " ", TRANSPARENT, fill)
        }
      }
    }
    super.renderSelf(buffer)
  }
}

extend({ opaque_box: OpaqueBoxRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    opaque_box: typeof OpaqueBoxRenderable
  }
}

export type OpaqueBoxProps = ExtendedComponentProps<typeof OpaqueBoxRenderable>

export function OpaqueBox(props: OpaqueBoxProps): JSX.Element {
  const themeContext = useTheme()
  return <opaque_box {...props} clearColor={themeContext.baseBackground} />
}
