import type { Accessor } from "solid-js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { ReleaseNotice } from "../../protocol/update-protocol-types.js"
import { mutateRuntimeConfig, type RuntimeConfigCache } from "./shell-state.js"

interface ReleaseNoticeActions {
  dismiss(): Promise<void>
}

/** Dismiss through the account configuration, without an optimistic client copy. */
export function useReleaseNotice(
  notice: Accessor<ReleaseNotice | undefined>,
  config: RuntimeConfigCache,
  appService: Pick<RuntimeClient, "dispatch">,
  showToast: (opts: { message: string; variant: "error" }) => void,
): ReleaseNoticeActions {
  return {
    async dismiss() {
      const current = notice()
      if (current === undefined) return
      const acknowledged = config.view()?.values.acknowledgedReleaseVersion
      const result = await mutateRuntimeConfig(config, appService, {
        type: "config.mutate",
        setting: {
          id: "acknowledgedReleaseVersion",
          expected: acknowledged === undefined ? { kind: "absent" } : { kind: "value", value: acknowledged },
          desired: current.version,
        },
      })
      if (result.kind !== "committed" && result.kind !== "committed-with-durability-warning" && result.kind !== "committed-with-degraded-application") {
        showToast({ message: `Update notice dismissal failed: ${result.message}`, variant: "error" })
      }
    },
  }
}
