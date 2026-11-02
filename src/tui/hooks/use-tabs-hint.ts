import type { Accessor } from "solid-js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { mutateRuntimeConfig, type RuntimeConfigCache } from "./shell-state.js"

export interface TabsHint {
  readonly dismissed: Accessor<boolean>
  /** Persists the dismissal; a failed write keeps the hint and says why. */
  readonly dismiss: () => Promise<void>
}

/** The intro card's tabs hint stays until the user dismisses it once. */
export function useTabsHint(
  config: RuntimeConfigCache,
  appService: Pick<RuntimeClient, "dispatch">,
  showToast: (opts: { message: string; variant: "error" }) => void,
): TabsHint {
  return {
    // Hidden until configuration loads, so a dismissed hint never flashes.
    dismissed: () => config.view()?.values.tabsHintDismissed ?? true,
    dismiss: async () => {
      const result = await mutateRuntimeConfig(config, appService, {
        type: "config.mutate",
        setting: { id: "tabsHintDismissed", expected: { kind: "value", value: false }, desired: true },
      })
      if (result.kind !== "committed" && result.kind !== "committed-with-durability-warning" && result.kind !== "committed-with-degraded-application") {
        showToast({ message: `Tabs hint dismissal failed: ${result.message}`, variant: "error" })
      }
    },
  }
}
