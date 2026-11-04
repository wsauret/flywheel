import { describe, expect, spyOn, test } from "bun:test"

import { Log } from "../../../src/infra/log.js"
import type { BootIdentity, ProcessStart } from "../../../src/infra/process-container.js"
import {
  createProcessHolders,
  decodeHolderFields,
  decodeHolderText,
  encodeHolderText,
  type HolderKernel,
  type HolderState,
  type ProcessHolder,
} from "../../../src/infra/process-holder.js"

const BOOT = "2507fc47f1c3430b8bc31e1bc9887e94"
const OTHER_BOOT = "0123456789abcdef0123456789abcdef"
const HOLDER_PID = 4242

/** A kernel the test scripted: the start stamp each pid answers with, and the
 *  host boot. A pid nobody scripted holds no process. `asked` records every
 *  question, so a case can prove what was cached. */
function fakeKernel(options: {
  readonly starts?: { readonly [pid: number]: ProcessStart | (() => ProcessStart) }
  readonly boot?: BootIdentity | (() => BootIdentity)
}): HolderKernel & { readonly asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    start(pid) {
      asked.push(`start ${pid}`)
      const answer = options.starts?.[pid] ?? { kind: "absent" }
      return typeof answer === "function" ? answer() : answer
    },
    boot() {
      asked.push("boot")
      const answer = options.boot ?? { kind: "boot", id: BOOT }
      return typeof answer === "function" ? answer() : answer
    },
  }
}

const running = (start: string): ProcessStart => ({ kind: "process", start })

/** Answers `unproven` to the first two questions and `answer` to every later one. */
function failingTwice<T>(unproven: T, answer: T): () => T {
  let asked = 0
  return () => {
    asked += 1
    return asked > 2 ? answer : unproven
  }
}

const identified = (start: string, boot?: string): ProcessHolder => ({
  kind: "identified",
  pid: HOLDER_PID,
  identity: { v: 1, start, ...(boot === undefined ? {} : { boot }) },
})

describe("holder state", () => {
  test("proves a v1 holder alive only while its pid runs the same start in the same boot", () => {
    const cases: readonly { readonly name: string; readonly kernel: HolderKernel; readonly holder: ProcessHolder; readonly state: HolderState["kind"]; readonly proof?: Extract<HolderState, { readonly kind: "gone" }>["proof"] }[] = [
      { name: "same start and boot", kernel: fakeKernel({ starts: { [HOLDER_PID]: running("77") } }), holder: identified("77", BOOT), state: "alive" },
      { name: "another start", kernel: fakeKernel({ starts: { [HOLDER_PID]: running("78") } }), holder: identified("77", BOOT), state: "gone", proof: "another-process" },
      { name: "another boot", kernel: fakeKernel({ starts: { [HOLDER_PID]: running("77") } }), holder: identified("77", OTHER_BOOT), state: "gone", proof: "another-boot" },
      { name: "pid absent", kernel: fakeKernel({}), holder: identified("77", BOOT), state: "gone", proof: "absent" },
      { name: "no boot recorded", kernel: fakeKernel({ starts: { [HOLDER_PID]: running("77") } }), holder: identified("77"), state: "alive" },
      { name: "query unproven", kernel: fakeKernel({ starts: { [HOLDER_PID]: { kind: "unproven" } } }), holder: identified("77", BOOT), state: "unknown" },
      { name: "host boot unreadable", kernel: fakeKernel({ boot: { kind: "unproven" } }), holder: identified("77", BOOT), state: "unknown" },
      // A host that names no boot cannot tell whether a recorded one is its own.
      { name: "host names no boot", kernel: fakeKernel({ boot: { kind: "none" } }), holder: identified("77", BOOT), state: "unknown" },
    ]

    for (const { name, kernel, holder, state, proof } of cases) {
      const answer = createProcessHolders(kernel).state(holder)
      expect({ name, state: answer.kind, proof: answer.kind === "gone" ? answer.proof : undefined }).toEqual({ name, state, proof })
    }
  })

  test("proves a holder without identity gone only when its pid is absent", () => {
    const holder: ProcessHolder = { kind: "without-identity", pid: HOLDER_PID }

    expect(createProcessHolders(fakeKernel({})).state(holder)).toEqual({ kind: "gone", proof: "absent" })
    expect(createProcessHolders(fakeKernel({ starts: { [HOLDER_PID]: running("1") } })).state(holder)).toEqual({ kind: "alive" })
    expect(createProcessHolders(fakeKernel({ starts: { [HOLDER_PID]: { kind: "unproven" } } })).state(holder).kind).toBe("unknown")
  })

  test("reads an identity this build cannot read as unknown and never gone, and warns once per version", () => {
    const warn = spyOn(Log.create({ service: "process-holder" }), "warn").mockImplementation(() => {})
    try {
      // The pid is free, so a record this build could read would be gone.
      const holders = createProcessHolders(fakeKernel({}))
      const unreadable = [
        decodeHolderFields(HOLDER_PID, { v: 2, start: "5" }),
        decodeHolderFields(HOLDER_PID, { v: 1, start: "not-a-decimal" }),
      ]

      for (const holder of [...unreadable, ...unreadable]) expect(holders.state(holder).kind).toBe("unknown")
      expect(warn.mock.calls.map(([, fields]) => fields?.version)).toEqual(["2", "1"])
    } finally {
      warn.mockRestore()
    }
  })
})

