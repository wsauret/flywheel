import { describe, expect, it } from "bun:test"
import { bypassesLazyTuiViewRegistry } from "../../../scripts/lazy-tui-view-boundary.js"

describe("lazy TUI view boundary", () => {
  const registeredTargets = new Set(["src/tui/modals/example-modal.tsx"])
  it("rejects a direct deferred TUI view import", () => {
    expect(bypassesLazyTuiViewRegistry({
      sourcePath: "src/tui/hooks/example.ts",
      targetPath: "src/tui/modals/example-modal.tsx",
      dynamic: true,
    }, registeredTargets)).toBe(true)
  })

  it("rejects an eager import of a deferred TUI view", () => {
    expect(bypassesLazyTuiViewRegistry({
      sourcePath: "src/tui/hooks/example.ts",
      targetPath: "src/tui/modals/example-modal.tsx",
      dynamic: false,
    }, registeredTargets)).toBe(true)
  })

  it("rejects a new deferred TUI view outside the registry", () => {
    expect(bypassesLazyTuiViewRegistry({
      sourcePath: "src/tui/hooks/example.ts",
      targetPath: "src/tui/components/unregistered.tsx",
      dynamic: true,
    }, registeredTargets)).toBe(true)
  })

  it("allows the lazy registry and non-view deferred imports", () => {
    expect(bypassesLazyTuiViewRegistry({
      sourcePath: "src/tui/modals/lazy-modal-registry.ts",
      targetPath: "src/tui/modals/example-modal.tsx",
      dynamic: true,
    }, registeredTargets)).toBe(false)
    expect(bypassesLazyTuiViewRegistry({
      sourcePath: "src/tui/launcher.ts",
      targetPath: "src/tui/app.tsx",
      dynamic: true,
    }, registeredTargets)).toBe(false)
    expect(bypassesLazyTuiViewRegistry({
      sourcePath: "src/tui/hooks/example.ts",
      targetPath: "src/tui/components/unregistered.tsx",
      dynamic: false,
    }, registeredTargets)).toBe(false)
  })
})
