import { describe, expect, it, mock } from "bun:test"
import { Schema } from "effect"
import { createRoot, createSignal } from "solid-js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { projectNotificationsDomain, RuntimeProjectNotificationSnapshotResultSchema, type ProjectNotificationEpisode } from "../../../../../src/protocol/modules/project-notifications.js"
import { createModalScrollController } from "../../../../../src/tui/components/modal-scroll-controller.js"
import { projectNotificationsTui } from "../../../../../src/tui/modules/project-notifications/index.js"
import { notificationCursor, resetNotificationCursor } from "../../../../../src/tui/modules/project-notifications/list.js"
import type { TuiSurfaceHost } from "../../../../../src/tui/tui-module.js"
import type { FrontendMutation } from "../../../../../src/protocol/app-service-types.js"
import { runtimeDispatch } from "../../../../helpers/runtime-dispatch.js"

const [surface] = projectNotificationsTui.surfaces

const episode = (id: string, action: ProjectNotificationEpisode["action"] = { kind: "open-auth" }): ProjectNotificationEpisode => ({
  id,
  sourceId: `source-${id}`,
  title: `Title ${id}`,
  message: `Message ${id}`,
  severity: "warning",
  action,
  createdAt: 10,
  expiresAt: Number.MAX_SAFE_INTEGER,
})

/** The host the slot host lends the surface: a reader over one signal of rows and the kernel destinations. */
function createHost(initial = [episode("one"), episode("two", { kind: "open-usage" })]) {
  resetNotificationCursor()
  const [rows, setRows] = createSignal<readonly ProjectNotificationEpisode[]>(initial)
  const dispatch = mock(async (_command: FrontendMutation) => ({ ok: true as const }))
  const openSettings = mock(async () => {})
  const openSurface = mock(() => {})
  const close = mock(() => {})
  const host = createRoot(() => ({
    read: moduleDomainReader((domain) => (domain.domain === "project_notifications" ? rows() : undefined)),
    client: { dispatch: runtimeDispatch({ "project_notifications.dismiss": dispatch }) },
    navigate: { openSettings, openSurface, navigateSession: () => {} },
    showToast: () => {},
    scroll: createModalScrollController(),
    close,
  } satisfies TuiSurfaceHost))
  const press = (name: string): boolean => surface.onKey(({ name }), host)
  return { host, press, dispatch, openSettings, openSurface, close, setRows }
}

describe("the notifications surface", () => {
  it("moves the cursor over the live rows and clamps it when rows leave", () => {
    const { host, press, setRows, dispatch, openSurface } = createHost()
    expect(press("down")).toBe(true)
    expect(notificationCursor(host.read)).toBe(1)
    const raised = projectNotificationsDomain.view.patch({ kind: "project_notifications.raised", episode: episode("new") }, [episode("one"), episode("two", { kind: "open-usage" })])
    if (raised === null) throw new Error("A raised episode must produce a notification view")
    setRows(raised)
    expect(notificationCursor(host.read)).toBe(2)
    press("return")
    expect(openSurface).toHaveBeenCalledWith("usage")
    press("d")
    expect(dispatch).toHaveBeenCalledWith({ type: "project_notifications.dismiss", sourceId: "source-two", episodeId: "two" })
    setRows([episode("one")])
    expect(notificationCursor(host.read)).toBe(0)
    setRows([])
    expect(notificationCursor(host.read)).toBe(0)
  })

  it("opens the selected typed primary action and leaves the escape key to the host", () => {
    const { press, openSurface, close } = createHost()
    press("down")
    expect(press("return")).toBe(true)
    expect(openSurface).toHaveBeenCalledTimes(1)
    expect(press("escape")).toBe(false)
    expect(close).not.toHaveBeenCalled()
    const { action: _action, ...actionless } = episode("notice")
    const notice = createHost([actionless])
    expect(notice.press("return")).toBe(true)
    expect(notice.openSurface).not.toHaveBeenCalled()
    expect(notice.openSettings).not.toHaveBeenCalled()
  })

  it("routes a targeted review to the exact Auth account", () => {
    const action = { kind: "open-auth", providerId: "chatgpt", accountCorrelationId: "account-1", envelopeId: "envelope-1" } as const
    const { press, openSettings } = createHost([episode("spend", action)])
    press("return")
    expect(openSettings).toHaveBeenCalledWith({ kind: "auth-account", providerId: "chatgpt", accountCorrelationId: "account-1", envelopeId: "envelope-1" })
  })

  it("routes a provider-only auth action to the provider", () => {
    const { press, openSettings } = createHost([episode("provider", { kind: "open-auth-provider", providerId: "chatgpt" })])
    press("return")
    expect(openSettings).toHaveBeenCalledWith({ kind: "auth-provider", providerId: "chatgpt" })
  })

  it("rejects fields outside the closed provider-only protocol action", () => {
    const decode = Schema.decodeUnknownSync(RuntimeProjectNotificationSnapshotResultSchema, { onExcessProperty: "error" })
    for (const field of ["credentials", "accountSubject", "path", "command", "extra"]) {
      expect(() => decode({
        snapshotPosition: 1,
        notifications: [episode("provider", { kind: "open-auth-provider", providerId: "chatgpt", [field]: "forbidden" })],
      })).toThrow()
    }
  })

  it("dismisses only through the explicit dismiss key, as the module's own mutation", async () => {
    const { press, dispatch } = createHost()
    expect(press("d")).toBe(true)
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledWith({ type: "project_notifications.dismiss", sourceId: "source-one", episodeId: "one" })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("dismisses and opens nothing when no row is visible", () => {
    const { press, dispatch, openSettings } = createHost([])
    expect(press("d")).toBe(true)
    expect(press("return")).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(openSettings).not.toHaveBeenCalled()
  })
})
