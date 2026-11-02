import { describe, expect, it } from "bun:test"
import { BINARY_COMPILE_FLAGS } from "../../../scripts/binary-entries.js"

const buildBinarySource = await Bun.file(new URL("../../../scripts/build-binary.ts", import.meta.url)).text()
const cliIndexSource = await Bun.file(new URL("../../../src/cli/index.ts", import.meta.url)).text()

describe("binary build typecheck gate", () => {
  it("splits the bundle so each lane loads only the chunks its role imports", () => {
    // The CLI entry dispatches internal roles through lazy imports. Splitting
    // is what keeps those imports lazy in the executable; the second stage
    // must ask for it too or it folds every chunk back into the entry.
    expect(buildBinarySource).toContain("splitting: true,")
    expect(BINARY_COMPILE_FLAGS).toContain("--splitting")
    expect(buildBinarySource).toContain('"build",\n  ...BINARY_COMPILE_FLAGS,')
    // Asset references land in whichever chunk holds their importer, so the
    // path patch walks every emitted script rather than four named files.
    expect(buildBinarySource).toContain('for (const output of bundleResult.outputs) {\n  if (!output.path.endsWith(".js")) continue;\n  const patched = patchBundleScript(')
    for (const role of ["projectExecutor", "guardian", "commandSupervisor", "binaryInstall"]) {
      expect(cliIndexSource).toMatch(new RegExp(`\\[EXECUTABLE_ROLES\\.${role}\\]: async \\(\\) => \\{\\n\\s+const \\{ \\w+ \\} = await import\\(`))
    }
  })
})
