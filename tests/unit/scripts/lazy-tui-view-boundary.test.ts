import { describe, expect, it } from "bun:test"
import { bypassesLazyTuiViewRegistry, isLazyTuiViewRegistryTarget } from "../../../scripts/lazy-tui-view-boundary.js"

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

  it("lets a module home defer its own views and nothing else reach them", () => {
    const home = "src/tui/modules/experiments/index.ts"
    const view = "src/tui/modules/experiments/dashboard-modal.tsx"
    expect(isLazyTuiViewRegistryTarget({ sourcePath: home, targetPath: view, dynamic: true })).toBe(true)
    expect(isLazyTuiViewRegistryTarget({ sourcePath: home, targetPath: view, dynamic: false })).toBe(false)
    expect(isLazyTuiViewRegistryTarget({ sourcePath: home, targetPath: "src/tui/modules/other/view.tsx", dynamic: true })).toBe(false)
    const registered = new Set([view])
    expect(bypassesLazyTuiViewRegistry({ sourcePath: home, targetPath: view, dynamic: true }, registered)).toBe(false)
    expect(bypassesLazyTuiViewRegistry({ sourcePath: home, targetPath: "src/tui/modules/experiments/strip.tsx", dynamic: false }, registered)).toBe(false)
    expect(bypassesLazyTuiViewRegistry({ sourcePath: "src/tui/modules.ts", targetPath: home, dynamic: false }, registered)).toBe(false)
    expect(bypassesLazyTuiViewRegistry({ sourcePath: "src/tui/shell.tsx", targetPath: view, dynamic: false }, registered)).toBe(true)
    expect(bypassesLazyTuiViewRegistry({ sourcePath: "src/tui/hooks/example.ts", targetPath: view, dynamic: true }, registered)).toBe(true)
    expect(bypassesLazyTuiViewRegistry({ sourcePath: "src/tui/hooks/example.ts", targetPath: "src/tui/modules/other/view.tsx", dynamic: true }, registered)).toBe(true)
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
