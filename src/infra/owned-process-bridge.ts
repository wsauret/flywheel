import type { OwnedProcessBackend } from "./owned-subprocess-backend.js"
import { createMessagePortProcessEndpoint, type InternalProcessEndpoint } from "./internal-process-channel.js"
import { errorMessage } from "./error-message.js"
import { Log } from "./log.js"
import { lockCommandSupervisorEntry } from "./command-supervisor-entry.js"
import {
  decodeGuardianCommand,
  decodeGuardianLeaseOutcome,
  hasExactKeys,
  type GuardianCommand,
  type GuardianLeaseOutcome,
} from "./process-guardian-protocol.js"
import { createLauncherScope, createProcessSupervisor, type GuardianControl, type GuardianGeneration, type GuardianLease, type LauncherScope, type OwnershipClosure } from "./process-supervisor.js"
import { withDeadline } from "./with-deadline.js"

import { isRecord } from "./record.js"
/** Extends one process's container ownership into a Worker thread.
 *
 *  The Worker launches its own containers because it needs their stdio: a
 *  command's streams cannot cross a thread boundary. Ownership still belongs
 *  to the one guardian the main thread holds, so the Worker forwards adopt and
 *  release over a transferred MessagePort and the guardian remains the sole
 *  crash backstop.
 *
 *  Exactly one owner settles a container: the Worker-side `OwnedProcess` that
 *  launched it. So generation close is a request first - the main thread asks
 *  the Worker to close its scope and waits for the answer under one absolute
 *  deadline - and the guardian's own generation close after it. The guardian
 *  is what makes the close final: it ends whatever the Worker did not, and
 *  answers with what survived, so a thread that died without saying anything
 *  costs the deadline rather than the ownership. */

const log = Log.create({ service: "owned-process-bridge" })

const BRIDGE_PROTOCOL_VERSION = 1

/** Bounds one bridged adopt or release. Past it the Worker's launch fails
 *  closed instead of parking on a peer that is gone: a MessagePort reports no
 *  peer death, so the wait has to bound itself. */
const DEFAULT_REQUEST_DEADLINE_MS = 10_000

/** Bounds generation close. One deadline covers the whole close, so a
 *  generation holding many containers ends exactly like one holding a single
 *  container. */
const DEFAULT_CLOSE_DEADLINE_MS = 15_000

/** Worker to main. */
type OwnedBridgeCall =
  | { readonly kind: "lease"; readonly id: number; readonly command: GuardianCommand }
  | { readonly kind: "guardian-pid"; readonly id: number }
  | { readonly kind: "terminated" }

/** Main to worker. */
type OwnedBridgeReturn =
  | { readonly kind: "lease"; readonly id: number; readonly outcome: GuardianLeaseOutcome }
  | { readonly kind: "guardian-pid"; readonly id: number; readonly pid: number }
  | { readonly kind: "terminate" }
  | { readonly kind: "closed" }
type CallKeys = { readonly [Kind in OwnedBridgeCall["kind"]]: readonly string[] }
type ReturnKeys = { readonly [Kind in OwnedBridgeReturn["kind"]]: readonly string[] }

/** The generation's half of the bridge on the thread that owns the guardian. */
export interface OwnedProcessBridge {
  /** Ends the generation: asks the Worker-side owner to run its settlement,
   *  waits for it under one absolute deadline, ends the channel, and reports
   *  whether the generation is provably empty. Repeated calls join the first
   *  close. */
  close(): Promise<OwnershipClosure>
  /** Reports an observed Worker exit, releasing any peer wait without claiming
   *  its containers are empty. close() still awaits guardian settlement. */
  peerExited(): void
  /** Abandons a peer that never completed admission, then settles the guardian generation without waiting for a reply. */
  abort(): Promise<OwnershipClosure>
}

export interface ServeOwnedProcessBridgeInput {
  readonly port?: MessagePort
  readonly endpoint?: InternalProcessEndpoint<unknown, unknown>
  /** Opens the generation the peer leases into. A bridge that outlives a
   *  guardian asks it again, for a generation in the guardian that replaced
   *  the one that exited. */
  readonly guardian: Pick<GuardianControl, "openGeneration">
  readonly closeDeadlineMs?: number
}

