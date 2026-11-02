import type { MutationResult, FrontendMutation } from "../../protocol/app-service-types.js"
import type { SessionChangesUndoResult } from "../../protocol/session-changes-protocol-types.js"
import type { CommandOutcome } from "../../protocol/command-catalog-protocol-types.js"
import { isProtocolModuleMutation, type ProtocolModuleMutationResult, type ProtocolModuleMutationType } from "../../protocol/modules.js"
import { type ChatMutationDeps, handleChatMutation } from "./chat-mutations.js"
import type { CommandInvokeService } from "./command-invoke-service.js"
import type { ModuleProtocolRoutes } from "./module-protocol-host.js"
import { handleSessionSend, type SessionSendDeps } from "./session-send.js"

export interface MutationHandlerDeps {
  readonly chat: ChatMutationDeps
  /** The owner of a person's message to each kind of session. */
  readonly send: SessionSendDeps
  readonly commands: CommandInvokeService
  /** The module protocol runtimes; a registry mutation routes to its module by lookup. */
  readonly modules: Pick<ModuleProtocolRoutes, "mutate">
}

/** Runtime-wide commands are excluded because the app-service answers them
 * directly; this dispatcher owns session-scoped commands and
 * every module mutation, which it routes by registry lookup. */
export async function dispatchFrontendMutation(
  mutation: Exclude<FrontendMutation,
    | { type: "auth.refresh" }
    | { type: "auth.catalog.refresh" }
    | { type: "auth.login" }
    | { type: "auth.login.answer" }
    | { type: "auth.login.complete" }
    | { type: "auth.login.cancel" }
    | { type: "auth.login.decline" }
    | { type: "auth.account.disconnect" }
    | { type: "auth.account.rename" }
    | { type: "auth.profile.select" }
    | { type: "auth.profile.create" }
    | { type: "auth.profile.rename" }
    | { type: "auth.profile.bind_current_project" }
    | { type: "auth.profile.unbind_current_project" }
    | { type: "auth.profile.delete" }
    | { type: "config.mutate" }
    | { type: "config.reset" }
    | { type: "settings.set_module" }
    | { type: "settings.set_modules" }
    | { type: "settings.set_workflow_mode" }
    | { type: "settings.set_persistent_processes" }
    | { type: "settings.set_update_auto_install" }
    | { type: "command_usage.record" }
    | { type: "model.save_effort" }
    | { type: "model.reset_assignments" }
    | { type: "provider_model.set" }
    | { type: "provider_models.deselect_all" }
    | { type: "provider_models.recheck" }
    | { type: "provider_models.set_auto_enable" }
    | { type: "provider_free_routes.set" }
    | { type: "background.warm" }
    | { type: "subscription_spend_consent.save" }
    | { type: "session.changes.set_viewed" }
    | { type: "session_detail.release" }
    | { type: "output.watch" }
    | { type: "session.claim_composer_returns" }
  >,
  deps: MutationHandlerDeps,
): Promise<MutationResult | SessionChangesUndoResult | CommandOutcome | ProtocolModuleMutationResult<ProtocolModuleMutationType>> {
  if (isProtocolModuleMutation(mutation)) return deps.modules.mutate(mutation)
  switch (mutation.type) {
    case "session.send":
      return handleSessionSend(mutation, deps.send)
    case "session.changes.undo":
    case "chat.open":
    case "chat.compact":
    case "chat.interrupt":
    case "chat.resume":
    case "background.terminate":
    case "bash.detach":
    case "session.activate":
    case "session.release":
    case "session.fork":
    case "session.close":
    case "session.discard_transient":
    case "session.delete":
    case "session.rename":
    case "session.reorder":
    case "session.dismiss_notice":
    case "question.answer":
    case "question.cancel":
      return handleChatMutation(mutation, deps.chat)
    case "command.invoke":
      return deps.commands.invoke(mutation)
  }
}
