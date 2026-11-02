import { describe, expect, test } from "bun:test"
import { type Pointer, toArrayBuffer } from "bun:ffi"

import { createWindowsProcessApi, windowsProcessApi } from "../../../src/infra/windows-process-api.js"

const ERROR_ACCESS_DENIED = 5
const ERROR_INVALID_PARAMETER = 87
// `STATUS_ACCESS_DENIED`, 0xC0000022, as the signed 32-bit value the call returns.
const STATUS_ACCESS_DENIED = -1_073_741_790

/** A target process's memory as the kernel lays it out on x64: the PEB names
 *  the process parameters at 0x20, and those name the environment block at
 *  0x80 and its size in bytes at 0x3f0. */
function processMemory(environment: string, environmentSize = environment.length * 2): ReadonlyMap<bigint, Uint8Array> {
  const peb = new Uint8Array(0x28)
  new DataView(peb.buffer).setBigUint64(0x20, 0x2000n, true)
  const parameters = new Uint8Array(0x3f8)
  new DataView(parameters.buffer).setBigUint64(0x80, 0x3000n, true)
  new DataView(parameters.buffer).setBigUint64(0x3f0, BigInt(environmentSize), true)
  return new Map([[0x1000n, peb], [0x2000n, parameters], [0x3000n, new Uint8Array(Buffer.from(environment, "utf16le"))]])
}

/** The kernel32 calls this module makes, scripted. The real library is only
 *  present on Windows, and what needs proving here is the mapping from return
 *  values and error codes to answers, which is platform-independent. */
