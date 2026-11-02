import { randomBytes, timingSafeEqual } from "node:crypto"
import { Redacted, Schema } from "effect"
import type { InternalProcessChannelLimits, InternalProcessEndpoint } from "../../infra/internal-process-channel.js"
import { isRecord, type UnknownRecord } from "../../infra/record.js"
import { PROJECT_STATE_MAX_BYTES } from "./project-state-protocol.js"
import { RuntimeChatDefaultSchema } from "../../protocol/runtime-protocol-schemas.js"
import { ReplacementBlockerSchema } from "./replacement-blockers.js"
import type { ReplacementState } from "./replacement-owner.js"

export type ProjectExecutorEndpointKind = "control" | "output" | "lifecycle" | "state"

export type ProjectExecutorChannelLimits = Required<InternalProcessChannelLimits>

const CHANNEL_FRAME_BYTES = 1_048_576
/** How long a lost channel may stay detached before its generation ends. Long
 *  enough for a transport hiccup and a backoff walk, short enough that a
 *  genuinely dead peer whose exit the account somehow missed cannot hold a
 *  generation open indefinitely. */
export const PROJECT_EXECUTOR_REATTACH_DEADLINE_MS = 30_000
/** How often, in production, the executor states on its lifecycle channel
 *  that its event loop answers, from the moment the channel is up until it
 *  stops. The account tells each generation this period in its
 *  initialization. */
export const EXECUTOR_HEARTBEAT_INTERVAL_MS = 1_000
const REATTACH_FIRST_RETRY_MS = 1_000
const REATTACH_MAX_DELAY_MS = 8_000

/** How long the executor waits before its reconnect attempt `attempt` of a
 *  lost channel, counted from zero: at once, then 1, 2, 4, and 8 seconds, and
 *  every 8 seconds after that. The walk has no end of its own: the account
 *  ends the generation when the deadline passes, and that closes the channel
 *  the walk serves. */
export function projectExecutorReattachDelayMs(attempt: number): number {
  return attempt === 0 ? 0 : Math.min(REATTACH_FIRST_RETRY_MS * 2 ** (attempt - 1), REATTACH_MAX_DELAY_MS)
}
// A message is what one side hands the other whole: a bounded state page with
// its envelope, a query reply, a stored-fact batch. The frame layer splits it,
// so this ceiling protects reassembly memory and nothing a caller designs
// against. Well above any bounded page, it fails only a runaway producer.
const CHANNEL_MESSAGE_BYTES = 64 * 1_048_576

/** The wire bounds of one executor channel. The queue bound orders senders
 *  under pressure; a full queue makes a sender wait, never fail. */
export function projectExecutorChannelLimits(kind: ProjectExecutorEndpointKind): ProjectExecutorChannelLimits {
  return {
    maxFrameBytes: CHANNEL_FRAME_BYTES,
    maxMessageBytes: CHANNEL_MESSAGE_BYTES,
    maxQueuedBytes: kind === "state" ? PROJECT_STATE_MAX_BYTES : CHANNEL_FRAME_BYTES * 4,
  }
}

const ENDPOINT_KINDS: readonly ProjectExecutorEndpointKind[] = ["control", "output", "lifecycle", "state"]

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const Credential = Schema.String.check(Schema.isMinLength(32))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ProjectExecutorInitializationDtoSchema = Schema.Struct({
  projectId: NonEmptyString,
  /** The account registry's label for the project, which every blocker the
   *  executor reports carries so a person in another project can name it. */
  projectLabel: NonEmptyString,
  generation: PositiveInteger,
  workerUrl: NonEmptyString,
  allowPersistentProcesses: Schema.Boolean,
  /** How often the executor sends a heartbeat, which is also the period the
   *  account counts missed heartbeats in, so both sides read one value. The
   *  initialization reaches only an executor of the account's own build, so
   *  the field needs no conversion. */
  heartbeatIntervalMs: PositiveInteger,
  directories: Schema.Struct({
    userDataRoot: NonEmptyString,
    accountHome: NonEmptyString,
    projectRoot: NonEmptyString,
    executionCwd: NonEmptyString,
    canonicalRepositoryRoot: Schema.optionalKey(NonEmptyString),
  }),
  endpoints: Schema.Struct({
    control: NonEmptyString,
    state: NonEmptyString,
    output: NonEmptyString,
    lifecycle: NonEmptyString,
  }),
  credentials: Schema.Struct({
    control: Credential,
    state: Credential,
    output: Credential,
    lifecycle: Credential,
  }),
})

type ProjectExecutorInitializationDto = typeof ProjectExecutorInitializationDtoSchema.Type

