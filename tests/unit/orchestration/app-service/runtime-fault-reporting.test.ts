import { expect, test } from "bun:test"
import type { RuntimeExecutorState, RuntimeServiceState } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeFaultReporting, type RuntimeFaultReport } from "../../../../src/orchestration/app-service/runtime-fault-reporting.js"

test("a fault reports once per episode, preserves its receipt, and ignores late results after recovery", async () => {
  const reports: Array<ReturnType<typeof Promise.withResolvers<RuntimeFaultReport | undefined>>> = []
  const published: RuntimeServiceState[] = []
  const reporting = createRuntimeFaultReporting<RuntimeServiceState>({
    initial: { kind: "serving" },
    report: async () => { const result = Promise.withResolvers<RuntimeFaultReport | undefined>(); reports.push(result); return result.promise },
    publish: (state) => published.push(state),
  })
  reporting.update({ kind: "crash_loop", cause: "code 1" })
  reporting.update({ kind: "crash_loop", cause: "code 2" })
  await Promise.resolve()
  expect(reports).toHaveLength(1)
  reports[0]!.resolve({ kind: "sent", reportId: "7" })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(reporting.state()).toMatchObject({ kind: "crash_loop", cause: "code 2", report: { kind: "sent", reportId: "7" } })
  reporting.update({ kind: "crash_loop", cause: "code 3" })
  expect(reporting.state()).toMatchObject({ report: { kind: "sent", reportId: "7" } })
  reporting.update({ kind: "serving" })
  reporting.update({ kind: "crash_loop", cause: "code 4" })
  await Promise.resolve()
  expect(reports).toHaveLength(2)
  reporting.update({ kind: "serving" })
  reports[1]!.resolve({ kind: "failed", reportText: "stale failed report" })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(reporting.state()).toEqual({ kind: "serving" })
  expect(published.at(-1)).toEqual({ kind: "serving" })
  expect(reporting.failedReport()).toBeUndefined()
  await reporting.dispose()
})

test("a report withheld by a build that is not a release keeps its text for Copy", async () => {
  const reporting = createRuntimeFaultReporting<RuntimeServiceState>({
    initial: { kind: "serving" },
    report: async () => ({ kind: "not-release", reportText: "assembled report" }),
    publish() {},
  })
  reporting.update({ kind: "crash_loop", cause: "stopped" })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(reporting.state()).toEqual({ kind: "crash_loop", cause: "stopped", report: { kind: "not-release" } })
  expect(reporting.failedReport()).toBe("assembled report")
  await reporting.dispose()
})

test("a failed automatic report marks its fault without retrying", async () => {
  let calls = 0
  const reporting = createRuntimeFaultReporting<RuntimeServiceState>({
    initial: { kind: "serving" },
    report: async () => { calls += 1; return { kind: "failed", reportText: "assembled report" } },
    publish() {},
  })
  reporting.update({ kind: "crash_loop", cause: "stopped" })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(reporting.state()).toMatchObject({ report: { kind: "failed" } })
  expect(reporting.failedReport()).toBe("assembled report")
  reporting.update({ kind: "crash_loop", cause: "stopped again" })
  expect(calls).toBe(1)
  reporting.update({ kind: "serving" })
  expect(reporting.failedReport()).toBeUndefined()
  await reporting.dispose()
})

test("restarting and failed recovery share an episode until the executor serves again", async () => {
  let calls = 0
  const reporting = createRuntimeFaultReporting<RuntimeExecutorState>({
    initial: { kind: "serving" },
    report: async () => ({ kind: "sent", reportId: String(++calls) }),
    publish() {},
  })
  reporting.update({ kind: "restarting", since: 1, cause: "stopped" })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  reporting.update({ kind: "recovery_failed", cause: "recovery stopped" })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(calls).toBe(1)
  expect(reporting.state()).toEqual({ kind: "recovery_failed", cause: "recovery stopped", report: { kind: "sent", reportId: "1" } })
  reporting.update({ kind: "serving" })
  expect(reporting.state()).toEqual({ kind: "serving" })
  reporting.update({ kind: "restarting", since: 2, cause: "stopped again" })
  for (let i = 0; i < 10; i++) await Promise.resolve()
  expect(calls).toBe(2)
  expect(reporting.state()).toMatchObject({ report: { kind: "sent", reportId: "2" } })
  await reporting.dispose()
})
