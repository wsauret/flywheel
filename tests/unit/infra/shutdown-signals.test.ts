import { describe, expect, test } from "bun:test";
import { shutdownSignals } from "../../../src/infra/shutdown-signals.js"

describe("shutdown signals", () => {
  test.each([
    ["darwin", ["SIGHUP", "SIGTERM", "SIGINT"]],
    ["linux", ["SIGHUP", "SIGTERM", "SIGINT"]],
    ["win32", ["SIGHUP", "SIGINT"]],
  ] as const)("returns the meaningful signals for %s", (platform, expected) => {
    expect(shutdownSignals(platform)).toEqual(expected)
  })
})
