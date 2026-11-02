import type { ConversationMessage } from "./llm/types.js"
import type { ProviderRequestAuditHandle, ProviderRequestAuditWriter } from "./llm/provider-request-audit.js"
import type { GitAiTranscriptMessage } from "./git-ai-attribution-service.js"
import type { RunnableAgentOptions } from "./types.js"
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js"
import type { ToolAttributionIdentity } from "./tools/types.js"

const MAX_GIT_AI_TRANSCRIPT_BYTES = 2 * 1_024 * 1_024
export interface RequestAttributionRegistry {
  register(input: Parameters<ProviderRequestAuditWriter["recordRequest"]>[0], handle: ProviderRequestAuditHandle): void
  resolve(requestId: string): ToolAttributionIdentity | undefined
  retire(requestId: string): void
}

export function createRequestAttribution(options: RunnableAgentOptions, conversationId: string | undefined, surface: RequestToolSurfaceOwner): RequestAttributionRegistry | undefined {
  const service = options.runtimeSurfaces.gitAiAttribution
  const profileId = options.activeProfileId
  if (!service || !profileId || !conversationId) return undefined
  const requests = new Map<string, ToolAttributionIdentity>()
  const retire = (requestId: string): void => {
    requests.delete(requestId)
  }
  return {
    register(input, handle): void {
      if (!surface.current().runtimeConfig.gitAiAttribution) return
      const registration = service.registerRequest({
        requestId: handle.requestId,
        model: input.attribution.model,
        conversationId,
        transcriptBytes: Math.min(MAX_GIT_AI_TRANSCRIPT_BYTES, input.estimatedContextTokens * 8),
        transcript: () => ({ messages: gitAiTranscript(input.messages, MAX_GIT_AI_TRANSCRIPT_BYTES) }),
      })
      if (!registration) return
      const identity: ToolAttributionIdentity = Object.freeze({ ...registration, service, repositoryRoot: service.canonicalRepositoryRoot, profileId, enabled: true })
      requests.set(handle.requestId, identity)
    },
    resolve: (requestId) => requests.get(requestId),
    retire,
  }
}

export function composeAttributionAudit(audit: ProviderRequestAuditWriter, registry: RequestAttributionRegistry | undefined): ProviderRequestAuditWriter {
  if (!registry) return audit
  return {
    ...audit,
    async recordRequest(input) {
      const handle = await audit.recordRequest(input)
      registry.register(input, handle)
      return handle
    },
    async recordResponse(handle, input) {
      try { await audit.recordResponse(handle, input) }
      finally { registry.retire(handle.requestId) }
    },
    ...(audit.recordAbandonedResponse ? {
      async recordAbandonedResponse(handle: ProviderRequestAuditHandle, input: Parameters<NonNullable<ProviderRequestAuditWriter["recordAbandonedResponse"]>>[1]) {
        try { await audit.recordAbandonedResponse?.(handle, input) }
        finally { registry.retire(handle.requestId) }
      },
    } : {}),
  }
}

function gitAiTranscript(messages: ReadonlyArray<ConversationMessage>, byteLimit: number): GitAiTranscriptMessage[] {
  const timestamp = new Date().toISOString()
  const transcript: GitAiTranscriptMessage[] = []
  let bytes = 0
  const append = (message: GitAiTranscriptMessage): boolean => {
    const size = Buffer.byteLength(JSON.stringify(message))
    if (bytes + size > byteLimit) return false
    bytes += size
    transcript.push(message)
    return true
  }
  for (const message of messages) {
    if (message.kind === "user") {
      if (!append({ type: "user", text: typeof message.content === "string" ? message.content : JSON.stringify(message.content), timestamp })) break
      continue
    }
    if (message.kind !== "assistant") continue
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
    for (const block of content) {
      const appended = append(block.type === "tool_use"
        ? { type: "tool_use", name: block.name, input: block.input, timestamp }
        : { type: "assistant", text: block.type === "text" ? block.text : JSON.stringify(block), timestamp })
      if (!appended) return transcript
    }
  }
  return transcript
}
