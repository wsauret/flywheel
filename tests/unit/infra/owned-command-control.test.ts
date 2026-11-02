import { expect, spyOn, test } from "bun:test"

import { Log } from "../../../src/infra/log.js"
import { emptied } from "../../../src/infra/owned-command-control.js"
import type { ManagedContainer } from "../../../src/infra/process-container.js"

test("a container a crashed supervisor left, which outlives two escalations, records its first result once and the count of its repeats, and then resolves", async () => {
  const warn = spyOn(Log.create({ service: "owned-command-control" }), "warn")
  const signals: string[] = []
  // Its members leave at the third KILL.
  const container: ManagedContainer = {
    signal: (signal) => { signals.push(signal) },
    populated: () => signals.filter((signal) => signal === "SIGKILL").length < 3,
  }
  try {
    await emptied({ pid: 4242, container }, 0, "command supervisor exited with work left", () => Promise.resolve())

    expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"])
    expect(warn.mock.calls).toEqual([
      ["the container was not proven empty; the command's owner keeps it and empties it again", { container: 4242, remaining: 1, reason: "command supervisor exited with work left" }],
      ["the container was not proven empty again", { container: 4242, count: 1, windowMs: expect.any(Number) }],
    ])
  } finally {
    warn.mockRestore()
  }
})
