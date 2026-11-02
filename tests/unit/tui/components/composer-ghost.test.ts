import { expect, it } from "bun:test"
import { createTextAttributes } from "@opentui/core"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { createDraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import { mountPrompt } from "./prompt-area-fixture.js"

it("renders ghost completion with readable muted color and no terminal dim", async () => {
  const draftCache = createDraftCache()
  draftCache.set("chat-1", { text: "please /set", pastes: [], attachments: [] })
  const result = await mountPrompt({
    draftCache,
    foregroundId: () => "chat-1",
    slashCatalog: () => [{ id: "settings", value: "/settings", title: "Settings", footer: "/settings" }],
  })
  try {
    await result.renderOnce()
    const ghost = result.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("tings"))
    expect(ghost).toBeDefined()
    if (!ghost) throw new Error("Ghost completion was not rendered")
    expect(ghost.attributes & createTextAttributes({ dim: true })).toBe(0)
    expect(ghost.fg).toEqual(resolveTheme(flywheelTheme, "dark").textMuted)
  } finally {
    result.renderer.destroy()
  }
})
