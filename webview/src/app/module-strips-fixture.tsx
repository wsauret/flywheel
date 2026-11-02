import { createComponent, createRoot } from "solid-js"

import type { ModuleId } from "../../../src/protocol/module-ids.js"
import type { WebModule } from "../web-module.js"
import { ModuleStrips } from "./module-strips.js"
import { createElement, createTextNode, insert, insertNode, textContent } from "./render-ownership-host-fixture.js"

/** Mounts the module strips the way App does, beside a composer stand-in, so
 *  a strip's failure can be seen to leave its neighbours standing. */
export function mountModuleStrips(modules: readonly WebModule[]) {
  return createRoot((dispose) => {
    const root = createElement("root")
    const reports: string[] = []
    insert(root, createComponent(ModuleStrips, {
      modules,
      sessionId: "chat-1",
      report: (module, error) => { reports.push(`${module.id}: ${error instanceof Error ? error.message : String(error)}`) },
    }))
    const composer = createElement("composer")
    insertNode(composer, createTextNode("composer"))
    insertNode(root, composer)
    return { dispose, text: () => textContent(root), reports }
  })
}

/** A strip that renders its session, and one that throws on render, under
 *  the module id the test chooses. */
export function syntheticStrips(id: ModuleId) {
  const working: WebModule = {
    id,
    strip: (props) => <div class="strip">strip for {props.sessionId}</div>,
    surfaces: [{ id: "bench-board", open: () => {} }],
  }
  const broken: WebModule = { id, strip: () => { throw new Error("strip exploded") } }
  return { working, broken }
}