export interface ProjectExecutorInitialization extends Omit<ProjectExecutorInitializationDto, "credentials"> {
  readonly credentials: {
    readonly control: ProjectExecutorCredential["credential"]
    readonly output: ProjectExecutorCredential["credential"]
    readonly lifecycle: ProjectExecutorCredential["credential"]
    readonly state: ProjectExecutorCredential["credential"]
  }
}

/** Converts runtime initialization into the plaintext environment DTO. */
export function encodeProjectExecutorInitialization(value: ProjectExecutorInitialization): ProjectExecutorInitializationDto {
  return Schema.decodeUnknownSync(ProjectExecutorInitializationDtoSchema, { onExcessProperty: "error" })({
    ...value,
    credentials: Object.fromEntries(ENDPOINT_KINDS.map((kind) => [kind, credentialString(value.credentials[kind])])),
  })
}

export function decodeProjectExecutorInitialization(value: unknown): ProjectExecutorInitialization | undefined {
  try {
    const decoded = Schema.decodeUnknownSync(ProjectExecutorInitializationDtoSchema, { onExcessProperty: "error" })(value)
    const credentials: ProjectExecutorInitialization["credentials"] = {
      control: credentialFromString(decoded.credentials.control),
      output: credentialFromString(decoded.credentials.output),
      lifecycle: credentialFromString(decoded.credentials.lifecycle),
      state: credentialFromString(decoded.credentials.state),
    }
    return {
      ...decoded,
      credentials,
    }
  } catch {
    return undefined
  }
}

/** The account's replacement state as the executor receives it: the one
 *  value its published update view derives from. */
const ReplacementStateSchema: Schema.Codec<ReplacementState> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("requested"), blockers: Schema.Array(ReplacementBlockerSchema) }),
  Schema.Struct({ kind: Schema.Literal("draining"), handoffId: NonEmptyString }),
])

/** Lifecycle commands cannot execute arbitrary commands or advertise runtime success.
 *  `stop` says whether a client holds the project as it stops: each tab such
 *  a client shows attaches its session again, so the stop keeps an empty
 *  chat for it (ARCH-RUNTIME-024).
 *  `blockers` asks for the executor's replacement blockers under a request id;
 *  `replacement` tells the executor the account's current replacement state.
 *  The two handoff commands are a planned replacement's halves (ARCH-SESSIONS-039):
 *  `interrupt_for_replacement` cuts everything running with continuation
 *  authority for the handoff, and `continue_after_replacement`, sent to the
 *  successor's executor, resumes every session that handoff authorized. Each
 *  is answered by a `handoff` event under its id once the work is settled.
 *  `login_shell_path` hands down the PATH the account's login-shell probe
 *  found, whenever it arrives, so the executor never probes again.
 *  `capacity_wake_recorded` answers the executor's `capacity_wake` under its
 *  id once the account store holds the wake, or with the store's error.
 *  `continue_capacity_waits` asks the executor to continue every capacity
 *  wait no run of it holds (ARCH-SESSIONS-039); a `capacity_continued` event
 *  under its id answers it.
 *  `processor_holds` is the complete set of this executor's containers that
 *  processor admission holds (ARCH-TOOLS-051), each with the number of heavy
 *  containers of every project that wait before it, sent whenever the set
 *  changes and again on every reattach. */
const PROJECT_EXECUTOR_COMMAND_KINDS = ["start", "start_chat_default", "stop", "blockers", "replacement", "interrupt_for_replacement", "continue_after_replacement", "capacity_wake_recorded", "continue_capacity_waits", "login_shell_path", "processor_holds"] as const
const ProjectExecutorCommandSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("start"), chatDefault: RuntimeChatDefaultSchema }),
  Schema.Struct({ kind: Schema.Literal("start_chat_default") }),
  Schema.Struct({ kind: Schema.Literal("stop"), clientsHold: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("blockers"), id: PositiveInteger }),
  Schema.Struct({ kind: Schema.Literal("replacement"), state: ReplacementStateSchema }),
  Schema.Struct({ kind: Schema.Literals(["interrupt_for_replacement", "continue_after_replacement"]), id: PositiveInteger, handoffId: NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("capacity_wake_recorded"), id: PositiveInteger, error: Schema.optionalKey(NonEmptyString) }),
  Schema.Struct({ kind: Schema.Literal("continue_capacity_waits"), id: PositiveInteger }),
  Schema.Struct({ kind: Schema.Literal("login_shell_path"), path: NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("processor_holds"), held: Schema.Array(Schema.Struct({ token: NonEmptyString, ahead: NonNegativeInteger })) }),
])
/** The rows a planned replacement's handoff holds in one project for the
 *  successor, as its executor's stop counted them: one continuation row per
 *  session to resume, one handover row per command to adopt. */
