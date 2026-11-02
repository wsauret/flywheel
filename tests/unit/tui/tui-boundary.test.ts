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
    for (const file of ["src/tui/app.tsx", "src/tui/shell.tsx", "src/tui/hooks/shell-state.ts", "src/tui/hooks/create-modals.tsx"]) {
      const source = await Bun.file(file).text()
      for (const forbidden of FORBIDDEN) expect(source).not.toContain(forbidden)
    }
  })
})
