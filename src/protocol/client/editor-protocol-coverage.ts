import type { FrontendMutation } from "../app-service-types.js"
import { PROTOCOL_MODULE_MUTATIONS } from "../modules.js"
import { protocolMutationTable } from "../protocol-module.js"

/** Compile-time coverage of the mutations the editor host exposes.
 *
 *  The editor shell in `webview/editor/` gates every mutation through this
 *  table, and a mutation the editor silently does not know about is
 *  invisible in review: nothing breaks, a capability just never reaches the
 *  editor. So every member of the mutation union must be classified here, and
 *  the mapped table type turns an unclassified addition into a type error
 *  instead of a quiet gap.
 *
 *  "exposed" means some command, view, or client sheet in the webview dispatches it.
 *  "omitted" is the explicit decision not to surface it in the editor, stated
 *  as an entry so the decision survives review. A module's mutations are
 *  exposed unless its protocol home declares `editor: "omitted"`, so the
 *  table states only kernel rows by hand. */
export type ProtocolExposure = "exposed" | "omitted"

/** One entry per wire type: a member the table lacks, or a key the union lost, is a type error. */
type MutationExposureTable = { readonly [T in FrontendMutation["type"]]: ProtocolExposure }

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
  "background.release": "exposed",
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
  "service.restart": "exposed",
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

export function mutationTypeExposure(type: FrontendMutation["type"]): ProtocolExposure {
  return MUTATION_EXPOSURE[type]
}
