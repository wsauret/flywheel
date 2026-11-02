/** @jsxImportSource @opentui/solid */

import type { UserMessageImage } from "@infra/output-blocks"
import type { ImageRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useAttachmentImages } from "@tui/context/attachment-images.js"

/** Renders retained attachment bytes within cell bounds, scaled only for presentation. */
export function AttachmentImage(props: {
  image: UserMessageImage
  width: number
  height: number
  zoom?: number
}) {
  const presentation = useAttachmentImages()
  const [source, setSource] = createSignal<Uint8Array>()
  const [loaded, setLoaded] = createSignal(false)
  let renderable: ImageRenderable | undefined
  createEffect(on(() => props.image.data, (data) => {
    setLoaded(false)
    const timer = setTimeout(() => setSource(Buffer.from(data, "base64")), 0)
    onCleanup(() => clearTimeout(timer))
  }))
  const size = createMemo(() => {
    if (!loaded() || !renderable || props.width < 1 || props.height < 1) return { width: Math.max(1, props.width), height: 0 }
    const fitted = renderable.getFittedSize(Math.max(1, props.width), Math.max(1, props.height))
    const zoom = props.zoom ?? 1
    return { width: fitted.width * zoom, height: fitted.height * zoom }
  })
  return <image
    ref={(node: ImageRenderable) => { renderable = node }}
    source={source()}
    width={size().width}
    height={size().height}
    flexShrink={0}
    visible={presentation.visible()}
    fit="fit"
    protocol="auto"
    onLoad={() => setLoaded(true)}
  />
}
