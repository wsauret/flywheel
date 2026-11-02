import { expect, spyOn, test } from "bun:test"

import { Log } from "../../../src/infra/log.js"
import { createProcessSupervisor } from "../../../src/infra/process-supervisor.js"
import { stubGuardian } from "../../helpers/stub-guardian.js"

/** A process guardian writes its own diagnostic records on the stderr its
 *  host drains, and the host relays each one to its own log as the record it
 *  is, with the guardian that wrote it. */

test("a guardian's record that it could not open a kernel process API reaches the host's log with the guardian that wrote it", async () => {
  const unopened = { service: "process-kernel-api", message: "a kernel process API could not be opened; its process probes answer unproven", api: "libproc", error: "dlopen failed" }
  const record = `${JSON.stringify({ type: "log.warn", payload: unopened })}\n`
  const supervisor = createProcessSupervisor({ guardianCommand: [process.execPath, "-e", stubGuardian("", `require("node:fs").writeSync(2, ${JSON.stringify(record)})`)] })
  const warn = spyOn(Log.create({ service: "process-supervisor" }), "warn")
  const relayed = () => warn.mock.calls.filter(([message]) => message === unopened.message)

  try {
    await supervisor.start()
    const pid = await supervisor.guardian.pid()
    const deadline = Date.now() + 10_000
    while (relayed().length === 0 && Date.now() < deadline) await Bun.sleep(10)

    expect(relayed()).toEqual([[unopened.message, { service: "process-kernel-api", api: "libproc", error: "dlopen failed", guardianPid: pid }]])
  } finally {
    warn.mockRestore()
    await supervisor.dispose()
  }
}, 15_000)

