import { describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { probeRendezvous, readRuntimeIdentity, type RendezvousProbe, type RuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { runServe, startAddressVerdict } from "../../../src/cli/serve.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { errnoCode } from "../../../src/infra/error-message.js"
import { Log } from "../../../src/infra/log.js"
import { accountEventStoreDbFile, accountServeDir, accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { processHolders, type HolderState, type ProcessHolder } from "../../../src/infra/process-holder.js"
import { confirmServiceStart, failServiceStart } from "../../../src/orchestration/update/service-start.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { countStart, IDLE_SERVE, shortAccountHomes, startRecordText, statusRecords, unusedLauncher } from "./_serve-fixtures.js"

// A serve run in this test process serves the lane of this process's executable.
const lane = serveLaneFor(process.execPath)
const shortAccountHome = shortAccountHomes()

/** An account home whose lane directory exists, so a listener can bind the
 *  lane's address. */
function accountHome() {
  const { accountHome: home, userDataRoot } = shortAccountHome("fw-address-")
  fs.mkdirSync(accountServeDir(userDataRoot, lane), { recursive: true })
  return { accountHome: home, userDataRoot, socketPath: accountServeSocketPath(userDataRoot, lane), identityPath: accountServeRecordPath(userDataRoot, lane) }
}

describe("the account service address", () => {
  // An answer ends the probe at once, so only a silent owner waits out the
  // bound; the answering row's bound only has to outlast one round trip.
  test.each([
    // Every build since v0.0.9 rejects the empty line and closes.
    ["an owner that closes the connection on the empty line answers", (socket: { end(): void }) => { socket.end() }, 2_000, "listening"],
    // A stalled owner accepts the connection, because the kernel does, and
    // answers nothing.
    ["an owner that accepts the connection and answers nothing is silent", () => {}, 20, "silent"],
  ] as const)("%s", async (_name, onData, answerWithinMs, expected) => {
    const { socketPath } = accountHome()
    const listener = Bun.listen({ unix: socketPath, socket: { data: onData } })
    try {
      expect(await probeRendezvous(socketPath, answerWithinMs)).toEqual({ kind: expected })
    } finally {
      listener.stop(true)
    }
  })

  test("an address that does not exist answers absent in the caller's own turn, so a client launches its service while the interface loads", async () => {
    // The interface load that follows a client's first probe settles only
    // promises until it ends. A connect that answers through the event loop,
    // as a Windows named pipe does, would wait for the whole load.
    const { socketPath } = accountHome()
    let answer: RendezvousProbe | undefined
    void probeRendezvous(socketPath).then((probe) => { answer = probe })
    for (let hop = 0; hop < 100; hop++) await Promise.resolve()

    expect(answer).toEqual({ kind: "absent", code: "ENOENT" })
  })

  test("a service whose every pipe instance is taken reads as listening, never absent, so a client does not start a second service", async () => {
    const { socketPath } = accountHome()
    const listener = Bun.listen({ unix: socketPath, socket: { data() {} } })
    try {
      // On Windows each open of a named pipe takes one of the listener's
      // instances, and this turn holds the loop that would free them, as a
      // service's own startup does. Windows then answers EBUSY for the path,
      // and `existsSync` reads that answer as a path that does not exist.
      let refusal: string | undefined
      for (let open = 0; open < 64 && refusal === undefined; open++) {
        try {
          fs.statSync(socketPath)
        } catch (error) {
          refusal = errnoCode(error)
        }
      }
      expect(refusal).toBe(process.platform === "win32" ? "EBUSY" : undefined)

      expect(await probeRendezvous(socketPath)).toEqual({ kind: "listening" })
    } finally {
      listener.stop(true)
    }
  })

  test("a start whose address holds an owner that does not answer keeps the path, says why, exits to be asked again, and takes its count back", async () => {
    const { accountHome: home, userDataRoot, socketPath, identityPath } = accountHome()
    const listener = Bun.listen({ unix: socketPath, socket: { data() {} } })
    fs.writeFileSync(identityPath, JSON.stringify({ pid: process.pid, version: "1.3.0", protocolVersion: RUNTIME_PROTOCOL_VERSION }))
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const manager = createPersistentProcessManager()
    await countStart(userDataRoot)
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], { executionCwd: home, projectRoot: home, accountHome: home, userDataRoot }, unusedLauncher(), manager, false, { ...IDLE_SERVE, ownerAnswerMs: 20 })
      // The owner still holds its address.
      expect(await probeRendezvous(socketPath)).toEqual({ kind: "listening" })
    } finally {
      manager.releaseAll()
      write.mockRestore()
      listener.stop(true)
    }
    expect(exitCode).toBe(SERVE_EXIT.restart)
    expect(statusRecords(output)).toEqual([{ flywheel: "serve.startup.failed", error: expect.stringContaining(`the account service (pid ${process.pid}) accepted a connection and did not answer it`) }])
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2, failing: expect.objectContaining({ starts: 1 }) })
  }, 15_000)

  test("a start that parks behind an owner that answers takes its count back and ends without opening the account store under it, so nothing later in its process records for it", async () => {
    const { accountHome: home, userDataRoot, socketPath } = accountHome()
    const listener = Bun.listen({ unix: socketPath, socket: { data(socket) { socket.end() } } })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const manager = createPersistentProcessManager()
    await countStart(userDataRoot)
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], { executionCwd: home, projectRoot: home, accountHome: home, userDataRoot }, unusedLauncher(), manager, false, IDLE_SERVE)
    } finally {
      manager.releaseAll()
      write.mockRestore()
      listener.stop(true)
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(fs.existsSync(accountEventStoreDbFile(userDataRoot))).toBe(false)
    confirmServiceStart()
    expect(failServiceStart({ cause: "a later failure", causeKind: "thrown" }, () => {})).toBe("restart")
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2 })
  }, 15_000)

  test("a start that finds the previous service's record but not the service records its unclean end once, marks its logs, and publishes its own record", async () => {
    const { accountHome: home, userDataRoot, identityPath } = accountHome()
    const own = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity")
    // This pid with another start stamp: the service that wrote the record
    // is gone, and its pid was given to this process. It left no address.
    const buildId = "a".repeat(64)
    fs.writeFileSync(identityPath, JSON.stringify({ pid: process.pid, v: 1, start: "1", version: "1.3.0", protocolVersion: RUNTIME_PROTOCOL_VERSION, buildId }))
    const logDir = path.join(home, ".flywheel", "log")
    fs.mkdirSync(logDir, { recursive: true })
    const logFile = `2026-01-01T000000000Z-${process.pid}-0-${crypto.randomUUID()}.jsonl`
    fs.writeFileSync(path.join(logDir, logFile), "")
    // This process's own log, which opened in the same directory before the
    // start: the pid is the same, but the gone service never wrote it.
    const ownLogFile = `${new Date().toISOString().replace(/[:.]/g, "")}-${process.pid}-0-${crypto.randomUUID()}.jsonl`
    fs.writeFileSync(path.join(logDir, ownLogFile), "")
    let published: RuntimeIdentity | undefined
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (String(chunk).includes('"flywheel":"serve.listening"')) published = readRuntimeIdentity(identityPath)
      return true
    })
    const warnings: unknown[][] = []
    const warn = spyOn(Log.create({ service: "serve" }), "warn").mockImplementation((...args) => { warnings.push(args) })
    const manager = createPersistentProcessManager()
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], { executionCwd: home, projectRoot: home, accountHome: home, userDataRoot }, unusedLauncher(), manager, false, IDLE_SERVE)
    } finally {
      manager.releaseAll()
      write.mockRestore()
      warn.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    const marked = logFile.replace(/\.jsonl$/, ".unexpected-exit.jsonl")
    expect(warnings.filter(([message]) => message === "the previous account service ended without its exit path"))
      .toEqual([["the previous account service ended without its exit path", { pid: process.pid, version: "1.3.0", buildId, proof: "another-process", logFiles: [marked] }]])
    expect(fs.readdirSync(logDir).sort()).toEqual([marked, ownLogFile])
    // The record this start published at listen names this process by its
    // identity, which the gone service's record did not.
    expect(published).toMatchObject({ pid: process.pid, holder: { kind: "identified", pid: process.pid, identity: own } })
  }, 15_000)

  const SOCKET = "/scratch/serve.sock"
  const identified: ProcessHolder = { kind: "identified", pid: 41, identity: { v: 1, start: "7" } }
  const recordOf = (holder: ProcessHolder): RuntimeIdentity => ({ pid: holder.pid, version: "1.3.0", buildId: "a".repeat(64), holder })
  const refused: RendezvousProbe = { kind: "absent", code: "ECONNREFUSED" }
  const missing: RendezvousProbe = { kind: "absent", code: "ENOENT" }
  const alive: HolderState = { kind: "alive" }
  const unknown: HolderState = { kind: "unknown", reason: "the kernel did not answer for pid 41" }
  const refuse = (clearsItself: boolean, reason: string) => ({ kind: "refuse" as const, clearsItself, reason: expect.stringContaining(reason) })
  test.each([
    ["an owner that answers parks the start", { kind: "listening" }, undefined, alive, { kind: "park" }],
    ["a silent owner refuses the start with a cause that does not clear itself", { kind: "silent" }, recordOf(identified), alive, refuse(false, "the account service (pid 41) accepted a connection and did not answer it")],
    ["an address this user may not connect to refuses with its remedy", { kind: "unknown", code: "EACCES" }, undefined, alive, { ...refuse(false, "EACCES"), refusal: { kind: "address-access", path: SOCKET, code: "EACCES" } }],
    ["any other connect error refuses, and clears itself", { kind: "unknown", code: "EAGAIN" }, undefined, alive, refuse(true, "EAGAIN")],
    ["a refused connection while the identified holder runs refuses as a full queue", refused, recordOf(identified), alive, refuse(false, "the account service (pid 41) runs but refused a connection: its connection queue is full")],
    ["a refused connection whose identified holder the kernel did not answer for refuses, and clears itself", refused, recordOf(identified), unknown, refuse(true, "the kernel did not answer for pid 41")],
    ["a refused connection whose identified holder is gone serves and names the previous service", refused, recordOf(identified), { kind: "gone", proof: "another-process" }, { kind: "serve", previous: { pid: 41, version: "1.3.0", buildId: "a".repeat(64), proof: "another-process" } }],
    // An earlier build's record keeps the reading that a refused connection
    // means absence, even while a stranger holds its pid.
    ["a refused connection whose holder names no identity serves", refused, recordOf({ kind: "without-identity", pid: 42 }), alive, { kind: "serve" }],
    ["a refused connection whose holder identity this build cannot read serves", refused, recordOf({ kind: "unreadable-identity", pid: 43, version: "2" }), { kind: "unknown", reason: "version 2" }, { kind: "serve" }],
    ["a refused connection with no record serves", refused, undefined, alive, { kind: "serve" }],
    ["a missing address serves, whatever runs under the record's pid", missing, recordOf(identified), alive, { kind: "serve" }],
  ] as const)("%s", (_name, probe, identity, state, expected) => {
    expect(startAddressVerdict({ probe, identity, state: () => state, socketPath: SOCKET })).toEqual(expected)
  })
})
