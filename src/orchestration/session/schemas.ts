import { Schema } from "effect";
import { isAbsolute, resolve } from "node:path";
import { ProviderRequestOptionsSchema } from "../../infra/llm/provider-options.js";
import { canonicalModelId } from "../../infra/llm/model-id.js";
import { canonicalRoleId } from "../config/retired-config-names.js";
import { parseBriefRoleId } from "../../protocol/brief-role-id.js";
import { SessionLifecycleStateSchema } from "./types.js";
import { RoleAssignmentSnapshotSchema, RoleSettingEntrySchema, RoleSettingsSchema } from "../../infra/role-settings.js";
import { WorkflowMembershipSchema } from "../../infra/session-workflow-membership.js";

const NonEmptyString = Schema.NonEmptyString;

const LaunchedFromSchema = Schema.Struct({
  parentSessionId: NonEmptyString,
  conversationId: Schema.optionalKey(NonEmptyString),
  workflowDefinitionId: Schema.optionalKey(NonEmptyString),
  toolUseId: Schema.optionalKey(NonEmptyString),
  description: Schema.optionalKey(Schema.String),
});
const SubagentLaunchedFromSchema = Schema.Struct({
  parentSessionId: NonEmptyString,
  conversationId: Schema.optionalKey(NonEmptyString),
  workflowDefinitionId: Schema.optionalKey(NonEmptyString),
  toolUseId: NonEmptyString,
  description: Schema.optionalKey(Schema.String),
});
// Remove after 2027-09-20, when session.created v3 is outside the durable compatibility window.
const SessionCreatedV3LaunchedFromSchema = Schema.Struct({
  parentSessionId: NonEmptyString,
  conversationId: Schema.optionalKey(NonEmptyString),
  workflowDefinitionId: Schema.optionalKey(NonEmptyString),
  toolCallId: Schema.optionalKey(NonEmptyString), // stored spelling before session.created v4
  description: Schema.optionalKey(Schema.String),
});
const SessionCreatedV3SubagentLaunchedFromSchema = Schema.Struct({
  ...SessionCreatedV3LaunchedFromSchema.fields,
  toolCallId: NonEmptyString, // stored spelling before session.created v4
});
// Optional launch identifiers cannot distinguish union members. Retain both
// stored spellings until the recovery fold normalizes the historical one.
const SalvagedLaunchedFromSchema = Schema.Struct({
  ...LaunchedFromSchema.fields,
  toolCallId: SessionCreatedV3LaunchedFromSchema.fields.toolCallId,
});

const roleAssignmentFields = {
  model: NonEmptyString,
  effort: NonEmptyString,
  providerOptions: Schema.optionalKey(ProviderRequestOptionsSchema),
};

/** A role's model selection. Access-provider routing is automatic; nothing
 *  reads `provider` and nothing writes it. The field stays decode-only so
 *  version-2 facts written by the retired pinning feature keep decoding under
 *  onExcessProperty: "error". */
export const RoleAssignmentEntrySchema = Schema.Struct({
  ...roleAssignmentFields,
  provider: Schema.optionalKey(NonEmptyString),
});

/** Role entry as version-1 role facts wrote it, when every snapshot
 *  materialized a provider. Decode-only, like the version-2 field above. */
export const RoleAssignmentEntryV1Schema = Schema.Struct({
  ...roleAssignmentFields,
  provider: NonEmptyString,
});

export type RoleAssignmentEntry = typeof RoleAssignmentEntrySchema.Type;

export const RoleAssignmentsSchema = Schema.Record(NonEmptyString, RoleAssignmentEntrySchema);

export const RoleAssignmentsV1Schema = Schema.Record(NonEmptyString, RoleAssignmentEntryV1Schema);

export type RoleAssignments = typeof RoleAssignmentsSchema.Type;

// Remove after 2027-10-16, when generated session snapshots leave the compatibility window.
export const HistoricalRoleAssignmentSnapshotSchema = Schema.Struct({
  defaults: RoleAssignmentsSchema,
  overrides: RoleAssignmentsSchema,
});

export type RoleSettingEntry = typeof RoleSettingEntrySchema.Type;
export type RoleSettings = typeof RoleSettingsSchema.Type;

export type RoleAssignmentSnapshot = typeof RoleAssignmentSnapshotSchema.Type;

/** One role assignment table in canonical form: each model id canonical,
 *  and each role id current (refer to `canonicalRoleId`), so a snapshot
 *  that a run stored under a retired seat name reads as its current seat.
 *  A table that holds both spellings of one seat keeps the current one. */
