import { Schema, SchemaTransformation } from "effect"
import type { FrontendMutation, MutationResult } from "./app-service-types.js"
import type { RuntimeAuthLoginResult } from "./auth-login-protocol-types.js"
import type { RuntimeAuthProfileMutationResult } from "./auth-profile-selection-protocol-types.js"
import { SubscriptionSpendConsentViewSchema } from "./auth-status-protocol-schemas.js"
import { CommandOutcomeSchema } from "./command-catalog-protocol-schemas.js"
import { RuntimeResetModelAssignmentsResultSchema, RuntimeSaveModelEffortResultSchema } from "./model-assignment-protocol-schemas.js"
import { PROTOCOL_MODULE_MUTATIONS } from "./modules.js"
import { protocolMutationTable } from "./protocol-module.js"
import { ProviderModelViewSchema, RuntimeProviderModelHiddenResultSchema, RuntimeSetProviderAutoEnableNewModelsResultSchema, RuntimeSetProviderModelResultSchema } from "./provider-model-preference-protocol-schemas.js"
import { RuntimeConfigMutationResultSchema } from "./runtime-config-protocol-schemas.js"
import { SessionCatalogRowSchema } from "./session-catalog-protocol-schemas.js"
import { SessionChangesSetViewedResultSchema, SessionChangesUndoResultSchema } from "./session-changes-protocol-types.js"
import type { SubscriptionSpendConsentMutationResult } from "./subscription-spend-consent-protocol-types.js"
import { ClaimComposerReturnsResultSchema } from "./composer-returns.js"

const RuntimeAuthProfileMutationResultSchema: Schema.Codec<RuntimeAuthProfileMutationResult> = Schema.Union([
  Schema.Struct({ id: Schema.String, displayName: Schema.String }),
  Schema.Struct({ id: Schema.String, warning: Schema.optionalKey(Schema.String), mirrored: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ bound: Schema.Literal(false), warning: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
const SubscriptionSpendConsentMutationResultSchema: Schema.Codec<SubscriptionSpendConsentMutationResult> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("committed"), consent: SubscriptionSpendConsentViewSchema }),
  Schema.Struct({ kind: Schema.Literal("stale") }),
  Schema.Struct({ kind: Schema.Literal("contention") }),
  Schema.Struct({ kind: Schema.Literal("invalid-envelope") }),
  Schema.Struct({ kind: Schema.Literal("storage-failure") }),
])
const MutationFailureSchema = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String, kind: Schema.optionalKey(Schema.Literals(["stale", "handing_off"])) })
const MutationResultSchema: Schema.Codec<MutationResult> = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), sessionId: Schema.optionalKey(Schema.String), sessionCatalogRow: Schema.optionalKey(SessionCatalogRowSchema), sessionRemoved: Schema.optionalKey(Schema.Boolean), confirmedSubmissionIds: Schema.optionalKey(Schema.Array(Schema.String)), inTranscript: Schema.optionalKey(Schema.Boolean) }),
  MutationFailureSchema,
])
/** Connecting a provider answers with the next action the client must take. */
const RuntimeAuthLoginResultSchema: Schema.Codec<RuntimeAuthLoginResult> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ignored"), providerId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("completed"), providerId: Schema.String, identity: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("needs_key"), providerId: Schema.String, displayName: Schema.String, hint: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("device_code"), operationId: Schema.NonEmptyString, providerId: Schema.String, userCode: Schema.optionalKey(Schema.String), verificationUri: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("prompt"), operationId: Schema.NonEmptyString, providerId: Schema.String, prompt: Schema.Struct({ message: Schema.String, placeholder: Schema.optionalKey(Schema.String), allowEmpty: Schema.optionalKey(Schema.Boolean) }) }),
  Schema.Struct({ kind: Schema.Literal("browser"), operationId: Schema.NonEmptyString, providerId: Schema.String, authorizeUri: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unsupported"), providerId: Schema.String, detail: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed"), providerId: Schema.String, operationId: Schema.optionalKey(Schema.NonEmptyString), message: Schema.String }),
])
// Opaque RPC successes require a JSON value; void results use null on the wire.
const VoidResultSchema = Schema.Null.pipe(Schema.decodeTo(Schema.Void, SchemaTransformation.transform({ decode: (): void => undefined, encode: () => null })))

