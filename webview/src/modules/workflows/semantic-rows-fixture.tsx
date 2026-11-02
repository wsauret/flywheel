import { createComponent, createRoot } from "solid-js"
import { createElement, insert, nodes, textContent } from "../../app/render-ownership-host-fixture.js"
import { WorkflowCard } from "./card.js"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"

/** Renders imperative workflow rows through the client DOM boundary, not SSR. */
export function mountWorkflowTree(card: NonNullable<Extract<FrontendOutputBlock, { kind: "agentGroup" }>["card"]>) {
  return createRoot(dispose => {
    const root = createElement("root")
    insert(root, createComponent(WorkflowCard, { card, status: "active", live: [], now: () => 510_000, onAction() {}, sessions: new Map(), roles: { get: () => undefined, subscribe: () => () => {} } }))
    return { dispose, elements: () => nodes(root), text: () => textContent(root) }
  })
}
