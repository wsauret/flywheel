import { Socket } from "effect/socket"

import { AccountAttachFailedError, type RuntimeProtocolRefusal } from "../app-service-types.js"
import type { RuntimeCallTimeout } from "../runtime-client-deadlines.js"
import type { LaneEndCause } from "../runtime-client-diagnostics.js"
import { RuntimeProtocolError } from "../runtime-protocol-schemas.js"

// How a runtime call or an event lane failed, as the shared connection
// (`connection.ts`) raises it and every receiver reads it. The connection
// owns liveness and recovery; this vocabulary says which failures it
// explains, so a receiver shows no failure of its own for them.

/** A call that a lane took down with it: the attach it waited for failed,
 *  the lane it ran on ended, or it was a hold that waited for a lane its
 *  holder holds on again. Its message is the cause's. A read is not lost,
 *  because the next lane reads it again, so a receiver shows no failure for
 *  it (`lostWithLane`). */
export class RuntimeLaneLost extends Error {
  override readonly cause: unknown

  constructor(cause: unknown) {
    super(attachRefusal(cause)?.message ?? (cause instanceof Error ? cause.message : String(cause)))
    this.name = "RuntimeLaneLost"
    this.cause = cause
  }
}

/** The runtime's own refusal inside a failed attempt, wherever the transport
 *  wrapped it: Effect's socket errors carry the dial failure under `reason`,
 *  ordinary errors under `cause`. */
export function attachRefusal(error: unknown): AccountAttachFailedError | undefined {
  return findCause(error, (cause): cause is AccountAttachFailedError => cause instanceof AccountAttachFailedError)
}

/** Whether a failed attempt could not open its socket at all: nothing
 *  listens where the runtime was. A refusal the runtime stated is not one. */
export function foundNothingListening(error: unknown): boolean {
  return attachRefusal(error) === undefined && findCause(error, (cause): cause is Socket.SocketOpenError => cause instanceof Socket.SocketOpenError) !== undefined
}

/** Whether a call, or the event lane, ended because the runtime closed the
 *  connection cleanly (code 1000), as a planned stop does when it ends every
 *  lane. What the connection carried was lost with it, not refused or broken:
 *  the attach that follows reads everything again, and a record of it belongs
 *  below the default level, beside the other outcomes of a routine stop. */
export function lostToCleanClose(error: unknown): boolean {
  return findCause(error, (cause): cause is Socket.SocketCloseError => cause instanceof Socket.SocketCloseError && cause.code === 1000) !== undefined
}

/** Whether a call failed with its lane rather than on its own: the attach it
 *  waited for failed, the lane it ran on broke or closed, the runtime refused
 *  the lane (a client of another build or another protocol, which fails
 *  every call that waited for the lane's subscription; the connection's
 *  health shows that refusal), or it was a hold the next lane carries
 *  again. The next lane reads everything again, so a receiver shows no
 *  failure for it and does not retry a read. A mutation lost this way has
 *  an unknown outcome: the runtime can have applied it. Its owner sends it
 *  again only when the runtime answers a copy as a receipt, as a person's
 *  message under its submission identity is (ARCH-SESSIONS-030). */
export function lostWithLane(error: unknown): boolean {
  return findCause(error, (cause): cause is unknown => cause instanceof RuntimeLaneLost
    || Socket.isSocketError(cause)
    || cause instanceof Socket.SocketReadError
    || cause instanceof Socket.SocketWriteError
    || cause instanceof Socket.SocketOpenError
    || cause instanceof Socket.SocketCloseError
    || (cause instanceof RuntimeProtocolError && (cause.kind === "client-mismatch" || cause.kind === "protocol-mismatch"))) !== undefined
}

/** A best-effort call whose deadline passed while the connection heard
 *  nothing from the runtime after the call was made: it waited for a lane
 *  that did not open, or its lane delivered no frame, not even a heartbeat.
 *  The silence is the connection's, not the call's: the lane ends at its
 *  silence deadline and the next lane reads again, or the runtime answers
 *  again, and a silence that lasts raises the connection's fault notice. Its
 *  message is the timeout's. */
