import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { clearMocks, configValues, COPILOT_CAP, createModal, profileConfig } from "./_settings-modal-fixtures.js"

describe("createSettingsStore", () => {
  it.each(["idleCompaction", "shellWriteGuard"] as const)("turns %s off through the generated Settings presentation", async (id) => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { settings, configDispatch } = createModal()
      expect(settings.presentation.read(id)).toBe(true)
      expect(await settings.presentation.update(id, false)).toEqual({ ok: true })
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id, expected: { kind: "value", value: true }, desired: false } })
      expect(settings.presentation.read(id)).toBe(false)
      dispose()
    })
  })
  it("keeps the store untouched when the config write fails", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { settings, configDispatch } = createModal()
      configDispatch.mockResolvedValueOnce({ kind: "write-not-applied", message: "The configuration could not be saved." })

      const result = await settings.update("showThinking", false)

      expect(result).toEqual({ ok: false, error: new Error("The configuration could not be saved.") })
      expect(settings.values.showThinking).toBe(true)
      dispose()
    })
  })

  it("dispatches profile cap mutations and updates only from publication", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { settings, configDispatch } = createModal()

      await settings.update("diffColors", "standard")
      await settings.updateProfileProviderSetting("default", COPILOT_CAP, 4_100)
      await settings.updateProfileProviderSetting("default", COPILOT_CAP, 0)

      expect(configDispatch).toHaveBeenNthCalledWith(2, { type: "config.mutate", target: { kind: "profile", profileId: "default" }, setting: { id: "provider", providerId: "github_copilot", key: "monthly_credit_cap", expected: { kind: "value", value: 3900 }, desired: 4100 } })
      expect(configDispatch).toHaveBeenNthCalledWith(3, { type: "config.mutate", target: { kind: "profile", profileId: "default" }, setting: { id: "provider", providerId: "github_copilot", key: "monthly_credit_cap", expected: { kind: "value", value: 4100 }, desired: 0 } })
      expect(settings.profileProviderSetting("default", COPILOT_CAP)).toBe(0)
      dispose()
    })
  })

  it("switches and resets the Write syntax theme through typed config mutations", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { settings, configDispatch } = createModal()

      expect(settings.values.writeSyntaxTheme).toBe("nord")
      expect(await settings.update("writeSyntaxTheme", "vesper")).toEqual({ ok: true })
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "writeSyntaxTheme", expected: { kind: "value", value: "nord" }, desired: "vesper" } })
      expect(settings.values.writeSyntaxTheme).toBe("vesper")
      expect(await settings.update("writeSyntaxTheme", "nord")).toEqual({ ok: true })
      expect(settings.values.writeSyntaxTheme).toBe("nord")
      dispose()
    })
  })

  it("waits for matching publication before allowing a following mutation", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { settings, configDispatch, publishConfig } = createModal()
      configDispatch.mockResolvedValueOnce({ kind: "committed", revision: 2 })
      const first = settings.update("showThinking", false)
      await Promise.resolve()
      expect(configDispatch).toHaveBeenCalledTimes(1)
      expect(configDispatch).toHaveBeenCalledWith({ type: "config.mutate", setting: { id: "showThinking", expected: { kind: "value", value: true }, desired: false } })
      expect(settings.values.showThinking).toBe(true)
      publishConfig({ revision: 2, values: configValues({ showThinking: false }), status: { kind: "valid" }, warnings: [], diagnostics: [] })
      await first
      await settings.update("diffColors", "standard")
      expect(configDispatch).toHaveBeenCalledTimes(2)
      expect(configDispatch).toHaveBeenLastCalledWith({ type: "config.mutate", setting: { id: "diffColors", expected: { kind: "value", value: "theme" }, desired: "standard" } })
      dispose()
    })
  })

  it("targets active-profile boolean writes and waits for profile publication", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { settings, configDispatch, publishConfig } = createModal()
      publishConfig({ revision: 2, values: configValues({ profiles: { work: profileConfig() } }), status: { kind: "valid" }, warnings: [], diagnostics: [] })
      configDispatch.mockResolvedValueOnce({ kind: "committed", revision: 3 })

      const update = settings.updateProfileBoolean("work", "gitAiAttribution", true)
      await Promise.resolve()

      expect(configDispatch).toHaveBeenCalledWith({ type: "config.mutate", target: { kind: "profile", profileId: "work" }, setting: { id: "gitAiAttribution", expected: { kind: "value", value: false }, desired: true } })
      expect(settings.profileBoolean("work", "gitAiAttribution")).toBe(false)
      publishConfig({ revision: 3, values: configValues({ profiles: { work: profileConfig(3_900, true) } }), status: { kind: "valid" }, warnings: [], diagnostics: [] })
      expect(await update).toEqual({ ok: true })
      expect(settings.profileBoolean("work", "gitAiAttribution")).toBe(true)
      dispose()
    })
  })
  it("writes Show build to the connected project scope and reads the resolved value", async () => {
    clearMocks()
    await createRoot(async (dispose) => {
      const { settings, configDispatch, publishConfig } = createModal()
      publishConfig({ revision: 2, values: configValues({ showBuild: false }), status: { kind: "valid" }, warnings: [], diagnostics: [] })
      const committed = Promise.withResolvers<{ kind: "committed"; revision: number }>()
      configDispatch.mockImplementationOnce(() => committed.promise)

      const update = settings.updateShowBuild(true)
      await Promise.resolve()

      expect(configDispatch).toHaveBeenCalledWith({ type: "config.mutate", target: { kind: "project" }, setting: { id: "showBuild", expected: { kind: "value", value: false }, desired: true } })
      expect(settings.showBuild()).toBe(false)
      publishConfig({ revision: 3, values: configValues({ showBuild: true }), status: { kind: "valid" }, warnings: [], diagnostics: [] })
      committed.resolve({ kind: "committed", revision: 3 })
      expect(await update).toEqual({ ok: true })
      expect(settings.showBuild()).toBe(true)
      dispose()
    })
  })

})
