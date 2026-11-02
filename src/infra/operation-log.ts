import { isAbortError } from "./abort.js"
import { errorDetail, errorMessage } from "./error-message.js"
import { InvariantViolation } from "./invariant.js"

interface OperationFields { [key: string]: unknown }

export interface OperationLogger {
  debug(message?: unknown, extra?: OperationFields): void
  info(message?: unknown, extra?: OperationFields): void
  warn(message?: unknown, extra?: OperationFields): void
  error(message?: unknown, extra?: OperationFields): void
}

/** How loud the completion record is. `level` fixes it: "info" for a
 *  decision, a state change, or a finished unit of work a person can ask
 *  about, and "debug" for a hot path that runs per read or per call, whose
 *  routine completion at one record per call buries what matters. `slowMs`
 *  makes it conditional: the completion records at INFO only when the work
 *  ran at least that long, and at DEBUG otherwise. An operation that its
 *  owner aborts records `interrupted` where its completion would, because an
 *  abort is an outcome, not a failure. */
export type CompletionLevel =
  | { readonly level?: "info" | "debug"; readonly slowMs?: never }
  | { readonly slowMs: number; readonly level?: never }

/** One failed run of an operation, for an owner that records failures itself. */
export interface OperationFailure {
  readonly operation: string
  readonly fields: OperationFields
  readonly durationMs: number
  readonly error: unknown
  readonly level: "error" | "warn"
}

export type LoggedOperationOptions<T> = CompletionLevel & {
  readonly log: OperationLogger
  readonly operation: string
  readonly fields?: OperationFields
  readonly summarize?: (result: T) => OperationFields
  /** Level for the failure record, "error" by default. An operation whose
   *  caller recovers from the failure on its own, such as a best-effort read
   *  that the next request retries, sets "warn". */
  readonly failureLevel?: "error" | "warn"
  /** Records a failure in place of the failure record, for an owner whose
   *  failures repeat, such as every read of one broken window, and coalesce. */
  readonly onFailure?: (failure: OperationFailure) => void
  /** Whether a failure is an outcome rather than a failure: the operation
   *  was cut off, such as a call whose connection the other end closed
   *  cleanly, or declined as expected, such as a call a paused project does
   *  not run. Such a failure records `interrupted` where the completion
   *  would, as an abort does. */
  readonly interruptedBy?: (error: unknown) => boolean
}

export async function loggedOperation<T>(options: LoggedOperationOptions<T>, run: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const fields = options.fields ?? {}
  // The start record is DEBUG everywhere: its only unique value is showing an
  // operation that began and never finished, and the done and failed records
  // carry the same fields plus duration. At INFO it doubled every operation's
  // volume to say nothing the completion record does not.
  options.log.debug(`${options.operation} start`, fields)
  try {
    const result = await run()
    logOperationDone(options, fields, result, start)
    return result
  } catch (err) {
    recordOperationFailure(options, fields, start, err)
    throw err
  }
}

export function loggedSyncOperation<T>(options: LoggedOperationOptions<T>, run: () => T): T {
  const start = performance.now()
  const fields = options.fields ?? {}
  options.log.debug(`${options.operation} start`, fields)
  try {
    const result = run()
    logOperationDone(options, fields, result, start)
    return result
  } catch (err) {
    recordOperationFailure(options, fields, start, err)
    throw err
  }
}

function logOperationDone<T>(
  options: LoggedOperationOptions<T>,
  fields: OperationFields,
  result: T,
  start: number,
): void {
  recordAtCompletionLevel(options, `${options.operation} done`, { ...fields, ...safeSummary(options.summarize, result) }, durationMs(start))
}

function recordAtCompletionLevel<T>(options: LoggedOperationOptions<T>, message: string, fields: OperationFields, elapsed: number): void {
  if (options.slowMs !== undefined) logCompletion(options.log, message, fields, { durationMs: elapsed, slowMs: options.slowMs })
  else if (options.level === "debug") options.log.debug(message, { ...fields, durationMs: elapsed })
  else options.log.info(message, { ...fields, durationMs: elapsed })
}

/** Records one finished unit of work, once, with its duration: at INFO when
 *  it ran at least `slowMs`, naming the threshold so the record says why it
 *  is there, and at DEBUG otherwise. A start and done pair collapses into
 *  this one record: the start adds nothing the duration does not say. */
export function logCompletion(
  log: Pick<OperationLogger, "debug" | "info">,
  message: string,
  fields: OperationFields,
  timing: { readonly durationMs: number; readonly slowMs: number },
): void {
  if (timing.durationMs >= timing.slowMs) log.info(message, { ...fields, durationMs: timing.durationMs, slowMs: timing.slowMs })
  else log.debug(message, { ...fields, durationMs: timing.durationMs })
}

export function durationMs(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10
}

function safeSummary<T>(
  summarize: ((result: T) => OperationFields) | undefined,
  result: T,
): OperationFields {
  if (!summarize) return {}
  try {
    return summarize(result)
  } catch (err) {
    return { summaryError: errorMessage(err), summaryErrorDetail: errorDetail(err) }
  }
}

function recordOperationFailure<T>(
  options: LoggedOperationOptions<T>,
  fields: OperationFields,
  start: number,
  err: unknown,
): void {
  const elapsed = durationMs(start)
  const detail = { ...fields, error: errorMessage(err), errorDetail: errorDetail(err) }
  // An abort is the owner withdrawing the operation. It is an outcome, not a
  // failure, so it records where the operation's completion would.
  if (isAbortError(err) || options.interruptedBy?.(err) === true) {
    recordAtCompletionLevel(options, `${options.operation} interrupted`, detail, elapsed)
    return
  }
  const level = options.failureLevel ?? "error"
  if (options.onFailure) {
    options.onFailure({ operation: options.operation, fields, durationMs: elapsed, error: err, level })
    return
  }
  options.log[level](`${options.operation} failed`, { ...detail, durationMs: elapsed })
}

/** Records the failure of work that nothing awaits, such as bookkeeping that a
 *  runtime starts in the background, so its rejection is handled and never
 *  ends the process. The failure records once, at WARN with its detail. An
 *  InvariantViolation is a broken consistency check that must stay visible,
 *  so it records at ERROR. An abort is the owner withdrawing the work, so it
 *  records `interrupted` at DEBUG. */
export function recordBackgroundFailure(log: OperationLogger, operation: string, fields: OperationFields, error: unknown): void {
  const record = { ...fields, error: errorMessage(error), errorDetail: errorDetail(error) }
  if (isAbortError(error)) log.debug(`${operation} interrupted`, record)
  else if (error instanceof InvariantViolation) log.error(`${operation} failed`, record)
  else log.warn(`${operation} failed`, record)
}
