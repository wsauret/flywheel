import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"

import { ReturnToLatest } from "./return-to-latest.js"

export function renderReturnToLatest(unseen: number): string {
  return renderToString(() => createComponent(ReturnToLatest, { unseen, onClick: () => {} }))
}