export function serveOwnedProcessBridge(input: ServeOwnedProcessBridgeInput): OwnedProcessBridge {
  const endpoint = bridgeEndpoint(input)
  const closeDeadlineMs = input.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS
  let settle: () => void = () => {}
  const terminated = new Promise<void>((resolve) => { settle = resolve })
  let closing: Promise<OwnershipClosure> | null = null

  // The generation is declared before the peer can lease anything into it, and
  // the guardian keeps its record until this bridge closes it. That record is
  // the only one: nothing here counts containers a second time.
  const open = (): Promise<GuardianGeneration> => {
    const opened = input.guardian.openGeneration()
    opened.catch((err: unknown) => {
      log.warn("owned-process bridge could not open its generation", { error: errorMessage(err) })
    })
    return opened
  }
  let generation = open()

  // Every launch asks for the guardian's pid before it leases, and its
  // container depends on the guardian that pid names, so the answer comes
  // from the generation that the lease then goes to. A guardian that exited
  // took its generation and every lease in it with it, and a generation that
  // could not be opened holds nothing. Neither can answer, so the ask opens
  // the next generation, in the guardian that the supervisor starts next.
  const guardianPid = async (): Promise<number> => {
    const asked = generation
    try {
      return await (await asked).pid()
    } catch {
      if (generation === asked) generation = open()
      return await (await generation).pid()
    }
  }

  /** Posts one frame, reporting whether the peer could still be reached. A dead
   *  thread takes its port with it, and a frame nobody can hear is not an error
   *  this side can act on. */
  const answer = (frame: OwnedBridgeReturn): boolean => {
    try {
      void endpoint.send(encodeReturn(frame)).catch((err: unknown) => {
        log.warn("owned-process bridge could not reach its peer", { frame: frame.kind, error: errorMessage(err) })
      })
      return true
    } catch (err) {
      log.warn("owned-process bridge could not reach its peer", { frame: frame.kind, error: errorMessage(err) })
      return false
    }
  }

  const bridge: OwnedProcessBridge = {
    peerExited: settle,
    close() {
      // The channel is gone after the first close, so a later call can only
      // repeat what that one proved.
      closing ??= runClose(true)
      return closing
    },
    abort() {
      closing ??= runClose(false)
      return closing
    },
  }
  endpoint.onClose(() => {
    settle()
    void bridge.abort()
  })

  endpoint.onMessage((data) => {
    const call = decodeCall(data)
    if (!call) {
      // A peer that is not speaking this protocol is not a peer this
      // generation's containers may be left with, so the generation ends
      // instead of the frame being dropped.
      log.error("owned-process bridge received a frame the peer could not have produced; ending the generation")
      void bridge.close().then(
        (closure) => {
          if (!closure.settled) log.warn("the generation of an unusable peer did not prove settlement", { reason: closure.reason })
        },
        (err: unknown) => {
          log.warn("the generation of an unusable peer failed to close", { error: errorMessage(err) })
        },
      )
      return
    }
    if (call.kind === "terminated") {
      settle()
      return
    }
    if (call.kind === "guardian-pid") {
      void guardianPid().then(
        (pid) => { answer({ kind: "guardian-pid", id: call.id, pid }) },
        (err: unknown) => {
          log.warn("owned-process bridge could not reach the guardian", { error: errorMessage(err) })
        },
      )
      return
    }
    // The command is bound to this generation here, on the side that owns it:
    // a peer states a token and a pid and can never name another owner.
    void generation.then((owner) => owner.request(call.command)).then(
      (outcome) => { answer({ kind: "lease", id: call.id, outcome }) },
      (err: unknown) => {
        // The peer bounds its own wait, so a lost reply fails that launch
        // rather than parking it.
        log.warn("owned-process bridge could not reach the guardian", { error: errorMessage(err) })
      },
    )
  })

  const runClose = async (requestPeerSettlement: boolean): Promise<OwnershipClosure> => {
    // Asked first: the Worker-side owner is the only one that can settle its
    // containers cleanly. A thread that died with its port cannot be asked,
    // and a candidate that never completed admission has no work to settle.
    if (requestPeerSettlement && answer({ kind: "terminate" })) {
      // A bounded wait whose timer ends with the wait: a sleep left running
      // after the peer answered would hold the process open for the whole
      // deadline, and a runtime process ends only when its loop is empty.
      let deadline: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, closeDeadlineMs)
        deadline.unref?.()
      })
      try {
        await Promise.race([terminated, expired])
      } finally {
        if (deadline !== undefined) clearTimeout(deadline)
      }
    }
    if (requestPeerSettlement) answer({ kind: "closed" })
    endpoint.close("owned-process bridge is closed")
    // The guardian settles the rest. Whatever the peer did or did not do, this
    // is the answer: it ends every container still leased to the generation and
    // reports what survived.
    try {
      return await (await generation).close()
    } catch (err) {
      return { settled: false, reason: `the generation never reached the guardian: ${errorMessage(err)}` }
    }
  }

  return bridge
}

