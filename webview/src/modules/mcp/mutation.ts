import type { FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { mcpRemovalConfirmation, type McpClientAction, type McpEnabledAction, type McpRemovalReview, type McpStatusRow } from "../../../../src/protocol/modules/mcp.js"
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
  const serverKey = (name: string) => actionKey("mcp.server", name)
  const connectorsKey = actionKey("mcp.claudeAiConnectors")
  const run = async (key: string, mutation: McpMutation, copy?: McpRemovalReview): Promise<void> => {
    if (!admitted()) return
    await client.actions.run(key, async () => {
      if (copy) {
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
        else if (mutation.type === "mcp.authenticate") client.report("info", `${mutation.server} authenticated.`)
        else if (mutation.type === "mcp.reconnect") client.report("info", `${mutation.server} connected.`)
      } catch {
        if (admitted()) client.report("warning", "Flywheel could not complete the MCP action. Check the server status and try again.")
      }
    })
  }
  return {
    working: (name: string) => client.actions.working(serverKey(name)),
    claudeAiConnectorsWorking: () => client.actions.working(connectorsKey),
    claudeAiConnectors: (enabled: boolean) => run(connectorsKey, { type: "mcp.setClaudeAiConnectors", enabled }),
    authenticate: (row: McpStatusRow) => run(serverKey(row.name), { type: "mcp.authenticate", server: row.name }),
    reconnect: (row: McpStatusRow) => run(serverKey(row.name), { type: "mcp.reconnect", server: row.name }),
    enabled: (row: McpStatusRow, action: McpEnabledAction) => run(serverKey(row.name), { type: "mcp.setEnabled", server: row.name, scope: action.scope, enabled: action.enabled, expected: row.expected }),
    client: (row: McpStatusRow, action: McpClientAction) => run(serverKey(row.name), { type: "mcp.setClient", server: row.name, scope: row.definitionScope, client: action.client, expected: row.expected }),
    remove: (row: McpStatusRow) => run(serverKey(row.name), { type: "mcp.remove", server: row.name, scope: row.definitionScope, expected: row.expected }, mcpRemovalConfirmation(row)),
  }
}
