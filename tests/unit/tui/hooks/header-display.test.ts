import { describe, it, expect, afterEach } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createHeaderDisplay as buildHeaderDisplay } from "../../../../src/tui/hooks/create-header-display.js"
import type { SessionCatalogRow, ChildSessionRow } from "../../../../src/protocol/app-service-types.js"
import type { BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { RGBA } from "@opentui/core"
import { displayWidth } from "../../../../src/tui/utils/text.js"

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

function createHeaderDisplay(deps: Omit<Parameters<typeof buildHeaderDisplay>[0], "compactionThreshold">) {
  return buildHeaderDisplay({ ...deps, compactionThreshold: () => 270_000 })
}

function textOf(chunks: ReadonlyArray<{ text: string }>): string {
  return chunks.map(c => c.text).join("")
}

function headerText(header: ReturnType<typeof buildHeaderDisplay>): string {
  return textOf(header.headerStats().content.chunks).trim()
}

function sameColor(a: RGBA, b: RGBA): boolean {
  return Math.round(a.r * 255) === Math.round(b.r * 255)
    && Math.round(a.g * 255) === Math.round(b.g * 255)
    && Math.round(a.b * 255) === Math.round(b.b * 255)
}

function buildSignals(overrides: {
  title?: string
  sessionState?: "active" | "inactive" | null
  elapsedMs?: number
  elapsed?: () => number
  contextPercent?: number
  contextPromptTokens?: number
  cost?: number
  billedCost?: number
  priceUnavailable?: boolean
  liveBudget?: boolean
  totalsLoading?: boolean
  summary?: SessionCatalogRow | ChildSessionRow
} = {}) {
  const [sessionTitle] = createSignal(overrides.title ?? "")
  const [sessionState] = createSignal<"active" | "inactive" | null>(overrides.sessionState ?? "active")
  const [errorMessage] = createSignal("")
  const [foregroundId] = createSignal("session-1")
  const elapsed = overrides.elapsed ?? (() => overrides.elapsedMs ?? 0)
  const budgetView = () => overrides.liveBudget === false ? undefined : overrides.totalsLoading ? {
    totalsLoading: true as const,
  } : ({
    totalsLoading: false as const,
    contextPercent: overrides.contextPercent ?? 0,
    cost: overrides.cost ?? 0,
    billedCost: overrides.billedCost ?? 0,
    priceUnavailable: overrides.priceUnavailable ?? false,
    tokens: 0,
    contextPromptTokens: overrides.contextPromptTokens ?? (overrides.contextPercent ?? 0) * 2700,
  })
  const foregroundSummary = () => overrides.summary ?? null
  return {
    sessionTitle, activeSubagentCount: () => 0, sessionState, errorMessage,
    foregroundId, foregroundSummary, elapsed, budgetView, outputView: () => undefined,
  }
}

describe("header display", () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it("shows progress to compaction rather than the model window", () => {
    createRoot((d) => {
      dispose = d
      const header = createHeaderDisplay({
        signals: buildSignals({ contextPercent: 38, contextPromptTokens: 270_000 }),
        dimensions: () => ({ width: 120, height: 24 }),
        theme,
      })
      expect(headerText(header)).toBe("100% ctx")
    })
  })

  it("updates to thousands of tokens when automatic compaction is disabled", () => {
    createRoot((d) => {
      dispose = d
      const [threshold, setThreshold] = createSignal(350_000)
      const header = buildHeaderDisplay({
        signals: buildSignals({ contextPercent: 95, contextPromptTokens: 256_700 }),
        dimensions: () => ({ width: 120, height: 24 }),
        compactionThreshold: threshold,
        theme,
      })
      expect(headerText(header)).toBe("73% ctx")
      setThreshold(0)
      expect(headerText(header)).toBe("256.7k ctx")
      expect(sameColor(header.headerStats().context!.color, theme.text)).toBe(true)
      expect(header.contextCopy()?.detail).toBe("256,700 tokens in context; auto-compact is off.")
    })
  })

  it.each([[1100, "1.1k ctx"], [30400, "30.4k ctx"], [0, "0.0k ctx"]])("formats %d tokens with compaction off", (tokens, label) => {
    createRoot((d) => {
      dispose = d
      const header = buildHeaderDisplay({
        signals: buildSignals({ contextPromptTokens: tokens }),
        dimensions: () => ({ width: 120, height: 24 }),
        compactionThreshold: () => 0,
        theme,
      })
      expect(headerText(header)).toBe(label)
    })
  })

  it("omits zero elapsed in an empty chat while keeping zero context", () => {
    createRoot((d) => {
      dispose = d
      const [dims] = createSignal({ width: 120, height: 24 })

      const header = createHeaderDisplay({
        signals: buildSignals({ elapsedMs: 0, contextPercent: 0, cost: 0 }),
        dimensions: dims,
        theme,
      })

      const full = headerText(header)
      expect(full).toBe("0% ctx")
      expect(full).not.toContain("0s")
      expect(full).not.toContain("$")
    })
  })

  it.each([24, 70, 85, 100])("keeps right-side stats neutral at %i%% context usage", (contextPercent) => {
    for (const sessionState of ["active", "inactive"] as const) {
      createRoot((disposeRoot) => {
        const header = createHeaderDisplay({
          signals: buildSignals({ elapsedMs: 60_000, contextPercent, cost: 0.0345, sessionState }),
          dimensions: () => ({ width: 120, height: 24 }),
          theme,
        })
        try {
          for (const chunk of header.headerStats().content.chunks) {
            expect(sameColor(chunk.fg!, theme.text)).toBe(true)
          }
        } finally {
          disposeRoot()
        }
      })
    }
  })

  it("shows cost when it exceeds zero and width is wide enough", () => {
    createRoot((d) => {
      dispose = d
      const [dims] = createSignal({ width: 120, height: 24 })

      const header = createHeaderDisplay({
        signals: buildSignals({ elapsedMs: 60_000, contextPercent: 24, cost: 0.0098 }),
        dimensions: dims,
        theme,
      })

      const full = headerText(header)
      expect(full).toContain("$0.01")
      expect(full).not.toContain("$0.0098")
      expect(full).toContain("1m 0s")
      expect(full).toContain("24% ctx")
    })
  })

  it("keeps one measured presentation across live statistics updates", () => {
    createRoot((d) => {
      dispose = d
      const [budget, setBudget] = createSignal<Extract<BudgetView, { totalsLoading: false }>>({
        totalsLoading: false as const,
        tokens: 100,
        cost: 0,
        billedCost: 0,
        priceUnavailable: false,
        contextPercent: 24,
        contextPromptTokens: 64_800,
        averageGenerationTokensPerSecond: undefined,
      })
      const signals = buildSignals({ liveBudget: false, elapsedMs: 60_000 })
      const header = createHeaderDisplay({
        signals: { ...signals, budgetView: () => budget() },
        dimensions: () => ({ width: 120, height: 24 }),
        theme,
      })

      const initial = header.headerStats()
      expect(headerText(header)).toBe("1m 0s · 24% ctx")
      expect(initial.width).toBe(displayWidth(textOf(initial.content.chunks)))
      expect(initial.context?.left).toBe(displayWidth("1m 0s ·"))

      setBudget({ ...budget(), cost: 1, billedCost: 1, averageGenerationTokensPerSecond: 18.24 })
      const withCost = header.headerStats()
      expect(headerText(header)).toBe("1m 0s · 24% ctx · $1.00 · 18 tok/s")
      expect(withCost.width).toBeGreaterThan(initial.width)
      expect(withCost.context?.left).toBe(initial.context?.left)

      setBudget({ ...budget(), tokens: 101, averageGenerationTokensPerSecond: 22.26 })
      expect(headerText(header)).toBe("1m 0s · 24% ctx · $1.00 · 22 tok/s")
      expect(header.headerStats().width).toBe(withCost.width)
      expect(header.headerStats().context?.left).toBe(withCost.context?.left)
      for (const [rate, text, widthChange] of [[8.6, "9", -1], [89.1, "89", 0], [99.6, "100", 1], [999, "999", 1]] as const) {
        setBudget({ ...budget(), averageGenerationTokensPerSecond: rate })
        expect(headerText(header)).toBe(`1m 0s · 24% ctx · $1.00 · ${text} tok/s`)
        expect(header.headerStats().width).toBe(withCost.width + widthChange)
      }
    })
  })

  it("keeps the selected agent's neutral average while totals load at the wide tier", () => {
    createRoot((d) => {
      dispose = d
      const ready = { totalsLoading: false as const, tokens: 100, cost: 1, billedCost: 1, priceUnavailable: false, contextPercent: 24, contextPromptTokens: 64_800, averageGenerationTokensPerSecond: 18.24 }
      const [selected, setSelected] = createSignal("parent")
      const [loading, setLoading] = createSignal(false)
      const [width, setWidth] = createSignal(80)
      const header = createHeaderDisplay({
        signals: { ...buildSignals(), foregroundId: selected,
          budgetView: (id: string) => id === "parent" ? ready : { ...ready, averageGenerationTokensPerSecond: undefined },
          foregroundSummary: () => loading() ? { id: selected(), kind: "chat", title: "Existing chat", executionCwd: "/repo", lifecycleState: "active", notices: [], inputMode: { kind: "chat" }, lastUpdated: "", totalsLoading: true } : null },
        dimensions: () => ({ width: width(), height: 24 }), theme,
      })
      expect(headerText(header)).toBe("24% ctx · $1.00 · 18 tok/s")
      const offset = header.headerStats().context?.left
      for (const chunk of header.headerStats().content.chunks) {
        expect(sameColor(chunk.fg!, theme.text)).toBe(true)
        expect(chunk.attributes ?? 0).toBe(0)
      }
      setWidth(79)
      expect(headerText(header)).toBe("24% ctx")
      expect(header.headerStats().context?.left).toBe(offset)
      setWidth(80)
      setLoading(true)
      expect(headerText(header)).toBe("… ctx · totals loading · 18 tok/s")
      setLoading(false)
      setSelected("child")
      expect(headerText(header)).not.toContain("tok/s")
    })
  })

  it("preserves elapsed and context slots while loading totals", () => {
    createRoot((d) => {
      dispose = d
      const [width, setWidth] = createSignal(80)
      const header = createHeaderDisplay({
        signals: buildSignals({
          sessionState: "inactive",
          totalsLoading: true,
          elapsedMs: 60_000,
          summary: {
            id: "session-1",
            kind: "chat",
            title: "Historical chat",
            executionCwd: "/project",
            lifecycleState: "inactive",
            notices: [],
            inputMode: { kind: "chat" },
            lastUpdated: "2026-09-05T06:58:52.057Z",
            totalsLoading: true,
          },
        }),
        dimensions: () => ({ width: width(), height: 24 }),
        theme,
      })

      const chunks = header.headerStats().content.chunks
      expect(textOf(chunks)).toBe("1m 0s · … ctx · totals loading")

      setWidth(79)
      expect(headerText(header)).toBe("1m 0s · totals loading")

      setWidth(59)
      expect(headerText(header)).toBe("1m 0s")
    })
  })

  it("restores ready statistics and their neutral color after whole-view replacement", () => {
    createRoot((d) => {
      dispose = d
      const [budget, setBudget] = createSignal<BudgetView>({ totalsLoading: true })
      const signals = buildSignals({ liveBudget: false })
      const header = createHeaderDisplay({
        signals: { ...signals, budgetView: () => budget() },
        dimensions: () => ({ width: 120, height: 24 }),
        theme,
      })

      expect(headerText(header)).toBe("… ctx · totals loading")
      setBudget({
        totalsLoading: false,
        tokens: 100,
        cost: 1,
        billedCost: 1,
        priceUnavailable: false,
        contextPercent: 24,
        contextPromptTokens: 64_800,
      })

      const chunks = header.headerStats().content.chunks
      expect(headerText(header)).toBe("24% ctx · $1.00")
      expect(chunks.every((chunk) => sameColor(chunk.fg!, theme.text))).toBe(true)
    })
  })

  it("keeps durable workflow member stats visible after live views are removed", () => {
    createRoot((d) => {
      dispose = d
      const [dims] = createSignal({ width: 120, height: 24 })

      const header = createHeaderDisplay({
        signals: buildSignals({
          sessionState: "inactive",
          liveBudget: false,
          summary: {
            id: "session-1",
            kind: "workflow-agent",
            workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt-1" },
            parentSessionId: "parent",
            title: "Blocked workflow",
            admittedActions: ["session.delete"],
            executionCwd: "/project",
            lifecycleState: "inactive",
            notices: [],
            inputMode: { kind: "message" },
            lastUpdated: "2026-09-05T06:58:52.057Z",
            totalsLoading: false,
            durationMs: 12_345_000,
            contextPercent: 64,
            contextPromptTokens: 172_800,
            totalCost: 9.65,
            totalBilledCost: 0,
            priceUnavailable: false,
            totalTokens: 949_000,
            diffStats: { added: 0, modified: 0, removed: 0 },
          },
        }),
        dimensions: dims,
        theme,
      })

      expect(headerText(header)).toBe("3h 25m 45s · 64% ctx · ~$9.65")
    })
  })

  it("prefers live elapsed time while the session is active", () => {
    createRoot((d) => {
      dispose = d
      const [dims] = createSignal({ width: 120, height: 24 })

      const header = createHeaderDisplay({
        signals: buildSignals({
          sessionState: "active",
          elapsedMs: 60_000,
          summary: {
            id: "session-1",
            kind: "workflow-agent",
            workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt-1" },
            parentSessionId: "parent",
            title: "Running workflow",
            admittedActions: ["chat.interrupt", "session.delete"],
            executionCwd: "/project",
            lifecycleState: "active",
            notices: [],
            inputMode: { kind: "message" },
            lastUpdated: "2026-09-05T06:58:52.057Z",
            totalsLoading: false,
            durationMs: 120_000,
            contextPercent: 0,
            contextPromptTokens: 0,
            totalCost: 0,
            totalBilledCost: 0,
            priceUnavailable: false,
            totalTokens: 0,
          },
        }),
        dimensions: dims,
        theme,
      })

      expect(headerText(header)).toContain("1m 0s")
      expect(headerText(header)).not.toContain("2m 0s")
    })
  })

  it("shows credit-backed real spend before subscription-covered estimated cost", () => {
    createRoot((d) => {
      dispose = d
      const [dims] = createSignal({ width: 120, height: 24 })
      const header = createHeaderDisplay({
        signals: buildSignals({ cost: 38.21875235, billedCost: 5.64677735, priceUnavailable: true }),
        dimensions: dims,
        theme,
      })

      expect(headerText(header)).toBe("0% ctx · $5.65 · ~$32.57 · price unavailable")
    })
  })

  it("drops ctx% when terminal is narrower than 60 columns", () => {
    createRoot((d) => {
      dispose = d
      const [dims] = createSignal({ width: 50, height: 24 })

      const header = createHeaderDisplay({
        signals: buildSignals({ elapsedMs: 60_000, contextPercent: 24 }),
        dimensions: dims,
        theme,
      })

      const full = headerText(header)
      expect(full).not.toContain("ctx")
      expect(full).toContain("1m 0s")
    })
  })

  it("rounds context percent in the header", () => {
    createRoot((d) => {
      dispose = d
      const [dims] = createSignal({ width: 120, height: 24 })

      const header = createHeaderDisplay({
        signals: buildSignals({ title: "Resumed workflow", elapsedMs: 60_000, contextPercent: 0.9949523809523809 }),
        dimensions: dims,
        theme,
      })

      const full = headerText(header)
      expect(full).toContain("1% ctx")
      expect(full).not.toContain("0.9949523809523809")
    })
  })

})