export function normalizeRoleAssignments(roles: RoleSettings): RoleSettings {
  const normalized: { [roleId: string]: RoleSettings[string] } = {};
  for (const [roleId, assignment] of Object.entries(roles)) {
    const current = canonicalRoleId(roleId);
    if (current !== roleId && Object.hasOwn(roles, current)) continue;
    normalized[current] = {
      ...(assignment.model === undefined ? {} : { model: canonicalModelId(assignment.model) }),
      ...(assignment.effort === undefined ? {} : { effort: assignment.effort }),
      ...(assignment.providerOptions === undefined ? {} : { providerOptions: assignment.providerOptions }),
    };
  }
  return normalized;
}

// Remove after 2027-10-16. Flat maps cannot distinguish old generated defaults from user choices.
export function recoverRoleAssignmentSnapshot(
  snapshot: typeof HistoricalRoleAssignmentSnapshotSchema.Type | RoleAssignments,
): RoleAssignmentSnapshot {
  if (!Schema.is(HistoricalRoleAssignmentSnapshotSchema)(snapshot)) {
    return { defaults: {}, overrides: normalizeRoleAssignments(Schema.decodeUnknownSync(RoleAssignmentsSchema)(snapshot)) };
  }
  const historical = Schema.decodeUnknownSync(HistoricalRoleAssignmentSnapshotSchema)(snapshot);
  const defaults: { [roleId: string]: RoleSettingEntry } = {};
  for (const [roleId, entry] of Object.entries(normalizeRoleAssignments(historical.defaults))) {
    const selector = parseBriefRoleId(roleId);
    if (selector?.definitionId === undefined) continue;
    defaults[roleId] = {
      ...(selector.fixed === "effort" ? {} : { model: entry.model, ...(entry.providerOptions ? { providerOptions: entry.providerOptions } : {}) }),
      ...(selector.fixed === "model" ? {} : { effort: entry.effort }),
    };
  }
  return { defaults, overrides: normalizeRoleAssignments(historical.overrides) };
}
export function normalizeRoleAssignmentSnapshot(snapshot: RoleAssignmentSnapshot): RoleAssignmentSnapshot {
  return {
    defaults: snapshot.defaults,
    overrides: normalizeRoleAssignments(snapshot.overrides),
  };
}


/** A directory authority as this project's startup boundary canonicalized it
 *  (ARCH-DIRECTORIES-003): absolute, and equal to its own resolution, so no reader has to
 *  normalize it or resolve it against a process directory again. */
export const CanonicalDirectorySchema = NonEmptyString.check(
  Schema.makeFilter((value) => (isAbsolute(value) && resolve(value) === value) || "Expected a canonical absolute directory path"),
);

const baseFields = {
  label: Schema.String,
  shortLabel: Schema.optionalKey(Schema.String),
  lastUpdated: Schema.String,
  authProfileId: Schema.optionalKey(NonEmptyString),
  lifecycleState: SessionLifecycleStateSchema,
  /** Directory this session's tools execute in. Session metadata is the only
   *  execution-directory authority: a reader takes this value as written and
   *  never falls back to the directory its own process started in. */
  executionCwd: CanonicalDirectorySchema,
  /** User- or generator-provided session name; absent means unnamed. */
  name: Schema.optionalKey(Schema.String),
  /** Set by an explicit user rename; generated titles never overwrite it. */
  userNamed: Schema.optionalKey(Schema.Literal(true)),
  createdAt: Schema.optionalKey(Schema.String),
  activatedAt: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  childSessionIds: Schema.mutableKey(Schema.optionalKey(Schema.mutable(Schema.Array(NonEmptyString)))),
  launchedFrom: Schema.optionalKey(LaunchedFromSchema),
  roleAssignments: Schema.optionalKey(RoleAssignmentSnapshotSchema),
};

const workflowFields = {
  kind: Schema.Literal("workflow"),
  command: Schema.Literal("workflow"),
  /** Definition id the session launched. Resume compiles this id; the
   *  launch request prose lives in name/label. */
  workflowDefinitionId: Schema.String,
};

const conversationFields = {
  /** Stable Flywheel key for this conversation-backed session's durable tree
   *  (`conversation:<conversationId>`). Minted at session creation. */
  conversationId: NonEmptyString,
  /** Provider-side continuation/cache token (OpenAI thread, Anthropic
   *  conversation). Adapter metadata only; never the tree key. */
  providerConversationId: Schema.optionalKey(Schema.String),
  seedContext: Schema.optionalKey(Schema.String),
};

