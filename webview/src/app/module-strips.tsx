import { createComponent, ErrorBoundary, type JSX } from "solid-js"

import type { WebModule } from "../web-module.js"

/** Every registered module's strip for the open session, in registry order.
 *  A strip that throws is contained to itself and reported once, so a broken
 *  module never takes the transcript or the composer with it. */
export function ModuleStrips(props: {
  readonly modules: readonly WebModule[]
  readonly sessionId: string
  readonly report: (module: WebModule, error: unknown) => void
}): JSX.Element {
  return props.modules.flatMap((module) => {
    const strip = module.strip
    if (!strip) return []
    return [createComponent(ErrorBoundary, {
      fallback: (error: unknown) => { props.report(module, error); return null },
      get children() { return createComponent(strip, { sessionId: props.sessionId }) },
    })]
  })
}
