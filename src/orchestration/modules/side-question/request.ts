import { OutputProjector } from "../../../infra/output/projector/output-projector.js"
import { RuntimeEventProjector } from "../../../infra/output/runtime-event-projector.js"
import { resolveSessionDir } from "../../../infra/paths.js"
import { mergeAbortSignals } from "../../../infra/abort.js"
import type { ChatModuleHostInput } from "../../chat/chat-module-host.js"
import { createAgentGeneration } from "../../agent-runtime/runner/turn-host/host.js"
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
      // A change listener makes the builder record the changes the answer follows.
      const output = new OutputProjector({ executionCwd: deps.executionCwd, onChange: () => {} })
      const fold = new RuntimeEventProjector(output)
      const followAnswer = answerFollower(output, request)
      const host = createAgentGeneration({ createRunner: deps.createAgent })
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
              followAnswer()
            }
          },
        }),
        message: "",
        resilience: { signal },
      })
    },
  })
}

/** Follows the answer, the text blocks joined by blank lines, through the
 *  builder's recorded changes. Text appended to the last text block, or a new
 *  text block after every other, extends the answer, so a streamed token
 *  costs its own length; any other change to a text block, which a
 *  reconciliation or a retraction makes, derives the answer whole again. */
function answerFollower(output: OutputProjector, request: Pick<SideQuestionRun, "onAnswer" | "onAppend">): () => void {
  let lastTextId: string | undefined
  return () => {
    const batch = output.drainChanges()
    let whole = batch.fullResync
    let appended = ""
    for (const change of batch.changes) {
      if (change.kind === "append-content") {
        if (change.identity.kind !== "text") continue
        if (change.identity.id === lastTextId) appended += change.text
        else whole = true
      } else if (change.block.kind !== "text") continue
      else if (change.kind === "insert" && !output.getBlocks().slice(change.index + 1).some((block) => block.kind === "text")) {
        appended += (lastTextId === undefined ? "" : "\n\n") + change.block.content
        lastTextId = change.block.id
      } else whole = true
    }
    if (whole) {
      const texts = output.getBlocks().filter((block) => block.kind === "text")
      lastTextId = texts.at(-1)?.id
      request.onAnswer(texts.map((block) => block.content).join("\n\n"))
    } else if (appended) request.onAppend(appended)
  }
}
