import { describe, expect, test } from "bun:test"
import { join, sep } from "node:path"

import { releaseWorkspace } from "../../release/lib/workspaces.js"
import { accountServeSocketPath } from "../../../src/infra/paths.js"

// The perf gate's work root for a 20-character account name, under a root
// that does not exist: `/Users/<name>/.cache/flywheel/perf-gate/run-XXXXXX/w`.
const GATE_ROOT = join("/scratch", "a".repeat(16), ".cache/flywheel/perf-gate/run-cNAujq/w")

const socketBytes = (workDir: string, platform: NodeJS.Platform) =>
  Buffer.byteLength(accountServeSocketPath(join(workDir, ".flywheel"), "installed", platform))

describe("release workspaces", () => {
  test("keeps the account socket of every run within the unix socket limit", () => {
    for (const index of [0, 9, 99]) {
      const workDir = releaseWorkspace(GATE_ROOT, index, "darwin")
      expect(workDir.startsWith(`${GATE_ROOT}${sep}`)).toBe(true)
      expect(socketBytes(workDir, "darwin")).toBeLessThanOrEqual(103)
    }
  })

  test("refuses a root under which the account socket cannot bind", () => {
    const longRoot = join(GATE_ROOT, "x".repeat(30))
    expect(() => releaseWorkspace(longRoot, 0, "darwin")).toThrow(/unix socket.*104 bytes.*--work/s)
    expect(() => releaseWorkspace(longRoot, 0, "linux")).toThrow(/--work/)
  })

  test("places no limit on Windows, whose account service listens on a named pipe", () => {
    const longRoot = join(GATE_ROOT, "x".repeat(30))
    expect(releaseWorkspace(longRoot, 3, "win32")).toBe(join(longRoot, "3"))
  })
})