export class RuntimeSilent extends Error {
  override readonly cause: RuntimeCallTimeout

  constructor(cause: RuntimeCallTimeout) {
    super(cause.message)
    this.name = "RuntimeSilent"
    this.cause = cause
  }
}

/** Whether the connection, not the call, explains a failure: the call was
 *  lost with its lane (`lostWithLane`), or it timed out while the runtime
 *  was silent (`RuntimeSilent`). A receiver shows no failure of its own for
 *  it, because the connection's health already says what a person must know:
 *  nothing while recovery heals it, and the one fault notice when it does
 *  not. A reader still reads again after a silent timeout, since its lane
 *  may live on. */
export function explainedByConnection(error: unknown): boolean {
  return lostWithLane(error) || findCause(error, (cause): cause is RuntimeSilent => cause instanceof RuntimeSilent) !== undefined
}

/** Whether a call failed only because its project is paused: the executor
 *  is not running and nothing has asked for it, so the runtime ran nothing
 *  and answers every such call the same way until something asks. An
 *  expected outcome, whose record belongs below the default level. */
export function declinedByPausedProject(error: unknown): boolean {
  return findCause(error, (cause): cause is RuntimeProtocolError => cause instanceof RuntimeProtocolError && cause.kind === "not-running") !== undefined
}

/** Whether a read failed only because an executor generation change voided
 *  its answer. The change already told every client to read again, so the
 *  failure loses nothing: an expected outcome, whose record belongs below
 *  the default level. */
export function supersededByGenerationChange(error: unknown): boolean {
  return findCause(error, (cause): cause is RuntimeProtocolError => cause instanceof RuntimeProtocolError && cause.kind === "superseded") !== undefined
}

/** Whether a failed attempt is the runtime refusing this page's client bundle. */
export function isClientMismatch(error: unknown): boolean {
  return findCause(error, (cause): cause is RuntimeProtocolError => cause instanceof RuntimeProtocolError && cause.kind === "client-mismatch") !== undefined
}

/** The runtime's refusal of the protocol version this client states, in its
 *  own words and with the release the runtime runs, when a failed attempt is
 *  one. */
export function protocolRefusal(error: unknown): { readonly message: string; readonly refusal: RuntimeProtocolRefusal } | undefined {
  const refused = findCause(error, (cause): cause is RuntimeProtocolError => cause instanceof RuntimeProtocolError && cause.kind === "protocol-mismatch")
  return refused?.runtime === undefined ? undefined : { message: refused.message, refusal: { kind: "protocol-mismatch", ...refused.runtime } }
}

function findCause<T>(error: unknown, accept: (cause: unknown) => cause is T): T | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    if (accept(current)) return current
    // SocketError's cause aliases reason.cause, so following it first skips
    // the typed read/write error that owns the boundary failure.
    current = "reason" in current && current.reason !== undefined ? current.reason : "cause" in current ? current.cause : undefined
  }
  return undefined
}

/** Timer delivery can be delayed while a page is suspended. */
export class LaneSilence extends Error {
  constructor(readonly resumed: boolean) {
    super("runtime event lane silent past deadline")
  }
}

export function laneEndCause(error: unknown): LaneEndCause {
  const silence = findCause(error, (cause): cause is LaneSilence => cause instanceof LaneSilence)
  if (silence !== undefined) return { kind: silence.resumed ? "requested" : "silent" }
  const close = findCause(error, (cause): cause is Socket.SocketCloseError => cause instanceof Socket.SocketCloseError)
  if (close !== undefined) return { kind: "closed", code: close.code }
  if (findCause(error, (cause): cause is Socket.SocketReadError => cause instanceof Socket.SocketReadError)) return { kind: "read-error" }
  if (findCause(error, (cause): cause is Socket.SocketWriteError => cause instanceof Socket.SocketWriteError)) return { kind: "write-error" }
  if (attachRefusal(error) !== undefined || isClientMismatch(error) || protocolRefusal(error) !== undefined) return { kind: "refused" }
  return { kind: "defect" }
}
