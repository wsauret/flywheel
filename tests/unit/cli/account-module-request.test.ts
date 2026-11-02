import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"

import { requestAccountModule } from "../../../src/cli/account-module-request.js"
import { encodeAccountAttachResponse } from "../../../src/protocol/account-attach.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporary = temporaryDirectories()
const servers: Array<{ stop(): void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

/** An account service socket that reads one preface and runs `answer` on the connection. */
function serve(answer: (socket: { write(bytes: string): number; end(): void }) => void) {
  const path = join(temporary("flywheel-module-request-"), "account.sock")
  const prefaces: string[] = []
  servers.push(Bun.listen({ unix: path, socket: { data(socket, chunk) { prefaces.push(new TextDecoder().decode(chunk)); answer(socket) } } }))
  return { path, prefaces }
}

test("hands each answer of the service to the caller and settles when the service ends the request", async () => {
  const service = serve((socket) => {
    socket.write(encodeAccountAttachResponse({ kind: "answer", payload: { type: "pairing" } }))
    socket.write(encodeAccountAttachResponse({ kind: "answer", payload: { type: "paired" } }))
    socket.write(encodeAccountAttachResponse({ kind: "end" }))
  })
  const answers: unknown[] = []
  await requestAccountModule(service.path, new TextEncoder().encode("preface\n"), (answer) => { answers.push(answer) })
  expect(service.prefaces).toEqual(["preface\n"])
  expect(answers).toEqual([{ type: "pairing" }, { type: "paired" }])
})

test("rejects with the service's reason when it fails the request", async () => {
  const service = serve((socket) => { socket.write(encodeAccountAttachResponse({ kind: "failed", error: "The remote module is off for this account." })) })
  await expect(requestAccountModule(service.path, new TextEncoder().encode("preface\n"), () => {})).rejects.toThrow("The remote module is off for this account.")
})

test.each([
  // A refused attach (an older build cannot read the `module` intent) and an
  // accepted request whose service exited both close with no byte.
  ["before it answers", [], "The account service closed before it answered. A running service of an older build that does not accept this request is a likely cause: run /restart in a Flywheel terminal to restart it, then run this command again."],
  ["after an answer but before it ends the request", [{ type: "pairing" }], "The account service closed before it ended the request."],
] as const)("states what it knows when the service closes %s", async (_when, sent, message) => {
  const service = serve((socket) => {
    for (const payload of sent) socket.write(encodeAccountAttachResponse({ kind: "answer", payload }))
    socket.end()
  })
  const answers: unknown[] = []
  await expect(requestAccountModule(service.path, new TextEncoder().encode("preface\n"), (answer) => { answers.push(answer) })).rejects.toThrow(message)
  expect(answers).toEqual([...sent])
})
