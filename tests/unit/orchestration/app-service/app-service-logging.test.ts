import { describe, expect, it } from "bun:test"
import { RpcClientError } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { withLoggedRuntimeClient } from "../../../../src/orchestration/app-service/app-service-logging.js"
import type { OperationLogger } from "../../../../src/infra/operation-log.js"
import type { RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { RuntimeProtocolError, type RuntimeProtocolErrorKind } from "../../../../src/protocol/runtime-protocol-schemas.js"

type LogFields = { [key: string]: unknown } | undefined

interface LogCall {
  readonly level: "debug" | "info" | "warn" | "error"
  readonly message: unknown
  readonly extra: LogFields
}

function recordingLogger() {
  const calls: LogCall[] = []
  const log: OperationLogger = {
    debug: (message, extra) => { calls.push({ level: "debug", message, extra }) },
    info: (message, extra) => { calls.push({ level: "info", message, extra }) },
    warn: (message, extra) => { calls.push({ level: "warn", message, extra }) },
    error: (message, extra) => { calls.push({ level: "error", message, extra }) },
  }
  return { calls, log, defaultLevel: () => calls.filter((call) => call.level !== "debug") }
}

/** A client whose queries fail while `down` holds, the way every query in
 *  flight or sent after a lost connection fails. */
function flakyClient(state: { down: boolean }): RuntimeClient {
  const outage = async (): Promise<never> => { throw new Error("SocketReadError: ECONNRESET") }
  const answer = runtimeQuery({ sessionChangeSummary: () => ({ snapshotPosition: 0, fileCount: 0, unknownFileMutationGaps: 0 }) })
  const accepted = async () => ({ ok: true as const })
  return {
    query: (request) => state.down ? outage() : answer(request),
    dispatch: runtimeDispatch({ "chat.open": accepted, "session.delete": accepted }),
    subscribe: () => () => {},
    close: async () => {},
  }
}

describe("logged runtime client", () => {
  it("records the first failed query in full and the rest of the outage as one count when the connection returns", async () => {
    const { log, defaultLevel } = recordingLogger()
    const state = { down: true }
    const client = withLoggedRuntimeClient(flakyClient(state), log, "socket-runtime-client", "client")

    await expect(client.query({ type: "snapshot" })).rejects.toThrow("ECONNRESET")
    await expect(client.query({ type: "statusSnapshot", sessionIds: ["s1"] })).rejects.toThrow("ECONNRESET")
    await expect(client.query({ type: "snapshot" })).rejects.toThrow("ECONNRESET")
    expect(defaultLevel().map((call) => call.message)).toEqual(["socket-runtime-client query failed"])
    expect(defaultLevel()[0]?.extra).toMatchObject({ query: "snapshot", error: "SocketReadError: ECONNRESET", errorDetail: { message: "SocketReadError: ECONNRESET" } })

    state.down = false
    await client.query({ type: "sessionChangeSummary", sessionId: "s1" })

    expect(defaultLevel().map((call) => call.message)).toEqual(["socket-runtime-client query failed", "socket-runtime-client query failed again"])
    expect(defaultLevel()[1]?.extra).toMatchObject({ error: "SocketReadError: ECONNRESET", count: 2, byQuery: { snapshot: 1, statusSnapshot: 1 } })
  })

  it("records person runtime dispatches, leaves cleanup to its owner, and records client dispatch only when failed or slow", async () => {
    const runtime = recordingLogger()
    const clientSide = recordingLogger()
    const state = { down: false }

    await withLoggedRuntimeClient(flakyClient(state), runtime.log, "app-service", "runtime").dispatch({ type: "chat.open" })
    await withLoggedRuntimeClient(flakyClient(state), clientSide.log, "socket-runtime-client", "client").dispatch({ type: "chat.open" })

    expect(runtime.defaultLevel().map((call) => [call.level, call.message])).toEqual([["info", "app-service dispatch done"]])
    expect(clientSide.defaultLevel()).toEqual([])
    const service = withLoggedRuntimeClient(flakyClient(state), runtime.log, "app-service", "runtime")
    await service.dispatch({ type: "session.delete", sessionId: "unused", inactiveBefore: 1 })
    expect(runtime.defaultLevel()).toHaveLength(1)
    await service.dispatch({ type: "session.delete", sessionId: "unused" })
    expect(runtime.defaultLevel()).toHaveLength(2)
  })

  it("records a call its lane took down as interrupted, below the default level, and keeps other errors failures", async () => {
    const closedWith = (code: number) => new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code }) })
    let failure: () => Error = () => closedWith(1000)
    const fail = async (): Promise<never> => { throw failure() }
    const { calls, log, defaultLevel } = recordingLogger()
    const client = withLoggedRuntimeClient({ query: fail, dispatch: fail, subscribe: () => () => {}, close: async () => {} }, log, "socket-runtime-client", "client")

    await expect(client.dispatch({ type: "session.activate", sessionId: "s1" })).rejects.toThrow("SocketCloseError")
    await expect(client.dispatch({ type: "chat.interrupt", sessionId: "s1" })).rejects.toThrow("SocketCloseError")
    await expect(client.query({ type: "snapshot" })).rejects.toThrow("SocketCloseError")
    expect(defaultLevel()).toEqual([])
    expect(calls.filter((call) => String(call.message).endsWith("interrupted")).map((call) => [call.level, call.message, call.extra?.mutation ?? call.extra?.query])).toEqual([
      ["debug", "socket-runtime-client dispatch interrupted", "session.activate"],
      ["debug", "socket-runtime-client dispatch interrupted", "chat.interrupt"],
      ["debug", "socket-runtime-client query interrupted", "snapshot"],
    ])

    // An abnormal close also ends the lane, and the connection records that
    // end once, so each call it took down records no failure of its own.
    failure = () => closedWith(1006)
    await expect(client.dispatch({ type: "session.activate", sessionId: "s1" })).rejects.toThrow("SocketCloseError")
    expect(defaultLevel()).toEqual([])

    failure = () => new Error("activation refused")
    await expect(client.dispatch({ type: "session.activate", sessionId: "s1" })).rejects.toThrow("activation refused")
    expect(defaultLevel().map((call) => [call.level, call.message])).toEqual([["error", "socket-runtime-client dispatch failed"]])
  })

  it.each<[string, RuntimeProtocolErrorKind]>([
    ["a paused project declines", "not-running"],
    ["an executor generation change supersedes", "superseded"],
  ])("records a call %s as an expected outcome below the default level, and keeps other runtime refusals failures", async (_case, outcome) => {
    let kind: RuntimeProtocolErrorKind = outcome
    const query = async (): Promise<never> => { throw new RuntimeProtocolError({ kind, message: "Flywheel's process for this project is not running now." }) }
    const { calls, log, defaultLevel } = recordingLogger()
    const client = withLoggedRuntimeClient({ query, dispatch: runtimeDispatch({}), subscribe: () => () => {}, close: async () => {} }, log, "socket-runtime-client", "client")

    await expect(client.query({ type: "configSnapshot" })).rejects.toThrow("not running now")
    await expect(client.query({ type: "commandUsageSnapshot" })).rejects.toThrow("not running now")
    expect(defaultLevel()).toEqual([])
    expect(calls.filter((call) => String(call.message).endsWith("interrupted")).map((call) => [call.level, call.extra?.query])).toEqual([
      ["debug", "configSnapshot"],
      ["debug", "commandUsageSnapshot"],
    ])

    kind = "internal"
    await expect(client.query({ type: "configSnapshot" })).rejects.toThrow("not running now")
    expect(defaultLevel().map((call) => [call.level, call.message])).toEqual([["error", "socket-runtime-client query failed"]])
  })
})
