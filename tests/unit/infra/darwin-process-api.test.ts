import { describe, expect, test } from "bun:test"

import { createDarwinProcessApi, type LibprocCalls } from "../../../src/infra/darwin-process-api.js"

const EPERM = 1
const ENOENT = 2
const ESRCH = 3
const EINVAL = 22

/** One call's scripted answer: what the kernel writes, or the errno the call
 *  fails with. */
type Answer<T> = T | { readonly errno: number }

interface ShortInfo {
  readonly pgid: number
  readonly ppid?: number
  readonly status?: number
  /** The pid the kernel writes back, when it is not the pid asked about. */
  readonly writtenPid?: number
}

/** libproc as bookkeeping: a synthetic `struct proc_bsdshortinfo` and `struct
 *  proc_uniqidentifierinfo` per pid, laid out at the offsets the kernel uses,
 *  or an errno for a failed call. A pid with no script fails without setting
 *  errno, which is how a stale code left by an earlier call is tested. */
function fakeCalls(options: {
  readonly short?: { readonly [pid: number]: Answer<ShortInfo> }
  /** The answers of successive unique-id calls for a pid; the last repeats. */
  readonly unique?: { readonly [pid: number]: readonly Answer<bigint>[] }
  readonly written?: number
  readonly groups?: { readonly [pgid: number]: readonly number[] }
  readonly groupErrnos?: { readonly [pgid: number]: number }
  /** The path `proc_pidpath` writes for a pid, or the errno it fails with. */
  readonly executables?: { readonly [pid: number]: Answer<string> }
  readonly arguments?: { readonly [pid: number]: Uint8Array }
  /** The text `kern.bootsessionuuid` answers, or the errno it fails with. */
  readonly boot?: Answer<string>
} = {}): LibprocCalls & { readonly listings: number[]; readonly log: string[] } {
  let errno = 0
  const listings: number[] = []
  const log: string[] = []
  const uniqueCalls = new Map<number, number>()
  const fail = (code: number | undefined): number => {
    if (code !== undefined) errno = code
    return 0
  }
  return {
    listings,
    log,
    shortInfo(pid, buffer) {
      log.push(`short ${pid}`)
      const answer = options.short?.[pid]
      if (answer === undefined) return fail(undefined)
      if ("errno" in answer) return fail(answer.errno)
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      view.setUint32(0, answer.writtenPid ?? pid, true)
      view.setUint32(4, answer.ppid ?? 1, true)
      view.setUint32(8, answer.pgid, true)
      view.setUint32(12, answer.status ?? 2, true)
      return options.written ?? buffer.byteLength
    },
    uniqueInfo(pid, buffer) {
      log.push(`unique ${pid}`)
      const answers = options.unique?.[pid] ?? []
      const call = uniqueCalls.get(pid) ?? 0
      uniqueCalls.set(pid, call + 1)
      const answer = answers[Math.min(call, answers.length - 1)]
      if (answer === undefined) return fail(undefined)
      if (typeof answer !== "bigint") return fail(answer.errno)
      new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setBigUint64(16, answer, true)
      return buffer.byteLength
    },
    groupPids(pgid, buffer) {
      listings.push(buffer.length)
      const code = options.groupErrnos?.[pgid]
      if (code !== undefined) return fail(code)
      const members = options.groups?.[pgid] ?? []
      buffer.set(members.slice(0, buffer.length))
      return Math.min(members.length, buffer.length)
    },
    allPids: () => -1,
    childPids: () => -1,
    executablePath(pid, buffer) {
      const executable = options.executables?.[pid]
      if (executable === undefined) return fail(undefined)
      if (typeof executable !== "string") return fail(executable.errno)
      const { written } = new TextEncoder().encodeInto(executable, buffer)
      return written
    },
    processArguments: (pid) => options.arguments?.[pid],
    bootSession(buffer) {
      const answer = options.boot
      if (answer === undefined) return fail(undefined)
      if (typeof answer !== "string") return fail(answer.errno)
      // sysctl writes a string value with its terminator.
      return new TextEncoder().encodeInto(`${answer}\0`, buffer).written
    },
    resourceUsage: () => -1,
    taskInfo: () => 0,
    errno: () => errno,
    clearErrno: () => { errno = 0 },
  }
}

