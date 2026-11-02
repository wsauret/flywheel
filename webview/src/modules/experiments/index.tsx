import { onCleanup, Show } from "solid-js"

import { useClient } from "../../app/client-context.js"
import type { WebModule } from "../../web-module.js"
import { ExperimentStrip, type ExperimentStripHandle } from "./strip.js"

/** The mounted strip's handle. The dashboard surface is opened by id from
 *  outside any component, so the strip leaves its handle here while it is
 *  mounted and takes it away on unmount: a request after a session switch
 *  reaches nothing rather than a strip that no longer exists. */
let dashboard: ExperimentStripHandle | undefined

function Strip() {
  const client = useClient()
  return (
    <Show when={client.state().modules.experiment_view}>
      {(view) => <ExperimentStrip view={view()} register={(handle) => { dashboard = handle; onCleanup(() => { if (dashboard === handle) dashboard = undefined }) }} />}
    </Show>
  )
}

export const experimentsWeb = {
  id: "experiments",
  strip: Strip,
  surfaces: [{ id: "experiment-dashboard", open: () => dashboard?.showDashboard() }],
} as const satisfies WebModule
