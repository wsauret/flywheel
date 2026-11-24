import { describe, expect, test } from "bun:test"

const FORBIDDEN = [
  "orchestration/session-store",
  "orchestration/session/manager",
  "infra/event-store-effect",
  "infra/event-store-types",
  "createFlywheelAppService",
  "createRuntimeSupervisor",
  "createWorkflowController",
  "createRuntimeUiBus",
] as const

describe("TUI runtime boundary", () => {
  test("render root does not import runtime authorities", async () => {
    for (const file of ["src/tui/shell/app.tsx", "src/tui/shell/shell.tsx", "src/tui/hooks/state/shell-state.ts", "src/tui/hooks/overlays/create-modals.tsx"]) {
      const source = await Bun.file(file).text()
      for (const forbidden of FORBIDDEN) expect(source).not.toContain(forbidden)
    }
  })
})
