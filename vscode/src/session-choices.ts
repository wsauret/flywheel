import { isActiveActivity, type SessionCatalogRow } from "../../src/protocol/app-service-types.js"

/** One row of a chat quick pick. */
export interface SessionChoice {
  readonly label: string
  readonly description: "working" | "open" | "closed"
  readonly id: string
}

/** The chats a palette command offers, each with one word for where it is.
 *  The word comes from the same live activity the client's session dot
 *  reads: an open chat waits for input between turns and is working only
 *  while a turn runs. `open` offers only the chats a person can still close. */
export function sessionChoices(rows: readonly SessionCatalogRow[], among: "all" | "open"): readonly SessionChoice[] {
  return rows
    .filter((row) => among === "all" || row.lifecycleState === "active")
    .map((row) => ({
      label: row.shortTitle ?? row.title,
      description: isActiveActivity(row.activity) ? "working" : row.lifecycleState === "active" ? "open" : "closed",
      id: row.id,
    }))
}