function fakeKernel32(script: {
  readonly handle?: number
  readonly lastError?: number
  readonly timesWritten?: boolean
  readonly created?: bigint
  readonly exited?: bigint
  readonly snapshot?: number
  readonly rows?: readonly { readonly pid: number; readonly parentPid: number }[]
  readonly workingSet?: bigint
  /** The address `NtQueryInformationProcess` states for the PEB, or nothing
   *  for a refused query. */
  readonly peb?: bigint
  /** The target's memory: each region's start address and its bytes. */
  readonly memory?: ReadonlyMap<bigint, Uint8Array>
  /** What `TerminateProcess` answers; it succeeds unless told otherwise. */
  readonly terminates?: boolean
  /** The FILETIME `GetSystemTimeAsFileTime` writes. */
  readonly systemTime?: bigint
}) {
  const closed: number[] = []
  const access: number[] = []
  const terminated: string[] = []
  let index = 0
  const symbols = {
    OpenProcess: (desired: number) => { access.push(desired); return script.handle ?? 0 },
    GetLastError: () => script.lastError ?? 0,
    GetProcessTimes: (_handle: number, created: Pointer, exited: Pointer) => {
      if (script.timesWritten === false) return 0
      // The call writes through the pointers the caller allocated.
      new BigUint64Array(toArrayBuffer(created, 0, 8))[0] = script.created ?? 0n
      new BigUint64Array(toArrayBuffer(exited, 0, 8))[0] = script.exited ?? 0n
      return 1
    },
    CloseHandle: (handle: number) => { closed.push(handle); return 1 },
    TerminateProcess: (handle: number, exitCode: number) => {
      terminated.push(`${handle} ${exitCode}`)
      return script.terminates === false ? 0 : 1
    },
    GetSystemTimeAsFileTime: (time: Pointer) => { new BigUint64Array(toArrayBuffer(time, 0, 8))[0] = script.systemTime ?? 0n },
    CreateToolhelp32Snapshot: () => script.snapshot ?? 1,
    Process32FirstW: (_snapshot: number, entry: Pointer) => {
      index = 0
      return writeRow(entry)
    },
    Process32NextW: (_snapshot: number, entry: Pointer) => writeRow(entry),
    K32GetProcessMemoryInfo: (_handle: number, counters: Pointer, size: number) => {
      if (script.workingSet === undefined) return 0
      const view = new DataView(toArrayBuffer(counters, 0, size))
      expect(view.getUint32(0, true)).toBe(size)
      view.setBigUint64(16, script.workingSet, true)
      return 1
    },
    ReadProcessMemory: (_handle: number, address: bigint, buffer: Pointer, size: bigint) => {
      for (const [start, bytes] of script.memory ?? []) {
        const offset = Number(address - start)
        if (offset < 0 || offset + Number(size) > bytes.byteLength) continue
        new Uint8Array(toArrayBuffer(buffer, 0, Number(size))).set(bytes.subarray(offset, offset + Number(size)))
        return 1
      }
      return 0
    },
  }
  const ntdll = {
    NtQueryInformationProcess: (_handle: number, informationClass: number, information: Pointer, size: number) => {
      expect(informationClass).toBe(0)
      if (script.peb === undefined) return STATUS_ACCESS_DENIED
      new DataView(toArrayBuffer(information, 0, size)).setBigUint64(8, script.peb, true)
      return 0
    },
  }
  function writeRow(entry: Pointer): number {
    const rows = script.rows ?? []
    const row = rows[index]
    index += 1
    if (row === undefined) return 0
    const view = new DataView(toArrayBuffer(entry, 0, 568))
    view.setUint32(8, row.pid, true)
    view.setUint32(32, row.parentPid, true)
    return 1
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a dlopen result's type brands each symbol and returned pointer with private tags that only dlopen produces, so a scripted stand-in cannot carry it
  return { api: createWindowsProcessApi({ symbols } as never, { symbols: ntdll } as never), closed, access, terminated }
}

describe("windows process api", () => {
  test("reads a creation time as the process identity", () => {
    const { api, closed } = fakeKernel32({ handle: 42, created: 134320076628883394n })

    expect(api.query(1234)).toEqual({ kind: "process", createdFileTime: 134320076628883394n })
    // A handle is a leak if it is not closed, and this runs per probe.
    expect(closed).toEqual([42])
  })

  test("reads an exited process as absent, however openable its handle still is", () => {
    // Windows keeps a process openable until its last handle closes, so a
    // container asking whether it is empty would otherwise be told its own
    // terminated members are alive.
    const { api, closed } = fakeKernel32({ handle: 42, created: 134320076628883394n, exited: 134320076700000000n })

    expect(api.query(1234)).toEqual({ kind: "absent" })
    expect(closed).toEqual([42])
  })

  test("proves an absence only for the error that means no such pid", () => {
    expect(fakeKernel32({ handle: 0, lastError: ERROR_INVALID_PARAMETER }).api.query(999999)).toEqual({ kind: "absent" })
  })

  test("reports a process that refuses examination as present but unproven", () => {
    // A protected process exists. Reading "denied" as "absent" would license a
    // kill against a pid this side never proved anything about.
    expect(fakeKernel32({ handle: 0, lastError: ERROR_ACCESS_DENIED }).api.query(4)).toEqual({ kind: "denied" })
  })

  test("reports an unrecognized failure as unavailable rather than absent", () => {
    expect(fakeKernel32({ handle: 0, lastError: 1450 }).api.query(1234)).toEqual({ kind: "unavailable" })
  })

  test("reports a creation time it could not read as unavailable", () => {
    expect(fakeKernel32({ handle: 7, timesWritten: false }).api.query(1234)).toEqual({ kind: "unavailable" })
  })

  test("reads the time the kernel keeps as a FILETIME, the unit a creation time is stated in", () => {
    expect(fakeKernel32({ systemTime: 134320076628883394n }).api.now()).toBe(134320076628883394n)
  })

  test("ends a process only through a handle whose creation time matches the one it was given", () => {
    const { api, closed, access, terminated } = fakeKernel32({ handle: 42, created: 134320076628883394n })

    expect(api.terminate(1234, 134320076628883394n)).toEqual({ kind: "ended" })
    // One handle carries both the check and the kill, so a pid recycled
    // between the two can never be the process that is ended.
    expect(access).toEqual([0x1001])
    expect(terminated).toEqual(["42 1"])
    expect(closed).toEqual([42])
  })

  test("ends nothing at a pid that holds another process, has exited, or cannot be proven", () => {
    const cases = [
      { script: { handle: 42, created: 134320076628883394n }, answer: { kind: "other" }, killed: [] },
      { script: { handle: 42, created: 134320076628883395n, exited: 134320076700000000n }, answer: { kind: "absent" }, killed: [] },
      { script: { handle: 42, timesWritten: false }, answer: { kind: "unproven" }, killed: [] },
      // A kill the kernel refused proves nothing about the process.
      { script: { handle: 42, created: 134320076628883395n, terminates: false }, answer: { kind: "unproven" }, killed: ["42 1"] },
    ] as const
    for (const { script, answer, killed } of cases) {
      const { api, closed, terminated } = fakeKernel32(script)
      expect(api.terminate(1234, 134320076628883395n)).toEqual(answer)
      expect(terminated).toEqual([...killed])
      // Every handle opened is closed, whatever the answer.
      expect(closed).toEqual([42])
    }
  })

  test("proves an absence at terminate only for the error that means no such pid", () => {
    expect(fakeKernel32({ handle: 0, lastError: ERROR_INVALID_PARAMETER }).api.terminate(999999, 1n)).toEqual({ kind: "absent" })
    // A protected process exists, and a kill it refused ended nothing.
    expect(fakeKernel32({ handle: 0, lastError: ERROR_ACCESS_DENIED }).api.terminate(4, 1n)).toEqual({ kind: "unproven" })
  })

  test("walks the process table into pid and parent pid rows", () => {
    const rows = [{ pid: 4, parentPid: 0 }, { pid: 1234, parentPid: 4 }, { pid: 5678, parentPid: 1234 }]
    const { api, closed } = fakeKernel32({ snapshot: 9, rows })

    expect(api.list()).toEqual(rows)
    expect(closed).toEqual([9])
  })

  test("reads a process's working set in bytes, and nothing when it cannot be examined", () => {
    const { api, closed } = fakeKernel32({ handle: 9, workingSet: 123_456_789n })
    expect(api.workingSetBytes(4242)).toBe(123_456_789)
    expect(closed).toEqual([9])
    expect(fakeKernel32({ handle: 9 }).api.workingSetBytes(4242)).toBeUndefined()
    expect(fakeKernel32({ handle: 0, lastError: ERROR_ACCESS_DENIED }).api.workingSetBytes(4242)).toBeUndefined()
  })

  test("reads a process's environment block from its process parameters", () => {
    const { api, closed, access } = fakeKernel32({ handle: 9, peb: 0x1000n, memory: processMemory("=C:=C:\\Work\0HOME=C:\\Users\\Jo\0PATH=C:\\Windows\0\0") })
    expect(api.environment(4242)).toEqual(["=C:=C:\\Work", "HOME=C:\\Users\\Jo", "PATH=C:\\Windows"])
    // Query-limited and memory-read access only, and the handle is closed.
    expect(access).toEqual([0x1010])
    expect(closed).toEqual([9])
  })

  test("reads no environment from a process it cannot open, query, or read", () => {
    expect(fakeKernel32({ handle: 0, lastError: ERROR_ACCESS_DENIED }).api.environment(4242)).toBeUndefined()
    expect(fakeKernel32({ handle: 9, memory: processMemory("HOME=C:\\x\0\0") }).api.environment(4242)).toBeUndefined()
    expect(fakeKernel32({ handle: 9, peb: 0x1000n }).api.environment(4242)).toBeUndefined()
    // A block cut short may end in a prefix of a value, so it proves nothing.
    expect(fakeKernel32({ handle: 9, peb: 0x1000n, memory: processMemory("HOME=C:\\Users\\meg\0\0", 30) }).api.environment(4242)).toBeUndefined()
    // A stated size larger than the block that is there is a failed read, not a short block.
    expect(fakeKernel32({ handle: 9, peb: 0x1000n, memory: processMemory("HOME=C:\\x\0\0", 4096) }).api.environment(4242)).toBeUndefined()
  })

  test("reports a failed snapshot as nothing, never as an empty table", () => {
    // An empty table would read as "every process is gone", which is the one
    // conclusion a failed probe must never support.
    expect(fakeKernel32({ snapshot: -1, rows: [] }).api.list()).toBeUndefined()
    expect(fakeKernel32({ snapshot: 9, rows: [] }).api.list()).toBeUndefined()
  })
})

describe("windows process api on this host", () => {
  const api = windowsProcessApi()

  test.skipIf(process.platform !== "win32")("is available on Windows and identifies this process", () => {
    const query = api?.query(process.pid)

    expect(query?.kind).toBe("process")
    if (query?.kind === "process") expect(query.createdFileTime).toBeGreaterThan(0n)
  })

  test.skipIf(process.platform !== "win32")("finds this process in the table with its real parent", () => {
    const rows = api?.list()
    const self = rows?.find((row) => row.pid === process.pid)

    expect(self).toBeDefined()
    expect(self?.parentPid).toBeGreaterThan(0)
    // The parent must itself be a process, which is what makes a tree walk
    // from a root meaningful.
    expect(api?.query(self?.parentPid ?? 0).kind).toBe("process")
  })

  test.skipIf(process.platform === "win32")("is absent on platforms that answer without it", () => {
    expect(api).toBeUndefined()
  })
})
