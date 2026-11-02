import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { CommandOutcome, RuntimeCommandInvocation } from "../../../src/protocol/command-catalog-protocol-types.js"
import { RuntimeProtocolRpc } from "../../../src/protocol/runtime-protocol-schemas.js"
import { runtimeDispatchResultSchema } from "../../../src/protocol/runtime-dispatch-result-schemas.js"

const dispatch = RuntimeProtocolRpc.requests.get("RuntimeDispatch")
if (dispatch === undefined) throw new Error("Runtime dispatch RPC is missing")
const decodePayload = Schema.decodeUnknownSync(dispatch.payloadSchema)
const decodeSuccess = Schema.decodeUnknownSync(runtimeDispatchResultSchema("command.invoke"))

const invocation: RuntimeCommandInvocation = { type: "command.invoke", id: "papercuts", revision: 3, sessionId: "chat-1", argument: "  verbatim  " }

describe("command.invoke at the RPC seam", () => {
  test("decodes the exact invocation, with and without its optional fields", () => {
    expect(decodePayload(invocation)).toEqual(invocation)
    expect(decodePayload({ type: "command.invoke", id: "doctor", revision: 0 })).toEqual({ type: "command.invoke", id: "doctor", revision: 0 })
  })

  test("rejects a missing, empty, wrong-type, unknown-tag, or excess field", () => {
    const rejected: unknown[] = [
      { type: "command.invoke", revision: 3 },
      { type: "command.invoke", id: "", revision: 3 },
      { type: "command.invoke", id: "papercuts" },
      { type: "command.invoke", id: "papercuts", revision: "3" },
      { type: "command.invoke", id: "papercuts", revision: -1 },
      { type: "command.invoke", id: "papercuts", revision: 1.5 },
      { type: "command.invoke", id: "papercuts", revision: 3, sessionId: "" },
      { type: "command.invoke", id: "papercuts", revision: 3, argument: 7 },
      { type: "command.invoke", id: "papercuts", revision: 3, name: "papercuts" },
      { type: "chat.learn", sessionId: "chat-1" },
      { type: "chat.drain_papercuts", sessionId: "chat-1" },
      { type: "experiment.command", sessionId: "chat-1", argument: "start" },
    ]
    for (const candidate of rejected) expect(() => decodePayload(candidate)).toThrow()
  })

  test("decodes every closed outcome and rejects a widened one", () => {
    const outcomes: readonly CommandOutcome[] = [
      { kind: "none" },
      { kind: "message", message: "help" },
      { kind: "warning", message: "no" },
      { kind: "open", surface: "experiment-dashboard" },
      { kind: "focus-session", sessionId: "chat-2" },
      { kind: "stale" },
      { kind: "unavailable", message: "gone" },
    ]
    for (const outcome of outcomes) expect(decodeSuccess(outcome)).toEqual(outcome)
    for (const candidate of [
      { kind: "none", message: "extra" },
      { kind: "open", surface: "" },
      { kind: "focus-session" },
      { kind: "dashboard" },
      { kind: "handled" },
      { kind: "refused", message: "no" },
    ]) expect(() => decodeSuccess(candidate)).toThrow()
  })
})
