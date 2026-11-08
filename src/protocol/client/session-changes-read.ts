/** The read that the session changes controller keeps out while it shows a
 *  review (ARCH-PROTOCOL-045: the changes domain publishes invalidations).
 *
 *  The domain's patches carry no state, so each one asks for a read. A change
 *  never voids the read that is out: that read answers from an anchor it took
 *  before it awaited, so the change is newer than its answer. The answer is
 *  shown, marked behind, and one more read follows it. A burst of changes
 *  during one read asks for exactly one more. Only a lane, or a runtime
 *  invalidation that reads at once, voids the read that is out
 *  (ARCH-PROTOCOL-014). */
export interface ChangesRead {
  /** A change landed. A read that begins after this call covers it; the
   *  promise settles when that read ends, answered or not. */
  changed(): Promise<void>
  /** The read that is out answers for nothing: the runtime invalidated the
   *  domain, or a person or a write of this client asks for it now. A read
   *  begins now, or at the next lane while a lane break holds reads. */
  voided(): Promise<void>
  /** The lane broke: nothing is read until the next lane opens. */
  paused(): void
  /** A lane opened. Its read begins now and covers every request held. */
  opened(): Promise<void>
  /** Whether `read` is still the read that is out, so its answer may be adopted. */
  current(read: number): boolean
  /** Whether a change landed after `read` began, so its answer is already behind. */
  behind(read: number): boolean
}

type Waiters = PromiseWithResolvers<void>

/** `paused` holds requests for the next lane; `queued` begins a read on the
 *  next microtask, which coalesces one delivery burst; `reading` has one read
 *  out, and `next` holds the requests that landed after it began, so it is
 *  both the follow-up's waiters and the statement that the answer is behind. */
type ReadPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "paused"; readonly covering: Waiters | undefined }
  | { readonly kind: "queued"; readonly covering: Waiters }
  | { readonly kind: "reading"; readonly read: number; readonly next: Waiters | undefined }

type ReadEvent =
  | { readonly kind: "changed" }
  | { readonly kind: "voided" }
  | { readonly kind: "paused" }
  | { readonly kind: "opened" }
  | { readonly kind: "began"; readonly read: number }
  | { readonly kind: "ended"; readonly read: number }

const IDLE: ReadPhase = { kind: "idle" }

/** The requests no read has begun for yet. */
function waitingOf(phase: ReadPhase): Waiters | undefined {
  switch (phase.kind) {
    case "idle": return undefined
    case "paused": case "queued": return phase.covering
    case "reading": return phase.next
  }
}

/** The one transition of the read phase. Events about a read that is no
 *  longer out return the phase unchanged, so a voided read's late end moves
 *  nothing. */
function nextReadPhase(phase: ReadPhase, event: ReadEvent): ReadPhase {
  switch (event.kind) {
    case "changed":
      if (waitingOf(phase) !== undefined) return phase
      if (phase.kind === "reading") return { ...phase, next: Promise.withResolvers() }
      return phase.kind === "paused" ? { kind: "paused", covering: Promise.withResolvers() } : { kind: "queued", covering: Promise.withResolvers() }
    case "voided":
      if (phase.kind === "paused") return phase.covering ? phase : { kind: "paused", covering: Promise.withResolvers() }
      return phase.kind === "queued" ? phase : { kind: "queued", covering: waitingOf(phase) ?? Promise.withResolvers() }
    case "opened": return phase.kind === "queued" ? phase : { kind: "queued", covering: waitingOf(phase) ?? Promise.withResolvers() }
    case "paused": return { kind: "paused", covering: waitingOf(phase) }
    case "began": return phase.kind === "queued" ? { kind: "reading", read: event.read, next: undefined } : phase
    case "ended":
      if (phase.kind !== "reading" || phase.read !== event.read) return phase
      return phase.next ? { kind: "queued", covering: phase.next } : IDLE
  }
}

/** `read` performs one read and adopts its answer only while `current(read)`
 *  holds. It must not reject: a failure is the caller's state to show. */
export function createChangesRead(read: (read: number) => Promise<void>): ChangesRead {
  let phase: ReadPhase = IDLE
  let reads = 0

  function enter(event: ReadEvent): void {
    const before = phase
    phase = nextReadPhase(phase, event)
    if (phase.kind === "queued" && before.kind !== "queued") queueMicrotask(() => { void begin() })
  }

  async function begin(): Promise<void> {
    if (phase.kind !== "queued") return
    const { covering } = phase
    const id = ++reads
    enter({ kind: "began", read: id })
    try {
      await read(id)
    } finally {
      enter({ kind: "ended", read: id })
      covering.resolve()
    }
  }

  const waiting = (): Promise<void> => waitingOf(phase)?.promise ?? Promise.resolve()

  return {
    changed() {
      enter({ kind: "changed" })
      return waiting()
    },
    voided() {
      enter({ kind: "voided" })
      return waiting()
    },
    paused() { enter({ kind: "paused" }) },
    opened() {
      enter({ kind: "opened" })
      return waiting()
    },
    current(id) { return phase.kind === "reading" && phase.read === id },
    behind(id) { return phase.kind === "reading" && phase.read === id && phase.next !== undefined },
  }
}
