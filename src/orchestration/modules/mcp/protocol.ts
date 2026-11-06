import { MCP_REGISTRATION_HINT, mcpClientReason, mcpCursor, mcpProtocol, type McpManagementResult } from "../../../protocol/modules/mcp.js"
import type { ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import type { ConfigMutationResult } from "../../config/runtime-config-owner.js"
import { mcpMutationMessage } from "./config-mutation.js"
import { McpRegistrationRefusedError, McpSignInPortBusyError } from "./errors.js"
import { mcpService } from "./service.js"

/** The module's protocol runtime. Every manager transition publishes the
 *  whole server list, so the newest patch supersedes any it overtook. While
 *  the module is off, whether from composition or a live toggle, the snapshot
 *  is empty and every mutation is refused: a client shows no server from
 *  its next snapshot. */
export function createMcpProtocol(services: ModuleProtocolServices): ModuleProtocolRuntime<typeof mcpProtocol> {
  const service = () => (services.enabled() ? services.modules.get(mcpService) : undefined)
  const unsubscribe = services.modules.get(mcpService)?.subscribe(() => {
    const current = service()
    services.publish({ cursor: mcpCursor(), payload: { kind: "mcp.changed", servers: current?.status() ?? [], claudeAiConnectors: current?.claudeAiConnectors() ?? false } })
  })
  return {
    serve: {
      mcpStatusSnapshot: async () => {
        const current = service()
        return { servers: current?.status() ?? [], claudeAiConnectors: current?.claudeAiConnectors() ?? false, snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: mcpCursor() }) }
      },
    },
    mutate: {
      "mcp.setEnabled": async (mutation) => {
        const current = service()
        if (!current) return { ok: false, error: "MCP servers are off" }
        return manage(() => current.setEnabled(mutation))
      },
      "mcp.setClient": async (mutation) => {
        const current = service()
        if (!current) return { ok: false, error: "MCP servers are off" }
        return manage(() => current.setClient(mutation))
      },
      "mcp.setClaudeAiConnectors": async ({ enabled }) => {
        const current = service()
        if (!current) return { ok: false, error: "MCP servers are off" }
        return manage(() => current.setClaudeAiConnectors(enabled))
      },
      "mcp.remove": async (mutation) => {
        const current = service()
        if (!current) return { ok: false, error: "MCP servers are off" }
        return manage(() => current.remove(mutation))
      },
      "mcp.authenticate": async (mutation) => {
        const current = service()
        if (!current) return { ok: false, error: "MCP servers are off" }
        try {
          await current.authentication.authenticate(mutation.server)
          return { ok: true }
        } catch (error) {
          // The browser handoff and the token exchange can fail with a
          // provider URL in the message; the person gets the repair, not the URL.
          return { ok: false, error: mcpSignInFailure(error) }
        }
      },
      "mcp.reconnect": async ({ server }) => {
        const current = service()
        if (!current) return { ok: false, error: "MCP servers are off" }
        const source = current.status().find((row) => row.name === server)?.source
        try {
          // A claude.ai connector reconnects on a fresh engine and a fresh read, which sees a sign-in made at claude.ai.
          if (source !== undefined) await current.reconnectConnector(server)
          // A failed, retryable server starts a new attempt here; a failure
          // whose cleanup failed rethrows, because a new attempt is not safe.
          await current.manager.acquire(server)
          return { ok: true }
        } catch {
          // Connection errors can carry a URL or a host, so only the outcome travels.
          const state = current.manager.entries().find((entry) => entry.name === server)?.state
          if (state?.tag === "needs_auth" && source !== undefined) return { ok: false, error: `${server} needs a sign-in. ${mcpClientReason({ source, status: "needs_auth" })}` }
          if (state?.tag === "needs_auth") return { ok: false, error: `${server} needs authentication. Authenticate it to connect.` }
          if (state?.tag === "failed" && !state.retryable) return { ok: false, error: `${server} cannot reconnect because its last connection did not close. Restart Flywheel to reconnect it.` }
          return { ok: false, error: `${server} could not connect. Check the server settings and try again.` }
        }
      },
    },
    dispose() { unsubscribe?.() },
  }
}

/** What a person reads when a sign-in fails: the repair, never the cause, which can hold a provider URL. */
export function mcpSignInFailure(error: unknown): string {
  if (error instanceof McpSignInPortBusyError) return error.message
  if (error instanceof McpRegistrationRefusedError) return `MCP authentication failed. ${MCP_REGISTRATION_HINT}`
  return "MCP authentication failed. Try again."
}

async function manage(operation: () => Promise<ConfigMutationResult>): Promise<McpManagementResult> {
  try {
    const result = await operation()
    const message = mcpMutationMessage(result)
    // SAFETY: mcpMutationMessage returns guidance for every rejected outcome.
    return result.ok ? { ok: true, ...(message === undefined ? {} : { warning: message }) }
      : { ok: false, error: message! }
  } catch {
    return { ok: false, error: "MCP management failed. Check the server status and try again." }
  }
}
