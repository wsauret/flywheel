import assert from "node:assert/strict"
import { test } from "node:test"

import { copySessionId } from "./session-copy.js"

test("session copy reports a refused platform write without claiming success", async () => {
  const reports: { readonly severity: "info" | "warning"; readonly message: string }[] = []

  await copySessionId(
    async () => { throw new Error("permission denied") },
    (severity, message) => { reports.push({ severity, message }) },
    "session-full-id",
  )

  assert.deepEqual(reports, [{ severity: "warning", message: "Could not copy the session ID. Check clipboard access and try again." }])
})