const chatFields = {
  ...conversationFields,
  kind: Schema.Literal("chat"),
  command: Schema.Literal("chat"),
};

const subagentFields = {
  ...conversationFields,
  kind: Schema.Literal("subagent"),
  command: Schema.Literal("subagent"),
  launchedFrom: SubagentLaunchedFromSchema,
};

const WorkflowSessionSchema = Schema.Struct({ ...baseFields, ...workflowFields });

const ChatSessionSchema = Schema.Struct({ ...baseFields, ...chatFields });

const SubagentSessionSchema = Schema.Struct({ ...baseFields, ...subagentFields });
const { executionCwd: _memberDirectory, ...memberBaseFields } = baseFields;
const WorkflowAgentSessionSchema = Schema.Struct({
  ...memberBaseFields,
  ...conversationFields,
  kind: Schema.Literal("workflow-agent"),
  command: Schema.Literal("workflow-agent"),
  launchedFrom: SubagentLaunchedFromSchema,
  workflowMembership: WorkflowMembershipSchema,
  importedResources: Schema.optionalKey(Schema.Struct({
    workflowId: NonEmptyString,
    conversationId: NonEmptyString,
  })),
});

/** The creation payload the metadata salvage rule accepts (ARCH-SUBSTRATE-012): rows
 *  written before the execution-directory authority carried no
 *  `executionCwd`, and the earliest could omit the label, the update time, or
 *  the lifecycle state. Salvage supplies each missing value from the stored row
 *  and never invents an execution directory; the path-sensitive resolver
 *  selects one at use. A recorded `executionCwd` (every v3 row) is read as any
 *  string so that a bad value never makes the whole row unreadable; the salvage
 *  fold keeps it only when it is canonical (ARCH-DIRECTORIES-007). */
const { executionCwd: _executionCwd, label: _label, lastUpdated: _lastUpdated, lifecycleState: _lifecycleState, ...salvagedBaseFields } = baseFields;
const salvagedFields = {
  ...salvagedBaseFields,
  roleAssignments: Schema.optionalKey(Schema.Union([HistoricalRoleAssignmentSnapshotSchema, RoleAssignmentsSchema])),
  executionCwd: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  lastUpdated: Schema.optionalKey(Schema.String),
  lifecycleState: Schema.optionalKey(SessionLifecycleStateSchema),
};
export const SalvagedSessionSchema = Schema.Union([
  Schema.Struct({ ...salvagedFields, ...workflowFields, launchedFrom: Schema.optionalKey(SalvagedLaunchedFromSchema) }),
  Schema.Struct({ ...salvagedFields, ...chatFields, launchedFrom: Schema.optionalKey(SalvagedLaunchedFromSchema) }),
  Schema.Struct({ ...salvagedFields, ...subagentFields }),
  Schema.Struct({ ...salvagedFields, ...subagentFields, launchedFrom: SessionCreatedV3SubagentLaunchedFromSchema }),
]);
export type SalvagedSession = typeof SalvagedSessionSchema.Type;

export const SessionSchema = Schema.Union([
  WorkflowAgentSessionSchema,
  ChatSessionSchema,
  SubagentSessionSchema,
]);

export type Session = typeof SessionSchema.Type;

export const ReplayedSessionSchema = Schema.Union([
  Schema.Struct({ ...WorkflowAgentSessionSchema.fields, executionCwd: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    ...WorkflowSessionSchema.fields,
    executionCwd: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...ChatSessionSchema.fields,
    executionCwd: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...SubagentSessionSchema.fields,
    executionCwd: Schema.optionalKey(Schema.String),
  }),
]);

type ReplayedSessionVariant<S> = S extends { readonly kind: string } ? Omit<S, "executionCwd"> & { readonly executionCwd?: string } : never
// Remove the historical workflow arm after 2027-10-17. Conversion and admitted
// deletion recovery must read the previous representation before they replace it.
export type ReplayedSession = ReplayedSessionVariant<Session | typeof WorkflowSessionSchema.Type>

/** The name a session shows to the person, which other sessions read too. */
export function sessionDisplayName({ id, session }: { readonly id: string; readonly session: Pick<ReplayedSession, "label" | "name"> }): string {
  return session.label || session.name || id
}
