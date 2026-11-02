import type { FrontendMutation, RuntimeQuery } from "../app-service-types.js"
import { PROTOCOL_MODULE_MUTATIONS, PROTOCOL_MODULE_READS } from "../modules.js"
import { protocolMutationTable, protocolQueryTable } from "../protocol-module.js"

/** Compile-time coverage of the protocol surface the editor host exposes.
 *
 *  The editor shell in `webview/editor/` gates every mutation through this
 *  table, and a mutation or query the editor silently does not know about is
 *  invisible in review: nothing breaks, a capability just never reaches the
 *  editor. So every member of both wire unions must be classified here, and
 *  the `never` default turns an unclassified addition into a type error
 *  instead of a quiet gap.
 *
 *  "exposed" means some command, view, or client sheet in the webview dispatches it.
 *  "omitted" is the explicit decision not to surface it in the editor, stated
 *  as an entry so the decision survives review. A module's reads and mutations
 *  are exposed unless its protocol home declares `editor: "omitted"`, so both
 *  tables state only kernel rows by hand. */
export type ProtocolExposure = "exposed" | "omitted"

/** One entry per wire type: a member the table lacks, or a key the union lost, is a type error. */
type MutationExposureTable = { readonly [T in FrontendMutation["type"]]: ProtocolExposure }
type QueryExposureTable = { readonly [T in RuntimeQuery["type"]]: ProtocolExposure }

const MUTATION_EXPOSURE = {
  "session.changes.undo": "exposed",
  "session.changes.set_viewed": "exposed",
  "chat.open": "exposed",
  "chat.compact": "exposed",
  "chat.interrupt": "exposed",
  "chat.resume": "exposed",
  "background.terminate": "exposed",
  "background.warm": "exposed",
  "bash.detach": "exposed",
  "session.send": "exposed",
  "session.activate": "exposed",
  "session.claim_composer_returns": "exposed",
  "session.release": "exposed",
  "session_detail.release": "exposed",
  "output.watch": "exposed",
  "session.fork": "exposed",
  "session.close": "exposed",
  "session.delete": "exposed",
  "session.discard_transient": "exposed",
  "session.reorder": "exposed",
  "session.dismiss_notice": "exposed",
  "session.rename": "exposed",
  "question.answer": "exposed",
  "question.cancel": "exposed",
  "auth.refresh": "exposed",
  "auth.catalog.refresh": "exposed",
  "auth.login": "exposed",
  "auth.login.answer": "exposed",
  "auth.login.complete": "exposed",
  "auth.login.cancel": "exposed",
  "auth.login.decline": "exposed",
  "auth.account.disconnect": "exposed",
  "auth.account.rename": "exposed",
  "auth.profile.select": "exposed",
  "auth.profile.create": "exposed",
  "auth.profile.rename": "exposed",
  "auth.profile.bind_current_project": "exposed",
  "auth.profile.unbind_current_project": "exposed",
  "auth.profile.delete": "exposed",
  "config.mutate": "exposed",
  "config.reset": "exposed",
  "settings.set_module": "exposed",
  "settings.set_modules": "exposed",
  "settings.set_workflow_mode": "exposed",
  "settings.set_persistent_processes": "exposed",
  "settings.set_update_auto_install": "exposed",
  "model.save_effort": "exposed",
  "model.reset_assignments": "exposed",
  "provider_model.set": "exposed",
  "provider_models.deselect_all": "exposed",
  "provider_models.recheck": "exposed",
  "provider_models.set_auto_enable": "exposed",
  "provider_free_routes.set": "exposed",
  "subscription_spend_consent.save": "exposed",
  "command_usage.record": "exposed",
  "command.invoke": "exposed",
  ...protocolMutationTable(PROTOCOL_MODULE_MUTATIONS, (mutation) => mutation.editor === "omitted" ? "omitted" : "exposed"),
} satisfies MutationExposureTable

const QUERY_EXPOSURE = {
  sessionChangeSummary: "exposed",
  sessionChanges: "exposed",
  sessionChangeDiff: "exposed",
  mutationFiles: "exposed",
  mutationPatchWindow: "exposed",
  sessionBackgroundWork: "exposed",
  snapshot: "exposed",
  outputWindow: "exposed",
  outputRange: "exposed",
  outputGroupChildren: "exposed",
  outputBlockBody: "exposed",
  projectFiles: "exposed",
  statusSnapshot: "exposed",
  budgetSnapshot: "exposed",
  questionSnapshot: "exposed",
  roleSnapshot: "exposed",
  authStatusSnapshot: "exposed",
  authProfileDeletionPreview: "exposed",
  updateSnapshot: "exposed",
  moduleSnapshot: "exposed",
  configSnapshot: "exposed",
  sessionDetail: "exposed",
  sessionDetailSnapshot: "exposed",
  recallQueuedMessage: "exposed",
  commandCatalog: "exposed",
  modelAssignments: "exposed",
  sessionModelPlan: "omitted",
  modelOptions: "exposed",
  effortOptions: "exposed",
  modelRoles: "exposed",
  "provider_models.query": "exposed",
  gitAiAttributionSnapshot: "exposed",
  gitSnapshot: "exposed",
  commandUsageSnapshot: "exposed",
  transcriptSearch: "exposed",
  ...protocolQueryTable(PROTOCOL_MODULE_READS, (read) => read.editor === "omitted" ? "omitted" : "exposed"),
} satisfies QueryExposureTable

export function mutationTypeExposure(type: FrontendMutation["type"]): ProtocolExposure {
  return MUTATION_EXPOSURE[type]
}

export function mutationExposure(mutation: FrontendMutation): ProtocolExposure {
  return mutationTypeExposure(mutation.type)
}

export function queryExposure(query: RuntimeQuery): ProtocolExposure {
  return QUERY_EXPOSURE[query.type]
}
