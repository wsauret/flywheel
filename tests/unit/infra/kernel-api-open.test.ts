import { expect, test } from "bun:test"

import type { DebugLogRecordInput } from "../../../src/infra/debug-log.js"
import { openKernelApiOnce } from "../../../src/infra/kernel-api-open.js"
import { Log } from "../../../src/infra/log.js"

test("an API that cannot be opened answers nothing on every call, is opened once, and records one warning under the kernel API service", async () => {
  const records: DebugLogRecordInput[] = []
  await Log.init({ forward: (record) => { records.push(record) } })
  try {
    let opens = 0
    const api = openKernelApiOnce("libproc", () => {
      opens += 1
      throw new Error("dlopen failed")
    })

    expect([api(), api(), api()]).toEqual([undefined, undefined, undefined])
    expect(opens).toBe(1)
    // The record is written through a lazy import of the log.
    await Bun.sleep(1)
    expect(records).toEqual([{
      type: "log.warn",
      payload: { service: "process-kernel-api", message: "a kernel process API could not be opened; its process probes answer unproven", api: "libproc", error: "dlopen failed" },
    }])
  } finally {
    await Log.closeGlobal()
  }
})

test("an API that opens is opened once and answers every call", () => {
  let opens = 0
  const api = openKernelApiOnce("libproc", () => {
    opens += 1
    return { name: "libproc" }
  })

  expect(api()).toBe(api())
  expect(opens).toBe(1)
})
