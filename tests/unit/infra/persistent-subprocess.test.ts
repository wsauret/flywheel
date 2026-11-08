import { describe, expect, test } from "bun:test"

import {
  launchPersistentSubprocess,
  type PosixPersistentSubprocessPlatform,
  type WindowsPersistentSubprocessPlatform,
} from "../../../src/infra/persistent-subprocess.js"
import type { SpoolHolders } from "../../../src/infra/persistent-spool.js"
import { CONTAINER_MARK_VARIABLE, STRICT_DESCENDANT_SETTLEMENT_VARIABLE, enableStrictDescendantSettlement } from "../../../src/infra/container-mark.js"
import type { ProcessIdentity } from "../../../src/infra/process-container.js"

const command = ["bun", "fixture.ts"] as const
const spool = { directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr", stdoutFd: 7, stderrFd: 8 }

function posixPlatform(overrides: Partial<PosixPersistentSubprocessPlatform> = {}): PosixPersistentSubprocessPlatform {
  return {
    kind: "posix",
    createSpool: () => spool,
    closeSpool: async () => {},
    launch: async () => ({
      pid: 42,
      exited: new Promise<number>(() => {}),
      control: { drained: Promise.resolve(), write: async () => {}, close: async () => {} },
      unref: () => {},
    }),
    waitForSupervisorExit: async (child) => { await child.exited; return true },
    inspect: async (pid) => ({ kind: "process", identity: `${pid}:born` }),
    holdSpool: () => {},
    removeSpool: () => {},
    sweepSpools: async () => {},
    cleanup: () => {},
    spoolBytes: () => 0,
    now: () => 0,
    ...overrides,
  }
}

function defaultPlatform(overrides: Partial<WindowsPersistentSubprocessPlatform> = {}): WindowsPersistentSubprocessPlatform {
  return {
    kind: "windows",
    createSpool: () => spool,
    closeSpool: async () => {},
    launch: async () => ({ pid: 42, exited: new Promise<number>(() => {}), unref: () => {} }),
    inspect: async () => ({ kind: "process", identity: "42:born" }),
    stopContainer: async () => {},
    holdSpool: () => {},
    removeSpool: () => {},
    sweepSpools: async () => {},
    cleanup: () => {},
    spoolBytes: (path) => path.endsWith("stdout") ? 12 : 4,
    now: () => 0,
    ...overrides,
  }
}

describe("persistent subprocess", () => {
  test.each(["posix", "windows", "self-managed"] as const)("preserves the %s persistent exemption inside strict context", async (kind) => {
    const previous = process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE]
    try {
      enableStrictDescendantSettlement()
      const launch = async (request: Parameters<PosixPersistentSubprocessPlatform["launch"]>[0]) => {
        expect(request.env?.[STRICT_DESCENDANT_SETTLEMENT_VARIABLE]).toBeUndefined()
        if (kind !== "posix") expect(request.env?.[CONTAINER_MARK_VARIABLE]).toBeUndefined()
        return {
          pid: 42, exited: new Promise<number>(() => {}), unref: () => {},
          control: { drained: Promise.resolve(), write: async () => {}, close: async () => {} },
        }
      }
      await launchPersistentSubprocess(command, {
        platform: kind === "windows" ? defaultPlatform({ launch }) : posixPlatform({ launch }),
        selfManaged: kind === "self-managed",
        env: { PATH: "/bin", [CONTAINER_MARK_VARIABLE]: "owned:outer", [STRICT_DESCENDANT_SETTLEMENT_VARIABLE]: process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] },
      })
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, STRICT_DESCENDANT_SETTLEMENT_VARIABLE)
      else process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] = previous
    }
  })
  test("admits the persistent supervisor through its retained control channel", async () => {
    const words: string[] = []
    let request: Parameters<PosixPersistentSubprocessPlatform["launch"]>[0] | undefined
    const platform = posixPlatform({
      launch: async (input) => {
        request = input
        return {
          pid: 42,
          exited: new Promise<number>(() => {}),
          control: { drained: Promise.resolve(), write: async (word) => { words.push(word) }, close: async () => {} },
          unref: () => {},
        }
      },
    })

    await launchPersistentSubprocess(command, { platform })

    expect(request?.command).toContain("--lifetime")
    expect(request?.command).toContain("persistent")
    expect(words).toEqual(["go"])
    // The supervisor is a container of its own, so a stop reaches what it
    // started by its own mark, never by the mark of its launcher's container.
    expect(request?.env?.[CONTAINER_MARK_VARIABLE]).toMatch(/^persistent:/)
  })

  test("spawns the process in the caller's turn, before any other work can run", async () => {
    // A client starts the account service and then imports its interface
    // synchronously. A spawn that waited for a later turn waited for that
    // whole import, which held the service start back on every cold start.
    let spawned = false
    const launched = launchPersistentSubprocess(command, {
      selfManaged: true,
      platform: posixPlatform({
        launch: async () => {
          spawned = true
          return { pid: 42, exited: new Promise<number>(() => {}), control: { drained: Promise.resolve(), write: async () => {}, close: async () => {} }, unref: () => {} }
        },
      }),
    })

    expect(spawned).toBe(true)
    await launched
  })

  test("persistent stop uses the admitted channel and awaits supervisor settlement", async () => {
    const events: string[] = []
    let settle: ((code: number) => void) | undefined
    const exited = new Promise<number>((resolve) => { settle = resolve })
    const drain = Promise.withResolvers<void>()
    const process = await launchPersistentSubprocess(command, {
      platform: posixPlatform({
        launch: async () => ({
          pid: 42,
          exited,
          control: {
            drained: drain.promise,
            write: async (word) => { events.push(word) },
            close: async () => { events.push("closed") },
          },
          unref: () => {},
        }),
        waitForSupervisorExit: async (child) => { await child.exited; return true },
      }),
    })

    const stopping = process.stop()
    await Bun.sleep(0)
    expect(events).toEqual(["go", "stop"])
    let settled = false
    void stopping.then(() => { settled = true })
    await Bun.sleep(0)
    expect(settled).toBe(false)

    settle?.(143)
    await Bun.sleep(0)
    expect(settled).toBe(false)
    expect(events).toEqual(["go", "stop"])
    drain.resolve()
    expect(await stopping).toBe("terminated")
    await Bun.sleep(0)
    expect(events).toEqual(["go", "stop", "closed"])
  })

  test("retains POSIX control after an unsettled stop and retries the same supervisor", async () => {
    const words: string[] = []
    let attempts = 0
    const process = await launchPersistentSubprocess(command, {
      platform: posixPlatform({
        launch: async () => ({
          pid: 42,
          exited: new Promise<number>(() => {}),
          control: { drained: Promise.resolve(), write: async (word) => { words.push(word) }, close: async () => { words.push("closed") } },
          unref: () => {},
        }),
        waitForSupervisorExit: async () => ++attempts > 1,
      }),
    })

    expect(await process.stop()).toBe("unsettled")
    expect(words).toEqual(["go", "stop"])
    expect(await process.stop()).toBe("terminated")
    expect(words).toEqual(["go", "stop", "stop"])
  })

  test("a stop after the supervisor exited sends no word over the closed control channel", async () => {
    // The exit closes the control descriptor, and POSIX gives its number to
    // the next file the host opens, so a later word lands in that file.
    const events: string[] = []
    let exit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => { exit = resolve })
    const persistent = await launchPersistentSubprocess(command, {
      platform: posixPlatform({
        launch: async () => ({
          pid: 42,
          exited,
          control: { drained: Promise.resolve(), write: async (word) => { events.push(word) }, close: async () => { events.push("closed") } },
          unref: () => {},
        }),
      }),
    })

    exit(0)
    await persistent.exited
    expect(await persistent.stop()).toBe("terminated")
    expect(events).toEqual(["go", "closed"])
  })

  test("failed admission closes control, awaits refusal, and invokes cleanup", async () => {
    const events: string[] = []
    let settle: ((code: number) => void) | undefined
    const exited = new Promise<number>((resolve) => { settle = resolve })
    const launched = launchPersistentSubprocess(command, {
      platform: posixPlatform({
        launch: async () => ({
          pid: 42,
          exited,
          control: {
            drained: Promise.resolve(),
            write: async () => { throw new Error("admission failed") },
            close: async () => { events.push("closed"); settle?.(70) },
          },
          unref: () => {},
        }),
        cleanup: () => { events.push("cleaned") },
      }),
    })

    await expect(launched).rejects.toThrow("admission failed")
    expect(events).toEqual(["closed", "cleaned"])
  })

  test("release closes POSIX control and unrefs without requesting stop", async () => {
    const events: string[] = []
    const process = await launchPersistentSubprocess(command, {
      platform: posixPlatform({
        launch: async () => ({
          pid: 42,
          exited: new Promise<number>(() => {}),
          control: {
            drained: Promise.resolve(),
            write: async (word) => { events.push(word) },
            close: async () => { events.push("closed") },
          },
          unref: () => { events.push("unref") },
        }),
      }),
    })

    process.release()
    await Bun.sleep(0)

    expect(events).toEqual(["go", "closed", "unref"])
  })

  test("a self-managed launch skips the supervisor and admission, and stop signals the process itself", async () => {
    const events: string[] = []
    let exit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => { exit = resolve })
    const process = await launchPersistentSubprocess(command, {
      selfManaged: true,
      platform: posixPlatform({
        launch: async (request) => {
          events.push(`launch:${request.command.join(" ")}`)
          // It outlives the container that starts it, so it carries no mark.
          expect(request.env !== undefined && CONTAINER_MARK_VARIABLE in request.env && request.env[CONTAINER_MARK_VARIABLE] === undefined).toBe(true)
          return {
            pid: 42,
            exited,
            control: {
              drained: Promise.resolve(),
              write: async (word) => { events.push(`write:${word}`) },
              close: async () => { events.push("control-closed") },
            },
            kill: (signal) => { events.push(`kill:${signal}`); exit(0) },
            unref: () => { events.push("unref") },
          }
        },
      }),
    })
    await Bun.sleep(0)
    expect(events).toEqual(["launch:bun fixture.ts", "control-closed"])

    expect(await process.stop()).toBe("terminated")
    expect(events).toEqual(["launch:bun fixture.ts", "control-closed", "kill:SIGTERM"])
  })

  test("the launcher and the writer hold the spool, and only the writer once the launcher releases it", async () => {
    const holds: SpoolHolders[] = []
    const removed: string[] = []
    let exit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => { exit = resolve })
    const persistent = await launchPersistentSubprocess(command, {
      selfManaged: true,
      platform: posixPlatform({
        launch: async () => ({ pid: 42, exited, control: { drained: Promise.resolve(), write: async () => {}, close: async () => {} }, unref: () => {} }),
        holdSpool: (directory, holders) => { holds.push(holders) },
        removeSpool: (directory) => { removed.push(directory) },
      }),
    })
    const writer = { pid: 42, identity: "42:born" }
    expect(holds).toEqual([{ launcher: { pid: process.pid, identity: `${process.pid}:born` }, writer }])

    persistent.release()
    await Bun.sleep(0)
    expect(holds.at(-1)).toEqual({ writer })
    expect(removed).toEqual([])

    exit(0)
    await Bun.sleep(0)
    expect(removed).toEqual(["/spool"])
  })

  test("a writer that exits while its launcher holds the spool leaves it readable until the release, which removes it", async () => {
    const removed: string[] = []
    let exit: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => { exit = resolve })
    const persistent = await launchPersistentSubprocess(command, {
      platform: posixPlatform({
        launch: async () => ({ pid: 42, exited, control: { drained: Promise.resolve(), write: async () => {}, close: async () => {} }, unref: () => {} }),
        removeSpool: (directory) => { removed.push(directory) },
      }),
    })

    exit(1)
    await Bun.sleep(0)
    expect(persistent.metadata().status).toBe("exited")
    expect(removed).toEqual([])

    persistent.release()
    await Bun.sleep(0)
    expect(removed).toEqual(["/spool"])
  })

  test("each launch sweeps the spools that earlier launches left behind", async () => {
    let sweeps = 0
    await launchPersistentSubprocess(command, { platform: defaultPlatform({ sweepSpools: async () => { sweeps += 1 } }) })

    expect(sweeps).toBe(1)
  })

  test("refuses an unsupported host before creating a spool or launching", async () => {
    const platform = { kind: "unsupported" } as const

    await expect(launchPersistentSubprocess(command, { platform })).rejects.toThrow("persistent processes are not supported")
  })

  test("launches in an isolated session with retained owner-only spools and no stdin", async () => {
    let request: Parameters<WindowsPersistentSubprocessPlatform["launch"]>[0] | undefined
    const platform = defaultPlatform({
      launch: async (input) => {
        request = input
        return { pid: 42, exited: new Promise<number>(() => {}), unref: () => {} }
      },
      inspect: async () => ({ kind: "process", identity: "42:born" }),
      spoolBytes: (path) => path.endsWith("stdout") ? 12 : 4,
      now: () => 1_000,
    })

    const process = await launchPersistentSubprocess(command, { platform })

    expect(request).toEqual({ command, cwd: undefined, env: undefined, stdin: "ignore", stdoutFd: 7, stderrFd: 8, detached: true })
    expect(process.pid).toBe(42)
    expect(process.spool).toEqual({ directory: "/spool", stdoutPath: "/spool/stdout", stderrPath: "/spool/stderr" })
    expect(process.metadata()).toEqual({ startedAtMs: 1_000, status: "running", stdoutBytes: 12, stderrBytes: 4 })
  })

  test("reports terminal status without reading spool contents", async () => {
    let exit: ((code: number) => void) | undefined
    const exited = new Promise<number>((resolve) => { exit = resolve })
    const platform = defaultPlatform({
      launch: async () => ({ pid: 42, exited, unref: () => {} }),
      inspect: async () => ({ kind: "process", identity: "42:born" }),
      spoolBytes: () => 0,
      now: () => 2_000,
    })
    const process = await launchPersistentSubprocess(command, { platform })

    exit?.(0)
    await exited

    expect(process.metadata().status).toBe("exited")
  })

  test("stops only the process group with the captured identity and release never terminates", async () => {
    const stops: Array<{ pid: number; identity: string }> = []
    let unrefs = 0
    let identity: ProcessIdentity = { kind: "process", identity: "42:born" }
    const platform = defaultPlatform({
      launch: async () => ({ pid: 42, exited: new Promise<number>(() => {}), unref: () => { unrefs += 1 } }),
      inspect: async () => identity,
      stopContainer: async (pid, expected) => { stops.push({ pid, identity: expected }) },
      spoolBytes: () => 0,
    })
    const process = await launchPersistentSubprocess(command, { platform })

    await process.stop()
    expect(stops).toEqual([{ pid: 42, identity: "42:born" }])

    identity = { kind: "process", identity: "42:reused" }
    await expect(process.stop()).rejects.toThrow("process identity changed")
    expect(stops).toHaveLength(1)

    identity = { kind: "process", identity: "42:born" }
    process.release()
    expect(unrefs).toBe(1)
    expect(stops).toHaveLength(1)
  })

  test("refuses a stop when the identity could not be read, and never reads that as a changed process", async () => {
    let stops = 0
    let identity: ProcessIdentity = { kind: "process", identity: "42:born" }
    const platform = defaultPlatform({
      launch: async () => ({ pid: 42, exited: new Promise<number>(() => {}), unref: () => {} }),
      inspect: async () => identity,
      stopContainer: async () => { stops += 1 },
      spoolBytes: () => 0,
    })
    const process = await launchPersistentSubprocess(command, { platform })
    identity = { kind: "unproven" }

    await expect(process.stop()).rejects.toThrow("the process could not be identified")
    expect(stops).toBe(0)
  })

  test("awaits one asynchronous container stop and preserves an unsettled tree result", async () => {
    let identity: ProcessIdentity = { kind: "process", identity: "42:born" }
    let stops = 0
    const platform = defaultPlatform({
      launch: async () => ({ pid: 42, exited: new Promise<number>(() => {}), unref: () => {} }),
      inspect: async () => identity,
      stopContainer: async () => { stops += 1; await Promise.resolve(); return "unsettled" },
      spoolBytes: () => 0,
    })
    const process = await launchPersistentSubprocess(command, { platform })
    const first = process.stop()
    const second = process.stop()

    expect(second).toBe(first)
    expect(await first).toBe("unsettled")
    expect(stops).toBe(1)

    identity = { kind: "absent" }
    expect(await process.stop()).toBe("unsettled")
  })

  test("lets the platform clean the child and spool when identity cannot be proven", async () => {
    let cleaned = 0
    const platform = defaultPlatform({
      launch: async () => ({ pid: 42, exited: new Promise<number>(() => {}), unref: () => {} }),
      inspect: async () => ({ kind: "unproven" }),
      cleanup: () => { cleaned += 1 },
      spoolBytes: () => 0,
    })

    await expect(launchPersistentSubprocess(command, { platform })).rejects.toThrow("identity could not be proven")
    expect(cleaned).toBe(1)
  })
})