describe("own identity", () => {
  test("stamps this process with its start and the host boot", () => {
    const holders = createProcessHolders(fakeKernel({ starts: { [process.pid]: running("901") } }))

    expect(holders.own()).toEqual({ v: 1, start: "901", boot: BOOT })
  })

  test("records no boot on a host whose kernel names none", () => {
    const holders = createProcessHolders(fakeKernel({ starts: { [process.pid]: running("901") }, boot: { kind: "none" } }))

    expect(holders.own()).toEqual({ v: 1, start: "901" })
  })

  // A process without its identity still writes its records, which name its
  // pid alone, so its locks, claims, and holders never refuse for it.
  test("answers no identity while a read fails, warns once per process with the reason, asks again on the next call, and caches only a success", () => {
    const kernels = [
      { kernel: fakeKernel({ starts: { [process.pid]: failingTwice<ProcessStart>({ kind: "unproven" }, running("901")) } }), reason: "the kernel did not answer for this process's start stamp" },
      { kernel: fakeKernel({ starts: { [process.pid]: running("901") }, boot: failingTwice<BootIdentity>({ kind: "unproven" }, { kind: "boot", id: BOOT }) }), reason: "this host's boot identity could not be read" },
    ]

    for (const { kernel, reason } of kernels) {
      const warn = spyOn(Log.create({ service: "process-holder" }), "warn").mockImplementation(() => {})
      try {
        const holders = createProcessHolders(kernel)

        expect(holders.own()).toBeUndefined()
        expect(holders.own()).toBeUndefined()
        expect(warn.mock.calls.map(([, fields]) => fields?.reason)).toEqual([reason])
        expect(holders.own()).toEqual({ v: 1, start: "901", boot: BOOT })
        const asked = kernel.asked.length
        expect(holders.own()).toEqual({ v: 1, start: "901", boot: BOOT })
        expect(kernel.asked).toHaveLength(asked)
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    }
  })
})

describe("owner record text", () => {
  test("fits the largest pid, the largest start, and a boot in 63 bytes that an earlier build still reads as the pid", () => {
    const text = encodeHolderText(4_194_304, { v: 1, start: "18446744073709551615", boot: BOOT })

    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(63)
    // oxlint-disable-next-line unicorn/prefer-number-coercion -- the earlier build parses the leading digits only, which Number() does not
    expect(Number.parseInt(text, 10)).toBe(4_194_304)
    expect(decodeHolderText(text)).toEqual({ kind: "identified", pid: 4_194_304, identity: { v: 1, start: "18446744073709551615", boot: BOOT } })
  })

  test("decodes a bare decimal as a holder without identity, and an unknown version as unreadable", () => {
    expect(decodeHolderText("4242")).toEqual({ kind: "without-identity", pid: 4242 })
    expect(decodeHolderText("12 9 5 ab")).toEqual({ kind: "unreadable-identity", pid: 12, version: "9" })
    expect(decodeHolderText("12 1 5 notaboot")).toEqual({ kind: "unreadable-identity", pid: 12, version: "1" })
  })

  test("decodes text whose leading token is not a positive integer as garbled", () => {
    for (const text of ["", "abc", "0", "-3", "12abc 1 5"]) expect(decodeHolderText(text)).toBeUndefined()
  })
})

describe("holder record fields", () => {
  test("decodes a record without v as a holder without identity, and v1 fields as its identity", () => {
    expect(decodeHolderFields(HOLDER_PID, {})).toEqual({ kind: "without-identity", pid: HOLDER_PID })
    expect(decodeHolderFields(HOLDER_PID, { v: 1, start: "77", boot: BOOT })).toEqual(identified("77", BOOT))
    expect(decodeHolderFields(HOLDER_PID, { v: 1, start: "77" })).toEqual(identified("77"))
  })
})
