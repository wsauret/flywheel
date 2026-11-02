import { describe, expect, it, mock } from "bun:test"
import { createLauncherScope } from "../../../../src/infra/process-supervisor.js"
import { handleFontCommand } from "../../../../src/tui/commands/command-definitions.js"
import type { RuntimeConfigCache } from "../../../../src/tui/hooks/shell-state.js"
import { configValues } from "../modals/_settings-modal-fixtures.js"
import { runtimeDispatch, type DispatchAnswer } from "../../../helpers/runtime-dispatch.js"

function config(dismissed: boolean, settlePublication = async () => true): RuntimeConfigCache {
  return {
    view: () => ({ revision: 4, values: { ...configValues(), fontTipDismissed: dismissed }, status: { kind: "valid" }, warnings: [], diagnostics: [] }),
    settlePublication,
  }
}

function configDispatch(handler: DispatchAnswer<"config.mutate">) {
  return { dispatch: runtimeDispatch({ "config.mutate": handler }) }
}

const launcher = createLauncherScope({ spawnOwned: async () => { throw new Error("not used") }, adoptOwned: () => Promise.reject(new Error("no command is adopted here")) })
const directories = { accountHome: "/account", userDataRoot: "/account/.flywheel" }

describe("font command config mutation", () => {
  it("uses the projected value as CAS and reports success after publication", async () => {
    const dispatch = mock(async () => ({ kind: "committed", revision: 5 } as const))
    const showToast = mock(() => {})

    await handleFontCommand({ directories, launcher, appService: configDispatch(dispatch), runtimeConfig: config(false), showToast }, "dismiss")

    expect(dispatch).toHaveBeenCalledWith({
      type: "config.mutate",
      setting: { id: "fontTipDismissed", expected: { kind: "value", value: false }, desired: true },
    })
    expect(showToast).toHaveBeenLastCalledWith({ message: "Font tip dismissed", variant: "success" })
  })

  it("shows typed failure feedback and no success when mutation fails", async () => {
    const dispatch = mock(async () => ({ kind: "stale", message: "The configuration changed before this update. Try again." } as const))
    const showToast = mock(() => {})

    await handleFontCommand({ directories, launcher, appService: configDispatch(dispatch), runtimeConfig: config(true), showToast }, "reset")

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith({
      message: "Font tip update failed: The configuration changed before this update. Try again.",
      variant: "error",
    })
  })
})
