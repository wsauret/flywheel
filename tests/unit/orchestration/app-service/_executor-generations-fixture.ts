/** The harness of the executor generations tests: fake executor generations
 *  the test drives by hand, and the owner over them. */

import type { OwnershipClosure } from "../../../../src/infra/process-supervisor.js"
import type { RuntimeExecutorState } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import type { ProjectExecutorClient, ProjectExecutorStop } from "../../../../src/orchestration/app-service/project-executor-client.js"
import { createProjectExecutorGenerations } from "../../../../src/orchestration/app-service/project-executor-generations.js"
import type { RuntimeFaultReporter } from "../../../../src/orchestration/app-service/runtime-fault-reporting.js"

type ProjectExecutorGenerationEnd = Awaited<ProjectExecutorClient["closed"]>
type Execution = Parameters<typeof createProjectExecutorGenerations>[0]["execution"]
type WedgeListener = Parameters<ProjectExecutorClient["onWedged"]>[0]
/** One end the account decided for a generation: its cause and its record's detail. */
interface DecidedEnd {
  readonly cause: string
  readonly detail: Parameters<ProjectExecutorClient["terminate"]>[1]
}
/** A generation that lives this long no longer counts as an early death. */
export const STABLE_LIFETIME_MS = 60_000

/** A clock the test moves by hand, with the timers that clock fires. */
function manualClock() {
  let now = 0
  const timers = new Set<{ at: number; fire: () => void }>()
  return {
    now: () => now,
    setTimer(fire: () => void, delayMs: number) {
      const timer = { at: now + delayMs, fire }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    async advance(ms: number) {
      const until = now + ms
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers.delete(next)
        now = next.at
        next.fire()
        await settle()
      }
      now = until
      await settle()
    },
  }
}

export async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

/** How one fake generation answers: whether it is ready at once, when its
 *  stop answers, and what that stop reports. */
interface FakeExecutorOptions { readonly stopResult?: ProjectExecutorStop; readonly stopAnswer?: Promise<void>; readonly readyAtOnce?: boolean }

/** One executor generation the test drives by hand: it becomes ready when
 *  told, and it begins to end, then settles its closure, when told. */
function fakeExecutor(options: FakeExecutorOptions = {}) {
  const closed = Promise.withResolvers<ProjectExecutorGenerationEnd>()
  const ready = Promise.withResolvers<Awaited<ProjectExecutorClient["ready"]>>()
  const hidden: string[] = []
  const runtime: Awaited<ProjectExecutorClient["ready"]> = {
    query: () => new Promise(() => {}),
    dispatch: () => new Promise(() => {}),
    hideSession: async (sessionId) => { hidden.push(sessionId) },
    subscribe: () => () => {},
    close: async () => {},
  }
  if (options.readyAtOnce !== false) ready.resolve(runtime)
  void ready.promise.catch(() => {})
  let ending: { readonly cause: string; readonly own: boolean } | undefined
  const endingListeners = new Set<(cause: string, own: boolean) => void>()
  let stopped = 0
  const settleProofs: OwnershipClosure[] = []
  const wedgeListeners = new Set<WedgeListener>()
  const ends: DecidedEnd[] = []
  const begin = (cause: string, own: boolean): void => {
    if (ending !== undefined) return
    ending = { cause, own }
    for (const listener of endingListeners) listener(cause, own)
    // A real generation that ends before it is ready rejects its readiness
    // with an internal startup error, which no input may ever hear.
    ready.reject(new Error("project executor terminated during startup"))
  }
  const owner: ProjectExecutorClient = {
    ready: ready.promise,
    closed: closed.promise,
    startChatDefault: async () => {},
    blockers: async () => [],
    setReplacement: async () => {},
    onBlockersChanged: () => () => {},
    handoff: async () => [],
    continueCapacityWaits: async () => ({ pending: 0, at: null, next: null }),
    onWedged(listener) {
      wedgeListeners.add(listener)
      return () => { wedgeListeners.delete(listener) }
    },
    onEnding(listener) {
      if (ending !== undefined) { listener(ending.cause, ending.own); return () => {} }
      endingListeners.add(listener)
      return () => { endingListeners.delete(listener) }
    },
    settle: async () => settleProofs.shift() ?? { settled: true },
    async stop() {
      stopped += 1
      await options.stopAnswer
      begin("was stopped", false)
      closed.resolve({ settled: true, cause: "was stopped" })
      return options.stopResult ?? { settled: true }
    },
    async terminate(cause, detail) {
      ends.push({ cause, detail })
      begin(cause, false)
      const end = { settled: true, cause } as const
      closed.resolve(end)
      return end
    },
  }
  return {
    owner,
    /** What this generation serves once ready; a test replaces its calls. */
    runtime,
    /** The sessions this generation's own runtime was told to hide. */
    hidden: () => hidden,
    ready: () => ready.resolve(runtime),
    /** Begins to end now, by the executor's own exit or crash; the closure
     *  settles only when `close` is called. */
    beginEnding: (cause: string) => begin(cause, true),
    close: (end: ProjectExecutorGenerationEnd) => closed.resolve(end),
    /** Ends now, by the executor's own exit or crash unless `own` is false,
     *  as for a lost guardian or channel or an outside signal. */
    die: (cause: string, own = true) => { begin(cause, own); closed.resolve({ settled: true, cause }) },
    stops: () => stopped,
    /** The ends the account decided for this generation. */
    ends: () => ends,
    /** The executor has sent no heartbeat for thirty periods, `silentMs` in
     *  all: it is proven wedged. */
    wedge: (silentMs: number) => { for (const listener of wedgeListeners) listener({ missedPeriods: 30, silentMs }) },
    /** What the next fresh ownership proofs answer, in order. */
    proveNext: (...proofs: OwnershipClosure[]) => { settleProofs.push(...proofs) },
  }
}

