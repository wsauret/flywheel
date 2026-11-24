import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { activate, clearMocks, createModal, flush, fontStatus, installBundledFont, okWrite, rowOf, valueOf, type WriteResult } from "./_settings-modal-fixtures.js"

describe("useSettingsModal updates", () => {
  it("font action row calls bundled font installer", async () => {
    clearMocks()
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const { modal } = createModal()
        modal.openSettingsModal()
        activate(modal, "font")
        queueMicrotask(() => {
          expect(installBundledFont).toHaveBeenCalledTimes(1)
          dispose()
          resolve()
        })
      })
    })
  })

  it("drops font-install settlement after close", async () => {
    clearMocks()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof installBundledFont>>>()
    installBundledFont.mockImplementationOnce(() => pending.promise)
    await createRoot(async (dispose) => {
      const { modal, modals, showToast } = createModal()
      modal.openSettingsModal()
      activate(modal, "font")
      modals.input({ name: "escape" })

      pending.resolve({ status: fontStatus, installedFiles: [], targetDir: "/scratch/fonts", warnings: [] })
      await flush()

      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("reads Automatic updates from the published runtime view", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal } = createModal({ initialUpdateAutoInstall: false })
      modal.openSettingsModal()

      const row = rowOf(modal, "auto-install")
      expect(row.kind).toBe("cycle")
      expect(row.label).toBe("Automatic updates")
      expect(valueOf(modal, "auto-install")).toBe("NO")
      expect(row.unavailableReason?.()).toBeUndefined()
      dispose()
    })
  })

  it("keeps Automatic updates unavailable and inert before the runtime snapshot hydrates", () => {
    clearMocks()
    createRoot((dispose) => {
      const { modal, modals, setUpdateAutoInstall } = createModal()
      modal.openSettingsModal()

      activate(modal, "maintenance")
      expect(rowOf(modal, "auto-install").unavailableReason?.()).toBeDefined()
      const view = modal.settingsView()
      if (view.kind !== "list") throw new Error("Expected maintenance settings")
      const index = view.rows?.findIndex((row) => row.kind !== "separator" && row.id === "auto-install") ?? -1
      expect(index).toBeGreaterThanOrEqual(0)
      for (let movement = 0; movement < index; movement++) modals.input({ name: "down" })
      modals.input({ name: "space" })
      expect(setUpdateAutoInstall).not.toHaveBeenCalled()

      // The row still takes the cursor and refuses activation by any path.
      modal.activateSettingsRow(index)
      expect(modal.settingsModalCursor()).toBe(index)
      expect(setUpdateAutoInstall).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("publishes automatic updates only through the runtime command", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, setUpdateAutoInstall } = createModal({ initialUpdateAutoInstall: true })
      modal.openSettingsModal()

      activate(modal, "auto-install")
      await flush()

      expect(setUpdateAutoInstall).toHaveBeenCalledWith(true, false)
      expect(valueOf(modal, "auto-install")).toBe("NO")
      dispose()
    })
  })

  // The inert-toggle case: with the environment holding auto-install off, a row
  // that read the effective policy could never flip, and a toast that reported
  // a bare success described a change the user could not see anywhere.
  it("writes the durable value and names the override while the environment holds updates off", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, showToast, setUpdateAutoInstall } = createModal({ initialUpdateAutoInstall: false, updateOverrideHoldsOff: true })
      modal.openSettingsModal()

      activate(modal, "auto-install")
      await flush()

      expect(setUpdateAutoInstall).toHaveBeenCalledWith(false, true)
      expect(valueOf(modal, "auto-install")).toBe("Off for this run via environment")
      expect(showToast).toHaveBeenCalledWith({
        message: "Automatic updates enabled for future runs; still off for this run by the environment",
        variant: "success",
      })
      dispose()
    })
  })

  it.each([false, true])("reports a failed setting write with the modal closed: %s", async (close) => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { modal, showToast, setUpdateAutoInstall } = createModal({ initialUpdateAutoInstall: true })
      setUpdateAutoInstall.mockImplementationOnce(async () => ({ ok: false, error: new Error("runtime refused") }))
      modal.openSettingsModal()

      activate(modal, "auto-install")
      if (close) modal.closeSettingsModal()
      await flush()

      expect(showToast).toHaveBeenCalledWith({ message: "Automatic updates update failed: runtime refused", variant: "error" })
      expect(valueOf(modal, "auto-install")).toBe("YES")
      dispose()
    })
  })

  it("suppresses a second update toggle while the first request is pending", async () => {
    clearMocks()
    const pending = Promise.withResolvers<WriteResult>()
    await createRoot(async (dispose) => {
      const { modal, setUpdateAutoInstall } = createModal({ initialUpdateAutoInstall: true })
      setUpdateAutoInstall.mockImplementationOnce(() => pending.promise)
      modal.openSettingsModal()

      activate(modal, "auto-install")
      activate(modal, "auto-install")
      expect(setUpdateAutoInstall).toHaveBeenCalledTimes(1)

      pending.resolve(okWrite)
      await flush()
      dispose()
    })
  })
})
