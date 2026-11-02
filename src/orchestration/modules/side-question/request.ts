import { OutputProjector } from "../../../infra/output/output-projector.js"
import { RuntimeEventProjector } from "../../../infra/output/runtime-event-projector.js"
import { resolveSessionDir } from "../../../infra/paths.js"
import { mergeAbortSignals } from "../../../infra/abort.js"
import type { ChatModuleHostInput } from "../../chat-module-host.js"
import { createAgentHost } from "../../runner/host.js"
import type { SideQuestionRun } from "./host.js"
import { createSideQuestionHost } from "./host.js"

/** Session admission and the shared one-shot runner preserve ordinary chat prompting and request accounting. */
export function createChatSideQuestions(input: ChatModuleHostInput) {
  const { deps, background, emit } = input
  return createSideQuestionHost({
    signal: background.signal,
    capture: () => deps.treeWriter.captureRawLiveMessages(),
    run: async (request: SideQuestionRun) => {
      const role = (await deps.resolveRoles()).get("chat")
      const signal = mergeAbortSignals(background.signal, request.signal)
      const output = new OutputProjector({ executionCwd: deps.executionCwd })
      const fold = new RuntimeEventProjector(output)
      const host = createAgentHost({ createRunner: deps.createAgent })
      return host.runTurn({
        createContextOptions: () => ({
          model: role?.model,
          effort: role?.effort,
          providerOptions: role?.providerOptions,
          requestSelection: (roles) => ({ roleId: "chat", ...roles.get("chat") }),
          projectRoot: deps.projectRoot,
          executionCwd: deps.executionCwd,
          userDataRoot: deps.userDataRoot,
          accountHome: deps.accountHome,
          sessionDir: resolveSessionDir(deps.sessionId, deps.projectRoot),
          agentRegistry: deps.personas,
          auth: deps.auth,
          activeProfileId: deps.activeProfileId,
          availableModels: deps.availableModels,
          resolveRoles: deps.resolveRoles,
          resolveEnvSnapshot: deps.resolveEnvSnapshot,
          moduleSelection: deps.moduleSelection,
          capabilityAccess: deps.capabilityAccess,
          captureProviderConnection: deps.captureProviderConnection,
          purpose: { kind: "chat-side-call" },
          conversation: {
            kind: "replay",
            sessionId: deps.sessionId,
            providerSessionKey: request.id,
            historyProjection: "context-only",
            priorMessages: request.messages,
            requestAccounting: { owner: { kind: "session", sessionId: deps.sessionId }, streamId: request.id, writer: deps.infra.sessionEventWriter, reader: deps.infra.projectionReader },
          },
          lifecycle: { kind: "one-shot", signal },
          // A side call adds no launch value: it runs as an agent of its chat
          // tree's shared host, advertised the tree's tools, and every call is
          // refused. A per-call launch value starts another Claude engine process,
          // so it belongs in HOST_SPLIT_EXCEPTIONS
          // (provider-claude-agent-sdk/agent-host/host-registry.ts) with its
          // reason. A chat is the root of its tree.
          treeRootSessionId: deps.sessionId,
          maxLLMCalls: 1,
          onEvent: (event) => {
            if (event.type === "model.usage.measured") emit("model.usage.measured", { sessionId: deps.sessionId, data: event.data })
            else if (event.type === "budget.stream.completed") emit("budget.stream.completed", { sessionId: deps.sessionId, data: event.data })
            else {
              fold.dispatch(event)
              request.onAnswer(output.getBlocks().flatMap((block) => block.kind === "text" ? [block.content] : []).join("\n\n"))
            }
          },
        }),
        message: "",
        resilience: { signal },
      })
    },
  })
}
