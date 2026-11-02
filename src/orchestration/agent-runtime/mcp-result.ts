import type { LlmToolOutputPart } from "../../infra/llm/tool-output-part-schema.js"

export interface McpCallResult {
  readonly content: LlmToolOutputPart[]
  readonly isError: boolean
  readonly structuredContent?: unknown
}

/** Normalizes one MCP tools/call response after the caller applies any boundary redaction. */
export function normalizeMcpCallResult(value: unknown): McpCallResult {
  if (!isRecord(value)) throw new Error("Invalid MCP tools/call response")
  const content = Array.isArray(value.content)
    ? value.content.map(normalizeContentPart)
    : [{ type: "text" as const, text: "[unsupported MCP response content]" }]
  return {
    content,
    isError: value.isError === true,
    ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }),
  }
}

function normalizeContentPart(value: unknown): LlmToolOutputPart {
  if (!isRecord(value) || typeof value.type !== "string") return { type: "text", text: "[unsupported MCP content: unknown]" }
  if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text }
  if ((value.type === "image" || value.type === "audio") && typeof value.data === "string" && typeof value.mimeType === "string") {
    return value.type === "image"
      ? { type: "image", data: value.data, mediaType: value.mimeType }
      : { type: "text", text: `[unsupported MCP content: audio (${value.mimeType})]` }
  }
  if (value.type === "resource_link" && typeof value.uri === "string") return { type: "text", text: value.uri }
  if (value.type === "resource" && isRecord(value.resource)) {
    if (typeof value.resource.text === "string") return { type: "text", text: value.resource.text }
    if (typeof value.resource.uri === "string") return { type: "text", text: value.resource.uri }
  }
  return { type: "text", text: `[unsupported MCP content: ${value.type}]` }
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