export interface ConnectOwnedProcessBridgeInput {
  readonly port?: MessagePort
  readonly endpoint?: InternalProcessEndpoint<unknown, unknown>
  readonly requestDeadlineMs?: number
  /** Injected so the bridge is testable on a host that must not spawn. */
  readonly backend?: OwnedProcessBackend
}

/** The Worker's half of the bridge. */
export interface OwnedProcessBridgePeer {
  /** Launches containers here that the guardian on the other side owns.
   *  Closing it is the only way they end, whether the close comes from this
   *  thread's own teardown or from the owner ending the generation. */
  readonly launcher: LauncherScope
  /** Aborts when the owner ends the generation: its termination request, the
   *  end of the channel, or a frame the owner could not have produced. It
   *  aborts before this side closes `launcher`, so the work that holds it
   *  hears the end before its commands do. A close this side makes itself
   *  does not abort it. */
  readonly lifetime: AbortSignal
}

export function connectOwnedProcessBridge(input: ConnectOwnedProcessBridgeInput): OwnedProcessBridgePeer {
  const endpoint = bridgeEndpoint(input)
  const requestDeadlineMs = input.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS
  // A Worker thread holds its own copy of the supervisor module, so it locks
  // the entry for itself. An injected backend stands for the whole platform
  // launch surface, so only the real one locks. The lock is joined by nothing:
  // a launch that races it uses the live module, which is the pre-lock
  // behavior.
  if (input.backend === undefined) {
    void lockCommandSupervisorEntry().then((lock) => {
      if (lock.kind === "failed") log.warn("command supervisor entry was not locked; launches read the live module", { reason: lock.reason })
    })
  }
  interface PendingCall {
    readonly deliver: (frame: OwnedBridgeReturn) => void
    readonly fail: (err: Error) => void
  }
  const pending = new Map<number, PendingCall>()
  let nextId = 0
  let closedReason: string | undefined

  /** Posts one frame, reporting whether the peer could still be reached. */
  const send = (frame: OwnedBridgeCall): boolean => {
    try {
      void endpoint.send(encodeCall(frame)).catch((err: unknown) => {
        log.warn("owned-process bridge could not reach its peer", { frame: frame.kind, error: errorMessage(err) })
      })
      return true
    } catch (err) {
      log.warn("owned-process bridge could not reach its peer", { frame: frame.kind, error: errorMessage(err) })
      return false
    }
  }

  /** Ends the channel: a reply can no longer arrive, so every wait on it fails
   *  now instead of parking until its deadline, and every later call fails
   *  before it is written. */
  const endChannel = (reason: string): void => {
    closedReason ??= reason
    const waiting = [...pending.values()]
    pending.clear()
    for (const waiter of waiting) waiter.fail(new Error(reason))
    endpoint.close(reason)
  }

  /** One bridged round trip. A MessagePort reports no peer death, so the wait
   *  bounds itself and an answer of the wrong kind fails the call rather than
   *  being read as the right one. */
  const call = <T>(
    request: (id: number) => OwnedBridgeCall,
    answer: (frame: OwnedBridgeReturn) => T | undefined,
  ): Promise<T> => {
    if (closedReason) return Promise.reject(new Error(closedReason))
    const id = ++nextId
    const answered = new Promise<T>((resolve, reject) => {
      pending.set(id, {
        deliver: (frame) => {
          const value = answer(frame)
          if (value === undefined) reject(new Error("owned-process bridge answered a call with a frame it did not ask for"))
          else resolve(value)
        },
        fail: reject,
      })
      if (!send(request(id))) reject(new Error("owned-process bridge write failed"))
    })
    // The map holds a reply slot, not the caller's wait: a reply, a write
    // failure and the deadline all end the call, and every one of them releases
    // the slot.
    return withDeadline(answered, requestDeadlineMs).finally(() => { pending.delete(id) })
  }

  // The guardian's pid is asked for at each launch: the other side answers
  // from the generation this thread leases into, and it opens a new one in
  // the guardian that replaces a guardian that exited.
  const lease: GuardianLease = {
    request: (command) => call(
      (id) => ({ kind: "lease", id, command }),
      (answered) => (answered.kind === "lease" ? answered.outcome : undefined),
    ),
    pid: () => call(
      (id) => ({ kind: "guardian-pid", id }),
      (answered) => (answered.kind === "guardian-pid" ? answered.pid : undefined),
    ),
  }

  const supervisor = createProcessSupervisor({ lease, ...(input.backend ? { backend: input.backend } : {}) })
  const scope = createLauncherScope(supervisor)
  const lifetime = new AbortController()

  /** Ends the generation on this side because its owner ended it: the
   *  lifetime aborts first, then every container this thread launched ends,
   *  and a close that could not prove settlement is visible rather than
   *  silent. */
  const endGeneration = (reason: string): Promise<void> => {
    lifetime.abort(new DOMException(reason, "AbortError"))
    return scope.close().then(
      (closure) => {
        if (!closure.settled) log.warn("worker generation closed without proving settlement", { reason: closure.reason })
      },
      (err: unknown) => {
        log.warn("worker generation close failed", { error: errorMessage(err) })
      },
    )
  }
  endpoint.onClose((reason) => {
    endChannel(reason.message)
    void endGeneration(reason.message)
  })

  endpoint.onMessage((data) => {
    const frame = decodeReturn(data)
    if (!frame) {
      // The peer that owns these containers is no longer speaking this
      // protocol, so nothing it says can be trusted with them: the channel
      // ends and the containers end with it.
      log.error("owned-process bridge received a frame the peer could not have produced; ending what it launched")
      endChannel("owned-process bridge received a frame the peer could not have produced")
      void endGeneration("owned-process bridge received a frame the peer could not have produced")
      return
    }
    if (frame.kind === "closed") {
      endChannel("owned-process bridge is closed")
      return
    }
    if (frame.kind === "terminate") {
      void endGeneration("owned-process bridge owner ended the generation").finally(() => { send({ kind: "terminated" }) })
      return
    }
    pending.get(frame.id)?.deliver(frame)
  })

  return { launcher: scope, lifetime: lifetime.signal }
}

