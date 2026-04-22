// OpenTUI's onResize doesn't update wrap width, so text wraps at stale widths
// and continuation lines clip off-screen. Remove once the upstream fix lands.

import { TextBufferRenderable } from "@opentui/core"

// `as any` is unavoidable: onResize/_wrapMode/textBufferView are private in
// OpenTUI and have no public API. There's no way to patch or access them with
// correct types until the upstream fix lands.
const originalOnResize = (TextBufferRenderable.prototype as any).onResize

;(TextBufferRenderable.prototype as any).onResize = function (
  this: any,
  width: number,
  height: number,
) {
  if (this._wrapMode !== "none" && width > 0) {
    this.textBufferView.setWrapWidth(width)
  }

  originalOnResize.call(this, width, height)
}
