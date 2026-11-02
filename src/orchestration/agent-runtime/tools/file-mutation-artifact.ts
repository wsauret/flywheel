import type { GitAiAttributionService } from "../git-ai-attribution-service.js"
import type { ToolAttributionIdentity } from "./types.js"

interface FileMutationArtifactContext {
  readonly gitAiAttribution?: GitAiAttributionService
  readonly attributionIdentity?: ToolAttributionIdentity
  readonly toolUseId?: string
}

interface FileMutationArtifactInput {
  readonly path: string
  readonly beforeContent: string | Uint8Array
  readonly afterContent: string | Uint8Array
}

export interface SettledFileMutationArtifact {
  readonly path: string
  readonly beforeContent: string
  readonly afterContent: string
}

interface FileMutationArtifactAccumulator {
  readonly identity: ToolAttributionIdentity
  readonly settled: Map<string, SettledFileMutationArtifact>
}

const accumulators = new WeakMap<GitAiAttributionService, Map<string, FileMutationArtifactAccumulator>>()

export function settleFileMutationArtifact(
  context: FileMutationArtifactContext,
  file: FileMutationArtifactInput,
): void {
  const artifact = accumulator(context)
  if (!artifact) return
  const settledFile = Object.freeze({
    path: file.path,
    beforeContent: artifactText(file.beforeContent),
    afterContent: artifactText(file.afterContent),
  })
  const prior = artifact.settled.get(settledFile.path)
  artifact.settled.set(settledFile.path, Object.freeze({
    ...settledFile,
    ...(prior ? { beforeContent: prior.beforeContent } : {}),
  }))
}

/** Takes one immutable exact settled prefix. Each tool call can be taken once. */
export function takeFileMutationAttribution(
  context: FileMutationArtifactContext,
): { readonly identity: ToolAttributionIdentity; readonly files: readonly SettledFileMutationArtifact[] } | undefined {
  const service = context.gitAiAttribution
  const toolUseId = context.toolUseId
  if (!service || !toolUseId) return undefined
  const operations = accumulators.get(service)
  const operation = operations?.get(toolUseId)
  if (!operation) return undefined
  operations?.delete(toolUseId)
  if (operations?.size === 0) accumulators.delete(service)
  if (operation.settled.size === 0) return undefined
  return Object.freeze({ identity: operation.identity, files: Object.freeze([...operation.settled.values()]) })
}

/** Offers settled files once. Attribution failures cannot change the tool result. */
export function publishFileMutationAttribution(context: FileMutationArtifactContext): void {
  const job = takeFileMutationAttribution(context)
  if (!job) return
  try {
    context.gitAiAttribution?.direct(job)
  } catch {
    // Attribution observes a completed publication and owns no mutation state.
  }
}

function artifactText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8")
}

function accumulator(context: FileMutationArtifactContext): FileMutationArtifactAccumulator | undefined {
  const service = context.gitAiAttribution
  const identity = context.attributionIdentity
  const toolUseId = context.toolUseId
  if (!service || !identity || !toolUseId) return undefined
  let operations = accumulators.get(service)
  if (!operations) {
    operations = new Map()
    accumulators.set(service, operations)
  }
  let operation = operations.get(toolUseId)
  if (!operation) {
    operation = { identity, settled: new Map() }
    operations.set(toolUseId, operation)
  }
  return operation
}
