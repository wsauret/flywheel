import { Schema } from "effect"
import type { RuntimeAuthStatusScope, RuntimeAuthStatusSnapshotResult } from "./auth-status-protocol-types.js"
import type { RuntimeAuthProfileScope, RuntimeAuthProfileWriteScope } from "./auth-profile-selection-protocol-types.js"
import { SubscriptionUsageSpendSourceSchema } from "../infra/llm/subscription-usage.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "./subscription-spend-consent-protocol-types.js"

const RuntimePositionSchema = Schema.Number
// Boundary: the credential vocabulary is no longer a compile-time literal
// union. [custom_providers] config entries install provider ids at runtime,
// and this schema is built at module load, before any config is read. The
// auth store and auth actions validate membership against the live installed
// catalog; the wire accepts any non-empty id.
const CredentialProviderIdSchema = Schema.NonEmptyString

const ProviderCatalogDiscoverySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available"), provenance: Schema.Literals(["first-party", "first-party-cached", "models-dev-live", "models-dev-archive", "models-dev-bundled", "static"]), liveOutcome: Schema.Literals(["valid", "authentication-invalid", "discovery-failed", "empty", "unusable"]) }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.Literals(["authentication-absent", "authentication-invalid", "discovery-pending", "discovery-failed", "empty", "unusable"]), discoveryReason: Schema.optionalKey(Schema.Literals(["timeout", "oversized", "malformed", "transport", "http"])) }),
])
export const AccessProviderCandidateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("singleton"), providerId: CredentialProviderIdSchema, spendMode: Schema.Literals(["direct_api", "aggregator"]) }),
  Schema.Struct({ kind: Schema.Literal("subscription"), providerId: CredentialProviderIdSchema, instanceId: Schema.NonEmptyString, spendMode: Schema.Literals(["included", "prepaid", "automatic", "direct_api"]) }),
])
const AuthProviderAccountStatusSchema = Schema.Struct({
  instanceId: Schema.String,
  accountCorrelationId: Schema.NonEmptyString,
  identity: Schema.String,
  label: Schema.optionalKey(Schema.String),
  enterpriseDomain: Schema.optionalKey(Schema.String),
  displayLabel: Schema.String,
  plan: Schema.optionalKey(Schema.String),
  expired: Schema.Boolean,
  source: Schema.Union([Schema.Literal("stored_key"), Schema.Literal("oauth")]),
  configured: Schema.optionalKey(Schema.Literal(true)),
  catalog: Schema.optionalKey(ProviderCatalogDiscoverySchema),
  servingCandidate: Schema.optionalKey(AccessProviderCandidateSchema),
  freeRoutes: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean, eligibilityRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })),
  attention: Schema.optionalKey(Schema.Struct({ kind: Schema.Literals(["login-rejected", "program-exited", "program-cannot-start", "free-plan"]), message: Schema.String })),
})
const AuthProviderStatusSchema = Schema.Struct({
  // Provider identities cross the wire from the installed provider catalogs.
  providerId: CredentialProviderIdSchema,
  kind: Schema.Union([Schema.Literal("subscription"), Schema.Literal("singleton"), Schema.Literal("connect")]),
  source: Schema.Union([Schema.Literal("stored_key"), Schema.Literal("oauth"), Schema.Literal("invalid"), Schema.Literal("unconfigured"), Schema.Literal("misconfigured")]),
  expired: Schema.Boolean,
  configured: Schema.optionalKey(Schema.Boolean),
  catalog: Schema.optionalKey(ProviderCatalogDiscoverySchema),
  servingCandidate: Schema.optionalKey(AccessProviderCandidateSchema),
  freeRoutes: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean, eligibilityRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })),
  modelCapable: Schema.Boolean,
  loginMethod: Schema.Union([Schema.Literal("api-key"), Schema.Literal("browser-auth"), Schema.Literal("device-code")]),
  loginProgram: Schema.optionalKey(Schema.String),
  statusRank: Schema.Number,
  group: Schema.Union([Schema.Literal("model"), Schema.Literal("web")]),
  displayName: Schema.String,
  accounts: Schema.Array(AuthProviderAccountStatusSchema),
  detail: Schema.optionalKey(Schema.String),
  keyHint: Schema.optionalKey(Schema.String),
  keyPrefix: Schema.optionalKey(Schema.String),
  attention: Schema.optionalKey(Schema.Struct({
    kind: Schema.Literal("malformed"),
    message: Schema.String,
  })),
})
const AuthProfileSourceSchema = Schema.Literals(["environment", "project", "sticky", "default"])
export const RuntimeAuthStatusScopeSchema: Schema.Codec<RuntimeAuthStatusScope> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("defaults") }),
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: Schema.String }),
])
const RuntimeAuthProfileScopeSchema: Schema.Codec<RuntimeAuthProfileScope> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("defaults") }),
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: Schema.String }),
])
export const RuntimeAuthProfileWriteScopeSchema: Schema.Codec<RuntimeAuthProfileWriteScope> = Schema.Union([
  RuntimeAuthProfileScopeSchema,
  Schema.Struct({ kind: Schema.Literal("defaults-and-session"), sessionId: Schema.String }),
])
export const RuntimeAuthProfileDefaultScopeSchema = Schema.Struct({ kind: Schema.Literal("defaults") })
const RuntimeAuthProfileDescriptorSchema = Schema.Struct({ id: Schema.String, displayName: Schema.String })
const SubscriptionSpendConsentModeSchema = Schema.Struct({
  mode: Schema.Literals(["prepaid", "automatic"]),
  envelopeId: Schema.NonEmptyString,
  evidence: SubscriptionUsageSpendSourceSchema,
  decision: Schema.Literals(["accepted", "declined", "unreviewed"]),
})
const SubscriptionSpendConsentAccountSchema = Schema.Struct({
  accountCorrelationId: Schema.NonEmptyString,
  providerId: Schema.NonEmptyString,
  providerDisplayName: Schema.NonEmptyString,
  billingUrl: Schema.optionalKey(Schema.NonEmptyString),
  label: Schema.optionalKey(Schema.String),
  plan: Schema.optionalKey(Schema.String),
  tier: Schema.optionalKey(Schema.String),
  providerStatus: Schema.Literals(["ok", "warning", "exhausted", "unknown"]),
  modes: Schema.Array(SubscriptionSpendConsentModeSchema),
})
const SubscriptionSpendDetectionFailureMessageSchema = Schema.Literal(SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE)
export const SubscriptionSpendConsentViewSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available"), profileId: Schema.NonEmptyString, usageGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), authorityIncarnation: Schema.NonEmptyString, authorityRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), accounts: Schema.Array(SubscriptionSpendConsentAccountSchema) }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), profileId: Schema.NonEmptyString, message: SubscriptionSpendDetectionFailureMessageSchema }),
])
const AuthOperationSettlementSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("completed"), operationId: Schema.NonEmptyString, providerId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("failed"), operationId: Schema.NonEmptyString, providerId: Schema.NonEmptyString, message: Schema.NonEmptyString, refused: Schema.optionalKey(Schema.Literal(true)) }),
])
export const RuntimeAuthViewSchema = Schema.Struct({
  loginQuestions: Schema.optionalKey(Schema.Array(Schema.Struct({
    questionId: Schema.NonEmptyString,
    providerId: Schema.NonEmptyString,
    instanceId: Schema.NonEmptyString,
    profileId: Schema.NonEmptyString,
    profileDisplayName: Schema.NonEmptyString,
    providerDisplayName: Schema.NonEmptyString,
    accountDisplayName: Schema.NonEmptyString,
  }))),
  autoEnableNewModels: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean, eligibilityRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })),
  providers: Schema.Array(AuthProviderStatusSchema),
  warnings: Schema.Array(Schema.String),
  authFilePath: Schema.optionalKey(Schema.String),
  fileAttention: Schema.optionalKey(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("malformed"), path: Schema.String, message: Schema.String }),
    Schema.Struct({ kind: Schema.Literals(["oversized", "unsafe_path"]), path: Schema.String, message: Schema.String }),
  ])),
  profile: Schema.Struct({ id: Schema.String, displayName: Schema.String, source: AuthProfileSourceSchema, availableProfiles: Schema.Array(RuntimeAuthProfileDescriptorSchema), projectBinding: Schema.optionalKey(Schema.String) }),
  subscriptionSpendConsent: SubscriptionSpendConsentViewSchema,
  settlement: Schema.optionalKey(AuthOperationSettlementSchema),
  progress: Schema.optionalKey(Schema.Struct({ kind: Schema.Literal("progress"), operationId: Schema.NonEmptyString, providerId: Schema.NonEmptyString, message: Schema.NonEmptyString })),
  confirmation: Schema.optionalKey(Schema.Struct({ kind: Schema.Literal("confirmation"), operationId: Schema.NonEmptyString, providerId: Schema.NonEmptyString, message: Schema.NonEmptyString })),
})
export const RuntimeAuthStatusSnapshotResultSchema: Schema.Codec<RuntimeAuthStatusSnapshotResult> = Schema.Struct({ snapshotPosition: RuntimePositionSchema, auth: RuntimeAuthViewSchema })
