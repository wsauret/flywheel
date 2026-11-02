/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import type { ProjectNotificationEpisode } from "../../../../../src/protocol/modules/project-notifications.js"
import { createModalScrollController } from "../../../../../src/tui/components/modal-scroll-controller.js"
import { projectNotificationsTui } from "../../../../../src/tui/modules/project-notifications/index.js"
import { notificationCursor, resetNotificationCursor, selectNotificationRow } from "../../../../../src/tui/modules/project-notifications/list.js"

const [{ testRender }, { createComponent }, { ThemeProvider }, { NotificationsModal }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("../../../../../src/tui/context/theme.js"),
  import("../../../../../src/tui/modules/project-notifications/modal.js"),
])

const [surface] = projectNotificationsTui.surfaces
const row: ProjectNotificationEpisode = {
  id: "episode-1",
  sourceId: "provider:anthropic",
  title: "Authentication required",
  message: "Reconnect Anthropic to continue.",
  severity: "alert",
  action: { kind: "open-auth" },
  createdAt: 10,
  expiresAt: Number.MAX_SAFE_INTEGER,
}
const rows = [row]

async function frame(notifications: readonly ProjectNotificationEpisode[] | undefined, cursor = 0): Promise<string> {
  const read = moduleDomainReader((domain) => (domain.domain === "project_notifications" ? notifications : undefined))
  resetNotificationCursor()
  notificationCursor(read)
  selectNotificationRow(cursor)
  const result = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() {
      return createComponent(NotificationsModal, {
        sessionId: "chat-1",
        read,
        client: { dispatch: async () => { throw new Error("no mutation is sent") } },
        navigate: { openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} },
        showToast: () => {},
        scroll: createModalScrollController(),
        width: surface.width,
        controls: surface.controls,
        onClose: () => {},
      })
    },
  }), { width: 100, height: 30 })
  try {
    await result.renderOnce()
    return result.captureCharFrame()
  } finally {
    result.renderer.destroy()
  }
}

describe("NotificationsModal", () => {
  it("holds the first visible card and its offset through a variable-height prepend, then reveals explicit selection", async () => {
    resetNotificationCursor()
    const [notifications, setNotifications] = createSignal(Array.from({ length: 15 }, (_, index) => ({ ...row, id: `notice-${index}`, title: `Notice ${index}` })))
    const read = moduleDomainReader((domain) => domain.domain === "project_notifications" ? notifications() : undefined)
    const rendered = await testRender(() => <ThemeProvider mode="dark"><NotificationsModal
      sessionId="chat-1" read={read} client={{ dispatch: async () => { throw new Error("no action") } }}
      navigate={{ openSettings: async () => {}, openSurface: () => {}, navigateSession: () => {} }}
      showToast={() => {}} scroll={createModalScrollController()} width={surface.width} controls={surface.controls} onClose={() => {}} />
    </ThemeProvider>, { width: 80, height: 24 })
    const visible = () => rendered.captureCharFrame().split("\n").flatMap((text, y) => /Notice \d/.test(text) ? [{ text, y }] : [])[0]
    try {
      await rendered.flush()
      for (let index = 0; index < 10; index++) { await rendered.mockMouse.scroll(10, 10, "down"); await rendered.flush() }
      const anchor = visible()
      expect(anchor).toBeDefined()
      expect(rendered.captureCharFrame()).not.toContain("Notice 0 ")
      setNotifications((held) => [{ ...row, id: "new-notice", message: "New long message ".repeat(30) }, ...held.map((episode) => ({ ...episode }))])
      await rendered.flush()
      expect(visible()).toEqual(anchor)
      expect(notificationCursor(read)).toBe(1)
      selectNotificationRow(1)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("Notice 0")
    } finally { rendered.renderer.destroy() }
  })
  it("renders curated content and separate primary and dismiss actions", async () => {
    const rendered = await frame(rows)
    expect(rendered).toContain("Notifications")
    expect(rendered).toContain("ALERT")
    expect(rendered).toContain("Authentication required")
    expect(rendered).toContain("Reconnect Anthropic to continue.")
    expect(rendered).toContain("Open Auth")
    expect(rendered).toContain("Dismiss")
    const { action: _action, ...actionless } = row
    const notice = await frame([actionless])
    expect(notice).toContain("Reconnect Anthropic to continue.")
    expect(notice).toContain("Dismiss")
    expect(notice).not.toContain("Open Auth")
  })

  it("labels provider-only authentication actions", async () => {
    const rendered = await frame([{ ...row, action: { kind: "open-auth-provider", providerId: "anthropic_api" } }])
    expect(rendered).toContain("Open Auth")
    expect(rendered).not.toContain("Open Authentication")
  })

  it("keeps wrapped cards and following actions inside the list", async () => {
    const rendered = await frame([
      { ...row, message: "This warning has enough curated detail to wrap across several terminal lines without hiding the action that follows it. The full message remains readable even when another notification follows and the lower card is selected." },
      { ...row, id: "episode-2", sourceId: "provider:chatgpt", title: "Second notification", message: "Reconnect ChatGPT to continue." },
    ], 1)
    const lines = rendered.split("\n")
    const firstAction = lines.findIndex((line) => line.includes("Open Auth"))
    const secondTitle = lines.findIndex((line) => line.includes("Second notification"))
    const secondAction = lines.findIndex((line, index) => index > firstAction && line.includes("Open Auth"))
    const footer = lines.findIndex((line) => line.includes("enter open"))
    expect(firstAction).toBeGreaterThanOrEqual(0)
    expect(secondTitle).toBeGreaterThan(firstAction)
    expect(secondAction).toBeGreaterThan(secondTitle)
    expect(footer - secondAction).toBeLessThanOrEqual(3)
  })

  it("shows when each notification was raised, as a date and 24-hour time", async () => {
    const raisedAt = new Date(2026, 8, 6, 17, 21).getTime()
    const rendered = await frame([{ ...row, createdAt: raisedAt }])
    expect(rendered).toContain("Sep 6, 17:21")
  })

  it("hides dismissed and expired episodes", async () => {
    const loading = await frame(undefined)
    expect(loading).toContain("Loading notifications...")
    expect(loading).not.toContain("No notifications")
    const rendered = await frame([{ ...row, dismissedAt: 20 }, { ...row, id: "episode-2", expiresAt: 1 }])
    expect(rendered).toContain("No notifications")
  })

  it("labels retained recovered notifications as resolved", async () => {
    const rendered = await frame([{ ...row, resolvedAt: 20 }])
    expect(rendered).toContain("RESOLVED")
    expect(rendered).not.toContain("ALERT")
    expect(rendered).toContain("Authentication required")
    expect(rendered).toContain("Dismiss")
  })
})
