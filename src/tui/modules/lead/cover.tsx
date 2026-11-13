/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { OpaqueBox } from "../../components/opaque-box.js"

/** The whole terminal under one lead view, with the view centred in it. The
 *  viewer layer's backdrop repaints nothing, and a session viewer's frame
 *  leaves a margin, so without this cover the lead's own screen shows
 *  around the view: its composer border beside and below the frame. */
export function LeadViewCover(props: { readonly children: JSX.Element }) {
  const dimensions = useTerminalDimensions()
  return <OpaqueBox width={dimensions().width} height={dimensions().height} alignItems="center" justifyContent="center">{props.children}</OpaqueBox>
}
