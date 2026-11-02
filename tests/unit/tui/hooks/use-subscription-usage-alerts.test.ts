import { describe, expect, test } from "bun:test"

describe("subscription usage alert presentation cutover", () => {
  test("the shell has no direct subscription usage alert intake or presenter", async () => {
    const [shell, shellState, presence] = await Promise.all([
      Bun.file("src/tui/shell.tsx").text(),
      Bun.file("src/tui/hooks/shell-state.ts").text(),
      Bun.file("src/tui/modules/project-notifications/presence.ts").text(),
    ])

    expect(shell).not.toContain("useSubscriptionUsageAlerts")
    expect(shellState).not.toContain("createSubscriptionUsageAlertCache")
    expect(shellState).not.toContain("subscriptionUsageAlert")
    // Alerts reach the person as project notifications, presented by that module's terminal home.
    expect(shell).not.toContain("Notification")
    expect(presence).toContain("presentProjectNotifications")
  })
})
