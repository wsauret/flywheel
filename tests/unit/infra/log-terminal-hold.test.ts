import { describe, expect, it } from "bun:test"

import { Log } from "../../../src/infra/log.js"

/** Every stderr write while `run` runs, with stderr a terminal or not. */
function stderrWrites(isTTY: boolean, run: () => void): string {
  const chunks: string[] = []
  const originalWrite = process.stderr.write
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
  const captureWrite: typeof process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }
  process.stderr.write = captureWrite
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true })
  try {
    run()
  } finally {
    process.stderr.write = originalWrite
    Object.defineProperty(process.stderr, "isTTY", originalIsTTY ?? { value: undefined, configurable: true })
  }
  return chunks.join("")
}

describe("a diagnostic line while the full-screen TUI holds the terminal", () => {
  it("never reaches a terminal stderr, and reaches it again once the TUI lets the terminal go", () => {
    const release = Log.holdTerminal()
    try {
      expect(stderrWrites(true, () => Log.writeDiagnosticStderr("[boot +5ms] held\n"))).toBe("")
    } finally {
      release()
    }
    expect(stderrWrites(true, () => Log.writeDiagnosticStderr("[boot +9ms] released\n"))).toBe("[boot +9ms] released\n")
  })

  it("still reaches a stderr redirected to a file or a pipe", () => {
    const release = Log.holdTerminal()
    try {
      expect(stderrWrites(false, () => Log.writeDiagnosticStderr("[boot +5ms] held\n"))).toBe("[boot +5ms] held\n")
    } finally {
      release()
    }
  })
})
