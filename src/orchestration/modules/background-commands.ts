import type { FirstPartyModule } from "../module-catalog.js"


export const backgroundCommandsModule = {
  id: "background-commands",
  headless: { order: 1 },
  dependencies: [],
  producesBackgroundWork: true,
  contributions: [
    { domain: "shellOperations", id: "background", value: { background: true } },
    { domain: "settings", id: "background-commands", value: { control: "binary", label: "Background Commands", description: "Allow commands and tasks to continue in the background" } },
  ],
} as const satisfies FirstPartyModule