/** Both peers are Flywheel-owned, so this is internal IPC: every frame is
 *  validated in full before it changes any state. The lease traffic inside
 *  rides the guardian's own decoders, so a Worker reaches the guardian through
 *  exactly the vocabulary the control pipe accepts, and through no more of it:
 *  the capability and the generation are stamped on the other side. */
function encodeCall(call: OwnedBridgeCall) {
  if (call.kind === "terminated") return { v: BRIDGE_PROTOCOL_VERSION, kind: "terminated" }
  if (call.kind === "guardian-pid") return { v: BRIDGE_PROTOCOL_VERSION, kind: "guardian-pid", id: call.id }
  return { v: BRIDGE_PROTOCOL_VERSION, kind: "lease", id: call.id, command: call.command }
}

function encodeReturn(frame: OwnedBridgeReturn) {
  if (frame.kind === "terminate") return { v: BRIDGE_PROTOCOL_VERSION, kind: "terminate" }
  if (frame.kind === "closed") return { v: BRIDGE_PROTOCOL_VERSION, kind: "closed" }
  if (frame.kind === "guardian-pid") return { v: BRIDGE_PROTOCOL_VERSION, kind: "guardian-pid", id: frame.id, pid: frame.pid }
  return { v: BRIDGE_PROTOCOL_VERSION, kind: "lease", id: frame.id, outcome: frame.outcome }
}

