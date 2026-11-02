import { describe, expect, test } from "bun:test"

import { createWindowsJobApi } from "../../../src/infra/windows-job-object.js"

const ERROR_FILE_NOT_FOUND = 2
const ERROR_ACCESS_DENIED = 5

/** The kernel32 calls an open makes, scripted. The real library is only
 *  present on Windows, and what needs proving here is the mapping from return
 *  values and error codes to answers, which is platform-independent. */
function fakeKernel32(script: { readonly handle?: number; readonly lastError?: number }) {
  const closed: number[] = []
  const symbols = {
    OpenJobObjectW: () => script.handle ?? 0,
    GetLastError: () => script.lastError ?? 0,
    CloseHandle: (handle: number) => { closed.push(handle); return 1 },
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a dlopen result's type brands each symbol and returned pointer with private tags that only dlopen produces, so a scripted stand-in cannot carry it
  return { api: createWindowsJobApi({ symbols } as never, { symbols: {} } as never), closed }
}

describe("windows job open", () => {
  test("holds the container it opened until the handle is closed", () => {
    const { api, closed } = fakeKernel32({ handle: 7 })

    const opened = api.open("Local\\flywheel-owned-test")

    expect(opened.kind).toBe("opened")
    if (opened.kind === "opened") opened.job.close()
    expect(closed).toEqual([7])
  })

  test("reads only the error that means no such name as a container nobody created", () => {
    expect(fakeKernel32({ lastError: ERROR_FILE_NOT_FOUND }).api.open("Local\\flywheel-owned-test")).toEqual({ kind: "not-found" })
  })

  test("proves nothing when the open fails for any other reason", () => {
    // A container that refuses this side, or an open that failed for a
    // reason of its own, may still hold processes. Reading it as never
    // created would release a lease over them.
    expect(fakeKernel32({ lastError: ERROR_ACCESS_DENIED }).api.open("Local\\flywheel-owned-test")).toEqual({ kind: "unavailable", code: ERROR_ACCESS_DENIED })
  })
})
