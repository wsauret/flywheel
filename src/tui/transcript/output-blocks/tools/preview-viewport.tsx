/** @jsxImportSource @opentui/solid */

import { TOOL_PREVIEW_LINE_LIMIT } from "@infra/output-blocks"
import type { BoxRenderable } from "@opentui/core"
import type { JSX } from "solid-js"

/** Clips a preview after wrapping and reports whether its laid-out body exceeds the budget. */
export function PreviewViewport(props: {
  expanded: boolean
  onOverflow: (overflow: boolean) => void
  children: JSX.Element
}) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      maxHeight={props.expanded ? undefined : TOOL_PREVIEW_LINE_LIMIT}
      overflow={props.expanded ? undefined : "hidden"}
    >
      <box
        flexDirection="column"
        flexShrink={0}
        width="100%"
        onSizeChange={function (this: BoxRenderable) {
          props.onOverflow(this.height > TOOL_PREVIEW_LINE_LIMIT)
        }}
      >
        {props.children}
      </box>
    </box>
  )
}
