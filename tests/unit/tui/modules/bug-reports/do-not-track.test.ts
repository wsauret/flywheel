import { describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { AUTOMATIC_REPORTS_CONTROL } from "../../../../../src/protocol/modules/bug-reports.js"
import type { ToastInput } from "../../../../../src/tui/context/toast.js"
import { presentDoNotTrack } from "../../../../../src/tui/modules/bug-reports/do-not-track.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/modules/module-domain.js"

/** The presence over published signals, as the slot host runs it: the module selection and the saved answer
 *  start unpublished, so each case publishes them the way the runtime does after the first frame. */
function present(doNotTrack: string | undefined) {
  const [enabled, setEnabled] = createSignal<boolean | undefined>()
  const [automatic, setAutomatic] = createSignal<boolean | undefined>()
  const updateConfigBoolean = mock(async (_setting: typeof AUTOMATIC_REPORTS_CONTROL, _value: boolean) => ({ ok: true } as const))
  const showToast = mock((_toast: ToastInput) => {})
  const dispose = createRoot((disposeRoot) => {
    presentDoNotTrack({
      read: moduleDomainReader(() => undefined), showToast, enabled,
      settings: { configBoolean: () => automatic(), updateConfigBoolean },
    }, { DO_NOT_TRACK: doNotTrack })
    return disposeRoot
  })
  return { setEnabled, setAutomatic, updateConfigBoolean, showToast, dispose }
}

describe("DO_NOT_TRACK in the terminal's environment", () => {
  it("turns off a saved yes to automatic crash reports once and says so", async () => {
    const h = present("1")
    h.setAutomatic(true)
    expect(h.updateConfigBoolean).not.toHaveBeenCalled()
    h.setEnabled(true)
    await Bun.sleep(0)
    expect(h.updateConfigBoolean).toHaveBeenCalledTimes(1)
    expect(h.updateConfigBoolean).toHaveBeenCalledWith(AUTOMATIC_REPORTS_CONTROL, false)
    expect(h.showToast).toHaveBeenCalledTimes(1)
    expect(h.showToast).toHaveBeenCalledWith({
      message: "Automatic crash reports are now off because DO_NOT_TRACK is set. To change this, open Automatic crash reports in Settings.",
      variant: "info", duration: 10000,
    })
    // A later yes in this run is the person's own choice, so it stands.
    h.setAutomatic(false)
    h.setAutomatic(true)
    await Bun.sleep(0)
    expect(h.updateConfigBoolean).toHaveBeenCalledTimes(1)
    h.dispose()
  })

  it("leaves a no, an unanswered question, and a disabled module alone", async () => {
    for (const [enabled, automatic] of [[true, false], [false, true]] as const) {
      const h = present("true")
      h.setEnabled(enabled)
      h.setAutomatic(automatic)
      await Bun.sleep(0)
      expect(h.updateConfigBoolean).not.toHaveBeenCalled()
      // The decision is made once, so a yes saved later in this run is not undone.
      h.setEnabled(true)
      h.setAutomatic(true)
      await Bun.sleep(0)
      expect(h.updateConfigBoolean).not.toHaveBeenCalled()
      expect(h.showToast).not.toHaveBeenCalled()
      h.dispose()
    }
  })

  it("does nothing when DO_NOT_TRACK is unset or does not opt out", async () => {
    for (const value of [undefined, "0"]) {
      const h = present(value)
      h.setEnabled(true)
      h.setAutomatic(true)
      await Bun.sleep(0)
      expect(h.updateConfigBoolean).not.toHaveBeenCalled()
      expect(h.showToast).not.toHaveBeenCalled()
      h.dispose()
    }
  })
})
