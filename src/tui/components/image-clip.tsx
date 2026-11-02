/** @jsxImportSource @opentui/solid */

import { BoxRenderable, Yoga, type BoxOptions, type RenderContext } from "@opentui/core"
import { extend, type ExtendedComponentProps } from "@opentui/solid"
import { useImageClipBottom } from "@tui/context/attachment-images.js"
import { splitProps, type Accessor } from "solid-js"

interface ImageClipOptions extends BoxOptions {
  clipBottom: Accessor<number | undefined>
}

class ImageClipRenderable extends BoxRenderable {
  private readonly clipBottom: Accessor<number | undefined>

  constructor(context: RenderContext, options: ImageClipOptions) {
    super(context, options)
    this.clipBottom = options.clipBottom
  }

  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime)
    const bottom = this.clipBottom()
    // The inner box inherits the clamp, but its nonshrinking children retain
    // their full extent, including an image that has just loaded.
    const height = this.getChildren()[0]?.getChildren().reduce((extent, child) => {
      const layout = child.getLayout()
      return Math.max(extent, layout.top + layout.height)
    }, 0) ?? 0
    const top = (this.parent?.y ?? 0) + this.getLayout().top
    const clippedHeight = bottom === undefined ? height : Math.max(0, Math.min(height, bottom - top))
    // A zero-height native clip still emits a one-row image placement.
    // Opacity suppresses it without discarding the image's layout extent.
    const partial = clippedHeight > 0 && clippedHeight < height
    const maxHeight = partial ? clippedHeight : undefined
    // Native overflow clips paint; the margin preserves transcript extent.
    const marginBottom = partial ? height - clippedHeight : 0
    const opacity = bottom !== undefined && clippedHeight === 0 ? 0 : 1
    const currentMaxHeight = this.getMaxHeight()
    if ((currentMaxHeight.unit === Yoga.Unit.Undefined ? undefined : currentMaxHeight.value) !== maxHeight) this.maxHeight = maxHeight
    if (this.getMargin(Yoga.Edge.Bottom).value !== marginBottom) this.marginBottom = marginBottom
    if (this.opacity !== opacity) this.opacity = opacity
  }
}

extend({ image_clip: ImageClipRenderable })

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    image_clip: typeof ImageClipRenderable
  }
}

/** Clips native graphics as well as cells at the transcript's queue boundary. */
export function ImageClip(props: Omit<ExtendedComponentProps<typeof ImageClipRenderable>, "clipBottom">) {
  const bottom = useImageClipBottom()
  const [local, rest] = splitProps(props, ["children"])
  return <image_clip {...rest} clipBottom={bottom} overflow="hidden" flexShrink={0}>
    <box flexDirection="column" flexShrink={0}>{local.children}</box>
  </image_clip>
}
