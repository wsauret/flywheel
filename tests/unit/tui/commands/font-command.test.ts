import { describe, expect, it, mock } from "bun:test"
import { createLauncherScope } from "../../../../src/infra/process-supervisor.js"
import { handleFontCommand } from "../../../../src/tui/commands/command-definitions.js"
import type { CommandRuntimeConfig } from "../../../../src/tui/commands/command-types.js"
import { mutateRuntimeConfig } from "../../../../src/tui/hooks/state/create-settings-store.js"
import type { RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { configValues } from "../modals/settings/_settings-modal-fixtures.js"
import { runtimeDispatch, type DispatchAnswer } from "../../../helpers/runtime-dispatch.js"

/** The composition's binding: the cache's view, and its mutation settled through publication. */
function config(dismissed: boolean, appService: Pick<RuntimeClient, "dispatch">, settlePublication = async () => true): CommandRuntimeConfig {
  const cache = {
    view: () => ({ revision: 4, values: { ...configValues(), fontTipDismissed: dismissed }, status: { kind: "valid" as const }, warnings: [], diagnostics: [] }),
    settlePublication,
  }
  return { view: cache.view, mutate: (command) => mutateRuntimeConfig(cache, appService, command) }
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
    const published = Promise.withResolvers<boolean>()

    const done = handleFontCommand({ directories, launcher, runtimeConfig: config(false, configDispatch(dispatch), () => published.promise), showToast }, "dismiss")
    await Bun.sleep(0)

    expect(dispatch).toHaveBeenCalledWith({
      type: "config.mutate",
      setting: { id: "fontTipDismissed", expected: { kind: "value", value: false }, desired: true },
    })
    expect(showToast).not.toHaveBeenCalled()
    published.resolve(true)
    await done
    expect(showToast).toHaveBeenLastCalledWith({ message: "Font tip dismissed", variant: "success" })
  })

  it("shows typed failure feedback and no success when mutation fails", async () => {
    const dispatch = mock(async () => ({ kind: "stale", message: "The configuration changed before this update. Try again." } as const))
    const showToast = mock(() => {})

    await handleFontCommand({ directories, launcher, runtimeConfig: config(true, configDispatch(dispatch)), showToast }, "reset")

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith({
      message: "Font tip update failed: The configuration changed before this update. Try again.",
      variant: "error",
    })
  })
})