/** The generations of one project over fake executors, a hand-moved clock,
 *  and the records, publications, writes, and build proofs they make. */
export function fixture(options: FakeExecutorOptions & { readonly reportFault?: RuntimeFaultReporter; readonly execution?: Execution; readonly replacementRequested?: () => boolean; readonly handoffRecovery?: (rows: NonNullable<ProjectExecutorStop["successorRows"]>) => Promise<boolean>; readonly releaseForHandoff?: () => Promise<boolean> } = {}) {
  const clock = manualClock()
  const executors: ReturnType<typeof fakeExecutor>[] = []
  const published: RuntimeExecutorState[] = []
  const writes: string[] = []
  const errors: string[] = []
  const records: Array<[string, string, unknown]> = []
  /** What each generation told the build's fallback, in order. */
  const proofs: Array<"ready" | "failed to open"> = []
  let changes = 0
  const generations = createProjectExecutorGenerations({
    ...(options.reportFault === undefined ? {} : { reportFault: options.reportFault }),
    spawn: () => {
      const executor = fakeExecutor(options)
      executors.push(executor)
      return executor.owner
    },
    serve: () => () => {},
    execution: options.execution ?? (async (operation) => { writes.push(`${operation.kind}:${operation.generation}${operation.kind === "generation.recover" && operation.interruptedSessionIds.length ? `:${operation.interruptedSessionIds.join(",")}` : ""}`); return { kind: "ok" } }),
    onReset: () => {},
    changed: () => { changes += 1 },
    replacementRequested: options.replacementRequested ?? (() => false),
    handoffRecovery: options.handoffRecovery,
    releaseForHandoff: options.releaseForHandoff,
    bus: {
      publish(input: RuntimeUiPatchInput) {
        if (input.payload.kind === "executor.changed") published.push(input.payload.executor)
        return { ...input, position: published.length, prevPosition: published.length - 1 }
      },
    },
    log: {
      debug() {},
      info: (message, fields) => { records.push(["info", String(message), fields]) },
      warn: (message, fields) => { records.push(["warn", String(message), fields]) },
      error: (message, fields) => { errors.push(`${message} ${JSON.stringify(fields)}`) },
    },
    now: clock.now, setTimer: clock.setTimer,
    buildProof: { executorReady: () => { proofs.push("ready") }, failedToOpen: () => { proofs.push("failed to open") } },
  })
  return { generations, clock, executors, published, writes, errors, records, proofs, changes: () => changes, latest: () => executors.at(-1)! }
}

/** Resolves to how long, on the test clock, explicit input waited for its generation. */
export async function servedAfter(f: ReturnType<typeof fixture>, stepMs = 250, limitMs = 60_000): Promise<number> {
  const start = f.clock.now()
  const input = { served: false }
  void f.generations.serving("person").then(() => { input.served = true })
  await settle()
  while (!input.served && f.clock.now() - start < limitMs) await f.clock.advance(stepMs)
  if (!input.served) throw new Error("input was never served")
  return f.clock.now() - start
}
