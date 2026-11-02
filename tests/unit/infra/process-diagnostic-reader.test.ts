import { expect, test } from "bun:test"
import { createProcessDiagnosticReader, relayProcessDiagnostic } from "../../../src/infra/process-diagnostic-reader.js"

test("classifies split service markers independently for each stream", () => {
  const records: Array<[string, string | undefined]> = []
  const stdout = createProcessDiagnosticReader((line, record) => records.push([line, record?.payload.service]))
  const stderr = createProcessDiagnosticReader((line, record) => records.push([line, record?.payload.service]))
  stdout('{"payload":{"service":"process-')
  stderr('{"payload":{"service":"process-watchdog"}}\n')
  stdout('termination"}}\nordinary "service":"process-termination"\n')
  expect(records.map((record) => record[1])).toEqual(["process-watchdog", "process-termination", undefined])
})

test("keeps every complete record in a coalesced batch larger than the remainder bound", () => {
  const services: Array<string | undefined> = []
  const read = createProcessDiagnosticReader((_line, record) => services.push(record?.payload.service))
  const records = ["process-guardian", "process-termination", "command-supervisor", "process-supervisor"]
  read(records.map((service) => JSON.stringify({ payload: { service, message: "x".repeat(2000) } })).join("\n") + "\n")
  expect(services).toEqual(records)
  read("x".repeat(5000))
  read('\n{"payload":{"service":"process-guardian"}}\n')
  expect(services.slice(-2)).toEqual([undefined, "process-guardian"])
})

test("gives each record the record it parsed, so a reader need not parse it again", () => {
  const records: unknown[] = []
  const read = createProcessDiagnosticReader((_line, record) => records.push(record))
  read('{"ts":5,"type":"log.info","payload":{"service":"process-termination","container":42}}\n{"payload":{"container":42}}\nplain\n')
  expect(records).toEqual([{ type: "log.info", ts: 5, payload: { service: "process-termination", container: 42 } }, undefined, undefined])
})

test("relays a record at the level its writer gave it, with the time its writer recorded it", () => {
  const relayed: Array<[string, unknown, unknown]> = []
  const logger = {
    debug: (message: unknown, extra?: unknown) => { relayed.push(["debug", message, extra]) },
    info: (message: unknown, extra?: unknown) => { relayed.push(["info", message, extra]) },
    warn: (message: unknown, extra?: unknown) => { relayed.push(["warn", message, extra]) },
    error: (message: unknown, extra?: unknown) => { relayed.push(["error", message, extra]) },
  }
  const read = createProcessDiagnosticReader((_line, record) => { if (record) relayProcessDiagnostic(logger, record, { supervisorPid: 7 }) })
  read([
    { ts: 100, type: "log.warn", payload: { service: "process-termination", message: "container killed", container: 42 } },
    { ts: 200, type: "log.debug", payload: { service: "command-supervisor", message: "lease renewed" } },
    { type: "process.fact", payload: { service: "process-watchdog", message: "watched" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n")
  expect(relayed).toEqual([
    ["warn", "container killed", { service: "process-termination", container: 42, sourceTs: 100, supervisorPid: 7 }],
    ["debug", "lease renewed", { service: "command-supervisor", sourceTs: 200, supervisorPid: 7 }],
    ["info", "watched", { service: "process-watchdog", supervisorPid: 7 }],
  ])
})