describe("libproc process query", () => {
  test("identifies a process by pid, group and the kernel's unique id, read before and after the short info, and stamps its start with the unique id and its parent from the short info", () => {
    const calls = fakeCalls({ short: { 4242: { pgid: 4200, ppid: 4100 } }, unique: { 4242: [22_643_135n] } })

    expect(createDarwinProcessApi(calls).query(4242)).toEqual({ kind: "process", pgid: 4200, ppid: 4100, identity: "4242 4200 22643135", start: "22643135" })
    expect(calls.log).toEqual(["unique 4242", "short 4242", "unique 4242"])
  })

  test("proves nothing when the pid passed to another process between the reads", () => {
    const api = createDarwinProcessApi(fakeCalls({ short: { 4242: { pgid: 4242 } }, unique: { 4242: [1n, 2n] } }))

    expect(api.query(4242)).toEqual({ kind: "unavailable" })
  })

  test("reads ESRCH on any of the three calls as an absence, which is how the kernel answers for an unreaped exit too", () => {
    const beforeShort = createDarwinProcessApi(fakeCalls({ unique: { 4242: [{ errno: ESRCH }] } }))
    const atShort = createDarwinProcessApi(fakeCalls({ short: { 4242: { errno: ESRCH } }, unique: { 4242: [1n] } }))
    const afterShort = createDarwinProcessApi(fakeCalls({ short: { 4242: { pgid: 4242 } }, unique: { 4242: [1n, { errno: ESRCH }] } }))

    expect(beforeShort.query(4242)).toEqual({ kind: "absent" })
    expect(atShort.query(4242)).toEqual({ kind: "absent" })
    expect(afterShort.query(4242)).toEqual({ kind: "absent" })
  })

  test("reads an exited process whose status is still held as an absence", () => {
    const api = createDarwinProcessApi(fakeCalls({ short: { 4242: { pgid: 4242, status: 5 } }, unique: { 4242: [1n] } }))

    expect(api.query(4242)).toEqual({ kind: "absent" })
  })

  test("proves nothing when a call failed for any other reason or left a stale errno", () => {
    // A failed call whose errno this side did not set: an ESRCH left by an
    // earlier call must never read as this call's absence.
    const api = createDarwinProcessApi(fakeCalls({
      short: { 4244: { pgid: 4244 }, 4245: { errno: EINVAL } },
      unique: { 4242: [{ errno: ESRCH }], 4243: [{ errno: EINVAL }], 4244: [1n, { errno: EINVAL }], 4245: [1n] },
    }))

    expect(api.query(4242)).toEqual({ kind: "absent" })
    expect(api.query(9999)).toEqual({ kind: "unavailable" })
    expect(api.query(4243)).toEqual({ kind: "unavailable" })
    expect(api.query(4244)).toEqual({ kind: "unavailable" })
    expect(api.query(4245)).toEqual({ kind: "unavailable" })
  })

  test("proves nothing from a struct the kernel did not fill or filled for another pid", () => {
    const short = createDarwinProcessApi(fakeCalls({ written: 32, short: { 4242: { pgid: 4242 } }, unique: { 4242: [1n] } }))
    const other = createDarwinProcessApi(fakeCalls({ short: { 4242: { pgid: 4242, writtenPid: 4243 } }, unique: { 4242: [1n] } }))

    expect(short.query(4242)).toEqual({ kind: "unavailable" })
    expect(other.query(4242)).toEqual({ kind: "unavailable" })
  })
})

describe("libproc group listing", () => {
  test("lists every pid the group holds", () => {
    const api = createDarwinProcessApi(fakeCalls({ groups: { 4242: [4242, 4243, 4244] } }))

    expect(api.group(4242)).toEqual([4242, 4243, 4244])
  })

  test("reads a zero count with errno clear as a group that holds nothing", () => {
    // The kernel answers an empty group and a group that does not exist alike:
    // no pid written, no error.
    expect(createDarwinProcessApi(fakeCalls()).group(9999)).toEqual([])
  })

  test("clears the ESRCH an earlier query left, so an empty group never reads as a failed listing", () => {
    const api = createDarwinProcessApi(fakeCalls({ unique: { 4242: [{ errno: ESRCH }] } }))

    expect(api.query(4242)).toEqual({ kind: "absent" })
    expect(api.group(9999)).toEqual([])
  })

  test("grows the buffer until the listing no longer fills it, so no member is hidden", () => {
    const members = Array.from({ length: 1500 }, (_, index) => 10_000 + index)
    const calls = fakeCalls({ groups: { 4242: members } })

    expect(createDarwinProcessApi(calls).group(4242)).toEqual(members)
    expect(calls.listings).toEqual([1024, 2048])
  })

  test("proves nothing when the listing failed, which the kernel reports as a zero count with errno set", () => {
    expect(createDarwinProcessApi(fakeCalls({ groupErrnos: { 4242: EINVAL } })).group(4242)).toBeUndefined()
  })
})

