import { DebugLog } from "../../../../infra/diagnostics/debug-log.js"
import { RouteUnavailableError } from "../../../agent-runtime/llm/errors.js"
import type { EngineProcess } from "./engine-process.js"
import type { McpToolDeclaration } from "../tools/tool-projection.js"

/** What decides which engine process serves an agent: its chat tree and its login, nothing else (ARCH-PROVIDERS-086,
 *  plan P2). Every value in which sibling agents differ goes where agy reads it per session or per request, so no
 *  agent of a tree ever starts a second process on one login. `accountId` names the login's account, and `tools` the
 *  tree's composed tool surface, which the process declares at launch. */
export interface EnginePlace {
  readonly treeRootSessionId: string
  readonly loginDir: string
  readonly accountId: string
  readonly tools: readonly McpToolDeclaration[]
}

/** The part of an engine process that the registry uses. */
export type RegisteredEngine = Pick<EngineProcess, "processId" | "toolNames" | "served" | "ended" | "whenIdle" | "close">

/** One use of a place's engine: a session that a client shows, or an agent's bridge. */
export interface EngineLease<E extends RegisteredEngine> {
  /** The running process of the place, launched when none runs. A process that ended, closes, or was replaced is
   *  never returned again, so a caller that meets another process id rotates its sessions. A launch waits until the
   *  place's earlier process exited and no logout holds its login. Rejects when the launch fails, the next call
   *  launches again, and with `RouteUnavailableError` once the registry drains. */
  engine(): Promise<E>
  /** Ends the use. The place's process closes when its last use ended and no prompt of it is open. Resolves when the
   *  use ended: at once while other uses remain, else once the process exited. */
  release(): Promise<void>
}

