import { describe, expect, expectTypeOf, it } from "bun:test"
import { fileURLToPath } from "node:url"
import type { TextEditorPresentation } from "../../../../src/tui/keymap/text-entry.js"
import { LazySessionModal } from "../../../../src/tui/modals/lazy-modal-registry.js"

describe("modal source coherence", () => {
  it("keeps kernel modals in the lazy registry and Remote behind its module controller loader", async () => {
    const composition = await Bun.file(fileURLToPath(new URL("../../../../src/tui/hooks/create-modals.tsx", import.meta.url))).text()
    const registry = await Bun.file(fileURLToPath(new URL("../../../../src/tui/modals/lazy-modal-registry.ts", import.meta.url))).text()
    const remoteModule = await Bun.file(fileURLToPath(new URL("../../../../src/tui/modules/remote/index.ts", import.meta.url))).text()
    const remoteSurface = await Bun.file(fileURLToPath(new URL("../../../../src/tui/modules/remote/surface.tsx", import.meta.url))).text()

    expect(composition).toContain("lazy-modal-registry.js")
    expect(composition).not.toMatch(/import\(["']/)
    expect(registry.match(/createLazyTuiView\(/g)).toHaveLength(12)
    expect(registry.match(/import\(["']/g)).toHaveLength(12)
    expect(registry).not.toContain("orchestration")
    expect(registry).not.toContain("remote")
    expect(remoteModule).toContain('loadController: async () => (await import("./surface.js")).createRemoteSurface')
    expect(remoteModule).not.toMatch(/from ["']\.\/(?:surface|modal|use-remote-modal)\.js["']/)
    expect(remoteModule.match(/import\(["']/g)).toHaveLength(1)
    expect(remoteSurface).toContain('import { RemoteModal } from "./modal.js"')
  })

  it("preserves required props through the lazy boundary", () => {
    expectTypeOf<Parameters<typeof LazySessionModal>[0]>().toMatchTypeOf<{
      filterQuery: string
      inputPresentation: TextEditorPresentation
    }>()
  })
})
