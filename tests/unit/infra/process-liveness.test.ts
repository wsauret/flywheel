import { describe, expect, spyOn, test } from "bun:test"

import { isProcessAlive } from "../../../src/infra/process-liveness.js"

const failKill = (code: string) => () => { throw Object.assign(new Error(code), { code }) }

describe("process liveness", () => {
  test("reads a pid as free only when signal zero answers ESRCH", () => {
    const kill = spyOn(process, "kill")
    try {
      kill.mockImplementation(() => true)
      expect(isProcessAlive(4242)).toBe(true)
      // A refusal is a process that exists and belongs to another user.
      kill.mockImplementation(failKill("EPERM"))
      expect(isProcessAlive(4242)).toBe(true)
      kill.mockImplementation(failKill("ESRCH"))
      expect(isProcessAlive(4242)).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })

  test("never signals a pid that could not name a process", () => {
    const kill = spyOn(process, "kill")
    try {
      expect(isProcessAlive(0)).toBe(false)
      expect(isProcessAlive(-1)).toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})
