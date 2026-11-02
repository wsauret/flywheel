import { createContext, useContext } from "solid-js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { SessionDetailCache } from "../hooks/create-session-surface.js"

/** Cards share the viewer's held session details and the shell's dispatch. */
export interface SubagentControls {
  readonly details: Pick<SessionDetailCache, "retain" | "view">
  readonly client: Pick<RuntimeClient, "dispatch">
  readonly report: (message: string, variant: "warning" | "error") => void
}

const SubagentControlsContext = createContext<SubagentControls>()
export const SubagentControlsProvider = SubagentControlsContext.Provider

export function useSubagentControls(): SubagentControls | undefined {
  return useContext(SubagentControlsContext)
}
