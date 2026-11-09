/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
import type { AuthView } from "../../../../src/tui/hooks/auth-modal-options.js"
import type { ProviderModelRow } from "../../../../src/protocol/provider-model-preference-protocol-types.js"

const [{ testRender }, { createComponent }, { ThemeProvider }, { AuthModal }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("../../../../src/tui/context/theme.js"),
  import("../../../../src/tui/modals/auth-modal.js"),
])

const noOp = (): void => {}
const EMPTY_PRESENTATION = { value: "", cursor: 0, selection: null, preferredVisualColumn: null } as const

describe("AuthModal provider models", () => {
  it("keeps provider model renderables and scroll anchor when catalog rows change", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ modelId: `model-${i}`, checked: true, optInAvailable: true, configured: true }))
    const [view, setView] = createSignal<Extract<AuthView, { kind: "provider-models" }>>({
      kind: "provider-models", profileId: "default", target: { kind: "singleton", providerId: "openrouter" },
      providerTitle: "OpenRouter", rows, query: "model", loading: false, cursor: 12, originCursor: 0,
    })
    const selections: number[] = []
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() { return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, get view() { return view() }, rows: [], cursor: 0, inputPresentation: { ...EMPTY_PRESENTATION, value: "model" }, onSelect: noOp, onSelectModel: (index) => { selections.push(index) }, onClose: noOp }) },
    }), { width: 80, height: 24 })
    const nodes = (): Renderable[] => {
      const all: Renderable[] = [result.renderer.root]
      for (let i = 0; i < all.length; i++) all.push(...all[i]!.getChildren())
      return all
    }
    try {
      await result.renderOnce()
      const before = nodes().find((node) => node instanceof TextRenderable && node.plainText.includes("model-12"))
      const scroll = nodes().find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)!
      scroll.scrollTo(8)
      await result.renderOnce()
      const top = scroll.scrollTop
      setView((previous) => ({ ...previous, cursor: 13, rows: [{ ...rows[0]!, modelId: "new-model" }, ...rows.map((row) => ({ ...row }))] }))
      await result.renderOnce()
      expect(nodes().find((node) => node instanceof TextRenderable && node.plainText.includes("model-12")) === before).toBe(true)
      expect(scroll.scrollTop).toBe(top + 1)
      expect(result.captureCharFrame()).not.toContain("Loading models")
      const lines = result.captureCharFrame().split("\n")
      const line = lines.findIndex((value) => value.includes("model-12"))
      await result.mockMouse.click(lines[line]!.indexOf("model-12"), line)
      expect(selections).toEqual([13])
    } finally { result.renderer.destroy() }
  })
  it("keeps the checkbox and model visible before a long unavailable reason at width 40", async () => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-models", profileId: "default", eligibilityRevision: 7, target: { kind: "singleton", providerId: "openrouter" }, providerTitle: "OpenRouter", catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" }, rows: [{ modelId: "openai/gpt-6-luna", checked: false, optInAvailable: false, configured: true, unavailableReason: "This unavailable reason is intentionally much too long" }], preferenceAvailable: true, query: "", loading: false, cursor: 0, originCursor: 0 },
          rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 40, height: 14 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).not.toContain("Enable new models automatically")
      expect(frame).toContain(">     openai/gpt-6-luna")
      expect(frame).not.toContain(" · Unavailable")
      expect(frame).not.toContain("intentionally much too long")
    } finally {
      result.renderer.destroy()
    }
  })

  it("uses the full model row width and truncates only the variable reason at width 60", async () => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-models", profileId: "default", eligibilityRevision: 7, target: { kind: "singleton", providerId: "openrouter" }, providerTitle: "OpenRouter", catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" }, rows: [{ modelId: "openai/gpt-6-luna", checked: false, optInAvailable: false, configured: true, unavailableReason: "This unavailable reason is intentionally much too long" }], query: "", loading: false, cursor: 0, originCursor: 0 },
          rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 60, height: 14 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain(">     openai/gpt-6-luna · Unavailable · This un...")
      expect(frame).not.toContain("intentionally much too long")
    } finally {
      result.renderer.destroy()
    }
  })

  it("omits unavailable detail when no reason grapheme fits", async () => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-models", profileId: "default", eligibilityRevision: 7, target: { kind: "singleton", providerId: "openrouter" }, providerTitle: "OpenRouter", catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" }, rows: [{ modelId: "model-1", checked: false, optInAvailable: false, configured: true, unavailableReason: "Blocked" }], query: "", loading: false, cursor: 0, originCursor: 0 },
          rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 40, height: 14 })
    try {
      await result.renderOnce()
      const row = result.captureCharFrame().split("\n").find((line) => line.includes("model-1"))
      expect(row?.split("│")[1]?.trimEnd()).toEndWith("Unavailable")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders nested checkbox rows, selection, and footer conventions", async () => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-models", profileId: "default", eligibilityRevision: 7, target: { kind: "singleton", providerId: "openrouter" }, providerTitle: "OpenRouter API Key", catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" }, rows: [{ modelId: "openai/gpt-5", checked: true, optInAvailable: true, configured: true }, { modelId: "anthropic/claude-sonnet-4", checked: false, optInAvailable: true, configured: true, unavailableReason: "Allow training routes" }], preferenceAvailable: true, query: "", loading: false, cursor: 1, originCursor: 1 },
          rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Authentication › OpenRouter API Key models")
      expect(frame).toContain("[x] openai/gpt-5")
      expect(frame).toContain("> [ ] anthropic/claude-sonnet-4")
      expect(frame).toContain("· Unavailable · Allow training routes")
      expect(frame).not.toContain("· Free")
      expect(frame).not.toContain("alt+a auto new")
      expect(frame).toContain("type search · ctrl+d deselect all · space/enter toggle")
      expect(frame).toContain("↑↓ navigate · ← back · esc close")
    } finally {
      result.renderer.destroy()
    }
  })

  it("labels pending routes neutrally and offers Recheck access even with no rows", async () => {
    const render = async (rows: readonly ProviderModelRow[]) => {
      const result = await testRender(() => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
            view: { kind: "provider-models", profileId: "default", eligibilityRevision: 7, target: { kind: "singleton", providerId: "openrouter" }, providerTitle: "OpenRouter API Key", rows, recheckAvailable: true, audit: { remaining: rows.length, refused: rows.length === 0 ? 1 : 0 }, catalog: { kind: "unavailable", reason: rows.length === 0 ? "unusable" : "discovery-pending" }, notice: "Model access changed. The list was refreshed; review it and try again.", query: "", loading: false, cursor: 0, originCursor: 0 },
            rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
          })
        },
      }), { width: 80, height: 20 })
      await result.renderOnce()
      const frame = result.captureCharFrame()
      result.renderer.destroy()
      return frame
    }
    const pending = await render([{ modelId: "grok-4", checked: false, optInAvailable: true, configured: true, accessState: "pending" }])
    expect(pending).toContain("[ ] grok-4 · Access pending")
    expect(pending).toContain("1 access check pending")
    expect(pending).toContain("Recheck access")
    expect(pending).toContain("ctrl+r")
    expect(pending).toContain("Model access changed.")
    const refused = await render([])
    expect(refused).toContain("Recheck access")
    expect(refused).toContain("No models are currently available for this account.")
  })

  it("explains auth-invalid fallback inventory without actionable checkboxes", async () => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: {
            kind: "provider-models",
            profileId: "default",
            eligibilityRevision: 7,
            target: { kind: "subscription", providerId: "github_copilot", accountCorrelationId: "opaque" },
            providerTitle: "GitHub Copilot",
            catalog: { kind: "available", provenance: "models-dev-bundled", liveOutcome: "authentication-invalid" },
            rows: [{ modelId: "gpt-5", checked: true, optInAvailable: false, configured: true }],
            preferenceAvailable: false,
            query: "",
            loading: false,
            cursor: 0,
            originCursor: 1,
          },
          rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 52, height: 16 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Preferences can be saved. Reconnect before")
      expect(frame).toContain("sending requests.")
      expect(frame).toContain(">     gpt-5")
      expect(frame).not.toContain("[x] gpt-5")
      expect(frame).not.toContain("deselect all")
      expect(frame).not.toContain("toggle")
    } finally {
      result.renderer.destroy()
    }
  })
})
