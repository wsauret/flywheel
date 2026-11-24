import { Effect, Exit, Scope } from "effect"
import { canonicalDirectory } from "../../../../src/infra/directory-authorities.js"
import { createTurnDispatcher } from "../../../../src/orchestration/agent-runtime/loop/tool-calls/agent-loop-tools.js"
import { settleTurn } from "../../../../src/orchestration/agent-runtime/loop/tool-calls/agent-turn-settlement.js"
import type { BackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution/background-execution-owner.js"
import { fixedTurnOutputBound, type TurnOutputBound } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js"
import type { StreamEvent, ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RuntimeTool, ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

/** The turn dispatcher of one test file, with its tool context. Call it at the top of the file: the project roots
 *  that its contexts use are the file's own temporary directories, which a replaced result writes its breadcrumb
 *  under. */
export function turnDispatchHarnesses() {
  const temporaryDirectory = temporaryDirectories()

  /** The CLI publishes canonical authorities, so this fixture does too: a
   *  breadcrumb write never follows a link on the project root's own name, and
   *  `/tmp` is a link on this platform. */
  function makeContext(): ToolContext {
    const root = canonicalDirectory(temporaryDirectory("flywheel-loop-tools-"), "test project root")
    return {
      executionCwd: root,
      artifactScopeId: "test-session", retrievalSessionId: "test-session",
      userDataRoot: `${root}/.test-account`, projectRoot: root,
    }
  }

  /** Production shape in miniature: the dispatcher owns the fibers, and the
   *  masked coordinator is the only publisher of results. */
  function harness(input: {
    tools: ReadonlyMap<string, RuntimeTool>
    signal?: AbortSignal
    background?: BackgroundExecutionOwner
    commitAssistant?: () => void
    toolContext?: ToolContext
    outputBound?: TurnOutputBound
  }) {
    const events: StreamEvent[] = []
    const onEvent = (event: StreamEvent): void => { events.push(event) }
    const turnScope = Scope.makeUnsafe()
    const dispatcher = createTurnDispatcher({
      tools: input.tools,
      executionAdmission: (toolName) => input.tools.has(toolName)
        ? { ok: true }
        : { ok: false, refusal: { content: `Tool '${toolName}' is not registered`, outcome: "error" } },
      toolContext: input.toolContext ?? makeContext(),
      signal: input.signal,
      background: input.background,
      turnScope,
      afterToolCall: undefined,
      onEvent,
      artifactScopeId: "test-session",
      outputBound: input.outputBound ?? fixedTurnOutputBound(undefined),
    })
    return {
      events,
      onToolUse: (tc: ToolCall) => dispatcher.onToolUse(tc),
      settle: async (calls: readonly ToolCall[]) => {
        try {
          const settled = await Effect.runPromise(settleTurn({
            dispatcher,
            ...(input.signal ? { turnSignal: input.signal } : {}),
            stream: () => Promise.resolve(),
            commitAssistant: () => {
              input.commitAssistant?.()
              return calls
            },
            commitAssistantBarrier: async () => {},
            commitResults: async () => {},
            commitDisplayBarrier: async () => {},
            onEvent,
            publishTerminal: () => {},
            publishSettlement: () => {},
          }))
          return settled.batch
        } finally {
          await Effect.runPromise(Scope.close(turnScope, Exit.void))
        }
      },
    }
  }

  return { harness, makeContext }
}