const SuccessorRowsSchema = Schema.Struct({
  continuations: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  handovers: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type SuccessorRows = typeof SuccessorRowsSchema.Type

/** `process` names the executor's own pid, once, as its first lifecycle
 *  event: the account names that pid in the record of an unexpected exit and
 *  keeps the executor's log files by it.
 *  `blockers` answers a request by its id, or reports a change with no id
 *  while a replacement is requested. `handoff` answers a handoff command with
 *  the sessions it interrupted or resumed, or with why it could not.
 *  `stopped` answers a stop; after a planned replacement's cut it counts the
 *  continuation rows and the handover rows the handoff holds in the project,
 *  so the account keeps the project in the handoff row when there is work to
 *  continue or a command to adopt, and names a project the phone held awake
 *  that hands commands over.
 *  `capacity_wake` names the earliest continue time of the capacity waits
 *  the project owes (ARCH-SESSIONS-039), or null for none, under a request
 *  id that `capacity_wake_recorded` answers: before an agent writes the row
 *  of its wait, after a wait is withdrawn, and once the executor's start
 *  continued the waits an earlier executor left. The account opens the
 *  project at that time and asks it to continue them.
 *  `capacity_continued` answers `continue_capacity_waits`: how many due
 *  waits are still owed by a continuation that could not start, the
 *  project's earliest owed time, and the earliest time of a wait the
 *  continuation left for later, at which the account wakes the project next.
 *  `processor_claims` is the complete set of shell containers this executor
 *  owns, for processor admission: each container's ownership token, its
 *  supervisor's pid, which names its process group, its launch time in epoch
 *  milliseconds, and whether a chat's own turn started it. It is sent whenever
 *  the set changes and again on every reattach.
 *  `command_failed` answers one command that could not be done, under its id
 *  when it has one, while the generation keeps serving; a command the
 *  executor could not read names no kind. `failed` ends the generation. */
const ProjectExecutorEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("process"), pid: PositiveInteger }),
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("heartbeat") }),
  Schema.Struct({ kind: Schema.Literal("stopped"), successorRows: Schema.optionalKey(SuccessorRowsSchema) }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("blockers"), id: Schema.optionalKey(PositiveInteger), blockers: Schema.Array(ReplacementBlockerSchema) }),
  Schema.Struct({ kind: Schema.Literal("handoff"), id: PositiveInteger, sessionIds: Schema.Array(NonEmptyString) }),
  Schema.Struct({ kind: Schema.Literal("handoff"), id: PositiveInteger, error: NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("capacity_wake"), id: PositiveInteger, at: Schema.NullOr(NonNegativeInteger) }),
  Schema.Struct({ kind: Schema.Literal("capacity_continued"), id: PositiveInteger, pending: NonNegativeInteger, at: Schema.NullOr(NonNegativeInteger), next: Schema.NullOr(NonNegativeInteger) }),
  Schema.Struct({ kind: Schema.Literal("processor_claims"), claims: Schema.Array(Schema.Struct({ token: NonEmptyString, pid: PositiveInteger, order: NonNegativeInteger, exempt: Schema.Boolean })) }),
  Schema.Struct({ kind: Schema.Literal("command_failed"), command: Schema.optionalKey(Schema.Literals(PROJECT_EXECUTOR_COMMAND_KINDS)), id: Schema.optionalKey(PositiveInteger), reason: NonEmptyString }),
])


export type ProjectExecutorCommand = typeof ProjectExecutorCommandSchema.Type
export type ProjectExecutorEvent = typeof ProjectExecutorEventSchema.Type

