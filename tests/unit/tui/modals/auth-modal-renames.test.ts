import { beforeEach, describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { clearMocks, createModal, flush, rowIndexOf, setAuthStatuses } from "./auth-modal-test-harness.js"

describe("auth names save on completion", () => {
  beforeEach(clearMocks)

  it.each(["escape", "tab", "click", "frame"])("commits a profile rename on %s, not while typing", async (finish) => {
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal()
      modal.openAuthModal()
      modals.input({ name: "r" })
      modals.paste("New name")
      expect(sent("auth.profile.rename")).toEqual([])
      if (finish === "frame") modal.closeAuthModal()
      else if (finish === "click") modal.finishRename()
      else modals.input({ name: finish })
      await flush()
      expect(sent("auth.profile.rename")).toEqual([{ type: "auth.profile.rename", scope: { kind: "defaults" }, id: "default", displayName: "New name" }])
      dispose()
    })
  })

  it.each(["escape", "tab", "click", "frame"])("commits an account label cleared on %s", async (finish) => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", accounts: [
      { instanceId: "account-1", accountCorrelationId: "opaque-1", identity: "one@example.com", displayLabel: "Personal", label: "Personal", expired: false, source: "oauth" },
      { instanceId: "account-2", accountCorrelationId: "opaque-2", identity: "two@example.com", displayLabel: "two@example.com", expired: false, source: "oauth" },
    ] })
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal()
      modal.openAuthModal()
      while (modal.authRows()[modal.authModalCursor()]?.kind !== "account") modals.input({ name: "down" })
      modals.input({ name: "r" })
      modals.input({ name: "backspace" })
      if (finish === "frame") modals.clear()
      else if (finish === "click") modal.finishRename()
      else modals.input({ name: finish })
      await flush()
      expect(sent("auth.account.rename")).toEqual([{ type: "auth.account.rename", providerId: "chatgpt", instanceId: "account-1", profileId: "default" }])
      dispose()
    })
  })

  it("keeps invalid profile text until leaving and never writes an unchanged name", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, sent, showToast } = createModal()
      modal.openAuthModal()
      modals.input({ name: "r" })
      modals.input({ name: "escape" })
      await flush()
      expect(sent("auth.profile.rename")).toEqual([])
      modals.input({ name: "r" })
      modals.input({ name: "backspace" })
      modals.input({ name: "return" })
      expect(modal.authView()).toMatchObject({ kind: "profile-rename-input", error: "Enter a profile name" })
      expect(modal.authInputPresentation().value).toBe("")
      modals.input({ name: "escape" })
      expect(modal.authView().kind).toBe("list")
      expect(sent("auth.profile.rename")).toEqual([])
      expect(showToast).toHaveBeenCalledWith({ message: "Enter a profile name", variant: "error" })
      dispose()
    })
  })
  it.each([{}, { ctrl: true }, { shift: true }])("keeps rename arrows in the text editor: %j", async (modifier) => {
    await createRoot(async (dispose) => {
      const { modal, modals, sent } = createModal()
      modal.openAuthModal()
      modals.input({ name: "r" })
      modals.input({ name: "right" })
      modals.input({ name: "left", ...modifier })
      expect(modal.authView().kind).toBe("profile-rename-input")
      expect(sent("auth.profile.rename")).toEqual([])
      dispose()
    })
  })
  it.each([1, 2])("shows an account rename write with %i accounts until it settles, including after leaving", async (count) => {
    setAuthStatuses({ providerId: "chatgpt", source: "oauth", accounts: [
      { instanceId: "account-1", accountCorrelationId: "opaque-1", identity: "one@example.com", displayLabel: "Personal", label: "Personal", expired: false, source: "oauth" as const },
      { instanceId: "account-2", accountCorrelationId: "opaque-2", identity: "two@example.com", displayLabel: "Work", expired: false, source: "oauth" as const },
    ].slice(0, count) })
    await createRoot(async (dispose) => {
      const { modal, modals, runtime, showToast } = createModal()
      const pending = Promise.withResolvers<{ ok: true }>()
      runtime["auth.account.rename"].mockImplementationOnce(() => pending.promise)
      modal.openAuthModal()
      if (count === 1) {
        modal.selectProvider(rowIndexOf(modal, "chatgpt"))
        await flush()
        modals.input({ name: "n" })
      } else {
        while (modal.authRows()[modal.authModalCursor()]?.kind !== "account") modals.input({ name: "down" })
        modals.input({ name: "r" })
      }
      modals.paste("New")
      modals.input({ name: "return" })
      expect(modal.authView()).toMatchObject({ kind: "rename-input", saving: true })
      modals.input({ name: "tab" })
      expect(modal.authRows().find((row) => count === 1 ? row.kind === "provider" && row.option.id === "chatgpt" : row.kind === "account" && row.account.instanceId === "account-1")).toMatchObject({ saving: true })
      pending.resolve({ ok: true })
      await flush()
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })
})
