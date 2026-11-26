import { Deferred, Effect, Schema, Stream } from "effect"
import { Socket } from "effect/socket"

import { attachDeviceChannel, type DeviceIdentity } from "./relay-channel.js"
import { decodeJsonFrame, fromBase64Url, type Placement } from "./relay-protocol.js"
import { sealedSocket } from "./sealed-socket.js"

/** Creating a project on a paired machine from a repository (PI-REMOTE-021).
 *
 *  A machine's account service announces one placement of its own beside its
 *  projects: the machine placement, whose id is the machine's runtime id. A
 *  device attaches to it like to a project and gets a sealed channel to the
 *  account service itself, which carries one exchange: the device names a
 *  repository, and the machine answers when it has cloned it, then when it has
 *  opened it, or why it could not. The relay sees one more placement and
 *  ciphertext, so the relay contract does not change. The same channel also
 *  answers which project an earlier placement id names
 *  (`resolveLegacyPlacement`).
 *
 *  The device never names a path on the machine. It names a repository
 *  (`repository-reference.ts`), and the machine derives the folder from the
 *  repository's name.
 *
 *  Bun-free and DOM-free apart from `WebSocket` and WebCrypto, which every
 *  host has. */

/** The machine placement's id: the machine's runtime id. A project placement
 *  is a keyed digest of a project root, so the two never meet. */
export function machinePlacementId(runtimeId: string): string {
  return runtimeId
}

export function isMachinePlacement(runtimeId: string, placement: Pick<Placement, "id">): boolean {
  return placement.id === machinePlacementId(runtimeId)
}

/** What the machine placement of v0.1.1 and v0.1.2 names itself in presence,
 *  in place of the machine's name. A device keeps the label it paired with
 *  when it sees this one. Remove once the relay protocol version moves past
 *  5, because no runtime that sends it can attach then. */
export const LEGACY_MACHINE_PLACEMENT_LABEL = "New project from repository"

const ProjectCreateRequestSchema = Schema.Struct({ type: Schema.Literal("project.create"), repository: Schema.NonEmptyString })
/** Asks which project a placement id that releases before 2026-11-25 gave
 *  out names. Those releases announced the unkeyed SHA-256 of the project
 *  root, and a device that selected a project then still holds that id.
 *  Remove after 2027-05-25, with `resolveLegacyPlacement`. */
const PlacementResolveRequestSchema = Schema.Struct({ type: Schema.Literal("placement.resolve"), placementId: Schema.NonEmptyString })
/** The device's one request on the machine placement's channel. */
const MachineRequestSchema = Schema.Union([ProjectCreateRequestSchema, PlacementResolveRequestSchema])
export type MachineRequest = typeof MachineRequestSchema.Type

/** The machine's answers, in order: `project.opening` once the clone is
 *  recorded, `project.created` once the project is open, or `project.failed`
 *  at either step. A project that cloned but did not open stays on the
 *  machine's list as an asleep project. */
const ProjectOpeningSchema = Schema.Struct({ type: Schema.Literal("project.opening"), placementId: Schema.NonEmptyString, projectLabel: Schema.NonEmptyString })
const ProjectCreatedSchema = Schema.Struct({ type: Schema.Literal("project.created"), placementId: Schema.NonEmptyString, projectLabel: Schema.NonEmptyString })
const ProjectFailedSchema = Schema.Struct({ type: Schema.Literal("project.failed"), message: Schema.NonEmptyString })
const ProjectCreationAnswerSchema = Schema.Union([ProjectOpeningSchema, ProjectCreatedSchema, ProjectFailedSchema])
/** The machine's answer to `placement.resolve`: the project's current
 *  placement id, or none when no recorded project has the earlier one. */
const PlacementResolvedSchema = Schema.Struct({ type: Schema.Literal("placement.resolved"), placementId: Schema.optionalKey(Schema.NonEmptyString) })
export type MachineAnswer = typeof ProjectCreationAnswerSchema.Type | typeof PlacementResolvedSchema.Type