export function decodeProjectExecutorCommand(value: unknown): ProjectExecutorCommand | undefined {
  try {
    return Schema.decodeUnknownSync(ProjectExecutorCommandSchema, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
}

export function decodeProjectExecutorEvent(value: unknown): ProjectExecutorEvent | undefined {
  try {
    return Schema.decodeUnknownSync(ProjectExecutorEventSchema, { onExcessProperty: "error" })(value)
  } catch {
    return undefined
  }
}

/** A credential admits one endpoint of one project generation exactly once. */
export interface ProjectExecutorCredential {
  readonly projectId: string
  readonly generation: number
  readonly endpoint: ProjectExecutorEndpointKind
  readonly credential: Redacted.Redacted<Uint8Array>
}

export interface ProjectExecutorAuthenticator {
  issue(endpoint: ProjectExecutorEndpointKind): ProjectExecutorCredential
  accept(candidate: ProjectExecutorCredential): boolean
  revoke(): void
}

/** Creates the sole admission authority for one executor generation. */
export function createProjectExecutorAuthenticator(identity: {
  readonly projectId: string
  readonly generation: number
}): ProjectExecutorAuthenticator {
  const issued = new Map<ProjectExecutorEndpointKind, ProjectExecutorCredential["credential"]>()
  let revoked = false
  return {
    issue(endpoint) {
      if (revoked) throw new Error("project executor generation is closed")
      if (issued.has(endpoint)) throw new Error(`${endpoint} credential was already issued`)
      const credential = Redacted.make<Uint8Array>(randomBytes(32))
      issued.set(endpoint, credential)
      return { ...identity, endpoint, credential }
    },
    // A credential stays valid for its generation: the executor presents the
    // same secret again when it reattaches a lost channel. Revocation, which
    // ends the generation, is what retires it.
    accept(candidate) {
      if (revoked || candidate.projectId !== identity.projectId || candidate.generation !== identity.generation) return false
      const credential = issued.get(candidate.endpoint)
      return credential !== undefined && credentialMatches(credential, candidate.credential)
    },
    revoke() {
      revoked = true
      issued.clear()
    },
  }
}

export interface ProjectExecutorChannelSet<Message = unknown> {
  readonly control: InternalProcessEndpoint<Message, Message>
  readonly output: InternalProcessEndpoint<Message, Message>
  readonly lifecycle: InternalProcessEndpoint<Message, Message>
  readonly state: InternalProcessEndpoint<Message, Message>
  readonly closed: Promise<void>
  close(reason?: string): Promise<void>
}

interface ProjectExecutorEndpoints<Message> {
  readonly control: InternalProcessEndpoint<Message, Message>
  readonly output: InternalProcessEndpoint<Message, Message>
  readonly lifecycle: InternalProcessEndpoint<Message, Message>
  readonly state: InternalProcessEndpoint<Message, Message>
}

/** Groups four independent transports under one generation lifetime. Loss of any transport closes the generation. */
export function createProjectExecutorChannelSet<Message = unknown>(
  endpoints: ProjectExecutorEndpoints<Message>,
): ProjectExecutorChannelSet<Message> {
  const closed = Promise.withResolvers<void>()
  let closing = false
  const close = async (reason = "project executor channel closed"): Promise<void> => {
    if (closing) return closed.promise
    closing = true
    for (const kind of ENDPOINT_KINDS) endpoints[kind].close(reason)
    await Promise.all(ENDPOINT_KINDS.map((kind) => endpoints[kind].closed))
    closed.resolve()
  }
  for (const kind of ENDPOINT_KINDS) endpoints[kind].onClose((reason) => { void close(reason.message) })
  return { ...endpoints, closed: closed.promise, close }
}

/** Strictly decodes the authentication preface before an endpoint handler is installed. */
export function decodeProjectExecutorCredential(value: unknown): ProjectExecutorCredential | undefined {
  if (!isRecord(value) || !exactKeys(value, ["projectId", "generation", "endpoint", "credential"])) return undefined
  if (typeof value.projectId !== "string" || value.projectId.length === 0 || !positiveInteger(value.generation)) return undefined
  if (!isEndpointKind(value.endpoint) || typeof value.credential !== "string" || value.credential.length < 32) return undefined
  return { projectId: value.projectId, generation: value.generation, endpoint: value.endpoint, credential: credentialFromString(value.credential) }
}

/** Converts a runtime credential into the plaintext socket authentication DTO. */
export function encodeProjectExecutorCredential(value: ProjectExecutorCredential): Omit<ProjectExecutorCredential, "credential"> & { readonly credential: string } {
  return { ...value, credential: credentialString(value.credential) }
}

function isEndpointKind(value: unknown): value is ProjectExecutorEndpointKind {
  return value === "control" || value === "output" || value === "lifecycle" || value === "state"
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function credentialString(credential: ProjectExecutorCredential["credential"]): string {
  return Buffer.from(Redacted.value(credential)).toString("base64url")
}

function credentialFromString(credential: string): ProjectExecutorCredential["credential"] {
  return Redacted.make<Uint8Array>(Buffer.from(credential, "base64url"))
}

function credentialMatches(expected: ProjectExecutorCredential["credential"], offered: ProjectExecutorCredential["credential"]): boolean {
  const expectedBytes = Redacted.value(expected)
  const offeredBytes = Redacted.value(offered)
  return expectedBytes.length === offeredBytes.length && timingSafeEqual(expectedBytes, offeredBytes)
}
