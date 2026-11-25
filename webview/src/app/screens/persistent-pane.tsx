import { createMemo, Show, type JSX } from "solid-js"

/** Cold stages fill the pane. A known subject keeps its interactive content
 *  while the stage supplies advisory recovery or setup actions beside it. */
export function PersistentPane(props: {
  readonly active: boolean
  readonly advisory?: boolean
  readonly children: JSX.Element
  readonly takeover: JSX.Element
}) {
  const mounted = createMemo((wasMounted) => wasMounted || props.active || props.advisory, false)
  return (
    <>
      <Show when={mounted()}>
        <div class="pane-resident" inert={!props.active && !props.advisory}>
          {props.children}
        </div>
      </Show>
      <Show when={!props.active}>
        <div class={props.advisory ? "pane-advisory" : "pane-takeover"}>{props.takeover}</div>
      </Show>
    </>
  )
}