const decodeOptions = { onExcessProperty: "error" } as const
export const decodeMachineRequest = Schema.decodeUnknownSync(MachineRequestSchema, decodeOptions)
const decodeProjectCreationAnswer = Schema.decodeUnknownSync(ProjectCreationAnswerSchema, decodeOptions)
const decodePlacementResolved = Schema.decodeUnknownSync(PlacementResolvedSchema, decodeOptions)

/** A project the machine created: its placement and the name it shows. */
export interface CreatedProject {
  readonly placementId: string
  readonly projectLabel: string
}

/** A paired machine's machine placement, as this device reaches it. */
interface MachineChannelAddress {
  readonly relay: string
  readonly runtimeId: string
  /** The machine's key as pairing recorded it; the channel is sealed to it. */
  readonly runtimePublicKey: string
  readonly device: DeviceIdentity
}

export interface ProjectCreationRequest extends MachineChannelAddress {
  readonly repository: string
  /** The machine cloned the repository and is opening the project. */
  readonly onOpening: (project: CreatedProject) => void
}

/** Asks a paired machine to create a project from a repository, and resolves
 *  once the machine has opened it. Rejects with a message a person can act
 *  on: the machine's own reason, or that the channel ended first. */
export async function requestProjectCreation(request: ProjectCreationRequest): Promise<CreatedProject> {
  return await machineExchange<CreatedProject>(request, { type: "project.create", repository: request.repository }, "The machine stopped answering. If it finished the clone, the project appears in its list.", (text, settle) => {
    const answer = decodeJsonFrame(decodeProjectCreationAnswer, text)
    switch (answer.type) {
      case "project.opening":
        request.onOpening({ placementId: answer.placementId, projectLabel: answer.projectLabel })
        return
      case "project.created":
        settle(Effect.succeed({ placementId: answer.placementId, projectLabel: answer.projectLabel }))
        return
      case "project.failed":
        settle(Effect.fail(new Error(answer.message)))
        return
    }
  })
}

/** Asks a paired machine which project `placementId`, an id of a release
 *  before 2026-11-25, names, and resolves to that project's current id, or
 *  to undefined when the machine records no such project. The question
 *  travels sealed, so the relay never sees the earlier id again. Remove
 *  after 2027-05-25, with `placement.resolve`. */
export async function resolveLegacyPlacement(address: MachineChannelAddress, placementId: string): Promise<string | undefined> {
  return await machineExchange<string | undefined>(address, { type: "placement.resolve", placementId }, "The machine stopped answering.", (text, settle) => {
    settle(Effect.succeed(decodeJsonFrame(decodePlacementResolved, text).placementId))
  })
}

/** One request on the machine placement's sealed channel. `read` takes each
 *  answer's text and settles the outcome; an answer it cannot decode fails
 *  the exchange, and a channel that ends first fails it with `ended`. */
async function machineExchange<A>(address: MachineChannelAddress, ask: MachineRequest, ended: string, read: (text: string, settle: (outcome: Effect.Effect<A, Error>) => void) => void): Promise<A> {
  const channel = await attachDeviceChannel(address.relay, address.runtimeId, machinePlacementId(address.runtimeId), address.device)
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const inner = yield* Socket.fromTransformStream(Effect.succeed(channel.streams))
      const sealed = sealedSocket(inner, { role: "device", publicKey: address.device.publicKey, sign: address.device.sign }, { kind: "paired", publicKey: fromBase64Url(address.runtimePublicKey) })
      const outcome = yield* Deferred.make<A, Error>()
      const settle = (result: Effect.Effect<A, Error>) => { Deferred.doneUnsafe(outcome, result) }
      yield* Effect.forkScoped(Stream.runForEach(Socket.toStream(sealed.socket), (bytes) => Effect.sync(() => {
        try {
          read(new TextDecoder().decode(bytes), settle)
        } catch {
          settle(Effect.fail(new Error("The machine answered in a way this Flywheel cannot read.")))
        }
      })).pipe(Effect.ensuring(Effect.sync(() => settle(Effect.fail(new Error(ended)))))), { startImmediately: true })
      const { write } = yield* sealed.socket.writer
      yield* sealed.established
      yield* write(new TextEncoder().encode(JSON.stringify(ask)))
      return yield* Deferred.await(outcome)
    })).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause)))))
  } finally {
    channel.ws.close(1000)
  }
}
