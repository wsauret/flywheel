import { isAbortError } from "./abort.js"
import { errorDetail, errorMessage, type ErrorDetail } from "./error-message.js"
import type { Log } from "./log.js"
import { coalesceRepeats } from "./repeat-coalescer.js"

/** What a process does with a failure that no code awaits (ARCH-RUNTIME-030).
 *
 *  A floating abort is contained: an abort proves that its owner withdrew
 *  the work, so nothing is left torn and the process keeps serving. Every
 *  other unhandled rejection, and every uncaught exception, abort-named ones
 *  included, is fatal: it can leave an operation torn, and the synchronous
 *  state after an uncaught exception is not trustworthy. A fatal failure runs
 *  the role's fatal function once, and the policy runs no ordered shutdown of
 *  its own, because the owner of the process restarts it and the next start
 *  recovers what it left. */

type Logger = ReturnType<typeof Log.create>

/** How a failure reached the policy. */
export type UncaughtKind = "uncaught exception" | "unhandled rejection"

type CrashRole = "account-service" | "project-executor" | "runtime-background-worker" | "runtime-maintenance-worker"

/** One contained abort is recorded in full, and the repeats of its condition
 *  in this window become one count. */
const ABORT_REPEAT_WINDOW_MS = 60_000

export interface CrashPolicyOptions {
  readonly role: CrashRole
  readonly log: Pick<Logger, "warn">
  /** Records a fatal failure and ends the process. It runs at most once. */
  readonly fatal: (error: unknown, kind: UncaughtKind) => void | Promise<void>
  /** Ends the process without the fatal function: when the fatal function
   *  fails, and when a second fatal failure arrives while it runs. */
  readonly exitNow: () => void
  /** The window for the repeats of a contained abort. A test shortens it. */
  readonly repeatWindowMs?: number
}

export interface CrashPolicy {
  uncaughtException(error: unknown): void
  unhandledRejection(reason: unknown): void
}

/** Builds the two process handlers without installing them, so that a test
 *  can drive them without touching the test runner's own process events. */
export function makeCrashPolicy(options: CrashPolicyOptions): CrashPolicy {
  const aborts = coalesceRepeats<ErrorDetail>({
    windowMs: options.repeatWindowMs ?? ABORT_REPEAT_WINDOW_MS,
    first: (_condition, detail) => { options.log.warn(`${options.role} abort rejection contained`, { error: detail.message, errorDetail: detail }) },
    repeated: (_condition, repeats) => {
      options.log.warn(`${options.role} abort rejection contained again`, { count: repeats.count, windowMs: repeats.windowMs, error: repeats.events[0]?.message })
    },
  })
  let failing = false
  const fail = (failure: unknown, kind: UncaughtKind): void => {
    if (failing) {
      options.exitNow()
      return
    }
    failing = true
    // The process ends, so the count of repeats in the window is reported now.
    aborts.end()
    void (async () => { await options.fatal(failure, kind) })().catch(() => { options.exitNow() })
  }
  return {
    uncaughtException: (error) => { fail(error, "uncaught exception") },
    unhandledRejection: (reason) => {
      if (!isAbortError(reason)) {
        fail(reason, "unhandled rejection")
        return
      }
      const detail = errorDetail(reason)
      aborts.observe(abortCondition(detail), detail)
    },
  }
}

/** Installs the policy on this process's or this Worker's events. A role
 *  that names no `exitNow` exits 1 at once when its fatal function fails or
 *  a second fatal failure arrives. */
export function installCrashPolicy(options: Omit<CrashPolicyOptions, "exitNow" | "repeatWindowMs"> & { readonly exitNow?: CrashPolicyOptions["exitNow"] }): void {
  const policy = makeCrashPolicy({ ...options, exitNow: options.exitNow ?? (() => { process.exit(1) }) })
  process.on("uncaughtException", policy.uncaughtException)
  process.on("unhandledRejection", policy.unhandledRejection)
}

/** Records a failure that ends its process: one ERROR named by its kind,
 *  with its message and its redacted detail. */
export function recordFatal(log: Pick<Logger, "error">, kind: UncaughtKind, error: unknown): void {
  log.error(kind, { error: errorMessage(error), errorDetail: errorDetail(error) })
}

/** Runs `settle`, one step a fatal path owes before it ends, such as a
 *  durable flush, and then calls `exit`. The exit follows whether the step
 *  settles, fails, or runs past `boundMs`, and a step that fails or runs
 *  past its bound is recorded once. */
export async function exitAfter(options: {
  readonly settle: () => Promise<void>
  readonly boundMs: number
  readonly log: Pick<Logger, "warn">
  readonly exit: () => void
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Not unref'd: the bound, not an empty event loop, ends the wait.
  const bound = new Promise<"bound">((resolve) => { timer = setTimeout(() => { resolve("bound") }, options.boundMs) })
  try {
    const outcome = await Promise.race([Promise.resolve().then(options.settle).then(() => "settled" as const), bound])
    if (outcome === "bound") options.log.warn("the step before a fatal exit ran past its bound", { boundMs: options.boundMs })
  } catch (error) {
    options.log.warn("the step before a fatal exit failed", { error: errorMessage(error), errorDetail: errorDetail(error) })
  } finally {
    clearTimeout(timer)
    options.exit()
  }
}

/** A frame with a source position that is not in one of the runtime's own
 *  modules. A native frame has no source position. */
const SOURCE_FRAME = /:\d+:\d+\)?$/
const RUNTIME_FRAME = /[\s(@](?:node|bun):/

/** One contained abort's condition: its name, its message, and the first
 *  frame of its stack outside native code. An abort reason's stack is taken
 *  where the abort was raised, so that frame names the code that aborted,
 *  not the code that left the rejection with no handler; the reason holds
 *  nothing closer to that code. */
function abortCondition(detail: ErrorDetail): string {
  const frame = detail.stack?.split("\n").map((line) => line.trim()).find((line) => SOURCE_FRAME.test(line) && !RUNTIME_FRAME.test(line))
  return [detail.name, detail.message, frame].join("\0")
}