/** The exact key set of each bridge frame. */
const CALL_KEYS: CallKeys = {
  terminated: ["v", "kind"],
  "guardian-pid": ["v", "kind", "id"],
  lease: ["v", "kind", "id", "command"],
}

const RETURN_KEYS: ReturnKeys = {
  terminate: ["v", "kind"],
  closed: ["v", "kind"],
  "guardian-pid": ["v", "kind", "id", "pid"],
  lease: ["v", "kind", "id", "outcome"],
}

function decodeCall(data: unknown): OwnedBridgeCall | undefined {
  if (!isRecord(data)) return undefined
  const fields = bridgeFields(data, CALL_KEYS)
  if (!fields) return undefined
  if (fields.kind === "terminated") return { kind: "terminated" }
  const id = correlationId(fields.id)
  if (id === undefined) return undefined
  if (fields.kind === "guardian-pid") return { kind: "guardian-pid", id }
  const command = decodeGuardianCommand(fields.command)
  return command ? { kind: "lease", id, command } : undefined
}

function decodeReturn(data: unknown): OwnedBridgeReturn | undefined {
  if (!isRecord(data)) return undefined
  const fields = bridgeFields(data, RETURN_KEYS)
  if (!fields) return undefined
  if (fields.kind === "terminate") return { kind: "terminate" }
  if (fields.kind === "closed") return { kind: "closed" }
  const id = correlationId(fields.id)
  if (id === undefined) return undefined
  if (fields.kind === "guardian-pid") {
    const pid = correlationId(fields.pid)
    return pid === undefined ? undefined : { kind: "guardian-pid", id, pid }
  }
  const outcome = decodeGuardianLeaseOutcome(fields.outcome)
  return outcome ? { kind: "lease", id, outcome } : undefined
}

/** The fields of one frame this bridge could have produced: the version it
 *  defines, a kind it names, and exactly the keys that kind carries. */
interface BridgeFields {
  readonly [key: string]: unknown
}

function bridgeFields<Kind extends string>(
  data: BridgeFields,
  keys: { readonly [Key in Kind]: readonly string[] },
): (BridgeFields & { readonly kind: Kind }) | undefined {
  if (!isRecord(data) || data.v !== BRIDGE_PROTOCOL_VERSION) return undefined
  const kind = data.kind
  if (typeof kind !== "string" || !Object.hasOwn(keys, kind)) return undefined
  // SAFETY: Exact-key validation proves that the structured-clone discriminant is one of the supplied keys.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: MessagePort structured clones require a discriminant view after exact-key validation
  const named = kind as Kind
  // SAFETY: Version, discriminant, and exact-key validation prove the complete bridge frame shape.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: MessagePort structured clones require their validated frame shape
  return hasExactKeys(data, keys[named]) ? data as BridgeFields & { readonly kind: Kind } : undefined
}

function correlationId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function bridgeEndpoint(input: {
  readonly port?: MessagePort
  readonly endpoint?: InternalProcessEndpoint<unknown, unknown>
}): InternalProcessEndpoint<unknown, unknown> {
  if (input.endpoint) return input.endpoint
  if (input.port) return createMessagePortProcessEndpoint({ port: input.port, decode: (value) => value })
  throw new Error("owned-process bridge requires an endpoint")
}
