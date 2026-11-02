import { loadPersonaSources } from "./persona-sources.js"

export interface AgentDefaults {
  readonly [path: string]: string
}

/** Returns persona definitions for the bundled-default catalog. Persona
 * publication is owned by the definitions installer. */
export function loadAgentDefaults(): AgentDefaults {
  return loadPersonaSources()
}
