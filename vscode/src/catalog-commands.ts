import { moduleHostCommand } from "../../src/protocol/modules.js"

/** Each palette command that is the same action as a command of the
 *  runtime's command catalog, by the catalog id of that command. Its palette
 *  title is "Flywheel: " and the catalog name (ARCH-PROTOCOL-037). The
 *  extension runs each through the client as that command, so it opens the
 *  same surface as the command menu entry; Changes keeps the editor's own
 *  diff views. */
export const CATALOG_PALETTE_COMMANDS = {
  "flywheel.showUsage": "usage",
  "flywheel.pickModel": "model-and-effort",
  "flywheel.browseModels": "model",
  "flywheel.signIn": "auth",
  "flywheel.settings": "settings",
  "flywheel.status": "status",
  "flywheel.profiles": "profile",
  "flywheel.newSession": "new",
  "flywheel.compact": "compact",
  "flywheel.learn": "learn",
  "flywheel.drainPapercuts": moduleHostCommand("drainPapercuts"),
  "flywheel.openAllChanges": "changes",
} as const

export type CatalogPaletteCommand = keyof typeof CATALOG_PALETTE_COMMANDS
