import type { FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { mcpRemovalConfirmation, type McpEnabledAction, type McpStatusRow } from "../../../../src/protocol/modules/mcp.js"
import type { ConfirmRequest } from "../../app/client-context.js"
import type { ClientActions } from "../../client/actions.js"
import { actionKey } from "../../client/action-key.js"

type McpMutation = Extract<FrontendMutation, { readonly type: `mcp.${string}` }>
interface McpMutationClient {
  readonly actions: Pick<ClientActions, "run" | "working">
  readonly dispatch: (mutation: McpMutation) => Promise<MutationResult<McpMutation>>
  readonly confirm: (request: ConfirmRequest, signal: AbortSignal) => Promise<boolean>
  readonly report: (severity: "info" | "warning", message: string) => void
}

/** Owns reviewed actions for one sheet lifetime. State changes arrive only through protocol publications. */
export function createMcpMutation(client: McpMutationClient, active: () => boolean, signal: AbortSignal) {
  const admitted = () => !signal.aborted && active()
  const key = (name: string) => actionKey("mcp.server", name)
  const run = async (row: McpStatusRow, mutation: McpMutation, review = false): Promise<void> => {
    if (!admitted()) return
    await client.actions.run(key(row.name), async () => {
      if (review) {
        const copy = mcpRemovalConfirmation(row)
        let confirmed: boolean
        try {
          confirmed = await client.confirm({ title: copy.title, detail: copy.message, confirmLabel: copy.confirmLabel, destructive: true, cancelByDefault: true }, signal)
        } catch {
          return
        }
        if (!confirmed) return
      }
      if (!admitted()) return
      try {
        const result = await client.dispatch(mutation)
        if (!admitted()) return
        if (!result.ok) client.report("warning", result.error)
        else if ("warning" in result && result.warning !== undefined) client.report("warning", result.warning)
        else if (mutation.type === "mcp.authenticate") client.report("info", `${row.name} authenticated.`)
      } catch {
        if (admitted()) client.report("warning", "Flywheel could not complete the MCP action. Check the server status and try again.")
      }
    })
  }
  return {
    working: (name: string) => client.actions.working(key(name)),
    authenticate: (row: McpStatusRow) => run(row, { type: "mcp.authenticate", server: row.name }),
    enabled: (row: McpStatusRow, action: McpEnabledAction) => run(row, { type: "mcp.setEnabled", server: row.name, scope: action.scope, enabled: action.enabled, expected: row.expected }),
    remove: (row: McpStatusRow) => run(row, { type: "mcp.remove", server: row.name, scope: row.definitionScope, expected: row.expected }, true),
  }
}
