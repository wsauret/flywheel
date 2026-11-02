import { afterEach, expect, it, spyOn } from "bun:test"
import { PassThrough } from "node:stream"
import { Log } from "../../../src/infra/log.js"
import { watchTerminalInput } from "../../../src/tui/terminal-input.js"

const log = Log.create({ service: "terminal-input" })
const spies: { mockRestore(): void }[] = []

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function readFailure(code: string): Error {
  return Object.assign(new Error(`${code}: i/o error, read`), { code, syscall: "read" })
}

// The shell that owned the terminal exits, the kernel revokes the terminal,
// and the next read of standard input fails with EIO before the hangup
// signal arrives. The read must end as one record, never as an uncaught
// exception.
it("records a revoked terminal once instead of letting its read failure escape", () => {
  const info = spyOn(log, "info").mockImplementation(() => {})
  const error = spyOn(log, "error").mockImplementation(() => {})
  spies.push(info, error)
  const input = new PassThrough()

  watchTerminalInput(input)

  expect(() => input.emit("error", readFailure("EIO"))).not.toThrow()
  expect(info).toHaveBeenCalledTimes(1)
  expect(info.mock.calls[0]).toEqual(["terminal input closed", { code: "EIO" }])
  expect(error).not.toHaveBeenCalled()
})
