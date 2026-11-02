import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import type { OwnedCommandOptions, OwnedCommandResult } from "../../../../../src/infra/owned-command.js"
import { executeIosSimulatorPointTap } from "../../../../../src/orchestration/modules/development/ios-simulator-point-tap.js"

const packageRoot = resolve("/repo/node_modules/xcodebuildmcp")

function success(): OwnedCommandResult {
  const stdout = "tap complete\n"
  return { exitCode: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", timedOut: false }
}

describe("iOS simulator point tap", () => {
  test("runs the pinned bundled AXe binary through the owned command boundary", async () => {
    const calls: Array<{ command: readonly string[]; options?: OwnedCommandOptions }> = []
    const signal = new AbortController().signal
    const result = await executeIosSimulatorPointTap({
      runOwnedCommand: async (command, options) => { calls.push({ command, options }); return success() },
      cliPath: join(packageRoot, "build", "cli.js"),
      arguments: { simulatorId: "F9CD63C0-F6CE-49FD-9434-AC90845999CD", x: 31, y: 88 },
      signal,
    })

    expect(calls).toEqual([{
      command: [
        join(packageRoot, "bundled", "axe"),
        "tap",
        "-x",
        "31",
        "-y",
        "88",
        "--udid",
        "F9CD63C0-F6CE-49FD-9434-AC90845999CD",
      ],
      options: expect.objectContaining({ signal, timeoutMs: 30_000, maxOutputBytes: 65_536 }),
    }])
    expect(result).toMatchObject({ isError: false, structuredContent: { x: 31, y: 88 } })
  })

  test("rejects invalid device points and extra fields before launch", async () => {
    const simulatorId = "F9CD63C0-F6CE-49FD-9434-AC90845999CD"
    let launched = false
    const refuseRunner = async (): Promise<OwnedCommandResult> => {
      launched = true
      return success()
    }
    const invalid = [
      { simulatorId: "not-a-udid", x: 31, y: 88 },
      { simulatorId, x: -1, y: 88 },
      { simulatorId, x: 2_001, y: 88 },
      { simulatorId, x: Number.NaN, y: 88 },
      { simulatorId, x: Number.POSITIVE_INFINITY, y: 88 },
      { simulatorId, x: 31, y: -1 },
      { simulatorId, x: 31, y: 3_001 },
      { simulatorId, x: 31, y: Number.NaN },
      { simulatorId, x: 31, y: Number.POSITIVE_INFINITY },
      { simulatorId, x: 31, y: 88, command: "erase" },
    ]
    for (const arguments_ of invalid) {
      await expect(executeIosSimulatorPointTap({
        runOwnedCommand: refuseRunner,
        cliPath: join(packageRoot, "build", "cli.js"),
        arguments: arguments_,
      })).rejects.toThrow()
    }
    expect(launched).toBe(false)
  })

  test("accepts both coordinate boundaries", async () => {
    const simulatorId = "F9CD63C0-F6CE-49FD-9434-AC90845999CD"
    let launches = 0
    const boundaryRunner = async (): Promise<OwnedCommandResult> => {
      launches += 1
      return success()
    }
    for (const arguments_ of [
      { simulatorId, x: 0, y: 0 },
      { simulatorId, x: 2_000, y: 3_000 },
    ]) {
      await executeIosSimulatorPointTap({
        runOwnedCommand: boundaryRunner,
        cliPath: join(packageRoot, "build", "cli.js"),
        arguments: arguments_,
      })
    }
    expect(launches).toBe(2)
  })
})
