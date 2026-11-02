import { expect, mock, test } from "bun:test"
import type { FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeConfigView } from "../../../../src/protocol/runtime-config-protocol-types.js"
import { useReleaseNotice } from "../../../../src/tui/hooks/use-release-notice.js"
import { configValues } from "../modals/_settings-modal-fixtures.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

type ConfigMutation = Extract<FrontendMutation, { type: "config.mutate" }>

test("dismissal writes the running release with the shared expected version and reports a failed write", async () => {
  const notice = { version: "0.1.1", message: "Updated to v0.1.1.", url: "https://github.com/owner/project/releases" }
  const current: RuntimeConfigView = { revision: 1, values: { ...configValues(), acknowledgedReleaseVersion: "0.1.0" }, status: { kind: "valid" }, warnings: [], diagnostics: [] }
  const writes = mock(async (_command: ConfigMutation): Promise<MutationResult<ConfigMutation>> => ({ kind: "committed", revision: 2 }))
  const dispatch = runtimeDispatch({ "config.mutate": writes })
  const showToast = mock(() => {})
  const actions = useReleaseNotice(() => notice, { view: () => current, settlePublication: async () => true }, { dispatch }, showToast)
  await actions.dismiss()
  expect(writes).toHaveBeenCalledWith({ type: "config.mutate", setting: { id: "acknowledgedReleaseVersion", expected: { kind: "value", value: "0.1.0" }, desired: "0.1.1" } })
  expect(showToast).not.toHaveBeenCalled()
  expect(current.values.acknowledgedReleaseVersion).toBe("0.1.0")

  writes.mockImplementation(async () => ({ kind: "stale", message: "The configuration changed before this update. Try again." }))
  await actions.dismiss()
  expect(showToast).toHaveBeenCalledWith({ message: "Update notice dismissal failed: The configuration changed before this update. Try again.", variant: "error" })
})
