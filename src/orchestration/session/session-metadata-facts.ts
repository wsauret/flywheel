import { Schema } from "effect"
import { defineFact } from "../../infra/event-registry.js"
import { CanonicalDirectorySchema, RoleAssignmentEntryV1Schema, RoleAssignmentsV1Schema, RoleAssignmentEntrySchema, RoleAssignmentsSchema, HistoricalRoleAssignmentSnapshotSchema, ReplayedSessionSchema, SalvagedSessionSchema, SessionSchema, normalizeRoleAssignments, recoverRoleAssignmentSnapshot, type ReplayedSession, type RoleSettingEntry, type RoleSettings, type SalvagedSession, type Session } from "./schemas.js"
import { RoleAssignmentSnapshotSchema, RoleSettingEntrySchema } from "../../infra/role-settings.js"
import { SessionLifecycleStateSchema } from "./types.js"
import { isRecord } from "../../infra/record.js"

const DateTimeStringSchema = Schema.String.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)) || "Expected ISO datetime string"),
)

// Remove after 2027-10-17. Version 5 workflow containers remain readable only
// for registered conversion and already-admitted deletion recovery.
const SessionCreatedV5Schema = defineFact({
  type: "session.created", version: 5, actor: Schema.Literal("flywheel"), payload: ReplayedSessionSchema,
})
const SessionCreatedSchema = defineFact({
  type: "session.created",
  version: 6,
  actor: Schema.Literal("flywheel"),
  payload: SessionSchema,
})

const SessionAuthProfileSelectedSchema = defineFact({
  type: "session.auth.profile.selected",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ authProfileId: Schema.NonEmptyString }),
})

const SessionLabelUpdatedSchema = defineFact({
  type: "session.label.updated",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    label: Schema.String,
    shortLabel: Schema.String,
    name: Schema.String,
    lastUpdated: DateTimeStringSchema,
    /** Present only on user renames; marks the session user-named. */
    userNamed: Schema.optionalKey(Schema.Literal(true)),
  }),
})

const SessionLifecycleChangedSchema = defineFact({
  type: "session.lifecycle.changed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    lifecycleState: SessionLifecycleStateSchema,
    activatedAt: Schema.optionalKey(DateTimeStringSchema),
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionChatMetadataUpdatedSchema = defineFact({
  type: "session.chat_metadata.updated",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    providerConversationId: Schema.optionalKey(Schema.String),
    seedContext: Schema.optionalKey(Schema.String),
    lastUpdated: DateTimeStringSchema,
  }),
})

// Registered only to decode and reduce historical repair facts. Current code
// does not write new execution-directory updates.
const SessionExecutionCwdUpdatedSchema = defineFact({
  type: "session.execution_cwd.updated",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    executionCwd: CanonicalDirectorySchema,
    lastUpdated: DateTimeStringSchema,
  }),
})

