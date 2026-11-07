import type { AgentLoopOptions } from "./agent-loop-types.js"
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js"
import { FileReadLedger } from "./tools/file-read-ledger.js"
import type { ToolContext, ToolNameMap } from "./tools/types.js"
import type { ConversationMessage, ServingAttempt } from "./llm/types.js"
import { prepareRequestPrompt } from "./request-preparation.js"
import type { ModelInteractionProfile } from "./model-interaction-profile.js"

interface AgentLoopToolContextInput {
  options: AgentLoopOptions
  executionCwd: string
  signal: AbortSignal | undefined
  attempt: () => ServingAttempt
  handoff: ToolContext["handoff"]
  snapshotConversation: () => Promise<ConversationMessage[]>
  contextAdmission: NonNullable<ToolContext["contextAdmission"]>
  turnHasVisibleText: NonNullable<ToolContext["turnHasVisibleText"]>
  turnHop: NonNullable<ToolContext["turnHop"]>
  conversationHistory: NonNullable<ToolContext["conversationHistory"]>
}

interface AgentLoopToolContext {
  /** The loop's single surface owner: every request resolves through it. */
  surface: RequestToolSurfaceOwner
  toolContext: ToolContext
  prepareCurrentPrompt(profile: ModelInteractionProfile): Promise<void>
}

function toolNameMap(registrationIdentities: ReadonlyMap<string, string>): ToolNameMap {
  return {
    logical: (presented) => registrationIdentities.get(presented) ?? presented,
    presented: (logical) => {
      for (const [presented, id] of registrationIdentities) if (id === logical) return presented
      return logical
    },
  }
}

export function createAgentLoopToolContext(input: AgentLoopToolContextInput): AgentLoopToolContext {
  const { options, executionCwd, signal, handoff, snapshotConversation, contextAdmission, turnHasVisibleText, turnHop, conversationHistory } = input
  const surface = options.tools
  const toolContext: ToolContext = {
    persistentProcesses: options.persistentProcesses,
    admitPersistentProcess: options.persistentProcesses && options.allowPersistentProcesses
      ? options.allowPersistentProcesses
      : undefined,
    executionCwd,
    readLedger: new FileReadLedger(),
    projectRoot: options.projectRoot,
    userDataRoot: options.userDataRoot,
    protectedTraversalRoots: options.protectedTraversalRoots,
    signal,
    disposalSignal: options.disposalSignal,
    backgroundSignal: options.background?.signal,
    shell: options.background?.shell,
    handoff,
    scratchDir: options.scratchDir,
    spawnOwned: options.launcher?.spawnOwned,
    moduleRuntimes: options.moduleRuntimes,
    snapshotConversation,
    contextAdmission,
    turnHasVisibleText,
    turnHop,
    conversationHistory,
    // Read from the request in flight, not captured. Grants use logical tool
    // identities even when the provider receives a contract-specific adapter,
    // and only the tools this agent may call, so a general clone inherits no
    // tool its parent's calls are refused.
    get availableTools() { return new Set(surface.current().usableToolNames) },
    get capabilities() { return surface.current().capabilities },
    get toolNames() { return toolNameMap(surface.current().registrationIdentities) },
    get effectiveBundledSkillIds() { return options.effectiveBundledSkillIds },
    artifactScopeId: options.artifactScopeId,
    retrievalSessionId: options.retrievalSessionId,
    sessionId: options.sessionId,
    conversationId: options.conversationId,
    parentToolUseId: options.parentToolUseId,
    flushCanonicalMessages: options.flushCanonicalMessages,
    backgroundTasks: options.background?.tasks,
    sessionEventWriter: options.sessionEventWriter,
    sessionEventStore: options.sessionEventStore,
    projectionReader: options.sessionEventReader,
    applyNestedStoredFact: options.applyNestedStoredFact,
    capabilityAccess: options.capabilityAccess,
  }

  return {
    surface,
    toolContext,
    prepareCurrentPrompt: async (profile) => {
      await prepareRequestPrompt(options, profile, input.attempt())
    },
  }
}
