import { Cause, Effect, Queue } from "effect";
import type { CliTool, QueryIdentity } from "./cli-view.js";
import type { CliFrame, EngineLaunch, LaunchedQuery, QueryLaunch } from "./query-launcher.js";
import { observeEngine, type EngineObserver, type ObservedEngine } from "./observed-engine.js";
import { queueIterable } from "./queue-iterable.js";
import type { StepGate } from "./step-gate.js";
import { createToolGate, type ToolGate } from "./tool-gate.js";

/** The launch values of an engine for a query of `identity`: what the engine fixes when it starts. */
export type EngineValues = Omit<EngineLaunch, "prompt" | "mcpServer" | "stepGate" | "onStderrLine" | "tools"> & { readonly tools: readonly CliTool[] };

/** The launch values that `identity` and the bridge's model give. Every value except the model, the context limit, and the effort level is also a value of the chat tree's shared
 *  agent host (`hostValues`), and so is whether the values state an effort. A per-agent difference in one of them
 *  starts another engine process. If such a difference is absolutely necessary, add its field to
 *  `HOST_SPLIT_EXCEPTIONS` (agent-host/host-registry.ts) with its reason. */
export function engineValues(identity: QueryIdentity, wireModelId: string, contextLimit: number): EngineValues {
  return {
    tools: identity.tools, wireModelId, contextLimit, thinking: identity.thinking,
    ...(identity.effort === undefined ? {} : { effort: identity.effort }),
    extraBody: { ...identity.extraBody, ...(identity.toolChoice === undefined ? {} : { tool_choice: identity.toolChoice }), max_tokens: identity.maxTokens },
    eagerInputStreaming: identity.eagerInputStreaming, promptCaching: identity.promptCaching,
  };
}

/** The engine of one query and the parts of the query that its launch fixes: the runtime MCP server and its tool
 *  gate, and the prompt stream. */
export interface QueryEngine extends ObservedEngine<LaunchedQuery> {
  readonly toolGate: ToolGate;
  readonly prompt: Queue.Queue<CliFrame, Error | Cause.Done>;
  /** Releases what the engine holds, after the query's stop ended the engine. */
  close(): Promise<void>;
}

/** Starts a new engine for one query of `identity` at `session`, with its own tool gate and prompt stream, which
 *  `observer` hears from its launch on (`observeEngine`). */
export function startColdEngine(
  launchQuery: (launch: QueryLaunch) => LaunchedQuery, identity: QueryIdentity, values: EngineValues, session: QueryLaunch["session"], stepGate: StepGate, observer: EngineObserver,
): Effect.Effect<QueryEngine, Error> {
  return Effect.gen(function* () {
    const toolGate = createToolGate(identity.tools);
    const prompt = yield* Queue.unbounded<CliFrame, Error | Cause.Done>();
    const engine = yield* Effect.try({ try: () => observeEngine((onStderrLine) => launchQuery({
      ...values, prompt: queueIterable(prompt), systemPrompt: identity.systemPrompt, mcpServer: toolGate.server, stepGate, cwd: identity.cwd, session, onStderrLine,
    }), (launched) => launched.query, observer, { role: "chat", sessionId: session.id, resumed: session.kind === "resume", wireModelId: values.wireModelId }),
    catch: (error) => error instanceof Error ? error : new Error(String(error)) });
    return { ...engine, toolGate, prompt, close: () => engine.launched.close() };
  });
}
