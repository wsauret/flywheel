import type { BoxRenderable } from "@opentui/core"
import { createSignal, onCleanup } from "solid-js"

// One width measurement per tool list, passed down to every ToolRow. The
// element measurement is the authority, but it only lands after the list's
// first layout - one frame after mount. The optional seed (the shared row
// width minus the caller's declared chrome; see context/row-width.ts)
// covers that mount frame so rows wrap into their final shape on first
// layout: no blank-then-rewrap transient for the scroll pipeline to
// mis-record as a height. If the declared chrome ever drifts from the JSX,
// the measurement corrects it one frame later instead of failing silently.
export function createMeasuredWidth(seed?: () => number) {
  const [measured, setMeasured] = createSignal(0)
  const ref = (el: BoxRenderable) => {
    const update = () => {
      // OpenTUI reports NaN width while the box is between layouts; skip it,
      // the resize event re-fires once laid out.
      if (!Number.isFinite(el.width)) return
      setMeasured(el.width)
    }
    update()
    el.on("resize", update)
    onCleanup(() => el.off("resize", update))
  }
  const width = () => {
    const m = measured()
    return m > 0 ? m : Math.max(0, seed?.() ?? 0)
  }
  return { width, ref }
}
