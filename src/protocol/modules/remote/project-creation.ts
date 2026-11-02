import { Deferred, Effect, Schema } from "effect"
import { Socket } from "effect/unstable/socket"

import { attachDeviceChannel, type DeviceIdentity } from "./relay-channel.js"
import { decodeJsonFrame, fromBase64Url, type Placement } from "./relay-protocol.js"
import { sealedSocket } from "./sealed-socket.js"

/** Creating a project on a paired machine from a repository (PI-REMOTE-009).
 *
 *  A machine's account service announces one placement of its own beside its
 *  projects: the machine placement, whose id is the machine's runtime id. A
 *  device attaches to it like to a project and gets a sealed channel to the
 *  account service itself, which carries one exchange: the device names a
 *  repository, and the machine answers when it has cloned it, then when it has
 *  opened it, or why it could not. The relay sees one more placement and
 *  ciphertext, so the relay contract does not change.
 *
 *  The device never names a path on the machine. It names a repository
 *  (`repository-reference.ts`), and the machine derives the folder from the
 *  repository's name.
 *
 *  Bun-free and DOM-free apart from `WebSocket` and WebCrypto, which every
 *  host has. */

/** The machine placement's id: the machine's runtime id. A project placement
 *  is the digest of a project root, so the two never meet. */
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

/** The device's one request on the machine placement's channel. */
const ProjectCreateRequestSchema = Schema.Struct({ type: Schema.Literal("project.create"), repository: Schema.NonEmptyString })
export type ProjectCreateRequest = typeof ProjectCreateRequestSchema.Type

/** The machine's answers, in order: `project.opening` once the clone is
 *  recorded, `project.created` once the project is open, or `project.failed`
 *  at either step. A project that cloned but did not open stays on the
 *  machine's list as an asleep project. */
const ProjectOpeningSchema = Schema.Struct({ type: Schema.Literal("project.opening"), placementId: Schema.NonEmptyString, projectLabel: Schema.NonEmptyString })
const ProjectCreatedSchema = Schema.Struct({ type: Schema.Literal("project.created"), placementId: Schema.NonEmptyString, projectLabel: Schema.NonEmptyString })
const ProjectFailedSchema = Schema.Struct({ type: Schema.Literal("project.failed"), message: Schema.NonEmptyString })
const ProjectCreationAnswerSchema = Schema.Union([ProjectOpeningSchema, ProjectCreatedSchema, ProjectFailedSchema])
export type ProjectCreationAnswer = typeof ProjectCreationAnswerSchema.Type

const decodeOptions = { onExcessProperty: "error" } as const
export const decodeProjectCreateRequest = Schema.decodeUnknownSync(ProjectCreateRequestSchema, decodeOptions)
const decodeProjectCreationAnswer = Schema.decodeUnknownSync(ProjectCreationAnswerSchema, decodeOptions)

/** A project the machine created: its placement and the name it shows. */
export interface CreatedProject {
  readonly placementId: string
  readonly projectLabel: string
}

export interface ProjectCreationRequest {
  readonly relay: string
  readonly runtimeId: string
  /** The machine's key as pairing recorded it; the channel is sealed to it. */
  readonly runtimePublicKey: string
  readonly device: DeviceIdentity
  readonly repository: string
  /** The machine cloned the repository and is opening the project. */
  readonly onOpening: (project: CreatedProject) => void
}

/** Asks a paired machine to create a project from a repository, and resolves
 *  once the machine has opened it. Rejects with a message a person can act
 *  on: the machine's own reason, or that the channel ended first. */
export async function requestProjectCreation(request: ProjectCreationRequest): Promise<CreatedProject> {
  const channel = await attachDeviceChannel(request.relay, request.runtimeId, machinePlacementId(request.runtimeId), request.device)
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const inner = yield* Socket.fromTransformStream(Effect.succeed(channel.streams))
      const sealed = sealedSocket(inner, { role: "device", publicKey: request.device.publicKey, sign: request.device.sign }, { kind: "paired", publicKey: fromBase64Url(request.runtimePublicKey) })
      const outcome = yield* Deferred.make<CreatedProject, Error>()
      const ended = new Error("The machine stopped answering. If it finished the clone, the project appears in its list.")
      yield* Effect.forkScoped(sealed.socket.run((bytes) => {
        let answer: ProjectCreationAnswer
        try {
          answer = decodeJsonFrame(decodeProjectCreationAnswer, new TextDecoder().decode(bytes))
        } catch {
          Deferred.doneUnsafe(outcome, Effect.fail(new Error("The machine answered in a way this Flywheel cannot read.")))
          return
        }
        switch (answer.type) {
          case "project.opening":
            request.onOpening({ placementId: answer.placementId, projectLabel: answer.projectLabel })
            return
          case "project.created":
            Deferred.doneUnsafe(outcome, Effect.succeed({ placementId: answer.placementId, projectLabel: answer.projectLabel }))
            return
          case "project.failed":
            Deferred.doneUnsafe(outcome, Effect.fail(new Error(answer.message)))
            return
        }
      }).pipe(Effect.ensuring(Effect.sync(() => { Deferred.doneUnsafe(outcome, Effect.fail(ended)) }))), { startImmediately: true })
      const write = yield* sealed.socket.writer
      yield* sealed.established
      const ask: ProjectCreateRequest = { type: "project.create", repository: request.repository }
      yield* write(new TextEncoder().encode(JSON.stringify(ask)))
      return yield* Deferred.await(outcome)
    })).pipe(Effect.mapError((cause) => cause instanceof Error ? cause : new Error(String(cause)))))
  } finally {
    channel.ws.close(1000)
  }
}
