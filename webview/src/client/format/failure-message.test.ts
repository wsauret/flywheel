import assert from "node:assert/strict"
import { test } from "node:test"

import { RpcClientError } from "effect/rpc"
import { describeFailure } from "./failure-message.js"

// Every failure the transport raises shows in the same plain words, whatever
// layer named it. "Not delivered: Flywheel could not start a new chat:
// RpcClientDefect: Unknown socket error" once reached the screen.
test("a transport failure reads as a dropped connection, never by an internal name", () => {
  const causes = [
    new Error("RpcClientDefect: Unknown socket error"),
    new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message: "the socket stopped", cause: new Error("broke") }) }),
    new Error("SocketReadError: An error occurred during Read"),
    "RpcClientError",
  ]
  for (const cause of causes) {
    const words = describeFailure(cause)
    assert.match(words, /the connection to the runtime dropped/)
    assert.doesNotMatch(words, /Rpc|Socket[A-Z]|Defect/)
  }
})

test("a runtime's own refusal keeps its words", () => {
  assert.equal(describeFailure(new Error("the auth profile does not exist")), "the auth profile does not exist")
})