describe("libproc executable path", () => {
  test("names the executable a process runs", () => {
    const api = createDarwinProcessApi(fakeCalls({ executables: { 4242: "/Users/test/.flywheel/launcher/Flywheel.app/Contents/MacOS/Flywheel" } }))

    expect(api.executable(4242)).toEqual({ kind: "path", path: "/Users/test/.flywheel/launcher/Flywheel.app/Contents/MacOS/Flywheel" })
  })

  test("reads ESRCH as an absence, and any other failure as a call that proves nothing", () => {
    const api = createDarwinProcessApi(fakeCalls({ executables: { 4242: { errno: ESRCH }, 4343: { errno: EPERM } } }))

    expect(api.executable(4242)).toEqual({ kind: "absent" })
    expect(api.executable(4343)).toEqual({ kind: "unavailable" })
    // A call that fails without setting errno leaves no code of its own, and
    // a code an earlier call left must not read as this call's.
    expect(api.executable(4242)).toEqual({ kind: "absent" })
    expect(api.executable(9999)).toEqual({ kind: "unavailable" })
  })
})

describe("libproc boot session", () => {
  test("names the boot by the kernel's session UUID, as 32 lowercase hex characters", () => {
    const api = createDarwinProcessApi(fakeCalls({ boot: "2507FC47-F1C3-430B-8BC3-1E1BC9887E94" }))

    expect(api.bootSession()).toEqual({ kind: "boot", id: "2507fc47f1c3430b8bc31e1bc9887e94" })
  })

  test("reads ENOENT as a kernel that names no boot", () => {
    expect(createDarwinProcessApi(fakeCalls({ boot: { errno: ENOENT } })).bootSession()).toEqual({ kind: "none" })
  })

  test("proves nothing when the call failed for another reason or answered bytes that are not a UUID", () => {
    expect(createDarwinProcessApi(fakeCalls({ boot: { errno: EINVAL } })).bootSession()).toBeUndefined()
    expect(createDarwinProcessApi(fakeCalls()).bootSession()).toBeUndefined()
    expect(createDarwinProcessApi(fakeCalls({ boot: "not a boot session" })).bootSession()).toBeUndefined()
  })
})

/** The bytes `sysctl(KERN_PROCARGS2)` answers, laid out as the kernel lays
 *  them out: argc, the executable path, NUL padding, the arguments, the
 *  environment, and the loader's own strings after an empty one. */
function processArguments(argv: readonly string[], environment: readonly string[]): Uint8Array {
  const text = ["/usr/local/bin/tool", "", "", "", ...argv, ...environment, "", "executable_path=/usr/local/bin/tool", ""].join("\0")
  const strings = new TextEncoder().encode(text)
  const bytes = new Uint8Array(4 + strings.byteLength)
  new DataView(bytes.buffer).setInt32(0, argv.length, true)
  bytes.set(strings, 4)
  return bytes
}

describe("kernel process arguments and environment", () => {
  test("reads the arguments and environment the process started with, before the loader's strings", () => {
    const api = createDarwinProcessApi(fakeCalls({ arguments: { 4242: processArguments(["flywheel-bin", "HOME=not-a-variable", "/a path/serve", ""], ["PATH=/usr/bin", "HOME=/Users/test"]) } }))

    expect(api.processArguments(4242)).toEqual({
      argv: ["flywheel-bin", "HOME=not-a-variable", "/a path/serve", ""],
      environment: ["PATH=/usr/bin", "HOME=/Users/test"],
    })
    expect(api.environment(4242)).toEqual(["PATH=/usr/bin", "HOME=/Users/test"])
  })

  test("proves nothing when the kernel answers nothing or answers bytes too short to hold the arguments", () => {
    const truncated = processArguments(["flywheel-bin", "serve"], []).subarray(0, 12)
    const api = createDarwinProcessApi(fakeCalls({ arguments: { 7: truncated } }))

    expect(api.environment(9999)).toBeUndefined()
    expect(api.environment(7)).toBeUndefined()
    expect(api.processArguments(9999)).toBeUndefined()
    expect(api.processArguments(7)).toBeUndefined()
  })
})