export interface EngineRegistry<E extends RegisteredEngine> {
  /** A use of the engine of `place`. A lease whose tools name one that the running process did not declare replaces
   *  the process once no prompt of it is open (plan P3): the old process exits first, then the new one launches with
   *  every tool any lease of the place named. */
  lease(place: EnginePlace): EngineLease<E>
  /** The account of a running process of the chat tree rooted at `treeRootSessionId`, for a request of that tree that
   *  must stay on the account its tree already uses (PI-MODEL-094). */
  preferredAccount(treeRootSessionId: string): string | undefined
  /** The bracket of a logout of the login directory `loginDir`: closes every process of the login once no prompt of
   *  it is open, waits until each exited, runs `work`, and settles with it. From the call until `work` settled, no
   *  process launches on the login: a launch of a lease waits until then. `signal` aborts the wait for the exits, and
   *  then `work` does not run. */
  withLoginReleased<T>(loginDir: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T>
  /** Closes every process at once, at the process's shutdown, and waits until every one exited, also those that were
   *  launching or closing. After the call no process launches again. */
  drain(): Promise<void>
}

/** One process of a place, from the start of its launch until it exited or its launch failed. */
interface Process<E extends RegisteredEngine> {
  readonly loginDir: string
  readonly launched: Promise<E>
  /** The launch passed its waits and called `launch`. */
  launching: boolean
  /** A close was asked for, or the process ended: it is never returned again. */
  closing: boolean
  engine: E | undefined
  /** Settles once the process exited or its launch failed. */
  readonly gone: Promise<void>
}

/** The one slot of a place: it stays in the registry while a lease holds it or a process of it has not exited. */
interface Slot<E extends RegisteredEngine> {
  readonly key: string
  readonly place: Omit<EnginePlace, "tools">
  readonly tools: Map<string, McpToolDeclaration>
  leases: number
  /** The place's newest process. An earlier one that has not exited yet is in `processes` only. */
  process: Process<E> | undefined
}

function placeKey(place: Pick<EnginePlace, "treeRootSessionId" | "loginDir">): string {
  return JSON.stringify([place.treeRootSessionId, place.loginDir])
}

/**
 * The engine processes of this Flywheel process, one per place, made by `launch`. Flywheel caps neither the processes
 * nor their sessions. A place has at most one process at a time: a launch for a place waits until the place's
 * earlier process, which a replacement or a release closes, has exited.
 */
export function createEngineRegistry<E extends RegisteredEngine>(launch: (place: EnginePlace) => Promise<E>): EngineRegistry<E> {
  const slots = new Map<string, Slot<E>>()
  /** Every process that has not exited, also an earlier one of a place, which a drain or a logout must wait for. */
  const processes = new Set<Process<E>>()
  /** The logouts that hold each login directory now. */
  const logouts = new Map<string, Set<Promise<void>>>()
  let draining = false

  const forget = (slot: Slot<E>) => {
    if (slot.leases === 0 && slot.process === undefined && slots.get(slot.key) === slot) slots.delete(slot.key)
  }

  const loginReleased = async (loginDir: string) => {
    for (let held = logouts.get(loginDir); held !== undefined; held = logouts.get(loginDir)) await Promise.all(held)
  }

  /** Asks `process` to close, once no prompt of it is open when `afterPrompts`, and answers when it is gone. */
  const close = (process: Process<E>, reason: string, afterPrompts: boolean): Promise<void> => {
    if (process.closing) return process.gone
    process.closing = true
    void process.launched.then(async (engine) => {
      if (afterPrompts) await Promise.race([engine.whenIdle(), engine.ended])
      await engine.close(reason)
    }).catch(() => {})
    return process.gone
  }

  const start = (slot: Slot<E>): Promise<E> => {
    const previous = slot.process?.gone
    const launched = Promise.withResolvers<E>()
    const started: Process<E> = {
      loginDir: slot.place.loginDir,
      launched: launched.promise,
      launching: false,
      closing: false,
      engine: undefined,
      gone: launched.promise.then((engine) => engine.ended).then(() => {}, () => {}),
    }
    void (async () => {
      await previous
      await loginReleased(slot.place.loginDir)
      if (draining) throw new RouteUnavailableError("The Google Antigravity engines are shutting down.")
      if (started.closing) throw new RouteUnavailableError("The Google Antigravity engine was closed before it launched.")
      started.launching = true
      return launch({ ...slot.place, tools: [...slot.tools.values()] })
    })().then(launched.resolve, launched.reject)
    slot.process = started
    processes.add(started)
    void launched.promise.then((engine) => {
      started.engine = engine
      return engine.ended
    }).then(() => { started.closing = true }, () => { started.closing = true })
    void started.gone.then(() => {
      processes.delete(started)
      if (slot.process === started) slot.process = undefined
      forget(slot)
    })
    return launched.promise
  }

  /** Adds the tools of a new lease, and replaces the place's process when it lacks one of them. */
  const offer = (slot: Slot<E>, tools: readonly McpToolDeclaration[]) => {
    const added = tools.filter((tool) => !slot.tools.has(tool.name))
    for (const tool of added) slot.tools.set(tool.name, tool)
    const current = slot.process
    if (added.length === 0 || current === undefined || current.closing) return
    void replaceWhenIdle(slot, current, added).catch(() => {})
  }

  /** Replaces `current`, the process of `slot`, once no prompt of it is open, when it lacks a tool of `added`. */
  const replaceWhenIdle = async (slot: Slot<E>, current: Process<E>, added: readonly McpToolDeclaration[]) => {
    const engine = await current.launched
    if (added.every((tool) => engine.toolNames.has(tool.name))) return
    await engine.whenIdle()
    // The process ended, or another replacement, a release, a logout, or a drain already closed it, meanwhile.
    if (slot.process !== current || current.closing) return
    DebugLog.record({ type: "provider.antigravity.process.replaced", payload: { processId: engine.processId, reason: "tools", added: added.length } })
    void close(current, "replaced", false)
    if (slot.leases > 0 && !draining) await start(slot)
  }

  return {
    lease(place) {
      const key = placeKey(place)
      let slot = slots.get(key)
      if (slot === undefined) {
        const { tools: _tools, ...rest } = place
        slot = { key, place: rest, tools: new Map(), leases: 0, process: undefined }
        slots.set(key, slot)
      }
      const leased = slot
      leased.leases += 1
      offer(leased, place.tools)
      let released = false
      return {
        engine: () => {
          const current = leased.process
          return current !== undefined && !current.closing ? current.launched : start(leased)
        },
        async release() {
          if (released) return
          released = true
          leased.leases -= 1
          if (leased.leases > 0) return
          const current = leased.process
          if (current === undefined) {
            forget(leased)
            return
          }
          await close(current, "released", true)
        },
      }
    },
    preferredAccount(treeRootSessionId) {
      for (const slot of slots.values()) {
        const current = slot.process
        if (current?.engine !== undefined && !current.closing && slot.place.treeRootSessionId === treeRootSessionId) return slot.place.accountId
      }
      return undefined
    },
    async withLoginReleased(loginDir, signal, work) {
      const held = Promise.withResolvers<void>()
      const holders = logouts.get(loginDir) ?? new Set()
      holders.add(held.promise)
      logouts.set(loginDir, holders)
      try {
        // A launch that still waits sees the logout and waits for it; every other process of the login closes.
        const exits = [...processes].filter((process) => process.loginDir === loginDir && (process.launching || process.engine !== undefined)).map((process) => close(process, "logout", true))
        await abortable(Promise.all(exits), signal)
        return await work()
      } finally {
        holders.delete(held.promise)
        if (holders.size === 0 && logouts.get(loginDir) === holders) logouts.delete(loginDir)
        held.resolve()
      }
    },
    async drain() {
      draining = true
      const exits = [...processes].map((process) => {
        // A close that still waits for open prompts ends now; the engine's close joins its first close.
        if (process.closing) void process.launched.then((engine) => engine.close("shutdown")).catch(() => {})
        return close(process, "shutdown", false)
      })
      await Promise.all(exits)
    },
  }
}

/** `promise`, or the rejection with the reason of `signal` once it aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  return Promise.race([promise, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort))
}
