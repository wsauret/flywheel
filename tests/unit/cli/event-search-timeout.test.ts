import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { runEventSearch } from "../../../src/cli/event-search"
import { MAX_TIMEOUT_SECONDS } from "../../../src/cli/event-search-args"
import * as hardExitClock from "../../../src/infra/hard-exit-clock"
import { temporaryDirectories } from "../../helpers/directories"

const temporaryDirectory = temporaryDirectories()

afterEach(() => {
  process.exitCode = 0
})

async function timeoutGuidance(timeoutSeconds: number): Promise<string> {
  const clock = spyOn(hardExitClock, "startHardExitClock").mockImplementation(() => ({ cancel: async () => {} }))
  const quiet = spyOn(console, "error").mockImplementation(() => {})
  try {
    await runEventSearch(["--list-types", "--timeout", String(timeoutSeconds)], temporaryDirectory("event-search-timeout-"))
    expect(clock).toHaveBeenCalledTimes(1)
    return clock.mock.calls[0]![1]
  } finally {
    clock.mockRestore()
    quiet.mockRestore()
  }
}

describe("events search timeout guidance", () => {
  test("suggests a longer timeout only while one is allowed", async () => {
    expect(await timeoutGuidance(MAX_TIMEOUT_SECONDS - 1)).toContain("raise --timeout")
    const atMaximum = await timeoutGuidance(MAX_TIMEOUT_SECONDS)
    expect(atMaximum).toContain(`timed out after ${MAX_TIMEOUT_SECONDS}s`)
    expect(atMaximum).not.toContain("raise --timeout")
  })
})
