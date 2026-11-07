import { randomUUID } from "node:crypto"
import { resolveSessionDir } from "../../infra/paths.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import type { AgentHostContextOptions } from "../runner/types.js"
import type { AgentOptions, RunnerToolSurfaces } from "../agent-runtime/types.js"
import type { ProviderSession } from "../agent-runtime/provider-runtime-cache.js"
import type { ResolvedRole } from "../config/roles.js"
import type { ChatSessionDeps } from "./session.js"

interface ChatRequestOptionsInput {
  readonly deps: ChatSessionDeps
  readonly surfaces: Required<Pick<RunnerToolSurfaces, "background" | "foregroundBashHold" | "askUser">>
  readonly applyNestedStoredFact: (event: StoredFact) => void | Promise<void>
  /** The chat's provider session identity, which its sends and its pre-start share. */
  readonly providerSessionKey: () => string
}

/**
 * What decides the requests of one chat session's runs: its sends, the pre-start of its next send, and a call of
 * its tree's shared host. A send and the chat's pre-start share their options, so the engine that the pre-start
 * started is the one that the send asks for.
 */
export function createChatRequestOptions(input: ChatRequestOptionsInput) {
  const { deps, surfaces, applyNestedStoredFact } = input
  const { sessionId, projectRoot, executionCwd, userDataRoot, accountHome } = deps

  function send(selectedModel: ResolvedRole | undefined, provider: ProviderSession) {
    return {
      agentRegistry: deps.personas,
      model: selectedModel?.model,
      effort: selectedModel?.effort,
      requestSelection: (currentRoles: Awaited<ReturnType<typeof deps.resolveRoles>>) => ({ roleId: "chat", ...currentRoles.get("chat") }),
      providerOptions: selectedModel?.providerOptions,
      proactiveCompactionThreshold: deps.proactiveCompactionThreshold,
      availableModels: deps.availableModels,
      activeProfileId: deps.activeProfileId,
      resolveRoles: deps.resolveRoles,
      executionCwd,
      projectRoot,
      userDataRoot,
      accountHome,
      sessionDir: resolveSessionDir(sessionId, projectRoot),
      createChildConversation: deps.createChildConversation,
      moduleSelection: deps.moduleSelection,
      ...(deps.capabilityAccess ? { capabilityAccess: deps.capabilityAccess } : {}),
      purpose: { kind: deps.rootChatCompletion?.unattended ? "unattended-chat" : "interactive-chat" },
      // Read auth at runner-creation time (per turn). With ChatSessionDeps.auth
      // backed by a getter that forwards to workflowDeps, this reflects auth
      // modal mutations applied since the prior turn.
      auth: deps.auth,
      runtimeSurfaces: {
        recall: (recallInput) => deps.treeWriter.recall(recallInput),
        ...surfaces,
        startWorkflow: deps.startWorkflow,
        workflowMode: deps.workflowMode,
        ...(deps.sessionMessaging ? { sessions: deps.sessionMessaging } : {}),
      },
      sessionEventWriter: deps.infra.sessionEventWriter,
      applyNestedStoredFact,
      sessionEventStore: deps.infra.eventStore,
      sessionEventReader: deps.infra.projectionReader,
      ...(deps.subagentSessions ? { subagentSessions: deps.subagentSessions } : {}),
      providerSession: provider,
    } satisfies Partial<AgentHostContextOptions>
  }

  return {
    send,
    /** The chat's next send on `provider`, for its pre-start (`RequestPreparer`), and the read of its history, which
     *  the preparation runs only when it prepares a request. Between turns the history ends with the chat's reply,
     *  which the person's next message follows, so the read allows an assistant tail. A preparation writes nothing, so
     *  its conversation's writer takes nothing. */
    async prestart(provider: ProviderSession) {
      const roles = await deps.resolveRoles()
      const options: AgentOptions & { readonly providerSession: ProviderSession } = {
        ...send(roles.get("chat"), provider),
        conversation: {
          kind: "durable-tree", sessionId, conversationId: deps.conversationId,
          providerSessionKey: input.providerSessionKey(),
          priorMessages: [],
          append: () => {},
          reserveMessageId: async () => randomUUID(),
          resolveLeafId: () => deps.treeWriter.getLeafId(),
          committedTree: () => deps.treeWriter.getState(),
          captureCommittedForkMessages: () => deps.treeWriter.captureCommittedForkMessages(),
        },
        lifecycle: { kind: "one-shot" },
        onEvent: () => {},
      }
      return { options, readHistory: async () => (await deps.treeWriter.buildContext({ allowAssistantTail: true })).messages }
    },
    /** One call of the chat tree's shared host on `role`'s setting. It runs as a side call of the tree, which shares
     *  its host with every tree-hosted run whatever its purpose: the host's place reads no prompt and no tool grant. */
    host(role: ResolvedRole, provider: ProviderSession): AgentHostContextOptions & { readonly providerSession: ProviderSession } {
      return {
        model: role.model,
        effort: role.effort,
        providerOptions: role.providerOptions,
        resolveRoles: deps.resolveRoles,
        requestSelection: (currentRoles) => ({ roleId: role.roleId, ...currentRoles.get(role.roleId) }),
        purpose: { kind: "session-title" },
        auth: deps.auth,
        executionCwd,
        projectRoot,
        userDataRoot,
        accountHome,
        // A chat is the root of its tree.
        treeRootSessionId: sessionId,
        memorySnapshot: null,
        runtimeSurfaces: {},
        conversation: { kind: "stateless" },
        lifecycle: { kind: "one-shot" },
        onEvent: () => {},
        providerSession: provider,
      }
    },
  }
}
