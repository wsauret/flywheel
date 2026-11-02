import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation, type ModuleRow } from "../protocol-module.js"
import type { RuntimeCursorIdentity, RuntimePosition } from "../runtime-ui-protocol-types.js"

/** The workspace-scoped effective MCP registry and its lossless management
 * actions. Credentials belong to the account, not a provider auth profile. */

/** One configured server's connection lifecycle as a client may see it. The
 *  manager's internal entry union carries connection handles beside each tag;
 *  only the tag crosses the wire, and the manager's row builder is the
 *  compile-time check that its states and these stay the same set. */
type McpServerStatus = "pending" | "ready" | "failed" | "needs_auth" | "disabled"

/** Stable identifier for a failure the client may want to present with its
 *  own wording; `error` stays the human-readable fallback. */
type McpStatusErrorCode = "connection_failed"

export interface McpConnectionStatusRow {
  readonly name: string
  readonly status: McpServerStatus
  readonly toolCount: number
  readonly error?: string
  readonly errorCode?: McpStatusErrorCode
}

type McpScope = "global" | "project"

/** Applied connection status and private, opaque management expectations.
 * No connection configuration or canonical project path crosses this boundary. */
export interface McpStatusRow extends McpConnectionStatusRow {
  readonly definitionScope: McpScope
  readonly enabledScope: McpScope
  readonly enabled: boolean
  readonly hasGlobalFallback: boolean
  readonly expected: string
}

interface RuntimeMcpStatusSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly servers: readonly McpStatusRow[]
}

type McpPatchPayload = { readonly kind: "mcp.changed"; readonly servers: readonly McpStatusRow[] }

const McpStatusRowSchema: Schema.Codec<McpStatusRow> = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["pending", "ready", "failed", "needs_auth", "disabled"]),
  toolCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  error: Schema.optionalKey(Schema.String),
  errorCode: Schema.optionalKey(Schema.Literal("connection_failed")),
  definitionScope: Schema.Literals(["global", "project"]),
  enabledScope: Schema.Literals(["global", "project"]),
  enabled: Schema.Boolean,
  hasGlobalFallback: Schema.Boolean,
  expected: Schema.String,
})
const RuntimeMcpStatusSnapshotResultSchema: Schema.Codec<RuntimeMcpStatusSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, servers: Schema.Array(McpStatusRowSchema) })
const McpPatchPayloadSchema: Schema.Codec<McpPatchPayload> = Schema.Struct({ kind: Schema.Literal("mcp.changed"), servers: Schema.Array(McpStatusRowSchema) })

/** The module's one domain, exported so its client homes read the view by
 *  this declaration and never by a domain literal. */
export const mcpDomain = defineProtocolDomain({
  domain: "mcp",
  scope: "workspace",
  // One patch carries every server row, so the newest supersedes any it overtook.
  delivery: "latest-collapsible",
  content: "whole-value",
  snapshot: { query: "mcpStatusSnapshot", result: RuntimeMcpStatusSnapshotResultSchema, deadline: "control" },
  patch: McpPatchPayloadSchema,
  view: { snapshot: (result) => result.servers, patch: (payload) => payload.servers },
})

export const mcpCursor = (): RuntimeCursorIdentity => ({ scope: "workspace", domain: mcpDomain.domain })

/** Reauthenticate one server: a user action that drives a browser handoff, so it is lossless (ARCH-PROTOCOL-020). */
const mcpAuthenticate = defineProtocolMutation({
  type: "mcp.authenticate",
  fields: { server: Schema.String },
  result: Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Schema.Struct({ ok: Schema.Literal(false), error: Schema.String })]),
  policy: "lossless",
})

/** A committed save can report publication or connection-application degradation. */
export type McpManagementResult = { readonly ok: true; readonly warning?: string } | { readonly ok: false; readonly error: string }

