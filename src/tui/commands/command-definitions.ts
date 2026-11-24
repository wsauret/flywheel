import { errorMessage } from "../../infra/error-message.js"
import { fontInstallSummary, fontStatusSummary, getFontStatus, installBundledFont } from "../../orchestration/font-installer.js"
import { ownedCommandRunner } from "../../infra/owned-command.js"
import { createAsyncReporter } from "../context/toast-presenter.js"
import type { Keymap } from "../terminal/keymap/keymap.js"
import type { BuiltInCommandContext, BuiltInCommandDefinition, FontCommandContext } from "./command-types.js"
import type { BuiltInCommandDescriptor } from "../../protocol/commands/command-catalog-protocol-types.js"
import { bindRuntimeCommandDefinitions } from "./runtime-command-bindings.js"
import { commandMenuGroups } from "../../protocol/client/command-menu.js"

export async function handleFontCommand(context: FontCommandContext, action: string | undefined): Promise<void> {
  switch ((action ?? "status").toLowerCase()) {
    case "status":
      context.showToast({ message: fontStatusSummary(getFontStatus(context.directories)), variant: "info", duration: 5000 })
      return
    case "install": {
      const result = await installBundledFont(context.directories, { run: ownedCommandRunner(context.launcher) })
      context.showToast({ message: fontInstallSummary(result), variant: "success", duration: 6000 })
      return
    }
    case "dismiss":
    case "reset": {
      const view = context.runtimeConfig.view()
      if (!view) {
        context.showToast({ message: "Font tip update failed: Configuration is still loading.", variant: "error" })
        return
      }
      const desired = action === "dismiss"
      const result = await context.runtimeConfig.mutate({
        type: "config.mutate",
        setting: { id: "fontTipDismissed", expected: { kind: "value", value: view.values.fontTipDismissed }, desired },
      })
      if (result.kind !== "committed" && result.kind !== "committed-with-durability-warning" && result.kind !== "committed-with-degraded-application") {
        context.showToast({ message: `Font tip update failed: ${result.message}`, variant: "error" })
        return
      }
      context.showToast({ message: desired ? "Font tip dismissed" : "Font tip reset", variant: "success" })
      return
    }
    default:
      context.showToast({ message: "Usage: /font status|install|dismiss|reset", variant: "warning" })
  }
}

/** The terminal's command list: every command the runtime catalog publishes,
 *  in command-menu order, then the commands that act on the terminal itself.
 *  The catalog owns each published command's name, aliases, and position; a
 *  keyboard shortcut hint comes from the keymap by the command's id. */
export function buildCommandDefinitions(
  chordFor: Keymap["chordFor"],
  builtInCommands: readonly BuiltInCommandDescriptor[] = [],
): readonly BuiltInCommandDefinition<BuiltInCommandContext>[] {
  const run = (context: BuiltInCommandContext, task: () => Promise<void>): true => {
    createAsyncReporter(context.showToast)(task)
    return true
  }
  const { top, chat, more, rest } = commandMenuGroups(builtInCommands)
  return [
    ...bindRuntimeCommandDefinitions([...top, ...chat, ...more, ...rest], chordFor),
    { spec: { id: "theme", title: "Theme", description: "Switch theme" }, execute: (context) => { context.openThemeModal(); return true } },
    { spec: { id: "font", title: "Font", description: "Check or install the recommended terminal font: status, install, dismiss, or reset" }, execute: (context, arg) => run(context, () => handleFontCommand(context, arg)) },
    { spec: { id: "clear", title: "Clear", description: "Open a fresh chat tab", hidden: true, aliases: ["reset"] }, execute: (context) => run(context, context.startClearedChat) },
    { spec: { id: "restart", title: "Restart", description: "Restart Flywheel in place and keep your tabs, drafts, and running work" }, execute: (context) => run(context, async () => {
      // The drain can outlast any timed toast; the successor's first frame or the error toast replaces it.
      context.showToast({ message: "Restarting Flywheel", variant: "info", duration: 0 })
      await context.restart().catch((cause: unknown) => { throw new Error(`Flywheel could not restart: ${errorMessage(cause)}`) })
    }) },
    { spec: { id: "exit", title: "Exit", description: "Exit Flywheel", aliases: ["quit"] }, execute: (context) => { context.exit(); return true } },
  ]
}
