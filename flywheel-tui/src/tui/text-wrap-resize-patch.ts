/**
 * Patch: TextBufferRenderable.onResize wrap width update
 *
 * OpenTUI's TextBufferRenderable.onResize updates the viewport but does NOT
 * update the wrap width. This means when a <text> element is resized after
 * construction (which always happens since Yoga layout runs post-creation),
 * the wrap width stays stale. Text wraps at a wider width than the actual
 * rendered area, causing the first character(s) of wrapped continuation
 * lines to be clipped off-screen.
 *
 * This patch adds the missing setWrapWidth call to onResize.
 *
 * Upstream fix: https://github.com/anomalyco/opentui/issues/XXX
 * Remove this patch once the upstream fix is released.
 */

import { TextBufferRenderable } from "@opentui/core"

// onResize is a private method — `as any` required to monkey-patch it (see module doc for upstream issue)
const originalOnResize = (TextBufferRenderable.prototype as any).onResize

;(TextBufferRenderable.prototype as any).onResize = function (
  this: any,
  width: number,
  height: number,
) {
  // Fix: update wrap width when wrapping is enabled
  if (this._wrapMode !== "none" && width > 0) {
    this.textBufferView.setWrapWidth(width)
  }

  // Call original onResize
  originalOnResize.call(this, width, height)
}