const McpManagementResultSchema: Schema.Codec<McpManagementResult> = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), warning: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
const selectedFields = { server: Schema.String, scope: Schema.Literals(["global", "project"]), expected: Schema.String }
const mcpSetEnabled = defineProtocolMutation({
  type: "mcp.setEnabled",
  fields: { ...selectedFields, enabled: Schema.Boolean },
  result: McpManagementResultSchema,
  policy: "lossless",
})
const mcpRemove = defineProtocolMutation({
  type: "mcp.remove",
  fields: selectedFields,
  result: McpManagementResultSchema,
  policy: "lossless",
})

export interface McpEnabledAction {
  readonly scope: McpScope
  readonly enabled: boolean
  readonly label: string
}

/** Plain enabled action edits the authored override when one exists. */
export function mcpEnabledAction(row: McpStatusRow): McpEnabledAction {
  return { scope: row.enabledScope, enabled: !row.enabled, label: `${row.enabled ? "Disable" : "Enable"} in ${row.enabledScope === "global" ? "all projects" : "this project"}` }
}

/** Unoverridden globals also offer a private project choice. */
export function mcpProjectEnabledAction(row: McpStatusRow): McpEnabledAction | undefined {
  if (row.definitionScope !== "global" || row.enabledScope !== "global") return undefined
  return { scope: "project", enabled: !row.enabled, label: row.enabled ? "Disable in this project" : "Enable in this project" }
}

export function mcpScopeDetail(row: McpStatusRow): string {
  return row.definitionScope === "project" ? "Project server"
    : row.enabledScope === "project" ? "Global server · project enabled override" : "Global server"
}

/** Removal always targets the defining scope, never an enabled-only override. */
export function mcpRemovalConfirmation(row: Pick<McpStatusRow, "name" | "definitionScope" | "hasGlobalFallback">): McpRemovalReview {
  return {
    title: row.definitionScope === "global" ? "Remove global server" : "Remove project server",
    message: row.definitionScope === "global"
      ? `Remove "${row.name}" from all projects? The global definition and its project enabled overrides will be removed. Full project definitions remain. Saved credentials are kept.`
      : `Remove "${row.name}" from this project?${row.hasGlobalFallback ? " This reveals the inherited global definition." : ""} Saved credentials are kept.`,
    confirmLabel: "Remove",
  }
}

export interface McpRemovalReview {
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
}

/** The surface both client homes register the server list under. */
export const MCP_SURFACE = "mcp"

/** The command that opens the surface; the intro row points a person at it. */
export const MCP_COMMAND = "mcp"
/** The command's one name, which its surface also heads with. */
export const MCP_COMMAND_NAME = "MCP servers"

const OPEN: ModuleRow["action"] = { kind: "surface", id: MCP_SURFACE }

/** Servers a person has to act on: a lapsed token or a failed connection. */
function mcpServersNeedingAttention(servers: readonly McpStatusRow[]): readonly McpStatusRow[] {
  return servers.filter((row) => row.status === "needs_auth" || row.status === "failed")
}

export const mcpProtocol = defineProtocolModule({
  id: "mcp",
  domains: [mcpDomain],
  mutations: [mcpAuthenticate, mcpSetEnabled, mcpRemove],
  rows: {
    // Healthy servers render nothing on the intro card; the row exists only to alert.
    intro: (read) => {
      const attention = mcpServersNeedingAttention(read(mcpDomain) ?? []).length
      return attention === 0 ? [] : [{ id: "mcp", label: "mcp", value: `${attention} need${attention === 1 ? "s" : ""} attention`, hint: "to fix", tone: "warning", action: { kind: "command", id: MCP_COMMAND } }]
    },
    status: (read) => {
      const servers = read(mcpDomain)
      if (servers === undefined) return []
      if (servers.length === 0) return [{ id: "mcp", label: "MCP servers", value: "none configured", action: OPEN }]
      const attention = mcpServersNeedingAttention(servers).length
      if (attention > 0) return [{ id: "mcp", label: "MCP servers", value: `${attention} of ${servers.length} need${attention === 1 ? "s" : ""} attention`, tone: "warning", action: OPEN }]
      const tools = servers.reduce((total, server) => total + server.toolCount, 0)
      return [{ id: "mcp", label: "MCP servers", value: `${servers.length} configured, ${tools} tool${tools === 1 ? "" : "s"}`, action: OPEN }]
    },
  },
})
