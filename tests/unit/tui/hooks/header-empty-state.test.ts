import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { createRoot } from "solid-js"
import type { FrontendOutputBlock, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { createHeaderDisplay } from "../../../../src/tui/hooks/create-header-display.js"
import type { BudgetView } from "../../../../src/protocol/budget-protocol-types.js"

const summary: SessionCatalogRow = {
  id: "session-1",
  kind: "chat",
  title: "New Chat",
  executionCwd: "/project",
  lifecycleState: "active",
  notices: [],
  inputMode: { kind: "chat" },
  lastUpdated: "2026-09-22T21:00:00.000Z",
  totalsLoading: true,
}

const theme = {
  primary: RGBA.fromInts(100, 200, 255, 255),
  text: RGBA.fromInts(255, 255, 255, 255),
  textMuted: RGBA.fromInts(128, 128, 128, 255),
  textSubtle: RGBA.fromInts(100, 100, 100, 255),
  borderSubtle: RGBA.fromInts(60, 60, 60, 255),
  error: RGBA.fromInts(255, 80, 80, 255),
  warning: RGBA.fromInts(255, 200, 50, 255),
  success: RGBA.fromInts(80, 255, 80, 255),
}

const unused: BudgetView = { totalsLoading: false, tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0, averageGenerationTokensPerSecond: 18.24 }

function renderHeader(blocks: readonly FrontendOutputBlock[], budget: BudgetView = unused, row: SessionCatalogRow = summary): string {
  return createRoot((dispose) => {
    const header = createHeaderDisplay({
      signals: {
        budgetView: () => budget,
        elapsed: () => 0,
        foregroundId: () => summary.id,
        foregroundSummary: () => row,
        outputView: () => ({ blocks, streamingToolText: {} }),
        sessionState: () => "active",
      },
      dimensions: () => ({ width: 120, height: 24 }),
      compactionThreshold: () => 270_000,
      theme,
    })
    const text = header.headerStats().content.chunks.map((chunk) => chunk.text).join("").trim()
    dispose()
    return text
  })
}

test("empty new chat leaves header statistics blank", () => {
  expect(renderHeader([])).toBe("")
})

// A side question records usage without adding a transcript block.
test("new chat with recorded usage keeps its header statistics", () => {
  const { totalsLoading: _loading, ...metadata } = summary
  const ready: SessionCatalogRow = { ...metadata, totalsLoading: false, totalCost: 0.008698, totalBilledCost: 0, priceUnavailable: false, totalTokens: 4329, contextPercent: 0, contextPromptTokens: 0, durationMs: 0 }
  expect(renderHeader([], { ...unused, tokens: 4329, cost: 0.008698 }, ready)).toContain("~$0.01")
})
