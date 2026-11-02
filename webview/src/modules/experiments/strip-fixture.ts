import { createComponent, createRoot, createSignal, Show } from "solid-js"

import type { FrontendExperimentView } from "../../../../src/protocol/modules/experiments.js"
import { createElement, insert, nodes, textContent } from "../../app/render-ownership-host-fixture.js"
import { ExperimentStrip, type ExperimentStripHandle } from "./strip.js"

/** Mounts the strip the way App does: under a Show over the frame's view,
 *  with the handle owned outside and dropped when the strip unmounts. */
export function mountExperimentStrip(initial: FrontendExperimentView | undefined) {
  return createRoot((dispose) => {
    const [view, setView] = createSignal<FrontendExperimentView | undefined>(initial)
    const root = createElement("root")
    let handle: ExperimentStripHandle | undefined
    insert(root, Show({
      get when() { return view() },
      children: (current: () => FrontendExperimentView) => createComponent(ExperimentStrip, {
        get view() { return current() },
        register(next: ExperimentStripHandle) { handle = next },
      }),
    }))
    const find = (className: string) => nodes(root).filter((node) => typeof node.properties.class === "string" && node.properties.class.split(" ").includes(className))
    // The memory host has no focus; the strip's request is recorded instead.
    // Patched after the handle runs, because the table it focuses mounts in
    // that same synchronous update and the focus call waits a microtask.
    let focused: string | undefined
    const recordFocus = (node: ReturnType<typeof nodes>[number]) => {
      Object.assign(node, { focus: () => { focused = typeof node.properties.id === "string" ? node.properties.id : undefined } })
    }
    return {
      setView,
      dispose,
      text: () => textContent(root),
      find,
      showDashboard: () => {
        handle?.showDashboard()
        for (const node of nodes(root)) recordFocus(node)
      },
      focused: () => focused,
      hasHandle: () => handle !== undefined,
      root,
    }
  })
}
