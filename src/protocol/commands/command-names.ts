/** The one name of each kernel command, keyed by its id (PI-INTERACTION-081,
 *  ARCH-PROTOCOL-037). The runtime publishes it as the command's title, and
 *  every client heads the surface the command opens with it, so the menu
 *  entry and the screen it opens read the same. A module command's name
 *  sits beside its id in the module's protocol file. */
export const KERNEL_COMMAND_NAMES = {
  "model-and-effort": "Model and effort",
  model: "Models",
  auth: "Authentication",
  settings: "Settings",
  bg: "Background work",
  status: "Status",
  profile: "Auth profiles",
  doctor: "Doctor",
  shortcuts: "Keyboard shortcuts",
  new: "New chat",
  sessions: "Sessions",
  changes: "Changes",
  compact: "Compact conversation",
  resume: "Resume",
  attach: "Attach files",
  find: "Find in transcripts",
  fork: "Fork conversation",
  close: "Close chat",
  help: "Commands",
} as const