/** Both transport ends select the mutation's result codec by request type.
 *  A structural union can accept a richer success as a basic success and
 *  discard its IDs. Every mutation must register its result here. */
const RUNTIME_DISPATCH_RESULT_SCHEMAS = {
  "session.claim_composer_returns": ClaimComposerReturnsResultSchema,
  "session.changes.undo": SessionChangesUndoResultSchema, "session.changes.set_viewed": SessionChangesSetViewedResultSchema,
  "chat.open": MutationResultSchema, "session.send": MutationResultSchema, "chat.compact": MutationResultSchema,
  "chat.interrupt": MutationResultSchema, "chat.resume": MutationResultSchema, "background.terminate": MutationResultSchema, "bash.detach": MutationResultSchema,
  "session.activate": MutationResultSchema, "session.release": MutationResultSchema, "session_detail.release": MutationResultSchema, "background.release": MutationResultSchema, "output.watch": MutationResultSchema,
  "session.fork": MutationResultSchema, "session.close": MutationResultSchema, "session.delete": MutationResultSchema, "session.discard_transient": MutationResultSchema,
  "session.reorder": MutationResultSchema, "session.dismiss_notice": MutationResultSchema, "session.rename": MutationResultSchema,
  "question.answer": MutationResultSchema, "question.cancel": MutationResultSchema,
  "auth.refresh": MutationResultSchema, "auth.catalog.refresh": MutationResultSchema,
  "auth.login": RuntimeAuthLoginResultSchema, "auth.login.answer": RuntimeAuthLoginResultSchema, "auth.login.complete": MutationResultSchema, "auth.login.cancel": MutationResultSchema, "auth.login.decline": MutationResultSchema,
  "auth.account.disconnect": MutationResultSchema, "auth.account.rename": MutationResultSchema,
  "auth.profile.select": RuntimeAuthProfileMutationResultSchema, "auth.profile.create": RuntimeAuthProfileMutationResultSchema,
  "auth.profile.rename": RuntimeAuthProfileMutationResultSchema, "auth.profile.delete": RuntimeAuthProfileMutationResultSchema,
  "auth.profile.bind_current_project": RuntimeAuthProfileMutationResultSchema, "auth.profile.unbind_current_project": RuntimeAuthProfileMutationResultSchema,
  "config.mutate": RuntimeConfigMutationResultSchema, "config.reset": RuntimeConfigMutationResultSchema,
  "settings.set_module": MutationResultSchema, "settings.set_modules": MutationResultSchema, "settings.set_workflow_mode": MutationResultSchema,
  "settings.set_persistent_processes": MutationResultSchema, "settings.set_update_auto_install": MutationResultSchema,
  "command.invoke": CommandOutcomeSchema, "command_usage.record": MutationResultSchema,
  "model.save_effort": RuntimeSaveModelEffortResultSchema, "model.reset_assignments": RuntimeResetModelAssignmentsResultSchema,
  "provider_model.set": RuntimeSetProviderModelResultSchema, "provider_models.set_auto_enable": RuntimeSetProviderAutoEnableNewModelsResultSchema,
  "provider_models.deselect_all": Schema.Union([ProviderModelViewSchema, RuntimeProviderModelHiddenResultSchema]),
  "provider_models.recheck": Schema.Union([ProviderModelViewSchema, RuntimeProviderModelHiddenResultSchema]),
  "provider_free_routes.set": Schema.Union([ProviderModelViewSchema, RuntimeProviderModelHiddenResultSchema]),
  "background.warm": VoidResultSchema, "subscription_spend_consent.save": SubscriptionSpendConsentMutationResultSchema,
  ...protocolMutationTable(PROTOCOL_MODULE_MUTATIONS, (mutation) => mutation.result),
} satisfies { readonly [Type in FrontendMutation["type"]]: Schema.Codec<unknown> }

/** Validates a result for its mutation type, including module-owned results. */
export function runtimeDispatchResultSchema(type: FrontendMutation["type"]): Schema.Codec<unknown> {
  return RUNTIME_DISPATCH_RESULT_SCHEMAS[type]
}