// Version 1 role facts always carried a materialized provider; version 2 made
// it optional. Access-provider routing is now automatic, so no version writes
// a provider anymore; both stay registered so existing facts keep decoding.
const SessionRolesSnapshottedV1Schema = defineFact({
  type: "session.roles.snapshotted",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    roles: RoleAssignmentsV1Schema,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionRolesSnapshottedV2Schema = defineFact({
  type: "session.roles.snapshotted",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    roles: RoleAssignmentsSchema,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionRolesSnapshottedV3Schema = defineFact({
  type: "session.roles.snapshotted",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    roles: HistoricalRoleAssignmentSnapshotSchema,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionRolesSnapshottedSchema = defineFact({
  type: "session.roles.snapshotted",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ roles: RoleAssignmentSnapshotSchema, lastUpdated: DateTimeStringSchema }),
})

const SessionRolesUpdatedV1Schema = defineFact({
  type: "session.roles.updated",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    roleId: Schema.NonEmptyString,
    assignment: RoleAssignmentEntryV1Schema,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionRolesUpdatedV2Schema = defineFact({
  type: "session.roles.updated",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    roleId: Schema.NonEmptyString,
    assignment: RoleAssignmentEntrySchema,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionRolesUpdatedV3Schema = defineFact({
  type: "session.roles.updated",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    roleId: Schema.NonEmptyString,
    assignment: RoleAssignmentEntrySchema,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionRolesUpdatedSchema = defineFact({
  type: "session.roles.updated",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ roleId: Schema.NonEmptyString, assignment: RoleSettingEntrySchema, lastUpdated: DateTimeStringSchema }),
})

const SessionRolesRemovedSchema = defineFact({
  type: "session.roles.removed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    roleId: Schema.NonEmptyString,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionChildLinkedSchema = defineFact({
  type: "session.child.linked",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childSessionId: Schema.NonEmptyString,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionChildUnlinkedSchema = defineFact({
  type: "session.child.unlinked",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childSessionId: Schema.NonEmptyString,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionOwnershipAdoptedSchema = defineFact({
  type: "session.ownership.adopted",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    parentSessionId: Schema.NonEmptyString,
    parentConversationId: Schema.NonEmptyString,
    toolUseId: Schema.NonEmptyString,
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionDeletedSchema = defineFact({
  type: "session.deleted",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    lastUpdated: DateTimeStringSchema,
  }),
})

const SessionRepresentationRetiredSchema = defineFact({
  type: "session.representation.retired", version: 1, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    migrationId: Schema.NonEmptyString, aggregateId: Schema.NonEmptyString,
    recovery: Schema.Array(Schema.Struct({ kind: Schema.Literal("unreadable-control"), position: Schema.Int })),
  }),
})

export const SessionMetadataFactSchemas = [
  SessionCreatedV5Schema,
  SessionCreatedSchema,
  SessionAuthProfileSelectedSchema,
  SessionLabelUpdatedSchema,
  SessionLifecycleChangedSchema,
  SessionChatMetadataUpdatedSchema,
  SessionExecutionCwdUpdatedSchema,
  SessionRolesSnapshottedV1Schema,
  SessionRolesSnapshottedV2Schema,
  SessionRolesSnapshottedV3Schema,
  SessionRolesSnapshottedSchema,
  SessionRolesUpdatedV1Schema,
  SessionRolesUpdatedV2Schema,
  SessionRolesUpdatedV3Schema,
  SessionRolesUpdatedSchema,
  SessionRolesRemovedSchema,
  SessionChildLinkedSchema,
  SessionChildUnlinkedSchema,
  SessionOwnershipAdoptedSchema,
  SessionDeletedSchema,
  SessionRepresentationRetiredSchema,
] as const

const SessionMetadataFactSchema = Schema.Union(SessionMetadataFactSchemas)

export type SessionMetadataFact = typeof SessionMetadataFactSchema.Type

export function parseSessionMetadataFact(value: unknown): SessionMetadataFact {
  return Schema.decodeUnknownSync(SessionMetadataFactSchema, { onExcessProperty: "error" })(value)
}

/** Recover only the original v3 workflow creation request. publishWorkflow
 * writes the exact description to label; later label facts have no task authority. */
export function recoverWorkflowCreationRequest(value: unknown): string | null {
  try {
    const fact = parseSessionMetadataFact(value)
    return fact.type === "session.created" && fact.payload.kind === "workflow" ? fact.payload.label : null
  } catch {
    if (!isRecord(value) || value.type !== "session.created" || value.version !== 3 || value.actor !== "flywheel" || !isRecord(value.payload)) return null
    return value.payload.kind === "workflow" && value.payload.command === "workflow" && typeof value.payload.workflowDefinitionId === "string" && typeof value.payload.label === "string"
      ? value.payload.label : null
  }
}

/** What the catalog reducer consumes: every current fact as written, and a
 *  creation fact whose payload is the replayed shape, which carries
 *  `executionCwd` only when the row recorded one. */
export type ReplayedSessionMetadataFact =
  | Exclude<SessionMetadataFact, { type: "session.created" }>
  | { readonly type: "session.created"; readonly version: 1 | 2 | 3 | 4 | 5 | 6; readonly actor: "flywheel"; readonly payload: ReplayedSession }

// The one reviewed recovery rule for creation rows (ARCH-SUBSTRATE-012): a row that the
// current schema refuses is read against the salvage shape, whatever its
// version, so a session the previous reader could list stays listed instead
// of becoming a retirement candidate. Nothing else is tolerated: any other
// fact decodes against its own registered version or is reported.
// A reader rule, not a registered fact: `defineFact` publishes writer
// contracts, and no writer produces this shape.
const SessionCreatedSalvageSchema = Schema.Struct({
  type: Schema.Literal("session.created"),
  version: Schema.Literals([1, 2, 3, 4]),
  actor: Schema.Literal("flywheel"),
  payload: SalvagedSessionSchema,
})
const decodeCurrent = Schema.decodeUnknownSync(SessionMetadataFactSchema)
const decodeSalvage = Schema.decodeUnknownSync(SessionCreatedSalvageSchema)

/** Decodes one stored metadata row for the catalog. Current facts decode
 *  against their registered version with retired excess fields ignored; auth
 *  profile and ownership-adoption facts have no retired shape and stay strict. A
 *  creation row the current schema refuses takes the salvage rule above with
 *  `timestamp`, the stored row's time, standing in for a missing update time.
 *  Returns undefined for a row no rule reads, and the reducer reports it. */
export function decodeSessionMetadataFactForReplay(value: unknown, timestamp = 0): ReplayedSessionMetadataFact | undefined {
  if (
    isRecord(value)
    && (value.type === "session.auth.profile.selected" || value.type === "session.ownership.adopted")
  ) {
    try { return parseSessionMetadataFact(value) } catch { return undefined }
  }
  try {
    return decodeCurrent(value)
  } catch {
    // Current first, salvage second, in two calls rather than one union: a
    // salvage member that ignores the fields it does not declare would also
    // match a healthy current row, and the union would not promise which wins.
    try {
      const fact = decodeSalvage(value)
      return { type: "session.created", version: fact.version, actor: "flywheel", payload: salvagedCreation(fact.payload, timestamp) }
    } catch {
      return undefined
    }
  }
}

const isCanonicalDirectory = Schema.is(CanonicalDirectorySchema)

function salvagedCreation(payload: SalvagedSession, timestamp: number): ReplayedSession {
  const { executionCwd, roleAssignments, ...rest } = payload
  const launchedFrom = rest.launchedFrom && "toolCallId" in rest.launchedFrom // stored spelling before session.created v4
    ? canonicalLaunchedFrom(rest.launchedFrom)
    : rest.launchedFrom
  return Schema.decodeUnknownSync(ReplayedSessionSchema)({
    ...rest,
    ...(roleAssignments === undefined ? {} : { roleAssignments: recoverRoleAssignmentSnapshot(roleAssignments) }),
    // A recorded directory survives salvage so the resolver can select it
    // (ARCH-DIRECTORIES-007); a non-canonical one is omitted and the resolver selects the
    // project root, as the v3 reader did for a row its schema refused.
    ...(executionCwd !== undefined && isCanonicalDirectory(executionCwd) ? { executionCwd } : {}),
    ...(launchedFrom ? { launchedFrom } : {}),
    label: payload.label ?? "",
    lastUpdated: payload.lastUpdated ?? new Date(timestamp).toISOString(),
    lifecycleState: payload.lifecycleState ?? "inactive",
  })
}

function canonicalLaunchedFrom(launchedFrom: NonNullable<SalvagedSession["launchedFrom"]>) {
  if (!("toolCallId" in launchedFrom)) return launchedFrom // stored spelling before session.created v4
  const { toolCallId: toolUseId, ...canonical } = launchedFrom
  return { ...canonical, ...(toolUseId ? { toolUseId } : {}) }
}

type MetadataFact<T extends SessionMetadataFact["type"]> = Extract<SessionMetadataFact, { type: T }>

export function buildSessionCreatedFact(session: Session): MetadataFact<"session.created"> {
  return { type: "session.created", version: 6, actor: "flywheel", payload: session }
}

export function buildSessionAuthProfileSelectedFact(authProfileId: string): MetadataFact<"session.auth.profile.selected"> {
  return { type: "session.auth.profile.selected", version: 1, actor: "flywheel", payload: { authProfileId } }
}

export function buildSessionRolesSnapshottedFact(
  roles: RoleSettings,
  lastUpdated: string,
  overrides: RoleSettings = {},
): typeof SessionRolesSnapshottedSchema.Type {
  return { type: "session.roles.snapshotted", version: 4, actor: "flywheel", payload: { roles: { defaults: roles, overrides: normalizeRoleAssignments(overrides) }, lastUpdated } }
}

export function buildSessionRolesUpdatedFact(
  roleId: string,
  assignment: RoleSettingEntry,
  lastUpdated: string,
): typeof SessionRolesUpdatedSchema.Type {
  return { type: "session.roles.updated", version: 4, actor: "flywheel", payload: { roleId, assignment: normalizeRoleAssignments({ [roleId]: assignment })[roleId] ?? {}, lastUpdated } }
}

export function buildSessionChildLinkedFact(
  childSessionId: string,
  lastUpdated: string,
): MetadataFact<"session.child.linked"> {
  return { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId, lastUpdated } }
}

export function buildSessionChildUnlinkedFact(
  childSessionId: string,
  lastUpdated: string,
): MetadataFact<"session.child.unlinked"> {
  return { type: "session.child.unlinked", version: 1, actor: "flywheel", payload: { childSessionId, lastUpdated } }
}

export function buildSessionOwnershipAdoptedFact(
  parentSessionId: string,
  parentConversationId: string,
  toolUseId: string,
  lastUpdated: string,
): MetadataFact<"session.ownership.adopted"> {
  return {
    type: "session.ownership.adopted",
    version: 1,
    actor: "flywheel",
    payload: { parentSessionId, parentConversationId, toolUseId, lastUpdated },
  }
}
