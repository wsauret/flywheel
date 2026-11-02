import { createHash } from "node:crypto"
import type { HistoricalProviderRequestAuditTool, ProviderRequestAuditOmittedTool, ProviderRequestAuditTool } from "./provider-request-audit-types.js"

// Canonical hashing for the provider-request audit. Computed identically at
// write time and reconstruction time so a folded prompt can be verified
// byte-for-byte against the stored `promptSha256`.

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

const USER_ROUTING_KEYS = new Set(["dispatchIds", "backgroundNotificationIds", "framing", "runtimeNotice", "requestOnly"])

function canonicalJson(value: unknown, messageRoot = false): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("unsupported JSON value: non-finite number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  if (typeof value !== "object") throw new TypeError(`unsupported JSON value: ${typeof value}`)

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("unsupported JSON value: non-ordinary object")

  const entries = Object.entries(value)
  // Queue retirement keys are neither provider content nor durable conversation data. Request framing, the
  // runtime-notice label, and the request-only mark decide how a route sends a message, not what it sends, and the
  // reader labels entries that earlier builds wrote without them, so an audit that those builds recorded still verifies.
  const fields = messageRoot && "kind" in value && value.kind === "user"
    ? entries.filter(([key]) => !USER_ROUTING_KEYS.has(key))
    : entries
  return `{${fields
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`
}

function canonicalArray(values: ReadonlyArray<unknown>): string {
  return `[${values.map((value) => canonicalJson(value, true)).join(",")}]`
}

export function hashSystemPrompt(systemPrompt: string): string {
  return sha256(systemPrompt)
}

export function hashToolInputFormat(format: unknown): string {
  return sha256(canonicalJson(format))
}

function canonicalTool(tool: ProviderRequestAuditTool | HistoricalProviderRequestAuditTool): string {
  const identity = "registrationId" in tool
    ? `,"registrationId":${canonicalJson(tool.registrationId)},"executableId":${canonicalJson(tool.executableId)}`
    : ""
  const presentation = "kind" in tool && tool.kind !== undefined
    ? `,"kind":${canonicalJson(tool.kind)},"inputFormatSha256":${canonicalJson(tool.inputFormatSha256)}`
    : ""
  return `{"name":${canonicalJson(tool.name)}${identity}${presentation},"description":${canonicalJson(tool.description)},"input_schema":${canonicalJson(tool.input_schema)}}`
}

export function hashToolSurface(
  tools: ReadonlyArray<ProviderRequestAuditTool | HistoricalProviderRequestAuditTool>,
  omittedTools: ReadonlyArray<ProviderRequestAuditOmittedTool>,
): string {
  const toolsJson = `[${tools.map(canonicalTool).join(",")}]`
  const omittedToolsJson = `[${omittedTools
    .map((tool) => `{"name":${canonicalJson(tool.name)},"reason":${canonicalJson(tool.reason)}}`)
    .join(",")}]`
  return sha256(`{"tools":${toolsJson},"omittedTools":${omittedToolsJson}}`)
}

// The prompt sha binds the three inputs the model actually received: the
// system prompt, the assembled message array, and the tool surface. The
// reconstruction recomputes this from the historical-fold of the tree plus the
// recorded system prompt and tool surface; a mismatch is a hard error.
export function hashAgentPrompt(input: {
  systemPrompt: string
  messages: ReadonlyArray<unknown>
  tools: ReadonlyArray<ProviderRequestAuditTool | HistoricalProviderRequestAuditTool>
}): string {
  const toolsJson = `[${input.tools.map(canonicalTool).join(",")}]`
  return sha256(
    `{"systemPrompt":${canonicalJson(input.systemPrompt)},"messages":${canonicalArray(input.messages)},"tools":${toolsJson}}`,
  )
}
