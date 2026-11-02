import type { BuiltInCommandDescriptor, CommandOutcome } from "../../protocol/command-catalog-protocol-types.js"
import type { BuiltInCommandContext } from "./command-definitions.js"
import type { BuiltInCommandDefinition } from "./command-types.js"
import { chordForCommand, type Keymap } from "../keymap/keymap.js"
import { chatOnlyCommandNotice } from "../../protocol/client/slash-route.js"

type OutcomePresenter = Pick<BuiltInCommandContext, "showToast" | "focusSession" | "refreshCommandCatalog">

/** Turns the runtime's answer into what the person sees. The client owns
 *  presentation only: every variant maps to one affordance, and no branch
 *  reads the command id. Resolves false when the runtime refused to run the
 *  command, so the prompt gets the typed command back to try again. */
async function presentCommandOutcome(context: OutcomePresenter, outcome: CommandOutcome, openSurface: ReturnType<BuiltInCommandContext["captureSurfaceOpener"]>): Promise<boolean> {
  switch (outcome.kind) {
    case "none": return true
    case "message": context.showToast({ message: outcome.message, variant: "info" }); return true
    case "warning": context.showToast({ message: outcome.message, variant: "warning" }); return true
    case "unavailable": context.showToast({ message: outcome.message, variant: "warning" }); return false
    case "open": openSurface(outcome.surface, outcome.sessionId); return true
    case "focus-session": context.focusSession(outcome.sessionId); return true
    case "stale":
      await context.refreshCommandCatalog()
      context.showToast({ message: "Commands changed, try again", variant: "warning" })
      return false
  }
}

/** Binds every runtime-published built-in descriptor to one invocation. The
 *  runtime executes the command in the composition that published the
 *  descriptor (ARCH-PROTOCOL-037); this client sends the id, the argument, the catalog
 *  revision it rendered, and the chat in front, then presents the outcome. A
 *  descriptor that publishes the surface it opens needs no runtime: the
 *  surface opens at once at the descriptor's target, with the argument, also
 *  while the runtime does not answer, and a surface that refuses the opening
 *  gives the prompt its command back. */
export function bindRuntimeCommandDefinitions(
  commands: readonly BuiltInCommandDescriptor[],
  chordFor: Keymap["chordFor"],
): readonly BuiltInCommandDefinition<BuiltInCommandContext>[] {
  return commands.map((command) => {
    const keybinding = chordForCommand(chordFor, command.id)
    return {
      spec: {
        id: command.id,
        title: command.title,
        description: command.description,
        ...(command.aliases.length > 0 ? { aliases: command.aliases } : {}),
        ...(keybinding === undefined ? {} : { keybinding }),
      },
      execute: async (context, argument) => {
        if (command.opens !== undefined) return await context.openSurface(command.opens, { ...(argument === undefined ? {} : { argument }), ...(command.target === undefined ? {} : { target: command.target }) })
        const agent = context.agentInView()
        if (agent !== undefined) { context.showToast({ message: chatOnlyCommandNotice(command.id, agent), variant: "warning" }); return false }
        const sessionId = context.signals.sessionInputMode()?.kind === "chat" ? context.signals.foregroundId() : undefined
        const openSurface = context.captureSurfaceOpener()
        const outcome = await context.appService.dispatch({
          type: "command.invoke",
          id: command.id,
          revision: context.signals.commandCatalogRevision(),
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(argument === undefined ? {} : { argument }),
        })
        return await presentCommandOutcome(context, outcome, openSurface)
      },
    }
  })
}
