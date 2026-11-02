/** The one name of each client action that a host also offers as its own
 *  command, keyed by the host command id. The command menu shows the name,
 *  and the editor palette titles the command "Flywheel: <name>"
 *  (PI-INTERACTION-081), so both places call one action by one name. */
export const HOST_ACTION_NAMES = {
  "flywheel.addFiles": "Mention a project file",
  "flywheel.revertTurn": "Review changes to undo",
  "flywheel.showRuntimeLog": "Runtime log",
  "flywheel.reconnect": "Reconnect",
  "flywheel.interrupt": "Interrupt",
  "flywheel.closeSession": "Close chat",
  "flywheel.renameSession": "Rename chat",
  "flywheel.pickProviderModels": "Available models",
} as const
