import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import type { ProjectNotificationEpisode } from "../../../../../src/protocol/modules/project-notifications.js"
import { createToastState, type ToastInput } from "../../../../../src/tui/context/toast.js"
import { presentProjectNotifications } from "../../../../../src/tui/modules/project-notifications/presence.js"

const episode = (id: string, severity: "warning" | "alert" = "warning"): ProjectNotificationEpisode => ({
  id,
  sourceId: `source-${id}`,
  title: `Title ${id}`,
  message: `Message ${id}`,
  severity,
  action: { kind: "open-settings" },
  createdAt: 100,
  expiresAt: Number.MAX_SAFE_INTEGER,
})

/** The presence hook over one signal of the domain view, the way the slot host runs it. Without `showToast`, it
 *  shows toasts in a toast state of the same owner, which `dispose` ends with its timer. */
function present(initial: readonly ProjectNotificationEpisode[] | undefined, showToast?: (toast: ToastInput) => void) {
  const [view, setView] = createSignal<readonly ProjectNotificationEpisode[] | undefined>(initial)
  return createRoot((dispose) => {
    const toast = createToastState()
    presentProjectNotifications({ read: moduleDomainReader((domain) => (domain.domain === "project_notifications" ? view() : undefined)), showToast: showToast ?? toast.show })
    return { setView, dispose, toast }
  })
}

describe("presentProjectNotifications", () => {
  it("keeps the displayed summary in sync with the list", () => {
    const { setView, dispose, toast } = present([episode("a"), episode("b")])
    expect(toast.current?.message).toContain("2 project notifications")
    setView([episode("a")])
    expect(toast.current?.message).toContain("1 project notification")
    setView([])
    expect(toast.current).toBeNull()
    toast.show({ message: "Saved", variant: "success", duration: 0 })
    // An episode that arrives already dismissed is not announced over what is showing.
    setView([{ ...episode("a"), dismissedAt: 101 }])
    expect(toast.current?.message).toBe("Saved")
    dispose()
  })

  it("emits one startup summary once the view lands and then one toast per new episode", () => {
    const shown: Array<{ message: string; variant: string; duration?: number }> = []
    const showToast = (toast: ToastInput): void => {
      const value = typeof toast === "function" ? toast() : toast
      if (value) shown.push(value)
    }
    const { setView, dispose } = present(undefined, showToast)
    expect(shown).toEqual([])
    setView([episode("a"), episode("b")])
    expect(shown).toEqual([{ message: "2 project notifications available", variant: "info" }])
    setView([episode("replacement")])
    expect(shown).toHaveLength(2)
    expect(shown[1]?.message).toBe("Title replacement: Message replacement")
    setView([episode("alert", "alert"), episode("replacement")])
    expect(shown[2]).toEqual({ message: "Title alert: Message alert", variant: "error", duration: 7000 })
    dispose()
  })

  it("marks startup complete after an empty view and never summarizes later views", () => {
    const shown: ToastInput[] = []
    const { setView, dispose } = present([], (toast) => { shown.push(toast) })
    expect(shown).toEqual([])
    setView([episode("later")])
    expect(shown).toHaveLength(1)
    expect(typeof shown[0] === "function" ? shown[0]()?.message : undefined).toBe("Title later: Message later")
    dispose()
  })

  it("retains resolved live notifications and clears their toast on dismissal or expiry", () => {
    const { setView, dispose, toast } = present([])
    const row = episode("a", "alert")
    setView([row])
    expect(toast.current).toEqual({ message: "Title a: Message a", variant: "error" })
    setView([{ ...row, resolvedAt: 101 }])
    expect(toast.current).toEqual({ message: "Resolved: Title a: Message a", variant: "info" })
    setView([{ ...row, resolvedAt: 101, dismissedAt: 102 }])
    expect(toast.current).toBeNull()
    dispose()
  })
})
